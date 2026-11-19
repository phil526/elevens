// Passing and shooting: receiver selection (DESIGN §7 "Passing") and the
// solvers that turn an intention into a ball velocity, including errors from
// attributes, pressure, sprinting, distance and body orientation.

import { BALL, MATCH, PITCH, PLAYER } from './config';
import { flyTo, landingPoint } from './ball';
import { angleOf, clamp, dist, norm, pointSegment, wrapAngle } from './math';
import type { Rng } from './rng';
import { footProfile } from './teams';
import { accelOf, effectiveSprint, sprintTop } from './movement';
import type { KickKind, Player, V2, V3 } from './types';

export interface ReceiverChoice {
  receiver: number; // -1 => into space
  target: V2; // aim point on the ground
}

const PREF: Record<'pass' | 'through' | 'lob', { min: number; max: number; hard: number }> = {
  pass: { min: 5, max: 26, hard: 42 },
  through: { min: 10, max: 38, hard: 50 },
  lob: { min: 14, max: 55, hard: 70 },
};

export const MAX_PASS_ANGLE = (70 * Math.PI) / 180;
/** Semi pass assistance only looks for teammates close to where the stick points. */
export const SEMI_PASS_ANGLE = (28 * Math.PI) / 180;

/** How blocked a ground lane is. Opponents further along the lane have more time to step in. */
export function laneBlock(from: V2, to: V2, opponents: Player[]): number {
  let block = 0;
  const L = dist(from, to);
  for (const o of opponents) {
    // Where the opponent will be shortly, not just where they stand.
    const q = { x: o.pos.x + o.vel.x * 0.3, z: o.pos.z + o.vel.z * 0.3 };
    const { d, t } = pointSegment(q, from, to);
    const r = 1.3 + 0.08 * t * L;
    if (t > 0 && t < 0.98 && d < r) block += (r - d) / r;
  }
  return block;
}

export function pressureOn(p: Player, players: Player[]): number {
  let near = 99;
  for (const o of players) if (o.team !== p.team && !o.off) near = Math.min(near, dist(o.pos, p.pos));
  return clamp((4 - near) / 3, 0, 1);
}

/**
 * Choose the intended receiver. Teammates are scored by the angle from the
 * input direction (never beyond 70°, so no passes behind the intended
 * direction), distance against the pass type's preferred range, lane clearance
 * for ground passes and forward movement for through balls. If no teammate
 * qualifies, the ball goes into space along the input direction.
 */
export interface SelectOptions {
  /** Human charge 0..1: a tap looks for the near teammate in the lane, a full charge the far one. */
  power?: number;
  driven?: boolean; // firm ground pass: longer range, harder to cut out
  lofted?: boolean; // lofted through ball: over the top, so lanes don't matter
  cone?: number; // widest angle off the stick a teammate may be (Semi pass assistance narrows it)
  help?: number; // a human's pass: prefer the open teammate more strongly (humanHelp.laneWeight)
  runner?: boolean; // a person's through ball: the teammate the stick points at, favouring forward runs (19 Nov 2026)
}

/** Preferred ranges of a driven ground pass. */
const DRIVEN = { min: 8, max: 34, hard: 48 };

/** Distance a charged pass looks for: from just short of the type's minimum to past its maximum. */
export function wantedDistance(kind: 'pass' | 'through' | 'lob', power: number, driven = false) {
  const pref = driven ? DRIVEN : PREF[kind];
  return pref.min - 2 + clamp(power, 0, 1) * (pref.max - pref.min + 6);
}

export function selectReceiver(players: Player[], passer: Player, dirX: number, dirZ: number, kind: 'pass' | 'through' | 'lob', attackDir: number, opt: SelectOptions = {}): ReceiverChoice {
  let u = norm(dirX, dirZ);
  if (u.x === 0 && u.z === 0) u = { x: Math.cos(passer.facing), z: Math.sin(passer.facing) };
  const pref = opt.driven && kind === 'pass' ? DRIVEN : PREF[kind];
  const want = opt.power === undefined ? -1 : wantedDistance(kind, opt.power, opt.driven && kind === 'pass');
  const opponents = players.filter((o) => o.team !== passer.team && !o.off);
  const runner = kind === 'through' && !!opt.runner && !opt.lofted;
  let best = -1, bestScore = -Infinity;
  for (const t of players) {
    if (t.team !== passer.team || t.id === passer.id || t.off) continue;
    if (t.role === 'GK' && kind !== 'pass') continue;
    const lead = kind === 'through' ? 1.0 : 0.4;
    const P = { x: t.pos.x + t.vel.x * lead, z: t.pos.z + t.vel.z * lead };
    const vx = P.x - passer.pos.x, vz = P.z - passer.pos.z;
    const d = Math.hypot(vx, vz);
    if (d < 3 || d > pref.hard) continue;
    let ang = Math.abs(wrapAngle(angleOf(vx, vz) - angleOf(u.x, u.z)));
    // A person's through ball: the stick points at the runner they can see (where he is now, or just ahead of him).
    if (runner) ang = Math.min(ang, Math.abs(wrapAngle(angleOf(t.pos.x - passer.pos.x, t.pos.z - passer.pos.z) - angleOf(u.x, u.z))));
    if (ang > (opt.cone ?? MAX_PASS_ANGLE)) continue;
    let s = Math.cos(ang) * 2.2 - (runner ? 1.2 * ang : 0);
    if (want >= 0) {
      // Charged pass: the hold length says how far away the intended teammate is (only a hint for a through ball to a runner).
      s -= Math.min(Math.abs(d - want), 15) / (runner ? 25 : 10);
    } else {
      if (d < pref.min) s -= (pref.min - d) / 6;
      if (d > pref.max) s -= (d - pref.max) / 10;
    }
    // The stride plan (throughPlan) finds its own way round defenders, so the lane counts less for a runner.
    if (kind !== 'lob' && !opt.lofted) s -= laneBlock(passer.pos, P, opponents) * (opt.driven ? 0.6 : 0.9) * humanHelp.laneWeight(opt.help) * (runner ? 0.4 : 1);
    if (kind === 'through') {
      const fwd = (t.vel.x * attackDir) / 8;
      s += runner ? clamp((t.vel.x * attackDir) / 5, -0.4, 1.2) : clamp(fwd, -0.3, 0.6);
    }
    if (t.role === 'GK') s -= 0.8;
    if (s > bestScore) { bestScore = s; best = t.id; }
  }
  if (best >= 0) {
    const r = players[best];
    return { receiver: best, target: leadTarget(passer, r, kind, attackDir) };
  }
  let reach = kind === 'pass' ? 14 : kind === 'through' ? 22 : 30;
  if (opt.power !== undefined) reach *= 0.5 + 0.8 * clamp(opt.power, 0, 1);
  return { receiver: -1, target: clampToPitch({ x: passer.pos.x + u.x * reach, z: passer.pos.z + u.z * reach }) };
}

export function clampToPitch(p: V2, margin = 1): V2 {
  return { x: clamp(p.x, -PITCH.halfLength + margin, PITCH.halfLength - margin), z: clamp(p.z, -PITCH.halfWidth + margin, PITCH.halfWidth - margin) };
}

/** Aim point for a pass to receiver r, leading moving receivers (through balls into their run). */
const LEAD_CAP = 0.7; // seconds of receiver movement a normal pass leads
const RUN_LEAD_CAP = 1.1; // ...and for a receiver already running forward at pace (a pass into their stride)
export function leadTarget(passer: Player, r: Player, kind: KickKind, attackDir: number): V2 {
  let T = { ...r.pos };
  const avg = kind === 'lob' || kind === 'cross' ? 17 : kind === 'through' ? 10 : 11;
  const forwardRun = r.vel.x * attackDir > 3.5;
  for (let i = 0; i < 2; i++) {
    // Lead runners fully only with through balls: other receivers often stop or turn to meet the ball.
    const t = Math.min(dist(passer.pos, T) / avg + 0.12, kind === 'through' ? 9 : forwardRun ? RUN_LEAD_CAP : LEAD_CAP);
    T = { x: r.pos.x + r.vel.x * t, z: r.pos.z + r.vel.z * t };
  }
  if (kind === 'through') {
    const sp = Math.hypot(r.vel.x, r.vel.z);
    const run = sp > 1.5 ? norm(r.vel.x, r.vel.z) : { x: attackDir, z: 0 };
    T.x += run.x * 3.5;
    T.z += run.z * 3.5;
  }
  return clampToPitch(T, 1.5);
}

/**
 * A human's through ball into a runner's stride (19 Nov 2026, "it should pass in front of a running
 * team mate"): instead of aiming a fixed lead ahead and hitting it at a set pace, find the point on
 * the runner's line where he and the ball arrive together, with the ball rolling slower than he runs
 * so he collects it without breaking stride, inside the pitch and as far from the defenders as it
 * can be. `arrive` is the ball's speed there (for solveGroundPass) and `t` the seconds until then.
 */
export interface StridePlan { point: V2; arrive: number; t: number; run: V2; margin: number }
export const STRIDE = { minT: 0.6, maxT: 4.6, react: 0.25, gkReach: 1.8, maxV0: 23, vaOver: -0.5, tPen: 0.4, ahead: 0.3, vaSoft: 4, pursuit: 0.7 };
export function throughPlan(players: Player[], passer: Player, r: Player, ballPos: V2, attackDir: number): StridePlan | null {
  const sp = Math.hypot(r.vel.x, r.vel.z);
  // His line: the way he is running, or straight at goal if he is standing still or going backwards.
  let run = sp > 2 && r.vel.x * attackDir > -0.5 ? norm(r.vel.x, r.vel.z) : norm(attackDir, -r.pos.z * 0.015);
  // A run straight at the byline bends in towards goal (a winger's run would otherwise take the ball out).
  if (Math.abs(r.pos.x) > PITCH.halfLength - 22) run = norm(run.x, run.z - r.pos.z * 0.02);
  // ...and one towards the touchline straightens down the line.
  if (Math.abs(r.pos.z) > PITCH.halfWidth - 14 && run.z * r.pos.z > 0) run = norm(run.x, run.z * 0.25);
  const v0r = Math.max(0, r.vel.x * run.x + r.vel.z * run.z);
  const top = effectiveSprint(r.a, r.stamina);
  const acc = accelOf(r.a);
  const tUp = Math.max(0, (top - v0r) / acc);
  const runDist = (t: number) => (t < tUp ? v0r * t + 0.5 * acc * t * t : v0r * tUp + 0.5 * acc * tUp * tUp + top * (t - tUp));
  const opponents = players.filter((o) => o.team !== r.team && !o.off);
  const a = BALL.rollDecel;
  let best: StridePlan | null = null, bestScore = -Infinity;
  for (let t = STRIDE.minT; t <= STRIDE.maxT + 1e-6; t += 0.1) {
    const s = runDist(t);
    const C = { x: r.pos.x + run.x * s, z: r.pos.z + run.z * s };
    // Room to take it: not on the lines, where a ball he just misses runs out of play.
    if (Math.abs(C.x) > PITCH.halfLength - 5 || Math.abs(C.z) > PITCH.halfWidth - 3.5) break;
    // The ball gets there a moment before him, so it is just ahead of his stride.
    const tb = t - STRIDE.ahead;
    const D = dist(ballPos, C);
    const v0 = D / tb + (a * tb) / 2, va = D / tb - (a * tb) / 2;
    // Still rolling, but no quicker than he runs, so he closes on it rather than chasing it.
    const ub = norm(C.x - ballPos.x, C.z - ballPos.z);
    const runSp = Math.max(v0r, Math.min(top, v0r + acc * t));
    if (va < 1.5 || va > Math.max(3, runSp + STRIDE.vaOver) || v0 > STRIDE.maxV0) continue;
    // Who else gets to the ball first: anywhere along its path before it reaches him, or at the
    // meeting point itself (a keeper also has his hands there).
    let margin = 9;
    for (const o of opponents) {
      const top = sprintTop(o.a);
      const toC = Math.max(0, dist(o.pos, C) - (o.role === 'GK' ? STRIDE.gkReach : 0.8)) / top + STRIDE.react;
      margin = Math.min(margin, toC - t);
      for (let k = 1; k <= 8; k++) {
        const tk = (tb * k) / 9, sk = v0 * tk - 0.5 * a * tk * tk;
        const P = { x: ballPos.x + ub.x * sk, z: ballPos.z + ub.z * sk };
        const to = Math.max(0, dist(o.pos, P) - 0.7) / top + STRIDE.react;
        margin = Math.min(margin, to - tk);
      }
    }
    const lane = laneBlock(ballPos, C, opponents);
    // A ball much quicker than his run gets away from him; a long one gives defenders time.
    const quick = Math.max(0, va - STRIDE.vaSoft);
    // Where it stops if he misses it: better still on the pitch.
    const stop = (va * va) / (2 * a);
    const E = { x: C.x + ub.x * stop * 0.6, z: C.z + ub.z * stop * 0.6 };
    const runsOut = Math.abs(E.x) > PITCH.halfLength || Math.abs(E.z) > PITCH.halfWidth ? 0.5 : 0;
    const score = Math.min(margin, 1.0) - 0.25 * lane - 0.25 * quick - runsOut - STRIDE.tPen * t + 0.004 * (C.x - r.pos.x) * attackDir;
    if (score > bestScore) { bestScore = score; best = { point: C, arrive: va, t, run, margin }; }
  }
  return best;
}

export interface KickContext {
  kicker: Player;
  ballPos: V3;
  pressure: number;
  rng: Rng;
  accuracy?: number; // set-piece timing: multiplies every error (1 = normal, lower is better)
  firstTime?: boolean; // struck on the first touch, without settling the ball
  help?: number; // a human's kick: the opposing level's help (0..1), see humanHelp
}

/**
 * How much a human's kick is helped (18 Nov 2026, "too hard to score and pass"): passes and
 * crosses lose up to half their aim error and arrive up to 15% firmer, shots lose up to a third
 * of their spread and can be charged further before they fly over. Zero for the AI.
 */
export const humanHelp = {
  passError: (h = 0) => 1 - 0.5 * h,
  passPace: (h = 0) => 1 + 0.15 * h,
  shotError: (h = 0) => 1 - 0.35 * h,
  /** Charge above which a shot starts to lose accuracy and rise (0.8 for the AI). */
  overhit: (h = 0) => 0.8 + 0.1 * h,
  /** Extra weight on lane clearance when Assisted passing picks the receiver. */
  laneWeight: (h = 0) => 1 + 0.8 * h,
} as const;

/**
 * How hard the situation makes a pass, as a multiplier on its error: pressure from the nearest
 * opponent, the kicker's speed, playing across or behind the body, the weaker foot and a
 * first-time strike all add up, while a simple short pass with time and the body open stays clean.
 */
export function passDifficulty(ctx: KickContext, dx: number, dz: number, d: number): number {
  const { kicker } = ctx;
  const body = bodyPenalty(kicker, dx, dz);
  const speedFrac = clamp(Math.hypot(kicker.vel.x, kicker.vel.z) / 9, 0, 1);
  const weak = weakFootUsed(kicker, ctx.ballPos, dx, dz) ? 1 - footProfile(kicker.def).weak : 0;
  let k = (1 + 1.25 * ctx.pressure) * (1 + 0.35 * speedFrac * speedFrac + (kicker.sprinting ? 0.25 : 0)) * (1 + 1.6 * body) * (1 + 0.9 * weak);
  if (ctx.firstTime) k *= 1.35 - 0.3 * kicker.a.control;
  if (d < 16 && ctx.pressure < 0.15 && body < 0.05 && !kicker.sprinting) k *= 0.7; // a simple pass with time on the ball
  return k;
}

/**
 * Set-piece timing ring: shrinks to a point and grows again every MATCH.timingPeriod seconds
 * after the taker is ready. 0 = smallest (perfect timing), 1 = widest.
 */
export function timingRing(readyT: number): number {
  return Math.abs(Math.cos((Math.PI * readyT) / MATCH.timingPeriod));
}

/** Error multiplier for a set piece struck at ring size q: 0.45 when perfect, 2.05 at its widest. */
export const timingAccuracy = (q: number) => 0.45 + 1.6 * clamp(q, 0, 1);

export interface KickResult {
  vel: V3;
  spin: number;
  dip?: number; // topspin (free kicks with dip)
}

function bodyPenalty(kicker: Player, dx: number, dz: number) {
  const ang = Math.abs(wrapAngle(angleOf(dx, dz) - kicker.facing));
  return clamp((ang - 0.6) / 1.6, 0, 1);
}

function rotate(x: number, z: number, a: number): V2 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - z * s, z: x * s + z * c };
}

/** Ground pass that arrives at `target` with a sensible arrival speed. */
export function solveGroundPass(ctx: KickContext, target: V2, kind: 'pass' | 'through' | 'throw', driven = false, arrive?: number): KickResult {
  const { kicker, ballPos, rng } = ctx;
  const dx = target.x - ballPos.x, dz = target.z - ballPos.z;
  const d = Math.max(1, Math.hypot(dx, dz));
  const passing = kicker.a.passing;
  const sigma = (0.01 + 0.085 * (1 - passing)) * passDifficulty(ctx, dx, dz, d) * (1 + d / 60) * (driven ? 1.15 : 1) * (ctx.accuracy ?? 1) * humanHelp.passError(ctx.help);
  const dir = rotate(dx / d, dz / d, rng.gauss() * sigma);
  // Through balls are weighted to die into the runner's path; others arrive firmly; driven passes zip.
  const va0 = (kind === 'through' ? 4 + d * 0.12 : driven ? 10 + d * 0.3 : 6.5 + d * 0.25) * (kind === 'through' ? 1 : humanHelp.passPace(ctx.help));
  // A through ball into a runner's stride (throughPlan) says how fast it should be rolling when he gets there.
  const va = arrive ?? va0;
  let v0 = Math.sqrt(va * va + 2 * BALL.rollDecel * d);
  v0 *= 1 + rng.gauss() * (0.02 + 0.07 * (1 - passing)) * (0.7 + 0.3 * passDifficulty(ctx, dx, dz, d));
  if (kind !== 'through') v0 *= 1 + 0.06 * (ctx.help ?? 0); // a human's pass is a touch firmer, so harder to cut out
  v0 = clamp(v0, 5, kind === 'throw' ? 14 : driven ? 30 : 24);
  return { vel: { x: dir.x * v0, y: 0, z: dir.z * v0 }, spin: 0 };
}

/** Lofted pass/cross/clearance/long throw landing near `target`. */
export function solveLob(ctx: KickContext, target: V2, kind: 'lob' | 'cross' | 'clear' | 'throw' | 'dropkick' | 'punt' | 'shortthrow' | 'longthrow' | 'linethrow'): KickResult {
  const { kicker, ballPos, rng } = ctx;
  const dx = target.x - ballPos.x, dz = target.z - ballPos.z;
  const d = Math.max(2, Math.hypot(dx, dz));
  const passing = kicker.a.passing;
  const sigma = (0.014 + 0.095 * (1 - passing)) * passDifficulty(ctx, dx, dz, d) * (1 + d / 70) * (ctx.accuracy ?? 1) * humanHelp.passError(ctx.help);
  const dir = rotate(dx / d, dz / d, rng.gauss() * sigma);
  const distErr = 1 + rng.gauss() * (0.03 + 0.07 * (1 - passing)) * (1 + 0.6 * ctx.pressure) * (ctx.accuracy ?? 1) * humanHelp.passError(ctx.help);
  const want = d * distErr;
  // Throws: a short one is flat (to feet), a long one loops high, one down the line drops into the runner's stride.
  let T = kind === 'cross' ? 1.0 + d * 0.022 : kind === 'throw' ? 0.55 + d * 0.035 : kind === 'shortthrow' ? 0.45 + d * 0.028 : kind === 'longthrow' ? 0.85 + d * 0.036 : kind === 'linethrow' ? 0.6 + d * 0.03
    : kind === 'dropkick' ? 0.75 + d * 0.017 : kind === 'punt' ? 1.4 + d * 0.024 : 0.8 + d * 0.028;
  T = clamp(T, kind === 'shortthrow' ? 0.5 : 0.7, kind === 'punt' ? 3.2 : 2.5);
  let vy = (BALL.gravity * T) / 2;
  let vh = want / T;
  for (let i = 0; i < 4; i++) {
    const r = flyTo(vh, vy, ballPos.y);
    if (r.dist < 0.5) break;
    vh *= want / r.dist;
  }
  vh = Math.min(vh, kind === 'punt' || kind === 'dropkick' ? 33 : 30);
  return { vel: { x: dir.x * vh, y: vy, z: dir.z * vh }, spin: 0 };
}

/**
 * Crosses. Floated: a high, hanging ball that drops onto the target (good for big headers, but
 * the keeper has time to come for it). Whipped: struck fast and flat, curling away from the
 * keeper into the gap in front of goal, still at head height as it passes the target.
 */
export function solveCross(ctx: KickContext, target: V2, style: 'floated' | 'whipped', attackDir: number): KickResult {
  if (style === 'floated') {
    const r = solveLob(ctx, target, 'cross');
    // Same landing point, more hang: slow the ball and launch it higher.
    const d = Math.max(2, dist(ctx.ballPos, target));
    const T = clamp(1.3 + d * 0.026, 1.4, 2.9);
    const sp = Math.hypot(r.vel.x, r.vel.z);
    let vy = (BALL.gravity * T) / 2;
    let vh = d / T;
    for (let i = 0; i < 4; i++) {
      const f = flyTo(vh, vy, ctx.ballPos.y);
      if (Math.abs(f.dist - d) < 0.4) break;
      vh *= d / f.dist;
    }
    const k = Math.min(vh, 26) / Math.max(1e-6, sp);
    return { vel: { x: r.vel.x * k, y: vy, z: r.vel.z * k }, spin: 0 };
  }
  // Whipped: aim to land a few metres past the target so the ball is still head high there.
  const { kicker, ballPos, rng } = ctx;
  const dx0 = target.x - ballPos.x, dz0 = target.z - ballPos.z;
  const d0 = Math.max(2, Math.hypot(dx0, dz0));
  const u = { x: dx0 / d0, z: dz0 / d0 };
  const land = { x: target.x + u.x * 4.5, z: target.z + u.z * 4.5 };
  const d = d0 + 4.5;
  const passing = kicker.a.passing;
  const sigma = (0.02 + 0.07 * (1 - passing)) * passDifficulty(ctx, dx0, dz0, d0) * (1 + d / 60) * (ctx.accuracy ?? 1) * 1.1 * humanHelp.passError(ctx.help);
  const T = clamp(0.85 + d * 0.016, 0.95, 1.6);
  let vy = (BALL.gravity * T) / 2;
  let vh = d / T;
  for (let i = 0; i < 4; i++) {
    const f = flyTo(vh, vy, ballPos.y);
    if (Math.abs(f.dist - d) < 0.4) break;
    vh *= d / f.dist;
  }
  vh = Math.min(vh, 31);
  // Curl back away from the goal line (away from the keeper, towards the attackers).
  const spin = (attackDir * Math.sign(u.z || 1)) * 4.5;
  let ang = angleOf(land.x - ballPos.x, land.z - ballPos.z);
  for (let i = 0; i < 3; i++) {
    const L = landingPoint(ballPos, { x: Math.cos(ang) * vh, y: vy, z: Math.sin(ang) * vh }, spin);
    const err = wrapAngle(angleOf(land.x - ballPos.x, land.z - ballPos.z) - angleOf(L.x - ballPos.x, L.z - ballPos.z));
    ang += err;
    if (Math.abs(err) < 0.004) break;
  }
  ang += rng.gauss() * sigma;
  const dErr = 1 + rng.gauss() * (0.03 + 0.06 * (1 - passing)) * (1 + 0.6 * ctx.pressure) * (ctx.accuracy ?? 1);
  return { vel: { x: Math.cos(ang) * vh * dErr, y: vy, z: Math.sin(ang) * vh * dErr }, spin };
}

/**
 * Where a cross should be aimed at receiver r: whipped and low crosses go into the corridor
 * between the six-yard box and the penalty spot, leading the runner; floated crosses drop onto
 * the receiver (a step further on if they are moving).
 */
export function crossTarget(passer: Player, r: Player, style: 'floated' | 'whipped' | 'lowcross', attackDir: number): V2 {
  const T = leadTarget(passer, r, style === 'floated' ? 'cross' : 'through', attackDir);
  if (style === 'floated') return T;
  const gx = attackDir * PITCH.halfLength;
  // Into the corridor: 5-11 m out from goal, inside the width of the six-yard box (and a bit).
  const out = clamp(Math.abs(gx - T.x), 5, 11);
  return { x: gx - attackDir * out, z: clamp(T.z, -7.5, 7.5) };
}

/** True when a player is in a crossing position: wide in the final third (early crosses from a bit deeper). */
export function inCrossZone(p: V2, attackDir: number, early = false): boolean {
  const fx = p.x * attackDir;
  return early ? fx > 16 && Math.abs(p.z) > 10 : fx > 24 && Math.abs(p.z) > 12;
}

export interface ShotAim {
  side: 1 | -1; // goal being attacked: +1 => x = +52.5
  aimZ: number; // lateral aim inside the goal
  power: number; // 0..1
  placed: boolean;
  header?: boolean;
  clear?: { d: number; h: number }; // a wall at distance d that the ball must pass above height h
  /**
   * Chipped over the keeper, driven low and hard, curled (finesse, also `placed`), struck with
   * everything (power), or side-footed into the corner (placed).
   */
  style?: 'chip' | 'low' | 'finesse' | 'power' | 'placed';
  curve?: number; // free kick: bend chosen by the taker (-1..1, + curls to the right of travel, seen from behind)
  dip?: number; // free kick: dip chosen by the taker (0..1)
}

/**
 * Shot types (19 Nov 2026). Finesse: curled, a touch slower, tighter. Power: much harder and
 * flatter, but wilder unless the striker is a good finisher. Placed: side-footed, slow and very
 * accurate, kept low to mid height. Free kicks: bend and dip as the taker sets them.
 */
export const SHOT_STYLE = {
  finesse: { speed: 0.84, spread: 0.72, curl: 8 },
  power: { base: 16, per: 22, spread: 1.2, spreadPoor: 0.45, lift: 1.05, overhit: 0.06 },
  placed: { base: 11, per: 13, spread: 0.5, vspread: 0.6 },
  freekick: { curl: 10, dip: 9 },
} as const;

/**
 * Manual shooting: where the stick points is where the ball goes, carried on to the goal line
 * (it can miss the target). With the stick at rest, straight ahead of the shooter.
 */
export function manualShotAim(shooter: Player, side: 1 | -1, mx: number, mz: number): number {
  const m = Math.hypot(mx, mz);
  const u = m > 0.3 ? { x: mx / m, z: mz / m } : { x: Math.cos(shooter.facing), z: Math.sin(shooter.facing) };
  const gx = side * PITCH.halfLength;
  const dx = gx - shooter.pos.x;
  // Pointing sideways or backwards: the widest it can go.
  if (u.x * side < 0.15) return clamp(shooter.pos.z + Math.sign(u.z || 1) * 30, -9, 9);
  return clamp(shooter.pos.z + (u.z / u.x) * dx, -9, 9);
}

/**
 * Whether a strike is on the kicker's weaker foot. The natural foot is the one on the side the
 * ball sits, and opening the body to hit across the other way calls for the other foot: a
 * right-footer with the ball on their left, or shooting well to their right, uses the left.
 */
export function weakFootUsed(kicker: Player, ballPos: V2, dx: number, dz: number): boolean {
  const fx = Math.cos(kicker.facing), fz = Math.sin(kicker.facing);
  const ballLeft = (ballPos.x - kicker.pos.x) * fz - (ballPos.z - kicker.pos.z) * fx;
  const d = Math.max(1e-6, Math.hypot(dx, dz));
  const shotRight = -(dx * fz - dz * fx) / d;
  const leftFootScore = ballLeft * 3 + shotRight;
  return footProfile(kicker.def).foot === 1 ? leftFootScore > 0.45 : leftFootScore < -0.45;
}

/** Map the input direction to a lateral aim point in the goal (assisted). */
export function aimFromInput(shooter: Player, side: 1 | -1, mx: number, mz: number): number {
  const m = Math.hypot(mx, mz);
  if (m > 0.3 && Math.abs(mz / m) > 0.25) return clamp((mz / m) * 3.4, -3.15, 3.15);
  // No lateral input: assisted aim towards the far post.
  const far = shooter.pos.z > 0 ? -1 : 1;
  return Math.abs(shooter.pos.z) < 2 ? 0 : far * 2.1;
}

export function solveShot(ctx: KickContext, aim: ShotAim): KickResult {
  const { kicker, ballPos, rng } = ctx;
  const gx = aim.side * PITCH.halfLength;
  const dx = gx - ballPos.x, dz = aim.aimZ - ballPos.z;
  const d = Math.max(1, Math.hypot(dx, dz));
  const shooting = kicker.a.shooting;
  const p = clamp(aim.power, 0, 1);
  const speedFrac = clamp(Math.hypot(kicker.vel.x, kicker.vel.z) / 9, 0, 1);
  const body = bodyPenalty(kicker, dx, dz);
  const over = humanHelp.overhit(ctx.help);
  const powerPen = 1 + Math.max(0, p - over) * 2.5;
  const power = aim.style === 'power' && !aim.header, placedStyle = aim.style === 'placed' && !aim.header;
  const finesse = (aim.placed || aim.style === 'finesse') && !aim.header && !power && !placedStyle;
  let sigmaH = (0.011 + 0.08 * (1 - shooting)) * (1 + d / 25) * (1 + 0.8 * ctx.pressure) * (1 + 0.4 * speedFrac) * (1 + 1.8 * body) * (power ? 1 + Math.max(0, p - over - SHOT_STYLE.power.overhit) * 2.5 : powerPen);
  if (finesse) sigmaH *= SHOT_STYLE.finesse.spread;
  if (power) sigmaH *= SHOT_STYLE.power.spread + SHOT_STYLE.power.spreadPoor * (1 - shooting);
  if (placedStyle) sigmaH *= SHOT_STYLE.placed.spread;
  if (aim.header) sigmaH *= 1.6;
  // Weaker foot: up to 10% less power and a wider spread, by the player's weak-foot rating.
  const weak = !aim.header && weakFootUsed(kicker, ballPos, dx, dz);
  const wf = weak ? 1 - footProfile(kicker.def).weak : 0;
  sigmaH *= (1 + 1.6 * wf) * (ctx.accuracy ?? 1) * humanHelp.shotError(ctx.help);
  if (aim.style === 'chip' && !aim.header) return solveChip(ctx, aim, d, dx, dz, sigmaH * 1.2, wf);
  let speed = (13 + 21 * p) * (0.8 + 0.22 * shooting) * (1 - 0.1 * wf);
  if (aim.style === 'low') speed = (15 + 17 * p) * (0.8 + 0.22 * shooting) * (1 - 0.1 * wf);
  if (power) speed = (SHOT_STYLE.power.base + SHOT_STYLE.power.per * p) * (0.8 + 0.22 * shooting) * (1 - 0.1 * wf);
  if (placedStyle) speed = (SHOT_STYLE.placed.base + SHOT_STYLE.placed.per * p) * (0.8 + 0.22 * shooting) * (1 - 0.1 * wf);
  if (aim.header) speed = 9 + 7 * p;
  let spin = 0;
  if (finesse) {
    speed *= SHOT_STYLE.finesse.speed;
    // Curve back towards the centre of the goal.
    const cross = (dx * (0 - ballPos.z) - dz * (gx - ballPos.x)) >= 0 ? 1 : -1;
    spin = -cross * SHOT_STYLE.finesse.curl;
  }
  // A free kick the taker has bent and dipped: their curl, their topspin.
  const bent = aim.curve !== undefined && !aim.header;
  if (bent) spin = clamp(aim.curve!, -1, 1) * SHOT_STYLE.freekick.curl;
  const dip = bent || aim.dip !== undefined ? clamp(aim.dip ?? 0, 0, 1) * SHOT_STYLE.freekick.dip : 0;
  speed = Math.min(speed, power ? 38 : 36);
  let aimY = aim.header ? 0.6 + 0.6 * p : power ? 0.3 + SHOT_STYLE.power.lift * p * p : placedStyle ? 0.25 + 0.6 * p : 0.25 + 1.45 * p * p;
  if (aim.clear) aimY = 1.0 + 1.1 * p; // over a wall: aim for the upper half of the goal
  if (aim.style === 'low') {
    // Kept low and skidding: a tight vertical spread and no risk of skying it.
    aimY = 0.18 + 0.12 * p + Math.abs(rng.gauss()) * (0.04 + 0.12 * (1 - shooting)) * (d / 16) * (1 + 0.5 * wf);
  } else {
    const ov = over + (power ? SHOT_STYLE.power.overhit : 0);
    const sigmaV = (0.1 + 0.5 * (1 - shooting)) * (d / 16) * (1 + Math.max(0, p - (ov - 0.05)) * 4) * (1 + 0.6 * ctx.pressure) * (1 + 0.8 * wf) * (ctx.accuracy ?? 1) * humanHelp.shotError(ctx.help) * (placedStyle ? SHOT_STYLE.placed.vspread : 1);
    aimY += rng.gauss() * sigmaV;
    if (p > ov + 0.05) aimY += rng.next() * (p - ov - 0.05) * 8; // risk of skying an over-hit shot
  }
  aimY = Math.max(0.12, aimY);
  if (aim.clear && aim.clear.d < d) {
    // Take pace off until the ball rises over the wall and still comes down at the target height.
    for (let f = 1; f >= 0.5; f -= 0.05) {
      const vy0 = solveLaunch(speed * f, aimY, ballPos.y, d, dip);
      if (flyTo(speed * f, vy0, ballPos.y, aim.clear.d, dip).y >= aim.clear.h) { speed *= f; break; }
    }
  }

  let dirAng = angleOf(dx, dz) + rng.gauss() * sigmaH;
  const tFlight = d / (speed * 0.92);
  if (spin !== 0) {
    // Pre-aim against the curve so a placed shot bends back on target.
    const lateral = 0.5 * Math.abs(spin) * (speed / 20) * tFlight * tFlight;
    dirAng -= Math.sign(spin) * Math.atan2(lateral, d) * 0.9;
  }
  const vy = solveLaunch(speed, aimY, ballPos.y, d, dip);
  return { vel: { x: Math.cos(dirAng) * speed, y: vy, z: Math.sin(dirAng) * speed }, spin, dip: dip || undefined };
}

/**
 * Chip: a high, slow ball that drops under the bar. Power sets how high it comes down at the
 * goal line, so an over-hit chip clears the bar. Best against a keeper off their line.
 */
function solveChip(ctx: KickContext, aim: ShotAim, d: number, dx: number, dz: number, sigmaH: number, wf: number): KickResult {
  const { kicker, ballPos, rng } = ctx;
  const shooting = kicker.a.shooting;
  const p = clamp(aim.power, 0, 1);
  let aimY = 1.15 + 1.6 * p * p;
  aimY += rng.gauss() * (0.12 + 0.3 * (1 - shooting)) * (d / 16) * (1 + 0.6 * ctx.pressure) * (1 + 0.8 * wf) * (ctx.accuracy ?? 1) * humanHelp.shotError(ctx.help);
  aimY = clamp(aimY, 0.3, 6);
  const tFlight = 0.95 + d * 0.04;
  const vh = (d / tFlight) * 1.08; // a little extra for air drag
  const vy = solveLaunch(vh, aimY, ballPos.y, d);
  const dirAng = angleOf(dx, dz) + rng.gauss() * sigmaH;
  return { vel: { x: Math.cos(dirAng) * vh, y: vy, z: Math.sin(dirAng) * vh }, spin: 0 };
}

/** Vertical launch speed so a ball struck at `speed` is at height aimY after travelling d metres. */
function solveLaunch(speed: number, aimY: number, y0: number, d: number, dip = 0) {
  const tFlight = d / (speed * 0.92);
  let vy = (aimY - y0) / tFlight + 0.5 * (BALL.gravity + dip * (speed / 20)) * tFlight;
  for (let i = 0; i < (dip ? 5 : 3); i++) {
    const r = flyTo(speed, vy, y0, d, dip);
    if (r.dist < d - 0.01) { vy += 0.8; continue; }
    vy += (aimY - r.y) / Math.max(0.2, r.t);
  }
  return clamp(vy, -2, dip ? 18 : 14);
}

export const kickWindup = (kind: KickKind) => (kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup);
/**
 * A keeper's distribution from the hands takes longer to wind up than a pass: the overarm throw
 * draws the arm right back and swings it over the top, the roll crouches and bowls it underarm.
 */
export const handWindup = (variant?: string) => (variant === 'roll' ? 0.3 : 0.34);
/** Follow-through after a keeper's throw or roll leaves the hand. */
export const HAND_FOLLOW = 0.4;
