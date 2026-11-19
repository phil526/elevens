// Mouse and keyboard play (PC): your player runs towards the mouse pointer on the pitch, mouse
// buttons and keys do the rest (left click pass, right click shoot, A long ball, S through ball by
// default; all remappable in Controls > Mouse). The steering maths is pure so it is unit-tested;
// DOM wiring is in attachMouse.

import { type InputSource, type RawState } from './actions';
import { defaultBindings, mouseMap, type BindAction, type ControlBindings } from './bindings';
import { KeyboardState } from './keyboard';

export interface Pt { x: number; z: number }

/** Inside this distance (m) from the pointer your player stops; the run builds to full speed by STEER_FULL. */
export const STEER_DEAD = 0.6;
export const STEER_FULL = 3.2;

/**
 * Screen-space stick (right, up) that runs from `from` towards `to` on the pitch, given the camera
 * heading (the inverse of ActionLayer.toWorld). Strength grows with the distance, so a pointer
 * resting on your player stands him still and a pointer a few metres away is a full run.
 */
export function steer(from: Pt, to: Pt, yaw: number): { sx: number; sy: number } {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < STEER_DEAD) return { sx: 0, sy: 0 };
  const m = Math.min(1, (d - STEER_DEAD) / (STEER_FULL - STEER_DEAD));
  // Keep a minimum so the aim still has a direction just outside the dead zone.
  const k = Math.max(0.2, m) / d;
  const wx = dx * k, wz = dz * k;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // toWorld is [x, z] = [sx c + sy s, sx s - sy c]; that matrix is its own inverse.
  return { sx: wx * c + wz * s, sy: wx * s - wz * c };
}

export class MouseSource implements InputSource {
  device = 'mouse' as const;
  /** Keys and mouse buttons of the mouse layout (mouse buttons arrive as Mouse0..Mouse4, the wheel as WheelUp/WheelDown). */
  keys = new KeyboardState();
  /** Set each frame by the app: the point on the pitch under the pointer (null when it is off the pitch or the window). */
  cursor: Pt | null = null;
  /** Set each frame by the app: where steering starts from (your player, or a set-piece target being aimed), or null. */
  from: Pt | null = null;
  /** Camera heading, as ActionLayer.yaw. */
  yaw = 0;

  constructor(b: ControlBindings = defaultBindings()) {
    this.setBindings(b);
  }

  setBindings(b: ControlBindings) {
    this.keys.setMap(mouseMap(b));
  }

  /** A key or mouse button went down or up; true when the mouse layout uses it. */
  handle(code: string, down: boolean): boolean {
    return this.keys.handle(code, down);
  }

  /** Whether an input is part of the mouse layout. */
  uses(code: string): BindAction | undefined {
    return this.keys.action(code);
  }

  read(): RawState {
    const r = this.keys.read();
    // The keys' own movement is unused here (the layout has no movement keys); the pointer steers.
    r.sx = 0; r.sy = 0;
    if (this.cursor && this.from) {
      const st = steer(this.from, this.cursor, this.yaw);
      r.sx = st.sx; r.sy = st.sy;
    }
    return r;
  }

  clear() {
    this.keys.clear();
  }
}

/**
 * DOM wiring. Buttons count only while `active()` (a match is being played with mouse control on and
 * no menu open), pressed anywhere on the game picture (the HUD on top of it included, but not a
 * button or link); letting go anywhere releases them. The browser menu stays shut during play and
 * never opens on the canvas. Keys go through the window, like the keyboard.
 */
export function attachMouse(m: MouseSource, canvas: HTMLElement, active: () => boolean, onPoint: (cx: number, cy: number, inside: boolean) => void) {
  const onControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a, input, select, textarea, label, [data-a], .touch-layer');
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('contextmenu', (e) => { if (active() && !onControl(e.target)) e.preventDefault(); }, true);
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || !active() || onControl(e.target)) return;
    if (m.handle(`Mouse${e.button}`, true)) e.preventDefault();
    onPoint(e.clientX, e.clientY, true);
  });
  // Middle click would start auto-scroll and side buttons would go back a page.
  window.addEventListener('mousedown', (e) => { if (active() && e.button !== 0 && !onControl(e.target)) e.preventDefault(); });
  window.addEventListener('auxclick', (e) => { if (active()) e.preventDefault(); });
  window.addEventListener('mouseup', (e) => { if ((e.button === 3 || e.button === 4) && active()) e.preventDefault(); });
  window.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') m.handle(`Mouse${e.button}`, false); });
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') onPoint(e.clientX, e.clientY, true); });
  document.documentElement.addEventListener('mouseleave', () => onPoint(0, 0, false));
  window.addEventListener('wheel', (e) => {
    if (!active() || Math.abs(e.deltaY) < 1 || onControl(e.target)) return;
    const code = e.deltaY < 0 ? 'WheelUp' : 'WheelDown';
    if (m.uses(code)) {
      e.preventDefault();
      // One sample's press: the latch keeps it until the next read.
      m.handle(code, true);
      m.handle(code, false);
    }
  }, { passive: false });
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (m.handle(e.code, true) && active() && e.code !== 'Escape') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { m.handle(e.code, false); });
}
