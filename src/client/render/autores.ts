// Auto resolution: draw slightly fewer pixels while the frame rate is dropping, and go back up
// when it recovers. Pure logic (no WebGL) so it can be tested; GameRenderer applies the scale.

/** Auto resolution never goes below this share of the chosen resolution. */
export const AUTO_RES_MIN = 0.75;

/**
 * Fed each match frame's real duration. When frames average under ~51 fps over a second and a
 * half, step 10% down (to AUTO_RES_MIN at most); after 6 s back at full speed, step 5% back up.
 * If a step up makes it slow again within 12 s, stay down for a minute instead of bouncing.
 */
export class AutoRes {
  scale = 1;
  private sum = 0;
  private n = 0;
  private good = 0;
  private lastRaise = -1e9;
  private holdUntil = 0;

  /** Returns the new scale when it changes, otherwise null. */
  feed(frameMs: number, now: number): number | null {
    if (frameMs > 250) return null; // a hitch (loading, tab switched), not the steady frame rate
    this.sum += frameMs;
    this.n++;
    if (this.sum < 1500) return null;
    const avg = this.sum / this.n;
    this.sum = this.n = 0;
    let next = this.scale;
    if (avg > 19.5) {
      if (now - this.lastRaise < 12000) this.holdUntil = now + 60000;
      next = Math.max(AUTO_RES_MIN, this.scale - 0.1);
      this.good = 0;
    } else if (avg < 17.8) {
      this.good += 1.5;
      if (this.good >= 6 && this.scale < 1 && now > this.holdUntil) {
        next = Math.min(1, this.scale + 0.05);
        this.lastRaise = now;
        this.good = 0;
      }
    } else this.good = 0;
    if (Math.abs(next - this.scale) < 1e-3) return null;
    this.scale = next;
    return next;
  }

  reset() {
    this.scale = 1;
    this.sum = this.n = this.good = 0;
    this.lastRaise = -1e9;
    this.holdUntil = 0;
  }
}
