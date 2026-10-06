import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { loadPlay, loadSeason } from '../lib/data';
import { sample } from '../lib/playMath';
import { useStore } from '../lib/store';
import { team, useData } from '../lib/teams';
import type { Featured, Play, Season } from '../lib/types';
import { FormationDiagram, MiniField, ReadDiagram, RoutesDiagram, windowAround } from '../ui/MiniField';
import { TeamTag } from '../ui/PlayBrowser';
import { ScoreBug } from '../ui/ScoreBug';
import { SiteFooter } from '../ui/SiteFooter';

const SEASON = 2026;
const QTR = ['', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'];
const fmt = (n: number) => n.toLocaleString('en-US');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The Hill touchdown, tracked by the NFL and rebuilt from the broadcast: the video section compares the two. */
const COMPARE = { tracked: [2017090700, 2756] as const, video: [9000002756, 1] as const };

function useOnScreen(ref: RefObject<Element>, margin = '0px', initial = false) {
  const [on, setOn] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin]);
  return on;
}

/** Open a play in Replay and start it. */
async function watch(gameId: number, playId: number) {
  const st = useStore.getState();
  const current = st.play?.gameId === gameId && st.play?.playId === playId ? st.play : null;
  if (!current) st.setLoadingPlay(true);
  st.setMode('theater');
  const play = current ?? (await loadPlay(gameId, playId));
  if (!play) return useStore.getState().setLoadingPlay(false);
  useStore.getState().setPlay(play, { autoplay: true });
}

function Hero({ reel, heroRef }: { reel: Featured[]; heroRef: RefObject<HTMLElement> }) {
  const missing = useData((s) => s.ready && !s.index);
  const play = useStore((s) => s.play);
  const playing = useStore((s) => s.playing);
  const [k, setK] = useState<number | null>(null);
  const still = useRef(reducedMotion());

  // Start on the play already showing if it's one of these, else the first.
  useEffect(() => {
    if (k != null || !reel.length) return;
    const cur = useStore.getState().play;
    const i = reel.findIndex((f) => f.gameId === cur?.gameId && f.playId === cur?.playId);
    setK(Math.max(0, i));
  }, [reel, k]);

  useEffect(() => {
    if (k == null || !reel.length) return;
    const f = reel[k % reel.length];
    let live = true;
    const st = useStore.getState();
    st.setCamera('showcase');
    if (st.play?.gameId === f.gameId && st.play?.playId === f.playId) {
      st.setTime(Math.max(0, st.play.snap - 15));
      st.setPlaying(!still.current);
    } else {
      void loadPlay(f.gameId, f.playId).then((p) => {
        if (live && p && useStore.getState().mode === 'home') useStore.getState().setPlay(p, { autoplay: !still.current });
      });
    }
    return () => {
      live = false;
    };
  }, [k, reel]);

  // When a play finishes, hold on the last frame for a beat, then roll the next one.
  useEffect(() => {
    let timer = 0;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.mode === 'home' && prev.playing && !s.playing && s.play && s.time >= s.play.n - 1.01) {
        timer = window.setTimeout(() => setK((x) => (x ?? 0) + 1), 1600);
      }
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, []);

  const now = reel.find((f) => f.gameId === play?.gameId && f.playId === play?.playId) ?? null;
  const togglePause = () => {
    still.current = playing;
    useStore.getState().setPlaying(!playing);
  };

  return (
    <section className="hero" ref={heroRef} aria-labelledby="hero-title">
      <div className="hero__inner">
        <div className="hero__copy">
          <p className="eyebrow">Real NFL tracking, rebuilt in 3D</p>
          <h1 className="hero__title" id="hero-title">
            See the whole field.
          </h1>
          <p className="hero__lede">
            Every player on every snap, ten times a second, from the NFL’s own player tracking. Replay a play from any angle, make the
            quarterback’s read, or find a route by drawing it.
          </p>
          {missing ? (
            <div className="hero__missing">
              <p>
                The tracking data isn’t built on this computer yet. Run <code>npm run data</code>, then refresh. This week’s games work without
                it.
              </p>
              <div className="hero__actions">
                <button className="btn btn--primary btn--lg" onClick={() => useStore.getState().setMode('week')}>
                  See this week’s games
                </button>
                <button className="btn btn--lg" onClick={() => useStore.getState().setMode('theater')}>
                  Preview the 3D engine
                </button>
              </div>
            </div>
          ) : (
            <div className="hero__actions">
              <button className="btn btn--primary btn--lg" disabled={!now} onClick={() => now && void watch(now.gameId, now.playId)}>
                Watch this play
              </button>
              <button className="btn btn--lg" onClick={() => useStore.getState().setMode('qb')}>
                Make a QB read
              </button>
            </div>
          )}
        </div>
        <div className="hero__foot">
          {now && play && (
            <div className="hero__now">
              <p className="hero__caption">
                <span className="hero__label">Now showing</span>
                <span className="hero__now-title">{now.title}</span>
                <span className="hero__now-meta">
                  {now.season} · Week {now.week}
                </span>
              </p>
              <ScoreBug play={play} />
            </div>
          )}
          <div className="hero__controls">
            <button className="btn btn--ghost" onClick={togglePause} aria-label={playing ? 'Pause the background replay' : 'Play the background replay'}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button className="btn btn--ghost" onClick={() => setK((x) => (x ?? 0) + 1)} disabled={reel.length < 2}>
              Next play →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stats() {
  const index = useData((s) => s.index);
  if (!index) return null;
  const tracked = index.games.filter((g) => !/video/i.test(g.source ?? ''));
  const items = [
    { n: fmt(tracked.reduce((a, g) => a + g.plays, 0)), label: 'real plays to replay' },
    { n: fmt(tracked.length), label: 'games, 2017 and 2023' },
    ...(index.routeCount ? [{ n: fmt(index.routeCount), label: 'routes to search' }] : []),
    { n: '10 Hz', label: 'every tracked player, ten times a second' },
  ];
  return (
    <section className="home-stats" aria-label="What’s in Sideline">
      {items.map((s) => (
        <div className="home-stat" key={s.label}>
          <span className="home-stat__n">{s.n}</span>
          <span className="home-stat__label">{s.label}</span>
        </div>
      ))}
    </section>
  );
}

function Scores({ season }: { season: Season | null | undefined }) {
  if (season === undefined) return <div className="tool__fallback">Loading scores…</div>;
  if (!season) return <div className="tool__fallback">Season data isn’t built yet.</div>;
  const week = season.weeks.find((w) => w.week === season.latestWeek) ?? season.weeks[0];
  const games = [...(week?.games ?? [])].sort((a, b) => Number(b.final) - Number(a.final)).slice(0, 5);
  return (
    <div className="scores" aria-label={`Week ${week?.week} scores`}>
      <p className="scores__head">
        Week {week?.week} · {SEASON}
      </p>
      {games.map((g) => (
        <div className="scores__row" key={g.id}>
          <span className="scores__team">
            <TeamTag abbr={g.away} />
            <b>{g.awayScore ?? ''}</b>
          </span>
          <span className="scores__team">
            <TeamTag abbr={g.home} />
            <b>{g.homeScore ?? ''}</b>
          </span>
          <span className="scores__state">{g.final ? (g.overtime ? 'Final/OT' : 'Final') : g.date.slice(5).replace('-', '/')}</span>
        </div>
      ))}
    </div>
  );
}

const CAMERAS = ['Broadcast', 'All-22', 'End zone', 'QB', 'Follow', 'Free'];

function Tools({ diagram, sample: shown }: { diagram: Play | null; sample: Featured | null }) {
  const index = useData((s) => s.index);
  const setMode = useStore((s) => s.setMode);
  const ref = useRef<HTMLElement>(null);
  const near = useOnScreen(ref, '400px');
  const [season, setSeason] = useState<Season | null | undefined>(undefined);
  useEffect(() => {
    if (near && season === undefined) void loadSeason(SEASON).then(setSeason);
  }, [near, season]);
  const latest = season?.latestWeek;
  const tools = [
    {
      mode: 'theater' as const,
      name: 'Replay',
      title: 'Any play, any angle.',
      text: 'Scrub through real plays in 3D. Watch from the broadcast camera, the All-22, the end zone or the quarterback’s eyes, or follow one player.',
      detail: index ? `${fmt(index.games.filter((g) => !/video/i.test(g.source ?? '')).reduce((a, g) => a + g.plays, 0))} plays` : '',
      visual: diagram ? (
        <>
          <FormationDiagram play={diagram} />
          <div className="tool__cams" aria-hidden="true">
            {CAMERAS.map((c, i) => (
              <span key={c} className={i === 0 ? 'is-on' : ''}>
                {c}
              </span>
            ))}
          </div>
        </>
      ) : null,
    },
    {
      mode: 'qb' as const,
      name: 'QB Read',
      title: 'Make the read.',
      text: 'The play freezes as the quarterback throws. Pick your receiver, then see where the ball really went and how open everyone was.',
      detail: index ? `${fmt(index.qbPool.length)} plays to read` : '',
      visual: diagram ? <ReadDiagram play={diagram} /> : null,
    },
    {
      mode: 'draw' as const,
      name: 'Route Finder',
      title: 'Draw a route, find it.',
      text: 'Sketch a route on the field. Sideline searches every route in the data for the closest matches and takes you to the play.',
      detail: index?.routeCount ? `${fmt(index.routeCount)} routes` : '',
      visual: diagram ? <RoutesDiagram play={diagram} /> : null,
    },
    {
      mode: 'week' as const,
      name: 'This Week',
      title: 'The season as it happens.',
      text: 'Scores, win-probability charts and the plays that swung each game, from play-by-play updated through the season.',
      detail: latest ? `${SEASON} season · Week ${latest}` : `${SEASON} season`,
      visual: <Scores season={season} />,
    },
  ];
  return (
    <section className="home-section" ref={ref} aria-labelledby="tools-title">
      <header className="home-section__head">
        <p className="eyebrow">What you can do</p>
        <h2 id="tools-title">Four ways into the game</h2>
      </header>
      <div className="tools">
        {tools.map((t, i) => (
          <article className="tool" key={t.mode}>
            <button className="tool__visual" onClick={() => setMode(t.mode)} aria-label={`Open ${t.name}`} tabIndex={-1}>
              {t.visual ?? <div className="tool__fallback" />}
            </button>
            <div className="tool__body">
              <p className="tool__name">
                <span className="tool__num">0{i + 1}</span>
                {t.name}
              </p>
              <h3>{t.title}</h3>
              <p>{t.text}</p>
              <div className="tool__foot">
                <span className="tool__detail">{t.detail}</span>
                <button className="btn" onClick={() => setMode(t.mode)}>
                  Open {t.name} →
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {shown && diagram && (
        <p className="home-note">
          Diagrams: {shown.title}, {shown.season} Week {shown.week}, from its tracking data.
        </p>
      )}
    </section>
  );
}

function FeaturedPlays({ plays }: { plays: Featured[] }) {
  const setMode = useStore((s) => s.setMode);
  return (
    <section className="home-section" aria-labelledby="featured-title">
      <header className="home-section__head home-section__head--row">
        <div>
          <p className="eyebrow">Start here</p>
          <h2 id="featured-title">Plays worth watching</h2>
        </div>
        <button className="btn" onClick={() => setMode('theater')}>
          Browse every play →
        </button>
      </header>
      <div className="featured">
        {plays.map((f) => (
          <button
            key={f.id}
            className="feature"
            onClick={() => void watch(f.gameId, f.playId)}
            style={{ '--accent-team': team(f.offense).primary } as React.CSSProperties}
          >
            <span className="feature__top">
              <span className="matchup">
                <TeamTag abbr={f.away} />
                <span>at</span>
                <TeamTag abbr={f.home} />
              </span>
              <span>
                {f.season} · Wk {f.week}
              </span>
            </span>
            <span className="feature__title">{f.title}</span>
            <span className="feature__meta">
              {QTR[f.quarter]} {f.clock.replace(/^0(\d)/, '$1')}
              {f.yards != null && f.yards > 0 ? ` · ${f.yards} yds` : ''}
              <span className="feature__go">Watch →</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** NFL tracking (rings) against the video estimate (dots) of the same play, 1.2 s after the snap. */
function Compare({ tracked, video }: { tracked: Play; video: Play }) {
  const k = 12;
  const tt = Math.min(tracked.n - 1, tracked.snap + k);
  const tv = Math.min(video.n - 1, video.snap + k);
  const [x0, x1] = windowAround(tracked.los, 12, 22);
  return (
    <figure className="compare">
      <MiniField x0={x0} x1={x1} los={tracked.los} label="NFL tracking compared with positions estimated from broadcast video">
        {(pt) => (
          <>
            {tracked.players.map((_, i) => {
              const [cx, cy] = pt(sample(tracked.x[i], tt), sample(tracked.y[i], tt));
              return <circle key={`t${i}`} cx={cx} cy={cy} r={12} className="compare__truth" />;
            })}
            {video.players.map((p, i) => {
              if (p.seen && !p.seen.some(([a, b]) => tv >= a && tv <= b)) return null;
              const [cx, cy] = pt(sample(video.x[i], tv), sample(video.y[i], tv));
              return <circle key={`v${i}`} cx={cx} cy={cy} r={6.5} className="compare__video" />;
            })}
          </>
        )}
      </MiniField>
      <figcaption>
        <span className="compare__key">
          <i className="compare__ring" /> NFL tracking
        </span>
        <span className="compare__key">
          <i className="compare__dot" /> Estimated from the TV broadcast
        </span>
        <span className="compare__what">Smith to Hill, 2017 Week 1, 1.2 s after the snap</span>
      </figcaption>
    </figure>
  );
}

function FromVideo() {
  const index = useData((s) => s.index);
  const setMode = useStore((s) => s.setMode);
  const ref = useRef<HTMLElement>(null);
  const near = useOnScreen(ref, '400px');
  const available = !!index?.featured.some((f) => f.gameId === COMPARE.video[0]);
  const [pair, setPair] = useState<[Play, Play] | null>(null);
  useEffect(() => {
    if (!near || !available || pair) return;
    void Promise.all([loadPlay(...COMPARE.tracked), loadPlay(...COMPARE.video)]).then(([a, b]) => a && b && setPair([a, b]));
  }, [near, available, pair]);
  return (
    <section className="home-section home-video" ref={ref} aria-labelledby="video-title">
      <div className="home-video__copy">
        <p className="eyebrow">From the broadcast</p>
        <h2 id="video-title">No tracking? Use the TV feed.</h2>
        <p>
          Most games never get public tracking data. Sideline’s vision pipeline estimates it from the broadcast instead: it finds each play
          by reading the game clock, locks onto the painted lines, follows every player and reads jersey numbers where they’re big enough.
          It runs on this computer, and it was checked against the NFL’s own tracking of a full game.
        </p>
        <dl className="figures">
          <div>
            <dt>1.5 yd</dt>
            <dd>median position error over 50 plays</dd>
          </div>
          <div>
            <dt>50 of 68</dt>
            <dd>plays found and started with no manual setup</dd>
          </div>
          <div>
            <dt>91%</dt>
            <dd>of jersey names right, checked by eye</dd>
          </div>
        </dl>
        <div className="hero__actions">
          {available && (
            <button className="btn btn--primary btn--lg" onClick={() => void watch(...COMPARE.video)}>
              Watch a play rebuilt from video
            </button>
          )}
          <button className="btn btn--lg" onClick={() => setMode('about')}>
            How it was measured
          </button>
        </div>
      </div>
      <div className="home-video__visual">{pair ? <Compare tracked={pair[0]} video={pair[1]} /> : <div className="compare compare--empty" />}</div>
    </section>
  );
}

function DataBand() {
  const setMode = useStore((s) => s.setMode);
  return (
    <section className="home-section" aria-labelledby="data-title">
      <header className="home-section__head">
        <p className="eyebrow">The data</p>
        <h2 id="data-title">Real plays, not simulations</h2>
      </header>
      <div className="sources">
        <div>
          <h3>Player tracking</h3>
          <p>
            NFL Next Gen Stats tracking released through the Big Data Bowl: every 2023 pass play (quarterback, receivers and coverage) and a
            full 2017 game with all 22 players and the ball.
          </p>
        </div>
        <div>
          <h3>Play-by-play</h3>
          <p>
            nflverse play-by-play for everything around the tracking: down and distance, expected points, win probability, and this season’s
            scores.
          </p>
        </div>
        <div>
          <h3>Motion</h3>
          <p>
            Motion-captured running, throwing and catching, timed to each play’s real snap, throw and catch. Anything the data doesn’t cover is
            shown faded and labelled.
          </p>
        </div>
      </div>
      <button className="btn" onClick={() => setMode('about')}>
        What’s measured and what’s modelled →
      </button>
    </section>
  );
}

export function Home() {
  const index = useData((s) => s.index);
  const heroRef = useRef<HTMLElement>(null);
  const heroOn = useOnScreen(heroRef, '0px', true);
  const setStageIdle = useStore((s) => s.setStageIdle);
  const reel = useMemo(() => index?.featured.filter((f) => f.season > 0) ?? [], [index]);
  const [diagram, setDiagram] = useState<Play | null>(null);

  // Stop drawing the 3D view once it has scrolled out of sight.
  useEffect(() => setStageIdle(!heroOn), [heroOn, setStageIdle]);
  useEffect(() => () => setStageIdle(false), [setStageIdle]);

  useEffect(() => {
    if (reel[0]) void loadPlay(reel[0].gameId, reel[0].playId).then(setDiagram);
  }, [reel]);

  return (
    <div className="home">
      <Hero reel={reel} heroRef={heroRef} />
      <Stats />
      <Tools diagram={diagram} sample={reel[0] ?? null} />
      <FeaturedPlays plays={reel.slice(0, 6)} />
      <FromVideo />
      <DataBand />
      <SiteFooter />
    </div>
  );
}
