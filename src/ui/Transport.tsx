import { useEffect, useMemo, useRef } from 'react';
import { timelineEvents } from '../lib/playMath';
import { useStore, type CameraMode } from '../lib/store';
import type { Play } from '../lib/types';
import { PanelsIcon, PauseIcon, PlayIcon, RestartIcon, RouteIcon, StepBackIcon, StepFwdIcon } from './icons';

const SPEEDS = [0.25, 0.5, 1, 2];
const CAMS: { id: CameraMode; label: string; key: string }[] = [
  { id: 'broadcast', label: 'Broadcast', key: '1' },
  { id: 'all22', label: 'All-22', key: '2' },
  { id: 'endzone', label: 'End zone', key: '3' },
  { id: 'qb', label: 'QB', key: '4' },
  { id: 'follow', label: 'Follow', key: '5' },
  { id: 'free', label: 'Free', key: '6' },
];

export function Timeline({ play, locked = false }: { play: Play; locked?: boolean }) {
  const fill = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const clock = useRef<HTMLDivElement>(null);
  const max = play.n - 1;
  const events = useMemo(() => timelineEvents(play), [play]);

  useEffect(() => {
    const paint = (t: number) => {
      const pct = (t / max) * 100;
      if (fill.current) fill.current.style.width = `${pct}%`;
      if (thumb.current) thumb.current.style.left = `${pct}%`;
      if (input.current && document.activeElement !== input.current) input.current.value = String(t);
      if (clock.current) {
        const sec = (t - play.snap) / play.fps;
        clock.current.textContent = `${sec < 0 ? '−' : '+'}${Math.abs(sec).toFixed(1)}s from snap`;
      }
    };
    paint(useStore.getState().time);
    return useStore.subscribe((s) => paint(s.time));
  }, [play, max]);

  const seek = (t: number) => {
    if (locked) return;
    const st = useStore.getState();
    st.setPlaying(false);
    st.setTime(t);
  };

  return (
    <div className="timeline">
      {events.map((e) => (
        <button
          key={e.label}
          className="timeline__event"
          style={{ left: `${(e.frame / max) * 100}%` }}
          onClick={() => seek(e.frame)}
          disabled={locked}
          title={`Jump to ${e.label.toLowerCase()}`}
        >
          {e.label}
        </button>
      ))}
      <div className="timeline__track">
        <div className="timeline__presnap" style={{ width: `${(play.snap / max) * 100}%` }} />
        <div className="timeline__fill" ref={fill} />
      </div>
      <div className="timeline__thumb" ref={thumb} />
      <input
        ref={input}
        className="timeline__input"
        type="range"
        min={0}
        max={max}
        step={0.1}
        defaultValue={0}
        aria-label="Play timeline"
        disabled={locked}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <div className="timeline__clock" ref={clock} />
    </div>
  );
}

/** Camera switcher, shown in the corner of the 3D view. */
export function CameraSwitch() {
  const camera = useStore((s) => s.camera);
  const setCamera = useStore((s) => s.setCamera);
  return (
    <div className="segmented camswitch" role="group" aria-label="Camera">
      {CAMS.map((c) => (
        <button key={c.id} aria-pressed={camera === c.id} onClick={() => setCamera(c.id)} title={`${c.label} camera (${c.key})`}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function Transport({ play, locked = false, cameras = true }: { play: Play; locked?: boolean; cameras?: boolean }) {
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const showRoutes = useStore((s) => s.showRoutes);
  const panelsHidden = useStore((s) => s.panelsHidden);
  const st = useStore.getState;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const s = st();
      if (e.code === 'Space') {
        e.preventDefault();
        if (!locked) s.togglePlaying();
      } else if (e.key === 'ArrowRight' && !locked) {
        s.setPlaying(false);
        s.setTime(Math.round(s.time) + (e.shiftKey ? 10 : 1));
      } else if (e.key === 'ArrowLeft' && !locked) {
        s.setPlaying(false);
        s.setTime(Math.round(s.time) - (e.shiftKey ? 10 : 1));
      } else if (e.key.toLowerCase() === 'h') {
        s.togglePanels();
      } else if (e.key.toLowerCase() === 'r' && !locked) {
        s.setTime(Math.max(0, play.snap - 15));
        s.setPlaying(true);
      } else if (cameras && !e.metaKey && !e.ctrlKey) {
        const cam = CAMS.find((c) => c.key === e.key);
        if (cam && s.mode !== 'qb') s.setCamera(cam.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [play, locked, cameras, st]);

  return (
    <div className="transport">
      <div className="transport__group">
        <button className="iconbtn" onClick={() => { st().setPlaying(false); st().setTime(Math.round(st().time) - 1); }} disabled={locked} aria-label="Back one frame">
          <StepBackIcon />
        </button>
        <button className="iconbtn iconbtn--play" onClick={() => st().togglePlaying()} disabled={locked} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button className="iconbtn" onClick={() => { st().setPlaying(false); st().setTime(Math.round(st().time) + 1); }} disabled={locked} aria-label="Forward one frame">
          <StepFwdIcon />
        </button>
        <button className="iconbtn" onClick={() => { st().setTime(Math.max(0, play.snap - 15)); st().setPlaying(true); }} disabled={locked} aria-label="Replay from the snap">
          <RestartIcon />
        </button>
        <button
          className="speed"
          onClick={() => st().setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          aria-label={`Playback speed ${speed}x`}
          title="Playback speed"
        >
          {speed}×
        </button>
      </div>
      <Timeline play={play} locked={locked} />
      <div className="transport__group transport__group--cams">
        <button className="iconbtn" aria-pressed={showRoutes} onClick={() => st().toggleRoutes()} title="Route trails" aria-label="Route trails">
          <RouteIcon />
        </button>
        <button className="iconbtn" aria-pressed={panelsHidden} onClick={() => st().togglePanels()} title="Full-width view (H)" aria-label="Full-width view">
          <PanelsIcon />
        </button>
        <span className="divider" />
      </div>
    </div>
  );
}
