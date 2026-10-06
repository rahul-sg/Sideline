import type { GameFile, Play, RawPlay, RouteLibrary, Season, Teams, TrackingIndex } from './types';

const BASE = '/data';
/** Tracking files live under /data, or /data/preview for the synthetic preview play. */
let trackingBase = BASE;
export function setPreviewData(on: boolean) {
  trackingBase = on ? `${BASE}/preview` : BASE;
  gameCache.clear();
  routesPromise = null;
}

async function fetchJson<T>(path: string, base = BASE): Promise<T | null> {
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) return null;
  // Vite answers unknown paths with index.html; treat that as "not built yet".
  if (!(res.headers.get('content-type') ?? '').includes('json')) return null;
  return (await res.json()) as T;
}

/** Fetch a gzip'd JSON file. Handles servers that already decoded it. */
async function fetchGzJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${trackingBase}/${path}`);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  let text: string;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  if (!text.startsWith('{')) return null;
  return JSON.parse(text) as T;
}

function expandRuns(runs: [number, number][], n: number): Int16Array {
  const out = new Int16Array(n).fill(-1);
  runs.forEach(([start, who], k) => out.fill(who, start, k + 1 < runs.length ? runs[k + 1][0] : n));
  return out;
}

export function decodePlay(raw: RawPlay): Play {
  const scaled = (rows: number[][], k: number) => rows.map((r) => Float32Array.from(r, (v) => v / k));
  return {
    ...raw,
    x: scaled(raw.x, 10),
    y: scaled(raw.y, 10),
    o: scaled(raw.o, 1),
    s: scaled(raw.s, 10),
    bx: Float32Array.from(raw.bx, (v) => v / 10),
    by: Float32Array.from(raw.by, (v) => v / 10),
    carrier: expandRuns(raw.carrier ?? [], raw.n),
  };
}

export const loadTeams = () => fetchJson<Teams>('teams.json');
export async function loadIndex(): Promise<TrackingIndex | null> {
  const [idx, video] = await Promise.all([
    fetchJson<TrackingIndex>('index.json', trackingBase),
    trackingBase === BASE ? fetchJson<Pick<TrackingIndex, 'games' | 'featured' | 'teams'>>('video/index.json') : null,
  ]);
  if (!idx || !video) return idx;
  // Plays estimated from broadcast video are listed after the tracked ones.
  return { ...idx, games: [...idx.games, ...video.games], featured: [...idx.featured, ...video.featured], teams: video.teams };
}
export const loadSeason = (season: number) => fetchJson<Season>(`season${season}.json`);

const gameCache = new Map<number, Promise<GameFile | null>>();
export function loadGame(gameId: number): Promise<GameFile | null> {
  if (!gameCache.has(gameId)) {
    const p = fetchGzJson<Omit<GameFile, 'plays'> & { plays: RawPlay[] }>(`games/${gameId}.json.gz`).then((g) =>
      g ? { ...g, plays: g.plays.map(decodePlay) } : null,
    );
    p.catch(() => gameCache.delete(gameId));
    gameCache.set(gameId, p);
  }
  return gameCache.get(gameId)!;
}

export async function loadPlay(gameId: number, playId: number): Promise<Play | null> {
  const g = await loadGame(gameId);
  return g?.plays.find((p) => p.playId === playId) ?? null;
}

let routesPromise: Promise<RouteLibrary | null> | null = null;
export function loadRoutes(): Promise<RouteLibrary | null> {
  routesPromise ??= (async () => {
    const meta = await fetchJson<Omit<RouteLibrary, 'pts'>>('routes.json', trackingBase);
    if (!meta) return null;
    const res = await fetch(`${trackingBase}/routes.bin`);
    if (!res.ok) return null;
    return { ...meta, pts: new Int16Array(await res.arrayBuffer()) };
  })();
  return routesPromise;
}
