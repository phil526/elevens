// Remappable controls: which keyboard keys and controller buttons trigger each action.
// Pure data and helpers (no DOM), so the rules are unit-tested. Movement on the left stick
// and D-pad, the right-stick flick, and menu A (confirm) / B (back) stay fixed.

import type { PadStyle } from './gamepad';

export type BindAction =
  | 'up' | 'down' | 'left' | 'right'
  | 'sprint' | 'pass' | 'shoot' | 'lob' | 'through' | 'jockey' | 'switch' | 'skill' | 'teamPress' | 'trap' | 'keeper' | 'plan' | 'pause' | 'help';

/**
 * Keyboard: up to two keys per action. Controller: up to two buttons per action (standard mapping indices).
 * Mouse: the mouse-and-keyboard layout (the mouse steers, so no movement keys): up to two inputs per
 * action, each a key code or a mouse button (`Mouse0` left, `Mouse1` middle, `Mouse2` right, `Mouse3`/`Mouse4`
 * side buttons) or a wheel turn (`WheelUp`, `WheelDown`).
 */
export interface ControlBindings {
  keys: Record<BindAction, string[]>;
  pad: Record<BindAction, number[]>;
  mouse: Record<BindAction, string[]>;
}

export type BindDevice = 'keys' | 'pad' | 'mouse';

export const KEY_SLOTS = 2;
export const PAD_SLOTS = 2;

/** Actions in the order the Controls menu lists them, with their names there. */
export const BIND_ACTIONS: { id: BindAction; name: string; pad: boolean }[] = [
  { id: 'up', name: 'Move up', pad: false },
  { id: 'down', name: 'Move down', pad: false },
  { id: 'left', name: 'Move left', pad: false },
  { id: 'right', name: 'Move right', pad: false },
  { id: 'pass', name: 'Pass / tackle', pad: true },
  { id: 'shoot', name: 'Shoot / tackle', pad: true },
  { id: 'lob', name: 'Lob, cross / slide tackle', pad: true },
  { id: 'through', name: 'Through ball / contain', pad: true },
  { id: 'sprint', name: 'Sprint', pad: true },
  { id: 'jockey', name: 'Modifier / jockey', pad: true },
  { id: 'switch', name: 'Switch player / call run', pad: true },
  { id: 'skill', name: 'Skill move / take the keeper', pad: true },
  { id: 'teamPress', name: 'Team press (defending)', pad: true },
  { id: 'trap', name: 'Offside trap (defending)', pad: true },
  { id: 'keeper', name: 'Take or leave the keeper', pad: true },
  { id: 'plan', name: 'Next game plan (live tactics)', pad: true },
  { id: 'pause', name: 'Pause / menu', pad: true },
  { id: 'help', name: 'Controls overlay', pad: true },
];

export function defaultBindings(): ControlBindings {
  return {
    keys: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
      sprint: ['ShiftLeft', 'ShiftRight'], pass: ['KeyJ'], shoot: ['KeyK', 'Space'], lob: ['KeyL'], through: ['KeyI'],
      jockey: ['KeyE'], switch: ['KeyQ'], skill: ['KeyU'], teamPress: ['KeyR'], trap: ['KeyT'], keeper: ['KeyG'], plan: ['KeyY'], pause: ['KeyP'], help: ['KeyH'],
    },
    pad: {
      up: [], down: [], left: [], right: [],
      pass: [0], lob: [1], shoot: [2], through: [3], switch: [4], sprint: [7, 5], jockey: [6],
      trap: [8], pause: [9], teamPress: [10], skill: [11], keeper: [], plan: [], help: [],
    },
    // Mouse and keyboard: point to run, left click passes, right click shoots, A long ball, S through ball.
    mouse: {
      up: [], down: [], left: [], right: [],
      pass: ['Mouse0'], shoot: ['Mouse2'], lob: ['KeyA'], through: ['KeyS'], sprint: ['ShiftLeft', 'ShiftRight'], jockey: ['KeyD'],
      switch: ['Space', 'Mouse1'], skill: ['KeyF'], teamPress: ['KeyR'], trap: ['KeyT'], keeper: ['KeyG'], plan: ['KeyY'], pause: ['KeyP'], help: ['KeyH'],
    },
  };
}

/** Mouse buttons and wheel turns a mouse binding can use. */
export const MOUSE_INPUTS = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4', 'WheelUp', 'WheelDown'];
export const isMouseInput = (c: string) => MOUSE_INPUTS.includes(c);

/** Esc always pauses (and cancels a key capture), so it can't be given to another action. */
export const RESERVED_KEYS = new Set(['Escape']);
/** D-pad (12-15) moves and Home/Xbox (16) belongs to the system, so they can't be bound. */
export const RESERVED_PAD = new Set([12, 13, 14, 15, 16]);
/** Buttons a controller binding can use. */
export const PAD_BUTTONS = 16;

const ACTION_IDS = BIND_ACTIONS.map((a) => a.id);

/** Repairs saved bindings: unknown actions dropped, missing ones defaulted, duplicates and reserved inputs removed. */
export function cleanBindings(raw: unknown): ControlBindings {
  const d = defaultBindings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as { keys?: Record<string, unknown>; pad?: Record<string, unknown>; mouse?: Record<string, unknown> };
  const out = defaultBindings();
  const seenK = new Set<string>();
  const seenP = new Set<number>();
  const seenM = new Set<string>();
  for (const id of ACTION_IDS) {
    // Mouse layout: keys and mouse buttons, no movement keys (the mouse steers). Saved data from before it existed gets the defaults.
    const mo = r.mouse?.[id];
    if (Array.isArray(mo) && BIND_ACTIONS.find((a) => a.id === id)!.pad) {
      out.mouse[id] = mo.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 40 && !RESERVED_KEYS.has(c) && !seenM.has(c)).slice(0, KEY_SLOTS);
    }
    out.mouse[id].forEach((c) => seenM.add(c));
    const k = r.keys?.[id];
    if (Array.isArray(k)) {
      out.keys[id] = k.filter((c): c is string => typeof c === 'string' && c.length > 0 && c.length < 40 && !RESERVED_KEYS.has(c) && !seenK.has(c)).slice(0, KEY_SLOTS);
    }
    out.keys[id].forEach((c) => seenK.add(c));
    const p = r.pad?.[id];
    if (Array.isArray(p) && BIND_ACTIONS.find((a) => a.id === id)!.pad) {
      out.pad[id] = p.filter((b): b is number => Number.isInteger(b) && b >= 0 && b < PAD_BUTTONS && !RESERVED_PAD.has(b) && !seenP.has(b)).slice(0, PAD_SLOTS);
    }
    out.pad[id].forEach((b) => seenP.add(b));
  }
  return out;
}

export interface BindResult {
  /** The action that already used the input, if any. */
  from?: BindAction;
  /** True when that action was given this slot's old input in exchange. */
  swapped: boolean;
  /** Actions that now have no input on this device. */
  unbound: BindAction[];
}

/**
 * Assigns an input to one slot of an action. If another action used it, the two swap: that action
 * takes this slot's previous input (or simply loses the input when the slot was empty).
 */
export function assign(b: ControlBindings, device: BindDevice, action: BindAction, slot: number, input: string | number): BindResult {
  const table = b[device] as Record<BindAction, (string | number)[]>;
  const list = table[action];
  const old = list[slot];
  let from: BindAction | undefined;
  let swapped = false;
  for (const id of ACTION_IDS) {
    const i = table[id].indexOf(input);
    if (i < 0) continue;
    if (id === action) {
      // Already on this action in the other slot: the two slots swap.
      if (old !== undefined) table[id][i] = old;
      else table[id].splice(i, 1);
      continue;
    }
    from = id;
    if (old !== undefined && old !== input) { table[id][i] = old; swapped = true; }
    else table[id].splice(i, 1);
  }
  const cur = table[action];
  if (slot < cur.length) cur[slot] = input;
  else cur.push(input);
  // Keep the list dense and without repeats.
  table[action] = cur.filter((v, i) => cur.indexOf(v) === i).slice(0, device === 'pad' ? PAD_SLOTS : KEY_SLOTS);
  return { from, swapped, unbound: unboundActions(b, device) };
}

/** Removes one slot's input. */
export function clearSlot(b: ControlBindings, device: BindDevice, action: BindAction, slot: number) {
  const table = b[device] as Record<BindAction, (string | number)[]>;
  table[action] = table[action].filter((_, i) => i !== slot);
}

/** Actions a controller has no button for by default (the pad is full): left out of the unbound warning there. */
export const PAD_OPTIONAL = new Set<BindAction>(['help', 'keeper', 'plan']);

/** Actions with nothing bound on a device (optional controller actions are left out there). */
export function unboundActions(b: ControlBindings, device: BindDevice): BindAction[] {
  return BIND_ACTIONS.filter((a) => (device === 'keys' || (device === 'mouse' ? a.pad : a.pad && !PAD_OPTIONAL.has(a.id))) && b[device][a.id].length === 0).map((a) => a.id);
}

/** Mouse layout lookup (key codes and mouse buttons → action), built from the bindings. Esc always pauses. */
export function mouseMap(b: ControlBindings): Record<string, BindAction> {
  const m: Record<string, BindAction> = { Escape: 'pause' };
  for (const id of ACTION_IDS) for (const c of b.mouse[id]) m[c] = id;
  return m;
}

/** The bindings with the mouse layout in the keyboard's place, so key labels and help text read it. */
export function mouseAsKeys(b: ControlBindings): ControlBindings {
  return { ...b, keys: b.mouse };
}

/** Keyboard code → action lookup, built from the bindings. */
export function keyMap(b: ControlBindings): Record<string, BindAction> {
  const m: Record<string, BindAction> = { Escape: 'pause' };
  for (const id of ACTION_IDS) for (const c of b.keys[id]) m[c] = id;
  return m;
}

export const sameBindings = (a: ControlBindings, b: ControlBindings) => JSON.stringify(cleanBindings(a)) === JSON.stringify(cleanBindings(b));

// ------------------------------------------------------------- labels

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
  MetaLeft: 'L Cmd', MetaRight: 'R Cmd', CapsLock: 'Caps Lock', Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  IntlBackslash: '§', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  NumpadEnter: 'Num Enter', NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
};

const MOUSE_NAMES: Record<string, string> = {
  Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', Mouse3: 'Mouse back', Mouse4: 'Mouse forward', WheelUp: 'Wheel up', WheelDown: 'Wheel down',
};

export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (MOUSE_NAMES[code]) return MOUSE_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

const PAD_NAMES: Record<PadStyle, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Xbox'],
  playstation: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'PS'],
  generic: Array.from({ length: 17 }, (_, i) => `B${i}`),
};

export function padLabel(style: PadStyle, button: number): string {
  return PAD_NAMES[style][button] ?? `B${button}`;
}

/** Label of an action's bindings for help text: "J", "K or Space", "—" when unbound. */
export function keysText(b: ControlBindings, action: BindAction): string[] {
  const l = b.keys[action].map(keyLabel);
  if (action === 'pause') l.unshift('Esc');
  return l;
}

export function padText(b: ControlBindings, style: PadStyle, action: BindAction): string[] {
  return b.pad[action].map((i) => padLabel(style, i));
}
