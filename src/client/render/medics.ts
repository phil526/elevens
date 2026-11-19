// Matchday extras in 3D (19 Nov 2026):
//  - injuries: two physios run on with their bags and kneel by the injured player; for a bad one
//    two stretcher bearers bring the stretcher, he is lifted onto it and carried to the touchline
//    (the simulation moves him: shared/injury.ts; here he is raised onto the stretcher);
//  - skill games: the targets hanging in the goal (Target practice).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { INJURY } from '../../shared/injury';
import { PITCH } from '../../shared/config';
import type { ViewState } from '../view';
import { box, figure } from './arena';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** A person who can stand (running bob) or kneel. */
class Medic {
  root = new THREE.Group();
  private stand: THREE.Mesh;
  private kneel: THREE.Mesh;
  constructor(mat: THREE.Material, top: number, vest?: number, bag = false) {
    const extra = bag ? [(hip: number) => box(0.32, 0.24, 0.16, 0.36, hip - 0.05, 0.05, 0x161616)] : [];
    this.stand = new THREE.Mesh(figure({ top, bottom: 0x16181d, vest, skin: 0xc99a74, extra }), mat);
    this.kneel = new THREE.Mesh(figure({ top, bottom: 0x16181d, vest, skin: 0xc99a74, pose: 'kneel' }), mat);
    this.stand.castShadow = this.kneel.castShadow = true;
    this.root.add(this.stand, this.kneel);
    this.kneel.visible = false;
    this.root.visible = false;
  }
  place(x: number, z: number, yaw: number, kneel: boolean, run: number, t: number) {
    this.root.visible = true;
    this.root.position.set(x, run > 0 ? Math.abs(Math.sin(t * 9)) * 0.06 * run : 0, z);
    this.root.rotation.y = yaw;
    this.stand.visible = !kneel;
    this.kneel.visible = kneel;
    this.stand.rotation.x = run * 0.12;
  }
  hide() { this.root.visible = false; }
}

const yawTo = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, tz - fz);

export class MatchExtras {
  group = new THREE.Group();
  private physios: Medic[];
  private bearers: Medic[];
  private stretcher: THREE.Mesh;
  private targets: THREE.Mesh[] = [];
  private targetMats: THREE.MeshBasicMaterial[] = [];
  private t = 0;
  /** The physios walking back off after a knock (where from, how long ago). */
  private leaving: { at: { x: number; z: number }; edge: { x: number; z: number }; t: number } | null = null;
  private lastInjury: { at: { x: number; z: number }; edge: { x: number; z: number } } | null = null;
  private lifted = -1;

  constructor() {
    this.group.name = 'matchday-extras';
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.physios = [new Medic(mat, 0x1d3b2a, undefined, true), new Medic(mat, 0x1d3b2a, undefined, true)];
    this.bearers = [new Medic(mat, 0x1f2a44, 0xd8f02a), new Medic(mat, 0x1f2a44, 0xd8f02a)];
    for (const m of [...this.physios, ...this.bearers]) this.group.add(m.root);
    // Stretcher: canvas bed between two poles with handles, on short legs.
    const s = mergeGeometries([
      box(0.62, 0.05, 2.0, 0, 0, 0, 0xd94a2b),
      box(0.05, 0.05, 2.6, -0.33, 0, 0, 0xc9ccd2), box(0.05, 0.05, 2.6, 0.33, 0, 0, 0xc9ccd2),
      box(0.04, 0.16, 0.04, -0.33, -0.1, 0.8, 0x9aa0aa), box(0.04, 0.16, 0.04, 0.33, -0.1, 0.8, 0x9aa0aa),
      box(0.04, 0.16, 0.04, -0.33, -0.1, -0.8, 0x9aa0aa), box(0.04, 0.16, 0.04, 0.33, -0.1, -0.8, 0x9aa0aa),
    ]);
    this.stretcher = new THREE.Mesh(s, mat);
    this.stretcher.castShadow = true;
    this.stretcher.visible = false;
    this.group.add(this.stretcher);
  }

  /** Builds the targets for a skill game (once per match). */
  private ensureTargets(n: number) {
    while (this.targets.length < n) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 40), mat);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.34, 24), mat);
      ring.add(dot);
      ring.visible = false;
      this.targets.push(ring);
      this.targetMats.push(mat);
      this.group.add(ring);
    }
  }

  /**
   * Per frame. `roots` gives each player's model root, so the injured player can be raised onto
   * the stretcher.
   */
  update(view: ViewState, dt: number, roots: (i: number) => THREE.Object3D | undefined) {
    this.t += dt;

    // Skill-game targets.
    const sk = view.skill;
    if (sk && sk.targets.length) {
      this.ensureTargets(sk.targets.length);
      const x = sk.dir * (PITCH.halfLength + 0.05);
      sk.targets.forEach((tg, i) => {
        const m = this.targets[i];
        m.visible = !tg.hit;
        m.position.set(x, tg.y, tg.z);
        m.rotation.y = Math.PI / 2;
        m.scale.setScalar(tg.r);
        this.targetMats[i].color.setHex(tg.pts >= 3 ? 0xffd23a : tg.pts === 2 ? 0xd9dde6 : 0xd08a4a);
        this.targetMats[i].opacity = 0.75 + 0.2 * Math.sin(this.t * 4 + i);
      });
      for (let i = sk.targets.length; i < this.targets.length; i++) this.targets[i].visible = false;
    } else for (const m of this.targets) m.visible = false;

    // Injury treatment.
    const j = view.injury;
    if (this.lifted >= 0 && (!j || j.pid !== this.lifted)) { const r = roots(this.lifted); if (r) r.position.y = 0; this.lifted = -1; }
    if (!j || j.stage === 'done') {
      this.stretcher.visible = false;
      for (const b of this.bearers) b.hide();
      if (this.lastInjury && !j) { this.leaving = { ...this.lastInjury, t: 0 }; this.lastInjury = null; }
      if (this.leaving) {
        // Walking back to the touchline.
        const L = this.leaving;
        L.t += dt;
        const k = clamp01(L.t / 3.2);
        this.physios.forEach((m, i) => {
          const sx = L.at.x + (i ? 0.9 : -0.9), x = lerp(sx, L.edge.x + (i ? 0.7 : -0.7), k), z = lerp(L.at.z, L.edge.z, k);
          m.place(x, z, yawTo(sx, L.at.z, L.edge.x, L.edge.z), false, 0.4, this.t + i);
        });
        if (k >= 1) { this.leaving = null; for (const m of this.physios) m.hide(); }
      } else for (const m of this.physios) m.hide();
      return;
    }
    this.leaving = null;
    this.lastInjury = { at: j.at, edge: j.edge };
    const p = view.players[j.pid];
    const pos = p ? p.pos : j.at;
    const t = j.t;
    const runK = clamp01((t - INJURY.down) / INJURY.runOn);
    const stretcherCase = j.severity >= 2;
    const side = Math.sign(j.edge.z) || 1;
    // Physios: run on from the touchline, then kneel either side of him.
    this.physios.forEach((m, i) => {
      const off = i ? 0.85 : -0.85;
      const tx = j.at.x + off, tz = j.at.z + side * 0.25;
      if (j.stage === 'down') { m.hide(); return; }
      if (j.stage === 'runon') {
        const k = Math.min(1, runK * 1.15);
        const x = lerp(j.edge.x + off, tx, k), z = lerp(j.edge.z, tz, k);
        m.place(x, z, yawTo(j.edge.x, j.edge.z, j.at.x, j.at.z), false, k < 1 ? 1 : 0, this.t + i * 0.4);
      } else if (j.stage === 'treat' || j.stage === 'lift') {
        m.place(tx, tz, yawTo(tx, tz, j.at.x, j.at.z), j.stage === 'treat', 0, this.t);
      } else {
        // Walking alongside the stretcher.
        m.place(pos.x + off * 1.6, pos.z + side * 0.9, yawTo(pos.x, pos.z, j.edge.x, j.edge.z), false, 0.3, this.t + i);
      }
    });
    // Stretcher bearers come on behind the physios.
    const yaw = yawTo(pos.x, pos.z, j.edge.x, j.edge.z);
    if (stretcherCase && j.stage !== 'down') {
      const k = clamp01((t - INJURY.down - 1.2) / INJURY.runOn);
      const sx = lerp(j.edge.x, j.at.x, k), sz = lerp(j.edge.z, j.at.z - side * 1.1, k);
      let lift = 0;
      if (j.stage === 'lift') lift = clamp01((t - INJURY.down - INJURY.runOn - INJURY.treat) / INJURY.lift);
      else if (j.stage === 'carry') lift = 1;
      const onPlayer = j.stage === 'lift' || j.stage === 'carry';
      const cx = onPlayer ? pos.x : sx, cz = onPlayer ? pos.z : sz;
      this.stretcher.visible = true;
      this.stretcher.position.set(cx, 0.12 + lift * 0.62, cz);
      this.stretcher.rotation.y = onPlayer ? yaw : Math.PI / 2;
      const fx = Math.sin(this.stretcher.rotation.y), fz = Math.cos(this.stretcher.rotation.y);
      this.bearers.forEach((m, i) => {
        const s = i ? 1 : -1;
        const bx = cx + fx * 1.45 * s, bz = cz + fz * 1.45 * s;
        m.place(bx, bz, onPlayer ? yaw : yawTo(j.edge.x, j.edge.z, j.at.x, j.at.z), false, j.stage === 'carry' || (j.stage === 'runon' && k < 1) ? 0.8 : 0, this.t + i * 0.3);
      });
      // He lies on the stretcher once it is lifted.
      const r = roots(j.pid);
      if (r) { r.position.y = onPlayer ? 0.12 + lift * 0.62 + 0.03 : 0; this.lifted = j.pid; }
    } else {
      this.stretcher.visible = false;
      for (const b of this.bearers) b.hide();
    }
  }
}
