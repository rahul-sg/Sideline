import type { ReactNode } from 'react';
import { FIELD_LEN, FIELD_W, qbIndex, sample, separation } from '../lib/playMath';
import { visibleColor } from '../lib/teams';
import type { Play } from '../lib/types';

const U = 10; // diagram units per yard
const HASHES = [23.583, 29.75]; // NFL hash marks, yards from a sideline

export type Pt = (x: number, y: number) => [number, number];

/** Downfield window [x0, x1] around the line of scrimmage, kept on the field. */
export function windowAround(los: number, behind = 10, ahead = 26): [number, number] {
  const x0 = Math.max(0, Math.min(los - behind, FIELD_LEN - behind - ahead));
  return [x0, x0 + behind + ahead];
}

/**
 * Top-down play diagram. Field yards in the tracking's frame (offense toward +x) are drawn
 * with the offense going up the page and its left on the left.
 */
export function MiniField({
  x0,
  x1,
  los,
  firstDown,
  label,
  children,
}: {
  x0: number;
  x1: number;
  los?: number;
  firstDown?: number;
  label: string;
  children?: (pt: Pt) => ReactNode;
}) {
  const pt: Pt = (x, y) => [(FIELD_W - y) * U, (x1 - x) * U];
  const W = FIELD_W * U;
  const H = (x1 - x0) * U;
  const lines: ReactNode[] = [];
  for (let x = Math.ceil(x0); x <= x1; x++) {
    const [, y] = pt(x, 0);
    if (x % 5 === 0 && x >= 10 && x <= 110) {
      lines.push(<line key={`l${x}`} x1={0} x2={W} y1={y} y2={y} className={x === 10 || x === 110 ? 'minifield__goal' : 'minifield__line'} />);
    } else if (x > 10 && x < 110) {
      for (const h of [...HASHES, 0.6, FIELD_W - 0.6]) {
        const [hx] = pt(x, h);
        lines.push(<line key={`h${x}-${h}`} x1={hx - 3} x2={hx + 3} y1={y} y2={y} className="minifield__hash" />);
      }
    }
  }
  return (
    <svg className="minifield" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <rect width={W} height={H} className="minifield__turf" />
      {[
        [110, FIELD_LEN],
        [0, 10],
      ].map(([a, b]) => {
        const lo = Math.max(a, x0);
        const hi = Math.min(b, x1);
        if (hi - lo < 1) return null;
        const [, top] = pt(hi, 0);
        const [, bottom] = pt(lo, 0);
        return (
          <g key={a}>
            <rect x={0} y={top} width={W} height={bottom - top} className="minifield__endzone" />
            {hi - lo >= 4 && (
              <text x={W / 2} y={(top + bottom) / 2 + 12} textAnchor="middle" className="minifield__ez-label">
                End zone
              </text>
            )}
          </g>
        );
      })}
      {lines}
      {firstDown != null && firstDown < x1 && <line x1={0} x2={W} y1={pt(firstDown, 0)[1]} y2={pt(firstDown, 0)[1]} className="minifield__first" />}
      {los != null && <line x1={0} x2={W} y1={pt(los, 0)[1]} y2={pt(los, 0)[1]} className="minifield__los" />}
      {children?.(pt)}
    </svg>
  );
}

/** Every player at frame t: offense as dots in its team color, defense as grey rings
 * (two teams can share a color family, so the defense never competes with it). */
export function Players({ play, t, pt, dim = false }: { play: Play; t: number; pt: Pt; dim?: boolean }) {
  const off = visibleColor(play.offense);
  return (
    <g opacity={dim ? 0.35 : 1}>
      {play.players.map((p, i) => {
        const [cx, cy] = pt(sample(play.x[i], t), sample(play.y[i], t));
        return p.off ? (
          <circle key={i} cx={cx} cy={cy} r={8.5} fill={off} stroke="#05080c" strokeWidth={2} />
        ) : (
          <circle key={i} cx={cx} cy={cy} r={7.5} className="minifield__def" />
        );
      })}
    </g>
  );
}

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** The quarterback's read at the throw: who the ball went to and how open he was. */
export function ReadDiagram({ play }: { play: Play }) {
  const t = play.throw ?? Math.min(play.n - 1, play.snap + 25);
  const qb = qbIndex(play);
  let target = play.players.findIndex((p) => p.target);
  if (target < 0) {
    // Run play or no target recorded: the most open eligible receiver.
    const options = play.players.map((_, i) => i).filter((i) => play.players[i].off && i !== qb && play.players[i].runner);
    target = options.sort((a, b) => separation(play, b, t) - separation(play, a, t))[0] ?? -1;
  }
  const [x0, x1] = windowAround(play.los, 9, 25);
  return (
    <MiniField x0={x0} x1={x1} los={play.los} firstDown={play.firstDown} label="Players at the moment of the throw">
      {(pt) => {
        if (target < 0) return <Players play={play} t={t} pt={pt} />;
        const [qx, qy] = pt(sample(play.x[qb], t), sample(play.y[qb], t));
        const [tx, ty] = pt(sample(play.x[target], t), sample(play.y[target], t));
        const sep = separation(play, target, t);
        const right = tx < (FIELD_W * U) / 2;
        return (
          <>
            <line x1={qx} y1={qy} x2={tx} y2={ty} className="minifield__read" />
            <Players play={play} t={t} pt={pt} />
            <circle cx={tx} cy={ty} r={20} className="minifield__target" />
            {Number.isFinite(sep) && (
              <text x={right ? tx + 28 : tx - 28} y={ty + 6} textAnchor={right ? 'start' : 'end'} className="minifield__note">
                {sep.toFixed(1)} yd open
              </text>
            )}
          </>
        );
      }}
    </MiniField>
  );
}

/** Every route on the play from the snap until the ball arrives; the target's in white. */
export function RoutesDiagram({ play }: { play: Play }) {
  const end = Math.min(play.n - 1, (play.arrive ?? play.throw ?? play.snap + 30) + 4);
  const runners = play.players.map((_, i) => i).filter((i) => play.players[i].off && (play.players[i].runner || play.players[i].route));
  const target = runners.find((i) => play.players[i].target);
  const color = visibleColor(play.offense);
  const [x0, x1] = windowAround(play.los, 9, 25);
  return (
    <MiniField x0={x0} x1={x1} los={play.los} label="Every route run on the play">
      {(pt) => {
        const path = (i: number) => {
          const pts: string[] = [];
          for (let f = play.snap; f <= end; f++) pts.push(pt(play.x[i][f], play.y[i][f]).map((v) => v.toFixed(1)).join(','));
          return pts.join(' ');
        };
        const last = (i: number) => pt(play.x[i][end], play.y[i][end]);
        return (
          <>
            <Players play={play} t={play.snap} pt={pt} dim />
            {runners
              .filter((i) => i !== target)
              .map((i) => (
                <polyline key={i} points={path(i)} className="minifield__route" stroke={color} />
              ))}
            {target != null && (
              <>
                <polyline points={path(target)} className="minifield__route minifield__route--target" />
                <circle cx={last(target)[0]} cy={last(target)[1]} r={7} fill="#fff" />
                {play.players[target].route && (
                  <text x={last(target)[0]} y={last(target)[1] - 18} textAnchor="middle" className="minifield__note">
                    {title(play.players[target].route!)}
                  </text>
                )}
              </>
            )}
          </>
        );
      }}
    </MiniField>
  );
}

/** The formation at the snap. */
export function FormationDiagram({ play }: { play: Play }) {
  const [x0, x1] = windowAround(play.los, 9, 25);
  return (
    <MiniField x0={x0} x1={x1} los={play.los} firstDown={play.firstDown} label="The formation at the snap">
      {(pt) => <Players play={play} t={play.snap} pt={pt} />}
    </MiniField>
  );
}
