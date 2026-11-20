import { describe, expect, it } from 'vitest';
import { assign, cleanBindings, clearSlot, defaultBindings, keyLabel, keyMap, migrateKeysNov20, OLD_DEFAULT_KEYS_NOV20, padLabel, unboundActions } from '../src/client/input/bindings';
import { GamepadSource } from '../src/client/input/gamepad';
import { KeyboardState } from '../src/client/input/keyboard';
import { controlsTable, guideLine } from '../src/client/ui/controls';

const fakePad = () => ({ connected: true, id: 'Xbox Wireless Controller', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });

describe('control bindings', () => {
  it("defaults are Philip's keyboard layout (20 Nov 2026)", () => {
    const m = keyMap(defaultBindings());
    expect(m.KeyJ).toBe('pass');
    expect(m.KeyL).toBe('shoot');
    expect(m.KeyK).toBe('lob');
    expect(m.KeyO).toBe('through');
    expect(m.KeyE).toBe('jockey');
    expect(m.KeyI).toBe('switch');
    expect(m.KeyU).toBe('skill');
    expect(m.ShiftRight).toBe('sprint');
    expect(m.Space).toBeUndefined();
    expect(m.KeyQ).toBeUndefined();
    expect(m.Escape).toBe('pause');
    expect(m.ArrowUp).toBe('up');
    expect(defaultBindings().pad.sprint).toEqual([7]);
    expect(defaultBindings().pad.close).toEqual([5]); // RB: close control (19 Nov 2026)
  });
  it('a key already in use swaps with the slot being changed', () => {
    const b = defaultBindings();
    const r = assign(b, 'keys', 'pass', 0, 'KeyL'); // L was shoot
    expect(r.from).toBe('shoot');
    expect(r.swapped).toBe(true);
    expect(b.keys.pass).toEqual(['KeyL']);
    expect(b.keys.shoot).toEqual(['KeyJ']);
    expect(r.unbound).toEqual([]);
  });
  it('filling an empty slot takes the input from the other action', () => {
    const b = defaultBindings();
    const r = assign(b, 'keys', 'pass', 1, 'KeyK'); // pass had one key, K was lob
    expect(b.keys.pass).toEqual(['KeyJ', 'KeyK']);
    expect(b.keys.lob).toEqual([]);
    expect(r.swapped).toBe(false);
    expect(r.unbound).toEqual(['lob']);
  });
  it('controller buttons swap the same way and moving within an action swaps slots', () => {
    const b = defaultBindings();
    assign(b, 'pad', 'shoot', 0, 0); // A to shoot, X to pass
    expect(b.pad.shoot).toEqual([0]);
    expect(b.pad.pass).toEqual([2]);
    b.pad.sprint = [7, 5]; b.pad.close = [];
    assign(b, 'pad', 'sprint', 0, 5); // RB into the first sprint slot
    expect(b.pad.sprint).toEqual([5, 7]);
  });
  it('clearing removes one slot', () => {
    const b = defaultBindings();
    clearSlot(b, 'keys', 'up', 0);
    expect(b.keys.up).toEqual(['ArrowUp']);
    clearSlot(b, 'pad', 'pass', 0);
    expect(unboundActions(b, 'pad')).toEqual(['pass']);
  });
  it('repairs saved data: reserved and duplicate inputs dropped, missing actions defaulted', () => {
    const c = cleanBindings({ keys: { pass: ['KeyK', 'Escape'], shoot: ['KeyK', 'Space'], bogus: ['KeyZ'] }, pad: { pass: [12, 3], through: [3, 99] } });
    expect(c.keys.pass).toEqual(['KeyK']);
    expect(c.keys.shoot).toEqual(['Space']);
    expect(c.keys.lob).toEqual([]); // its default K is already pass in this table
    expect(c.keys.through).toEqual(['KeyO']);
    expect(c.pad.pass).toEqual([3]);
    expect(c.pad.through).toEqual([]);
    expect(cleanBindings('nonsense')).toEqual(defaultBindings());
  });
  it('keys saved on the old defaults move to the new layout once; changed tables are kept', () => {
    const old = cleanBindings({ keys: JSON.parse(JSON.stringify(OLD_DEFAULT_KEYS_NOV20)), pad: defaultBindings().pad });
    old.pad.pass = [1]; old.pad.lob = [0]; // the controller table is left alone
    expect(migrateKeysNov20(old)).toBe(true);
    expect(old.keys).toEqual(defaultBindings().keys);
    expect(old.pad.pass).toEqual([1]);
    const mine = cleanBindings({ keys: { ...JSON.parse(JSON.stringify(OLD_DEFAULT_KEYS_NOV20)), shoot: ['KeyK'] } });
    expect(migrateKeysNov20(mine)).toBe(false);
    expect(mine.keys.shoot).toEqual(['KeyK']);
    expect(mine.keys.switch).toEqual(['KeyQ']);
    // Old saves from before an action existed are filled in, then still count as the old defaults.
    const older = JSON.parse(JSON.stringify(OLD_DEFAULT_KEYS_NOV20)); delete older.close; delete older.plan;
    const c = cleanBindings({ keys: older });
    expect(migrateKeysNov20(c)).toBe(true);
    expect(c.keys.shoot).toEqual(['KeyL']);
    expect(migrateKeysNov20(defaultBindings())).toBe(false);
  });
  it('labels keys and buttons', () => {
    expect(keyLabel('KeyJ')).toBe('J');
    expect(keyLabel('ShiftLeft')).toBe('L Shift');
    expect(keyLabel('Digit7')).toBe('7');
    expect(padLabel('xbox', 5)).toBe('RB');
    expect(padLabel('playstation', 0)).toBe('✕');
  });
});

describe('remapped devices', () => {
  it('the keyboard follows new bindings', () => {
    const b = defaultBindings();
    assign(b, 'keys', 'pass', 0, 'KeyZ');
    const k = new KeyboardState();
    k.setBindings(b);
    expect(k.handle('KeyJ', true)).toBe(false);
    k.handle('KeyZ', true);
    expect(k.read().pass).toBe(true);
    k.handle('Escape', true);
    expect(k.read().pause).toBe(true);
  });
  it('the controller follows new bindings but menus keep A and B', () => {
    const pad = fakePad();
    const g = new GamepadSource(() => [pad]);
    g.bindings = defaultBindings();
    assign(g.bindings, 'pad', 'shoot', 0, 0); // A shoots, X passes
    pad.buttons[0].pressed = true;
    const r = g.read();
    expect(r.shoot).toBe(true);
    expect(r.pass).toBe(false);
    expect(g.readMenu().a).toBe(true);
    expect(g.pressedButtons()).toEqual([0]);
    g.muted = true;
    expect(g.read().shoot).toBe(false);
  });
  it('the D-pad and Xbox button are never captured as bindings', () => {
    const pad = fakePad();
    const g = new GamepadSource(() => [pad]);
    pad.buttons[13].pressed = true;
    pad.buttons[16].pressed = true;
    expect(g.pressedButtons()).toEqual([]);
    expect(g.anyButton()).toBe(true);
    expect(g.readMenu().sy).toBe(-1);
  });
  it('help text shows the new keys and buttons', () => {
    const b = defaultBindings();
    assign(b, 'keys', 'pass', 0, 'KeyZ');
    assign(b, 'pad', 'pass', 0, 5);
    expect(controlsTable('xbox', b)).toContain('<kbd>Z</kbd>');
    expect(guideLine('keyboard', 'xbox', true, b)).toContain('<kbd>Z</kbd> Pass');
    expect(guideLine('gamepad', 'xbox', true, b)).toContain('<kbd>RB</kbd> Pass');
  });
});
