import { create } from 'zustand';
import type { Play } from './types';

export type Mode = 'home' | 'theater' | 'qb' | 'draw' | 'week' | 'about';
/** 'showcase' is the home page's slow cinematic camera; the rest are user-selectable. */
export type CameraMode = 'broadcast' | 'all22' | 'endzone' | 'qb' | 'follow' | 'free' | 'showcase';

export interface QbState {
  phase: 'loading' | 'watch' | 'decide' | 'reveal';
  pick: number | null; // player index
  freezeAt: number;
}

interface State {
  mode: Mode;
  play: Play | null;
  loadingPlay: boolean;
  /** Fractional frame index into the current play. */
  time: number;
  playing: boolean;
  speed: number;
  selected: number | null;
  hovered: number | null;
  camera: CameraMode;
  /** Bumped to re-apply the current camera preset. */
  cameraNonce: number;
  showRoutes: boolean;
  panelsHidden: boolean;
  /** The 3D view is off screen (home page scrolled past it): stop rendering. */
  stageIdle: boolean;
  qb: QbState;
  setMode: (m: Mode) => void;
  setStageIdle: (v: boolean) => void;
  setPlay: (p: Play | null, opts?: { time?: number; selected?: number | null; autoplay?: boolean }) => void;
  setLoadingPlay: (v: boolean) => void;
  setTime: (t: number) => void;
  setPlaying: (v: boolean) => void;
  togglePlaying: () => void;
  setSpeed: (v: number) => void;
  select: (i: number | null) => void;
  hover: (i: number | null) => void;
  setCamera: (c: CameraMode) => void;
  toggleRoutes: () => void;
  togglePanels: () => void;
  setQb: (q: Partial<QbState>) => void;
}

export const useStore = create<State>((set, get) => ({
  mode: 'home',
  play: null,
  loadingPlay: false,
  time: 0,
  playing: false,
  speed: 1,
  selected: null,
  hovered: null,
  camera: 'broadcast',
  cameraNonce: 0,
  showRoutes: true,
  panelsHidden: false,
  stageIdle: false,
  qb: { phase: 'loading', pick: null, freezeAt: 0 },
  setMode: (mode) =>
    set((s) => ({
      mode,
      playing: false,
      stageIdle: false,
      // The cinematic camera belongs to the home page.
      ...(s.camera === 'showcase' && mode !== 'home' ? { camera: 'broadcast' as const, cameraNonce: s.cameraNonce + 1 } : {}),
    })),
  setStageIdle: (stageIdle) => set({ stageIdle }),
  setPlay: (play, opts = {}) =>
    set((s) => ({
      play,
      time: opts.time ?? (play ? Math.max(0, play.snap - 15) : 0),
      selected: opts.selected ?? null,
      playing: opts.autoplay ?? false,
      loadingPlay: false,
      cameraNonce: s.cameraNonce + 1,
    })),
  setLoadingPlay: (loadingPlay) => set({ loadingPlay }),
  setTime: (time) => {
    const p = get().play;
    set({ time: p ? Math.min(Math.max(0, time), p.n - 1) : 0 });
  },
  setPlaying: (playing) => {
    const { play, time } = get();
    // Restart from the top when pressing play at the end.
    if (playing && play && time >= play.n - 1.01) set({ time: Math.max(0, play.snap - 15) });
    set({ playing });
  },
  togglePlaying: () => get().setPlaying(!get().playing),
  setSpeed: (speed) => set({ speed }),
  select: (selected) => set({ selected }),
  hover: (hovered) => set({ hovered }),
  setCamera: (camera) => set((s) => ({ camera, cameraNonce: s.cameraNonce + 1 })),
  toggleRoutes: () => set((s) => ({ showRoutes: !s.showRoutes })),
  togglePanels: () => set((s) => ({ panelsHidden: !s.panelsHidden })),
  setQb: (q) => set((s) => ({ qb: { ...s.qb, ...q } })),
}));
