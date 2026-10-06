export interface Team {
  name: string;
  nick: string;
  primary: string;
  secondary: string;
  tertiary: string | null;
}
export type Teams = Record<string, Team>;

export interface PlayerMeta {
  id: number;
  name: string;
  num: number | null;
  team: string;
  off: boolean;
  pos: string | null;
  h: number | null;
  w: number | null;
  /** Ran a pass route on this play (whether or not the route type is labelled). */
  runner: boolean;
  route: string | null;
  /** Not tracked after the throw; movement after that is modelled. */
  modelled?: boolean;
  /** Video estimates: frame ranges [from, to] where the player was actually seen; outside them the position is held or bridged. */
  seen?: [number, number][];
  target: boolean;
  cov: string | null;
  rush: boolean;
  rec: boolean;
  int: boolean;
}

/** One play as written by pipeline/build.py (quantized tracks). */
export interface RawPlay {
  id: string;
  gameId: number;
  playId: number;
  season: number;
  week: number;
  source?: string;
  home: string;
  away: string;
  offense: string;
  defense: string;
  desc: string;
  quarter: number;
  clock: string;
  down: number | null;
  ytg: number;
  homeScore: number | null;
  awayScore: number | null;
  los: number;
  firstDown: number;
  ballY: number;
  passResult: string | null;
  yards: number | null;
  epa: number | null;
  homeWp: number | null;
  homeWpa: number | null;
  formation: string | null;
  coverage: string | null;
  manZone: string | null;
  playAction: boolean;
  dropback: string | null;
  timeToThrow: number | null;
  isPass: boolean;
  fps: number;
  n: number;
  snap: number;
  throw: number | null;
  arrive: number | null;
  events: [number, string][];
  players: PlayerMeta[];
  x: number[][];
  y: number[][];
  o: number[][];
  s: number[][];
  bx: number[];
  by: number[];
  /** Ball possession runs: [startFrame, playerIndex]; -1 = loose or in the air. */
  carrier?: [number, number][];
  /** No ball track (e.g. plays estimated from video). */
  noBall?: boolean;
  /** Mean field-registration error in pixels, for video estimates. */
  fitError?: number;
}

/** A play with tracks decoded into yards / degrees / yd·s⁻¹. */
export interface Play extends Omit<RawPlay, 'x' | 'y' | 'o' | 's' | 'bx' | 'by' | 'carrier'> {
  /** Player index holding the ball on each frame, -1 when loose or in the air. */
  carrier: Int16Array;
  x: Float32Array[];
  y: Float32Array[];
  o: Float32Array[];
  s: Float32Array[];
  bx: Float32Array;
  by: Float32Array;
}

export interface GameFile {
  gameId: number;
  season: number;
  week: number;
  date: string;
  home: string;
  away: string;
  plays: Play[];
}

export interface FilmRef {
  videoId: string;
  channel: string;
  title: string;
}

export interface Featured {
  id: string;
  gameId: number;
  playId: number;
  title: string;
  subtitle: string;
  film: FilmRef | null;
  season: number;
  week: number;
  offense: string;
  defense: string;
  home: string;
  away: string;
  quarter: number;
  clock: string;
  yards: number | null;
}

export interface GameSummary {
  gameId: number;
  season: number;
  week: number;
  source: string;
  date: string;
  time: string | null;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  plays: number;
}

export interface TrackingIndex {
  source: string;
  /** Colors for teams outside the NFL table (video estimates of college games). */
  teams?: Teams;
  builtAt: string;
  games: GameSummary[];
  featured: Featured[];
  qbPool: [number, number][];
  /** Routes in the Route Finder library (absent in older builds). */
  routeCount?: number;
}

export interface RouteLibrary {
  count: number;
  points: number;
  stepSeconds: number;
  scale: number;
  games: number[];
  routeTypes: string[];
  players: Record<string, [string, string | null]>;
  rows: [number, number, number, number, number, string, string][];
  pts: Int16Array;
}

export interface SeasonKeyPlay {
  playId: number;
  qtr: number;
  clock: string;
  team: string;
  down: number | null;
  ytg: number | null;
  yardline100: number | null;
  yards: number | null;
  tag: string;
  desc: string;
  homeWpa: number;
  homeWpAfter: number | null;
  epa: number | null;
}

export interface SeasonDrive {
  team: string;
  qtr: number;
  start100: number;
  end100: number;
  plays: number;
  result: string | null;
}

export interface SeasonGame {
  id: string;
  week: number;
  date: string;
  time: string | null;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  final: boolean;
  overtime: boolean;
  stadium: string | null;
  roof: string | null;
  wp: [number, number][];
  keyPlays: SeasonKeyPlay[];
  drives: SeasonDrive[];
}

export interface Season {
  season: number;
  builtAt: string;
  latestWeek: number;
  source: string;
  weeks: { week: number; played: number; games: SeasonGame[] }[];
}
