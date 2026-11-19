import { describe, expect, it } from 'vitest';
import { ActionLayer } from '../src/client/input/actions';
import { assign, cleanBindings, defaultBindings, keyLabel, mouseMap, unboundActions } from '../src/client/input/bindings';
import { MouseSource, steer, STEER_DEAD, STEER_FULL } from '../src/client/input/mouse';
import { controlsTable, guideLine } from '../src/client/ui/controls';
import { loadSettings } from '../src/client/settings';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);

describe('mouse steering', () => {
  it('runs towards the pointer, whatever the camera heading', () => {
    const layer = new ActionLayer([]);
    for (const yaw of [0, 0.4, -1.1, Math.PI / 2, 2.8]) {
      layer.yaw = yaw;
      const st = steer({ x: 3, z: -2 }, { x: 13, z: 5 }, yaw);
      const [wx, wz] = layer.toWorld(st.sx, st.sy);
      const l = Math.hypot(wx, wz);
      near(l, 1);
      near(wx / l, 10 / Math.hypot(10, 7));
      near(wz / l, 7 / Math.hypot(10, 7));
    }
  });
  it('stands still on the pointer and builds to a full run with distance', () => {
    expect(steer({ x: 0, z: 0 }, { x: STEER_DEAD * 0.9, z: 0 }, 0)).toEqual({ sx: 0, sy: 0 });
    const mid = steer({ x: 0, z: 0 }, { x: (STEER_DEAD + STEER_FULL) / 2, z: 0 }, 0);
    expect(Math.hypot(mid.sx, mid.sy)).toBeGreaterThan(0.3);
    expect(Math.hypot(mid.sx, mid.sy)).toBeLessThan(0.7);
    const far = steer({ x: 0, z: 0 }, { x: 0, z: 30 }, 0);
    near(Math.hypot(far.sx, far.sy), 1);
    // Camera looking along -z (yaw 0): +z on the pitch is towards the camera, i.e. screen down.
    expect(far.sy).toBeLessThan(-0.99);
  });
  it('no pointer or no player: no movement', () => {
    const m = new MouseSource();
    m.from = { x: 0, z: 0 };
    expect(m.read().sx).toBe(0);
    m.cursor = { x: 10, z: 0 };
    m.from = null;
    expect(m.read().sx).toBe(0);
    m.from = { x: 0, z: 0 };
    expect(m.read().sx).toBeCloseTo(1, 5);
  });
});

describe('mouse layout', () => {
  it('defaults: left click pass, right click shoot, A long ball, S through ball, no movement keys', () => {
    const m = mouseMap(defaultBindings());
    expect(m.Mouse0).toBe('pass');
    expect(m.Mouse2).toBe('shoot');
    expect(m.KeyA).toBe('lob');
    expect(m.KeyS).toBe('through');
    expect(m.ShiftLeft).toBe('sprint');
    expect(m.Space).toBe('switch');
    expect(m.Mouse1).toBe('switch');
    expect(m.Escape).toBe('pause');
    expect(m.KeyW).toBeUndefined();
    expect(unboundActions(defaultBindings(), 'mouse')).toEqual([]);
    // Every default is a different input.
    const all = Object.values(defaultBindings().mouse).flat();
    expect(new Set(all).size).toBe(all.length);
  });
  it('mouse buttons and keys read as actions; the pointer steers', () => {
    const m = new MouseSource();
    m.handle('Mouse0', true);
    m.handle('KeyA', true);
    m.handle('KeyW', true); // not in the mouse layout
    const r = m.read();
    expect(r.pass).toBe(true);
    expect(r.lob).toBe(true);
    expect(r.sy).toBe(0);
    expect(m.handle('KeyW', true)).toBe(false);
  });
  it('a click charges a pass and releases it the way the pointer is', () => {
    const m = new MouseSource();
    m.from = { x: 0, z: 0 };
    m.cursor = { x: 20, z: 0 };
    const layer = new ActionLayer([m]);
    layer.sample(0, { attacking: true });
    m.handle('Mouse0', true);
    layer.sample(16, { attacking: true });
    expect(layer.charging(300)?.kind).toBe('pass');
    m.handle('Mouse0', false);
    const f = layer.sample(450, { attacking: true });
    expect(f.ev[0]?.k).toBe('pass');
    expect(f.ev[0]?.p).toBeGreaterThan(0.3);
    near(f.mx, 1);
    near(f.mz, 0);
    expect(layer.lastDevice).toBe('mouse');
  });
  it('right click shoots; A held with it chips; S on its own is a through ball', () => {
    const m = new MouseSource();
    const layer = new ActionLayer([m]);
    layer.sample(0, { attacking: true });
    m.handle('KeyA', true);
    layer.sample(16, { attacking: true });
    m.handle('Mouse2', true);
    layer.sample(32, { attacking: true });
    m.handle('Mouse2', false);
    m.handle('KeyA', false);
    const f = layer.sample(500, { attacking: true });
    expect(f.ev.find((e) => e.k === 'shoot')?.v).toBe('chip');
    m.handle('KeyS', true);
    layer.sample(600, { attacking: true });
    m.handle('KeyS', false);
    expect(layer.sample(700, { attacking: true }).ev[0]?.k).toBe('through');
  });
  it('defending: left click tackles at once, A slides, S contains while held', () => {
    const m = new MouseSource();
    const layer = new ActionLayer([m]);
    m.handle('Mouse0', true);
    expect(layer.sample(0, { attacking: false }).ev[0]?.k).toBe('pass');
    m.handle('KeyS', true);
    expect(layer.sample(16, { attacking: false }).contain).toBe(true);
  });
  it('a wheel turn is one press', () => {
    const b = defaultBindings();
    assign(b, 'mouse', 'switch', 1, 'WheelDown');
    const m = new MouseSource(b);
    m.handle('WheelDown', true);
    m.handle('WheelDown', false);
    expect(m.read().switch).toBe(true);
    expect(m.read().switch).toBe(false);
  });
  it('remaps with swaps like the other devices, and old saves get the defaults', () => {
    const b = defaultBindings();
    const r = assign(b, 'mouse', 'pass', 0, 'Mouse2'); // right click to pass
    expect(r.from).toBe('shoot');
    expect(b.mouse.shoot).toEqual(['Mouse0']);
    const old = cleanBindings({ keys: defaultBindings().keys, pad: defaultBindings().pad });
    expect(old.mouse).toEqual(defaultBindings().mouse);
    const c = cleanBindings({ mouse: { pass: ['Mouse2', 'Escape'], shoot: ['Mouse2'], up: ['KeyW'] } });
    expect(c.mouse.pass).toEqual(['Mouse2']);
    expect(c.mouse.shoot).toEqual([]);
    expect(c.mouse.up).toEqual([]);
  });
  it('labels and help text', () => {
    expect(keyLabel('Mouse0')).toBe('Left click');
    expect(keyLabel('Mouse2')).toBe('Right click');
    expect(keyLabel('WheelUp')).toBe('Wheel up');
    const g = guideLine('mouse', 'xbox', true, defaultBindings());
    expect(g).toContain('Left click');
    expect(g).toContain('Right click');
    expect(g).toContain('Long ball');
    const t = controlsTable('xbox', defaultBindings(), true);
    expect(t).toContain('<th>Mouse</th>');
    expect(t).toContain('Point where to run');
    expect(controlsTable('xbox', defaultBindings())).not.toContain('<th>Mouse</th>');
  });
  it('mouse control is off by default', () => {
    expect(loadSettings().mouseControl).toBe(false);
  });
});
