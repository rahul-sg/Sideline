import { useCallback, useEffect, useMemo, useState } from 'react';
import { separation } from '../lib/playMath';
import { useStore } from '../lib/store';
import { team, useData } from '../lib/teams';
import type { Play } from '../lib/types';
import { routeColor } from '../scene/Overlays';
import { lastName } from '../ui/PlayInspector';
import { ScoreBug } from '../ui/ScoreBug';
import { CameraSwitch, Transport } from '../ui/Transport';
import { DataMissing } from './DataMissing';
import { useOpenPlay } from './Theater';

const SCORE_KEY = 'sideline:qbread';
const DECISION_LEAD = 3; // freeze 0.3 s before the ball leaves the QB's hand

interface Tally {
  plays: number;
  matchedQb: number;
  pickedOpen: number;
}

function readTally(): Tally {
  try {
    return { plays: 0, matchedQb: 0, pickedOpen: 0, ...JSON.parse(localStorage.getItem(SCORE_KEY) ?? '{}') };
  } catch {
    return { plays: 0, matchedQb: 0, pickedOpen: 0 };
  }
}

function options(play: Play) {
  return play.players.map((p, i) => [p, i] as const).filter(([p]) => p.off && p.runner);
}

function arrivalFrame(play: Play) {
  return play.arrive ?? Math.min(play.n - 1, (play.throw ?? play.snap) + 10);
}

export function QBRead() {
  const index = useData((s) => s.index);
  const ready = useData((s) => s.ready);
  const play = useStore((s) => s.play);
  const qb = useStore((s) => s.qb);
  const open = useOpenPlay();
  const [tally, setTally] = useState<Tally>(readTally);
  const [scored, setScored] = useState<string | null>(null);

  const next = useCallback(async () => {
    const pool = useData.getState().index?.qbPool;
    if (!pool?.length) return;
    const st = useStore.getState();
    st.setQb({ phase: 'loading', pick: null });
    for (let attempt = 0; attempt < 5; attempt++) {
      const [g, p] = pool[Math.floor(Math.random() * pool.length)];
      const loaded = await open(g, p, { autoplay: false });
      if (loaded && loaded.throw != null) {
        st.setPlay(loaded, { time: Math.max(0, loaded.snap - 12), autoplay: true });
        st.setCamera('qb');
        st.setQb({ phase: 'watch', pick: null, freezeAt: Math.max(loaded.snap + 5, loaded.throw - DECISION_LEAD) });
        return;
      }
    }
  }, [open]);

  // Every visit starts on a fresh dropback.
  useEffect(() => {
    if (index?.qbPool.length) void next();
    return () => {
      const s = useStore.getState();
      s.setQb({ phase: 'loading', pick: null });
      s.setCamera('broadcast');
    };
  }, [index, next]);

  const opts = useMemo(() => (play ? options(play) : []), [play]);
  const results = useMemo(() => {
    if (!play || qb.phase !== 'reveal') return null;
    // Some releases stop tracking non-targeted receivers at the throw; measure there instead of guessing.
    const atThrow = opts.some(([p]) => p.modelled);
    const f = atThrow ? play.throw ?? arrivalFrame(play) : arrivalFrame(play);
    const rows = opts.map(([p, i]) => ({ p, i, sep: separation(play, i, f) }));
    const open = rows.reduce((a, b) => (b.sep > a.sep ? b : a), rows[0]);
    const target = rows.find((r) => r.p.target) ?? null;
    return { rows: rows.sort((a, b) => b.sep - a.sep), open, target, atThrow };
  }, [play, qb.phase, opts]);

  // Score once per play, then let the rest of the play run.
  useEffect(() => {
    if (!play || !results || qb.pick == null || scored === play.id) return;
    const t = {
      plays: tally.plays + 1,
      matchedQb: tally.matchedQb + (results.target?.i === qb.pick ? 1 : 0),
      pickedOpen: tally.pickedOpen + (results.open?.i === qb.pick ? 1 : 0),
    };
    setTally(t);
    setScored(play.id);
    try {
      localStorage.setItem(SCORE_KEY, JSON.stringify(t));
    } catch {
      /* storage unavailable */
    }
    const st = useStore.getState();
    st.setCamera('broadcast');
    st.setPlaying(true);
  }, [results, qb.pick, play, scored, tally]);

  // Number keys pick, N for next play.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.qb.phase === 'decide') {
        const k = Number(e.key);
        if (k >= 1 && k <= opts.length) st.setQb({ pick: opts[k - 1][1], phase: 'reveal' });
      } else if (st.qb.phase === 'reveal' && e.key.toLowerCase() === 'n') {
        void next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, next]);

  if (ready && !index)
    return (
      <div className="view-overlay">
        <DataMissing />
      </div>
    );
  if (!play)
    return (
      <div className="view-overlay">
        <div className="toast">Finding a dropback…</div>
      </div>
    );

  const pct = (a: number) => (tally.plays ? `${Math.round((a / tally.plays) * 100)}%` : '—');
  const last = lastName;

  return (
    <>
      <div className="view-overlay">
        {qb.phase !== 'reveal' && (
          <div className="qb-banner" role="status" aria-live="polite">
            {qb.phase === 'watch' && (
              <>
                <h2>Read the defense</h2>
                <p>
                  {team(play.offense).nick} ball{play.down ? `, ${['', '1st', '2nd', '3rd', '4th'][play.down]} & ${play.ytg}` : ''}. The
                  play freezes just before the throw.
                </p>
              </>
            )}
            {qb.phase === 'decide' && (
              <>
                <h2>Where is the ball going?</h2>
                <p>Select a receiver, or press 1–{opts.length}.</p>
                <div className="qb-options">
                  {opts.map(([p, i], k) => (
                    <button key={p.id} className="qb-option" onClick={() => useStore.getState().setQb({ pick: i, phase: 'reveal' })}>
                      <kbd>{k + 1}</kbd>
                      <span className="dot" style={{ background: routeColor(play, i) }} />
                      <span className="qb-option__num">{p.num ?? ''}</span>
                      {last(p.name)} <span style={{ color: 'var(--text-3)' }}>{p.pos}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {qb.phase === 'loading' && <h2>Finding a dropback…</h2>}
          </div>
        )}
        <ScoreBug play={play} />
        {qb.phase === 'reveal' && <CameraSwitch />}
      </div>

      {qb.phase === 'reveal' && (
        <div className="area-bar">
          <Transport play={play} />
        </div>
      )}

      {qb.phase === 'reveal' && results && (
        <aside className="panel area-right qb-result" aria-label="QB Read result" aria-live="polite">
          <div className="panel__scroll">
            <div className="section">
              <p className="label">Your read</p>
              <h2>
                {results.target?.i === qb.pick
                  ? 'Same read as the quarterback'
                  : `The QB threw to ${results.target ? `#${results.target.p.num ?? ''} ${last(results.target.p.name)}` : 'another receiver'}`}
              </h2>
              <p className="note">
                {play.passResult === 'C' ? `Complete, ${play.yards} yds` : play.passResult === 'IN' ? 'Intercepted' : 'Incomplete'} ·
                separation from the nearest defender {results.atThrow ? 'at the throw' : 'when the ball arrived'}
              </p>
              <div style={{ marginTop: 10 }}>
                {results.rows.map(({ p, i, sep }) => (
                  <div className="result-row" key={p.id}>
                    <span className="dot" style={{ background: routeColor(play, i) }} />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong>{p.num ?? ''}</strong> {p.name} <span style={{ color: 'var(--text-3)' }}>{p.route?.toLowerCase()}</span>
                    </span>
                    <span style={{ display: 'flex', gap: 4 }}>
                      {p.target && <span className="badge badge--qb">QB</span>}
                      {qb.pick === i && <span className="badge badge--you">You</span>}
                      {results.open?.i === i && <span className="badge badge--open">Open</span>}
                    </span>
                    <span style={{ fontWeight: 600 }}>{sep.toFixed(1)} yd</span>
                  </div>
                ))}
              </div>
              <div className="scoreline">
                <div>
                  {pct(tally.matchedQb)}
                  <span>Matched the QB</span>
                </div>
                <div>
                  {pct(tally.pickedOpen)}
                  <span>Picked most open</span>
                </div>
                <div>
                  {tally.plays}
                  <span>Reps</span>
                </div>
              </div>
              <button className="btn btn--primary" style={{ width: '100%', marginTop: 14, height: 36 }} onClick={() => void next()}>
                Next play <span style={{ opacity: 0.6, fontWeight: 500 }}>N</span>
              </button>
              <p className="note">
                “Most open” measures space {results.atThrow ? 'at the throw' : 'at arrival'} only. It doesn’t account for protection, timing
                or the play call.
              </p>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
