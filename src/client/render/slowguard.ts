// Slow-graphics guard (20 Nov 2026). On a computer whose browser draws the 3D scene slowly (a work
// laptop with graphics acceleration switched off draws it in software at about 1 frame a second),
// the live menu stadium, the match intro and the match itself look broken. Auto resolution can't help
// there: it ignores frames over 250 ms. This watches the real frame rate of any 3D scene and asks
// for lower graphics when it stays under MIN_FPS. Pure logic, so it can be tested.

export const MIN_FPS = 15;
/** Frames in the first moments of a scene are shader building and loading: not counted. */
const SETTLE_MS = 4000;
const WINDOW_MS = 5000;

/** Browsers drawing WebGL on the processor, with no graphics chip: always far too slow for a match. */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(name);
}

export class SlowGuard {
  private since = 0;
  private sum = 0;
  private n = 0;

  /** Start again (a new scene, or graphics were just lowered). */
  rearm(now: number) { this.since = now; this.sum = 0; this.n = 0; }

  /** Feed each drawn frame's real duration; true when graphics should go down a step. */
  feed(frameMs: number, now: number): boolean {
    if (!this.since) this.since = now;
    if (now - this.since < SETTLE_MS) return false;
    if (frameMs > 4000) return false; // a stall (tab switched, loading), not the frame rate
    this.sum += frameMs;
    this.n++;
    if (this.sum < WINDOW_MS) return false;
    const fps = (this.n * 1000) / this.sum;
    this.sum = 0;
    this.n = 0;
    if (fps >= MIN_FPS) return false;
    this.since = now;
    return true;
  }
}

export interface SlowSettings {
  graphics: { preset: 'low' | 'medium' | 'high' | 'ultra'; renderScale: number; shadows: boolean; sharpen?: boolean };
  menuBackdrop: boolean;
  matchIntro: boolean;
}

/**
 * Lower graphics one step: quality down to Low, then Sharper picture off, then fewer pixels, then
 * the live menu stadium and match intro off. Returns what changed (for the message), or null when nothing is left to lower.
 */
export function lowerGraphics(s: SlowSettings): string | null {
  const g = s.graphics;
  if (g.preset === 'ultra' || g.preset === 'high') { g.preset = 'medium'; return 'Quality is now Medium'; }
  if (g.preset === 'medium') { g.preset = 'low'; return 'Quality is now Low'; }
  if (g.sharpen !== false) { g.sharpen = false; return 'Sharper picture is now off'; }
  if (g.renderScale > 0.7) { g.renderScale = 0.7; return 'Resolution is now 70%'; }
  if (g.renderScale > 0.5) { g.renderScale = 0.5; return 'Resolution is now 50%'; }
  if (s.menuBackdrop || s.matchIntro) { s.menuBackdrop = false; s.matchIntro = false; return 'The live menu stadium and match intro are off'; }
  return null;
}

/** Software drawing: straight to the lightest settings that still look like the game. */
export function softwareGraphics(s: SlowSettings) {
  s.graphics.preset = 'low';
  s.graphics.renderScale = Math.min(s.graphics.renderScale, 0.5);
  s.graphics.shadows = false;
  s.graphics.sharpen = false;
  s.menuBackdrop = false;
  s.matchIntro = false;
}
