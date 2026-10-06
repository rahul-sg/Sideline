import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import type { Play, PlayerMeta } from '../lib/types';
import { makeRig, pose, restoreAnimPose, saveAnimPose } from './rig';

async function loadXbot() {
  const buf = readFileSync(resolve(__dirname, '../../public/models/Xbot.glb'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((ok, fail) =>
    new GLTFLoader().parse(ab, '', (g) => ok(g as never), fail),
  );
}

function stillPlay(n = 40): Play {
  const meta = (i: number, pos: string, off: boolean): PlayerMeta => ({
    id: i, name: `P ${i}`, num: i, team: off ? 'KC' : 'NE', off, pos, h: 74, w: 220,
    runner: false, route: null, target: false, cov: null, rush: false, rec: false, int: false,
  });
  const line = (v: number) => Float32Array.from({ length: n }, () => v);
  return {
    id: 'p', gameId: 1, playId: 1, season: 2017, week: 1, home: 'NE', away: 'KC', offense: 'KC', defense: 'NE',
    desc: '', quarter: 1, clock: '15:00', down: 1, ytg: 10, homeScore: 0, awayScore: 0, los: 40, firstDown: 50,
    ballY: 26.65, passResult: 'C', yards: 5, epa: 0, homeWp: 0.5, homeWpa: 0, formation: null, coverage: null,
    manZone: null, playAction: false, dropback: null, timeToThrow: null, isPass: true, fps: 10, n,
    snap: 10, throw: 25, arrive: 32, events: [[10, 'ball_snap'], [25, 'pass_forward'], [32, 'pass_arrived']],
    players: [meta(0, 'QB', true), meta(1, 'T', true)],
    x: [line(35), line(39)], y: [line(26.65), line(24)], o: [line(90), line(90)], s: [line(0), line(0)],
    bx: line(35), by: line(26.65), carrier: new Int16Array(n).fill(0),
  };
}

describe('procedural poses', () => {
  it('do not accumulate while the replay is paused', async () => {
    const gltf = await loadXbot();
    const model = gltf.scene;
    const mixer = new THREE.AnimationMixer(model);
    const idle = mixer.clipAction(gltf.animations.find((a) => a.name === 'idle')!);
    idle.play();
    const rig = makeRig(model);
    const play = stillPlay();

    const frame = (t: number) => {
      restoreAnimPose(rig);
      mixer.update(0); // paused: the mixer sees no change and writes nothing
      saveAnimPose(rig);
      pose(rig, play, 0, t); // QB mid-windup
      pose(rig, play, 1, t);
    };
    const snapshot = () => rig.bones.map((b) => b.quaternion.clone());

    frame(23);
    const first = snapshot();
    for (let k = 0; k < 300; k++) frame(23);
    const later = snapshot();
    later.forEach((q, i) => {
      expect(Math.abs(q.length() - 1)).toBeLessThan(1e-4);
      expect(q.angleTo(first[i])).toBeLessThan(1e-3);
    });
  });
});
