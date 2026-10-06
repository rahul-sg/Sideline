import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { team } from '../lib/teams';
import type { FilmRef, Play } from '../lib/types';
import { ExternalIcon, LinkIcon } from './icons';

/* Minimal typing for the YouTube IFrame API. */
interface YTPlayer {
  getCurrentTime(): number;
  getPlayerState(): number;
  seekTo(s: number, allowSeekAhead: boolean): void;
  pauseVideo(): void;
  playVideo(): void;
  destroy(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: object) => YTPlayer; PlayerState: { PLAYING: number } };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  apiPromise ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('YouTube API failed to load'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const store = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v')!.slice(0, 11);
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/**
 * Film next to the 3D replay. Built-in clips come from official NFL/team
 * channels; any other YouTube video can be attached per game. Marking the
 * snap once links the film and the 3D clock for that play.
 */
export function FilmPanel({ play, builtIn }: { play: Play; builtIn: FilmRef | null }) {
  const gameKey = `sideline:film:${play.gameId}`;
  const syncKey = `sideline:sync:${play.id}`;
  const [attached, setAttached] = useState<FilmRef | null>(() => store.get<FilmRef>(gameKey));
  const film = attached ?? builtIn;
  const [snapAt, setSnapAt] = useState<number | null>(() => store.get<number>(syncKey));
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);

  useEffect(() => {
    setAttached(store.get<FilmRef>(gameKey));
    setSnapAt(store.get<number>(syncKey));
    setLinked(false);
  }, [gameKey, syncKey]);

  useEffect(() => {
    if (!film || !host.current) return;
    let cancelled = false;
    setError(null);
    const mount = document.createElement('div');
    host.current.replaceChildren(mount);
    loadYouTubeApi()
      .then(() => {
        if (cancelled || !window.YT) return;
        player.current = new window.YT.Player(mount, {
          videoId: film.videoId,
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
          events: {
            onError: () => setError('This video can’t be played here. Open it on YouTube or attach another.'),
          },
        });
      })
      .catch(() => setError('Couldn’t reach YouTube. Check your connection.'));
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
    };
  }, [film?.videoId]);

  // When linked, the film drives the 3D clock.
  useEffect(() => {
    if (!linked || snapAt == null) return;
    let raf = 0;
    const tick = () => {
      const p = player.current;
      if (p && window.YT) {
        const st = useStore.getState();
        if (st.play?.id === play.id) {
          const t = play.snap + (p.getCurrentTime() - snapAt) * play.fps;
          st.setTime(t);
          if (st.playing) st.setPlaying(false);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [linked, snapAt, play]);

  const markSnap = () => {
    const p = player.current;
    if (!p) return;
    const t = p.getCurrentTime();
    setSnapAt(t);
    store.set(syncKey, t);
    useStore.getState().setTime(play.snap);
    setLinked(true);
  };

  const jumpFilm = () => {
    const p = player.current;
    if (!p || snapAt == null) return;
    const t = useStore.getState().time;
    p.seekTo(Math.max(0, snapAt + (t - play.snap) / play.fps), true);
  };

  const attach = () => {
    const id = parseYouTubeId(draft);
    if (!id) {
      setError('That doesn’t look like a YouTube link.');
      return;
    }
    const ref = { videoId: id, channel: 'Attached by you', title: 'Your video' };
    store.set(gameKey, ref);
    setAttached(ref);
    setDraft('');
  };

  const detach = () => {
    store.set(gameKey, null);
    setAttached(null);
    setLinked(false);
  };

  const query = `${team(play.away).name} vs ${team(play.home).name} ${play.season} week ${play.week} highlights`;
  const search = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

  return (
    <div>
      {film ? (
        <>
          <div className="film" ref={host} />
          <p className="note" style={{ marginTop: 6 }}>
            {film.channel} · {film.title}
          </p>
          {error && <p className="note" style={{ color: 'var(--bad)' }}>{error}</p>}
          <div className="film-actions">
            <button className="btn btn--primary" onClick={markSnap} title="Pause the video exactly on the snap, then press this">
              Mark snap here
            </button>
            {snapAt != null && (
              <>
                <button className="btn" aria-pressed={linked} onClick={() => setLinked((v) => !v)}>
                  <LinkIcon /> {linked ? 'Linked to film' : 'Link to film'}
                </button>
                <button className="btn" onClick={jumpFilm}>Film to this moment</button>
              </>
            )}
            {attached && (
              <button className="btn btn--ghost" onClick={detach}>
                Remove video
              </button>
            )}
          </div>
          <p className="note">
            {snapAt == null
              ? 'Find this play in the video, pause on the snap and press “Mark snap here”. The 3D replay then follows the film.'
              : linked
                ? 'Playing or scrubbing the video now drives the 3D replay.'
                : `Snap marked at ${snapAt.toFixed(1)}s.`}
          </p>
        </>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            No official clip saved for this game yet. Find one, then paste the link to watch it beside the replay.
          </p>
          <div className="film-actions">
            <a className="btn" href={search} target="_blank" rel="noreferrer">
              <ExternalIcon /> Search YouTube
            </a>
          </div>
          {error && <p className="note" style={{ color: 'var(--bad)' }}>{error}</p>}
        </>
      )}
      <div className="film-actions" style={{ marginTop: 10 }}>
        <input
          className="input"
          placeholder={film ? 'Use a different YouTube link…' : 'Paste a YouTube link…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && attach()}
          aria-label="YouTube link"
        />
        <button className="btn" onClick={attach} disabled={!draft.trim()}>
          Attach
        </button>
      </div>
    </div>
  );
}
