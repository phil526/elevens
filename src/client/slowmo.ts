// A moment of slow motion after a goal or a shot off the woodwork (offline matches only):
// play drops to a fraction of normal speed, holds, then eases back up to full speed.

export interface SlowMoShape {
  /** Speed while slowed (0..1). */
  speed: number;
  /** Real seconds held at that speed. */
  hold: number;
  /** Real seconds easing back to full speed. */
  ease: number;
}

export const SLOW_MO = {
  goal: { speed: 0.3, hold: 1.3, ease: 0.6 },
  woodwork: { speed: 0.45, hold: 0.55, ease: 0.4 },
} as const satisfies Record<string, SlowMoShape>;

/**
 * Hit-stop (21 Nov 2026): the picture all but freezes for a few hundredths of a second as a
 * thunderous shot is struck or a crunching tackle goes in, so big contacts land with weight.
 * Offline only (an online match can't wait), and only with Settings > Camera > Big moments on.
 */
export const HIT_STOP = {
  strike: { speed: 0.04, hold: 0.07, ease: 0.07 },
  tackle: { speed: 0.12, hold: 0.045, ease: 0.05 },
  woodwork: { speed: 0.03, hold: 0.09, ease: 0.05 },
} as const satisfies Record<string, SlowMoShape>;

export class SlowMo {
  private t = 0;
  private shape: SlowMoShape | null = null;

  start(shape: SlowMoShape) {
    // A bigger moment (slower) replaces a smaller one in progress.
    if (this.shape && this.t < this.shape.hold + this.shape.ease && shape.speed > this.shape.speed) return;
    this.shape = shape;
    this.t = 0;
  }

  stop() {
    this.shape = null;
  }

  get active() {
    return !!this.shape;
  }

  /** Advance by a real frame time and return the speed for this frame (1 = normal). */
  scale(dt: number): number {
    const s = this.shape;
    if (!s) return 1;
    this.t += dt;
    if (this.t < s.hold) return s.speed;
    const e = (this.t - s.hold) / s.ease;
    if (e >= 1) { this.shape = null; return 1; }
    return s.speed + (1 - s.speed) * e * e * (3 - 2 * e);
  }
}
