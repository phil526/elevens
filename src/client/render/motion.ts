// Player movement detail (19 Nov 2026, "Add 10 player animation improvements"). Everything here
// is drawn from what the renderer already sees (positions, velocities, actions, match events), so
// the simulation, online play and AI v AI results are untouched.
//
// - Short "gestures" layered over running: first touches (chest, thigh, cushioned, flicked),
//   dribbling touches and big touches into space, body blocks, getting up after a fall.
// - Choosers for tackle styles, falls, kick styles (toe pokes, outside of the boot, backheels)
//   and how tired a player looks.
// - Plant/brake detection for sharp turns, acceleration and stopping.
// - A two-bone leg solver that keeps planted feet still on the grass.
//
// Poses are written in the procedural solver's channels (player.ts). The channel numbers are
// repeated here because player.ts imports this file; tests/motion.test.ts checks they match.

import * as THREE from 'three';

export const MC = { BY: 0, BRZ: 1, SPX: 2, HLX: 3, HLZ: 4, KLX: 5, HRX: 6, HRZ: 7, KRX: 8, SLX: 9, SLZ: 10, ELX: 11, SRX: 12, SRZ: 13, ERX: 14, NKX: 15, BRX: 16 } as const;
const { BY, BRZ, SPX, HLX, HLZ, KLX, HRX, HRZ, KRX, SLX, SLZ, ELX, SRX, SRZ, ERX, NKX, BRX } = MC;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sm = (t: number) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
/** Rises over `a` (share of the time), holds, falls over the last `b`. */
const env = (u: number, a: number, b: number) => sm(u / a) * (1 - sm((u - (1 - b)) / b));

// ---------------------------------------------------------------------------------------------
// Gestures: short, render-only overlays.

export type GestureKind =
  | 'chest' | 'thigh' | 'cushion' | 'flick' // first touches
  | 'touch' | 'push' // dribbling: a running touch, a big touch into space
  | 'block' // body thrown in the way of a shot or pass
  | 'stagger'; // knocked off balance but still on the feet (a foul with advantage)

export const GESTURE_DUR: Record<GestureKind, number> = { chest: 0.6, thigh: 0.48, cushion: 0.36, flick: 0.34, touch: 0.22, push: 0.34, block: 0.6, stagger: 0.55 };

export interface Gesture {
  kind: GestureKind;
  t: number;
  dur: number;
  /** +1: right foot / to the right, -1: left. */
  side: 1 | -1;
  /** Strength 0..1. */
  k: number;
}

export function makeGesture(kind: GestureKind, side: 1 | -1, k = 1): Gesture {
  return { kind, t: 0, dur: GESTURE_DUR[kind], side, k };
}

/** Which parts of the body a gesture moves: the touching leg only, the upper body, or everything. */
export type GestureParts = 'leg' | 'legArms' | 'upper' | 'all';
export function gestureParts(kind: GestureKind, speed: number): GestureParts {
  if (kind === 'touch' || kind === 'push' || kind === 'cushion' || kind === 'flick') return speed > 1.5 ? 'leg' : 'legArms';
  if (kind === 'thigh') return 'legArms';
  if (kind === 'chest' || kind === 'block' || kind === 'stagger') return speed > 2 ? 'upper' : 'all';
  return 'all';
}

/** Set one leg's hip (forward/back, out) and knee; `side` +1 is the right leg. */
function leg(X: Float32Array, side: 1 | -1, hipX: number, hipOut: number, knee: number, w = 1) {
  if (side > 0) { X[HRX] = lerp(X[HRX], hipX, w); X[HRZ] = lerp(X[HRZ], -hipOut, w); X[KRX] = lerp(X[KRX], knee, w); }
  else { X[HLX] = lerp(X[HLX], hipX, w); X[HLZ] = lerp(X[HLZ], hipOut, w); X[KLX] = lerp(X[KLX], knee, w); }
}
/** Both arms out for balance: forward/back, out from the body, elbow bend. */
function arms(X: Float32Array, fwd: number, out: number, elbow: number, w = 1) {
  X[SLX] = lerp(X[SLX], fwd, w); X[SRX] = lerp(X[SRX], fwd, w);
  X[SLZ] = lerp(X[SLZ], out, w); X[SRZ] = lerp(X[SRZ], -out, w);
  X[ELX] = lerp(X[ELX], elbow, w); X[ERX] = lerp(X[ERX], elbow, w);
}

/**
 * Write a gesture's full pose over X (X already holds the pose underneath: running, standing) and
 * return how strongly it shows this frame (0..1); the caller blends by that weight.
 */
export function gesturePose(X: Float32Array, g: Gesture): number {
  const u = clamp01(g.t / g.dur);
  const s = g.side, k = g.k;
  const o = (-s) as 1 | -1;
  switch (g.kind) {
    case 'chest': {
      // Chest out to meet a dropping ball, arms wide, eyes down onto it; then let it drop to the feet.
      X[SPX] = -0.32; X[NKX] = 0.38;
      arms(X, -0.12, 1.05, -0.3);
      X[BY] = -0.05; X[KLX] = 0.3; X[KRX] = 0.3; X[HLX] = -0.1; X[HRX] = -0.1;
      return env(u, 0.25, 0.4) * k;
    }
    case 'thigh': {
      // Thigh raised to cushion a ball at waist height, knee bent, the standing leg a little soft.
      leg(X, s, -1.05, 0.08, 1.15);
      leg(X, o, -0.05, 0.05, 0.22);
      X[SPX] = 0.18; X[NKX] = 0.32;
      arms(X, -0.25, 0.55, -0.55);
      return env(u, 0.3, 0.4) * k;
    }
    case 'cushion': {
      // Inside of the foot meets the ball and gives with it: the leg reaches forward, then draws back.
      const give = sm((u - 0.25) / 0.4);
      leg(X, s, lerp(-0.42, -0.12, give), 0.22, lerp(0.35, 0.55, give));
      X[SPX] = 0.16; X[NKX] = 0.28;
      arms(X, -0.1, 0.38, -0.45);
      return env(u, 0.3, 0.5) * k;
    }
    case 'flick': {
      // Outside-of-the-foot flick: the boot reaches across the ball, then snaps out to the side.
      const snap = sm((u - 0.2) / 0.3);
      leg(X, s, -0.45, lerp(-0.18, 0.38, snap), 0.4);
      X[BRZ] = -0.08 * s * snap; X[SPX] = 0.12; X[NKX] = 0.25;
      arms(X, -0.1, 0.42, -0.5);
      return env(u, 0.25, 0.45) * k;
    }
    case 'touch': {
      // A running touch: the swinging boot reaches down to the ball and pushes it on with the laces.
      leg(X, s, -0.55, 0.06, 0.25);
      return env(u, 0.35, 0.55) * k * 0.75;
    }
    case 'push': {
      // Big touch into space: a long reach with the swinging leg, the body driving after it.
      leg(X, s, -0.85, 0.05, 0.2);
      X[SPX] += 0.08;
      return env(u, 0.3, 0.5) * k * 0.85;
    }
    case 'block': {
      // In the way of a shot: a stretched leg, chest square, arms tucked behind the back (no handball).
      leg(X, s, -0.25, 0.7, 0.15);
      leg(X, o, -0.2, 0.05, 0.55);
      X[BY] = -0.1; X[SPX] = 0.2; X[BRZ] = -0.12 * s;
      X[SLX] = 0.55; X[SRX] = 0.55; X[SLZ] = 0.12; X[SRZ] = -0.12; X[ELX] = -0.5; X[ERX] = -0.5;
      X[NKX] = 0.1;
      return env(u, 0.18, 0.45) * k;
    }
    case 'stagger': {
      // Knocked off balance but stays up: lurch away from the contact, a quick catching step, arms out.
      const lurch = Math.sin(Math.PI * clamp01(u / 0.6));
      X[BRZ] = 0.22 * s * lurch; X[SPX] = 0.3 * lurch;
      leg(X, s, -0.35 * lurch, 0.3 * lurch, 0.5);
      arms(X, -0.6, 0.85 * lurch + 0.2, -0.4);
      return env(u, 0.15, 0.5) * k;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// First touches.

/**
 * How a player takes a pass, from the ball's height and speed just before it reached him, and how
 * far his first touch turned it: chest (a dropping ball above the waist), thigh (waist height),
 * flicked (a ground ball knocked off sharply to the side with the outside of the boot) or
 * cushioned (everything else on the ground).
 */
export function firstTouchFor(ballY: number, turn: number): GestureKind {
  if (ballY > 1.12) return 'chest';
  if (ballY > 0.5) return 'thigh';
  return Math.abs(turn) > 0.8 ? 'flick' : 'cushion';
}

// ---------------------------------------------------------------------------------------------
// Tackles.

export type TackleStyle = 'poke' | 'block' | 'shoulder';

/**
 * Standing tackles by where the ball and its carrier are when the tackle starts (tackler facing
 * `facing`): a carrier running alongside gets a shoulder-to-shoulder challenge, a ball out of
 * easy reach a stretching toe poke, and a carrier coming head-on a planted block tackle.
 * Returns the side (+1: to the tackler's right) too.
 */
export function tackleStyleFor(facing: number, me: { x: number; z: number }, ball: { x: number; z: number }, carrier: { x: number; z: number; vx: number; vz: number } | null): { style: TackleStyle; side: 1 | -1 } {
  const fx = Math.cos(facing), fz = Math.sin(facing);
  const dx = ball.x - me.x, dz = ball.z - me.z;
  const ahead = dx * fx + dz * fz;
  const right = dz * fx - dx * fz; // + to my right
  const side: 1 | -1 = right >= 0 ? 1 : -1;
  if (carrier) {
    const cx = carrier.x - me.x, cz = carrier.z - me.z;
    const cRight = cz * fx - cx * fz, cAhead = cx * fx + cz * fz;
    const csp = Math.hypot(carrier.vx, carrier.vz);
    const same = csp > 1.5 ? (carrier.vx * fx + carrier.vz * fz) / csp : 0;
    if (Math.abs(cRight) > 0.45 && Math.abs(cAhead) < 1.0 && same > 0.4) return { style: 'shoulder', side: cRight >= 0 ? 1 : -1 };
  }
  if (Math.hypot(dx, dz) > 1.05 || ahead > 0.95) return { style: 'poke', side };
  return { style: 'block', side };
}

/** A standing tackle's pose by style; `t` is the action's time, `dur` its length. */
export function tacklePose(X: Float32Array, style: TackleStyle, side: 1 | -1, t: number, dur: number) {
  const reach = sm(t / 0.2);
  const back = sm((t - Math.max(0.3, dur - 0.18)) / 0.18); // recovering as the action ends
  const k = reach * (1 - back * 0.7);
  const s = side;
  if (style === 'poke') {
    // Stretch: the standing knee folds, the tackling leg goes out long and low for the ball.
    X[BY] = -0.26 * k; X[SPX] = 0.42 * k; X[BRZ] = 0.1 * s * k;
    leg(X, s, -1.3 * k, 0.15 * k, 0.05, 1);
    leg(X, (-s) as 1 | -1, 0.3 * k, 0.05, 1.15 * k, 1);
    X[SLX] = 0.35 * k; X[SRX] = 0.35 * k; X[SLZ] = 0.55 * k + 0.1; X[SRZ] = -0.55 * k - 0.1; X[ELX] = -0.35; X[ERX] = -0.35;
    X[NKX] = 0.35 * k;
  } else if (style === 'block') {
    // Block tackle: square on, weight down, the inside of the boot planted across the ball.
    X[BY] = -0.16 * k; X[SPX] = 0.32 * k;
    leg(X, s, -0.65 * k, 0.32 * k, 0.35, 1);
    leg(X, (-s) as 1 | -1, 0.15 * k, 0.08, 0.75 * k, 1);
    X[SLX] = -0.15; X[SRX] = -0.15; X[SLZ] = 0.75 * k; X[SRZ] = -0.75 * k; X[ELX] = -0.5; X[ERX] = -0.5;
    X[NKX] = 0.3 * k;
  } else {
    // Shoulder to shoulder: lean the near shoulder into the carrier, near arm tucked, far leg reaching across.
    X[BRZ] = 0.28 * s * k; X[SPX] = 0.25 * k; X[BY] = -0.1 * k;
    leg(X, (-s) as 1 | -1, -0.75 * k, -0.2 * k, 0.35, 1);
    leg(X, s, 0.2 * k, 0.15 * k, 0.55 * k, 1);
    // Near arm in against the body, far arm out for balance.
    if (s > 0) { X[SRX] = -0.1; X[SRZ] = -0.08; X[ERX] = -1.2 * k; X[SLX] = -0.4; X[SLZ] = 0.7 * k; X[ELX] = -0.6; }
    else { X[SLX] = -0.1; X[SLZ] = 0.08; X[ELX] = -1.2 * k; X[SRX] = -0.4; X[SRZ] = -0.7 * k; X[ERX] = -0.6; }
    X[NKX] = 0.2 * k;
  }
}

// ---------------------------------------------------------------------------------------------
// Falls.

/** A fouled player goes down this way: forward (from behind or a trip) or onto his side. */
export type FallDir = 'forward' | 'left' | 'right';
export function fallDirFor(facing: number, me: { x: number; z: number }, from: { x: number; z: number } | null): FallDir {
  if (!from) return 'forward';
  const fx = Math.cos(facing), fz = Math.sin(facing);
  const dx = me.x - from.x, dz = me.z - from.z; // push direction
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) return 'forward';
  const along = (dx * fx + dz * fz) / d, right = (dz * fx - dx * fz) / d;
  if (Math.abs(right) > 0.75 && along < 0.4) return right > 0 ? 'right' : 'left';
  return 'forward';
}

/** Seconds a fouled player stays down after he lands (before getting up), and the get-up itself. */
export const FALL = { stagger: 0.12, drop: 0.3, lie: 0.65, rise: 1.05 } as const;
export const FALL_TOTAL = FALL.stagger + FALL.drop + FALL.lie + FALL.rise;

/**
 * Pose for a fall from a foul and getting back up, `t` seconds after the contact. The simulation
 * only holds the player for 0.9 s, so the renderer plays the rest (lying, getting up) itself.
 */
export function fallPose(X: Float32Array, dir: FallDir, t: number) {
  const t1 = FALL.stagger, t2 = t1 + FALL.drop, t3 = t2 + FALL.lie;
  const buckle = sm(t / t1);
  const drop = sm((t - t1) / FALL.drop);
  const down = 1 - sm((t - t3) / (FALL.rise * 0.4)); // still lying
  const rise = clamp01((t - t3) / FALL.rise);
  X.fill(0);
  if (dir === 'forward') {
    // Knees go, the body pitches forward onto the hands and chest.
    const ly = drop * down;
    X[BRX] = 1.42 * ly; X[BY] = -0.1 * ly - 0.12 * buckle * (1 - drop);
    X[SPX] = 0.25 * buckle * (1 - drop) - 0.08 * ly;
    X[HLX] = -0.25 * buckle * (1 - drop) + 0.05 * ly; X[HRX] = 0.1 * ly; X[KLX] = 0.6 * buckle * (1 - drop) + 0.35 * ly; X[KRX] = 0.25 * ly;
    // Arms come forward to break the fall, then lie bent under the shoulders, elbows out.
    X[SLX] = lerp(-0.9 * buckle, -1.45, ly); X[SRX] = lerp(-0.8 * buckle, -1.35, ly);
    X[SLZ] = lerp(0.4, 0.75, ly); X[SRZ] = lerp(-0.4, -0.75, ly);
    X[ELX] = lerp(-0.3, -1.35, ly); X[ERX] = lerp(-0.3, -1.45, ly);
    X[NKX] = -0.55 * ly; // head up off the grass
  } else {
    // Onto the side: hip and shoulder take it, knees drawn up.
    const sd = dir === 'right' ? 1 : -1;
    const ly = drop * down;
    X[BRZ] = 1.35 * sd * ly; X[BY] = 0.14 * ly - 0.12 * buckle * (1 - drop);
    X[SPX] = 0.2 * buckle * (1 - drop) + 0.35 * ly;
    X[HLX] = -0.7 * ly; X[HRX] = -0.5 * ly; X[KLX] = 1.1 * ly + 0.5 * buckle * (1 - drop); X[KRX] = 1.0 * ly;
    X[SLX] = -0.9 * ly - 0.6 * buckle * (1 - drop); X[SRX] = -1.1 * ly - 0.6 * buckle * (1 - drop);
    X[SLZ] = 0.35; X[SRZ] = -0.35; X[ELX] = -1.3 * ly; X[ERX] = -1.3 * ly;
    X[NKX] = 0.3 * ly;
  }
  if (rise > 0) {
    // Getting up: onto hands and knees, up onto one knee, then stand.
    const a = sm(rise / 0.35), b = sm((rise - 0.3) / 0.35), c = sm((rise - 0.62) / 0.38);
    const kneel = new Float32Array(17);
    // Hands and knees.
    kneel[BRX] = 0.95; kneel[BY] = -0.42; kneel[SPX] = 0.25; kneel[HLX] = -0.35; kneel[HRX] = -0.35; kneel[KLX] = 1.75; kneel[KRX] = 1.75;
    kneel[SLX] = -1.45; kneel[SRX] = -1.45; kneel[SLZ] = 0.15; kneel[SRZ] = -0.15; kneel[ELX] = -0.1; kneel[ERX] = -0.1; kneel[NKX] = -0.5;
    const oneKnee = new Float32Array(17);
    // Up on the right knee, left foot planted in front, a hand on the left knee.
    oneKnee[BY] = -0.5; oneKnee[SPX] = 0.35; oneKnee[HLX] = -1.45; oneKnee[KLX] = 1.6; oneKnee[HRX] = 0.25; oneKnee[KRX] = 1.75;
    oneKnee[SLX] = -0.85; oneKnee[SLZ] = 0.2; oneKnee[ELX] = -0.6; oneKnee[SRX] = -0.2; oneKnee[SRZ] = -0.25; oneKnee[ERX] = -0.4; oneKnee[NKX] = 0.05;
    const stand = new Float32Array(17);
    stand[SPX] = 0.1; stand[KLX] = 0.1; stand[KRX] = 0.1; stand[SLZ] = 0.12; stand[SRZ] = -0.12; stand[ELX] = -0.25; stand[ERX] = -0.25;
    for (let i = 0; i < 17; i++) {
      let v = lerp(X[i], kneel[i], a);
      v = lerp(v, oneKnee[i], b);
      X[i] = lerp(v, stand[i], c);
    }
    // A fall to the side rolls over onto the front first.
    if (dir !== 'forward') X[BRZ] = X[BRZ] * (1 - a);
  }
}

// ---------------------------------------------------------------------------------------------
// Kick styles.

export type KickFlavour = 'toe' | 'outside' | 'backheel';

/**
 * Toe pokes, outside-of-the-boot passes and backheels, from where the kick goes relative to the
 * way the kicker faces. `angle` is the kick direction relative to the facing (radians, + to the
 * player's left), `foot` the kicking foot (+1 right), `reach` the ball's distance from the
 * kicker when the kick starts, `goalDist` the distance to the goal for shots.
 */
export function kickFlavourFor(o: { kind?: string; angle: number; strong: 1 | -1; reach: number; goalDist?: number; ballY: number; seed: number }): { flavour: KickFlavour | null; foot?: 1 | -1 } {
  const k = o.kind;
  if (o.ballY > 0.45) return { flavour: null };
  const ground = k === 'pass' || k === 'through' || k === 'shot';
  if (ground && Math.abs(o.angle) > 2.15 && (k !== 'shot' || (o.goalDist ?? 99) < 16)) return { flavour: 'backheel', foot: o.strong };
  // Outside of the strong foot for a ball played off to that side (a right-footer passing right).
  const toStrong = -o.angle * o.strong;
  if ((k === 'pass' || k === 'through' || k === 'cross') && toStrong > 0.55 && toStrong < 2.0 && (toStrong > 0.85 || o.seed % 2 === 0)) return { flavour: 'outside', foot: o.strong };
  // The ball usually runs a stride ahead when a kick starts (1.5 m is common): only a real stretch is a poke.
  if (k === 'shot' && (o.reach > 1.9 || ((o.goalDist ?? 99) < 9 && o.seed % 3 === 0))) return { flavour: 'toe' };
  if ((k === 'pass' || k === 'through') && o.reach > 2.1) return { flavour: 'toe' };
  return { flavour: null };
}

/** Signed angle (radians, + to the left) from facing `f` to direction (dx, dz). */
export function relAngle(f: number, dx: number, dz: number) {
  const a = Math.atan2(dz, dx) - f;
  return -Math.atan2(Math.sin(a), Math.cos(a));
}

// ---------------------------------------------------------------------------------------------
// Tiredness.

/**
 * How tired a player looks (0 fresh .. 1 exhausted): stamina left (sprints drain it, and late in
 * the match fatigue stops it recovering).
 */
export function tirednessFor(stamina: number) {
  return sm((0.92 - stamina) / 0.4);
}

/** Bent over with hands on knees, or standing with the head down and arms loose, breathing hard. */
export function restPose(X: Float32Array, kind: 'knees' | 'breathe', time: number, tired: number) {
  const breath = Math.sin(time * (2.2 + 1.6 * tired)) * (0.03 + 0.03 * tired);
  X.fill(0);
  if (kind === 'knees') {
    X[SPX] = 1.1 + breath; X[NKX] = -0.75; X[BY] = -0.07;
    X[HLX] = -0.3; X[HRX] = -0.3; X[KLX] = 0.4; X[KRX] = 0.4; X[HLZ] = 0.07; X[HRZ] = -0.07;
    // Arms straight down from the bent-over shoulders onto the front of the knees.
    X[SLX] = -1.2; X[SRX] = -1.2; X[SLZ] = 0.2; X[SRZ] = -0.2; X[ELX] = -0.15; X[ERX] = -0.15;
  } else {
    // Upright but spent: chest heaving, head down, arms hanging loose.
    X[SPX] = 0.22 + breath; X[NKX] = 0.35 + breath * 0.5;
    X[HLZ] = 0.07; X[HRZ] = -0.07; X[KLX] = 0.12; X[KRX] = 0.12;
    X[SLX] = -0.18; X[SRX] = -0.18; X[SLZ] = 0.12; X[SRZ] = -0.12; X[ELX] = -0.2; X[ERX] = -0.2;
  }
}

// ---------------------------------------------------------------------------------------------
// Turning, speeding up and stopping.

/**
 * Follows a player's ground velocity to spot sharp cuts (plant a foot and lean into the new
 * direction) and how hard he is speeding up or braking.
 */
export class GaitTracker {
  private dir: number | null = null;
  private lastSpeed = 0;
  /** Smoothed acceleration along the run (m/s², + speeding up). */
  acc = 0;
  /** The current plant: which way the cut goes (+1 to the player's left), how sharp, and its clock. */
  cut: { side: 1 | -1; k: number; t: number } | null = null;
  private cool = 0;
  static readonly CUT_DUR = 0.34;

  update(vx: number, vz: number, dt: number) {
    if (dt <= 0) return;
    const sp = Math.hypot(vx, vz);
    const rawAcc = (sp - this.lastSpeed) / dt;
    this.lastSpeed = sp;
    this.acc += (Math.max(-14, Math.min(14, rawAcc)) - this.acc) * (1 - Math.exp(-dt * 7));
    this.cool = Math.max(0, this.cool - dt);
    if (this.cut) { this.cut.t += dt; if (this.cut.t >= GaitTracker.CUT_DUR) this.cut = null; }
    if (sp < 1.2) { if (sp < 0.3) this.dir = null; return; }
    const d = Math.atan2(vz, vx);
    if (this.dir === null) { this.dir = d; return; }
    const dd = Math.atan2(Math.sin(d - this.dir), Math.cos(d - this.dir));
    // The reference direction trails the velocity, so a quick change of direction shows as a big gap.
    this.dir += dd * (1 - Math.exp(-dt * 6));
    if (!this.cut && this.cool <= 0 && sp > 2.4 && Math.abs(dd) > 0.55) {
      this.cut = { side: dd > 0 ? -1 : 1, k: clamp01((Math.abs(dd) - 0.4) / 0.9) * clamp01((sp - 1.8) / 3), t: 0 };
      this.cool = 0.45;
      this.dir = d - Math.sign(dd) * 0.1;
    }
  }

  /** Plant weight now (0..1): quick in, slower out. */
  get plant() {
    if (!this.cut) return 0;
    const u = this.cut.t / GaitTracker.CUT_DUR;
    return this.cut.k * sm(u / 0.25) * (1 - sm((u - 0.45) / 0.55));
  }
}

// ---------------------------------------------------------------------------------------------
// Two-bone leg solver.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();

/**
 * Bend a hip-knee-ankle chain so the ankle reaches `target` (world space), keeping the knee in the
 * plane it already bends in (`pole` is used when the leg is straight). The foot keeps its world
 * orientation, so a planted boot stays flat. Returns false when the target can't be reached.
 */
export function solveLeg(thigh: THREE.Object3D, shin: THREE.Object3D, foot: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): boolean {
  const H = thigh.getWorldPosition(new THREE.Vector3());
  const K = shin.getWorldPosition(new THREE.Vector3());
  const A = foot.getWorldPosition(new THREE.Vector3());
  const footQ = foot.getWorldQuaternion(new THREE.Quaternion());
  const la = H.distanceTo(K), lb = K.distanceTo(A);
  const want = H.distanceTo(target);
  if (want > (la + lb) * 0.999 || want < Math.abs(la - lb) + 1e-3) return false;
  // Knee: rotate the shin about the bend axis so hip-to-ankle is the wanted length.
  const u = _a.subVectors(H, K), v = _b.subVectors(A, K);
  _n.crossVectors(v, u);
  if (_n.lengthSq() < 1e-10) _n.copy(pole);
  _n.normalize();
  const cur = u.angleTo(v);
  const cosD = (la * la + lb * lb - want * want) / (2 * la * lb);
  const des = Math.acos(Math.max(-1, Math.min(1, cosD)));
  const rotKnee = _qa.setFromAxisAngle(_n, cur - des);
  const shinW = shin.getWorldQuaternion(_qb);
  shinW.premultiply(rotKnee);
  setWorldQuat(shin, shinW);
  // Thigh: swing the whole leg so the ankle lands on the target.
  const A2 = _c.copy(v).applyQuaternion(rotKnee).add(K);
  const from = A2.sub(H).normalize(), to = _a.subVectors(target, H).normalize();
  const swing = _qc.setFromUnitVectors(from, to);
  const thighW = thigh.getWorldQuaternion(_qb);
  thighW.premultiply(swing);
  setWorldQuat(thigh, thighW);
  // Keep the boot's orientation.
  setWorldQuat(foot, footQ);
  return true;
}

const _pq = new THREE.Quaternion();
function setWorldQuat(o: THREE.Object3D, q: THREE.Quaternion) {
  const p = o.parent!;
  p.updateWorldMatrix(true, false);
  p.getWorldQuaternion(_pq);
  o.quaternion.copy(_pq.invert().multiply(q));
  o.updateMatrixWorld(true);
}
