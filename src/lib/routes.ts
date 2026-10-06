import type { RouteLibrary } from './types';

export type Pt = [number, number];
export const SAMPLES = 24;

export function arcLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Resample a polyline to n points evenly spaced along its first `upTo` yards. */
export function resample(pts: Pt[], n = SAMPLES, upTo = Infinity): Pt[] {
  if (pts.length === 0) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = Math.min(cum[cum.length - 1], upTo);
  if (total === 0) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as Pt);
  const out: Pt[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < cum.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const f = Math.min(1, Math.max(0, (d - cum[j - 1]) / seg));
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f]);
  }
  return out;
}

/** Mean distance between corresponding points of two equal-length curves. */
export function meanDistance(a: Pt[], b: Pt[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return s / a.length;
}

export function libraryRoute(lib: RouteLibrary, k: number): Pt[] {
  const out: Pt[] = [];
  const base = k * lib.points * 2;
  for (let i = 0; i < lib.points; i++) out.push([lib.pts[base + i * 2] / lib.scale, lib.pts[base + i * 2 + 1] / lib.scale]);
  return out;
}

export interface RouteFilter {
  routeType?: string;
  team?: string;
  targetedOnly?: boolean;
  completedOnly?: boolean;
}

export interface RouteMatch {
  k: number;
  distance: number;
  similarity: number;
}

/**
 * Find library routes whose opening matches the sketch. Each library route is
 * cut to the sketch's length so "starts like this" matches, and routes shorter
 * than the sketch are penalized for the missing distance.
 */
export function matchRoutes(lib: RouteLibrary, sketch: Pt[], filter: RouteFilter = {}, limit = 24): RouteMatch[] {
  const L = arcLength(sketch);
  if (L < 2) return [];
  const target = resample(sketch);
  const typeIdx = filter.routeType ? lib.routeTypes.indexOf(filter.routeType) : -1;
  const best: RouteMatch[] = [];
  let worst = Infinity;

  for (let k = 0; k < lib.count; k++) {
    const row = lib.rows[k];
    if (typeIdx >= 0 && row[3] !== typeIdx) continue;
    if (filter.team && row[6] !== filter.team) continue;
    if (filter.targetedOnly && !row[4]) continue;
    if (filter.completedOnly && row[5] !== 'C') continue;
    const pts = libraryRoute(lib, k);
    const len = arcLength(pts);
    let d = meanDistance(target, resample(pts, SAMPLES, L));
    if (len < L) d += (L - len) * 0.5;
    if (best.length < limit || d < worst) {
      best.push({ k, distance: d, similarity: 0 });
      best.sort((a, b) => a.distance - b.distance);
      if (best.length > limit) best.pop();
      worst = best[best.length - 1].distance;
    }
  }
  return best.map((m) => ({ ...m, similarity: Math.round(100 * Math.exp(-m.distance / 3)) }));
}

/** Convert a sketch in field yards to route-library space: origin at start, +x downfield, +y toward the receiver's sideline. */
export function toRouteSpace(sketch: Pt[], ballY: number): Pt[] {
  if (!sketch.length) return [];
  const [x0, y0] = sketch[0];
  const side = y0 >= ballY - 0.5 ? 1 : -1;
  return sketch.map(([x, y]) => [x - x0, (y - y0) * side]);
}
