// Animation pack of 20 Nov 2026 ("Build all the animations", after comparing the players with
// GOALS and the Football Game Maker showcase): overhead and scissor kicks, diving headers,
// hurdling a tackle, body feints and Berba / McGeady spins, backpedalling and side-stepping,
// shirt-pulls and hand-offs, keeper punches, fingertip, foot and star saves, the keeper organising
// his wall, an injured player's pose and limp, and the referee's and assistants' signals.
//
// Poses are written in the procedural solver's channels (player.ts), like motion.ts. Everything
// here is chosen from what the renderer already sees, so the simulation is untouched by it.

import { MC } from './motion';

const { BY, BRZ, SPX, HLX, HLZ, KLX, HRX, HRZ, KRX, SLX, SLZ, ELX, SRX, SRZ, ERX, NKX, BRX } = MC;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sm = (t: number) => { const c = clamp01(t); return c * c * (3 - 2 * c); };

// ---------------------------------------------------------------------------------------------
// Kicks in the air.

/** Special kicks struck off the ground: an overhead (bicycle) kick or a side-on scissor volley. */
export type AirKick = 'overhead' | 'scissor';

/**
 * Which air kick, if any, from the ball's height when the kick starts and where the ball goes
 * relative to the way the kicker faces (`angle`, radians, + to his left): a ball above the head
 * sent back over it is an overhead kick; a ball between knee and chest height struck off to the
 * side is a scissor volley. Anything else is an ordinary kick.
 */
export function airKickFor(ballY: number, angle: number): AirKick | null {
  const a = Math.abs(angle);
  if (ballY >= 1.3 && a > 1.9) return 'overhead';
  if (ballY >= 0.8 && ballY <= 1.75 && a > 0.85) return 'scissor';
  return null;
}

/**
 * Overhead kick, `t` seconds into the kick action (the ball is struck at `w`; a volley starts
 * there). The body is already laid back in the air, the standing leg thrown up first and the
 * kicking leg scissoring over the top through the ball, arms out to break the fall; the body comes
 * down onto the back (the fall carries on from there). Returns the body's forward shift (m) that
 * keeps the hips over the spot the jump was made from.
 */
export function overheadPose(X: Float32Array, t: number, w: number): number {
  const u = clamp01((t - w + 0.12) / 0.4);
  const snap = sm((t - w + 0.1) / 0.18);
  const tilt = lerp(-1.15, -1.45, u);
  X[BRX] = tilt; X[BRZ] = 0.12;
  X[BY] = lerp(0.62, 0.12, u * u);
  X[SPX] = 0.3; X[NKX] = 0.55;
  X[HRX] = lerp(-1.3, -2.75, snap); X[KRX] = lerp(1.25, 0.12, snap); X[HRZ] = -0.05;
  X[HLX] = lerp(-2.1, -0.35, snap); X[KLX] = lerp(0.35, 0.95, snap); X[HLZ] = 0.12;
  X[SLX] = -0.45; X[SRX] = -0.45; X[SLZ] = 1.25; X[SRZ] = -1.25; X[ELX] = -0.35; X[ERX] = -0.35;
  return 0.95 * Math.sin(-tilt) * 0.85;
}

/**
 * Scissor volley: the body leans right over to the side away from the kicking leg, hips up off the
 * ground, the far leg swept up and across through the ball, then down onto the side.
 * `side` is the side the body falls to (+1: the player's right).
 */
export function scissorPose(X: Float32Array, t: number, w: number, side: 1 | -1) {
  const u = clamp01((t - w + 0.12) / 0.4);
  const snap = sm((t - w + 0.08) / 0.18);
  X[BRZ] = lerp(0.85, 1.25, u) * side;
  X[BY] = lerp(0.4, 0.12, u * u);
  X[SPX] = 0.15; X[NKX] = 0.35;
  // The top leg (away from the fall) is the kicking leg.
  const kick = side > 0 ? [HLX, KLX, HLZ] : [HRX, KRX, HRZ];
  const stand = side > 0 ? [HRX, KRX, HRZ] : [HLX, KLX, HLZ];
  X[kick[0]] = lerp(-0.4, -1.65, snap); X[kick[1]] = lerp(1.0, 0.1, snap); X[kick[2]] = 0.25 * (side > 0 ? 1 : -1) * snap;
  X[stand[0]] = lerp(-1.4, -0.3, snap); X[stand[1]] = lerp(0.4, 0.8, snap); X[stand[2]] = 0;
  // Bottom arm reaching for the grass, top arm up and out for balance.
  if (side > 0) { X[SRX] = -0.6; X[SRZ] = -1.3; X[ERX] = -0.2; X[SLX] = -1.2; X[SLZ] = 0.9; X[ELX] = -0.5; }
  else { X[SLX] = -0.6; X[SLZ] = 1.3; X[ELX] = -0.2; X[SRX] = -1.2; X[SRZ] = -0.9; X[ERX] = -0.5; }
}

/**
 * Diving header, `u` 0..1 through the header action (which starts at contact): launched flat out
 * towards the ball, head up and neck braced, arms coming forward to break the landing, then down
 * onto the chest. Returns the body's forward shift (m) that keeps the head near the ball.
 */
export function divingHeaderPose(X: Float32Array, u: number): number {
  const land = sm((u - 0.3) / 0.6);
  X[BRX] = lerp(1.35, 1.45, land);
  X[BY] = lerp(0.5, -0.08, land);
  X[BRZ] = 0;
  X[SPX] = -0.15; X[NKX] = lerp(-0.85, -0.55, land);
  X[HLX] = 0.25; X[HRX] = 0.35; X[KLX] = lerp(0.35, 0.3, land); X[KRX] = lerp(0.55, 0.3, land); X[HLZ] = 0.1; X[HRZ] = -0.1;
  // Arms swept back for the header, then forward and bent under the shoulders for the landing.
  X[SLX] = lerp(0.6, -1.45, land); X[SRX] = lerp(0.6, -1.35, land);
  X[SLZ] = lerp(0.35, 0.75, land); X[SRZ] = lerp(-0.35, -0.75, land);
  X[ELX] = lerp(-0.2, -1.35, land); X[ERX] = lerp(-0.2, -1.45, land);
  return -0.65;
}

// ---------------------------------------------------------------------------------------------
// Skill moves (the simulation scripts the movement: match.ts stepSkill7).

/**
 * Body feint: shoulder dropped and the weight leant the wrong way for a beat, then the push off
 * that foot and away. Berba spin: the sole rolls the ball across, the player spins round on it,
 * arms out. McGeady spin: sole on top, pulled back as he spins half a turn, low.
 * `u` 0..1 through the move, `side` the side he breaks to (+1: his right).
 */
export function skill7Pose(X: Float32Array, move: 'bodyfeint' | 'berba' | 'mcgeady', u: number, side: number) {
  const s = Math.sin(Math.PI * u);
  if (move === 'bodyfeint') {
    const sell = Math.sin(Math.PI * clamp01(u / 0.5));
    const go = sm((u - 0.42) / 0.35);
    X[BRZ] = (0.32 * sell - 0.2 * go) * -side;
    X[SPX] = 0.18 + 0.12 * sell;
    X[BY] = -0.08 * sell;
    // Shoulder dropped towards the fake: that arm down and in, the other out.
    const dropL = side > 0;
    X[SLZ] = dropL ? 0.15 : 0.75 * sell + 0.3; X[SRZ] = dropL ? -(0.75 * sell + 0.3) : -0.15;
    X[SLX] = dropL ? 0.25 * sell : -0.3; X[SRX] = dropL ? -0.3 : 0.25 * sell;
    X[ELX] = -0.6; X[ERX] = -0.6;
    // Plant on the fake side, push off across.
    if (side > 0) { X[HLX] = -0.35 * sell; X[HLZ] = 0.35 * sell; X[KLX] = 0.55 * sell + 0.2; X[HRX] = -0.5 * go; X[KRX] = 0.4; }
    else { X[HRX] = -0.35 * sell; X[HRZ] = -0.35 * sell; X[KRX] = 0.55 * sell + 0.2; X[HLX] = -0.5 * go; X[KLX] = 0.4; }
    X[NKX] = 0.15;
    return;
  }
  if (move === 'berba') {
    // One foot rolls the ball across the body, then a low spin round it with the arms wide.
    const roll = Math.sin(Math.PI * clamp01(u / 0.4));
    X[BY] = -0.1 * s; X[SPX] = 0.2 * s;
    X[HRX] = -0.35 * roll; X[HRZ] = 0.45 * side * roll; X[KRX] = 0.35 + 0.2 * roll;
    X[HLX] = 0.2 * s; X[KLX] = 0.55 * s;
    X[SLZ] = 0.95 * s + 0.2; X[SRZ] = -0.95 * s - 0.2; X[ELX] = -0.25; X[ERX] = -0.25;
    X[BRZ] = 0.14 * side * s; X[NKX] = 0.3;
    return;
  }
  // McGeady: sole on top of the ball, pulled back under the body as he turns, low and wide.
  const drag = Math.sin(Math.PI * clamp01(u / 0.65));
  X[BY] = -0.12 * drag; X[SPX] = -0.1 * drag + 0.25 * sm((u - 0.6) / 0.3);
  X[HRX] = -0.55 * drag; X[KRX] = 0.5 * drag; X[HRZ] = 0.2 * side * drag;
  X[HLX] = 0.25 * drag; X[KLX] = 0.8 * drag;
  X[SLZ] = 0.75 * drag + 0.2; X[SRZ] = -0.75 * drag - 0.2; X[ELX] = -0.45; X[ERX] = -0.45;
  X[BRZ] = -0.15 * side * drag; X[NKX] = 0.35;
}

// ---------------------------------------------------------------------------------------------
// Moving backwards and sideways.

/**
 * How a player is moving relative to the way he faces: `back` 0..1 for backpedalling (moving
 * mostly away from where he looks), `side` 0..1 for side-stepping (moving across), and the sign
 * of the side-step (+1: to his right).
 */
export function moveDirFor(facing: number, vx: number, vz: number): { back: number; side: number; dir: 1 | -1 } {
  const sp = Math.hypot(vx, vz);
  if (sp < 0.45) return { back: 0, side: 0, dir: 1 };
  const fx = Math.cos(facing), fz = Math.sin(facing);
  const along = (vx * fx + vz * fz) / sp;
  const right = (vz * fx - vx * fz) / sp;
  const moving = sm((sp - 0.45) / 0.5);
  // Fast running is never a backpedal: a player at full speed turns and runs.
  const slow = 1 - sm((sp - 5.5) / 1.5);
  const back = sm((-along - 0.45) / 0.3) * moving * slow;
  const side = sm((Math.abs(right) - 0.82) / 0.12) * (1 - back) * moving * slow;
  return { back, side, dir: right >= 0 ? 1 : -1 };
}

/**
 * Backpedalling: short, quick steps pushing off the toes, the body a little forward over them so
 * he doesn't fall back, arms bent and low. `ph` is the gait phase, `r` speed 0..1.
 */
export function backpedalPose(X: Float32Array, ph: number, r: number) {
  const A = 0.22 + 0.3 * r;
  X[HLX] = -Math.sin(ph) * A * 0.6 + 0.12; X[HRX] = Math.sin(ph) * A * 0.6 + 0.12;
  // The leg reaching back lifts its foot; the knees stay soft.
  X[KLX] = 0.3 + 0.6 * Math.max(0, Math.cos(ph)) * (0.5 + r);
  X[KRX] = 0.3 + 0.6 * Math.max(0, -Math.cos(ph)) * (0.5 + r);
  X[HLZ] = 0.06; X[HRZ] = -0.06;
  X[SPX] = 0.2 + 0.08 * r; X[BY] = -0.05 - 0.02 * Math.abs(Math.cos(ph));
  X[SLX] = -0.35 + 0.18 * Math.sin(ph); X[SRX] = -0.35 - 0.18 * Math.sin(ph);
  X[SLZ] = 0.3; X[SRZ] = -0.3; X[ELX] = -1.15; X[ERX] = -1.15;
  X[NKX] = -0.05;
}

/**
 * Side-stepping: the lead leg opens out, the trailing one closes up to it (feet never cross),
 * knees bent, upright chest square to play, arms a little out. `dir` +1 moves to the right.
 */
export function sidestepPose(X: Float32Array, ph: number, r: number, dir: 1 | -1) {
  const open = Math.max(0, Math.sin(ph)), close = Math.max(0, -Math.sin(ph));
  const spread = 0.2 + 0.18 * r;
  // Lead leg (the side moved towards) abducts on the open beat; trailing leg follows on the close.
  const lead = dir > 0 ? HRZ : HLZ, trail = dir > 0 ? HLZ : HRZ;
  const leadSign = dir > 0 ? -1 : 1;
  X[lead] = leadSign * (0.08 + spread * open);
  X[trail] = -leadSign * (0.08 + spread * 0.4 * close);
  X[HLX] = -0.18; X[HRX] = -0.18;
  X[KLX] = 0.45 + 0.25 * (dir > 0 ? close : open); X[KRX] = 0.45 + 0.25 * (dir > 0 ? open : close);
  X[BY] = -0.08 + 0.025 * Math.abs(Math.sin(ph));
  X[SPX] = 0.12; X[BRZ] = 0.04 * dir * open;
  X[SLX] = -0.25; X[SRX] = -0.25; X[SLZ] = 0.4; X[SRZ] = -0.4; X[ELX] = -0.75; X[ERX] = -0.75;
}

// ---------------------------------------------------------------------------------------------
// Injured.

/**
 * An injured player down on the grass: on his back, knees drawn up, both hands on the shin
 * he's holding, rocking. With `sit` 0..1 he sits up as the physio treats him.
 */
export function injuredPose(X: Float32Array, time: number, sit: number) {
  const rock = Math.sin(time * 2.6) * (1 - sit);
  X.fill(0);
  X[BRX] = lerp(-1.42, -0.55, sit) + 0.05 * rock;
  X[BY] = lerp(-0.08, -0.55, sit);
  X[BRZ] = 0.18 * rock;
  X[SPX] = lerp(0.55, 0.45, sit);
  X[HLX] = lerp(-1.25, -0.4, sit) + 0.08 * rock; X[KLX] = lerp(1.9, 0.3, sit);
  X[HRX] = lerp(-0.6, -0.25, sit); X[KRX] = lerp(0.9, 0.2, sit);
  X[HLZ] = 0.12; X[HRZ] = -0.12;
  X[SLX] = lerp(-1.05, -0.55, sit); X[SRX] = lerp(-1.05, -0.4, sit);
  X[SLZ] = 0.2; X[SRZ] = -0.2; X[ELX] = lerp(-0.55, -0.35, sit); X[ERX] = lerp(-0.55, -0.3, sit);
  X[NKX] = lerp(0.6, 0.3, sit);
}

/** Limping: the hurt (left) leg stiff and short, the body dropping onto the good leg, an arm out. */
export function limpPose(X: Float32Array, ph: number, k: number) {
  const step = Math.sin(ph);
  X[KLX] = lerp(X[KLX], 0.08, k);
  X[HLX] = lerp(X[HLX], -0.2 * step, k);
  X[BRZ] = lerp(X[BRZ], -0.1 * Math.max(0, -step), k);
  X[BY] = lerp(X[BY], -0.05 * Math.max(0, -step), k);
  X[SPX] = lerp(X[SPX], 0.16, k);
  X[SLX] = lerp(X[SLX], -0.15, k); X[SLZ] = lerp(X[SLZ], 0.28, k); X[ELX] = lerp(X[ELX], -0.4, k);
  X[NKX] = lerp(X[NKX], 0.25, k);
}

// ---------------------------------------------------------------------------------------------
// Goalkeeper saves (keeperpose.ts has the catches and the throws).

/** Punching a high ball clear with both fists, `u` 0..1. */
export function punchPose(X: Float32Array, ballY: number, u: number) {
  const k = Math.sin(Math.PI * clamp01(u / 0.7));
  const up = clamp01((ballY - 1.6) / 0.9);
  const jump = Math.sin(Math.PI * clamp01(u)) * up;
  X[BY] = 0.32 * jump;
  X[SLX] = lerp(-1.4, -2.9, up) * k + -0.8 * (1 - k); X[SRX] = X[SLX];
  X[SLZ] = 0.05; X[SRZ] = -0.05; X[ELX] = lerp(-1.6, -0.05, k); X[ERX] = X[ELX];
  X[SPX] = -0.12 * up; X[NKX] = -0.45 * up;
  X[HLX] = -0.6 * jump; X[KLX] = 1.0 * jump; X[HRX] = -0.15 * jump; X[KRX] = 0.25 * jump;
}

/** Saves a keeper makes without the full dive (realplayer applyDive plays the rest). */
export type QuickSave = 'star' | 'foot';

/**
 * A star block (up close, the keeper spreads himself big: arms and legs wide, jumping a little at
 * the shot) or a foot save (a low ball just out of the hands' reach: the near leg kicks out to it).
 * `dist` is how far the ball is when the dive starts, `lat` the save point's sideways distance and
 * `ty` its height.
 */
export function quickSaveFor(dist: number, lat: number, ty: number): QuickSave | null {
  if (dist < 8.5 && lat < 1.6 && ty < 1.7) return 'star';
  if (ty < 0.35 && lat > 0.3 && lat < 1.25 && dist < 16) return 'foot';
  return null;
}

/** Pose for a star block or foot save, `t` s into the dive; `side` +1 is the keeper's left. */
export function quickSavePose(X: Float32Array, kind: QuickSave, t: number, side: number) {
  const k = sm(t / 0.16);
  if (kind === 'star') {
    const hop = Math.sin(Math.PI * clamp01(t / 0.55)) * 0.12;
    X[BY] = hop - 0.04; X[SPX] = 0.08; X[NKX] = -0.1;
    X[SLX] = -1.55 * k; X[SRX] = -1.55 * k; X[SLZ] = 1.1 * k; X[SRZ] = -1.1 * k; X[ELX] = -0.1; X[ERX] = -0.1;
    X[HLZ] = 0.55 * k; X[HRZ] = -0.55 * k; X[HLX] = -0.1; X[HRX] = -0.1; X[KLX] = 0.15; X[KRX] = 0.15;
    return;
  }
  // Foot save: the near leg shoots out low along the grass to the ball while the body drops and
  // leans away from it over the folded far leg (checked on the realistic bodies, 20 Nov 2026).
  X[BRZ] = 0.4 * side * k; X[BY] = -0.3 * k; X[SPX] = 0.15;
  const near = side > 0 ? [HRX, HRZ, KRX] : [HLX, HLZ, KLX];
  const far = side > 0 ? [HLX, HLZ, KLX] : [HRX, HRZ, KRX];
  X[near[0]] = -0.25 * k; X[near[1]] = -0.85 * side * k; X[near[2]] = 0.05;
  X[far[0]] = -0.5 * k; X[far[1]] = 0.15 * side * k; X[far[2]] = 1.45 * k;
  X[SLX] = -0.9 * k; X[SRX] = -0.9 * k; X[SLZ] = 0.9; X[SRZ] = -0.9; X[ELX] = -0.3; X[ERX] = -0.3;
  X[NKX] = 0.2;
}
