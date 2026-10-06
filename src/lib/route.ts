import { useEffect } from 'react';
import { loadPlay } from './data';
import { useStore, type Mode } from './store';

/** URL paths for each page: #/replay, #/qb-read, … Replay adds the play: #/replay/2023110500-1234. */
const PATHS: Record<Mode, string> = {
  home: '',
  theater: 'replay',
  qb: 'qb-read',
  draw: 'route-finder',
  week: 'this-week',
  about: 'about',
};

export function parseHash(hash: string): { mode: Mode; play: [number, number] | null } {
  const [path = '', ref] = hash.replace(/^#\/?/, '').split('/');
  const mode = (Object.keys(PATHS) as Mode[]).find((m) => PATHS[m] === path) ?? 'home';
  const id = mode === 'theater' ? ref?.match(/^(\d+)-(\d+)$/) : null;
  return { mode, play: id ? [+id[1], +id[2]] : null };
}

export function hashFor(mode: Mode, play?: { gameId: number; playId: number } | null): string {
  const base = `#/${PATHS[mode]}`;
  return mode === 'theater' && play ? `${base}/${play.gameId}-${play.playId}` : base;
}

const same = (a: string, b: string) => (a || '#/') === (b || '#/');
/** While the URL is being applied to the app, the app doesn't write the URL back. */
let applying = false;

async function apply(hash: string) {
  const { mode, play } = parseHash(hash);
  const st = useStore.getState();
  applying = true;
  try {
    const want = play && (st.play?.gameId !== play[0] || st.play?.playId !== play[1]);
    if (want) st.setLoadingPlay(true); // Replay waits for this play instead of opening its default
    if (st.mode !== mode) st.setMode(mode);
    if (want) {
      const p = await loadPlay(play[0], play[1]);
      if (p) useStore.getState().setPlay(p);
      else useStore.getState().setLoadingPlay(false);
    }
  } finally {
    applying = false;
  }
}

/** Keeps the page and the URL in step: links and reloads land on the same page and play,
 * and the browser's back and forward buttons move between pages. */
export function useHashRouting() {
  useEffect(() => {
    void apply(location.hash);
    const onPop = () => void apply(location.hash);
    window.addEventListener('popstate', onPop);
    const unsub = useStore.subscribe((s, prev) => {
      if (applying) return;
      const h = hashFor(s.mode, s.play);
      if (same(h, location.hash)) return;
      // New page: new history entry. Another play on the same page: replace it.
      if (s.mode !== prev.mode) history.pushState(null, '', h);
      else if (s.play !== prev.play) history.replaceState(null, '', h);
    });
    return () => {
      window.removeEventListener('popstate', onPop);
      unsub();
    };
  }, []);
}
