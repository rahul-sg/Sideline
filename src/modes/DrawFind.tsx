import { useEffect, useMemo, useRef, useState } from 'react';
import { loadRoutes } from '../lib/data';
import { FIELD_W } from '../lib/playMath';
import { libraryRoute, matchRoutes, toRouteSpace, type Pt, type RouteMatch } from '../lib/routes';
import { useStore } from '../lib/store';
import { team, useData } from '../lib/teams';
import type { RouteLibrary } from '../lib/types';
import { DataMissing } from './DataMissing';
import { useOpenPlay } from './Theater';

// Board: full field width across, 5 yards behind to 35 yards past the line.
const BEHIND = 5;
const AHEAD = 35;
const DEPTH = BEHIND + AHEAD;
const BALL_Y = FIELD_W / 2;
const HASH = 70.75 / 3;

type Sketch = Pt[]; // [depth past LOS, field y]

function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number, sketch: Sketch, preview: Pt[] | null) {
  const sx = w / FIELD_W;
  const sy = h / DEPTH;
  const X = (fy: number) => (FIELD_W - fy) * sx; // offense's left is screen left
  const Y = (d: number) => h - (d + BEHIND) * sy;
  ctx.clearRect(0, 0, w, h);
  // Turf stripes every 5 yards
  for (let d = -BEHIND; d < AHEAD; d += 5) {
    ctx.fillStyle = Math.round((d + BEHIND) / 5) % 2 ? '#2b5a30' : '#30633a';
    ctx.fillRect(0, Y(d + 5), w, 5 * sy);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = Math.max(1, sx * 0.12);
  for (let d = -BEHIND; d <= AHEAD; d += 5) {
    ctx.beginPath();
    ctx.moveTo(0, Y(d));
    ctx.lineTo(w, Y(d));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let d = -BEHIND; d <= AHEAD; d++) {
    if (d % 5 === 0) continue;
    for (const fy of [HASH, FIELD_W - HASH]) ctx.fillRect(X(fy) - sx * 0.35, Y(d) - 0.5, sx * 0.7, 1.5);
  }
  ctx.font = `600 ${Math.round(12 * (w / 800) + 6)}px Inter, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  for (let d = 5; d < AHEAD; d += 5) ctx.fillText(`+${d}`, 8, Y(d) - 4);
  // Line of scrimmage and ball
  ctx.strokeStyle = '#2f8cff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, Y(0));
  ctx.lineTo(w, Y(0));
  ctx.stroke();
  ctx.fillStyle = '#7a3a18';
  ctx.beginPath();
  ctx.ellipse(X(BALL_Y), Y(0), sx * 0.5, sy * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  const path = (pts: Pt[], color: string, width: number, dash: number[] = []) => {
    if (pts.length < 2) return;
    ctx.save();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([d, fy], i) => (i ? ctx.lineTo(X(fy), Y(d)) : ctx.moveTo(X(fy), Y(d))));
    ctx.stroke();
    // Arrowhead
    const [d1, y1] = pts[pts.length - 1];
    const [d0, y0] = pts[Math.max(0, pts.length - 4)];
    const ang = Math.atan2(Y(d1) - Y(d0), X(y1) - X(y0));
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(X(y1) + Math.cos(ang) * width * 2.4, Y(d1) + Math.sin(ang) * width * 2.4);
    ctx.lineTo(X(y1) + Math.cos(ang + 2.4) * width * 2.6, Y(d1) + Math.sin(ang + 2.4) * width * 2.6);
    ctx.lineTo(X(y1) + Math.cos(ang - 2.4) * width * 2.6, Y(d1) + Math.sin(ang - 2.4) * width * 2.6);
    ctx.fill();
    ctx.restore();
  };
  if (preview) path(preview, 'rgba(56,225,255,0.9)', 3, [8, 6]);
  path(sketch, '#ffd400', 4.5);
  if (sketch.length) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(X(sketch[0][1]), Y(sketch[0][0]), 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A library route drawn as if run from the sketch's starting spot. */
function placeRoute(route: Pt[], sketch: Sketch): Pt[] {
  const [d0, y0] = sketch[0];
  const side = y0 >= BALL_Y - 0.5 ? 1 : -1;
  return route.map(([dx, dy]) => [d0 + dx, y0 + dy * side]);
}

function MiniRoute({ route, sketch }: { route: Pt[]; sketch: Sketch }) {
  const placed = placeRoute(route, sketch);
  const toSvg = (pts: Pt[]) => pts.map(([d, fy]) => `${(FIELD_W - fy).toFixed(2)},${(AHEAD - d).toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${FIELD_W} ${DEPTH}`} aria-hidden>
      <line x1="0" x2={FIELD_W} y1={AHEAD} y2={AHEAD} stroke="#2f8cff" strokeWidth="0.5" />
      {[5, 10, 15, 20, 25, 30].map((d) => (
        <line key={d} x1="0" x2={FIELD_W} y1={AHEAD - d} y2={AHEAD - d} stroke="rgba(255,255,255,.18)" strokeWidth="0.2" />
      ))}
      <polyline points={toSvg(sketch)} fill="none" stroke="rgba(255,212,0,.45)" strokeWidth="0.8" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points={toSvg(placed)} fill="none" stroke="#38e1ff" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const RESULT: Record<string, string> = { C: 'Complete', I: 'Incomplete', IN: 'Intercepted', S: 'Sack', R: 'Scramble' };

export function DrawFind() {
  const ready = useData((s) => s.ready);
  const index = useData((s) => s.index);
  const [lib, setLib] = useState<RouteLibrary | null>(null);
  const [libState, setLibState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [sketch, setSketch] = useState<Sketch>([]);
  const [routeType, setRouteType] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [targetedOnly, setTargetedOnly] = useState(false);
  const [completedOnly, setCompletedOnly] = useState(false);
  const [hover, setHover] = useState<RouteMatch | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const open = useOpenPlay();
  const setMode = useStore((s) => s.setMode);
  const setCamera = useStore((s) => s.setCamera);

  useEffect(() => {
    loadRoutes().then((l) => {
      setLib(l);
      setLibState(l ? 'ready' : 'missing');
    });
  }, []);

  const teams = useMemo(() => (lib ? [...new Set(lib.rows.map((r) => r[6]))].sort() : []), [lib]);
  const matches = useMemo(() => {
    if (!lib || sketch.length < 2 || drawing.current) return [];
    const routeSpace = toRouteSpace(sketch.map(([d, fy]) => [d, fy]), BALL_Y);
    return matchRoutes(lib, routeSpace, { routeType: routeType || undefined, team: teamFilter || undefined, targetedOnly, completedOnly }, 24);
  }, [lib, sketch, routeType, teamFilter, targetedOnly, completedOnly]);

  // Keep the canvas sharp and redraw on any change.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const paint = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const preview = hover && lib && sketch.length ? placeRoute(libraryRoute(lib, hover.k), sketch) : null;
      drawBoard(ctx, r.width, r.height, sketch, preview);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
  }, [sketch, hover, lib]);

  const toField = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    const fy = FIELD_W - ((e.clientX - r.left) / r.width) * FIELD_W;
    const d = ((r.bottom - e.clientY) / r.height) * DEPTH - BEHIND;
    return [Math.min(AHEAD, Math.max(-BEHIND, d)), Math.min(FIELD_W, Math.max(0, fy))];
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    setHover(null);
    setSketch([toField(e)]);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const p = toField(e);
    setSketch((s) => {
      const last = s[s.length - 1];
      return last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.35 ? s : [...s, p];
    });
  };
  const onUp = () => {
    drawing.current = false;
    setSketch((s) => [...s]); // re-run matching now that the stroke is done
  };

  const openMatch = async (m: RouteMatch) => {
    if (!lib) return;
    const row = lib.rows[m.k];
    const gameId = lib.games[row[0]];
    setMode('theater');
    const play = await open(gameId, row[1], { selectNflId: row[2], autoplay: true });
    if (play) setCamera('follow');
  };

  if (ready && !index) return <DataMissing />;

  return (
    <div className="page">
      <div className="page__inner">
        <div className="page__head">
          <div>
            <p className="label">Route Finder</p>
            <h1>Search routes by shape</h1>
            <p>
              Draw a route from the receiver’s alignment. Every tracked route ({lib ? lib.count.toLocaleString() : '…'}) is compared with
              your sketch over its first yards; the closest matches open in Replay.
            </p>
          </div>
        </div>

        <div className="draw-layout">
          <div className="card draw-board">
            <canvas
              ref={canvas}
              className="draw-canvas"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              aria-label="Route drawing board. Offense moves up the screen."
              role="img"
            />
            <div className="toolbar">
              <select className="select" value={routeType} onChange={(e) => setRouteType(e.target.value)} aria-label="Route type">
                <option value="">Any route type</option>
                {lib?.routeTypes.filter((r) => r !== 'OTHER').map((r) => (
                  <option key={r} value={r}>
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
              <select className="select" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label="Team">
                <option value="">All teams</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {team(t).name}
                  </option>
                ))}
              </select>
              <label className="check">
                <input type="checkbox" checked={targetedOnly} onChange={(e) => setTargetedOnly(e.target.checked)} /> Targeted
              </label>
              <label className="check">
                <input type="checkbox" checked={completedOnly} onChange={(e) => setCompletedOnly(e.target.checked)} /> Completed
              </label>
              <button className="btn btn--ghost" onClick={() => setSketch([])} disabled={!sketch.length} style={{ marginLeft: 'auto' }}>
                Clear
              </button>
            </div>
          </div>

          <div className="card">
            {libState === 'loading' && <p className="empty">Loading the route library…</p>}
            {libState === 'missing' && <p className="empty">The route library isn’t built yet. Run npm run data.</p>}
            {libState === 'ready' && sketch.length < 2 && (
              <p className="empty">Start a route anywhere on the board. Try a slant from the right slot or a post from the left sideline.</p>
            )}
            {libState === 'ready' && sketch.length >= 2 && matches.length === 0 && !drawing.current && <p className="empty">No routes match those filters.</p>}
            {matches.length > 0 && lib && (
              <div className="matches">
                {matches.map((m) => {
                  const row = lib.rows[m.k];
                  const [name, pos] = lib.players[String(row[2])] ?? ['Unknown', null];
                  return (
                    <button
                      key={m.k}
                      className="match"
                      onClick={() => openMatch(m)}
                      onMouseEnter={() => setHover(m)}
                      onMouseLeave={() => setHover((h) => (h?.k === m.k ? null : h))}
                      onFocus={() => setHover(m)}
                    >
                      <MiniRoute route={libraryRoute(lib, m.k)} sketch={sketch} />
                      <div className="match__title">{name}</div>
                      <div className="match__meta">
                        <span>
                          {row[6]} {pos}
                          {lib.routeTypes[row[3]] !== 'OTHER' && ` · ${lib.routeTypes[row[3]].toLowerCase()}`}
                        </span>
                        <span className="sim">{m.similarity}%</span>
                      </div>
                      <div className="match__meta">
                        <span>{row[4] ? `Targeted · ${RESULT[row[5]] ?? row[5]}` : 'Not targeted'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
