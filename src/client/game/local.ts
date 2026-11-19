// Local multiplayer (same device): which controller or keyboard half plays for which side.
// Pure seat logic here (unit-tested); the app builds an ActionLayer per seat.

import { emptyRaw, type InputSource, type RawState } from '../input/actions';
import type { BindAction } from '../input/bindings';

/** A device that can take a seat: the whole keyboard, one half of it, a controller (by Gamepad API index) or the touch screen. */
export interface LocalDevice {
  id: string; // 'keys' | 'keysL' | 'keysR' | 'touch' | 'pad0'..'pad3'
  kind: 'keys' | 'keysL' | 'keysR' | 'touch' | 'pad';
  pad?: number;
  name: string;
}

/** -1 home, 0 not playing, +1 away (where the token sits on the Choose sides screen). */
export type SidePick = -1 | 0 | 1;

export interface Seat {
  device: LocalDevice;
  /** 1..4: the marker number (P1 yellow, P2 cyan, P3 green, P4 pink). */
  player: number;
  team: 0 | 1;
  /** 0 the side's first human, 1 the co-op second. */
  slot: 0 | 1;
}

/** Most humans on one side: the team's main control plus one co-op mate. */
export const MAX_PER_SIDE = 2;

/** Devices in the order players are numbered: controllers first (P1 is the first pad), then the keyboard, then touch. */
export function listDevices(pads: number[], keyboard: boolean, split: boolean, touch: boolean): LocalDevice[] {
  const out: LocalDevice[] = pads.slice(0, 4).map((i, n) => ({ id: `pad${i}`, kind: 'pad', pad: i, name: `Controller ${n + 1}` }));
  if (keyboard) {
    if (split) out.push({ id: 'keysL', kind: 'keysL', name: 'Keyboard left (WASD)' }, { id: 'keysR', kind: 'keysR', name: 'Keyboard right (arrows)' });
    else out.push({ id: 'keys', kind: 'keys', name: 'Keyboard' });
  }
  if (touch) out.push({ id: 'touch', kind: 'touch', name: 'Touch screen' });
  return out;
}

/** Moves a device's token one step left (-1) or right (+1); a side that already has two humans is skipped over. */
export function moveToken(picks: Record<string, SidePick>, id: string, step: -1 | 1): Record<string, SidePick> {
  const cur = picks[id] ?? 0;
  let to = Math.max(-1, Math.min(1, cur + step)) as SidePick;
  if (to !== 0 && to !== cur && Object.entries(picks).filter(([k, v]) => k !== id && v === to).length >= MAX_PER_SIDE) to = cur;
  return { ...picks, [id]: to };
}

/** Seats for the devices that picked a side, numbered in device order; at most two a side. */
export function seatsFor(devices: LocalDevice[], picks: Record<string, SidePick>): Seat[] {
  const seats: Seat[] = [];
  const per = [0, 0];
  let n = 0;
  for (const d of devices) {
    const p = picks[d.id] ?? 0;
    if (p === 0) continue;
    const team = p < 0 ? 0 : 1;
    if (per[team] >= MAX_PER_SIDE) continue;
    seats.push({ device: d, player: ++n, team, slot: per[team] as 0 | 1 });
    per[team]++;
  }
  return seats;
}

/** What the seats make: versus (humans both sides), co-op v computer, or one human. */
export function localKind(seats: Seat[]): 'versus' | 'coop' | 'single' | 'none' {
  if (!seats.length) return 'none';
  const home = seats.some((s) => s.team === 0), away = seats.some((s) => s.team === 1);
  if (home && away) return 'versus';
  return seats.length > 1 ? 'coop' : 'single';
}

/** Starting picks for a fresh screen: the first device plays home, the second away, the rest wait in the middle. */
export function defaultPicks(devices: LocalDevice[]): Record<string, SidePick> {
  const out: Record<string, SidePick> = {};
  devices.forEach((d, i) => { out[d.id] = i === 0 ? -1 : i === 1 ? 1 : 0; });
  return out;
}

/**
 * Two players on one keyboard: fixed layouts for the left hand pair (WASD) and the right hand pair
 * (arrows). Esc pauses for everyone (handled separately), so neither half has a pause key.
 */
export const SPLIT_KEYS: Record<'left' | 'right', Partial<Record<BindAction, string[]>>> = {
  left: {
    up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], sprint: ['ShiftLeft'],
    pass: ['KeyF'], shoot: ['KeyG'], lob: ['KeyR'], through: ['KeyT'], jockey: ['KeyE'], switch: ['KeyQ'], skill: ['KeyC'], teamPress: ['KeyX'], trap: ['KeyZ'], keeper: ['KeyV'],
  },
  right: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], sprint: ['ShiftRight', 'Numpad0'],
    pass: ['KeyK', 'Numpad1'], shoot: ['KeyL', 'Numpad2'], lob: ['KeyO', 'Numpad4'], through: ['KeyP', 'Numpad5'], jockey: ['KeyI', 'Numpad6'], switch: ['KeyJ', 'Numpad3'], skill: ['KeyM'], teamPress: ['KeyN'], trap: ['KeyB'], keeper: ['KeyU'],
  },
};

/** Key code to action for one half of a split keyboard. */
export function splitKeyMap(side: 'left' | 'right'): Record<string, BindAction> {
  const m: Record<string, BindAction> = {};
  for (const [a, codes] of Object.entries(SPLIT_KEYS[side])) for (const c of codes ?? []) m[c] = a as BindAction;
  return m;
}

/** The pause key on its own, for a local match whichever devices are seated (pads pause with Start). */
export class PauseKeySource implements InputSource {
  device = 'keyboard' as const;
  private down = false;
  private latched = false;
  handle(code: string, isDown: boolean) {
    if (code !== 'Escape') return;
    if (isDown) { this.down = true; this.latched = true; } else this.down = false;
  }
  read(): RawState {
    const r = emptyRaw();
    r.pause = this.down || this.latched;
    this.latched = false;
    return r;
  }
  clear() { this.down = false; this.latched = false; }
}
