import { Environment, Lightformer } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../lib/store';
import { Ball } from './Ball';
import { CameraRig } from './CameraRig';
import { Field } from './Field';
import { Overlays } from './Overlays';
import { Players } from './Players';
import { Stadium } from './Stadium';

/** Advances the play clock; QB Read freezes it at the decision point. */
function Playback() {
  useFrame((_, dt) => {
    const st = useStore.getState();
    if (!st.playing || !st.play) return;
    let t = st.time + Math.min(dt, 0.1) * st.play.fps * st.speed;
    if (st.mode === 'qb' && st.qb.phase === 'watch' && t >= st.qb.freezeAt) {
      st.setTime(st.qb.freezeAt);
      st.setPlaying(false);
      st.setQb({ phase: 'decide' });
      return;
    }
    if (t >= st.play.n - 1) {
      t = st.play.n - 1;
      st.setPlaying(false);
    }
    st.setTime(t);
  });
  return null;
}

/** Dev only: `sidelineRender(frames)` draws frames by hand, for checking visuals while the
 * tab is in the background (browsers pause animation frames there). */
function DevRender() {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { sidelineRender?: (frames?: number) => void };
    let clock = performance.now();
    w.sidelineRender = (frames = 1) => {
      for (let i = 0; i < frames; i++) advance((clock += 1000 / 60));
    };
    return () => {
      delete w.sidelineRender;
    };
  }, [advance]);
  return null;
}

function Sky() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {},
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'varying vec3 vP; void main(){ float h = clamp(vP.y, 0.0, 1.0); vec3 top = vec3(0.008,0.013,0.03); vec3 hor = vec3(0.07,0.09,0.15); gl_FragColor = vec4(mix(hor, top, pow(h, 0.55)), 1.0); }',
      }),
    [],
  );
  return (
    <mesh material={mat} renderOrder={-1}>
      <sphereGeometry args={[900, 32, 16]} />
    </mesh>
  );
}

function Lights() {
  return (
    <>
      <hemisphereLight args={['#c7d6ff', '#22301c', 0.3]} />
      <directionalLight
        position={[-30, 110, 55]}
        intensity={3.4}
        color="#fff6e8"
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
        shadow-camera-left={-80}
        shadow-camera-right={80}
        shadow-camera-top={48}
        shadow-camera-bottom={-48}
        shadow-camera-near={20}
        shadow-camera-far={320}
      />
      <directionalLight position={[40, 90, -60]} intensity={0.7} color="#e8f0ff" />
      {/* Reflections: a ring of light banks above the bowl */}
      <Environment resolution={256} frames={1} environmentIntensity={0.45}>
        <color attach="background" args={['#05070c']} />
        {[-60, -20, 20, 60].map((x) => (
          <Lightformer key={`n${x}`} form="rect" intensity={5} color="#fff8ee" position={[x, 55, 60]} rotation-x={Math.PI / 3} scale={[30, 4, 1]} />
        ))}
        {[-60, -20, 20, 60].map((x) => (
          <Lightformer key={`s${x}`} form="rect" intensity={5} color="#fff8ee" position={[x, 55, -60]} rotation-x={-Math.PI / 3} scale={[30, 4, 1]} />
        ))}
        <Lightformer form="rect" intensity={0.6} color="#3b5bff" position={[0, -20, 0]} rotation-x={-Math.PI / 2} scale={[200, 200, 1]} />
      </Environment>
    </>
  );
}

export function Stage({ paused = false }: { paused?: boolean }) {
  const play = useStore((s) => s.play);
  const home = play?.home ?? null;
  const away = play?.away ?? null;
  const select = useStore((s) => s.select);

  return (
    <Canvas
      frameloop={paused ? 'never' : 'always'}
      shadows
      dpr={[1, 1.75]}
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 34, near: 0.3, far: 2000, position: [-20, 40, 80] }}
      onPointerMissed={() => select(null)}
    >
      <fog attach="fog" args={['#05080f', 220, 600]} />
      <Sky />
      <Lights />
      <Suspense fallback={null}>
        <Field home={home} />
        <Stadium home={home} away={away} />
        {play && (
          <>
            <Players play={play} />
            {!play.noBall && <Ball play={play} />}
            <Overlays play={play} />
          </>
        )}
      </Suspense>
      <Playback />
      <DevRender />
      <CameraRig />
      <EffectComposer multisampling={0} enableNormalPass={false}>
        <N8AO halfRes aoRadius={1.6} intensity={2.2} distanceFalloff={0.6} />
        <Bloom mipmapBlur luminanceThreshold={1.0} luminanceSmoothing={0.2} intensity={0.85} />
        <Vignette offset={0.28} darkness={0.55} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}
