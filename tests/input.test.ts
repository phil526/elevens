import { describe, expect, it } from 'vitest';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { applyDeadZone, padStyle } from '../src/client/input/gamepad';
import { KeyboardState } from '../src/client/input/keyboard';
import { TouchModel } from '../src/client/input/touch';

class Fake implements InputSource {
  device = 'gamepad' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() { this.s = emptyRaw(); }
}

describe('keyboard', () => {
  it('maps WASD and arrows to a normalised screen vector', () => {
    const k = new KeyboardState();
    k.handle('KeyW', true);
    k.handle('ArrowRight', true);
    const r = k.read();
    expect(Math.hypot(r.sx, r.sy)).toBeCloseTo(1, 5);
    expect(r.sx).toBeGreaterThan(0);
    expect(r.sy).toBeGreaterThan(0);
  });
  it('opposite keys cancel', () => {
    const k = new KeyboardState();
    k.handle('KeyA', true);
    k.handle('KeyD', true);
    expect(k.read().sx).toBe(0);
  });
  it('a tap shorter than one sample still registers exactly once', () => {
    const k = new KeyboardState();
    k.handle('KeyJ', true);
    k.handle('KeyJ', false);
    expect(k.read().pass).toBe(true);
    expect(k.read().pass).toBe(false);
  });
  it('ignores unmapped keys and clears on focus loss', () => {
    const k = new KeyboardState();
    expect(k.handle('KeyZ', true)).toBe(false);
    k.handle('ShiftLeft', true);
    k.clear();
    expect(k.read().sprint).toBe(false);
  });
});

describe('action layer', () => {
  it('turns presses into one event each, not one per held frame', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.pass = true;
    const ev = [0, 1, 2].flatMap((i) => a.sample(i * 16, { attacking: false }).ev);
    expect(ev).toEqual([{ k: 'pass' }]);
  });
  it('charges a shot while held and fires on release with power', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.shoot = true;
    expect(a.sample(0, { attacking: true }).ev).toEqual([]);
    a.sample(400, { attacking: true });
    expect(a.charge(400)).toBeGreaterThan(0);
    f.s.shoot = false;
    f.s.jockey = true;
    const ev = a.sample(500, { attacking: true }).ev;
    expect(ev).toHaveLength(1);
    expect(ev[0].k).toBe('shoot');
    expect(ev[0].p).toBeGreaterThan(0.3);
    expect(ev[0].m).toBe(true); // placed-shot modifier
  });
  it('the shoot button tackles immediately when defending', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.shoot = true;
    expect(a.sample(0, { attacking: false }).ev).toEqual([{ k: 'shoot', p: 0.4 }]);
    f.s.shoot = false;
    expect(a.sample(16, { attacking: false }).ev).toEqual([]); // no second event on release
  });
  it('maps screen-up to away from the camera (-z) and merges devices', () => {
    const f1 = new Fake(), f2 = new Fake();
    const a = new ActionLayer([f1, f2]);
    f1.s.sy = 1;
    f2.s.sx = 1;
    const fr = a.sample(0, { attacking: true });
    expect(fr.mz).toBeLessThan(0);
    expect(fr.mx).toBeGreaterThan(0);
    expect(Math.hypot(fr.mx, fr.mz)).toBeLessThanOrEqual(1.0001);
  });
  it('clear() drops held movement and any half-charged shot', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.sx = 1;
    f.s.shoot = true;
    a.sample(0, { attacking: true });
    a.clear();
    expect(a.charge(100)).toBe(-1);
    const fr = a.sample(116, { attacking: true });
    expect(fr.mx).toBe(0);
    expect(fr.ev).toEqual([]);
  });
  it('sends no movement or actions while disabled (menus, goal celebrations)', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.sx = 1;
    f.s.pass = true;
    const fr = a.sample(0, { attacking: true }, false);
    expect(fr.mx).toBe(0);
    expect(fr.ev).toEqual([]);
  });
});

describe('gamepad', () => {
  it('applies a radial dead zone and rescales', () => {
    expect(applyDeadZone(0.1, 0.1)).toEqual([0, 0]);
    const [x] = applyDeadZone(1, 0);
    expect(x).toBeCloseTo(1, 5);
    const [h] = applyDeadZone(0.59, 0);
    expect(h).toBeCloseTo(0.5, 2);
  });
  it('recognises controller families for button labels', () => {
    expect(padStyle('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)')).toBe('xbox');
    expect(padStyle('DualSense Wireless Controller (Vendor: 054c)')).toBe('playstation');
    expect(padStyle('Unknown pad')).toBe('generic');
  });
});

describe('touch', () => {
  it('tracks the stick and a button on different fingers at the same time', () => {
    const t = new TouchModel();
    t.stickDown(1, 100, 100);
    t.move(1, 160, 100);
    t.buttonDown(2, 'sprint');
    t.buttonDown(3, 'a');
    const r = t.read();
    expect(r.sx).toBeCloseTo(1, 5);
    expect(r.sprint && r.pass).toBe(true);
    t.up(2);
    const r2 = t.read();
    expect(r2.sprint).toBe(false);
    expect(r2.pass).toBe(true);
    expect(r2.sx).toBeCloseTo(1, 5);
  });
  it('relabels buttons when defending', () => {
    const t = new TouchModel();
    t.attacking = false;
    t.buttonDown(1, 'c');
    t.buttonDown(2, 'd');
    const r = t.read();
    expect(r.jockey).toBe(true);
    expect(r.switch).toBe(true);
  });
  it('the small row calls a run and shields with the ball, and rushes, presses and traps without it', () => {
    const t = new TouchModel();
    t.buttonDown(1, 'f');
    t.buttonDown(2, 'g');
    t.buttonDown(3, 'h'); // no attacking action: ignored
    let r = t.read();
    expect(r.switch && r.jockey).toBe(true);
    expect(r.trap || r.teamPress).toBe(false);
    t.clear();
    t.attacking = false;
    t.buttonDown(1, 'f');
    t.buttonDown(2, 'g');
    t.buttonDown(3, 'h');
    r = t.read();
    expect(r.skill && r.teamPress && r.trap).toBe(true);
    expect(r.switch || r.jockey).toBe(false);
  });
  it('a quick tap still counts and lifting a finger releases only that finger', () => {
    const t = new TouchModel();
    t.buttonDown(1, 'b');
    t.up(1);
    expect(t.read().shoot).toBe(true);
    expect(t.read().shoot).toBe(false);
  });
  it('a small wobble is inside the stick dead zone', () => {
    const t = new TouchModel();
    t.stickDown(1, 100, 100);
    t.move(1, 103, 102);
    expect(t.read().sx).toBe(0);
  });
});

describe('new controls', () => {
  it('a right-stick flick is a skill move with the ball and a directed switch without, once per flick', () => {
    const pad = new Fake();
    const a = new ActionLayer([pad]);
    pad.s = { ...emptyRaw(), rsx: 0.9, rsy: 0 };
    const f1 = a.sample(0, { attacking: true });
    expect(f1.ev).toEqual([{ k: 'skill', x: 1, z: 0 }]);
    expect(a.sample(16, { attacking: true }).ev).toEqual([]); // still held: no repeat
    pad.s = emptyRaw();
    a.sample(32, { attacking: false });
    pad.s = { ...emptyRaw(), rsx: 0, rsy: 0.95 };
    const f2 = a.sample(48, { attacking: false });
    expect(f2.ev[0].k).toBe('switch');
    expect(f2.ev[0].z).toBeCloseTo(-1, 5); // screen up = away from the camera (-z)
  });
  it('holding through without the ball asks for contain; with the ball it does not', () => {
    const pad = new Fake();
    const a = new ActionLayer([pad]);
    pad.s = { ...emptyRaw(), through: true };
    expect(a.sample(0, { attacking: false }).contain).toBe(true);
    expect(a.sample(16, { attacking: true }).contain).toBe(false);
  });
  it('a click on the pitch is sent as a switch to that point with the next sample', () => {
    const a = new ActionLayer([new Fake()]);
    a.switchAt(12, -4);
    expect(a.sample(0, { attacking: false }).ev).toEqual([{ k: 'switch', x: 12, z: -4, at: true }]);
    expect(a.sample(16, { attacking: false }).ev).toEqual([]);
  });
  it('U is the skill key; touch has SKILL when attacking and SLIDE/CONTAIN when defending', () => {
    const k = new KeyboardState();
    k.handle('KeyU', true);
    expect(k.read().skill).toBe(true);
    const t = new TouchModel();
    t.attacking = true;
    t.buttonDown(1, 'e');
    expect(t.read().skill).toBe(true);
    t.up(1);
    t.attacking = false;
    t.buttonDown(2, 'b');
    expect(t.read().lob).toBe(true); // lob without the ball = slide tackle
    t.up(2);
    t.buttonDown(3, 'e');
    expect(t.read().through).toBe(true); // held through without the ball = contain
  });
});
