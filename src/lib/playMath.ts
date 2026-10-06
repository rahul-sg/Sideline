import type { Play } from './types';

export const FIELD_LEN = 120;
export const FIELD_W = 160 / 3;
const G_YD = 10.72; // gravity, yd/s²

/** Field coords (x along field, y across, offense → +x) to scene X/Z. Y is up. */
export const sceneX = (x: number) => x - FIELD_LEN / 2;
export const sceneZ = (y: number) => -(y - FIELD_W / 2);

/** Tracking orientation (deg, 0 = +y, clockwise) to a Y-axis rotation for a model facing +Z. */
export const yawFromO = (o: number) => Math.PI - (o * Math.PI) / 180;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Linearly interpolated sample of a per-frame series at fractional frame t. */
export function sample(arr: Float32Array, t: number): number {
  const n = arr.length;
  if (t <= 0) return arr[0];
  if (t >= n - 1) return arr[n - 1];
  const i = Math.floor(t);
  const f = t - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

/** Shortest-path interpolation for angles in degrees. */
export function sampleAngle(arr: Float32Array, t: number): number {
  const n = arr.length;
  if (t <= 0) return arr[0];
  if (t >= n - 1) return arr[n - 1];
  const i = Math.floor(t);
  const f = t - i;
  let d = arr[i + 1] - arr[i];
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return arr[i] + d * f;
}

/** Direction of travel (deg, tracking convention) from position deltas around t. */
export function motionDir(play: Play, i: number, t: number): number {
  const dx = sample(play.x[i], t + 0.5) - sample(play.x[i], t - 0.5);
  const dy = sample(play.y[i], t + 0.5) - sample(play.y[i], t - 0.5);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Ball height in yards. Tracking only gives x/y, so height is modelled:
 * on the ground before the snap, a projectile between throw and arrival,
 * carried at waist height otherwise.
 */
export function ballHeight(play: Play, t: number): number {
  const ground = 0.13;
  const carried = 1.15;
  if (t < play.snap) return ground;
  if (t < play.snap + 3) return ground + (carried - ground) * ((t - play.snap) / 3);
  const { throw: th, arrive: ar } = play;
  if (th != null && ar != null && ar > th) {
    if (t >= th && t <= ar) {
      const T = (ar - th) / play.fps;
      const tau = (t - th) / play.fps;
      const h0 = 2.0;
      const h1 = 1.5;
      const vz = (h1 - h0 + (G_YD * T * T) / 2) / T;
      return h0 + vz * tau - (G_YD * tau * tau) / 2;
    }
    if (t > ar && play.passResult === 'I') {
      return Math.max(ground, 1.5 - ((t - ar) / 5) * 1.4);
    }
  }
  return carried;
}

/** Peak height of the throw arc, for camera framing and trails. */
export function throwApex(play: Play): number {
  const { throw: th, arrive: ar } = play;
  if (th == null || ar == null) return 0;
  let best = 0;
  for (let t = th; t <= ar; t += 0.5) best = Math.max(best, ballHeight(play, t));
  return best;
}

export function frameOfEvent(play: Play, name: string): number | null {
  const e = play.events.find(([, n]) => n === name);
  return e ? e[0] : null;
}

/** Distance from player i to the nearest opponent at frame t. */
export function separation(play: Play, i: number, t: number): number {
  const me = play.players[i];
  const x = sample(play.x[i], t);
  const y = sample(play.y[i], t);
  let best = Infinity;
  play.players.forEach((p, j) => {
    if (p.off === me.off) return;
    const d = Math.hypot(sample(play.x[j], t) - x, sample(play.y[j], t) - y);
    if (d < best) best = d;
  });
  return best;
}

/** Who holds the ball at fractional frame t (-1 if loose or in the air). */
export const carrierAt = (play: Play, t: number) => play.carrier[Math.max(0, Math.min(play.n - 1, Math.floor(t)))] ?? -1;

export const playerIndex = (play: Play, nflId: number) => play.players.findIndex((p) => p.id === nflId);
export const qbIndex = (play: Play) => {
  const i = play.players.findIndex((p) => p.off && p.pos === 'QB');
  return i >= 0 ? i : play.players.findIndex((p) => p.off);
};

/** "3rd & 7", "1st & Goal" */
export function downText(down: number | null, ytg: number, los?: number): string {
  if (!down) return '';
  const ord = ['', '1st', '2nd', '3rd', '4th'][down] ?? `${down}th`;
  const goal = los != null && los + ytg >= 110;
  return `${ord} & ${goal ? 'Goal' : ytg}`;
}

/** Field position label from absolute x (offense → +x): "MIA 35", "50". */
export function yardLineLabel(x: number, offense: string, defense: string): string {
  const yd = Math.round(x - 10);
  if (yd === 50) return '50';
  return yd < 50 ? `${offense} ${yd}` : `${defense} ${100 - yd}`;
}

export const EVENT_LABELS: Record<string, string> = {
  ball_snap: 'Snap',
  autoevent_ballsnap: 'Snap',
  pass_forward: 'Throw',
  autoevent_passforward: 'Throw',
  pass_shovel: 'Shovel',
  pass_arrived: 'Arrival',
  pass_outcome_caught: 'Catch',
  pass_outcome_incomplete: 'Incomplete',
  pass_outcome_interception: 'Interception',
  pass_outcome_touchdown: 'Touchdown',
  handoff: 'Handoff',
  play_action: 'Play action',
  run: 'Run',
  first_contact: 'Contact',
  tackle: 'Tackle',
  out_of_bounds: 'Out of bounds',
  touchdown: 'Touchdown',
  fumble: 'Fumble',
  fumble_defense_recovered: 'Recovered',
  fumble_offense_recovered: 'Recovered',
  qb_sack: 'Sack',
  qb_strip_sack: 'Strip sack',
  qb_slide: 'Slide',
  man_in_motion: 'Motion',
  shift: 'Shift',
  line_set: 'Line set',
  lateral: 'Lateral',
  safety: 'Safety',
  run_pass_option: 'RPO',
};

const EVENT_PRIORITY: Record<string, number> = {
  Snap: 9, Throw: 8, Catch: 7, Incomplete: 7, Interception: 7, Touchdown: 7, Sack: 7, 'Strip sack': 7,
  Handoff: 6, Fumble: 6, Tackle: 5, 'Out of bounds': 5, Recovered: 4, Contact: 3, Arrival: 2,
};

/** Events worth a marker on the timeline: deduplicated, and thinned where they'd collide. */
export function timelineEvents(play: Play, minGap = Math.max(3, play.n * 0.06)): { frame: number; label: string }[] {
  const seen = new Set<string>();
  const out: { frame: number; label: string }[] = [];
  for (const [frame, name] of play.events) {
    const label = EVENT_LABELS[name];
    if (!label || label === 'Line set' || name.startsWith('autoevent') || seen.has(label)) continue;
    seen.add(label);
    const prev = out[out.length - 1];
    if (prev && frame - prev.frame < minGap) {
      if ((EVENT_PRIORITY[label] ?? 1) > (EVENT_PRIORITY[prev.label] ?? 1)) out[out.length - 1] = { frame, label };
      continue;
    }
    out.push({ frame, label });
  }
  return out;
}

export function clockAt(play: Play, t: number): string {
  // Game clock runs from the snap; show the pre-snap clock until then.
  const [m, s] = play.clock.split(':').map(Number);
  if (!Number.isFinite(m) || !Number.isFinite(s)) return play.clock;
  const elapsed = Math.max(0, (t - play.snap) / play.fps);
  const rem = Math.max(0, m * 60 + s - Math.floor(elapsed));
  return `${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
}
