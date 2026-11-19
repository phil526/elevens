import { describe, expect, it } from 'vitest';
import { AUTO_RES_MIN, AutoRes } from '../src/client/render/autores';

/** Feed `secs` seconds of frames lasting `ms` each, starting at `t0` ms; returns the end time. */
function run(a: AutoRes, ms: number, secs: number, t0: number) {
  let t = t0;
  for (let i = 0; i < (secs * 1000) / ms; i++) { t += ms; a.feed(ms, t); }
  return t;
}

describe('auto resolution', () => {
  it('stays at full resolution at a steady 60 fps', () => {
    const a = new AutoRes();
    run(a, 16.7, 30, 0);
    expect(a.scale).toBe(1);
  });

  it('steps down while slow, but never below the floor', () => {
    const a = new AutoRes();
    run(a, 33, 3.1, 0);
    expect(a.scale).toBeCloseTo(0.8, 5);
    run(a, 33, 30, 4000);
    expect(a.scale).toBeCloseTo(AUTO_RES_MIN, 5);
  });

  it('climbs back up once frames are fast again', () => {
    const a = new AutoRes();
    let t = run(a, 33, 10, 0);
    t = run(a, 16.7, 60, t);
    expect(a.scale).toBe(1);
  });

  it('holds down for a minute when stepping up made it slow again', () => {
    const a = new AutoRes();
    let t = run(a, 33, 1.6, 0); // 0.9
    t = run(a, 16.7, 7.6, t); // back up to 0.95
    expect(a.scale).toBeCloseTo(0.95, 5);
    t = run(a, 25, 1.6, t); // slow again: 0.85 and hold
    expect(a.scale).toBeCloseTo(0.85, 5);
    t = run(a, 16.7, 40, t);
    expect(a.scale).toBeCloseTo(0.85, 5);
    run(a, 16.7, 40, t);
    expect(a.scale).toBeGreaterThan(0.85);
  });

  it('ignores one-off hitches such as loading or switching tabs', () => {
    const a = new AutoRes();
    for (let i = 0; i < 20; i++) a.feed(1000, i * 1000);
    expect(a.scale).toBe(1);
  });
});
