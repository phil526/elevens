// The people round the pitch, alive: photographers behind each goal turn their lenses to follow
// play and fire flashes at shots and goals; stewards face the crowd, shifting their weight and
// now and then glancing back at the game; ball kids hold a spare ball, run along the touchline
// or behind the goal when it goes out near them, toss it in and walk back.
// Everything is instanced (a few draw calls in all) and reads only the ViewState.

import * as THREE from 'three';
import { box, figure, type StaffSpot } from './arena';
import { glowTexture } from './vfx';
import type { ViewState } from '../view';
import type { MatchEvent } from '../../shared/types';

/** Ball kids: run and walk speeds (m/s), how long the toss takes, how far they will go for a ball. */
export const KIDS = { run: 4.2, walk: 1.5, toss: 0.65, wait: 1.6, reach: 34, scale: 0.86, colour: 0x6b2bd9 } as const;

type KidState = 'home' | 'run' | 'toss' | 'wait' | 'back';
interface Kid { home: StaffSpot; x: number; z: number; yaw: number; tx: number; tz: number; state: KidState; t: number; phase: number; speed: number; hasBall: boolean; side: boolean }

const DUMMY = new THREE.Object3D();
const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

export class Pitchside {
  readonly group = new THREE.Group();
  private photo: { spots: StaffSpot[]; mesh: THREE.InstancedMesh; yaw: number[] } | null = null;
  private stew: { spots: StaffSpot[]; mesh: THREE.InstancedMesh; look: number[]; next: number[] } | null = null;
  private kids: Kid[] = [];
  private parts: Record<'torso' | 'head' | 'leg' | 'arm' | 'ball', THREE.InstancedMesh> | null = null;
  private flashes: { s: THREE.Sprite; t: number; at: number }[] = [];
  private lastRestart = '';
  private time = 0;

  constructor(staff: { photographers: StaffSpot[]; stewards: StaffSpot[]; ballKids: StaffSpot[] }, quality: number) {
    this.group.name = 'pitchside';
    const lam = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
    // Photographers: kneeling, a long lens to the eye.
    if (staff.photographers.length) {
      const g = figure({ top: 0x2a2c31, bottom: 0x15171c, vest: 0xff7a00, pose: 'kneel', skin: 0xc68a5f, extra: [(h) => box(0.13, 0.13, 0.6, 0, h + 0.62, 0.38, 0x0d0d0d)] });
      const mesh = new THREE.InstancedMesh(g, lam, staff.photographers.length);
      mesh.name = 'photographers';
      this.photo = { spots: staff.photographers, mesh, yaw: staff.photographers.map((s) => s.yaw) };
      this.group.add(mesh);
    }
    // Stewards in hi-vis, facing the stands.
    if (staff.stewards.length) {
      const g = figure({ top: 0x22242a, bottom: 0x15171c, vest: 0xe8ff1a, skin: 0xe0ac86 });
      const mesh = new THREE.InstancedMesh(g, lam, staff.stewards.length);
      mesh.name = 'stewards';
      this.stew = { spots: staff.stewards, mesh, look: staff.stewards.map(() => 0), next: staff.stewards.map((_, i) => 6 + ((i * 7.3) % 20)) };
      this.group.add(mesh);
    }
    // Ball kids: jointed so they can run, hold a ball and toss it.
    if (staff.ballKids.length) {
      const n = staff.ballKids.length;
      const plain = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const make = (geo: THREE.BufferGeometry, count: number, colour: number) => {
        const m = new THREE.InstancedMesh(geo, plain, count);
        for (let i = 0; i < count; i++) m.setColorAt(i, new THREE.Color(colour));
        m.frustumCulled = false;
        this.group.add(m);
        return m;
      };
      this.parts = {
        torso: make(new THREE.BoxGeometry(0.36, 0.5, 0.21).translate(0, 0.25, 0), n, KIDS.colour),
        head: make(new THREE.SphereGeometry(0.105, 10, 8), n, 0xd9a07a),
        leg: make(new THREE.BoxGeometry(0.14, 0.8, 0.16).translate(0, -0.4, 0), n * 2, 0x15171c),
        arm: make(new THREE.BoxGeometry(0.1, 0.52, 0.11).translate(0, -0.26, 0), n * 2, KIDS.colour),
        ball: make(new THREE.SphereGeometry(0.11, 12, 8), n, 0xf2f2ee),
      };
      const skins = [0xf1c7a5, 0xc68a5f, 0x8d5a3b, 0xe0ac86, 0x6e4a2f, 0xf5d3b8];
      staff.ballKids.forEach((h, i) => {
        this.parts!.head.setColorAt(i, new THREE.Color(skins[i % skins.length]));
        this.kids.push({ home: h, x: h.x, z: h.z, yaw: h.yaw, tx: h.x, tz: h.z, state: 'home', t: 0, phase: i * 1.3, speed: 0, hasBall: true, side: Math.abs(h.x) < 50 });
      });
    }
    // Camera flashes (High and Ultra bloom them).
    const tex = glowTexture();
    for (let i = 0; i < (quality > 0 ? 10 : 4); i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xf4f8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      s.scale.set(1.1, 1.1, 1);
      s.visible = false;
      this.flashes.push({ s, t: 0, at: -1 });
      this.group.add(s);
    }
    this.update(null, 0);
  }

  /** Match events: flashes for shots and goals, at the end the play is at. */
  onEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      const shot = e.type === 'kick' && /shot|volley|power|finesse|chip|placed|header/.test(e.text ?? '') && Math.abs(view.ball.pos.x) > 28;
      if (e.type === 'goal') this.flash(Math.sign(view.ball.pos.x) || 1, 7, 2.2);
      else if (shot || e.type === 'save' || e.type === 'post' || e.type === 'bar') this.flash(Math.sign(view.ball.pos.x) || 1, 3, 0.9);
    }
  }

  /** `count` flashes from the photographers behind one end over the next `spread` seconds. */
  flash(end: number, count: number, spread: number) {
    if (!this.photo) return;
    const ids = this.photo.spots.map((s, i) => (Math.sign(s.x) === end ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < count && ids.length; k++) {
      const f = this.flashes.find((x) => x.at < 0) ?? this.flashes[k % this.flashes.length];
      const id = ids[Math.floor(Math.random() * ids.length)];
      const s = this.photo.spots[id], yaw = this.photo.yaw[id];
      f.s.position.set(s.x + Math.sin(yaw) * 0.72, 1.18, s.z + Math.cos(yaw) * 0.72);
      f.at = this.time + Math.random() * spread;
      f.t = 0;
    }
  }

  /** Each frame (view null: just place everyone at home). */
  update(view: ViewState | null, dt: number) {
    this.time += dt;
    const t = this.time;
    const ball = view?.ball.pos;
    // Photographers follow the ball with their lenses (within their field of view).
    if (this.photo) {
      const { spots, mesh, yaw } = this.photo;
      spots.forEach((s, i) => {
        if (ball) {
          const want = Math.atan2(ball.x - s.x, ball.z - s.z);
          const d = THREE.MathUtils.clamp(angDiff(want, s.yaw), -1.1, 1.1);
          yaw[i] += angDiff(s.yaw + d, yaw[i]) * Math.min(1, dt * 3);
        }
        DUMMY.position.set(s.x, 0, s.z);
        DUMMY.rotation.set(0, yaw[i], 0);
        DUMMY.updateMatrix();
        mesh.setMatrixAt(i, DUMMY.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    // Stewards: a slow sway, now and then a look back over the shoulder at the game.
    if (this.stew) {
      const { spots, mesh, look, next } = this.stew;
      spots.forEach((s, i) => {
        if (t > next[i]) { next[i] = t + 12 + ((i * 13.7 + t) % 18); }
        const glancing = t > next[i] - 2.2 && t < next[i] && view;
        look[i] += ((glancing ? 2.4 * (i % 2 ? 1 : -1) : 0) - look[i]) * Math.min(1, dt * 2.5);
        const sway = Math.sin(t * 0.6 + i * 1.9) * 0.05;
        DUMMY.position.set(s.x + Math.sin(t * 0.35 + i) * 0.04, 0, s.z + Math.cos(t * 0.3 + i * 2) * 0.04);
        DUMMY.rotation.set(0, s.yaw + sway + look[i] * 0.5, Math.sin(t * 0.5 + i) * 0.015);
        DUMMY.updateMatrix();
        mesh.setMatrixAt(i, DUMMY.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    if (this.parts) this.updateKids(view, dt);
    // Flashes: a bright pop that fades in a tenth of a second.
    for (const f of this.flashes) {
      if (f.at < 0 || t < f.at) { f.s.visible = false; continue; }
      f.t = t - f.at;
      const k = Math.max(0, 1 - f.t / 0.12);
      f.s.visible = k > 0;
      (f.s.material as THREE.SpriteMaterial).opacity = k;
      f.s.scale.setScalar(0.8 + 0.8 * k);
      if (k <= 0) f.at = -1;
    }
  }

  /** Ball kids fetch for the throw-ins, corners and goal kicks near them. */
  private updateKids(view: ViewState | null, dt: number) {
    const r = view?.phase === 'restart' ? view.restart : null;
    if (r && (r.type === 'throwin' || r.type === 'corner' || r.type === 'goalkick')) {
      const key = `${r.type}|${r.spot.x.toFixed(1)}|${r.spot.z.toFixed(1)}`;
      if (key !== this.lastRestart) {
        this.lastRestart = key;
        // The nearest kid at home goes for it.
        let best: Kid | null = null, bd: number = KIDS.reach;
        for (const k of this.kids) {
          if (k.state !== 'home') continue;
          const tx = k.side ? THREE.MathUtils.clamp(r.spot.x, -48, 48) : k.home.x, tz = k.side ? k.home.z : THREE.MathUtils.clamp(r.spot.z, -30, 30);
          const d = Math.hypot(tx - k.x, tz - k.z);
          if (Math.sign(r.spot.z) !== Math.sign(k.home.z) && k.side) continue;
          if (d < bd && Math.hypot(r.spot.x - tx, r.spot.z - tz) < 12) { bd = d; best = k; best.tx = tx; best.tz = tz; }
        }
        if (best) { best.state = 'run'; best.t = 0; }
      }
    } else if (!r) this.lastRestart = '';
    const P = this.parts!;
    const ballPos = view?.ball.pos;
    this.kids.forEach((k, i) => {
      k.t += dt;
      let speed = 0;
      const go = (tx: number, tz: number, v: number) => {
        const dx = tx - k.x, dz = tz - k.z, d = Math.hypot(dx, dz);
        if (d < 0.05) return true;
        const step = Math.min(d, v * dt);
        k.x += (dx / d) * step; k.z += (dz / d) * step;
        speed = v;
        k.yaw += angDiff(Math.atan2(dx, dz), k.yaw) * Math.min(1, dt * 8);
        return d - step < 0.05;
      };
      if (k.state === 'run' && go(k.tx, k.tz, KIDS.run)) { k.state = 'toss'; k.t = 0; }
      else if (k.state === 'toss' && k.t > KIDS.toss) { k.state = 'wait'; k.t = 0; k.hasBall = false; }
      else if (k.state === 'wait' && k.t > KIDS.wait) { k.state = 'back'; k.t = 0; }
      else if (k.state === 'back' && go(k.home.x, k.home.z, KIDS.walk)) { k.state = 'home'; k.t = 0; k.hasBall = true; }
      if ((k.state === 'home' || k.state === 'wait' || k.state === 'toss') && ballPos) {
        // Watch the play (turned towards the pitch).
        const want = k.state === 'toss' ? k.home.yaw : Math.atan2(ballPos.x - k.x, ballPos.z - k.z);
        const d = THREE.MathUtils.clamp(angDiff(want, k.home.yaw), -1.2, 1.2);
        k.yaw += angDiff(k.home.yaw + d, k.yaw) * Math.min(1, dt * 3);
      }
      k.speed += (speed - k.speed) * Math.min(1, dt * 8);
      k.phase += dt * (k.speed > 2.5 ? 11 : 6.5) * Math.min(1, k.speed);
      // Pose.
      const a = Math.min(1, k.speed / 3) * (k.speed > 2.5 ? 0.85 : 0.45);
      const legL = Math.sin(k.phase) * a, legR = -legL;
      const bob = Math.abs(Math.sin(k.phase)) * 0.05 * Math.min(1, k.speed / 2);
      let armL = -legL * 0.9, armR = -legR * 0.9;
      if (k.hasBall && k.state !== 'toss') { armL = armR = -0.95; }
      if (k.state === 'toss') {
        // Both hands from the chest up over the head and forward: a throw-in style toss.
        const u = Math.min(1, k.t / KIDS.toss);
        armL = armR = u < 0.45 ? -0.95 - (u / 0.45) * 2.0 : -2.95 + ((u - 0.45) / 0.55) * 2.1;
      }
      const sc = KIDS.scale;
      const root = new THREE.Matrix4().compose(V.set(k.x, bob, k.z), Q.setFromAxisAngle(Y, k.yaw), S.set(sc, sc, sc));
      const put = (mesh: THREE.InstancedMesh, idx: number, x: number, y: number, z: number, rotX: number) => {
        M2.compose(V.set(x, y, z), Q.setFromAxisAngle(X, rotX), S.set(1, 1, 1));
        M.multiplyMatrices(root, M2);
        mesh.setMatrixAt(idx, M);
      };
      put(P.leg, i * 2, -0.09, 0.8, 0, legL);
      put(P.leg, i * 2 + 1, 0.09, 0.8, 0, legR);
      put(P.torso, i, 0, 0.8, 0, k.speed > 2.5 ? 0.12 : 0);
      put(P.head, i, 0, 1.43, k.speed > 2.5 ? 0.04 : 0, 0);
      put(P.arm, i * 2, -0.24, 1.25, 0, armL);
      put(P.arm, i * 2 + 1, 0.24, 1.25, 0, armR);
      // The spare ball, in both hands (gone once tossed, back when they're home with a new one).
      const handY = 1.25 - Math.cos(armL) * 0.5, handZ = -Math.sin(armL) * 0.5;
      const show = k.hasBall || (k.state === 'toss' && k.t < KIDS.toss * 0.8);
      put(P.ball, i, 0, show ? handY + 0.02 : -5, show ? handZ + 0.1 : 0, 0);
    });
    for (const m of Object.values(P)) m.instanceMatrix.needsUpdate = true;
  }

  /** For tests: what each ball kid is doing. */
  get kidStates(): string[] { return this.kids.map((k) => k.state); }
}
