// The fourth visual pass (19 Nov): footprints and slide marks, floodlight banks switching on,
// flare smoke, the handheld celebration camera, faces and the fan display timing.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';
import type { ViewState } from '../src/client/view';
import { PitchMarks, strideFor } from '../src/client/render/marks';
import { bankOrder, introLights, litShare } from '../src/client/render/haze';
import { FlareSmoke, SMOKE_PUFFS } from '../src/client/render/smoke';
import { Handheld, HANDHELD, pitchsideShot } from '../src/client/render/handheld';
import { MOODS } from '../src/client/render/realplayer';
import { REFLECT_LAYER, REFLECT_SCALE, WetReflection } from '../src/client/render/wet';
import { TIFO } from '../src/client/render/tifo';
import { INTRO } from '../src/client/render/cinematic';

function liveView(seed = 5, steps = 900): { m: Match; vb: MatchViewBuilder; v: ViewState } {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed }));
  const vb = new MatchViewBuilder(m);
  for (let i = 0; i < steps; i++) { m.step(); vb.capture(); }
  return { m, vb, v: vb.build(1) };
}

describe('footprints and slide marks', () => {
  it('strides lengthen with speed, within a walking step and a sprinting one', () => {
    expect(strideFor(0)).toBeCloseTo(0.45);
    expect(strideFor(3)).toBeGreaterThan(strideFor(1));
    expect(strideFor(9)).toBeCloseTo(1.15);
    expect(strideFor(20)).toBe(1.15);
  });

  it('players running in live play leave a footprint about every stride', () => {
    const marks = new PitchMarks();
    marks.setQuality(2);
    marks.reset(true);
    let steps = 0;
    marks.onStep = () => { steps++; };
    const { m, vb } = liveView(7, 300);
    let run = 0;
    const last = new Map<number, { x: number; z: number }>();
    for (let i = 0; i < 600; i++) {
      m.step(); vb.capture();
      const v = vb.build(1);
      marks.update(v, 1 / 30);
      for (const p of v.players) {
        const l = last.get(p.id);
        if (l) { const d = Math.hypot(p.pos.x - l.x, p.pos.z - l.z); if (d < 6 && p.action.type !== 'slide') run += d; }
        last.set(p.id, { x: p.pos.x, z: p.pos.z });
      }
    }
    expect(steps).toBeGreaterThan(run / 1.3);
    expect(steps).toBeLessThan(run / 0.4);
    // Nothing on Low, and nothing while a replay shows recorded play.
    const low = new PitchMarks();
    low.setQuality(0);
    let none = 0;
    low.onStep = () => { none++; };
    for (let i = 0; i < 60; i++) { m.step(); vb.capture(); low.update(vb.build(1), 1 / 30); marks.update(vb.build(1), 1 / 30, false); }
    expect(none).toBe(0);
    marks.dispose(); low.dispose();
  });
});

describe('floodlights', () => {
  it('the banks come on one after another round the ground', () => {
    const orders = new Set<number>();
    for (let a = 0; a < 8; a++) orders.add(bankOrder(Math.cos((a + 0.5) * Math.PI / 4) * 60, Math.sin((a + 0.5) * Math.PI / 4) * 40));
    expect(orders.size).toBe(8);
    for (const o of orders) { expect(o).toBeGreaterThan(0); expect(o).toBeLessThan(1); }
    expect(litShare(0)).toBe(0);
    expect(litShare(1)).toBe(1);
    expect(litShare(0.3) * 8).toBe(Math.round(litShare(0.3) * 8));
  });

  it('switch on during the stadium fly-in, all lit before the tunnel', () => {
    expect(introLights(0)).toBe(0);
    expect(introLights(INTRO.fly * 0.4)).toBeGreaterThan(0.3);
    expect(introLights(INTRO.fly * 0.4)).toBeLessThan(0.7);
    expect(introLights(INTRO.fly * 0.7)).toBe(1);
    expect(introLights(INTRO.fly + 5)).toBe(1);
  });
});

describe('wet pitch reflection', () => {
  it('only High and Ultra draw the mirror image', () => {
    expect(REFLECT_SCALE[0]).toBe(0);
    expect(REFLECT_SCALE[1]).toBe(0);
    const w = new WetReflection();
    w.setQuality(1);
    expect(w.enabled).toBe(false);
    w.setQuality(3);
    expect(w.enabled).toBe(true);
  });
});

describe('wet pitch reflection: floodlights', () => {
  it('never mirrors lamps or their glows (they drew thick white lines across the pitch)', () => {
    const g = new THREE.Group();
    const player = new THREE.Mesh(), strip = new THREE.Mesh(), panels = new THREE.Mesh(), halo = new THREE.Sprite();
    strip.userData.lamp = 0.55; panels.userData.lamp = true; halo.userData.noReflect = true;
    g.add(player, strip, panels, halo);
    WetReflection.show(g);
    const on = (o: THREE.Object3D) => o.layers.isEnabled(REFLECT_LAYER);
    expect(on(player)).toBe(true);
    expect(on(strip) || on(panels) || on(halo)).toBe(false);
  });
});

describe('flare smoke', () => {
  const flares = [new THREE.Vector3(-70, 8, 5), new THREE.Vector3(-72, 9, -8), new THREE.Vector3(68, 8, 0)];
  it('is thick as the teams come out, then thins to a trickle, and drifts over the pitch', () => {
    const s = new FlareSmoke();
    s.setup(flares, 2);
    s.update(1 / 30, 0, true, { x: 0, z: 0 });
    expect(s.count).toBeGreaterThan(SMOKE_PUFFS[2] * 0.5);
    expect(s.count).toBeLessThanOrEqual(SMOKE_PUFFS[2]);
    for (let i = 0; i < 30 * 60; i++) s.update(1 / 30, i / 30, false, { x: 3, z: 0 });
    expect(s.count).toBeLessThan(SMOKE_PUFFS[2] * 0.5);
    expect(s.mesh.count).toBe(s.count);
  });

  it('a goal brings a surge from the scorers end', () => {
    const s = new FlareSmoke();
    s.setup(flares, 3);
    s.update(1 / 30, 0, false, { x: 0, z: 0 });
    const before = s.count;
    s.goal(1);
    for (let i = 0; i < 30 * 8; i++) s.update(1 / 30, i / 30, false, { x: 0, z: 0 });
    expect(s.count).toBeGreaterThan(before + 5);
  });

  it('none on Low or in a ground without flares', () => {
    const s = new FlareSmoke();
    s.setup(flares, 0);
    s.update(1 / 30, 0, true, { x: 0, z: 0 });
    expect(s.count).toBe(0);
    s.setup([], 3);
    s.update(1 / 30, 0, true, { x: 0, z: 0 });
    expect(s.count).toBe(0);
  });
});

describe('handheld celebration camera', () => {
  const shot = { pos: { x: 10, y: 1.6, z: 30 }, look: { x: 12, y: 1.2, z: 25 }, fov: 44, near: 0.08 };
  it('sways a few centimetres round the planned shot, never far off it', () => {
    const h = new Handheld();
    let maxPos = 0, maxRoll = 0, moved = 0;
    for (let i = 0; i < 300; i++) {
      const s = h.shake(shot, 1 / 60, 1);
      const d = Math.hypot(s.pos.x - shot.pos.x, s.pos.y - shot.pos.y, s.pos.z - shot.pos.z);
      maxPos = Math.max(maxPos, d);
      if (d > 0.005) moved++;
      maxRoll = Math.max(maxRoll, Math.abs(s.up!.x) + Math.abs(s.up!.z));
      expect(Math.abs(s.fov - shot.fov)).toBeLessThan(shot.fov * HANDHELD.zoom * 1.01);
    }
    expect(moved).toBeGreaterThan(100);
    expect(maxPos).toBeLessThan(0.15);
    expect(maxRoll).toBeGreaterThan(0.002);
    expect(maxRoll).toBeLessThan(0.03);
  });

  it('steady (k = 0) leaves the shot as it is', () => {
    const h = new Handheld();
    expect(h.shake(shot, 1 / 60, 0)).toBe(shot);
  });

  it('online, the pitchside camera finds the scorer from the nearest touchline', () => {
    const { m, vb } = liveView(9, 200);
    const sc = m.players.find((p) => p.team === 0 && p.role !== 'GK')!;
    sc.pos.x = 30; sc.pos.z = 20;
    sc.action = { type: 'celebrate', t: 0, dur: 4 };
    vb.capture();
    const v = vb.build(1);
    const st = { pos: new THREE.Vector3(), look: new THREE.Vector3(), on: false };
    const s = pitchsideShot(v, 0, st, 1 / 30)!;
    expect(s).not.toBeNull();
    expect(s.pos.z).toBeGreaterThan(34);
    expect(s.pos.y).toBeGreaterThan(1.5);
    expect(Math.hypot(s.look.x - 30, s.look.z - 20)).toBeLessThan(7);
    sc.action = { type: 'none', t: 0, dur: 0 };
    vb.capture();
    expect(pitchsideShot(vb.build(1), 0, st, 1 / 30)).toBeNull();
  });
});

describe('faces', () => {
  it('joy grins with raised brows; effort grits and knits; frustration frowns', () => {
    expect(MOODS.joy.smile).toBeGreaterThan(0.5);
    expect(MOODS.joy.brow).toBeGreaterThan(0);
    expect(MOODS.effort.grit).toBeGreaterThan(0.5);
    expect(MOODS.effort.brow).toBeLessThan(0);
    expect(MOODS.anger.smile).toBeLessThan(-0.5);
    expect(MOODS.anger.brow).toBeLessThan(-0.5);
    expect(MOODS.calm).toEqual({ brow: 0, smile: 0, squint: 0, grit: 0 });
  });
});

describe('fan display', () => {
  it('goes up over the walk-out and comes down quickly at kick-off', () => {
    expect(TIFO.rise).toBeGreaterThan(TIFO.fall);
    expect(TIFO.rise).toBeLessThan(6);
    expect(TIFO.card).toBeGreaterThan(0.4);
  });
});
