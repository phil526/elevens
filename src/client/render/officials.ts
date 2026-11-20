// The match officials on the pitch (20 Nov 2026, "Build all the animations"): the referee and his
// two assistants. Purely visual: they move from what the view shows and signal from the match
// events, so the simulation, online play and AI v AI results are untouched.
//
// - The referee runs a diagonal (corner to corner) keeping 9-16 m from the ball and facing it;
//   he points the way a free kick goes, holds up a yellow or red card, sweeps both arms forward
//   for advantage, points at the spot for a penalty and to the centre after a goal.
// - The assistants side-step along a touchline each (diagonally opposite the referee), level with
//   the second-last defender or the ball, whichever is nearer the goal line; the flag goes up for
//   offside and points the way for throw-ins, corners and goal kicks.
// - In the intro they lead the teams out of the tunnel and stand between the teams in the line-up
//   (as in TV walk-outs; Philip's walk-out reference video of 20 Nov 2026).

import * as THREE from 'three';
import type { Kit, PlayerDef } from '../../shared/teams';
import { PITCH } from '../../shared/config';
import type { MatchEvent } from '../../shared/types';
import type { ViewPlayer, ViewState } from '../view';
import { kitMaterials, PlayerModel } from './player';
import { RealPlayerModel, type PlayerAssets } from './realplayer';
import { ReactionDirector, type ReactionKind } from './reactions';
import { INTRO, walkAlong, type TunnelInfo } from './cinematic';
import { OFFICIALS_LINE_X } from './prematch';

/** Where and how fast (metres, m/s). */
export const OFFICIALS = {
  refMin: 9, // closest the referee comes to the ball
  refMax: 16,
  refSpeed: 6.6,
  arSpeed: 6.2,
  arZ: 35.1, // assistants' line, just outside the touchline
  sideStepMax: 4.2, // faster than this an assistant turns and runs
  cardTime: 2.6,
  signalTime: 2.2,
} as const;

/** Referee kit colours in order of preference (black first, as usual); the first clear of both kits is worn. */
const REF_COLOURS = [0x101114, 0xf3e21a, 0x1fb85a, 0xff3d7f, 0x1e8cff, 0xff8a1a];

const colDist = (a: number, b: number) => {
  const d = (s: number) => ((a >> s) & 255) - ((b >> s) & 255);
  return Math.hypot(d(16), d(8), d(0));
};

/** The referees' shirt colour for these two kits. */
export function refereeColour(kits: [Kit, Kit]): number {
  const score = (c: number) => Math.min(...kits.flatMap((k) => [colDist(c, k.shirt), colDist(c, k.sleeves), colDist(c, k.keeper)]));
  return REF_COLOURS.find((c) => score(c) > 150) ?? [...REF_COLOURS].sort((a, b) => score(b) - score(a))[0];
}

/** Where the referee wants to be for the ball at (bx, bz): on his diagonal, 9-16 m from the ball. */
export function refereeSpot(bx: number, bz: number): { x: number; z: number } {
  const x = Math.max(-40, Math.min(40, bx * 0.86));
  let z = Math.max(-26, Math.min(26, -x * 0.42 + bz * 0.35));
  let dx = x - bx, dz = z - bz;
  let d = Math.hypot(dx, dz);
  if (d < 1e-3) { dx = -0.6; dz = 0.8; d = 1; }
  const want = Math.max(OFFICIALS.refMin, Math.min(OFFICIALS.refMax, d));
  const tx = bx + (dx / d) * want;
  z = bz + (dz / d) * want;
  return { x: Math.max(-48, Math.min(48, tx)), z: Math.max(-31, Math.min(31, z)) };
}

/**
 * Where an assistant stands along his touchline: in his half (+1: x > 0), level with the
 * second-last defender of the side defending that end, or the ball if it is nearer the goal line;
 * never past halfway.
 */
export function assistantX(view: ViewState, half: 1 | -1): number {
  // The side whose own goal is at this end.
  const team = view.attackDir[0] === -half ? 0 : 1;
  const xs = view.players.filter((p) => p.team === team && !p.off).map((p) => p.pos.x * half).sort((a, b) => b - a);
  const second = xs[1] ?? 0;
  const line = Math.max(second, view.ball.pos.x * half, 0);
  return Math.min(52.5, line) * half;
}

type Kind = 'ref' | 'ar1' | 'ar2';
interface Official { kind: Kind; model: PlayerModel | RealPlayerModel; p: ViewPlayer; face: number | null; faceUntil: number }

/** What the intro wants of the officials this frame (set by cine.ts through the renderer). */
export type OfficialStage =
  | { mode: 'hidden' }
  | { mode: 'tunnel'; walk: number; tunnel: TunnelInfo }
  | { mode: 'line'; z: number };

const stub = (id: number, def: PlayerDef, x: number, z: number): ViewPlayer => ({
  id, team: 0, role: 'CDM', def, pos: { x, z }, vel: { x: 0, z: 0 }, facing: Math.PI / 2,
  stamina: 1, sprinting: false, jockeying: false, cards: 0, off: false, action: { type: 'none', t: 0, dur: 0 },
});

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _down = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

export class Officials {
  readonly group = new THREE.Group();
  private list: Official[] = [];
  private react = new ReactionDirector(911);
  private card: THREE.Mesh;
  private cardMat: THREE.MeshStandardMaterial;
  private cardUntil = 0;
  private flags: THREE.Group[] = [];
  private time = 0;
  private ballV = new THREE.Vector3();
  private lastRestart: string | null = null;
  readonly colour: number;
  /** Vanishing spray (20 Nov 2026): the line the referee sprays in front of a free-kick wall and the mark by the ball. */
  private sprayLine: THREE.Mesh;
  private sprayDot: THREE.Mesh;
  private sprayMat: THREE.MeshBasicMaterial;
  private fk: { key: string; start: number; sprayed: number; gone: number } | null = null;

  constructor(kits: [Kit, Kit], def: PlayerDef, assets: PlayerAssets | null, shadows: boolean) {
    this.group.name = 'officials';
    this.colour = refereeColour(kits);
    const kit: Kit = { shirt: this.colour, sleeves: this.colour, shorts: 0x101114, socks: 0x101114, number: 0xffffff, keeper: this.colour, pattern: 'plain' };
    const starts: [Kind, number, number][] = [['ref', -6, 8], ['ar1', 20, OFFICIALS.arZ], ['ar2', -20, -OFFICIALS.arZ]];
    starts.forEach(([kind, x, z], i) => {
      const id = 89 + i;
      const model = assets
        ? new RealPlayerModel(id, assets, kit, false, [0xd9a47e, 0x8d5a3b, 0xe8b996][i], 0, shadows, { boot: 0x0c0c0c, hair: 0x2a2a2a })
        : new PlayerModel(id, kitMaterials(kit), false, 0xd9a47e, 0x2a2a2a, 0, shadows);
      // No shirt numbers on officials.
      model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.visible = false; });
      model.root.position.set(x, 0, z);
      this.group.add(model.root);
      this.list.push({ kind, model, p: stub(id, def, x, z), face: null, faceUntil: 0 });
    });
    // Vanishing spray: a dashed foam line and a half circle by the ball.
    const sc = document.createElement('canvas');
    sc.width = 128; sc.height = 8;
    const sg = sc.getContext('2d')!;
    for (let x = 0; x < 128; x += 16) { sg.fillStyle = '#ffffff'; sg.globalAlpha = 0.85; sg.fillRect(x + 1, 1, 11, 6); }
    const stex = new THREE.CanvasTexture(sc);
    this.sprayMat = new THREE.MeshBasicMaterial({ map: stex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.sprayLine = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.14), this.sprayMat);
    this.sprayLine.rotation.x = -Math.PI / 2;
    this.sprayLine.position.y = 0.012;
    this.sprayDot = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.36, 16, 1, 0, Math.PI), this.sprayMat);
    this.sprayDot.rotation.x = -Math.PI / 2;
    this.sprayDot.position.y = 0.012;
    this.sprayLine.visible = this.sprayDot.visible = false;
    this.group.add(this.sprayLine, this.sprayDot);
    // The card in the referee's hand.
    this.cardMat = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.5, side: THREE.DoubleSide });
    this.card = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.105), this.cardMat);
    this.card.visible = false;
    this.group.add(this.card);
    // The assistants' flags: a short pole and a chequered cloth.
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const g = c.getContext('2d')!;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) % 2 ? '#ffd21a' : '#ff3b1a'; g.fillRect(x * 8, y * 8, 8, 8); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < 2; i++) {
      const f = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
      pole.position.y = 0.25;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.24), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
      cloth.position.set(0.15, 0.37, 0);
      f.add(pole, cloth);
      pole.castShadow = cloth.castShadow = shadows;
      this.flags.push(f);
      this.group.add(f);
    }
  }

  /** Everyone drawn here (shadows and tests). */
  get models() { return this.list.map((o) => o.model); }
  /** The officials' positions and signals (tests and screenshots). */
  get state() { return this.list.map((o) => ({ kind: o.kind, x: o.p.pos.x, z: o.p.pos.z, facing: o.p.facing, signal: this.react.kindOf(this.list.indexOf(o)), visible: o.model.root.visible })); }
  get cardShowing() { return this.card.visible; }

  private signal(i: number, kind: ReactionKind, dur: number, face: number | null) {
    this.react.cancel(i);
    this.react.add(i, kind, dur);
    const o = this.list[i];
    o.face = face;
    o.faceUntil = this.time + dur;
  }

  private faceTo(i: number, x: number, z: number) {
    const o = this.list[i];
    return Math.atan2(z - o.p.pos.z, x - o.p.pos.x);
  }

  /** The assistant covering the half the point (x) is in. */
  private arFor(x: number) {
    return x >= 0 ? 1 : 2;
  }

  onEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      if (e.type === 'foul' && e.team !== undefined) {
        // Free kick to the other side: point the way they attack.
        const dir = view.attackDir[1 - e.team];
        this.signal(0, 'refPoint', OFFICIALS.signalTime, dir > 0 ? 0 : Math.PI);
      } else if (e.type === 'advantage' && e.text !== 'over' && e.team !== undefined) {
        this.signal(0, 'refAdvantage', 1.8, view.attackDir[e.team] > 0 ? 0 : Math.PI);
      } else if (e.type === 'card' && e.player !== undefined) {
        const pl = view.players[e.player];
        this.cardMat.color.setHex(e.text === 'yellow' ? 0xffd400 : 0xe0141e);
        this.cardUntil = this.time + OFFICIALS.cardTime;
        this.signal(0, 'refCard', OFFICIALS.cardTime, pl ? this.faceTo(0, pl.pos.x, pl.pos.z) : null);
      } else if (e.type === 'offside' && e.x !== undefined) {
        const ar = this.arFor(e.x);
        this.signal(ar, 'flagUp', 2.4, null);
        // The referee signals the indirect free kick with an arm up.
        this.signal(0, 'refCard', 1.8, null);
        this.cardUntil = 0;
      } else if (e.type === 'goal') {
        this.signal(0, 'refPoint', 2.4, this.faceTo(0, 0, 0));
      } else if (e.type === 'call' && (e.text === 'wallback' || e.text === 'retake')) {
        // The wall crept in, or the keeper left his line: the referee steps in and points.
        this.signal(0, 'refPoint', 1.8, e.text === 'retake' && view.restart ? this.faceTo(0, view.restart.spot.x, view.restart.spot.z) : null);
      }
    }
  }

  /** Per frame. `stage` places them for the intro (null: the match). */
  update(view: ViewState, dt: number, time: number, stage: OfficialStage | null) {
    this.time = time;
    this.react.update(dt);
    const b = view.ball.pos;
    this.ballV.set(b.x, b.y, b.z);
    if (stage) { this.staged(view, dt, time, stage); return; }
    // Restarts: the assistant (and for corners and goal kicks the referee) points the way.
    const rs = view.restart;
    const key = rs ? `${rs.type}:${rs.team}:${Math.round(rs.spot.x)}:${Math.round(rs.spot.z)}` : null;
    if (rs && key !== this.lastRestart && view.phase === 'restart') {
      const dir = view.attackDir[rs.team] > 0 ? 0 : Math.PI;
      if (rs.type === 'throwin' || rs.type === 'corner' || rs.type === 'goalkick') {
        const ar = this.arFor(rs.spot.x);
        this.signal(ar, 'flagPoint', 2.2, rs.type === 'throwin' ? dir : this.faceTo(ar, rs.type === 'corner' ? rs.spot.x : Math.sign(rs.spot.x) * 47, rs.type === 'corner' ? rs.spot.z : 0));
        if (rs.type !== 'throwin') this.signal(0, 'refPoint', 2, this.faceTo(0, rs.spot.x, rs.spot.z));
      } else if (rs.type === 'penalty') {
        this.signal(0, 'refSpot', 2.6, this.faceTo(0, rs.spot.x, rs.spot.z));
      }
    }
    this.lastRestart = key;
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      o.model.root.visible = true;
      let tx: number, tz: number, max: number;
      if (o.kind === 'ref') {
        const s = refereeSpot(b.x, b.z);
        tx = s.x; tz = s.z; max = OFFICIALS.refSpeed;
        // Penalty: beside the spot, level with the box.
        if (rs && rs.type === 'penalty') { tx = rs.spot.x - Math.sign(rs.spot.x) * 4; tz = 9; }
        // Direct free kick: he walks to the ball, paces out ten yards spraying the line, then stands off.
        const pace = this.fkPace(view, time);
        if (pace) { tx = pace.x; tz = pace.z; max = pace.speed; }
      } else {
        const half = o.kind === 'ar1' ? 1 : -1;
        tx = assistantX(view, half); tz = half * OFFICIALS.arZ; max = OFFICIALS.arSpeed;
      }
      this.move(o, tx, tz, max, dt, o.kind !== 'ref');
      const signalling = o.face !== null && time < o.faceUntil;
      const speed = Math.hypot(o.p.vel.x, o.p.vel.z);
      let face: number;
      if (signalling) face = o.face!;
      else if (o.kind === 'ref') face = speed > 4.8 ? Math.atan2(o.p.vel.z, o.p.vel.x) : Math.atan2(b.z - o.p.pos.z, b.x - o.p.pos.x);
      else {
        // Assistants face the pitch and side-step; flat out they turn and run.
        const pitch = o.kind === 'ar1' ? -Math.PI / 2 : Math.PI / 2;
        face = speed > OFFICIALS.sideStepMax ? Math.atan2(o.p.vel.z, o.p.vel.x) : pitch;
      }
      o.p.facing += wrap(face - o.p.facing) * Math.min(1, dt * 7);
      o.p.sprinting = speed > 5;
      o.model.reaction = this.react.frame(i);
      o.model.update(o.p, dt, time, false, this.ballV);
    }
    this.props();
    this.spray(view, time);
  }

  /**
   * A direct free kick in range: where the referee goes this frame (to the ball, then pacing out
   * 9.15 m towards goal, then off to the side of the wall), or null once he is done.
   */
  private fkPace(view: ViewState, time: number): { x: number; z: number; speed: number } | null {
    const rs = view.restart;
    const direct = rs && rs.type === 'freekick' && !rs.quick && view.phase === 'restart' && Math.hypot(rs.spot.x - PITCH.halfLength * view.attackDir[rs.team], rs.spot.z) < 30;
    if (!direct) return null;
    const key = `${rs.team}:${Math.round(rs.spot.x * 10)}:${Math.round(rs.spot.z * 10)}`;
    if (!this.fk || this.fk.key !== key) this.fk = { key, start: time, sprayed: -1, gone: -1 };
    const t = time - this.fk.start;
    const gx = PITCH.halfLength * view.attackDir[rs.team];
    const g = { x: gx - rs.spot.x, z: -rs.spot.z };
    const gl = Math.hypot(g.x, g.z) || 1;
    g.x /= gl; g.z /= gl;
    const side = { x: -g.z, z: g.x };
    if (t < 1.1) return { x: rs.spot.x + side.x * 0.8, z: rs.spot.z + side.z * 0.8, speed: 7 };
    if (t < 3.6) {
      const k = Math.min(1, (t - 1.1) / 2.2);
      if (k >= 1 && this.fk.sprayed < 0) this.fk.sprayed = time;
      return { x: rs.spot.x + g.x * 9.15 * k + side.x * 0.8, z: rs.spot.z + g.z * 9.15 * k + side.z * 0.8, speed: 4.5 };
    }
    if (this.fk.sprayed < 0) this.fk.sprayed = time;
    return { x: rs.spot.x + g.x * 9.15 + side.x * 4, z: rs.spot.z + g.z * 9.15 + side.z * 4, speed: 4 };
  }

  /** The spray: shows once the referee has paced it out and fades a few seconds after the kick. */
  private spray(view: ViewState, time: number) {
    const fk = this.fk;
    const rs = view.restart;
    if (!fk || fk.sprayed < 0) { this.sprayLine.visible = this.sprayDot.visible = false; return; }
    if (view.phase !== 'restart' && fk.gone < 0) fk.gone = time;
    if (rs && rs.type !== 'freekick') { this.fk = null; this.sprayLine.visible = this.sprayDot.visible = false; return; }
    const fade = fk.gone < 0 ? 1 : Math.max(0, 1 - (time - fk.gone - 4) / 3);
    if (fade <= 0) { this.fk = null; this.sprayLine.visible = this.sprayDot.visible = false; return; }
    const [team, sx, sz] = fk.key.split(':').map(Number);
    const spot = { x: sx / 10, z: sz / 10 };
    const gx = PITCH.halfLength * view.attackDir[team];
    const g = { x: gx - spot.x, z: -spot.z };
    const gl = Math.hypot(g.x, g.z) || 1;
    const a = Math.atan2(g.z, g.x);
    this.sprayMat.opacity = 0.9 * Math.min(1, (time - fk.sprayed) / 0.4) * fade;
    this.sprayLine.visible = this.sprayDot.visible = true;
    this.sprayLine.position.set(spot.x + (g.x / gl) * 9.15, 0.012, spot.z + (g.z / gl) * 9.15);
    this.sprayLine.scale.set(4.2, 1, 1);
    this.sprayLine.rotation.set(-Math.PI / 2, 0, -a - Math.PI / 2);
    this.sprayDot.position.set(spot.x, 0.012, spot.z);
    this.sprayDot.rotation.set(-Math.PI / 2, 0, Math.PI / 2 - a);
  }

  private move(o: Official, tx: number, tz: number, max: number, dt: number, lineOnly: boolean) {
    const dx = tx - o.p.pos.x, dz = lineOnly ? 0 : tz - o.p.pos.z, d = Math.hypot(dx, dz);
    // Ease in: walk when close, jog, then run.
    const want = d < 0.4 ? 0 : Math.min(max, d * 0.9);
    const vx = d > 1e-3 ? (dx / d) * want : 0, vz = d > 1e-3 ? (dz / d) * want : 0;
    const k = Math.min(1, dt * 3.2);
    o.p.vel.x += (vx - o.p.vel.x) * k;
    o.p.vel.z += (vz - o.p.vel.z) * k;
    o.p.pos.x += o.p.vel.x * dt;
    o.p.pos.z += o.p.vel.z * dt;
    if (lineOnly) o.p.pos.z += (tz - o.p.pos.z) * Math.min(1, dt * 4);
  }

  /** Walk-out (leading the teams) and line-up (between the teams). */
  private staged(view: ViewState, dt: number, time: number, stage: OfficialStage) {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i];
      if (stage.mode === 'hidden') { o.model.root.visible = false; continue; }
      o.model.root.visible = true;
      if (stage.mode === 'tunnel') {
        // Three abreast, a pair's gap ahead of the first players.
        const t = stage.tunnel;
        const along = walkAlong(-1, stage.walk) + (i === 0 ? 0.4 : 0);
        const lat = (i === 0 ? 0 : i === 1 ? 1.15 : -1.15) * -t.dir;
        o.model.root.visible = along > -(INTRO.corridor - 1.5);
        o.p.pos.x = t.x + lat; o.p.pos.z = t.z + t.dir * along;
        o.p.vel.x = 0; o.p.vel.z = t.dir * INTRO.walkSpeed;
        o.p.facing = t.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        this.react.hold(i, 'lineUp', 0.4);
      } else {
        // In the middle of the line-up, facing the cameras, the referee in the centre; each away
        // player shakes their hands as he files past.
        o.p.pos.x = OFFICIALS_LINE_X[i];
        o.p.pos.z = stage.z;
        o.p.vel.x = 0; o.p.vel.z = 0;
        const passing = view.players.some((p) => !p.off && p.pos.z > stage.z + 0.5 && p.pos.z < stage.z + 1.4 && Math.abs(p.pos.x - o.p.pos.x) < 0.42);
        o.p.facing = passing ? Math.PI / 2 - 0.45 : Math.PI / 2;
        const kind: ReactionKind = passing ? 'shake' : 'lineUp';
        if (this.react.kindOf(i) !== kind) this.react.cancel(i);
        this.react.hold(i, kind, 0.4);
      }
      o.model.reaction = this.react.frame(i);
      o.model.update(o.p, dt, time, false, this.ballV);
    }
    this.props();
  }

  /** The card in the referee's raised hand, the flags in the assistants' right hands. */
  private props() {
    const handOf = (o: Official) => {
      const root = o.model.root;
      root.updateMatrixWorld(true);
      const hand = root.getObjectByName('RightHand'), fore = root.getObjectByName('RightForeArm');
      if (hand && fore) return { at: hand.getWorldPosition(_v.clone()), dir: hand.getWorldPosition(_w.clone()).sub(fore.getWorldPosition(new THREE.Vector3())).normalize() };
      // Classic figures: hand near the right hip, pointing down (or up while signalling).
      const up = this.react.kindOf(this.list.indexOf(o));
      const raised = up === 'flagUp' || up === 'refCard';
      return { at: new THREE.Vector3(-0.24, raised ? 2.35 : 0.72, raised ? 0 : 0.05).applyMatrix4(root.matrixWorld), dir: new THREE.Vector3(0, raised ? 1 : -1, 0) };
    };
    const ref = this.list[0];
    this.card.visible = ref.model.root.visible && this.time < this.cardUntil && this.react.kindOf(0) === 'refCard';
    if (this.card.visible) {
      const h = handOf(ref);
      this.card.position.copy(h.at).addScaledVector(h.dir, 0.1);
      this.card.quaternion.copy(ref.model.root.quaternion);
    }
    for (let i = 0; i < 2; i++) {
      const o = this.list[i + 1], f = this.flags[i];
      f.visible = o.model.root.visible;
      if (!f.visible) continue;
      const h = handOf(o);
      f.position.copy(h.at);
      // Signalling, the flag follows the arm; otherwise it hangs from the hand, pointing at the grass.
      const sig = this.react.kindOf(i + 1);
      const dir = sig === 'flagUp' || sig === 'flagPoint' ? h.dir : _down.set(0, -1, 0).addScaledVector(h.dir, 0.25).normalize();
      f.quaternion.setFromUnitVectors(_up, dir);
    }
  }
}
