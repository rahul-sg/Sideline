import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { easing } from 'maath';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { qbIndex, sample, sceneX, sceneZ } from '../lib/playMath';
import { useStore, type CameraMode } from '../lib/store';
import type { Play } from '../lib/types';
import { bowlOffset, standsHeight } from './Stadium';

interface Shot {
  offset: [number, number, number];
  look: [number, number, number];
  fov: number;
}

// Camera offsets from the subject (scene units = yards). Near sideline is +Z.
const SHOTS: Record<CameraMode, Shot> = {
  broadcast: { offset: [-2, 30, 74], look: [5, 0, -2], fov: 22 },
  all22: { offset: [0, 62, 70], look: [0, 0, -2], fov: 30 },
  endzone: { offset: [-34, 21, 0], look: [16, 0, 0], fov: 34 },
  qb: { offset: [-1.6, 3.1, 0], look: [22, 0.6, 0], fov: 62 },
  follow: { offset: [-7, 5, 9], look: [2, 1, 0], fov: 42 },
  free: { offset: [-18, 26, 40], look: [4, 0, 0], fov: 34 },
  showcase: { offset: [-30, 17, 48], look: [6, 0, 0], fov: 28 },
};

/** Home page camera: sweeps slowly between the sideline and a three-quarter view from behind the offense. */
function showcasePosition(subject: THREE.Vector3, clock: number, pos: THREE.Vector3, look: THREE.Vector3) {
  const a = 0.62 + 0.26 * Math.sin(clock * 0.06); // angle from the near sideline toward the offense's backfield
  const r = 58;
  pos.set(subject.x - r * Math.sin(a), 16 + 3 * Math.sin(clock * 0.045), subject.z + r * Math.cos(a));
  look.set(subject.x + 6, 0, subject.z);
}
const showPos = new THREE.Vector3();
const showLook = new THREE.Vector3();
/** Wide screens frame the home page's action right of centre, leaving room for the headline. */
const SHOWCASE_SHIFT = 1.3; // full-frustum width ÷ visible width

const raw = new THREE.Vector3();

function subjectPoint(mode: CameraMode, play: Play | null, t: number, selected: number | null, out: THREE.Vector3) {
  if (!play) return out.set(0, 0, 0);
  const ballX = sceneX(sample(play.bx, t));
  const ballZ = sceneZ(sample(play.by, t));
  switch (mode) {
    case 'all22':
      return out.set(sceneX(play.los + 8) * 0.5 + ballX * 0.5, 0, 0);
    case 'endzone':
      return out.set(sceneX(play.los), 0, sceneZ(play.ballY));
    case 'qb': {
      const i = qbIndex(play);
      const f = Math.min(t, play.throw ?? t); // stay in the pocket view through the throw
      return out.set(sceneX(sample(play.x[i], f)), 0, sceneZ(sample(play.y[i], f)));
    }
    case 'follow': {
      if (selected == null) return out.set(ballX, 0, ballZ);
      return out.set(sceneX(sample(play.x[selected], t)), 0, sceneZ(sample(play.y[selected], t)));
    }
    case 'showcase':
      return out.set(sceneX(play.los + 6) * 0.4 + ballX * 0.6, 0, ballZ * 0.3);
    case 'broadcast':
    case 'free':
    default:
      return out.set(ballX, 0, ballZ * 0.35);
  }
}

const toTarget = new THREE.Vector3();

/**
 * Keep the camera in the open air of the stadium: never inside the stands or
 * behind them. Low orbits ride up over the seats instead of clipping through.
 */
function keepInsideBowl(pos: THREE.Vector3, target: THREE.Vector3) {
  // Stay over the field and lower bowl: pull back in from the upper deck and roof.
  for (let k = 0; k < 12 && bowlOffset(pos.x, pos.z) > 42; k++) {
    toTarget.subVectors(target, pos).setY(0).multiplyScalar(0.12);
    pos.add(toTarget);
  }
  const floor = Math.max(0.6, standsHeight(bowlOffset(pos.x, pos.z)) + 4);
  if (pos.y < floor) pos.y = floor;
  if (pos.y > 90) pos.y = 90;
}

export function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const subject = useRef(new THREE.Vector3());
  const transitioning = useRef(true);
  const nonce = useStore((s) => s.cameraNonce);
  const mode = useStore((s) => s.camera);

  const playId = useStore((s) => s.play?.id);
  const lastPlay = useRef<string | undefined>(undefined);

  useEffect(() => {
    const st = useStore.getState();
    subjectPoint(st.camera, st.play, st.time, st.selected, subject.current);
    const c = controls.current;
    if (playId !== lastPlay.current && c) {
      // A new play cuts straight to its shot, like a broadcast; switching cameras glides.
      lastPlay.current = playId;
      const shot = SHOTS[st.camera];
      const s0 = subject.current;
      camera.position.set(s0.x + shot.offset[0], shot.offset[1], s0.z + shot.offset[2]);
      c.target.set(s0.x + shot.look[0], shot.look[1], s0.z + shot.look[2]);
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
      c.update();
      transitioning.current = false;
      return;
    }
    transitioning.current = true;
  }, [nonce, playId, camera]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const stop = () => {
      transitioning.current = false;
    };
    c.addEventListener('start', stop);
    return () => c.removeEventListener('start', stop);
  }, []);

  useFrame((state, dt) => {
    const c = controls.current;
    if (!c) return;
    const st = useStore.getState();
    const shot = SHOTS[st.camera];
    subjectPoint(st.camera, st.play, st.time, st.selected, raw);

    const { width: w, height: h } = state.size;
    const shifted = st.camera === 'showcase' && w >= 900;
    if (shifted) {
      camera.aspect = (w * SHOWCASE_SHIFT) / h;
      camera.setViewOffset(w * SHOWCASE_SHIFT, h, 0, 0, w, h);
    } else if (camera.view?.enabled) {
      camera.clearViewOffset();
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (st.camera === 'showcase') {
      easing.damp3(subject.current, raw, 0.6, dt);
      showcasePosition(subject.current, state.clock.elapsedTime, showPos, showLook);
      easing.damp3(camera.position, showPos, 0.5, dt);
      easing.damp3(c.target, showLook, 0.5, dt);
      keepInsideBowl(camera.position, c.target);
      if (Math.abs(camera.fov - shot.fov) > 0.01) easing.damp(camera, 'fov', shot.fov, 0.4, dt);
      camera.updateProjectionMatrix();
      c.update();
      return;
    }
    if (st.camera !== 'free') {
      // Carry the camera along with the subject so user orbit angles persist.
      const prev = subject.current.clone();
      easing.damp3(subject.current, raw, st.camera === 'qb' ? 0.08 : 0.25, dt);
      const delta = subject.current.clone().sub(prev);
      camera.position.add(delta);
      c.target.add(delta);
    }
    if (transitioning.current) {
      const s = subject.current;
      const pos = new THREE.Vector3(s.x + shot.offset[0], shot.offset[1], s.z + shot.offset[2]);
      const look = new THREE.Vector3(s.x + shot.look[0], shot.look[1], s.z + shot.look[2]);
      easing.damp3(camera.position, pos, 0.45, dt);
      easing.damp3(c.target, look, 0.45, dt);
      if (camera.position.distanceTo(pos) < 0.05 && c.target.distanceTo(look) < 0.05) transitioning.current = false;
    }
    keepInsideBowl(camera.position, c.target);
    if (Math.abs(camera.fov - shot.fov) > 0.01) {
      easing.damp(camera, 'fov', shot.fov, 0.4, dt);
      camera.updateProjectionMatrix();
    }
    c.update();
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      maxPolarAngle={Math.PI / 2 - 0.02}
      minDistance={mode === 'qb' ? 0.5 : 3}
      maxDistance={170}
      zoomSpeed={0.8}
    />
  );
}
