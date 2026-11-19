import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';
import { KitWear, PitchWear, playedShare, sweatLevel } from '../src/client/render/wear';
import { SLOW_MO, SlowMo } from '../src/client/slowmo';
import { crossShadowFor, MASTS } from '../src/client/render/vfx';
import { SIM } from '../src/shared/config';

describe('pitch and kit wear', () => {
  it('wears the turf where players run, and only turns it to mud when wet', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 5 }));
    const vb = new MatchViewBuilder(m);
    const dry = new PitchWear(), wet = new PitchWear(), kits = new KitWear();
    for (let i = 0; i < 60 * 60; i++) {
      m.step(); vb.capture();
      const v = vb.build(1);
      dry.update(v, SIM.dt, 0); wet.update(v, SIM.dt, 1); kits.update(v, SIM.dt, 1, wet);
    }
    let wd = 0, md = 0, mw = 0;
    for (let x = -50; x <= 50; x += 1) for (let z = -32; z <= 32; z += 1) { wd += dry.at(x, z).wear; md += dry.at(x, z).mud; mw += wet.at(x, z).mud; }
    expect(wd).toBeGreaterThan(5);
    expect(md).toBe(0);
    expect(mw).toBeGreaterThan(0);
    expect(kits.state.some((s) => s.mud > 0.02)).toBe(true);
  });

  it('a slide leaves a streak along its direction', () => {
    const pw = new PitchWear();
    pw.stamp(10, 5, 0.55, 0, 1.4, 0.32, 1, 0);
    expect(pw.at(10, 5).wear).toBeGreaterThan(0.15);
    expect(pw.at(11, 5).wear).toBeGreaterThan(pw.at(10, 6).wear);
  });

  it('sweat builds over the match and with tiredness; substitutes start clean', () => {
    expect(sweatLevel(0, { stamina: 1, role: 'RCM' })).toBe(0);
    expect(sweatLevel(0.9, { stamina: 0.4, role: 'RCM' })).toBeGreaterThan(sweatLevel(0.3, { stamina: 1, role: 'RCM' }));
    expect(sweatLevel(1, { stamina: 0, role: 'GK' })).toBeLessThan(0.4);
    expect(playedShare({ clock: 45 * 60 })).toBeCloseTo(0.5);
    const kw = new KitWear();
    kw.get(3).mud = 0.8;
    kw.fresh(3, { clock: 60 * 60 } as never);
    expect(kw.get(3).mud).toBe(0);
    expect(kw.get(3).since).toBeCloseTo(2 / 3);
  });
});

describe('floodlight shadows', () => {
  it('the nearest light gives the darkest, shortest shadow', () => {
    const p = { x: 40, z: 25 };
    const ds = MASTS.map(([mx, mz]) => Math.hypot(p.x - mx, p.z - mz));
    const near = Math.min(...ds);
    const sh = MASTS.map(([mx, mz]) => crossShadowFor(p.x, p.z, mx, mz, near));
    const iNear = ds.indexOf(near), iFar = ds.indexOf(Math.max(...ds));
    expect(sh[iNear].alpha).toBe(1);
    expect(sh[iFar].alpha).toBeLessThan(0.7);
    expect(sh[iFar].len).toBeGreaterThan(sh[iNear].len);
  });
});

describe('slow motion', () => {
  it('holds at the slow speed, eases back to full speed, then ends', () => {
    const s = new SlowMo();
    s.start(SLOW_MO.goal);
    expect(s.scale(0.1)).toBe(SLOW_MO.goal.speed);
    let k = 0;
    for (let t = 0; t < SLOW_MO.goal.hold + SLOW_MO.goal.ease + 0.2; t += 0.1) k = s.scale(0.1);
    expect(k).toBe(1);
    expect(s.active).toBe(false);
  });
  it('a woodwork moment does not cut short a goal slow-down', () => {
    const s = new SlowMo();
    s.start(SLOW_MO.goal);
    s.scale(0.2);
    s.start(SLOW_MO.woodwork);
    expect(s.scale(0.1)).toBe(SLOW_MO.goal.speed);
  });
});
