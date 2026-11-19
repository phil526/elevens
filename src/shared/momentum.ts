// Home crowd momentum (19 Nov 2026). Pressure (shots, corners, time on the ball in the final
// third, goals, big tackles) swings a single momentum value towards the side on top. When the
// home side (team 0) is on top, the home crowd turns it into a lift: the home players run a
// little harder for longer and strike the ball a little cleaner, and the visitors feel it. The
// numbers are deliberately small: momentum tips a match, it never decides one.

import { clamp } from './math';

export const MOMENTUM = {
  /** Momentum drifts back towards level at this rate (per second, proportional). */
  decay: 0.045,
  shot: 0.06,
  onTarget: 0.05,
  corner: 0.05,
  goal: 0.3,
  tackle: 0.015,
  save: 0.03,
  woodwork: 0.06,
  /** Per second with the ball in the opponents' final third. */
  finalThird: 0.012,
  /** Per second with the ball in the opponents' penalty area. */
  box: 0.03,
  /** Lift starts above this much home momentum and is full at 1. */
  liftFrom: 0.3,
  /** At full lift: stamina drains this much slower for the home side... */
  stamina: 0.18,
  /** ...their kicks are this much more accurate (error multiplier 1 - x)... */
  accuracy: 0.08,
  /** ...and the visitors' kicks this much less accurate. */
  nerves: 0.04,
} as const;

/** Momentum as a number from -1 (away side on top) to 1 (home side on top). */
export class Momentum {
  value = 0;
  constructor(public on = true) {}

  /** Push momentum towards `team` (0 home, 1 away). */
  push(team: number, amount: number) {
    if (!this.on || team < 0) return;
    const s = team === 0 ? 1 : -1;
    // Harder to keep pushing a swing that's already big.
    const room = 1 - Math.max(0, this.value * s);
    this.value = clamp(this.value + s * amount * (0.35 + 0.65 * room), -1, 1);
  }

  step(dt: number) {
    if (!this.on) { this.value = 0; return; }
    this.value -= this.value * MOMENTUM.decay * dt;
  }

  /** The home crowd's lift for the home side, 0..1 (0 unless the home side is on top). */
  lift(): number {
    if (!this.on) return 0;
    return clamp((this.value - MOMENTUM.liftFrom) / (1 - MOMENTUM.liftFrom), 0, 1);
  }

  /** Kick error multiplier for a team: home cleaner with the crowd behind them, the visitors a little nervier. */
  kickError(team: number): number {
    const l = this.lift();
    return l === 0 ? 1 : team === 0 ? 1 - MOMENTUM.accuracy * l : 1 + MOMENTUM.nerves * l;
  }

  /** Stamina drain multiplier for a team (home players run on adrenaline). */
  staminaDrain(team: number): number {
    const l = this.lift();
    return team === 0 && l > 0 ? 1 - MOMENTUM.stamina * l : 1;
  }
}
