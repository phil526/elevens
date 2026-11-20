// Browser Gamepad API (standard mapping). Analogue stick with radial dead zone.

import { emptyRaw, type InputSource, type RawState } from './actions';
import { BIND_ACTIONS, defaultBindings, padLabel, PAD_BUTTONS, RESERVED_PAD, type ControlBindings } from './bindings';

export const DEAD_ZONE = 0.18;
/** A stick held further than this when input is cleared waits until it comes back inside it. */
export const LATCH_STICK = 0.5;

/** Radial dead zone with rescaling so movement starts smoothly from zero. */
export function applyDeadZone(x: number, y: number, dz = DEAD_ZONE): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

export type PadStyle = 'xbox' | 'playstation' | 'generic';
export const padStyle = (id: string): PadStyle =>
  /054c|playstation|dualshock|dualsense/i.test(id) ? 'playstation' : /xbox|xinput|045e/i.test(id) ? 'xbox' : 'generic';

/** Button names for each action under the given bindings (first bound button; '—' when none), plus the right stick. */
export function padLabels(style: PadStyle, b: ControlBindings = defaultBindings()): Record<string, string> {
  const out: Record<string, string> = { flick: style === 'xbox' ? 'RS' : style === 'playstation' ? 'R stick' : 'Axes 2/3' };
  for (const a of BIND_ACTIONS) if (a.pad) out[a.id] = b.pad[a.id].length ? b.pad[a.id].map((i) => padLabel(style, i)).join('/') : '—';
  return out;
}

/** Default labels (kept for older callers). */
export const PAD_LABELS: Record<PadStyle, Record<string, string>> = {
  xbox: padLabels('xbox'),
  playstation: padLabels('playstation'),
  generic: padLabels('generic'),
};

/** Fixed menu input: stick/D-pad direction and the A (confirm) and B (back) buttons, whatever the bindings. */
export interface PadMenuState {
  sx: number;
  sy: number;
  a: boolean;
  b: boolean;
}

interface Rumbler {
  playEffect?: (type: 'dual-rumble', params: { duration: number; startDelay?: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown>;
  pulse?: (value: number, duration: number) => Promise<unknown>;
  effects?: string[];
  type?: string;
}

interface PadLike {
  connected: boolean;
  id: string;
  mapping?: string;
  vibrationActuator?: Rumbler | null;
  hapticActuators?: readonly Rumbler[];
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
}

export class GamepadSource implements InputSource {
  device = 'gamepad' as const;
  index = -1;
  style: PadStyle = 'generic';
  /** clear() was called: the next read latches whatever is held then. */
  private pendingLatch = false;
  /** Buttons held when input was cleared: each is ignored until it is let go (not the whole pad). */
  private latchedButtons = new Set<number>();
  /** Sticks pushed when input was cleared: ignored until they return towards the middle. */
  private latchedStick = [false, false];
  /**
   * Per pad, per axis: has the axis ever read near its middle? An axis that has not (a trigger resting
   * at -1 on a pad without the standard mapping, as some PC controllers report) is not read as a stick.
   */
  private axisSeen = new Map<number, boolean[]>();
  /** Which buttons trigger each action (Settings → Controls). */
  bindings: ControlBindings = defaultBindings();
  onChange: (connected: boolean, id: string) => void = () => {};
  constructor(private getPads: () => (PadLike | null)[] = () => (navigator.getGamepads ? Array.from(navigator.getGamepads()) : [])) {}

  /** Indices of every connected pad (local multiplayer). */
  connectedIndices(): number[] {
    const out: number[] = [];
    this.getPads().forEach((p, i) => { if (p && p.connected) out.push(i); });
    return out;
  }

  /** Menu input from the pad at index i, whatever this source is pinned to (local multiplayer's Choose sides screen). */
  readMenuAt(i: number): PadMenuState & { start: boolean } {
    const pad = this.getPads()[i];
    if (!pad || !pad.connected) return { sx: 0, sy: 0, a: false, b: false, start: false };
    const [x, y] = this.move(pad, i);
    return { sx: x, sy: -y, a: GamepadSource.down(pad, 0), b: GamepadSource.down(pad, 1), start: GamepadSource.down(pad, 9) };
  }

  attach() {
    window.addEventListener('gamepadconnected', (e) => this.connect((e as GamepadEvent).gamepad.index, (e as GamepadEvent).gamepad.id));
    window.addEventListener('gamepaddisconnected', (e) => this.disconnect((e as GamepadEvent).gamepad.index, (e as GamepadEvent).gamepad.id));
  }
  connect(index: number, id: string) {
    if (this.index < 0) {
      this.index = index;
      this.style = padStyle(id);
      this.onChange(true, id);
    }
  }
  disconnect(index: number, id: string) {
    if (index === this.index) {
      this.index = -1;
      this.onChange(false, id);
    }
  }
  /** Local multiplayer: this source reads only the pad at this Gamepad API index (-1: the first connected). */
  pin = -1;

  /** The connected pad, connecting to one if the browser exposes it without an event. */
  private pad(): PadLike | null {
    if (this.pin >= 0) {
      const p = this.getPads()[this.pin];
      if (!p || !p.connected) return null;
      this.style = padStyle(p.id);
      return p;
    }
    const pads = this.getPads();
    if (this.index < 0) {
      // Some browsers only expose pads after a button press without firing the event.
      const p = pads.find((x) => x && x.connected);
      if (p) this.connect(pads.indexOf(p), p.id);
      else return null;
    } else if (pads.length > 1) {
      // PCs often list more than one "gamepad" (Steam or DS4Windows virtual pads, wheels, headsets,
      // RGB keyboards). Follow the one whose buttons are being pressed when ours is idle.
      const cur = pads[this.index];
      const pressing = (x: PadLike | null | undefined) => !!x && x.connected && x.buttons.some((b) => b && b.pressed);
      if (!pressing(cur)) {
        const j = pads.findIndex((x, k) => k !== this.index && pressing(x));
        if (j >= 0) {
          this.index = j;
          this.style = padStyle(pads[j]!.id);
        }
      }
    }
    const pad = pads[this.index];
    if (!pad || !pad.connected) {
      this.disconnect(this.index, pad?.id ?? '');
      return null;
    }
    return pad;
  }

  /** Does the connected controller accept rumble in this browser? */
  canRumble(): boolean {
    const pad = this.pad();
    return !!pad && (!!pad.vibrationActuator?.playEffect || !!pad.hapticActuators?.[0]?.pulse);
  }

  /**
   * Rumble the controller: strong (low, heavy motor) and weak (high, light motor) from 0 to 1, for
   * ms milliseconds. Uses the standard 'dual-rumble' effect, or the older haptic pulse; silently does
   * nothing where the browser or controller has neither.
   */
  rumble(strong: number, weak: number, ms: number) {
    const pad = this.pad();
    if (!pad) return;
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    try {
      const va = pad.vibrationActuator;
      if (va?.playEffect) {
        void va.playEffect('dual-rumble', { duration: ms, startDelay: 0, strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak) }).catch(() => {});
        return;
      }
      const h = pad.hapticActuators?.[0];
      if (h?.pulse) void h.pulse(clamp01(Math.max(strong, weak)), ms).catch(() => {});
    } catch { /* not supported */ }
  }

  /** Is button i down? Triggers count from a partial pull. */
  private static down(pad: PadLike, i: number) {
    const thr = i === 6 ? 0.4 : i === 7 ? 0.3 : 0.5;
    return !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > thr);
  }

  /** Axis value, or 0 for an axis that has never come near its middle (not a stick). */
  private axis(pad: PadLike, idx: number, k: number): number {
    const v = pad.axes[k] ?? 0;
    if (pad.mapping === 'standard') return v; // axes 0-3 are the two sticks by definition
    let seen = this.axisSeen.get(idx);
    if (!seen) this.axisSeen.set(idx, (seen = []));
    if (Math.abs(v) < 0.5) seen[k] = true;
    return seen[k] ? v : 0;
  }

  /** Left stick plus D-pad, gamepad axes (y down-positive). */
  private move(pad: PadLike, idx: number): [number, number] {
    let [x, y] = applyDeadZone(this.axis(pad, idx, 0), this.axis(pad, idx, 1));
    const d = (i: number) => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5);
    if (d(12)) y = -1;
    if (d(13)) y = 1;
    if (d(14)) x = -1;
    if (d(15)) x = 1;
    return [x, y];
  }

  /** While the Controls menu waits for a new button, play ignores the pad. */
  muted = false;

  read(): RawState {
    const r = emptyRaw();
    const pad = this.pad();
    if (!pad || this.muted) return r;
    const idx = this.pin >= 0 ? this.pin : this.index;
    let [x, y] = this.move(pad, idx);
    let [rx, ry] = applyDeadZone(this.axis(pad, idx, 2), this.axis(pad, idx, 3), 0.25);
    if (this.pendingLatch) {
      // After focus loss, a menu press or a cut scene: what is still held is ignored until let go.
      // Only those inputs, so a button stuck down or a drifting stick can't silence the whole pad.
      this.pendingLatch = false;
      this.latchedButtons.clear();
      for (let i = 0; i < pad.buttons.length; i++) if (GamepadSource.down(pad, i)) this.latchedButtons.add(i);
      this.latchedStick = [Math.hypot(x, y) > LATCH_STICK, Math.hypot(rx, ry) > LATCH_STICK];
    }
    for (const i of this.latchedButtons) if (!GamepadSource.down(pad, i)) this.latchedButtons.delete(i);
    if (this.latchedStick[0]) {
      if (Math.hypot(x, y) <= LATCH_STICK) this.latchedStick[0] = false;
      else [x, y] = [0, 0];
    }
    if (this.latchedStick[1]) {
      if (Math.hypot(rx, ry) <= LATCH_STICK) this.latchedStick[1] = false;
      else [rx, ry] = [0, 0];
    }
    r.sx = x;
    r.sy = -y; // gamepad y is down-positive
    const held = (i: number) => !this.latchedButtons.has(i) && GamepadSource.down(pad, i);
    for (const a of BIND_ACTIONS) {
      if (!a.pad) continue;
      if (this.bindings.pad[a.id].some(held)) (r[a.id as keyof RawState] as boolean) = true;
    }
    r.rsx = rx;
    r.rsy = -ry;
    return r;
  }

  /** Menus always use the stick/D-pad, A to confirm and B to go back, so a remap can't lock you out of them. */
  readMenu(): PadMenuState {
    const pad = this.pad();
    if (!pad) return { sx: 0, sy: 0, a: false, b: false };
    const [x, y] = this.move(pad, this.pin >= 0 ? this.pin : this.index);
    return { sx: x, sy: -y, a: GamepadSource.down(pad, 0), b: GamepadSource.down(pad, 1) };
  }

  /** Bindable buttons held right now (for capturing a new binding). */
  pressedButtons(): number[] {
    const pad = this.pad();
    if (!pad) return [];
    const out: number[] = [];
    for (let i = 0; i < Math.min(PAD_BUTTONS, pad.buttons.length); i++) if (!RESERVED_PAD.has(i) && GamepadSource.down(pad, i)) out.push(i);
    return out;
  }

  /** Any button at all held (D-pad included). */
  anyButton(): boolean {
    const pad = this.pad();
    return !!pad && pad.buttons.some((b) => b && (b.pressed || b.value > 0.5));
  }

  clear() {
    this.pendingLatch = true;
  }
}
