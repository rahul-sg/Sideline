import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { ballHeight, carrierAt, sample, sceneX, sceneZ } from '../lib/playMath';
import { useStore } from '../lib/store';
import type { Play } from '../lib/types';
import { hands, setBallWorld } from './rig';

const SIZE = 1.25; // slightly larger than life so it reads at broadcast distance
const X_AXIS = new THREE.Vector3(1, 0, 0);
const v = new THREE.Vector3();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const q = new THREE.Quaternion();
const spin = new THREE.Quaternion();

export function ballPosition(play: Play, t: number, out: THREE.Vector3) {
  return out.set(sceneX(sample(play.bx, t)), ballHeight(play, t), sceneZ(sample(play.by, t)));
}

const hand = new THREE.Vector3();
const fore = new THREE.Vector3();
const prevPos = new THREE.Vector3();

/**
 * The ball sits in the carrier's right hand, along the forearm (a tuck). It only
 * travels on its own during the snap, a pass in flight, or when it's loose.
 */
export function Ball({ play }: { play: Play }) {
  const ref = useRef<THREE.Group>(null);
  const last = useRef({ holder: -2, blend: 1, time: 0 });
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const t = useStore.getState().time;
    const holder = carrierAt(play, t);
    const bones = holder >= 0 ? hands.get(`${play.id}:${holder}`) : undefined;
    const L = last.current;
    if (holder !== L.holder) {
      prevPos.copy(g.position);
      L.blend = Math.abs(t - L.time) < 3 ? 0 : 1; // ease hand-offs, snap on seeks
      L.holder = holder;
    }
    L.blend = Math.min(1, L.blend + Math.abs(t - L.time) / 3);
    L.time = t;

    if (bones) {
      bones.hand.getWorldPosition(hand);
      bones.fore.getWorldPosition(fore);
      v.subVectors(hand, fore).normalize();
      g.position.copy(hand).addScaledVector(v, 0.06);
      q.setFromUnitVectors(X_AXIS, v);
    } else {
      ballPosition(play, t, g.position);
      ballPosition(play, t - 0.6, a);
      ballPosition(play, t + 0.6, b);
      v.subVectors(b, a);
      const inFlight = play.throw != null && play.arrive != null && t >= play.throw && t <= play.arrive;
      if (!inFlight) v.set(1, 0.05, 0);
      if (v.lengthSq() < 1e-4) v.set(1, 0.3, 0);
      q.setFromUnitVectors(X_AXIS, v.normalize());
      if (inFlight) {
        spin.setFromAxisAngle(X_AXIS, t * 3.2);
        q.multiply(spin);
      }
    }
    if (L.blend < 1) g.position.lerpVectors(prevPos, g.position, L.blend);
    g.quaternion.copy(q);
    setBallWorld(g.position);
  });
  return (
    <group ref={ref}>
      <mesh scale={[0.153 * SIZE, 0.095 * SIZE, 0.095 * SIZE]} castShadow>
        <sphereGeometry args={[1, 32, 20]} />
        <meshStandardMaterial color="#6e3417" roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.095 * SIZE, 0]} scale={SIZE}>
        <boxGeometry args={[0.1, 0.006, 0.014]} />
        <meshStandardMaterial color="#f2efe6" roughness={0.6} />
      </mesh>
    </group>
  );
}
