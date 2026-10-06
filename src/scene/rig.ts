import * as THREE from 'three';
import { carrierAt, clamp, qbIndex, sample } from '../lib/playMath';
import type { Play } from '../lib/types';

/**
 * Procedural football poses layered on top of the run/walk/idle clips.
 *
 * Bones are aimed in the player's own frame (+Z forward, +Y up, +X = player's left),
 * so the same targets work for any Mixamo-skeleton model. Each pose is driven by
 * the play's events: stance before the snap, the QB's hold, windup and release
 * around the throw, the handoff exchange, reaching for a catch, and the ball tuck.
 */

export interface Rig {
  model: THREE.Object3D;
  b: Record<string, THREE.Object3D>;
  footRest: number;
  /** Every bone, and its pure animation pose from the last mixer update. */
  bones: THREE.Object3D[];
  byName: Record<string, THREE.Object3D>;
  animPose: Float32Array | null;
}

const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightToeBase', 'LeftToeBase',
] as const;

export function makeRig(model: THREE.Object3D): Rig {
  const b: Record<string, THREE.Object3D> = {};
  for (const n of BONES) {
    const o = model.getObjectByName(`mixamorig${n}`);
    if (o) b[n] = o;
  }
  const bones: THREE.Object3D[] = [];
  const byName: Record<string, THREE.Object3D> = {};
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      bones.push(o);
      byName[o.name] = o;
    }
  });
  return { model, b, footRest: 0.08, bones, byName, animPose: null };
}

/**
 * The mixer only writes a bone when its animated value changes, so while paused it
 * would leave last frame's procedural pose in place and poses would stack up every
 * frame. Put the clean animation pose back before each mixer update...
 */
export function restoreAnimPose(rig: Rig) {
  const p = rig.animPose;
  if (!p) return;
  rig.bones.forEach((b, k) => b.quaternion.fromArray(p, k * 4));
  rig.b.Hips?.position.fromArray(p, rig.bones.length * 4);
}

/** ...and remember it right after, before poses are layered on. */
export function saveAnimPose(rig: Rig) {
  const p = (rig.animPose ??= new Float32Array(rig.bones.length * 4 + 3));
  rig.bones.forEach((b, k) => b.quaternion.toArray(p, k * 4));
  rig.b.Hips?.position.toArray(p, rig.bones.length * 4);
}

/* ---------- Motion-capture clips (Mixamo), baked by scripts/bake-anims.mjs ---------- */

export type ClipName = 'sprint' | 'backpedal' | 'stance' | 'hike' | 'pass' | 'catch' | 'catchHigh' | 'victory';
export interface Baked {
  kind: 'loop' | 'pose' | 'event';
  /** Seconds into the clip of its key moment (release, snap, catch, deepest stance). */
  key: number;
  /** Ground speed of a locomotion clip, model units per second. */
  speed: number;
  mask: 'upper' | null;
  clip: THREE.AnimationClip;
  tracks: { bone: string; prop: string; interp: THREE.Interpolant }[];
}
export type Clips = Partial<Record<ClipName, Baked>>;

let clipsPromise: Promise<Clips> | null = null;
/** Load baked clips if present; the replay falls back to procedural poses without them. */
export function loadClips(): Promise<Clips> {
  clipsPromise ??= fetch('/models/anims/clips.json')
    .then(async (r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : {}))
    .then((raw: Record<string, { kind: Baked['kind']; key: number; speed: number; mask: Baked['mask']; clip: THREE.AnimationClipJSON }>) => {
      const out: Clips = {};
      for (const [name, c] of Object.entries(raw)) {
        const clip = THREE.AnimationClip.parse(c.clip);
        const tracks = clip.tracks.map((t) => {
          const [bone, prop] = t.name.split('.');
          return { bone, prop, interp: t.createInterpolant() };
        });
        out[name as ClipName] = { ...c, clip, tracks };
      }
      return out;
    })
    .catch(() => ({}));
  return clipsPromise;
}

const UPPER = /Spine|Neck|Head|Shoulder|Arm|Hand/;
const cq = new THREE.Quaternion();

/** Blend a clip's pose at `time` seconds onto the rig with weight w (upper body only if masked). */
export function applyClip(rig: Rig, baked: Baked, time: number, w: number) {
  if (w <= 0.001) return;
  const t = clamp(time, 0, baked.clip.duration);
  for (const tr of baked.tracks) {
    if (baked.mask === 'upper' && !UPPER.test(tr.bone)) continue;
    const bone = rig.byName[tr.bone];
    if (!bone) continue;
    const v = tr.interp.evaluate(t);
    if (tr.prop === 'quaternion') bone.quaternion.slerp(cq.fromArray(v), w);
    else if (tr.prop === 'position' && bone === rig.b.Hips) bone.position.y += (v[1] - bone.position.y) * w;
  }
  rig.model.updateMatrixWorld(true);
}

/** Right hand of each player, so the ball can sit in it. Keyed by play id + player index. */
export const hands = new Map<string, { hand: THREE.Object3D; fore: THREE.Object3D }>();

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const dq = new THREE.Quaternion();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const ID = new THREE.Quaternion();
const AX_X = new THREE.Vector3(1, 0, 0);
const AX_Y = new THREE.Vector3(0, 1, 0);

/** Rotation of obj relative to the model root, ignoring scale. */
function modelQuat(obj: THREE.Object3D, model: THREE.Object3D, out: THREE.Quaternion) {
  out.identity();
  const chain: THREE.Object3D[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== model; o = o.parent) chain.push(o);
  for (let i = chain.length - 1; i >= 0; i--) out.multiply(chain[i].quaternion);
  return out;
}

function modelPos(obj: THREE.Object3D, model: THREE.Object3D, out: THREE.Vector3) {
  obj.getWorldPosition(out);
  return model.worldToLocal(out);
}

/** Apply a model-space rotation delta to a bone. */
function rotateInModel(rig: Rig, bone: THREE.Object3D, delta: THREE.Quaternion) {
  modelQuat(bone, rig.model, q1);
  q1.premultiply(delta);
  modelQuat(bone.parent!, rig.model, q2).invert();
  bone.quaternion.copy(q2.multiply(q1));
  bone.updateMatrixWorld(true);
}

/** Point a bone (toward its child) along a direction in the player's frame. */
export function aim(rig: Rig, name: string, child: string, dir: THREE.Vector3, w: number) {
  const bone = rig.b[name];
  const kid = rig.b[child];
  if (!bone || !kid || w <= 0.001) return;
  const from = modelPos(kid, rig.model, v1).sub(modelPos(bone, rig.model, v2)).normalize();
  dq.setFromUnitVectors(from, dir);
  if (w < 1) dq.slerpQuaternions(ID, dq, w);
  rotateInModel(rig, bone, dq);
}

function turn(rig: Rig, name: string, axis: THREE.Vector3, angle: number) {
  const bone = rig.b[name];
  if (!bone || Math.abs(angle) < 1e-4) return;
  dq.setFromAxisAngle(axis, angle);
  rotateInModel(rig, bone, dq);
}

const d = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
const P = {
  // Two-hand hold at the chest
  holdRA: d(-0.3, -0.8, 0.5), holdRF: d(0.65, 0.3, 0.7), holdLA: d(0.3, -0.8, 0.5), holdLF: d(-0.65, 0.3, 0.7),
  // Ball tucked high and tight in the right arm
  tuckRA: d(-0.2, -0.9, 0.3), tuckRF: d(0.55, 0.25, 0.8),
  // Throw
  windRA: d(-0.8, 0.35, -0.5), windRF: d(-0.05, 0.95, -0.3), aimLA: d(0.35, 0.15, 0.92), aimLF: d(0.1, 0.1, 1),
  relRA: d(-0.25, 0.6, 0.76), relRF: d(0, 0.3, 0.95), followRA: d(0.25, -0.55, 0.8), followRF: d(0.45, -0.6, 0.65),
  // Stances
  lineSpine: d(0, 0.5, 0.86), lineThighR: d(-0.12, -0.5, 0.86), lineThighL: d(0.12, -0.5, 0.86),
  lineShin: d(0, -0.92, -0.38), handDownRA: d(-0.08, -0.82, 0.57), handDownRF: d(0, -0.97, 0.25),
  restLA: d(0.2, -0.85, 0.48), restLF: d(-0.3, -0.5, 0.8),
  skillSpine: d(0, 0.82, 0.57), skillThighR: d(-0.08, -0.82, 0.57), skillThighL: d(0.08, -0.82, 0.57), skillShin: d(0, -0.97, -0.25),
};

/** 0→1→0 envelope over [a, b, c, e]: rises a→b, holds b→c, falls c→e. */
function env(t: number, a: number, b: number, c: number, e: number) {
  if (t <= a || t >= e) return 0;
  if (t < b) return (t - a) / (b - a);
  if (t <= c) return 1;
  return 1 - (t - c) / (e - c);
}
const smooth = (x: number) => x * x * (3 - 2 * x);

const LINE = new Set(['T', 'G', 'C', 'OT', 'OG', 'DE', 'DT', 'NT', 'DL', 'OL']);

/** Pose the rig for frame t. Call after the animation mixer has updated. */
export function pose(rig: Rig, play: Play, i: number, t: number, clips: Clips = {}) {
  const meta = play.players[i];
  rig.model.position.y = 0;
  // One full update after the mixer; each pose step then refreshes only the bones it moves.
  rig.model.updateMatrixWorld(true);
  const pre = clamp((play.snap + 1.5 - t) / 2.5, 0, 1); // stance, released over ~0.25 s after the snap
  const s = sample(play.s[i], t);

  const qb = qbIndex(play);
  const sec = (frames: number) => frames / play.fps;
  let clipStance = false;

  // Linemen: motion-captured stance, and the center's snap
  if (meta.pos && LINE.has(meta.pos) && clips.stance) {
    clipStance = true;
    const hike = meta.pos === 'C' && clips.hike;
    if (hike) {
      applyClip(rig, clips.stance, clips.stance.key, smooth(clamp((play.snap - 10 - t) / 4, 0, 1)));
      applyClip(rig, hike, hike.key + sec(t - play.snap), smooth(env(t, play.snap - 14, play.snap - 10, play.snap + 4, play.snap + 9)));
    } else {
      applyClip(rig, clips.stance, clips.stance.key, smooth(pre));
    }
  }

  // Pre-snap stance (procedural, for skill players or when no clip is loaded)
  if (pre > 0 && !clipStance) {
    const w = smooth(pre);
    if (meta.pos && LINE.has(meta.pos)) {
      aim(rig, 'Spine', 'Spine1', P.lineSpine, w * 0.8);
      aim(rig, 'RightUpLeg', 'RightLeg', P.lineThighR, w);
      aim(rig, 'LeftUpLeg', 'LeftLeg', P.lineThighL, w);
      aim(rig, 'RightLeg', 'RightFoot', P.lineShin, w);
      aim(rig, 'LeftLeg', 'LeftFoot', P.lineShin, w);
      aim(rig, 'RightArm', 'RightForeArm', P.handDownRA, w);
      aim(rig, 'RightForeArm', 'RightHand', P.handDownRF, w);
      aim(rig, 'LeftArm', 'LeftForeArm', P.restLA, w);
      aim(rig, 'LeftForeArm', 'LeftHand', P.restLF, w);
    } else if (meta.pos !== 'QB') {
      aim(rig, 'Spine', 'Spine1', P.skillSpine, w * 0.7);
      aim(rig, 'RightUpLeg', 'RightLeg', P.skillThighR, w * 0.8);
      aim(rig, 'LeftUpLeg', 'LeftLeg', P.skillThighL, w * 0.8);
      aim(rig, 'RightLeg', 'RightFoot', P.skillShin, w * 0.8);
      aim(rig, 'LeftLeg', 'LeftFoot', P.skillShin, w * 0.8);
    }
  }

  // Run lean: sprinters tilt forward with speed
  const lean = clamp((s - 2) / 6, 0, 1) * 0.22;
  if (lean > 0.01) turn(rig, 'Spine', AX_X, lean);

  const holder = carrierAt(play, t);
  const handoff = play.events.find(([, e]) => e === 'handoff')?.[0];

  // Quarterback: motion-captured throw, release lined up with the real release frame
  if (i === qb && play.throw != null && clips.pass) {
    const T = play.throw;
    const hold = env(t, play.snap + 2, play.snap + 5, T - 14, T - 10);
    armPair(rig, P.holdRA, P.holdRF, P.holdLA, P.holdLF, hold);
    applyClip(rig, clips.pass, clips.pass.key + sec(t - T), smooth(env(t, T - 16, T - 11, T + 5, T + 10)));
  } else if (i === qb && play.throw != null) {
    // Procedural fallback: hold, windup, release, follow-through
    const T = play.throw;
    const hold = env(t, play.snap + 2, play.snap + 5, T - 6, T - 4);
    armPair(rig, P.holdRA, P.holdRF, P.holdLA, P.holdLF, hold);
    const wind = smooth(env(t, T - 7, T - 2, T - 1.5, T - 0.5));
    aim(rig, 'RightArm', 'RightForeArm', P.windRA, wind);
    aim(rig, 'RightForeArm', 'RightHand', P.windRF, wind);
    aim(rig, 'LeftArm', 'LeftForeArm', P.aimLA, wind * 0.8);
    aim(rig, 'LeftForeArm', 'LeftHand', P.aimLF, wind * 0.8);
    turn(rig, 'Spine1', AX_Y, -0.45 * wind);
    const rel = smooth(env(t, T - 1.5, T - 0.3, T + 0.5, T + 2));
    aim(rig, 'RightArm', 'RightForeArm', P.relRA, rel);
    aim(rig, 'RightForeArm', 'RightHand', P.relRF, rel);
    turn(rig, 'Spine1', AX_Y, 0.3 * rel);
    const fol = smooth(env(t, T + 0.5, T + 2, T + 3, T + 7));
    aim(rig, 'RightArm', 'RightForeArm', P.followRA, fol);
    aim(rig, 'RightForeArm', 'RightHand', P.followRF, fol);
    turn(rig, 'Spine', AX_X, 0.25 * fol);
  } else if (i === qb && handoff != null) {
    const hold = env(t, play.snap + 2, play.snap + 4, handoff - 4, handoff - 2);
    armPair(rig, P.holdRA, P.holdRF, P.holdLA, P.holdLF, hold);
    // Reach toward the back taking the handoff
    const rb = holderAfter(play, handoff);
    const reach = smooth(env(t, handoff - 4, handoff - 1, handoff + 0.5, handoff + 3));
    if (rb >= 0 && reach > 0) {
      const dir = towardInModel(rig, play, rb, t, 1.0).setY(-0.15).normalize();
      armPair(rig, dir, dir, dir, dir, reach);
    }
  }

  // Receivers: motion-captured catch at the arrival frame; deep balls get the high catch
  const catcher = play.arrive != null && i !== qb && (holderAfter(play, play.arrive + 1) === i || (play.players[i].target && play.passResult !== 'IN'));
  const catchClip = play.throw != null && play.arrive != null && play.arrive - play.throw > 18 ? clips.catchHigh ?? clips.catch : clips.catch;
  if (catcher && catchClip) {
    const A = play.arrive!;
    applyClip(rig, catchClip, catchClip.key + sec(t - A), smooth(env(t, A - 8, A - 3, A + 1, A + 6)));
  } else if (play.arrive != null && holderAfter(play, play.arrive + 1) === i && i !== qb) {
    const A = play.arrive;
    const reach = smooth(env(t, A - 6, A - 1, A, A + 3));
    if (reach > 0) {
      const dir = ballDirInModel(rig);
      armPair(rig, dir, dir, dir, dir, reach);
    }
  }

  // Tuck the ball while running with it (not the QB in the pocket)
  if (holder === i && !(i === qb && play.throw != null && t < play.throw + 2)) {
    const since = t - firstHeld(play, i, t);
    const tuck = smooth(clamp((since - 1) / 3, 0, 1)) * (i === qb && s < 1.5 ? 0.5 : 1);
    aim(rig, 'RightArm', 'RightForeArm', P.tuckRA, tuck);
    aim(rig, 'RightForeArm', 'RightHand', P.tuckRF, tuck);
  }

  // Touchdown celebration once the scorer slows down
  const td = play.events.find(([, e]) => e === 'touchdown' || e === 'pass_outcome_touchdown')?.[0];
  if (td != null && clips.victory && t > td + 5 && play.carrier[td] === i) {
    const w = smooth(clamp((t - td - 5) / 6, 0, 1)) * clamp((2.5 - s) / 1.5, 0, 1);
    applyClip(rig, clips.victory, sec(t - td - 5) % clips.victory.clip.duration, w);
  }

  // Keep the lowest foot on the turf after posing
  const lf = rig.b.LeftToeBase ?? rig.b.LeftFoot;
  const rf = rig.b.RightToeBase ?? rig.b.RightFoot;
  if (lf && rf && pre > 0 && !clipStance) {
    const low = Math.min(modelPos(lf, rig.model, v1).y, modelPos(rf, rig.model, v2).y);
    rig.model.position.y = (rig.footRest - low) * smooth(pre);
  }
}

function armPair(rig: Rig, ra: THREE.Vector3, rf: THREE.Vector3, la: THREE.Vector3, lf: THREE.Vector3, w: number) {
  if (w <= 0.001) return;
  aim(rig, 'RightArm', 'RightForeArm', ra, w);
  aim(rig, 'RightForeArm', 'RightHand', rf, w);
  aim(rig, 'LeftArm', 'LeftForeArm', la, w);
  aim(rig, 'LeftForeArm', 'LeftHand', lf, w);
}

function holderAfter(play: Play, f: number) {
  return play.carrier[Math.min(play.n - 1, Math.max(0, Math.ceil(f)))] ?? -1;
}

function firstHeld(play: Play, i: number, t: number) {
  let f = Math.floor(t);
  while (f > 0 && play.carrier[f - 1] === i) f--;
  return f;
}

/** Direction from this player's chest toward another player, in this player's frame. */
function towardInModel(rig: Rig, play: Play, j: number, t: number, height: number) {
  const target = new THREE.Vector3(sample(play.x[j], t) - 60, height, -(sample(play.y[j], t) - 80 / 3));
  return dirToWorldPoint(rig, target);
}

const ballWorld = new THREE.Vector3();
export function setBallWorld(v: THREE.Vector3) {
  ballWorld.copy(v);
}
function ballDirInModel(rig: Rig) {
  return dirToWorldPoint(rig, ballWorld);
}

function dirToWorldPoint(rig: Rig, world: THREE.Vector3) {
  const chest = rig.b.Spine2 ?? rig.model;
  const from = modelPos(chest, rig.model, new THREE.Vector3());
  const to = rig.model.worldToLocal(world.clone());
  return to.sub(from).normalize();
}

/**
 * Ground speed of a locomotion clip, in model units per second, measured from how
 * far a foot travels relative to the hips during one cycle.
 */
export function clipSpeed(model: THREE.Object3D, clip: THREE.AnimationClip): number {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  const foot = model.getObjectByName('mixamorigLeftFoot');
  const hips = model.getObjectByName('mixamorigHips');
  if (!foot || !hips) return 1;
  let lo = Infinity;
  let hi = -Infinity;
  const steps = 40;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let k = 0; k <= steps; k++) {
    mixer.setTime((clip.duration * k) / steps);
    model.updateMatrixWorld(true);
    const z = model.worldToLocal(foot.getWorldPosition(a)).z - model.worldToLocal(hips.getWorldPosition(b)).z;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  // One cycle is two steps; each step covers roughly the foot's fore-aft range.
  return (2 * (hi - lo)) / clip.duration;
}
