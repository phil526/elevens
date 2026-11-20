// Expected goals (20 Nov 2026): how often a shot from that spot goes in, from the distance to the
// goal and the angle the goal mouth makes from there (a logistic fit to typical real-world rates:
// about 0.45 from 6 m out in the middle, 0.2 from the penalty spot in open play, 0.06 from 20 m,
// a couple of per cent from 30 m). Headers and volleys are harder; penalties are 0.76.

import { PITCH } from './config';

export type ShotKind = 'shot' | 'header' | 'volley' | 'overhead' | 'pen' | 'freekick';

/** Angle (radians) the goal mouth fills seen from (x, z), for a team attacking towards +x when dir = 1. */
export function goalAngle(x: number, z: number, dir: number): number {
  const gx = dir * PITCH.halfLength;
  const a1 = Math.atan2(PITCH.goalHalfWidth - z, Math.abs(gx - x));
  const a2 = Math.atan2(-PITCH.goalHalfWidth - z, Math.abs(gx - x));
  return Math.max(0, Math.abs(a1 - a2));
}

export function xgFor(x: number, z: number, dir: number, kind: ShotKind = 'shot'): number {
  if (kind === 'pen') return 0.76;
  const gx = dir * PITCH.halfLength;
  const d = Math.hypot(gx - x, z);
  const th = goalAngle(x, z, dir);
  // Behind the goal line or from the halfway line: almost nothing.
  if ((x - gx) * dir > 0) return 0.01;
  let p = 1 / (1 + Math.exp(-(-0.51 - 0.13 * d + 1.0 * th)));
  if (kind === 'header') p *= 0.6;
  else if (kind === 'volley') p *= 0.8;
  else if (kind === 'overhead') p *= 0.55;
  else if (kind === 'freekick') p = Math.min(p, 0.09);
  return Math.max(0.005, Math.min(0.95, p));
}
