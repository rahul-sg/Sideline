import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadPlay } from './lib/data';
import { useStore } from './lib/store';
import './styles/global.css';

// Dev-only handle for inspecting playback state from the browser console, and
// ?open=<gameId>-<playId>&t=<frame>&camera=<shot> to load a play paused (headless screenshots).
if (import.meta.env.DEV) {
  const open = async (gameId: number, playId: number) => useStore.getState().setPlay(await loadPlay(gameId, playId));
  Object.assign(window, { sideline: useStore, sidelineOpen: open });
  const q = new URLSearchParams(location.search);
  const id = q.get('open')?.match(/^(\d+)-(\d+)$/);
  if (id) {
    open(+id[1], +id[2]).then(() => {
      const st = useStore.getState();
      st.setPlaying(false);
      st.setTime(+(q.get('t') ?? 0));
      const cam = q.get('camera');
      if (cam) st.setCamera(cam as Parameters<typeof st.setCamera>[0]);
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
