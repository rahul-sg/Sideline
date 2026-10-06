import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { team } from '../lib/teams';
import { crowdTexture, ribbonTexture } from './textures';

// Inner edge of the seating bowl: a rounded rectangle around the field and apron.
const HALF_L = 74;
const HALF_W = 44;
const CORNER = 20;
const SEGMENTS = 280;

/** Signed distance from the bowl's inner edge (negative = over the field or apron). */
export function bowlOffset(x: number, z: number): number {
  const qx = Math.abs(x) - (HALF_L - CORNER);
  const qz = Math.abs(z) - (HALF_W - CORNER);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - CORNER;
}

/** Height of the stands (seats, club level, upper deck, roof) at a given bowl offset. */
export function standsHeight(d: number): number {
  if (d <= 0) return 0;
  if (d <= 34) return 2.6 + ((d - 0.5) / 33.5) * 18.4;
  if (d <= 38) return 27;
  if (d <= 74) return 27.5 + ((d - 38) / 36) * 30.5;
  return 70;
}

/** Points and outward normals around the rounded-rectangle bowl edge. */
function ringPath() {
  const sx = HALF_L - CORNER;
  const sz = HALF_W - CORNER;
  const straightL = sx * 2;
  const straightW = sz * 2;
  const arc = (Math.PI / 2) * CORNER;
  const perim = 2 * straightL + 2 * straightW + 4 * arc;
  const pts: { p: THREE.Vector2; n: THREE.Vector2; s: number }[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    let d = (i / SEGMENTS) * perim;
    const segs: [number, (u: number) => [number, number, number, number]][] = [
      [straightL, (u) => [-sx + u, sz + CORNER, 0, 1]],
      [arc, (u) => { const a = Math.PI / 2 - u / CORNER; return [sx + Math.cos(a) * CORNER, sz + Math.sin(a) * CORNER, Math.cos(a), Math.sin(a)]; }],
      [straightW, (u) => [sx + CORNER, sz - u, 1, 0]],
      [arc, (u) => { const a = -u / CORNER; return [sx + Math.cos(a) * CORNER, -sz + Math.sin(a) * CORNER, Math.cos(a), Math.sin(a)]; }],
      [straightL, (u) => [sx - u, -sz - CORNER, 0, -1]],
      [arc, (u) => { const a = -Math.PI / 2 - u / CORNER; return [-sx + Math.cos(a) * CORNER, -sz + Math.sin(a) * CORNER, Math.cos(a), Math.sin(a)]; }],
      [straightW, (u) => [-sx - CORNER, -sz + u, -1, 0]],
      [arc, (u) => { const a = Math.PI - u / CORNER; return [-sx + Math.cos(a) * CORNER, sz + Math.sin(a) * CORNER, Math.cos(a), Math.sin(a)]; }],
    ];
    for (const [len, f] of segs) {
      if (d <= len + 1e-6) {
        const [x, z, nx, nz] = f(Math.min(d, len));
        pts.push({ p: new THREE.Vector2(x, z), n: new THREE.Vector2(nx, nz), s: (i / SEGMENTS) * perim });
        break;
      }
      d -= len;
    }
  }
  return { pts, perim };
}

/** A band swept around the bowl from (offset d0, height h0) to (d1, h1). */
function band(d0: number, h0: number, d1: number, h1: number, uPerYard: number, vRepeat = 1) {
  const { pts } = ringPath();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  pts.forEach(({ p, n, s }, i) => {
    pos.push(p.x + n.x * d0, h0, p.y + n.y * d0, p.x + n.x * d1, h1, p.y + n.y * d1);
    uv.push(-s * uPerYard, 0, -s * uPerYard, vRepeat); // negative u reads correctly from inside the bowl
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function Stadium({ home, away }: { home: string | null; away: string | null }) {
  const h = team(home);
  const a = team(away);

  const crowd = useMemo(() => {
    const t = crowdTexture([h.primary, h.secondary, h.primary], [a.primary, a.secondary]);
    return t;
  }, [h.primary, h.secondary, a.primary, a.secondary]);
  const ribbon = useMemo(() => ribbonTexture(home ? `${h.name.toUpperCase()}` : 'SIDELINE', '#ffffff', home ? h.primary : '#10151f'), [home, h.name, h.primary]);
  useEffect(() => () => { crowd.dispose(); ribbon.dispose(); }, [crowd, ribbon]);

  const geo = useMemo(() => {
    const SEAT = 1 / 70; // crowd texture spans ~70 yards of seats
    return {
      wall: band(0, 0, 0, 2.2, 0.05),
      lower: band(0.5, 2.6, 34, 21, SEAT, 0.75),
      ribbon: band(34.2, 21.4, 34.2, 23.6, 1 / 120),
      fascia: band(34.2, 23.6, 34.6, 27, 0.05),
      club: band(34.6, 27, 38, 27, 0.05),
      upper: band(38, 27.5, 74, 58, SEAT, 0.85),
      rim: band(74, 58, 76, 66, 0.05),
      roof: band(76, 66, 70, 68, 0.05),
    };
  }, []);

  const ribbonRef = useRef<THREE.Texture>(ribbon);
  ribbonRef.current = ribbon;
  useFrame((_, dt) => {
    ribbonRef.current.offset.x = (ribbonRef.current.offset.x - dt * 0.02) % 1;
  });

  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0d1118', roughness: 0.85, metalness: 0.1, side: THREE.DoubleSide }), []);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ color: home ? h.primary : '#1a2030', roughness: 0.6, side: THREE.DoubleSide }), [home, h.primary]);
  const seatMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        map: crowd,
        emissiveMap: crowd,
        emissive: new THREE.Color('#ffffff'),
        emissiveIntensity: 0.08,
        color: new THREE.Color('#9a9a9a'),
        roughness: 1,
        side: THREE.DoubleSide,
      }),
    [crowd],
  );

  return (
    <group>
      <mesh geometry={geo.wall} material={wallMat} receiveShadow />
      <mesh geometry={geo.lower} material={seatMat} receiveShadow />
      <mesh geometry={geo.ribbon}>
        <meshBasicMaterial map={ribbon} toneMapped={false} side={THREE.DoubleSide} color="#d8d8d8" />
      </mesh>
      <mesh geometry={geo.fascia} material={dark} />
      <mesh geometry={geo.club} material={dark} />
      <mesh geometry={geo.upper} material={seatMat} />
      <mesh geometry={geo.rim} material={dark} />
      <mesh geometry={geo.roof} material={dark} />
      <LightBanks />
      <VideoBoards color={home ? h.primary : '#1d4ed8'} />
    </group>
  );
}

/** Emissive light banks on the roof edge; bloom turns them into stadium lights. */
function LightBanks() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const { pts } = useMemo(ringPath, []);
  const placements = useMemo(() => {
    const out: THREE.Matrix4[] = [];
    const step = 9;
    for (let i = 0; i < pts.length; i += step) {
      const { p, n } = pts[i];
      const pos = new THREE.Vector3(p.x + n.x * 66, 69, p.y + n.y * 66);
      const m = new THREE.Matrix4();
      const look = new THREE.Object3D();
      look.position.copy(pos);
      look.lookAt(0, 0, 0);
      look.updateMatrix();
      m.copy(look.matrix);
      out.push(m);
    }
    return out;
  }, [pts]);
  useEffect(() => {
    placements.forEach((m, i) => ref.current?.setMatrixAt(i, m));
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  }, [placements]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, placements.length]}>
      <planeGeometry args={[9, 2.6]} />
      <meshBasicMaterial color={new THREE.Color(5, 5, 4.6)} toneMapped={false} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

function VideoBoards({ color }: { color: string }) {
  return (
    <group>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 112, 52, 0]} rotation-y={side * -Math.PI / 2}>
          <mesh>
            <boxGeometry args={[46, 16, 1.2]} />
            <meshStandardMaterial color="#05070b" roughness={0.6} />
          </mesh>
          <mesh position-z={0.65}>
            <planeGeometry args={[44, 14]} />
            <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.55} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
