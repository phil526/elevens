import { describe, expect, it } from 'vitest';
import { BroadcastCamera, type CameraSettings } from '../src/client/render/camera';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import type { ViewState } from '../src/client/view';

// Just enough of a view for the camera: a loose ball in open play.
const view = (x: number, z: number) => ({
  phase: 'play', restart: null, attackDir: [1, -1], players: [],
  ball: { pos: { x, y: 0.11, z }, vel: { x: 0, y: 0, z: 0 }, owner: -1, state: 'ground', flight: null, lastTouchTeam: 0 },
}) as unknown as ViewState;

const settle = (c: BroadcastCamera, v: ViewState, s: CameraSettings) => { for (let i = 0; i < 600; i++) c.update(v, 1 / 60, s); };
const base = { height: 'standard', zoom: 'standard', reducedMotion: false } as const;

class Stick implements InputSource {
  device = 'keyboard' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() {}
}

describe('camera views', () => {
  it('tracking slides along the touchline and leaves input unrotated', () => {
    const c = new BroadcastCamera(16 / 9);
    settle(c, view(40, 0), { ...base, mode: 'tracking' });
    expect(c.cam.position.x).toBeGreaterThan(25);
    expect(c.inputYaw).toBe(0);
    expect(c.cam.fov).toBe(30);
  });

  it('broadcast stays on the halfway line, turns towards play and zooms in on the far end', () => {
    const c = new BroadcastCamera(16 / 9);
    const s = { ...base, mode: 'broadcast' as const };
    settle(c, view(0, 0), s);
    const centreFov = c.cam.fov;
    expect(c.inputYaw).toBeCloseTo(0, 3);
    settle(c, view(45, 0), s);
    expect(c.cam.position.x).toBe(0);
    expect(c.inputYaw).toBeGreaterThan(0.4); // turned right, towards +x
    expect(c.cam.fov).toBeLessThan(centreFov);
    // The camera's ground heading matches inputYaw.
    const fwd = c.cam.getWorldDirection(c.cam.position.clone());
    expect(Math.atan2(fwd.x, -fwd.z)).toBeCloseTo(c.inputYaw, 2);
    settle(c, view(-45, 0), s);
    expect(c.inputYaw).toBeLessThan(-0.4);
  });

  it('switching back to tracking restores the default lens', () => {
    const c = new BroadcastCamera(16 / 9);
    settle(c, view(45, 0), { ...base, mode: 'broadcast' });
    settle(c, view(45, 0), { ...base, mode: 'tracking' });
    expect(c.cam.fov).toBe(30);
    expect(c.inputYaw).toBe(0);
  });
});

describe('camera-relative input', () => {
  it('maps stick up to away from the camera, rotated by the camera heading', () => {
    const src = new Stick();
    const a = new ActionLayer([src]);
    src.s.sy = 1; // up
    let f = a.sample(0, { attacking: true });
    expect(f.mx).toBeCloseTo(0, 5);
    expect(f.mz).toBeCloseTo(-1, 5);
    a.yaw = Math.PI / 6; // camera turned 30° towards +x
    f = a.sample(16, { attacking: true });
    expect(f.mx).toBeCloseTo(Math.sin(Math.PI / 6), 5);
    expect(f.mz).toBeCloseTo(-Math.cos(Math.PI / 6), 5);
    src.s.sy = 0; src.s.sx = 1; // right stays perpendicular to the view
    f = a.sample(32, { attacking: true });
    expect(f.mx).toBeCloseTo(Math.cos(Math.PI / 6), 5);
    expect(f.mz).toBeCloseTo(Math.sin(Math.PI / 6), 5);
  });

  it('rotates right-stick flicks the same way', () => {
    const src = new Stick();
    const a = new ActionLayer([src]);
    a.yaw = -Math.PI / 4;
    a.sample(0, { attacking: false });
    src.s.rsy = 1;
    const f = a.sample(16, { attacking: false });
    const e = f.ev.find((x) => x.k === 'switch')!;
    expect(e.x).toBeCloseTo(Math.sin(-Math.PI / 4), 5);
    expect(e.z).toBeCloseTo(-Math.cos(-Math.PI / 4), 5);
  });
});

describe('wide and panoramic views', () => {
  const height = (mode: 'tracking' | 'wide' | 'panoramic') => {
    const c = new BroadcastCamera(16 / 9);
    settle(c, view(20, 0), { ...base, mode });
    return { y: c.cam.position.y, x: c.cam.position.x, yaw: c.inputYaw };
  };
  it('sit progressively higher than tracking, keep input unrotated, and panoramic barely slides', () => {
    const t = height('tracking'), w = height('wide'), p = height('panoramic');
    expect(w.y).toBeGreaterThan(t.y * 1.2);
    expect(p.y).toBeGreaterThan(w.y * 1.2);
    expect(w.yaw).toBe(0);
    expect(p.yaw).toBe(0);
    expect(p.x).toBeLessThan(t.x * 0.5);
  });
});
