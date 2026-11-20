import { describe, expect, it } from 'vitest';
import { assign, cleanBindings, clearSlot, defaultBindings, keyLabel, keyMap, padLabel, unboundActions } from '../src/client/input/bindings';
import { GamepadSource } from '../src/client/input/gamepad';
import { KeyboardState } from '../src/client/input/keyboard';
import { controlsTable, guideLine } from '../src/client/ui/controls';

const fakePad = () => ({ connected: true, id: 'Xbox Wireless Controller', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });

describe('control bindings', () => {
  it('defaults match the old fixed layout', () => {
    const m = keyMap(defaultBindings());
    expect(m.KeyJ).toBe('pass');
    expect(m.Space).toBe('shoot');
    expect(m.Escape).toBe('pause');
    expect(m.ArrowUp).toBe('up');
    expect(defaultBindings().pad.sprint).toEqual([7]);
    expect(defaultBindings().pad.close).toEqual([5]); // RB: close control (19 Nov 2026)
  });
  it('a key already in use swaps with the slot being changed', () => {
    const b = defaultBindings();
    const r = assign(b, 'keys', 'pass', 0, 'KeyK'); // K was shoot
    expect(r.from).toBe('shoot');
    expect(r.swapped).toBe(true);
    expect(b.keys.pass).toEqual(['KeyK']);
    expect(b.keys.shoot).toEqual(['KeyJ', 'Space']);
    expect(r.unbound).toEqual([]);
  });
  it('filling an empty slot takes the input from the other action', () => {
    const b = defaultBindings();
    const r = assign(b, 'keys', 'pass', 1, 'KeyL'); // pass had one key, L was lob
    expect(b.keys.pass).toEqual(['KeyJ', 'KeyL']);
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
    clearSlot(b, 'keys', 'shoot', 0);
    expect(b.keys.shoot).toEqual(['Space']);
    clearSlot(b, 'pad', 'pass', 0);
    expect(unboundActions(b, 'pad')).toEqual(['pass']);
  });
  it('repairs saved data: reserved and duplicate inputs dropped, missing actions defaulted', () => {
    const c = cleanBindings({ keys: { pass: ['KeyK', 'Escape'], shoot: ['KeyK', 'Space'], bogus: ['KeyZ'] }, pad: { pass: [12, 3], through: [3, 99] } });
    expect(c.keys.pass).toEqual(['KeyK']);
    expect(c.keys.shoot).toEqual(['Space']);
    expect(c.keys.lob).toEqual(['KeyL']);
    expect(c.pad.pass).toEqual([3]);
    expect(c.pad.through).toEqual([]);
    expect(cleanBindings('nonsense')).toEqual(defaultBindings());
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
