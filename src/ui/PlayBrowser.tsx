import { useEffect, useMemo, useState } from 'react';
import { loadGame } from '../lib/data';
import { downText } from '../lib/playMath';
import { useStore } from '../lib/store';
import { team, useData } from '../lib/teams';
import type { Featured, GameFile, GameSummary, Play } from '../lib/types';

type Filter = 'all' | 'pass' | 'run' | 'td' | 'big';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pass', label: 'Pass' },
  { id: 'run', label: 'Run' },
  { id: 'td', label: 'TDs' },
  { id: 'big', label: 'Big' },
];

const QTR = ['', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'];

function matches(p: Play, f: Filter) {
  switch (f) {
    case 'pass':
      return p.isPass;
    case 'run':
      return !p.isPass;
    case 'td':
      return /TOUCHDOWN/i.test(p.desc);
    case 'big':
      return Math.abs(p.epa ?? 0) >= 2 || (p.yards ?? 0) >= 20;
    default:
      return true;
  }
}

export function PlayBrowser({ onOpen }: { onOpen: (gameId: number, playId: number) => void }) {
  const index = useData((s) => s.index);
  const current = useStore((s) => s.play?.id);
  const [tab, setTab] = useState<'featured' | 'games'>('featured');
  const [gameId, setGameId] = useState<number | null>(null);
  const [game, setGame] = useState<GameFile | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const byWeek = useMemo(() => {
    const m = new Map<string, GameSummary[]>();
    index?.games.forEach((g) => {
      const k = g.season ? `${g.season} · Week ${g.week}` : 'Estimated from video';
      m.set(k, [...(m.get(k) ?? []), g]);
    });
    return [...m.entries()];
  }, [index]);

  useEffect(() => {
    if (gameId == null) return;
    let live = true;
    setGame(null);
    loadGame(gameId).then((g) => live && setGame(g));
    return () => {
      live = false;
    };
  }, [gameId]);

  if (!index) return null;
  const plays = game?.plays.filter((p) => matches(p, filter)) ?? [];

  return (
    <aside className="panel area-left" aria-label="Plays">
      <div className="panel__head">
        <div className="subtabs" role="tablist">
          <button className="subtab" role="tab" aria-selected={tab === 'featured'} onClick={() => setTab('featured')}>
            Featured
          </button>
          <button className="subtab" role="tab" aria-selected={tab === 'games'} onClick={() => setTab('games')}>
            All games
          </button>
        </div>
      </div>
      <div className="panel__scroll">
        {tab === 'featured' ? (
          <ul className="playlist">
            {index.featured.map((f) => (
              <li key={f.id}>
                <FeaturedItem f={f} current={current === f.id} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="section">
              <select
                className="select"
                value={gameId ?? ''}
                onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : null)}
                aria-label="Game"
              >
                <option value="">Select a game</option>
                {byWeek.map(([week, games]) => (
                  <optgroup key={week} label={week}>
                    {games.map((g) => (
                      <option key={g.gameId} value={g.gameId}>
                        {g.away} {g.awayScore ?? ''} at {g.home} {g.homeScore ?? ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {gameId != null && (
                <div className="chips" style={{ marginTop: 10 }}>
                  {FILTERS.map((f) => (
                    <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {gameId != null && !game && <p className="empty">Loading plays…</p>}
            {game && plays.length === 0 && <p className="empty">No plays match this filter.</p>}
            {game &&
              plays.map((p) => (
                <button key={p.id} className="compact-play" aria-current={current === p.id} onClick={() => onOpen(p.gameId, p.playId)}>
                  <span className="compact-play__when">
                    {QTR[p.quarter]} {p.clock}
                    <br />
                    <span className="compact-play__down">{p.offense}</span>
                  </span>
                  <span>
                    <span className="compact-play__down">{downText(p.down, p.ytg, p.los)}</span>
                    <span className="compact-play__desc">{p.desc.replace(/^\(\d+:\d+\)\s*/, '')}</span>
                  </span>
                </button>
              ))}
            {gameId == null && (
              <p className="empty">
                {index.games.length.toLocaleString()} games with player tracking.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export function TeamTag({ abbr }: { abbr: string }) {
  return (
    <span className="teamtag">
      <span className="teamtag__bar" style={{ background: team(abbr).primary }} />
      {abbr}
    </span>
  );
}

function FeaturedItem({ f, current, onOpen }: { f: Featured; current: boolean; onOpen: (g: number, p: number) => void }) {
  const result = f.yards != null && f.yards > 0 ? `${f.yards} yds` : null;
  return (
    <button
      className="play-row"
      aria-current={current}
      onClick={() => onOpen(f.gameId, f.playId)}
      style={{ '--accent-team': team(f.offense).primary } as React.CSSProperties}
    >
      <span className="play-row__top">
        <span className="matchup">
          <TeamTag abbr={f.away} />
          <span>at</span>
          <TeamTag abbr={f.home} />
        </span>
        <span>{f.season ? `${f.season} · Wk ${f.week}` : 'Video estimate'}</span>
      </span>
      <span className="play-row__title">{f.title}</span>
      <span className="play-row__meta">
        {f.quarter ? (
          <span>
            {QTR[f.quarter]} {f.clock.replace(/^0(\d)/, '$1')}
          </span>
        ) : null}
        {result && <span>{result}</span>}
        {f.film && <span className="tagline">Film</span>}
      </span>
    </button>
  );
}
