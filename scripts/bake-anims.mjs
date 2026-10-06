// Bake Mixamo FBX clips into public/models/anims/clips.json for the replay.
//
//   node scripts/bake-anims.mjs
//
// For each clip this finds its key moment on the actual player skeleton (the QB's
// release, the center's snap, the instant hands meet the ball, the deepest stance)
// so the replay can line that moment up with the real event in the tracking data.
// It also strips root drift (tracking moves the players), trims long clips around
// the key moment, and measures the ground speed of locomotion clips for stride matching.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIMS = path.join(ROOT, 'public/models/anims');

const SPEC = {
  sprint: { file: 'sprint.fbx', kind: 'loop' },
  backpedal: { file: 'run-backward-2.fbx', kind: 'loop', speedFrom: 'run-backward.fbx' },
  stance: { file: 'football-stance.fbx', kind: 'pose', key: 'lowestHips' },
  hike: { file: 'football-hike.fbx', kind: 'event', key: 'handSpeed:Right', before: 1.2, after: 1.0 },
  pass: { file: 'quarterback-pass.fbx', kind: 'event', key: 'handSpeed:Right', mask: 'upper', before: 1.6, after: 1.0 },
  catch: { file: 'goalkeeper-catch.fbx', kind: 'event', key: 'handsReach', mask: 'upper', before: 0.8, after: 0.8 },
  catchHigh: { file: 'goalkeeper-catch-1.fbx', kind: 'event', key: 'handsHigh', mask: 'upper', before: 0.9, after: 0.8 },
  victory: { file: 'victory.fbx', kind: 'loop' },
};

const buf = (f) => {
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const loadFbxScene = (name) => new FBXLoader().parse(buf(path.join(ANIMS, name)), '');
const loadFbx = (name) => loadFbxScene(name).animations[0];
const xbot = await new Promise((ok, fail) =>
  new GLTFLoader().parse(buf(path.join(ROOT, 'public/models/Xbot.glb')), '', ok, fail),
);
const model = xbot.scene;

/**
 * Retarget a clip from the FBX skeleton onto the GLB model. The two store bones with
 * different rest orientations, so local rotations can't be copied. Instead each frame's
 * world-space rotation change from rest is carried over:
 *   targetWorld = (sourceWorld · sourceRestWorld⁻¹) · targetRestWorld
 * and converted back to the target's local space, parents first.
 */
function retarget(srcRoot, clip) {
  const bonesOf = (root) => {
    const m = new Map();
    root.traverse((o) => o.isBone && m.set(o.name.replace(':', ''), o));
    return m;
  };
  const src = bonesOf(srcRoot);
  const tgt = bonesOf(model);
  srcRoot.updateMatrixWorld(true);
  model.updateMatrixWorld(true);
  const restW = (m) => new Map([...m].map(([n, b]) => [n, b.getWorldQuaternion(new THREE.Quaternion())]));
  const srcRest = restW(src);
  const tgtRest = restW(tgt);
  const tgtRestLocal = new Map([...tgt].map(([n, b]) => [n, b.quaternion.clone()]));
  const order = [];
  model.traverse((o) => o.isBone && order.push(o.name.replace(':', '')));

  const mixer = new THREE.AnimationMixer(srcRoot);
  mixer.clipAction(clip).play();
  const fps = 30;
  const times = [];
  const values = new Map(order.map((n) => [n, []]));
  const hipsPos = [];
  const srcHips = src.get('mixamorigHips');
  const q = new THREE.Quaternion();
  const parentW = new THREE.Quaternion();
  const frames = Math.floor(clip.duration * fps + 1e-6);
  for (let f = 0; f <= frames; f++) {
    const t = f / fps; // strictly increasing; no duplicate end key
    mixer.setTime(t);
    srcRoot.updateMatrixWorld(true);
    times.push(t);
    const world = new Map();
    for (const n of order) {
      const tb = tgt.get(n);
      const parentName = tb.parent?.isBone ? tb.parent.name.replace(':', '') : null;
      if (parentName) parentW.copy(world.get(parentName));
      else tb.parent.getWorldQuaternion(parentW);
      let w;
      const sb = src.get(n);
      if (sb) {
        const delta = sb.getWorldQuaternion(q).clone().multiply(srcRest.get(n).clone().invert());
        w = delta.multiply(tgtRest.get(n));
      } else {
        w = parentW.clone().multiply(tgtRestLocal.get(n));
      }
      world.set(n, w);
      const local = parentW.clone().invert().multiply(w);
      values.get(n).push(local.x, local.y, local.z, local.w);
    }
    hipsPos.push(srcHips.position.x, srcHips.position.y, srcHips.position.z);
  }
  mixer.stopAllAction();
  const tracks = order.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, values.get(n)));
  tracks.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', times, hipsPos));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function rootDrift(clip) {
  const t = clip.tracks.find((k) => k.name.endsWith('Hips.position'));
  const v = t.values;
  const n = v.length / 3;
  return { dx: v[(n - 1) * 3] - v[0], dz: v[(n - 1) * 3 + 2] - v[2] };
}

function inPlace(clip) {
  for (const t of clip.tracks) {
    if (!t.name.endsWith('Hips.position')) continue;
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
  return clip;
}

/** Sample bone positions (model space, meters) over the clip at 60 Hz. */
function sampleBones(clip, names) {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  const bones = names.map((n) => model.getObjectByName(`mixamorig${n}`));
  const out = [];
  const v = new THREE.Vector3();
  for (let t = 0; t <= clip.duration; t += 1 / 60) {
    mixer.setTime(t);
    model.updateMatrixWorld(true);
    out.push({ t, p: bones.map((b) => model.worldToLocal(b.getWorldPosition(v)).clone()) });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return out;
}

function keyTime(clip, key) {
  if (key === 'lowestHips') {
    const s = sampleBones(clip, ['Hips']);
    return s.reduce((a, b) => (b.p[0].y < a.p[0].y ? b : a)).t;
  }
  if (key.startsWith('handSpeed')) {
    const side = key.split(':')[1];
    const s = sampleBones(clip, [`${side}Hand`, 'Hips']);
    let best = 0;
    let bt = 0;
    // Ignore the last 0.15 s: clips often snap back to their start pose there.
    for (let i = 1; i < s.length - 9; i++) {
      const a = s[i - 1].p[0].clone().sub(s[i - 1].p[1]);
      const b = s[i].p[0].clone().sub(s[i].p[1]);
      const sp = a.distanceTo(b) * 60;
      if (sp > best) [best, bt] = [sp, s[i].t];
    }
    return bt;
  }
  if (key === 'handsReach') {
    const s = sampleBones(clip, ['RightHand', 'LeftHand', 'Spine2']);
    const reach = (x) => (x.p[0].z + x.p[1].z) / 2 - x.p[2].z;
    return s.slice(0, Math.floor(s.length * 0.75)).reduce((a, b) => (reach(b) > reach(a) ? b : a)).t;
  }
  if (key === 'handsHigh') {
    const s = sampleBones(clip, ['RightHand', 'LeftHand']);
    const h = (x) => (x.p[0].y + x.p[1].y) / 2;
    return s.reduce((a, b) => (h(b) > h(a) ? b : a)).t;
  }
  throw new Error(`unknown key ${key}`);
}

function trim(clip, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(clip.duration, end);
  const fps = 30;
  const sub = THREE.AnimationUtils.subclip(clip, clip.name, Math.round(s * fps), Math.round(e * fps), fps);
  return { clip: sub, offset: s };
}

function round(json) {
  for (const t of json.tracks) {
    t.times = t.times.map((x) => +x.toFixed(4));
    t.values = t.values.map((x) => +x.toFixed(4));
  }
  return json;
}

const out = {};
for (const [name, spec] of Object.entries(SPEC)) {
  if (!fs.existsSync(path.join(ANIMS, spec.file))) {
    console.log(`skip ${name}: ${spec.file} not found`);
    continue;
  }
  const scene = loadFbxScene(spec.file);
  let clip = retarget(scene, scene.animations[0]);
  clip.name = name;
  const drift = rootDrift(spec.speedFrom ? loadFbx(spec.speedFrom) : clip);
  // Ground speed in model units (meters) per second, from root motion when the clip has it.
  const speed = Math.hypot(drift.dx, drift.dz) / 100 / clip.duration;
  inPlace(clip);
  let key = 0;
  if (spec.key) key = keyTime(clip, spec.key);
  if (spec.kind === 'event') {
    const t = trim(clip, key - spec.before, key + spec.after);
    clip = t.clip;
    key -= t.offset;
  }
  out[name] = { kind: spec.kind, key: +key.toFixed(3), speed: +speed.toFixed(3), mask: spec.mask ?? null, clip: round(THREE.AnimationClip.toJSON(clip)) };
  console.log(`${name.padEnd(10)} ${spec.kind.padEnd(6)} ${clip.duration.toFixed(2)}s key=${key.toFixed(2)}s speed=${speed.toFixed(2)} m/s`);
}
fs.writeFileSync(path.join(ANIMS, 'clips.json'), JSON.stringify(out));
console.log(`wrote clips.json (${(fs.statSync(path.join(ANIMS, 'clips.json')).size / 1e6).toFixed(1)} MB)`);
