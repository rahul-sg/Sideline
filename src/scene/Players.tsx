import { Billboard, Html, Text, useGLTF } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { angleDiff, clamp, motionDir, qbIndex, sample, sampleAngle, sceneX, sceneZ, separation, yawFromO } from '../lib/playMath';
import { useStore } from '../lib/store';
import { uniformColors, type Uniform } from '../lib/teams';
import type { Play } from '../lib/types';
import { clipSpeed, hands, loadClips, makeRig, pose, restoreAnimPose, saveAnimPose, type Clips } from './rig';
import { lastName } from '../ui/PlayInspector';
import { numberTexture } from './textures';

const MODEL = '/models/Xbot.glb';
const MODEL_HEIGHT = 1.806; // model units, feet to top of head
const FONT = '/fonts/BarlowCondensed-700.woff';
useGLTF.preload(MODEL);

/** Strip root drift so clips play in place; tracking data drives position. */
function inPlace(clip: THREE.AnimationClip) {
  const c = clip.clone();
  for (const tr of c.tracks) {
    if (tr.name.endsWith('Hips.position')) {
      const v = tr.values;
      for (let i = 0; i < v.length; i += 3) {
        v[i] = v[0];
        v[i + 2] = v[2];
      }
    }
  }
  return c;
}

/**
 * Uniform material: paints jersey, pants, socks, sleeves and cleats onto the
 * mannequin by region of its bind pose, so one mesh reads as a football uniform.
 */
function uniformMaterial(u: Uniform, pants: string) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.0 });
  const uniforms = {
    uJersey: { value: new THREE.Color(u.jersey) },
    uTrim: { value: new THREE.Color(u.trim) },
    uPants: { value: new THREE.Color(pants) },
    uGlove: { value: new THREE.Color('#15171c') },
    uShoe: { value: new THREE.Color('#0d0e11') },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBind;
        uniform vec3 uJersey; uniform vec3 uTrim; uniform vec3 uPants; uniform vec3 uGlove; uniform vec3 uShoe;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Bind pose is a T-pose in meters: y up, arms along x.
        float y = vBind.y; float ax = abs(vBind.x);
        vec3 c = uJersey;
        if (ax > 0.33 && y > 1.2) {
          c = ax > 0.68 ? uGlove : (ax > 0.42 ? uJersey * 0.35 : uJersey); // sleeve, undersleeve, glove
          if (ax > 0.40 && ax < 0.44) c = uTrim;
        } else if (y < 0.09) {
          c = uShoe;
        } else if (y < 0.52) {
          c = mix(uTrim, uJersey, step(0.30, y) * step(y, 0.36)); // socks with a stripe
        } else if (y < 0.99) {
          c = uPants;
          if (ax > 0.08 && ax < 0.115 && y > 0.6) c = uTrim; // pant stripe
        } else if (y > 1.52) {
          c = uGlove; // head, under the helmet
        } else if (y > 0.99 && y < 1.03) {
          c = uTrim; // belt line
        }
        diffuseColor.rgb = c;`,
      );
  };
  m.customProgramCacheKey = () => 'uniform-v1';
  return m;
}

function equipment(u: Uniform, stripeColor: string) {
  const shell = new THREE.MeshPhysicalMaterial({ color: u.helmet, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.06, metalness: 0.2 });
  const mask = new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.35, metalness: 0.7 });
  const stripe = new THREE.MeshStandardMaterial({ color: stripeColor, roughness: 0.4 });
  const jersey = new THREE.MeshStandardMaterial({ color: u.jersey, roughness: 0.6 });
  return { shell, mask, stripe, jersey };
}

const KIT_KEYS = ['body', 'shell', 'mask', 'stripe', 'jersey'] as const;
type Kit = { body: THREE.Material; shell: THREE.Material; mask: THREE.Material; stripe: THREE.Material; jersey: THREE.Material };

interface AthleteProps {
  play: Play;
  index: number;
  uniform: Uniform;
  materials: Kit & { ghost: Kit };
  /** Ground speed of the walk and run clips (model units/s), for stride matching. */
  gait: { walk: number; run: number };
  clips: Clips;
}

/** Faded copy of a kit for players whose movement after the throw is modelled, not tracked. */
function ghostKit(kit: Kit): Kit {
  const fade = <M extends THREE.Material>(m: M) => {
    m.transparent = true;
    m.opacity = 0.28;
    m.depthWrite = false;
    return m;
  };
  // The uniform shader is added in onBeforeCompile, which clone() doesn't carry over.
  const body = new THREE.MeshStandardMaterial({ roughness: 0.62 });
  body.onBeforeCompile = kit.body.onBeforeCompile;
  body.customProgramCacheKey = () => 'uniform-v1-ghost';
  return { body: fade(body), shell: fade(kit.shell.clone()), mask: fade(kit.mask.clone()), stripe: fade(kit.stripe.clone()), jersey: fade(kit.jersey.clone()) };
}

const pads = new RoundedBoxGeometry(0.5, 0.08, 0.36, 3, 0.04);
const capGeo = new THREE.SphereGeometry(0.12, 20, 14);
const shellGeo = new THREE.SphereGeometry(0.15, 28, 20);
// Center stripe: two thin meridian slices of a slightly larger sphere, front and back.
const stripeFront = new THREE.SphereGeometry(0.152, 4, 16, Math.PI / 2 - 0.1, 0.2, 0, 1.45);
const stripeBack = new THREE.SphereGeometry(0.152, 4, 16, (3 * Math.PI) / 2 - 0.1, 0.2, 0, 1.9);
const barGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6);
const ringGeo = new THREE.RingGeometry(0.64, 0.74, 48);
const discGeo = new THREE.CircleGeometry(0.62, 48);
const hitGeo = new THREE.CylinderGeometry(0.7, 0.7, 2.2, 10);
const numGeo = new THREE.PlaneGeometry(0.3, 0.3);

function Athlete({ play, index, uniform, materials, gait, clips }: AthleteProps) {
  const meta = play.players[index];
  const gltf = useGLTF(MODEL);
  const root = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null);
  const lastTime = useRef<number | null>(null);
  const ghosted = useRef(false);

  const { model, mixer, actions } = useMemo(() => {
    const model = cloneSkinned(gltf.scene) as THREE.Group;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.material = materials.body;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.raycast = () => undefined;
      }
    });
    const mixer = new THREE.AnimationMixer(model);
    const clip = (n: string) => inPlace(gltf.animations.find((a) => a.name === n)!);
    const actions: Record<string, THREE.AnimationAction> = {
      idle: mixer.clipAction(clip('idle')),
      walk: mixer.clipAction(clip('walk')),
      run: mixer.clipAction(clip('run')),
    };
    // Motion-captured sprint and backpedal, when the baked clips are present.
    if (clips.sprint) actions.sprint = mixer.clipAction(clips.sprint.clip);
    if (clips.backpedal) actions.backpedal = mixer.clipAction(clips.backpedal.clip);
    Object.values(actions).forEach((a) => {
      a.play();
      a.setEffectiveWeight(0);
    });
    // Desynchronize strides so the field doesn't move in lockstep.
    mixer.update((index * 0.137) % 0.7);
    return { model, mixer, actions };
  }, [gltf, materials.body, index, clips]);
  const rig = useMemo(() => makeRig(model), [model]);
  useEffect(() => {
    const key = `${play.id}:${index}`;
    if (rig.b.RightHand && rig.b.RightForeArm) hands.set(key, { hand: rig.b.RightHand, fore: rig.b.RightForeArm });
    return () => {
      hands.delete(key);
    };
  }, [rig, play.id, index]);

  // Equipment rides on bones. Bones live under a 0.01-scaled armature, so
  // attachments are scaled 100x to author them in model meters.
  const numberTex = useMemo(() => numberTexture(meta.num, uniform.number, uniform.trim), [meta.num, uniform.number, uniform.trim]);
  useEffect(() => () => numberTex.dispose(), [numberTex]);
  useEffect(() => {
    const head = model.getObjectByName('mixamorigHead');
    const chest = model.getObjectByName('mixamorigSpine2');
    const added: THREE.Object3D[] = [];
    if (head) {
      const g = new THREE.Group();
      g.position.set(0, 10.5, 1.5);
      g.scale.setScalar(100);
      const shell = new THREE.Mesh(shellGeo, materials.shell);
      shell.scale.set(0.95, 1.0, 1.12);
      shell.castShadow = true;
      const stripe = new THREE.Group();
      stripe.add(new THREE.Mesh(stripeFront, materials.stripe), new THREE.Mesh(stripeBack, materials.stripe));
      stripe.scale.copy(shell.scale);
      g.add(shell, stripe);
      for (let k = 0; k < 3; k++) {
        const bar = new THREE.Mesh(barGeo, materials.mask);
        bar.rotation.z = Math.PI / 2;
        bar.position.set(0, -0.02 - k * 0.045, 0.165 - k * 0.006);
        g.add(bar);
      }
      const vbar = new THREE.Mesh(barGeo, materials.mask);
      vbar.scale.set(1, 0.55, 1);
      vbar.position.set(0, -0.065, 0.168);
      g.add(vbar);
      head.add(g);
      added.push(g);
    }
    if (chest) {
      const g = new THREE.Group();
      g.position.set(0, 10.5, -1);
      g.scale.setScalar(100);
      const plate = new THREE.Mesh(pads, materials.jersey);
      plate.castShadow = true;
      g.add(plate);
      for (const side of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, materials.jersey);
        cap.position.set(side * 0.23, -0.01, 0);
        cap.scale.set(1, 0.62, 1.25);
        cap.castShadow = true;
        g.add(cap);
      }
      const numMat = new THREE.MeshStandardMaterial({ map: numberTex, transparent: true, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4 });
      const front = new THREE.Mesh(numGeo, numMat);
      front.position.set(0, -0.2, 0.185);
      const back = new THREE.Mesh(numGeo, numMat);
      back.position.set(0, -0.17, -0.2);
      back.rotation.y = Math.PI;
      g.add(front, back);
      chest.add(g);
      added.push(g);
    }
    return () =>
      added.forEach((o) => {
        o.parent?.remove(o);
        o.traverse((c) => {
          const m = (c as THREE.Mesh).material as THREE.Material | undefined;
          if (m && ![...Object.values(materials), ...Object.values(materials.ghost)].includes(m)) m.dispose();
        });
      });
  }, [model, materials, numberTex]);

  const heightYd = (meta.h ?? 73) / 36;
  const scale = heightYd / MODEL_HEIGHT;
  // The mannequin is slim; pads and build make football players read much wider.
  const girth = clamp(1.3 * Math.sqrt((meta.w ?? 215) / 215), 1.15, 1.7);

  useFrame(() => {
    const st = useStore.getState();
    const t = st.time;
    const g = root.current;
    if (!g) return;
    // First-person QB camera: hide the QB so we look through his eyes.
    g.visible = !(st.camera === 'qb' && index === qbIndex(play));
    const x = sample(play.x[index], t);
    const y = sample(play.y[index], t);
    const o = sampleAngle(play.o[index], t);
    g.position.set(sceneX(x), 0, sceneZ(y));
    model.rotation.y = yawFromO(o);

    const s = Math.max(0, sample(play.s[index], t));
    const backwards = s > 0.8 && angleDiff(o, motionDir(play, index, t)) > 115;
    // Forward gaits blend idle → walk → run → sprint by real speed.
    const idleW = clamp(1 - s / 1.1, 0, 1);
    const sprintW = actions.sprint ? clamp((s - 6) / 1.5, 0, 1) : 0;
    const runW = clamp((s - 2.2) / 2.2, 0, 1) * (1 - sprintW);
    const walkW = clamp(1 - idleW - runW - sprintW, 0, 1);
    // Moving backward (DBs in coverage): the backpedal clip takes over the moving share.
    const bpW = backwards && actions.backpedal ? 1 - idleW : 0;
    const fwd = 1 - (bpW > 0 ? 1 : 0);
    actions.idle.setEffectiveWeight(idleW);
    actions.walk.setEffectiveWeight(walkW * fwd);
    actions.run.setEffectiveWeight(runW * fwd);
    actions.sprint?.setEffectiveWeight(sprintW * fwd);
    actions.backpedal?.setEffectiveWeight(bpW);
    // Match stride to real speed so feet don't skate: world stride = clip stride × body scale.
    const stride = scale * girth;
    const reverse = backwards && !actions.backpedal ? -1 : 1;
    actions.walk.timeScale = reverse * clamp(s / (gait.walk * stride), 0.5, 2.2);
    actions.run.timeScale = reverse * clamp(s / (gait.run * stride), 0.5, 1.8);
    if (actions.sprint && clips.sprint) actions.sprint.timeScale = clamp(s / (clips.sprint.speed * stride), 0.6, 1.6);
    if (actions.backpedal && clips.backpedal) actions.backpedal.timeScale = clamp(s / (clips.backpedal.speed * stride), 0.5, 2);
    // Legs follow the play clock, including while scrubbing.
    const prev = lastTime.current ?? t;
    lastTime.current = t;
    restoreAnimPose(rig);
    mixer.update(Math.min(0.25, Math.abs(t - prev) / play.fps));
    saveAnimPose(rig);
    // Fresh parent transforms so hand positions (and the ball in them) match this frame.
    model.parent?.updateWorldMatrix(true, false);
    pose(rig, play, index, t, clips);

    const ghost =
      (!!meta.modelled && play.throw != null && t > play.throw + 1) ||
      (!!meta.seen && !meta.seen.some(([a, b]) => t >= a - 1 && t <= b + 1));
    if (ghost !== ghosted.current) {
      ghosted.current = ghost;
      const from = ghost ? materials : materials.ghost;
      const to = ghost ? materials.ghost : materials;
      g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const key = KIT_KEYS.find((k) => from[k] === mesh.material);
        if (key) mesh.material = to[key];
        else if (mesh.material instanceof THREE.MeshStandardMaterial && mesh.material.map) {
          mesh.material.opacity = ghost ? 0.28 : 1; // jersey numbers
        }
        mesh.userData.shadow ??= mesh.castShadow;
        mesh.castShadow = !ghost && mesh.userData.shadow;
      });
    }

    const sel = st.selected === index;
    const hov = st.hovered === index;
    if (ring.current && ringMat.current) {
      const k = sel ? 1.25 + Math.sin(performance.now() / 260) * 0.06 : hov ? 1.15 : 1;
      ring.current.scale.setScalar(k);
      ringMat.current.opacity = sel ? 1 : hov ? 0.85 : 0.4;
      ringMat.current.color.set(sel ? '#ffd400' : uniform.helmet);
    }
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const st = useStore.getState();
    if (st.mode === 'qb' && st.qb.phase === 'decide') {
      if (meta.off && meta.runner) st.setQb({ pick: index, phase: 'reveal' });
      return;
    }
    st.select(st.selected === index ? null : index);
  };

  return (
    <group ref={root}>
      <group scale={[scale * girth, scale, scale * girth]}>
        <primitive object={model} />
      </group>
      <mesh
        geometry={hitGeo}
        position-y={1.1}
        visible={false}
        onClick={onClick}
        onPointerOver={(e) => {
          e.stopPropagation();
          useStore.getState().hover(index);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          if (useStore.getState().hovered === index) useStore.getState().hover(null);
          document.body.style.cursor = '';
        }}
      />
      <mesh ref={ring} geometry={ringGeo} rotation-x={-Math.PI / 2} position-y={0.03} renderOrder={2}>
        <meshBasicMaterial ref={ringMat} transparent depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh geometry={discGeo} rotation-x={-Math.PI / 2} position-y={0.025} renderOrder={2}>
        <meshBasicMaterial color="#000000" transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <PlayerTag play={play} index={index} height={heightYd} />
    </group>
  );
}

/** Floating tag for the selected / hovered player, and QB Read target letters. */
function PlayerTag({ play, index, height }: { play: Play; index: number; height: number }) {
  const meta = play.players[index];
  const selected = useStore((s) => s.selected === index);
  const hovered = useStore((s) => s.hovered === index);
  const qbPhase = useStore((s) => (s.mode === 'qb' ? s.qb.phase : null));
  const qbPick = useStore((s) => s.qb.pick);
  const speedRef = useRef<HTMLSpanElement>(null);
  const sepRef = useRef<HTMLSpanElement>(null);

  useFrame(() => {
    if (!speedRef.current) return;
    const t = useStore.getState().time;
    const mph = sample(play.s[index], t) * 2.045;
    speedRef.current.textContent = `${mph.toFixed(1)} mph`;
    if (sepRef.current) {
      const sep = separation(play, index, t);
      sepRef.current.textContent = `${sep.toFixed(1)} yd`;
    }
  });

  const option = qbPhase === 'decide' && meta.off && meta.runner;
  const show = selected || hovered || option;
  if (!show) return null;
  const last = lastName(meta.name);
  const showSep = meta.off && meta.runner;

  if (option) {
    return (
      <Billboard position={[0, height + 0.9, 0]}>
        <mesh position-z={-0.01}>
          <circleGeometry args={[0.62, 32]} />
          <meshBasicMaterial color={qbPick === index ? '#ffd400' : '#0b0f17'} toneMapped={false} transparent opacity={0.92} />
        </mesh>
        <Text font={FONT} fontSize={0.7} color={qbPick === index ? '#0b0f17' : '#ffffff'} anchorX="center" anchorY="middle">
          {meta.num ?? '?'}
        </Text>
      </Billboard>
    );
  }

  return (
    <Html position={[0, height + 0.35, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`tag ${selected ? 'tag--selected' : ''}`}>
        <span className="tag__num">{meta.num ?? ''}</span>
        <span className="tag__name">{last}</span>
        <span className="tag__pos">{meta.pos}</span>
        <span className="tag__stat" ref={speedRef} />
        {showSep && (
          <span className="tag__stat">
            sep <span ref={sepRef} />
          </span>
        )}
      </div>
    </Html>
  );
}

export function Players({ play }: { play: Play }) {
  const kit = useMemo(() => uniformColors(play.home, play.away), [play.home, play.away]);
  const gltf = useGLTF(MODEL);
  const [clips, setClips] = useState<Clips | null>(null);
  useEffect(() => {
    let live = true;
    loadClips().then((c) => live && setClips(c));
    return () => {
      live = false;
    };
  }, []);
  const gait = useMemo(() => {
    const probe = cloneSkinned(gltf.scene);
    const clip = (n: string) => inPlace(gltf.animations.find((a) => a.name === n)!);
    return { walk: clipSpeed(probe, clip('walk')), run: clipSpeed(probe, clip('run')) };
  }, [gltf]);
  const materials = useMemo(() => {
    const out: Record<string, AthleteProps['materials']> = {};
    for (const [abbr, u] of Object.entries(kit)) {
      const kit = { body: uniformMaterial(u, u.pants), ...equipment(u, abbr === play.home ? u.trim : '#f4f4f0') };
      out[abbr] = { ...kit, ghost: ghostKit(kit) };
    }
    return out;
  }, [kit, play.home]);
  useEffect(
    () =>
      () =>
        Object.values(materials).forEach(({ ghost, ...kit }) =>
          [...Object.values(kit), ...Object.values(ghost)].forEach((x) => x.dispose()),
        ),
    [materials],
  );

  if (!clips) return null;
  return (
    <group>
      {play.players.map((p, i) => {
        const u = kit[p.team] ?? Object.values(kit)[0];
        return (
          <Athlete key={`${play.id}-${p.id}`} play={play} index={i} uniform={u} gait={gait} clips={clips} materials={materials[p.team] ?? Object.values(materials)[0]} />
        );
      })}
    </group>
  );
}
