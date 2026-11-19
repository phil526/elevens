// Procedurally built and animated footballer. Realistic proportions (1.80 m),
// readable silhouette, kit colours and back numbers. Animation is layered:
// locomotion (gait phase driven by distance travelled, so feet don't slide),
// jockey stance, and short action overlays whose timing matches the simulation
// (the kick's contact frame is the moment the ball leaves the boot).

import { classicShirtTexture } from './kitstyle';
import * as THREE from 'three';
import { PLAYER } from '../../shared/config';
import type { Kit } from '../../shared/teams';
import type { ViewPlayer } from '../view';
import { numberTexture } from './textures';
import type { ReactionFrame } from './reactions';
import { handWindup } from '../../shared/kick';
import { anticipatePose, catchPose, catchStyleFor, CATCH_DUR, overarmPose, parryPose, rollPose, type CatchStyle } from './keeperpose';
import { FALL_TOTAL, fallDirFor, fallPose, gesturePose, kickFlavourFor, relAngle, restPose, tacklePose, tackleStyleFor, type FallDir, type Gesture, type KickFlavour, type TackleStyle } from './motion';
import { footProfile } from '../../shared/teams';

// Pose channels.
/** Body roll for a shoulder barge (sign flips with the side of the challenge). */
export const BARGE_ROLL = 0.32;
export const BY = 0, BRZ = 1, SPX = 2, HLX = 3, HLZ = 4, KLX = 5, HRX = 6, HRZ = 7, KRX = 8, SLX = 9, SLZ = 10, ELX = 11, SRX = 12, SRZ = 13, ERX = 14, NKX = 15, BRX = 16;
const CH = 17;
/** Channels a reaction (render/reactions.ts) drives: the upper body always; legs and height only for crouches. */
export const UPPER = [SPX, NKX, SLX, SLZ, ELX, SRX, SRZ, ERX] as const;
export const LEGS = [BY, HLX, HRX, KLX, KRX] as const;

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Throw-in pose. `k` 0..1 is the wind-up (arch back, ball further behind the head), `f` 0..1
 * the throw itself (whip the trunk and arms forward, release in front of the head, follow through
 * with the arms out in front while the back foot drags). Both feet stay on the ground.
 */
export function throwPose(X: Float32Array, k: number, f: number, time: number) {
  const breathe = f === 0 && k === 0 ? Math.sin(time * 1.7) * 0.03 : 0;
  const whip = 1 - (1 - f) * (1 - f);
  X[SLX] = lerp(lerp(-2.75, -2.95, k), -1.25, whip) + breathe; X[SRX] = X[SLX];
  X[SLZ] = lerp(0.18, 0.1, whip); X[SRZ] = -X[SLZ];
  X[ELX] = lerp(lerp(-1.55, -2.0, k), -0.15, Math.min(1, whip * 1.5)); X[ERX] = X[ELX];
  X[SPX] = lerp(lerp(-0.12, -0.38, k), 0.42, whip);
  X[NKX] = lerp(lerp(0.05, -0.1, k), 0.15, whip);
  X[HLX] = lerp(-0.32, -0.2, whip); X[KLX] = lerp(lerp(0.15, 0.35, k), 0.25, whip);
  X[HRX] = lerp(lerp(0.22, 0.3, k), 0.48, whip); X[KRX] = lerp(lerp(0.2, 0.4, k), 0.55, whip);
  X[HLZ] = 0.06; X[HRZ] = -0.06;
  X[BY] = lerp(-0.02, -0.07, Math.max(k, whip * (1 - f * 0.5)));
  X[BRZ] = 0; X[BRX] = 0;
}

/** Which header: by the ball's height at contact, and whether it is flicked on or glanced aside. */
export function headerStyleFor(p: ViewPlayer, ball: THREE.Vector3, vel: THREE.Vector3) {
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const sp = Math.hypot(vel.x, vel.z);
  const along = sp > 0.5 ? (vel.x * fx + vel.z * fz) / sp : 1;
  const lat = sp > 0.5 ? (vel.x * fz - vel.z * fx) / sp : 0; // + to the player's right
  const kind: 'stoop' | 'stand' | 'jump' = ball.y < 1.25 ? 'stoop' : ball.y < 1.9 ? 'stand' : 'jump';
  return { kind, flick: clamp01((-along - 0.1) / 0.5), turn: Math.max(-1, Math.min(1, lat * 1.4)) };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const PITCH_HALF = 52.5;
const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export interface KitMaterials {
  shirt: THREE.Material;
  sleeves: THREE.Material;
  shorts: THREE.Material;
  socks: THREE.Material;
  keeper: THREE.Material;
  gloves: THREE.Material;
  boots: THREE.Material;
  numberColour: string;
}

export function kitMaterials(kit: Kit): KitMaterials {
  const std = (c: number, r = 0.75) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  const shirtTex = classicShirtTexture(kit);
  return {
    // Striped, hooped, sashed... shirts and the sponsor are painted on (render/kitstyle.ts).
    shirt: shirtTex ? new THREE.MeshStandardMaterial({ map: shirtTex, roughness: 0.75 }) : std(kit.shirt), sleeves: std(kit.sleeves), shorts: std(kit.shorts), socks: std(kit.socks),
    keeper: std(kit.keeper), gloves: std(0xf0f0f0), boots: std(0x111111, 0.4), numberColour: '#' + kit.number.toString(16).padStart(6, '0'),
  };
}

const geo = {
  torso: new THREE.CapsuleGeometry(0.16, 0.32, 6, 18),
  pelvis: new THREE.CapsuleGeometry(0.15, 0.08, 6, 18),
  head: new THREE.SphereGeometry(0.105, 24, 16),
  hair: new THREE.SphereGeometry(0.11, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
  neck: new THREE.CylinderGeometry(0.05, 0.055, 0.1, 12),
  upperArm: new THREE.CapsuleGeometry(0.048, 0.2, 5, 12),
  foreArm: new THREE.CapsuleGeometry(0.04, 0.2, 5, 12),
  hand: new THREE.SphereGeometry(0.045, 12, 8),
  thigh: new THREE.CapsuleGeometry(0.072, 0.3, 5, 12),
  shin: new THREE.CapsuleGeometry(0.052, 0.32, 5, 12),
  boot: new THREE.BoxGeometry(0.09, 0.07, 0.25),
  numberPlane: new THREE.PlaneGeometry(0.22, 0.22),
};

const skinMats = new Map<number, THREE.Material>();
const skinMat = (c: number) => {
  if (!skinMats.has(c)) skinMats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));
  return skinMats.get(c)!;
};

export class PlayerModel {
  root = new THREE.Group();
  body = new THREE.Group();
  private hips = new THREE.Group();
  private spine = new THREE.Group();
  private neck = new THREE.Group();
  private shL = new THREE.Group();
  private shR = new THREE.Group();
  private elL = new THREE.Group();
  private elR = new THREE.Group();
  private hipL = new THREE.Group();
  private hipR = new THREE.Group();
  private knL = new THREE.Group();
  private knR = new THREE.Group();
  /** Final blended pose channels (read by the realistic model, which reuses this as its action layer). */
  readonly pose = new Float32Array(CH);
  private loco = new Float32Array(CH);
  private act = new Float32Array(CH);
  /** Weight of the current action overlay and of the jockey stance (0..1). */
  actW = 0;
  private prevAction = 'none';
  private gettingUp = false;
  jockW = 0;
  private phase = Math.random() * Math.PI * 2;
  private holding = false;
  /** Set by the renderer each frame: holding the ball overhead for a throw-in. */
  holdThrow = false;
  /** Set by the renderer each frame: this player has the ball at his feet. */
  dribbling = false;
  /** Set by the renderer each frame: the ball's velocity (for headers). */
  ballVel = new THREE.Vector3();
  /** Set by the renderer each frame: how tired the player looks, 0..1 (motion.ts tirednessFor). */
  tired = 0;
  /** Set by the renderer each frame: a stoppage, or play far away (a tired player may rest). */
  resting = false;
  /** Set by the renderer each frame: the opposing ball carrier (picks the standing tackle's style). */
  foe: { x: number; z: number; vx: number; vz: number } | null = null;
  /** Set by the renderer when a kick starts: where it is meant to go (receiver, target, goal), if known. */
  aimHint: { x: number; z: number } | null = null;
  /** Short render-only overlay over running or standing: first touches, dribbling touches, blocks. */
  gesture: Gesture | null = null;
  /** The gesture's own pose and how strongly it shows (RealPlayerModel blends it over chosen bones). */
  readonly gestPose = new Float32Array(CH);
  gestW = 0;
  /** Resting pose (hands on knees or hips) and its weight. */
  readonly restPose = new Float32Array(CH);
  restW = 0;
  private restKind: 'knees' | 'breathe' = 'breathe';
  /** Falling after a foul and getting up: runs on after the simulation's stumble ends. */
  private fall: { dir: FallDir; t: number } | null = null;
  private fallFrom: { x: number; z: number; ttl: number } | null = null;
  /** True while the solver poses the whole body with no simulation action (getting up after a fall). */
  overlay = false;
  /** Standing tackle style, picked when the tackle starts. */
  tackleStyle: { style: TackleStyle; side: 1 | -1 } = { style: 'block', side: 1 };
  /** Toe poke, outside of the boot or backheel (null: a normal kick), and the foot for it. */
  kickFlavour: { flavour: KickFlavour | null; foot?: 1 | -1 } = { flavour: null };
  private kickRefined = false;
  private prevActT = 0;
  /** Header style picked when a header starts (see the 'header' case). */
  private headerStyle: { kind: 'stoop' | 'stand' | 'jump'; flick: number; turn: number } = { kind: 'stand', flick: 0, turn: 0 };
  meshes: THREE.Mesh[] = [];

  /** `headless` builds no meshes: only the pose solver runs (used by RealPlayerModel). */
  constructor(public id: number, kit: KitMaterials | null, keeper: boolean, skin: number, hair: number, num: number, shadows: boolean, headless = false) {
    if (headless || !kit) return;
    const shirtMat = keeper ? kit.keeper : kit.shirt;
    const sleeveMat = keeper ? kit.keeper : kit.sleeves;
    const add = (parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = shadows;
      parent.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    };
    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = 0.95;
    const pelvis = add(this.hips, geo.pelvis, kit.shorts, 0, -0.04, 0);
    pelvis.scale.set(1.05, 1, 0.75);
    pelvis.rotation.z = Math.PI / 2;
    this.hips.add(this.spine);
    this.spine.position.y = 0.04;
    const torso = add(this.spine, geo.torso, shirtMat, 0, 0.25, 0);
    torso.scale.set(1.18, 1, 0.72);
    // Back number (faces -z, the player's back).
    const numMat = new THREE.MeshBasicMaterial({ map: numberTexture(num, keeper ? '#111111' : kit.numberColour), transparent: true, depthWrite: false });
    const numMesh = new THREE.Mesh(geo.numberPlane, numMat);
    numMesh.position.set(0, 0.3, -0.122);
    numMesh.rotation.y = Math.PI;
    this.spine.add(numMesh);
    this.spine.add(this.neck);
    this.neck.position.y = 0.5;
    add(this.neck, geo.neck, skinMat(skin), 0, 0.02, 0);
    add(this.neck, geo.head, skinMat(skin), 0, 0.15, 0.01);
    add(this.neck, geo.hair, skinMat(hair), 0, 0.165, -0.005);
    for (const [sh, el, sx] of [[this.shL, this.elL, 1], [this.shR, this.elR, -1]] as const) {
      this.spine.add(sh);
      sh.position.set(sx * 0.215, 0.43, 0);
      add(sh, geo.upperArm, sleeveMat, 0, -0.13, 0);
      sh.add(el);
      el.position.y = -0.27;
      add(el, geo.foreArm, keeper ? sleeveMat : skinMat(skin), 0, -0.12, 0);
      add(el, geo.hand, keeper ? kit.gloves : skinMat(skin), 0, -0.26, 0);
    }
    for (const [hp, kn, sx] of [[this.hipL, this.knL, 1], [this.hipR, this.knR, -1]] as const) {
      this.hips.add(hp);
      hp.position.set(sx * 0.095, -0.03, 0);
      add(hp, geo.thigh, kit.shorts === shirtMat ? kit.shorts : kit.shorts, 0, -0.2, 0).scale.set(1, 1, 1);
      hp.add(kn);
      kn.position.y = -0.42;
      add(kn, geo.shin, kit.socks, 0, -0.2, 0);
      add(kn, geo.boot, kit.boots, 0, -0.45, 0.05);
    }
    // Thigh above the shorts hem is skin; approximate with a short skin band on the lower thigh.
    for (const kn of [this.knL, this.knR]) add(kn, new THREE.CylinderGeometry(0.06, 0.055, 0.08, 8), skinMat(skin), 0, 0.03, 0);
  }

  setVisible(v: boolean) {
    this.root.visible = v;
  }

  /** Update the pose for this frame. `ballHeldByMe` raises the keeper's arms. */
  update(p: ViewPlayer, dt: number, time: number, ballHeldByMe: boolean, ballPos: THREE.Vector3) {
    this.root.position.set(p.pos.x, 0, p.pos.z);
    this.root.rotation.y = Math.PI / 2 - p.facing;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const cycle = 1.4 + 0.33 * speed;
    this.phase += ((speed * dt) / cycle) * Math.PI * 2;
    const r = clamp01(speed / 7.5);
    const ph = this.phase;
    const keeper = p.role === 'GK';
    const L = this.loco;
    L.fill(0);

    // Locomotion layer.
    const A = 0.18 + 0.78 * r;
    const moving = clamp01(speed / 0.6);
    L[HLX] = Math.sin(ph) * A * moving - 0.06 * r;
    L[HRX] = -Math.sin(ph) * A * moving - 0.06 * r;
    L[KLX] = (0.12 + 1.25 * r) * Math.max(0, -Math.cos(ph)) * moving + 0.08;
    L[KRX] = (0.12 + 1.25 * r) * Math.max(0, Math.cos(ph)) * moving + 0.08;
    L[SLX] = -L[HLX] * 0.85;
    L[SRX] = -L[HRX] * 0.85;
    L[SLZ] = 0.1 + 0.08 * r;
    L[SRZ] = -0.1 - 0.08 * r;
    L[ELX] = -(0.25 + 1.0 * r);
    L[ERX] = -(0.25 + 1.0 * r);
    L[SPX] = 0.04 + 0.2 * r + (p.sprinting ? 0.08 : 0);
    L[BY] = (Math.abs(Math.cos(ph)) - 0.6) * 0.07 * r * moving;
    if (speed < 0.25) {
      L[SPX] += Math.sin(time * 1.8 + this.id) * 0.012;
      if (keeper) {
        // Ready stance.
        L[BY] = -0.12; L[HLX] = -0.35; L[HRX] = -0.35; L[KLX] = 0.65; L[KRX] = 0.65; L[SPX] = 0.25;
        L[SLX] = -0.6; L[SRX] = -0.6; L[SLZ] = 0.45; L[SRZ] = -0.45; L[ELX] = -0.5; L[ERX] = -0.5;
      }
    }
    // Jockey layer: low, wide, side-on shuffle.
    this.jockW = lerp(this.jockW, p.jockeying ? 1 : 0, 1 - Math.exp(-dt * 12));
    if (this.jockW > 0.01) {
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
      const lat = (-p.vel.x * fz + p.vel.z * fx) / 3;
      const j = this.jockW;
      L[BY] = lerp(L[BY], -0.13, j);
      L[HLX] = lerp(L[HLX], -0.3 + Math.sin(ph) * 0.2, j);
      L[HRX] = lerp(L[HRX], -0.3 - Math.sin(ph) * 0.2, j);
      L[HLZ] = lerp(L[HLZ], 0.12 + Math.max(0, Math.sin(ph)) * 0.2 * Math.abs(lat), j);
      L[HRZ] = lerp(L[HRZ], -0.12 - Math.max(0, -Math.sin(ph)) * 0.2 * Math.abs(lat), j);
      L[KLX] = lerp(L[KLX], 0.6, j);
      L[KRX] = lerp(L[KRX], 0.6, j);
      L[SPX] = lerp(L[SPX], 0.3, j);
      L[SLZ] = lerp(L[SLZ], 0.45, j);
      L[SRZ] = lerp(L[SRZ], -0.45, j);
    }
    if (this.dribbling && !keeper) {
      // Ball at the feet: shorter, looser arm swing held a little out from the body for balance,
      // chest over the ball and eyes down.
      L[SLX] *= 0.55; L[SRX] *= 0.55;
      L[SLZ] = 0.32 + 0.08 * Math.sin(ph); L[SRZ] = -0.32 + 0.08 * Math.sin(ph);
      L[ELX] = -0.75; L[ERX] = -0.75;
      L[SPX] += 0.08; L[NKX] = 0.18;
    }
    // Tired: a heavier run, arms lower, head and shoulders dropping.
    if (this.tired > 0.01 && !keeper && speed > 1) {
      const k = this.tired * clamp01((speed - 1) / 2);
      L[SLX] *= 1 - 0.35 * k; L[SRX] *= 1 - 0.35 * k; L[ELX] *= 1 - 0.2 * k; L[ERX] *= 1 - 0.2 * k;
      L[SPX] += 0.08 * k; L[NKX] += 0.12 * k;
    }
    // Resting while the ball is dead or far away: bent over with hands on knees, or hands on hips.
    const restWant = this.resting && this.tired > 0.3 && speed < 0.35 && p.action.type === 'none' && !ballHeldByMe && !this.holdThrow && !keeper ? 1 : 0;
    if (restWant && this.restW < 0.02) this.restKind = this.tired > 0.5 && this.id % 3 !== 0 ? 'knees' : 'breathe';
    this.restW = lerp(this.restW, restWant, 1 - Math.exp(-dt * (restWant ? 2.2 : 6)));
    if (this.restW > 0.001) {
      restPose(this.restPose, this.restKind, time + this.id, this.tired);
      for (let i = 0; i < CH; i++) L[i] = lerp(L[i], this.restPose[i], this.restW);
    }
    // Gestures (first touches, dribbling touches, blocks) over the running or standing pose.
    this.gestW = 0;
    const g = this.gesture;
    if (g) {
      g.t += dt;
      if (g.t >= g.dur || (p.action.type !== 'none' && p.action.type !== 'skill')) this.gesture = null;
      else {
        this.gestPose.set(L);
        this.gestW = gesturePose(this.gestPose, g);
        for (let i = 0; i < CH; i++) L[i] = lerp(L[i], this.gestPose[i], this.gestW);
      }
    }
    if (keeper && ballHeldByMe) {
      // Ball held into the chest (keeperpose.ts HOLD).
      L[SLX] = -0.3; L[SRX] = -0.3; L[ELX] = -1.25; L[ERX] = -1.25; L[SLZ] = 0.22; L[SRZ] = -0.22;
    }
    this.holding = ballHeldByMe;

    // Action layer.
    const a = p.action;
    this.lastAction = a;
    this.keeper = keeper;
    const X = this.act;
    let target = 0;
    // A slide ends with the slider on the ground: the stumble that follows is getting up.
    const prevType = this.prevAction;
    const started = a.type !== this.prevAction || a.t < this.prevActT - 0.05;
    if (a.type === 'stumble' && this.prevAction === 'slide') this.gettingUp = true;
    else if (a.type !== 'stumble') this.gettingUp = false;
    this.prevAction = a.type;
    this.prevActT = a.t;
    if (this.fallFrom && (this.fallFrom.ttl -= dt) <= 0) this.fallFrom = null;
    if (started) this.actionStarted(p, ballPos);
    if (a.type === 'kick' && !this.kickRefined && a.t >= (a.windup ?? (a.kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup))) this.refineKick(p, ballPos, this.ballVel.x, this.ballVel.z);
    // A fall plays on after the simulation lets the player go (lying, then getting up), faster if he has to move.
    if (this.fall) {
      if (a.type !== 'none' && a.type !== 'stumble') this.fall = null;
      else {
        this.fall.t += dt * (a.type === 'stumble' ? 1 : 1 + Math.min(3, Math.max(0, speed - 0.6) * 1.5));
        if (this.fall.t >= FALL_TOTAL) this.fall = null;
      }
    }
    if (a.type === 'header' && (this.prevHeader !== a || a.t < 0.02)) {
      this.prevHeader = a;
      this.headerStyle = headerStyleFor(p, ballPos, this.ballVel);
    }
    if (a.type === 'none' && this.holdThrow) {
      // Throw-in: ball held behind the head in both hands, one foot in front of the other.
      target = 1;
      X.set(L);
      throwPose(X, 0, 0, time + this.id);
    }
    if (a.type !== 'none') {
      target = 1;
      X.set(L);
      const t = a.t;
      switch (a.type) {
        case 'kick': {
          const w = a.kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup;
          const strong = a.kind === 'shot' ? 1.25 : a.kind === 'lob' || a.kind === 'cross' || a.kind === 'clear' ? 1.15 : 0.9;
          X[HLX] = -0.15; X[KLX] = 0.3;
          X[SLZ] = 0.8; X[SRZ] = -0.35; X[SLX] = -0.3; X[SRX] = 0.4;
          if (t < w) {
            const k = ease(clamp01(t / w));
            X[HRX] = lerp(0.1, 0.85 * strong, k);
            X[KRX] = lerp(0.2, 1.4, k);
            X[SPX] = 0.12;
          } else {
            const f = clamp01((t - w) / 0.2);
            const e = 1 - (1 - f) * (1 - f);
            X[HRX] = lerp(-0.25, -1.15 * strong, e);
            X[KRX] = lerp(0.7, 0.05, e);
            X[SPX] = a.kind === 'lob' || a.kind === 'cross' || a.kind === 'clear' ? -0.12 : 0.22;
            if (f >= 1) target = clamp01(1 - (t - w - 0.2) / 0.1);
          }
          X[BY] = -0.04;
          const fl = this.kickFlavour.flavour;
          if (fl === 'backheel') {
            // Step past the ball, then the heel snaps back through it.
            const f = ease(clamp01((t - w) / 0.16));
            X[HRX] = t < w ? lerp(0, -0.45, ease(clamp01(t / w))) : lerp(-0.45, 0.65, f);
            X[KRX] = t < w ? 0.35 : lerp(0.5, 1.45, f);
            X[SPX] = 0.25; X[NKX] = 0.35;
          } else if (fl === 'toe') {
            // A short stab with the toe: little backswing, straight leg.
            X[HRX] *= t < w ? 0.5 : 0.85; X[KRX] = t < w ? X[KRX] * 0.5 : 0.05; X[SPX] = 0.3;
          } else if (fl === 'outside') {
            // Outside of the boot: the leg swings across, the foot turned in, and out through the ball.
            const f = ease(clamp01((t - w) / 0.2));
            X[HRZ] = t < w ? 0.15 * ease(clamp01(t / w)) : lerp(0.15, -0.4, f);
          }
          break;
        }
        case 'throw': {
          if (keeper) {
            // Keeper's distribution from the hands: one-handed overarm throw, or rolled out underarm.
            const w = a.windup ?? handWindup(a.variant);
            if (a.variant === 'roll') rollPose(X, t, w); else overarmPose(X, t, w);
          } else {
            const w = PLAYER.kickWindup;
            throwPose(X, ease(clamp01(t / w)), clamp01((t - w) / 0.26), time + this.id);
          }
          break;
        }
        case 'tackle': {
          // Toe poke, block tackle or shoulder to shoulder (motion.ts tackleStyleFor).
          tacklePose(X, this.tackleStyle.style, this.tackleStyle.side, t, a.dur);
          break;
        }
        case 'barge': {
          // Shoulder into the carrier: lean the body towards the side the player is moving to.
          const lat = -Math.sin(p.facing) * p.vel.x + Math.cos(p.facing) * p.vel.z;
          const s = lat >= 0 ? 1 : -1;
          const k = ease(clamp01(t / 0.12)) * (1 - clamp01((t - 0.26) / 0.14));
          X[BRZ] = BARGE_ROLL * s * k; X[SPX] = 0.22 * k; X[BY] = -0.08 * k;
          X[SLX] = -0.2; X[SRX] = -0.2; X[SLZ] = 0.25 + (s > 0 ? -0.2 : 0.4) * k; X[SRZ] = -0.25 - (s < 0 ? -0.2 : 0.4) * k;
          X[ELX] = -1.0; X[ERX] = -1.0;
          X[HLX] = -0.3 * k; X[HRX] = 0.25 * k; X[KLX] = 0.5; X[KRX] = 0.5;
          break;
        }
        case 'stumble': {
          if (this.fall) {
            // Fouled: down onto the grass (motion.ts fallPose; the get-up carries on after the stumble).
            fallPose(X, this.fall.dir, this.fall.t);
            break;
          }
          if (this.gettingUp) {
            // From the end of the slide (sitting, lead leg out) back to the feet: plant the
            // trailing foot, push up off the hand, rise through a crouch.
            const u = ease(clamp01(t / a.dur));
            const push = Math.sin(Math.PI * u);
            X[BY] = -0.7 * (1 - u) * (1 - u); X[BRZ] = 0.2 * (1 - u);
            X[SPX] = -0.3 * (1 - u) + 0.45 * push;
            X[HRX] = -1.1 * (1 - u) - 0.5 * push; X[KRX] = 0.15 * (1 - u) + 1.0 * push;
            X[HLX] = -0.6 * push; X[KLX] = 1.7 * (1 - u) + 0.6 * push;
            X[SLX] = 0.9 * (1 - u) - 0.3 * push; X[SLZ] = 0.5 * (1 - u) + 0.2; X[ELX] = -0.2;
            X[SRX] = -0.4 * push; X[SRZ] = -0.35; X[ERX] = -0.6;
            X[NKX] = 0.25 * (1 - u);
            break;
          }
          const s = Math.sin(Math.PI * clamp01(t / a.dur));
          X[SPX] = 0.15 + 0.5 * s; X[BY] = -0.1 * s;
          X[SLX] = -0.9 + Math.sin(t * 14) * 0.5; X[SRX] = -0.7 - Math.sin(t * 14) * 0.5;
          X[SLZ] = 0.6; X[SRZ] = -0.6; X[KLX] = 0.4; X[KRX] = 0.4;
          break;
        }
        case 'down': {
          X[BRZ] = this.lastRoll; X[BY] = 0.18; X[SLX] = -2.6; X[SRX] = -2.6; X[HLX] = -0.2; X[HRX] = -0.1;
          break;
        }
        case 'dive': {
          const k = ease(clamp01(t / 0.3));
          let side = 1, hgt = 0.8;
          if (a.target) {
            const local = this.root.worldToLocal(new THREE.Vector3(a.target.x, a.target.y, a.target.z));
            side = local.x >= 0 ? 1 : -1;
            hgt = a.target.y;
          }
          const high = hgt > 1.7;
          const roll = -side * (high ? 0.9 : 1.35) * k;
          this.lastRoll = roll;
          X[BRZ] = roll;
          X[BY] = lerp(0, Math.max(0.15, Math.min(1.1, hgt - 0.75)), k);
          X[SLX] = -2.95 * k; X[SRX] = -2.95 * k; X[SLZ] = 0.15 * side; X[SRZ] = 0.15 * side;
          X[ELX] = -0.1; X[ERX] = -0.1; X[HLX] = -0.1; X[HRX] = 0.15; X[KLX] = 0.3; X[KRX] = 0.15; X[SPX] = 0;
          break;
        }
        case 'jump': {
          // Wall jump: crouch, spring up with the arms tucked in, land.
          const u = clamp01(t / Math.max(0.01, a.dur));
          const air = Math.sin(Math.PI * u);
          this.root.position.y = PLAYER.wallJump * air;
          const crouch = u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 0;
          X[BY] = -0.12 * crouch;
          X[HLX] = -0.5 * crouch - 0.25 * air; X[HRX] = -0.5 * crouch - 0.25 * air;
          X[KLX] = 0.9 * crouch + 0.6 * air; X[KRX] = 0.9 * crouch + 0.6 * air;
          X[SLX] = -0.35; X[SRX] = -0.35; X[SLZ] = 0.1; X[SRZ] = -0.1; X[ELX] = -1.9; X[ERX] = -1.9;
          X[SPX] = 0.1 * crouch;
          break;
        }
        case 'catch': {
          // Posed by keeperHands (the catch style picked from the ball's height).
          X[SLX] = -1.3; X[SRX] = -1.3; X[ELX] = -0.9; X[ERX] = -0.9; X[SPX] = 0.25; X[SLZ] = 0.15; X[SRZ] = -0.15;
          break;
        }
        case 'header': {
          // The action starts at contact. Three heights: a stooping header (low ball: dive the
          // head down to it), a standing header and a jumping header. A flick-on arches back.
          const u = clamp01(t / a.dur);
          const hs = this.headerStyle;
          const snap = ease(clamp01(t / 0.12)); // head driven through the ball
          const rec = ease(clamp01((u - 0.45) / 0.55)); // back to running
          const nod = lerp(0.35, -0.35, hs.flick);
          if (hs.kind === 'stoop') {
            const k = 1 - rec;
            X[BRX] = 0.3 * k; X[BY] = -0.12 * k; X[SPX] = 0.35 * k;
            X[HLX] = -0.55 * k; X[KLX] = 0.75 * k; X[HRX] = 0.35 * k; X[KRX] = 0.35 * k;
            X[SLX] = 0.5 * k; X[SRX] = 0.5 * k; X[SLZ] = 0.5 * k; X[SRZ] = -0.5 * k; X[ELX] = -0.4; X[ERX] = -0.4;
            X[NKX] = lerp(-0.3, 0.15, snap) * k;
          } else {
            const hop = hs.kind === 'jump' ? Math.sin(Math.PI * u) * 0.35 : 0.03 * Math.sin(Math.PI * u);
            X[BY] = hop;
            X[SPX] = lerp(lerp(-0.3, 0.3, snap) * (1 - hs.flick) + lerp(0.1, -0.35, snap) * hs.flick, 0.05, rec);
            X[NKX] = lerp(-0.25, nod, snap) * (1 - rec);
            X[SLZ] = 0.7; X[SRZ] = -0.7; X[SLX] = -0.6; X[SRX] = -0.6; X[ELX] = -1.1; X[ERX] = -1.1;
            if (hs.kind === 'jump') { X[KLX] = 0.6 * Math.sin(Math.PI * u); X[KRX] = 0.9 * Math.sin(Math.PI * u); X[HRX] = -0.4 * Math.sin(Math.PI * u); }
            else { X[KLX] = 0.25; X[KRX] = 0.25; X[HLX] = -0.15; X[HRX] = 0.1; }
            X[BRZ] = -0.25 * hs.turn * (1 - rec);
          }
          break;
        }
        case 'slide': {
          // Three beats timed to the simulation (contact window 0.1-0.42 s, 0.7 s in all):
          // the take-off drops the hips and throws the lead leg out; the glide rides on the
          // trailing hip with the lead boot raised through the ball, leaning back on one hand;
          // the stop sits up as the slide runs out of speed.
          const drop = ease(clamp01(t / 0.14));
          const swing = Math.sin(Math.PI * clamp01((t - 0.06) / 0.4)); // lead boot rises through contact
          const stop = ease(clamp01((t - 0.45) / 0.25));
          X[BY] = -0.8 * drop; X[BRZ] = 0.35 * drop * (1 - 0.4 * stop);
          X[SPX] = -0.8 * drop * (1 - 0.45 * stop) + 0.1 * (1 - drop);
          X[HRX] = -1.15 * drop - 0.35 * swing; X[HRZ] = 0; X[KRX] = 0.05 + 0.25 * (1 - drop) + 0.15 * stop;
          X[HLX] = 0.15 * drop; X[HLZ] = 0.25 * drop; X[KLX] = 0.6 + 1.3 * drop;
          X[SLX] = 0.4 + 0.75 * drop; X[SLZ] = 0.55 * drop; X[ELX] = -0.15; // hand back towards the grass
          X[SRX] = -0.35 * drop - 0.25 * swing; X[SRZ] = -0.75 * drop; X[ERX] = -0.5; // other arm out for balance
          X[NKX] = 0.45 * drop; // eyes on the ball while leaning back
          break;
        }
        case 'skill': {
          const s = Math.sin(Math.PI * clamp01(t / a.dur));
          if (a.skill === 'stepover') {
            // Right foot circles over the ball, body dips and sways to sell the feint.
            const side = a.side ?? 1;
            X[BRZ] = -0.22 * side * s; X[BY] = -0.08 * s; X[SPX] = 0.2;
            X[HRX] = -0.55 * s; X[HRZ] = 0.45 * side * s; X[KRX] = 0.6 * s;
            X[SLZ] = 0.5 + 0.3 * s; X[SRZ] = -0.5 - 0.3 * s;
          } else if (a.skill === 'roulette') {
            // Low and wide, arms out for balance; the sole rolls the ball as the body spins (the spin comes from facing).
            const side = a.side ?? 1;
            X[BY] = -0.12 * s; X[SPX] = 0.18 * s; X[BRZ] = 0.12 * side * s;
            X[HRX] = -0.3 * s; X[KRX] = 0.45 * s; X[HLX] = 0.2 * s; X[KLX] = 0.4 * s;
            X[SLZ] = 0.9 * s + 0.2; X[SRZ] = -0.9 * s - 0.2; X[ELX] = -0.3; X[ERX] = -0.3;
          } else if (a.skill === 'fakeshot') {
            // Shooting leg swings back as for a strike, then stops short and drags the ball across.
            const side = a.side ?? 1;
            const w = 0.3;
            X[HLX] = -0.15; X[KLX] = 0.3; X[SLZ] = 0.8; X[SRZ] = -0.35; X[SLX] = -0.3; X[SRX] = 0.4; X[BY] = -0.05;
            if (t < w) {
              const k = ease(clamp01(t / w));
              X[HRX] = lerp(0.1, 1.0, k); X[KRX] = lerp(0.2, 1.4, k); X[SPX] = 0.12;
            } else {
              const f = ease(clamp01((t - w) / 0.15));
              X[HRX] = lerp(1.0, -0.2, f); X[KRX] = lerp(1.4, 0.35, f); X[HRZ] = 0.35 * side * f; X[SPX] = 0.2; X[BRZ] = -0.15 * side * f;
            }
          } else if (a.skill === 'elastico') {
            // Outside of the foot pushes the ball out, then the ankle snaps it back the other way.
            const side = a.side ?? 1;
            const u = clamp01(t / a.dur);
            const out = Math.sin(Math.PI * clamp01(u / 0.45)), back = Math.sin(Math.PI * clamp01((u - 0.35) / 0.5));
            X[HRX] = -0.4 * s; X[KRX] = 0.35 * s; X[HRZ] = 0.5 * side * out - 0.45 * side * back;
            X[BRZ] = -0.18 * side * out + 0.22 * side * back; X[BY] = -0.07 * s; X[SPX] = 0.15 * s;
            X[SLZ] = 0.55 + 0.35 * s; X[SRZ] = -0.55 - 0.35 * s;
          } else if (a.skill === 'ballroll') {
            // Sole across the top of the ball, gliding sideways with the arms out.
            const side = a.side ?? 1;
            X[HRX] = -0.3 * s; X[KRX] = 0.3 * s; X[HRZ] = -0.35 * side * s; X[BRZ] = 0.12 * side * s;
            X[BY] = -0.06 * s; X[SPX] = 0.1; X[SLZ] = 0.6 + 0.3 * s; X[SRZ] = -0.6 - 0.3 * s; X[ELX] = -0.25; X[ERX] = -0.25;
          } else if (a.skill === 'dragturn') {
            // Drag-back and spin away: sole pulls the ball back, low, then turn with it.
            X[HRX] = -0.45 * s; X[KRX] = 0.35 * s; X[SPX] = -0.1 * s + 0.15 * clamp01(t / a.dur); X[BY] = -0.09 * s;
            X[SLZ] = 0.6; X[SRZ] = -0.6; X[BRZ] = 0.1 * (a.side ?? 1) * s;
          } else if (a.skill === 'dragback') {
            // Sole on the ball, rolling it back while the body turns.
            X[HRX] = -0.35 * s; X[KRX] = 0.25; X[SPX] = -0.15 * s; X[BY] = -0.05 * s;
            X[SLZ] = 0.45; X[SRZ] = -0.45;
          } else {
            // Knock-on: a long push with the outside of the foot, then away.
            X[HRX] = -0.8 * s; X[KRX] = 0.3; X[SPX] = 0.3; X[SLX] = 0.5; X[SRX] = -0.5;
          }
          break;
        }
        case 'celebrate': {
          X[SLX] = -2.7; X[SRX] = -2.7; X[SLZ] = 0.35; X[SRZ] = -0.35; X[ELX] = -0.2; X[ERX] = -0.2; X[SPX] = -0.1;
          break;
        }
      }
    }
    // Getting up after a fall once the simulation has let the player go.
    this.overlay = false;
    if (a.type === 'none' && this.fall) {
      target = 1;
      X.set(L);
      fallPose(X, this.fall.dir, this.fall.t);
      this.overlay = true;
    }
    // Goalkeeper handling: hands up to meet the ball, the catch itself, standing parries.
    this.gkLayer = false;
    if (keeper) target = this.keeperHands(p, dt, ballHeldByMe, ballPos, speed, prevType, target);
    else this.gkCatch = null;
    if (target === 0 && this.holding) target = 0;
    // Fast blend so actions read instantly but without pops.
    this.actW = lerp(this.actW, target, 1 - Math.exp(-dt * (target > this.actW ? 40 : 14)));
    const P = this.pose;
    const w = this.actW;
    for (let i = 0; i < CH; i++) P[i] = w > 0.001 ? lerp(L[i], X[i], w) : L[i];
    this.applyReaction(P, speed);
    this.apply();
    void ballPos;
  }

  /** Play a short gesture (first touch, dribbling touch, block, stagger). */
  play(g: Gesture) {
    this.gesture = g;
  }

  /** A foul on this player by someone at `from`: if the simulation knocks him down, he falls away from it. */
  onFouled(from: { x: number; z: number }) {
    this.fallFrom = { x: from.x, z: from.z, ttl: 0.4 };
  }

  /** Lying on the grass or getting up after a foul. */
  get falling() {
    return !!this.fall;
  }

  /** Choices made once when an action starts: tackle style, fall direction, kick style. */
  private actionStarted(p: ViewPlayer, ballPos: THREE.Vector3) {
    const a = p.action;
    if (a.type === 'tackle') this.tackleStyle = tackleStyleFor(p.facing, p.pos, ballPos, this.foe);
    if (a.type === 'stumble' && a.dur >= 0.85 && !this.gettingUp) {
      this.fall = { dir: fallDirFor(p.facing, p.pos, this.fallFrom), t: 0 };
      this.fallFrom = null;
    }
    if (a.type === 'kick') {
      this.kickRefined = false;
      const h = this.aimHint;
      const dx = h ? h.x - p.pos.x : Math.cos(p.facing), dz = h ? h.z - p.pos.z : Math.sin(p.facing);
      this.kickFlavour = this.pickFlavour(p, ballPos, relAngle(p.facing, dx, dz));
    }
  }

  private pickFlavour(p: ViewPlayer, ballPos: THREE.Vector3, angle: number) {
    const a = p.action;
    const gx = Math.sign(p.pos.x || 1) * PITCH_HALF;
    return kickFlavourFor({
      kind: a.kind, angle, strong: footProfile(p.def).foot === 1 ? 1 : -1,
      reach: Math.hypot(ballPos.x - p.pos.x, ballPos.z - p.pos.z), goalDist: Math.hypot(gx - p.pos.x, p.pos.z), ballY: ballPos.y,
      seed: (p.id * 7 + Math.floor(Math.abs(ballPos.x) * 13)) % 6,
    });
  }

  /** At the moment the ball leaves the boot its real direction is known: a backheel can only be a backheel then. */
  refineKick(p: ViewPlayer, ballPos: THREE.Vector3, bvx: number, bvz: number) {
    if (this.kickRefined || p.action.type !== 'kick') return;
    this.kickRefined = true;
    if (Math.hypot(bvx, bvz) < 2) return;
    const was = this.kickFlavour.flavour;
    const now = this.pickFlavour(p, ballPos, relAngle(p.facing, bvx, bvz));
    // Only switch to or from a backheel (the others read the same either way at the strike).
    if ((now.flavour === 'backheel') !== (was === 'backheel')) this.kickFlavour = now;
  }

  /** Where the ball sits while held overhead for a throw-in (and until it leaves the hands). */
  throwBallPos(out: THREE.Vector3, _dt: number): boolean {
    const a = this.lastAction;
    const throwing = !!a && a.type === 'throw' && !this.keeper;
    if (!this.holdThrow && !throwing) return false;
    this.root.updateMatrixWorld(true);
    const hands = new THREE.Vector3(0, 2.12, -0.1).applyMatrix4(this.root.matrixWorld);
    if (throwing) out.lerpVectors(hands, out, clamp01((a!.t - PLAYER.kickWindup) / 0.12));
    else out.copy(hands);
    return true;
  }
  // Goalkeeper handling state (see keeperHands).
  private gkCatch: { style: CatchStyle; t: number; side: number } | null = null;
  private gkAnt: { style: CatchStyle; k: number; t: number } | null = null;
  private parry: { t: number; y: number } | null = null;
  private freeBall = { y: 1, speed: 0 };
  private gkSpeed = 0;
  /** Set by the renderer each frame: the ball is loose or in flight from an opponent's touch (a keeper may take it). */
  ballFoe = false;
  /** Set by the realistic model while its skeleton-driven dive plays (a catch in a dive is part of the dive). */
  inDive = false;
  /** True while the keeper's handling layer drives the pose this frame. */
  gkLayer = false;
  /** The catch being played (null when none), for the realistic model and tests. */
  get catchStyle(): CatchStyle | null { return this.gkCatch?.style ?? null; }
  /** How far the hands have come up to meet an incoming ball (0..1), and for which catch. */
  get anticipation() { return this.gkAnt; }
  /** The keeper has pushed the ball away (match 'parry' event): palms out at the ball's height. */
  onParry(ballY: number) { if (this.keeper) this.parry = { t: 0, y: ballY }; }

  private keeperHands(p: ViewPlayer, dt: number, held: boolean, ballPos: THREE.Vector3, speed: number, prevType: string, target: number): number {
    const a = p.action;
    const X = this.act, L = this.loco;
    const side = this.id % 2 ? 1 : -1;
    const bv = this.ballVel;
    if (!held) { this.freeBall.y = ballPos.y; this.freeBall.speed = bv.length(); }
    const lastSpeed = this.gkSpeed;
    this.gkSpeed = speed;
    // The catch: from the ball in the gloves to holding it at the chest.
    if (a.type === 'catch' && prevType !== 'catch' && !this.inDive) {
      const recent = this.gkAnt && this.gkAnt.k > 0.3 && this.gkAnt.t < 0.25;
      const style = recent ? this.gkAnt!.style : catchStyleFor(this.freeBall.y, this.freeBall.speed, Math.max(speed, lastSpeed));
      this.gkCatch = { style, t: 0, side };
      this.parry = null;
    }
    this.gkAnt = this.gkAnt ? { ...this.gkAnt, t: this.gkAnt.t + dt } : null;
    const c = this.gkCatch;
    if (c) {
      c.t += dt;
      const u = c.t / CATCH_DUR[c.style];
      if (u >= 1 || (!held && a.type !== 'catch') || (a.type !== 'none' && a.type !== 'catch')) this.gkCatch = null;
      else {
        X.set(L);
        catchPose(X, c.style, u, c.side);
        this.gkLayer = true;
        return 1;
      }
    }
    // A standing parry.
    if (this.parry) {
      this.parry.t += dt;
      const u = this.parry.t / 0.4;
      if (u >= 1 || a.type === 'dive') this.parry = null;
      else {
        if (a.type === 'none') X.set(L);
        parryPose(X, this.parry.y, u, 1);
        this.gkLayer = true;
        return 1;
      }
    }
    // Hands up to meet a ball coming at the keeper: shaped for the catch it will be, timed to arrive with it.
    if (a.type === 'none' && !held && this.ballFoe) {
      const rx = ballPos.x - p.pos.x, rz = ballPos.z - p.pos.z;
      const v2 = bv.x * bv.x + bv.z * bv.z;
      if (v2 > 9) {
        const tA = -(rx * bv.x + rz * bv.z) / v2;
        const miss = Math.hypot(rx + bv.x * tA, rz + bv.z * tA);
        const y = Math.max(0.11, ballPos.y + bv.y * tA - 4.9 * tA * tA);
        if (tA > 0 && tA < 0.6 && miss < 0.75 && y < 2.75) {
          const style = catchStyleFor(y, Math.sqrt(v2), 0);
          const win = style === 'scoop' || style === 'kneel' ? 0.55 : 0.4;
          const k = clamp01(1 - (tA - 0.03) / win);
          if (k > 0) {
            X.set(L);
            anticipatePose(X, style, k, side);
            this.gkAnt = { style, k, t: 0 };
            this.gkLayer = true;
            return 1;
          }
        }
      }
    }
    return target;
  }
  private lastAction: ViewPlayer['action'] | null = null;
  private keeper = false;
  private prevHeader: unknown = null;
  /** Header style chosen at contact (exposed for RealPlayerModel). */
  get header() { return this.headerStyle; }
  private lastRoll = 1.3;
  /** After the whistle (render/reactions.ts): set each frame by the renderer, null when not reacting. */
  reaction: ReactionFrame | null = null;
  /** How much of the reaction shows (eases out when an action takes over). */
  reactW = 0;

  /** Blend a reaction over the arms, head and back (and the legs for a crouch, when standing). */
  private applyReaction(P: Float32Array, speed: number) {
    const r = this.reaction;
    this.reactW = r ? r.w * (1 - this.actW) * (this.holding ? 0 : 1) : 0;
    const w = this.reactW;
    if (!r || w < 0.001) return;
    for (const c of r.only ?? UPPER) P[c] = lerp(P[c], r.pose[c], w);
    if (r.full) {
      const wl = w * clamp01(1 - speed / 0.8);
      for (const c of LEGS) P[c] = lerp(P[c], r.pose[c], wl);
    }
  }

  private apply() {
    const P = this.pose;
    this.body.position.y = P[BY];
    this.body.rotation.z = P[BRZ];
    this.body.rotation.x = P[BRX];
    this.spine.rotation.x = P[SPX];
    this.hipL.rotation.set(P[HLX], 0, P[HLZ]);
    this.hipR.rotation.set(P[HRX], 0, P[HRZ]);
    this.knL.rotation.x = P[KLX];
    this.knR.rotation.x = P[KRX];
    this.shL.rotation.set(P[SLX], 0, P[SLZ]);
    this.shR.rotation.set(P[SRX], 0, P[SRZ]);
    this.elL.rotation.x = P[ELX];
    this.elR.rotation.x = P[ERX];
    this.neck.rotation.x = P[NKX];
  }
}
