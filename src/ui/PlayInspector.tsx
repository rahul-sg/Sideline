import { useStore } from '../lib/store';
import { team } from '../lib/teams';
import type { Featured, Play } from '../lib/types';
import { routeColor } from '../scene/Overlays';
import { FilmPanel } from './FilmPanel';
import { TeamTag } from './PlayBrowser';

const RESULT: Record<string, string> = { C: 'Complete', I: 'Incomplete', IN: 'Interception', S: 'Sack', R: 'Scramble' };

function titleCase(s: string | null) {
  if (!s) return '—';
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "COVER_4_ZONE" / "Cover-3" → "Cover 4"; "ZONE_COVERAGE" → "Zone". */
function coverageLabel(c: string | null) {
  if (!c) return '—';
  const m = c.match(/cover[-_ ]?(\d)/i);
  if (m) return `Cover ${m[1]}${/man/i.test(c) && !/zone/i.test(c) ? ' Man' : ''}`;
  return titleCase(c.replace(/_(ZONE|MAN|COVERAGE)$/i, ''));
}

/** "Tre Hawkins III" → "Hawkins", "Odell Beckham Jr." → "Beckham". */
export function lastName(name: string) {
  const parts = name.split(' ').filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w));
  return parts[parts.length - 1] ?? name;
}

export function PlayInspector({ play, featured }: { play: Play; featured: Featured | null }) {
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const setCamera = useStore((s) => s.setCamera);
  const offWpa = play.homeWpa == null ? null : play.offense === play.home ? play.homeWpa : -play.homeWpa;
  const fromVideo = !!play.source?.includes('video');
  const result = fromVideo ? 'Unknown' : play.passResult ? RESULT[play.passResult] ?? play.passResult : 'Run';
  const off = play.players.map((p, i) => [p, i] as const).filter(([p]) => p.off);
  const def = play.players.map((p, i) => [p, i] as const).filter(([p]) => !p.off);

  const pick = (i: number) => {
    if (selected === i) {
      select(null);
      return;
    }
    select(i);
    setCamera('follow');
  };

  const note = fromVideo
    ? `Estimated from broadcast video: player detection, camera registration (fit error ${play.fitError?.toFixed(1)} px), jersey-color teams and jersey numbers read where players are big enough in frame. Positions are approximate; players are faded while off camera, and the ball isn’t tracked.`
    : play.source?.includes('2026')
      ? 'The 2023 release tracks the quarterback, route runners and coverage defenders (no linemen) and ends when the ball arrives. Faded players weren’t tracked after the throw; their movement is estimated.'
      : play.players.some((p) => p.modelled)
        ? 'Faded players aren’t tracked after the throw in this release; their movement after it is estimated.'
        : 'Player positions are NFL Next Gen Stats tracking (10 Hz). Body orientation is derived from movement in this release.';
  const kpis: { label: string; value: string; tone?: 'pos' | 'neg' }[] = [
    { label: 'Result', value: /TOUCHDOWN/i.test(play.desc) ? 'Touchdown' : result },
    { label: 'Yards', value: play.yards == null || fromVideo ? '—' : `${play.yards}` },
    { label: 'EPA', value: play.epa == null ? '—' : `${play.epa > 0 ? '+' : ''}${play.epa.toFixed(2)}`, tone: play.epa == null ? undefined : play.epa >= 0 ? 'pos' : 'neg' },
    { label: `${play.offense} win prob.`, value: offWpa == null ? '—' : `${offWpa > 0 ? '+' : ''}${(offWpa * 100).toFixed(1)}%`, tone: offWpa == null ? undefined : offWpa >= 0 ? 'pos' : 'neg' },
    { label: 'Coverage', value: coverageLabel(play.coverage) },
    { label: 'Formation', value: titleCase(play.formation) },
  ];

  return (
    <aside className="panel area-right" aria-label="Play details">
      <div className="panel__scroll">
        <div className="section">
          <div className="insp-meta">
            <TeamTag abbr={play.away} />
            <span>at</span>
            <TeamTag abbr={play.home} />
            <span style={{ marginLeft: 'auto' }}>{play.season ? `${play.season} · Week ${play.week}` : 'Video estimate'}</span>
          </div>
          <h2 className="insp-title">{featured?.title ?? `${play.offense} ${play.isPass ? 'pass' : 'run'}${play.yards != null ? `, ${play.yards} yards` : ''}`}</h2>
          <p className="insp-desc">{play.desc}</p>
          <div className="kpis">
            {kpis.map((k) => (
              <div className="kpi" key={k.label}>
                <div className="kpi__label">{k.label}</div>
                <div className={`kpi__value ${k.tone ?? ''}`}>{k.value}</div>
              </div>
            ))}
          </div>
          {play.playAction && <p className="note">Play action</p>}
          <details className="data-note">
            <summary>About this data</summary>
            <p>{note}</p>
          </details>
        </div>

        <div className="section">
          <p className="label">Personnel</p>
          <div className="personnel">
            {[off, def].map((side, k) => {
              const abbr = k === 0 ? play.offense : play.defense;
              return (
                <div key={abbr} style={{ '--team': team(abbr).primary } as React.CSSProperties}>
                  <div className="personnel__head">
                    {abbr}
                    <span style={{ font: '500 11px var(--body)', color: 'var(--text-3)', letterSpacing: 0 }}>{k === 0 ? 'Offense' : 'Defense'}</span>
                  </div>
                  {side.map(([p, i]) => (
                    <button
                      key={p.id}
                      className="person"
                      aria-pressed={selected === i}
                      onClick={() => pick(i)}
                      title={`${p.name}${p.pos ? ` · ${p.pos}` : ''}${p.route ? ` · ${p.route.toLowerCase()} route` : ''} — click to follow`}
                    >
                      <span className="person__num">{p.num ?? ''}</span>
                      <span className="person__name">
                        {lastName(p.name)}
                        {p.runner && <span className="dot" style={{ background: routeColor(play, i) }} />}
                      </span>
                      <span className="person__pos">{p.pos}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="section">
          <p className="label">Film</p>
          <FilmPanel play={play} builtIn={featured?.film ?? null} />
        </div>
      </div>
    </aside>
  );
}
