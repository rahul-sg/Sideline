import { useEffect, useMemo, useState } from 'react';
import { loadSeason } from '../lib/data';
import { team, visibleColor } from '../lib/teams';
import type { Season, SeasonGame } from '../lib/types';
import { ExternalIcon } from '../ui/icons';

const SEASON = 2026;

const lineColor = (abbr: string) => visibleColor(abbr);

function WinProbChart({ game }: { game: SeasonGame }) {
  const W = 720;
  const H = 260;
  const PAD = { l: 44, r: 14, t: 14, b: 28 };
  const end = Math.max(3600, ...game.wp.map(([s]) => s));
  const x = (s: number) => PAD.l + (s / end) * (W - PAD.l - PAD.r);
  const y = (p: number) => PAD.t + (1 - p) * (H - PAD.t - PAD.b);
  const homeC = lineColor(game.home);
  const awayC = lineColor(game.away);
  const pts = game.wp.length ? [[0, game.wp[0][1]] as [number, number], ...game.wp] : [];
  const line = pts.map(([s, p], i) => `${i ? 'L' : 'M'}${x(s).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${x(pts[pts.length - 1][0])},${y(0.5)} L${x(0)},${y(0.5)} Z` : '';
  const [hover, setHover] = useState<number | null>(null);
  const hp = hover != null ? pts.reduce((best, p) => (Math.abs(p[0] - hover) < Math.abs(best[0] - hover) ? p : best), pts[0]) : null;

  return (
    <svg
      className="wp-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Win probability chart for ${game.away} at ${game.home}`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const sx = ((e.clientX - r.left) / r.width) * W;
        setHover(Math.max(0, Math.min(end, ((sx - PAD.l) / (W - PAD.l - PAD.r)) * end)));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <clipPath id="wp-top">
          <rect x="0" y="0" width={W} height={y(0.5)} />
        </clipPath>
        <clipPath id="wp-bot">
          <rect x="0" y={y(0.5)} width={W} height={H} />
        </clipPath>
      </defs>
      {[0, 900, 1800, 2700, 3600].map((s, i) => (
        <g key={s}>
          <line x1={x(s)} x2={x(s)} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,.08)" />
          {i < 4 && (
            <text x={x(s + 450)} y={H - 8} fill="#5b6577" fontSize="12" textAnchor="middle" fontFamily="Barlow Condensed" fontWeight="700">
              Q{i + 1}
            </text>
          )}
        </g>
      ))}
      {end > 3600 && (
        <text x={x((3600 + end) / 2)} y={H - 8} fill="#5b6577" fontSize="12" textAnchor="middle" fontFamily="Barlow Condensed" fontWeight="700">
          OT
        </text>
      )}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(0.5)} y2={y(0.5)} stroke="rgba(255,255,255,.25)" strokeDasharray="3 4" />
      <text x={PAD.l - 8} y={y(1) + 4} fill={homeC} fontSize="13" textAnchor="end" fontFamily="Barlow Condensed" fontWeight="700">
        {game.home}
      </text>
      <text x={PAD.l - 8} y={y(0) + 4} fill={awayC} fontSize="13" textAnchor="end" fontFamily="Barlow Condensed" fontWeight="700">
        {game.away}
      </text>
      <path d={area} fill={homeC} opacity="0.22" clipPath="url(#wp-top)" />
      <path d={area} fill={awayC} opacity="0.22" clipPath="url(#wp-bot)" />
      <path d={line} fill="none" stroke="#eef2f8" strokeWidth="2" strokeLinejoin="round" />
      {hp && (
        <g>
          <line x1={x(hp[0])} x2={x(hp[0])} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,.3)" />
          <circle cx={x(hp[0])} cy={y(hp[1])} r="4.5" fill="#ffd400" />
          <text x={Math.min(W - 120, x(hp[0]) + 8)} y={PAD.t + 14} fill="#eef2f8" fontSize="13" fontFamily="Inter">
            {hp[1] >= 0.5 ? `${game.home} ${(hp[1] * 100).toFixed(0)}%` : `${game.away} ${((1 - hp[1]) * 100).toFixed(0)}%`}
          </text>
        </g>
      )}
    </svg>
  );
}

function DriveChart({ game }: { game: SeasonGame }) {
  return (
    <div className="drives">
      {game.drives.map((d, i) => {
        // Show both teams attacking to the right: position is yards from their own goal.
        const a = 100 - d.start100;
        const b = 100 - d.end100;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const scored = /touchdown|field goal/i.test(d.result ?? '');
        return (
          <div className="drive" key={i}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 700, color: lineColor(d.team) }}>{d.team}</span>
            <div className="drive__bar" title={`${d.plays} plays · ${d.result ?? ''}`}>
              <div className="drive__seg" style={{ left: `${lo}%`, width: `${Math.max(1, hi - lo)}%`, background: lineColor(d.team), opacity: scored ? 1 : 0.45 }} />
            </div>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.result ?? '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

/** nflverse game times are 24-hour Eastern. */
function kickoff(t: string | null) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} ET`;
}

function GameCard({ g, current, onClick }: { g: SeasonGame; current: boolean; onClick: () => void }) {
  const awayWon = g.final && (g.awayScore ?? 0) > (g.homeScore ?? 0);
  const homeWon = g.final && (g.homeScore ?? 0) > (g.awayScore ?? 0);
  return (
    <button className="gamecard" aria-current={current} onClick={onClick}>
      {[
        [g.away, g.awayScore, homeWon],
        [g.home, g.homeScore, awayWon],
      ].map(([abbr, score, lost]) => (
        <div key={String(abbr)} className={`gamecard__row ${lost ? 'loser' : ''}`}>
          <span className="swatch" style={{ background: team(String(abbr)).primary, width: 12, height: 12 }} />
          {String(abbr)} <span className="gamecard__nick">{team(String(abbr)).nick}</span>
          <span className="score">{score ?? ''}</span>
        </div>
      ))}
      <div className="gamecard__foot">
        <span>{g.final ? `Final${g.overtime ? '/OT' : ''}` : new Date(`${g.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        <span>{g.final ? '' : kickoff(g.time)}</span>
      </div>
    </button>
  );
}

export function ThisWeek() {
  const [season, setSeason] = useState<Season | null | undefined>(undefined);
  const [week, setWeek] = useState<number | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);

  useEffect(() => {
    loadSeason(SEASON).then((s) => {
      setSeason(s);
      if (s) setWeek(s.latestWeek);
    });
  }, []);

  const wk = useMemo(() => season?.weeks.find((w) => w.week === week) ?? null, [season, week]);
  useEffect(() => {
    if (!wk) return;
    const first = wk.games.find((g) => g.final) ?? wk.games[0];
    setGameId(first?.id ?? null);
  }, [wk]);
  const game = wk?.games.find((g) => g.id === gameId) ?? null;

  if (season === undefined) return <div className="page"><p className="empty">Loading the {SEASON} season…</p></div>;
  if (season === null)
    return (
      <div className="page">
        <div className="page__inner">
          <p className="empty">Season data isn’t built yet. Run npm run season, then refresh.</p>
        </div>
      </div>
    );

  const yt = game
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${team(game.away).name} vs ${team(game.home).name} ${SEASON} week ${game.week} highlights NFL`)}`
    : '#';

  return (
    <div className="page">
      <div className="page__inner">
        <div className="page__head">
          <div>
            <p className="label">Updated {new Date(season.builtAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</p>
            <h1>Week {week} · {SEASON} season</h1>
            <p>Scores, win probability and the plays that swung each game, from nflverse play-by-play.</p>
          </div>
          <div className="week-nav" role="group" aria-label="Week">
            {season.weeks.map((w) => (
              <button key={w.week} aria-pressed={w.week === week} disabled={!w.games.length} onClick={() => setWeek(w.week)}>
                {w.week}
              </button>
            ))}
          </div>
        </div>

        {wk && (
          <div className="games-grid">
            {wk.games.map((g) => (
              <GameCard key={g.id} g={g} current={g.id === gameId} onClick={() => setGameId(g.id)} />
            ))}
          </div>
        )}

        {game && (
          <div className="detail">
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <h2>
                  {team(game.away).nick} {game.awayScore ?? ''} at {team(game.home).nick} {game.homeScore ?? ''}
                </h2>
                <a className="btn" href={yt} target="_blank" rel="noreferrer">
                  <ExternalIcon /> Highlights on YouTube
                </a>
              </div>
              <p className="note">
                {game.stadium ?? ''}
                {game.roof ? ` · ${game.roof}` : ''}
              </p>
              {game.wp.length ? (
                <>
                  <p className="label" style={{ marginTop: 16 }}>
                    Win probability
                  </p>
                  <WinProbChart game={game} />
                  <p className="label" style={{ marginTop: 18 }}>
                    Drives · each team moving left to right
                  </p>
                  <DriveChart game={game} />
                </>
              ) : (
                <p className="empty">Not played yet.</p>
              )}
            </div>
            <div className="card">
              <p className="label">Biggest swings</p>
              {game.keyPlays.length === 0 && <p className="empty">No plays yet.</p>}
              {game.keyPlays.map((k) => {
                const forHome = k.homeWpa >= 0;
                const who = forHome ? game.home : game.away;
                return (
                  <div className="keyplay" key={k.playId}>
                    <span className="keyplay__when">
                      Q{k.qtr} {k.clock}
                      <br />
                      <span className="badge" style={{ marginTop: 4, display: 'inline-block', fontSize: 10 }}>
                        {k.tag}
                      </span>
                    </span>
                    <span>{k.desc}</span>
                    <span className="keyplay__swing" style={{ color: lineColor(who) }}>
                      {who} +{Math.abs(k.homeWpa * 100).toFixed(0)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
