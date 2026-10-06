import { describe, expect, it } from 'vitest';
import { ballHeight, clockAt, downText, sample, sampleAngle, separation, timelineEvents, yardLineLabel, yawFromO } from './playMath';
import { arcLength, matchRoutes, resample, toRouteSpace, type Pt } from './routes';
import type { Play, PlayerMeta, RouteLibrary } from './types';
import { hashFor, parseHash } from './route';

const player = (over: Partial<PlayerMeta>): PlayerMeta => ({
  id: 1, name: 'A B', num: 1, team: 'MIA', off: true, pos: 'WR', h: 72, w: 200,
  runner: false, route: null, target: false, cov: null, rush: false, rec: false, int: false, ...over,
});

function makePlay(over: Partial<Play> = {}): Play {
  const n = 60;
  const line = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
  return {
    id: 'g-p', gameId: 1, playId: 1, season: 2023, week: 1, home: 'BAL', away: 'MIA', offense: 'MIA', defense: 'BAL',
    desc: '', quarter: 2, clock: '08:41', down: 3, ytg: 6, homeScore: 0, awayScore: 0,
    los: 45, firstDown: 51, ballY: 26.65, passResult: 'C', yards: 10, epa: 1, homeWp: 0.5, homeWpa: 0,
    formation: null, coverage: null, manZone: null, playAction: false, dropback: null, timeToThrow: null,
    isPass: true, fps: 10, n, snap: 10, throw: 30, arrive: 40,
    events: [[10, 'ball_snap'], [30, 'pass_forward'], [40, 'pass_arrived'], [41, 'pass_outcome_caught'], [55, 'tackle']],
    players: [player({ id: 1, off: true }), player({ id: 2, off: false, team: 'BAL' }), player({ id: 3, off: false, team: 'BAL' })],
    x: [line((i) => 45 + i * 0.5), line(() => 50), line(() => 70)],
    y: [line(() => 20), line(() => 23), line(() => 20)],
    o: [line(() => 350), line(() => 10), line(() => 0)],
    s: [line(() => 5), line(() => 0), line(() => 0)],
    bx: line(() => 45),
    by: line(() => 26.65),
    carrier: new Int16Array(n).fill(-1),
    ...over,
  };
}

describe('playMath', () => {
  it('interpolates between frames and clamps at the ends', () => {
    const a = Float32Array.from([0, 10, 20]);
    expect(sample(a, 0.5)).toBeCloseTo(5);
    expect(sample(a, -3)).toBe(0);
    expect(sample(a, 9)).toBe(20);
  });

  it('interpolates angles the short way around', () => {
    expect(sampleAngle(Float32Array.from([350, 10]), 0.5) % 360).toBeCloseTo(0);
  });

  it('turns tracking orientation into a model yaw', () => {
    // Facing downfield (o = 90) should rotate the +Z-facing model to face +X.
    const yaw = yawFromO(90);
    expect(Math.sin(yaw)).toBeCloseTo(1);
    expect(Math.cos(yaw)).toBeCloseTo(0);
  });

  it('models the ball on the ground pre-snap and as an arc in flight', () => {
    const p = makePlay();
    expect(ballHeight(p, 0)).toBeLessThan(0.2);
    expect(ballHeight(p, 30)).toBeCloseTo(2.0);
    expect(ballHeight(p, 40)).toBeCloseTo(1.5);
    expect(ballHeight(p, 35)).toBeGreaterThan(2.0);
  });

  it('measures separation to the nearest opponent', () => {
    const p = makePlay();
    // Receiver at x = 45 + 0.5*20 = 55 vs defenders at (50,23) and (70,20)
    expect(separation(p, 0, 20)).toBeCloseTo(Math.hypot(5, 3));
  });

  it('formats down, distance and field position', () => {
    expect(downText(3, 6, 45)).toBe('3rd & 6');
    expect(downText(1, 8, 102)).toBe('1st & Goal');
    expect(yardLineLabel(45, 'MIA', 'BAL')).toBe('MIA 35');
    expect(yardLineLabel(60, 'MIA', 'BAL')).toBe('50');
    expect(yardLineLabel(80, 'MIA', 'BAL')).toBe('BAL 30');
  });

  it('runs the game clock from the snap', () => {
    const p = makePlay();
    expect(clockAt(p, 0)).toBe('8:41');
    expect(clockAt(p, 30)).toBe('8:39');
  });

  it('thins colliding timeline events, keeping the more important one', () => {
    const labels = timelineEvents(makePlay()).map((e) => e.label);
    expect(labels).toContain('Catch');
    expect(labels).not.toContain('Arrival');
    expect(labels[0]).toBe('Snap');
  });
});

describe('routes', () => {
  const straight: Pt[] = [[0, 0], [10, 0]];

  it('resamples evenly by arc length', () => {
    const r = resample([[0, 0], [2, 0], [10, 0]], 5);
    expect(r.map((p) => p[0])).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(arcLength(straight)).toBe(10);
  });

  it('can stop resampling partway along a curve', () => {
    const r = resample([[0, 0], [10, 0], [10, 10]], 3, 10);
    expect(r[2][0]).toBeCloseTo(10);
    expect(r[2][1]).toBeCloseTo(0);
  });

  it('puts sketches in outside-positive route space on either side of the ball', () => {
    // Receiver on the right (y below the ball) breaking inside should go negative.
    const right = toRouteSpace([[0, 10], [5, 14]], 26.65);
    expect(right[1]).toEqual([5, -4]);
    const left = toRouteSpace([[0, 40], [5, 36]], 26.65);
    expect(left[1]).toEqual([5, -4]);
  });

  it('ranks the route whose opening matches the sketch first', () => {
    const go: Pt[] = Array.from({ length: 21 }, (_, i) => [i * 1.5, 0]);
    const slant: Pt[] = Array.from({ length: 21 }, (_, i) => (i < 2 ? [i * 1.5, 0] : [3 + (i - 2) * 1.1, -(i - 2) * 1.1]));
    const pts = new Int16Array([...go, ...slant].flatMap(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]));
    const lib: RouteLibrary = {
      count: 2, points: 21, stepSeconds: 0.2, scale: 10, games: [1], routeTypes: ['GO', 'SLANT'], players: {},
      rows: [[0, 1, 10, 0, 0, 'I', 'MIA'], [0, 1, 11, 1, 1, 'C', 'MIA']], pts,
    };
    const sketch: Pt[] = [[0, 0], [3, 0], [9, -6]];
    const m = matchRoutes(lib, sketch);
    expect(m[0].k).toBe(1);
    expect(m[0].similarity).toBeGreaterThan(m[1].similarity);
    expect(matchRoutes(lib, sketch, { routeType: 'GO' }).map((x) => x.k)).toEqual([0]);
    expect(matchRoutes(lib, sketch, { completedOnly: true }).map((x) => x.k)).toEqual([1]);
  });
});

describe('page links', () => {
  it('reads each page and a Replay play from the URL', () => {
    expect(parseHash('')).toEqual({ mode: 'home', play: null });
    expect(parseHash('#/')).toEqual({ mode: 'home', play: null });
    expect(parseHash('#/qb-read')).toEqual({ mode: 'qb', play: null });
    expect(parseHash('#/replay/2023123000-698')).toEqual({ mode: 'theater', play: [2023123000, 698] });
    expect(parseHash('#/route-finder/123-4')).toEqual({ mode: 'draw', play: null });
    expect(parseHash('#/nonsense')).toEqual({ mode: 'home', play: null });
  });
  it('writes links that read back the same', () => {
    expect(hashFor('home')).toBe('#/');
    expect(hashFor('about')).toBe('#/about');
    expect(hashFor('theater', { gameId: 2023123000, playId: 698 })).toBe('#/replay/2023123000-698');
    expect(hashFor('week', { gameId: 1, playId: 2 })).toBe('#/this-week');
    for (const h of ['#/', '#/replay', '#/qb-read', '#/route-finder', '#/this-week', '#/about'])
      expect(hashFor(parseHash(h).mode)).toBe(h);
  });
});
