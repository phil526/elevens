// Player locomotion shared by the server, offline play and client prediction.
// Attribute effects (DESIGN §7): Pace -> top speed, Acceleration -> accel/turn,
// Stamina -> sprint drain/recovery.

import { BALLCTL, PITCH, PLAYER } from './config';
import { angleOf, clamp, turnTowards, wrapAngle } from './math';
import { BC } from './switches';
import type { Attributes, MoveModeName, V2 } from './types';

export interface MoverState {
  pos: V2;
  vel: V2;
  facing: number;
  stamina: number;
  sprinting: boolean;
  jockeying: boolean;
  a: Attributes;
}

/** Turn-rate multiplier for a carrier dribbling at jogging pace (server and client prediction). */
export const DRIBBLE_TURN = 1.3;

/**
 * How sharply a carrier turns with the ball (19 Nov 2026): better control turns tighter, at jogging
 * pace and when sprinting (the average player is unchanged: 1.3 jogging, 1.0 sprinting); close
 * control is tightest of all. Off the ball it is 1.
 */
export function dribbleTurn(a: Attributes, sprinting: boolean, close = false): number {
  if (close) return BALLCTL.closeTurn * (0.85 + 0.2 * a.control);
  if (!BC.attr) return sprinting ? 1 : DRIBBLE_TURN;
  return sprinting ? 1 + 0.6 * (a.control - 0.7) : DRIBBLE_TURN + 1.0 * (a.control - 0.7);
}

/** A carrier's movement (server and client prediction): mode, speed and acceleration multipliers and turn rate. */
export function carrierMove(a: Attributes, mode: MoveMode, close: boolean): { mode: MoveMode; speed: number; accel: number; turn: number } {
  if (close && mode !== 'jockey' && mode !== 'jockeyfast') return { mode: 'jog', speed: BALLCTL.closeSpeed, accel: BALLCTL.closeAccel, turn: dribbleTurn(a, false, true) };
  return { mode, speed: 1, accel: 1, turn: mode === 'sprint' ? dribbleTurn(a, true) : dribbleTurn(a, false) };
}

export type MoveMode = MoveModeName;

// Pace and acceleration spread around a 70-rated player (8.56 m/s, 6.95 m/s^2): an 88-pace
// winger is about a metre a second quicker than a 52-pace centre-back.
export const sprintTop = (a: Attributes) => 8.56 + 2.7 * (a.pace - 0.7);
export const jogSpeed = (a: Attributes) => 0.72 * sprintTop(a);
export const accelOf = (a: Attributes) => 6.95 + 4.6 * (a.acceleration - 0.7);

/** Sprint speed after fatigue: below 35% stamina it fades towards jogging speed. Jogging is never penalised. */
export function effectiveSprint(a: Attributes, stamina: number) {
  const jog = jogSpeed(a);
  return jog + (sprintTop(a) - jog) * clamp(stamina / 0.35, 0, 1);
}

export function modeSpeed(m: MoverState, mode: MoveMode): number {
  switch (mode) {
    case 'walk': return PLAYER.walkSpeed;
    case 'jog': return jogSpeed(m.a);
    case 'sprint': return effectiveSprint(m.a, m.stamina);
    case 'jockey': return Math.min(PLAYER.jockeySpeed, jogSpeed(m.a));
    case 'jockeyfast': return Math.min(PLAYER.jockeyFastSpeed * (0.9 + 0.2 * m.a.pace) * clamp(0.6 + m.stamina, 0, 1), jogSpeed(m.a));
  }
}

/**
 * Advance one mover. `wx, wz` is the wish direction scaled 0..1. `faceAngle`
 * (optional) keeps the body facing a point (jockeying, receiving); otherwise the
 * player faces the direction of travel. `speedScale` < 1 while dribbling.
 */
export function stepMovement(m: MoverState, wx: number, wz: number, mode: MoveMode, dt: number, faceAngle: number | null = null, speedScale = 1, accelScale = 1, turnScale = 1) {
  const mag = Math.min(1, Math.hypot(wx, wz));
  const target = modeSpeed(m, mode) * mag * speedScale;
  const dx = mag > 1e-6 ? wx / Math.hypot(wx, wz) : 0;
  const dz = mag > 1e-6 ? wz / Math.hypot(wx, wz) : 0;
  const accel = accelOf(m.a) * accelScale;
  const decel = accel * 1.7;
  let vx = m.vel.x, vz = m.vel.z;
  const speed = Math.hypot(vx, vz);

  if (target < 0.05) {
    // Decelerate to a stop.
    const ns = Math.max(0, speed - decel * dt);
    const k = speed > 1e-6 ? ns / speed : 0;
    vx *= k; vz *= k;
  } else if (speed < 1.5) {
    // From near standing a player can set off in any direction.
    vx += (dx * target - vx) * Math.min(1, (accel * dt) / Math.max(0.5, target));
    vz += (dz * target - vz) * Math.min(1, (accel * dt) / Math.max(0.5, target));
  } else {
    // At speed, heading turns at a limited rate; big reversals brake first (sense of weight).
    const heading = Math.atan2(vz, vx);
    const want = Math.atan2(dz, dx);
    const diff = Math.abs(wrapAngle(want - heading));
    const turnRate = (mode === 'jockey' || mode === 'jockeyfast' ? 9 : 11 - 6 * clamp(speed / 9, 0, 1)) * (0.8 + 0.4 * m.a.acceleration) * turnScale;
    let ns = speed;
    if (diff > 1.75) ns = Math.max(0, speed - decel * dt);
    else if (ns < target) ns = Math.min(target, ns + accel * dt * (1 - diff / 3));
    else ns = Math.max(target, ns - decel * dt);
    const nh = turnTowards(heading, want, turnRate * dt);
    vx = Math.cos(nh) * ns;
    vz = Math.sin(nh) * ns;
  }

  m.vel.x = vx;
  m.vel.z = vz;
  m.pos.x += vx * dt;
  m.pos.z += vz * dt;
  // Players may run a few metres beyond the lines but not into the stands.
  m.pos.x = clamp(m.pos.x, -PITCH.halfLength - 4, PITCH.halfLength + 4);
  m.pos.z = clamp(m.pos.z, -PITCH.halfWidth - 3, PITCH.halfWidth + 3);

  const ns = Math.hypot(vx, vz);
  const faceRate = 10 + 6 * m.a.acceleration;
  if (faceAngle !== null) m.facing = turnTowards(m.facing, faceAngle, faceRate * dt);
  else if (ns > 0.4) m.facing = turnTowards(m.facing, angleOf(vx, vz), faceRate * dt);

  // Stamina: the same rules for humans and AI.
  m.sprinting = mode === 'sprint' && ns > jogSpeed(m.a) * 1.02;
  m.jockeying = mode === 'jockey' || mode === 'jockeyfast';
  if (m.sprinting) {
    m.stamina -= (0.075 - 0.035 * m.a.stamina) * dt;
  } else if (mode === 'jockeyfast' && ns > PLAYER.jockeySpeed) {
    m.stamina -= (0.04 - 0.02 * m.a.stamina) * dt;
  } else {
    const rec = ns < 2.5 ? 0.05 : 0.025;
    m.stamina += rec * (0.7 + 0.6 * m.a.stamina) * dt;
  }
  m.stamina = clamp(m.stamina, 0, 1);
}
