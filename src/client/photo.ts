// Photo mode (19 Nov 2026): freeze an offline match from the pause menu, fly the camera around
// the moment and save a picture. Controller: left stick moves the point the camera looks at,
// right stick orbits, LT/RT zoom, LB/RB raise and lower; X changes the filter, Y hides the panel,
// A takes the picture, B goes back. Keyboard: WASD / arrows move, I J K L orbit, Q/E zoom,
// R/F up and down, Space takes it. Touch: drag on the pitch to orbit, the panel's buttons for the rest.

import type { CineShot } from './render/cinematic';
import type { ViewState } from './view';

export type PhotoFilter = 'none' | 'vivid' | 'mono' | 'sepia' | 'warm' | 'cool' | 'noir';
export const PHOTO_FILTERS: [PhotoFilter, string][] = [['none', 'Natural'], ['vivid', 'Vivid'], ['warm', 'Warm'], ['cool', 'Cool'], ['mono', 'Mono'], ['sepia', 'Sepia'], ['noir', 'Noir']];

/** CSS preview of each filter on the live canvas (the saved picture applies the same look to its pixels). */
export const FILTER_CSS: Record<PhotoFilter, string> = {
  none: '', vivid: 'saturate(1.45) contrast(1.08)', warm: 'sepia(0.25) saturate(1.2) hue-rotate(-8deg)', cool: 'saturate(0.95) hue-rotate(12deg) brightness(1.03)',
  mono: 'grayscale(1) contrast(1.1)', sepia: 'sepia(0.85) contrast(1.05)', noir: 'grayscale(1) contrast(1.55) brightness(0.92)',
};

export interface PhotoInput { mx: number; mz: number; ox: number; oy: number; zoom: number; lift: number }

export class PhotoMode {
  active = false;
  target = { x: 0, y: 1, z: 0 };
  yaw = 0; // radians around the target, 0 = camera on the +z side looking towards -z
  pitch = 0.32; // radians above the horizon
  dist = 16;
  fov = 40;
  filter: PhotoFilter = 'none';
  vignette = true;
  stamp = true;
  panel = true;
  /** Keyboard keys held (KeyboardEvent.code). */
  keys = new Set<string>();

  /** Start on the ball, from where the match camera was. */
  start(v: ViewState, camPos: { x: number; y: number; z: number }) {
    this.active = true;
    const b = v.ball.pos;
    this.target = { x: b.x, y: Math.max(0.6, b.y), z: b.z };
    const dx = camPos.x - b.x, dz = camPos.z - b.z;
    this.yaw = Math.atan2(dx, dz);
    this.dist = 14;
    this.pitch = 0.3;
    this.fov = 40;
    this.panel = true;
  }

  stop() { this.active = false; this.keys.clear(); }

  /** Controller and keyboard input for this frame (sticks -1..1). */
  input(): PhotoInput {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const inp: PhotoInput = {
      mx: k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft'),
      mz: k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown'),
      ox: k('KeyL') - k('KeyJ'), oy: k('KeyI') - k('KeyK'),
      zoom: k('KeyE') - k('KeyQ'), lift: k('KeyR') - k('KeyF'),
    };
    const pads = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
    for (const p of pads) {
      if (!p) continue;
      inp.mx += dz(p.axes[0] ?? 0); inp.mz -= dz(p.axes[1] ?? 0);
      inp.ox += dz(p.axes[2] ?? 0); inp.oy -= dz(p.axes[3] ?? 0);
      inp.zoom += (p.buttons[7]?.value ?? 0) - (p.buttons[6]?.value ?? 0);
      inp.lift += (p.buttons[4]?.pressed ? 1 : 0) - (p.buttons[5]?.pressed ? 1 : 0);
    }
    return inp;
  }

  /** Move the camera for one frame and return the shot. */
  update(dt: number, inp: PhotoInput = this.input()): CineShot {
    // Movement is relative to the way the camera faces.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const speed = 6 + this.dist * 0.6;
    this.target.x += (inp.mx * -fz + inp.mz * fx) * speed * dt;
    this.target.z += (inp.mx * fx + inp.mz * fz) * speed * dt;
    this.target.x = Math.max(-62, Math.min(62, this.target.x));
    this.target.z = Math.max(-42, Math.min(42, this.target.z));
    this.target.y = Math.max(0.2, Math.min(8, this.target.y + inp.lift * 3 * dt));
    this.yaw += inp.ox * 1.6 * dt;
    this.pitch = Math.max(0.02, Math.min(1.35, this.pitch + inp.oy * 1.1 * dt));
    // Zoom: first the lens, then the distance.
    if (inp.zoom) {
      this.fov = Math.max(14, Math.min(70, this.fov - inp.zoom * 22 * dt));
      if ((this.fov <= 14 && inp.zoom > 0) || (this.fov >= 70 && inp.zoom < 0)) this.dist = Math.max(3, Math.min(60, this.dist - inp.zoom * 10 * dt));
    }
    return this.shot();
  }

  /** Drag to orbit (pixels). */
  drag(dx: number, dy: number) {
    this.yaw -= dx * 0.008;
    this.pitch = Math.max(0.02, Math.min(1.35, this.pitch + dy * 0.006));
  }

  /** Zoom one step in (+1) or out (-1) from the panel. */
  step(z: number) {
    this.dist = Math.max(3, Math.min(60, this.dist * (z > 0 ? 0.8 : 1.25)));
  }

  shot(): CineShot {
    const c = Math.cos(this.pitch);
    const pos = { x: this.target.x + Math.sin(this.yaw) * c * this.dist, y: Math.max(0.25, this.target.y + Math.sin(this.pitch) * this.dist), z: this.target.z + Math.cos(this.yaw) * c * this.dist };
    return { pos, look: { ...this.target }, fov: this.fov, near: 0.1 };
  }

  nextFilter() {
    const i = PHOTO_FILTERS.findIndex(([f]) => f === this.filter);
    this.filter = PHOTO_FILTERS[(i + 1) % PHOTO_FILTERS.length][0];
  }
}

/** Apply a filter to RGBA pixels in place. */
export function filterPixels(d: Uint8ClampedArray, f: PhotoFilter) {
  if (f === 'none') return;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    switch (f) {
      case 'vivid': { const s = 1.45; r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s; r = (r - 128) * 1.08 + 128; g = (g - 128) * 1.08 + 128; b = (b - 128) * 1.08 + 128; break; }
      case 'mono': r = g = b = (y - 128) * 1.1 + 128; break;
      case 'noir': r = g = b = (y * 0.92 - 128) * 1.55 + 128; break;
      case 'sepia': { const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b; r = r * 0.15 + sr * 0.85; g = g * 0.15 + sg * 0.85; b = b * 0.15 + sb * 0.85; break; }
      case 'warm': r = r * 1.08 + 6; g = g * 1.02; b = b * 0.88; break;
      case 'cool': r = r * 0.92; g = g * 1.0 + 2; b = b * 1.1 + 6; break;
      default: break;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
}

/**
 * The finished picture: the frame just drawn, with the filter, an optional vignette and a small
 * ELEVENS stamp with the score and minute. Returns a JPEG data URL (or null if the canvas can't be read).
 */
export function composePhoto(src: HTMLCanvasElement, opts: { filter: PhotoFilter; vignette: boolean; stamp: string | null }): string | null {
  try {
    const w = src.width, h = src.height;
    const scale = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(src, 0, 0, c.width, c.height);
    if (opts.filter !== 'none') {
      const img = g.getImageData(0, 0, c.width, c.height);
      filterPixels(img.data, opts.filter);
      g.putImageData(img, 0, 0);
    }
    if (opts.vignette) {
      const rg = g.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.hypot(c.width, c.height) * 0.55);
      rg.addColorStop(0, 'rgba(0,0,0,0)');
      rg.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = rg;
      g.fillRect(0, 0, c.width, c.height);
    }
    if (opts.stamp) {
      const s = Math.max(14, Math.round(c.height * 0.028));
      g.font = `900 ${s}px system-ui, sans-serif`;
      g.textBaseline = 'bottom';
      g.fillStyle = 'rgba(0,0,0,0.45)';
      const text = `ELEVENS   ${opts.stamp}`;
      const tw = g.measureText(text).width;
      g.fillRect(s * 0.8, c.height - s * 2.4, tw + s * 1.2, s * 1.7);
      g.fillStyle = '#ffffff';
      g.fillText('ELEVENS', s * 1.4, c.height - s * 1.05);
      g.fillStyle = '#3ee08f';
      g.fillText(opts.stamp, s * 1.4 + g.measureText('ELEVENS   ').width, c.height - s * 1.05);
    }
    return c.toDataURL('image/jpeg', 0.92);
  } catch {
    return null;
  }
}
