import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Line2 } from 'three-stdlib';
import { FIELD_W, sample, sceneX, sceneZ } from '../lib/playMath';
import { useStore } from '../lib/store';
import type { Play } from '../lib/types';
import { ballPosition } from './Ball';

export const ROUTE_COLORS = ['#ffd400', '#38e1ff', '#ff5cc8', '#8dff5a', '#ff9b3d', '#b48cff'];

/** Route runners get stable colors in roster order. */
export function routeColor(play: Play, index: number): string {
  const runners = play.players.map((p, i) => (p.off && p.runner ? i : -1)).filter((i) => i >= 0);
  const k = runners.indexOf(index);
  return k >= 0 ? ROUTE_COLORS[k % ROUTE_COLORS.length] : '#ffffff';
}

function YardLine({ x, color, width = 0.2 }: { x: number; color: string; width?: number }) {
  return (
    <mesh rotation-x={-Math.PI / 2} position={[sceneX(x), 0.012, 0]} renderOrder={1}>
      <planeGeometry args={[width, FIELD_W]} />
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.92} depthWrite={false} polygonOffset polygonOffsetFactor={-3} />
    </mesh>
  );
}

/**
 * A flat ribbon along a player's path, revealed up to the play clock. The head
 * vertex pair is moved to the interpolated position so the trail is smooth
 * between 10 Hz tracking frames.
 */
function Trail({ play, index, color, from }: { play: Play; index: number; color: string; from: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const { geometry, base } = useMemo(() => {
    const pts: THREE.Vector2[] = [];
    for (let f = from; f < play.n; f++) pts.push(new THREE.Vector2(sceneX(play.x[index][f]), sceneZ(play.y[index][f])));
    const pos = new Float32Array(pts.length * 2 * 3);
    const w = 0.13;
    pts.forEach((p, i) => {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.y - prev.y;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      pos.set([p.x - tz * w, 0.05, p.y + tx * w, p.x + tz * w, 0.05, p.y - tx * w], i * 6);
    });
    const idx: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    return { geometry: g, base: pos.slice() };
  }, [play, index, from]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const edited = useRef(-1);

  useFrame(() => {
    const t = useStore.getState().time - from;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const segs = (base.length / 6) - 1;
    if (t <= 0 || segs <= 0) {
      geometry.setDrawRange(0, 0);
      return;
    }
    const k = Math.min(segs - 1, Math.floor(t));
    const f = Math.min(1, t - k);
    if (edited.current >= 0) arr.set(base.subarray(edited.current * 6, edited.current * 6 + 6), edited.current * 6);
    const head = k + 1;
    for (let j = 0; j < 6; j++) arr[head * 6 + j] = base[k * 6 + j] + (base[head * 6 + j] - base[k * 6 + j]) * f;
    edited.current = head;
    attr.needsUpdate = true;
    geometry.setDrawRange(0, (k + 1) * 6);
  });

  return (
    <mesh ref={mesh} geometry={geometry} renderOrder={3}>
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.9} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Dashed flight path of the pass, drawn as the ball travels. */
function PassArc({ play }: { play: Play }) {
  const ref = useRef<Line2>(null);
  const points = useMemo(() => {
    if (play.throw == null || play.arrive == null) return null;
    const out: THREE.Vector3[] = [];
    const v = new THREE.Vector3();
    for (let t = play.throw; t <= play.arrive + 1e-6; t += 0.25) out.push(ballPosition(play, t, v).clone());
    return out;
  }, [play]);
  const landing = useMemo(() => {
    if (play.arrive == null) return null;
    return new THREE.Vector3(sceneX(sample(play.bx, play.arrive)), 0.04, sceneZ(sample(play.by, play.arrive)));
  }, [play]);
  const marker = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!points || play.throw == null || play.arrive == null) return;
    const t = useStore.getState().time;
    const line = ref.current;
    const segs = points.length - 1;
    const k = t < play.throw ? 0 : Math.min(segs, Math.ceil(((t - play.throw) / 0.25)));
    if (line) {
      (line.geometry as THREE.InstancedBufferGeometry).instanceCount = k;
      line.visible = k > 0;
    }
    if (marker.current) {
      marker.current.visible = t >= play.throw;
      const s = 1 + 0.12 * Math.sin(performance.now() / 200);
      marker.current.scale.setScalar(s);
    }
  });

  if (!points || !landing) return null;
  return (
    <group>
      <Line ref={ref} points={points} color="#ffffff" lineWidth={2.2} dashed dashSize={0.6} gapSize={0.35} transparent opacity={0.85} toneMapped={false} />
      <mesh ref={marker} position={landing} rotation-x={-Math.PI / 2} renderOrder={3}>
        <ringGeometry args={[0.7, 0.95, 40]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} transparent opacity={0.8} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function Overlays({ play }: { play: Play }) {
  const showRoutes = useStore((s) => s.showRoutes);
  const selected = useStore((s) => s.selected);
  const mode = useStore((s) => s.mode);
  const qbPhase = useStore((s) => s.qb.phase);

  const trails = useMemo(() => {
    const set = new Map<number, string>();
    if (showRoutes) play.players.forEach((p, i) => p.off && p.runner && set.set(i, routeColor(play, i)));
    if (selected != null && !set.has(selected)) set.set(selected, '#ffffff');
    return [...set.entries()];
  }, [play, showRoutes, selected]);

  const goalToGo = play.firstDown >= 110;
  const hidePass = mode === 'qb' && qbPhase !== 'reveal';
  return (
    <group>
      <YardLine x={play.los} color="#2f8cff" />
      {!goalToGo && <YardLine x={play.firstDown} color="#ffd400" />}
      {trails.map(([i, color]) => (
        <Trail key={`${play.id}-${i}`} play={play} index={i} color={color} from={play.snap} />
      ))}
      {!hidePass && <PassArc play={play} />}
    </group>
  );
}
