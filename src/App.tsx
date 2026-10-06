import { useEffect } from 'react';
import { About } from './modes/About';
import { DrawFind } from './modes/DrawFind';
import { Home } from './modes/Home';
import { QBRead } from './modes/QBRead';
import { Theater } from './modes/Theater';
import { ThisWeek } from './modes/ThisWeek';
import { useHashRouting } from './lib/route';
import { useStore, type Mode } from './lib/store';
import { useData } from './lib/teams';
import { Stage } from './scene/Stage';
import { BrandMark } from './ui/icons';

const TABS: { id: Mode; label: string }[] = [
  { id: 'theater', label: 'Replay' },
  { id: 'qb', label: 'QB Read' },
  { id: 'draw', label: 'Route Finder' },
  { id: 'week', label: 'This Week' },
];

/** Short description of what's loaded, for the header. */
function sourceLine(source: string | undefined) {
  if (!source) return 'Loading data…';
  return source
    .replace('Big Data Bowl 2026 · 2023 season', '2023 season tracking')
    .replace('NFL Big Data Bowl sample game · 2017', '2017 KC–NE')
    .replace(' + ', ' · ');
}

export function App() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const index = useData((s) => s.index);
  const panelsHidden = useStore((s) => s.panelsHidden);
  const preview = useData((s) => s.preview);
  const init = useData((s) => s.init);
  const stageIdle = useStore((s) => s.stageIdle);
  const page = mode === 'draw' || mode === 'week' || mode === 'about';

  useEffect(() => {
    void init();
  }, [init]);
  useHashRouting();
  useEffect(() => {
    const t = TABS.find((x) => x.id === mode)?.label ?? (mode === 'about' ? 'About' : null);
    document.title = t ? `${t} · Sideline` : 'Sideline: real NFL plays in 3D';
  }, [mode]);

  return (
    <div className={`app ${panelsHidden ? 'panels-hidden' : ''}`}>
      <header className="topbar">
        <button className="brand" onClick={() => setMode('home')} aria-label="Sideline home">
          <BrandMark />
          Sideline
        </button>
        <nav className="tabs" role="tablist" aria-label="Mode">
          {TABS.map((t) => (
            <button key={t.id} className="tab" role="tab" aria-selected={mode === t.id} onClick={() => setMode(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className={`status ${preview ? 'status--preview' : ''}`} title={index?.source}>
          <span className="status__dot" />
          <span>{preview ? 'Preview: synthetic play, not real data' : sourceLine(index?.source)}</span>
        </div>
        <button className="tab tab--about" aria-current={mode === 'about' ? 'page' : undefined} onClick={() => setMode('about')}>
          About
        </button>
      </header>
      <main className="workspace" data-mode={mode}>
        <div className="stage" aria-hidden={page || mode === 'home'}>
          <Stage paused={page || stageIdle} />
        </div>
        {mode === 'home' && <Home />}
        {mode === 'about' && <About />}
        {mode === 'theater' && <Theater />}
        {mode === 'qb' && <QBRead />}
        {mode === 'draw' && <DrawFind />}
        {mode === 'week' && <ThisWeek />}
      </main>
    </div>
  );
}
