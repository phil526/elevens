// 20 Nov visual picks: sharper picture, kits that react to the weather and the match, TV cutaways.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder, type ViewState } from '../src/client/view';
import { ALL_CLUBS } from '../src/shared/teams';
import { SHARPEN, sharpenFor } from '../src/client/render/sharp';
import { KIT_WEATHER, KitWear, gearFor, kitRoll, lateLook } from '../src/client/render/wear';
import { CUTAWAY, CUT_CHANCE, CutawayDirector, cutawayAt, cutawayLength, planCutaway } from '../src/client/render/cutaway';
import { defaultSettings } from '../src/client/settings';

function liveView(seed = 3, steps = 600): ViewState {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed }));
  const vb = new MatchViewBuilder(m);
  for (let i = 0; i < steps; i++) { m.step(); vb.capture(); }
  return vb.build(1);
}

const names = ALL_CLUBS.flatMap((t) => t.players.map((p) => p.name));

describe('sharper picture', () => {
  it('is on by default and sharpens lower qualities (and lower resolutions) more', () => {
    expect(defaultSettings().graphics.sharpen).not.toBe(false);
    expect(sharpenFor('low')).toBeGreaterThan(sharpenFor('medium'));
    expect(sharpenFor('medium')).toBeGreaterThan(sharpenFor('high'));
    expect(sharpenFor('high')).toBeGreaterThanOrEqual(sharpenFor('ultra'));
    expect(sharpenFor('medium', 0.75)).toBeGreaterThan(sharpenFor('medium', 1));
    expect(sharpenFor('low', 0.1)).toBe(SHARPEN.max);
  });
});

describe('kits react to the weather and the match', () => {
  it('cold matches bring out long sleeves, gloves and tights for some players, the same each time', () => {
    const count = (cold: boolean, snow: boolean) => {
      const g = names.map((n) => gearFor(n, false, cold, snow));
      return { sleeves: g.filter((x) => x.sleeves).length / g.length, gloves: g.filter((x) => x.gloves).length / g.length, tights: g.filter((x) => x.tights).length / g.length };
    };
    const warm = count(false, false), night = count(true, false), snow = count(true, true);
    expect(warm.gloves).toBe(0);
    expect(warm.tights).toBe(0);
    expect(warm.sleeves).toBeGreaterThan(0.04);
    expect(warm.sleeves).toBeLessThan(0.22);
    expect(night.sleeves).toBeGreaterThan(warm.sleeves + 0.2);
    expect(night.gloves).toBeGreaterThan(0.1);
    expect(snow.gloves).toBeGreaterThan(night.gloves + 0.15);
    expect(snow.tights).toBeGreaterThan(night.tights);
    expect(gearFor(names[4], false, true, true)).toEqual(gearFor(names[4], false, true, true));
    // Keepers already wear gloves; plenty of them wear long sleeves.
    expect(names.slice(0, 40).every((n) => gearFor(n, true, true, true).gloves === 0)).toBe(true);
    expect(names.filter((n) => gearFor(n, true, false, false).sleeves).length / names.length).toBeGreaterThan(0.45);
  });

  it('shirts come out and socks come down late in the match, more and sooner when tired; keepers stay tidy', () => {
    const at = (played: number, stamina: number) => names.map((n) => lateLook(n, false, played, stamina));
    expect(at(0.3, 0.4).every((l) => l.untucked === 0 && l.socks === 0)).toBe(true);
    const late = at(1, 0.6);
    const untucked = late.filter((l) => l.untucked > 0.99).length / late.length;
    expect(untucked).toBeGreaterThan(KIT_WEATHER.untuck - 0.12);
    expect(untucked).toBeLessThan(KIT_WEATHER.untuck + 0.12);
    const mid = (s: number) => at(0.7, s).filter((l) => l.untucked > 0 || l.socks > 0).length;
    expect(mid(0.1)).toBeGreaterThan(mid(1));
    expect(names.every((n) => lateLook(n, true, 1, 0).untucked === 0)).toBe(true);
  });

  it('rain soaks kits in over the first part of the match; snow settles on players standing still', () => {
    const v = liveView(5, 400);
    const kw = new KitWear();
    kw.update(v, 1 / 60, 0.8, null);
    const s0 = kw.get(3).soak;
    expect(s0).toBeGreaterThan(0.3);
    const later = { ...v, clock: 30 * 60 };
    kw.update(later, 1 / 60, 0.8, null);
    expect(kw.get(3).soak).toBeGreaterThan(s0);
    expect(kw.get(3).soak).toBeLessThanOrEqual(0.8 + 1e-9);
    // Dry weather: nothing soaks.
    const dry = new KitWear();
    dry.update(later, 1 / 60, 0, null);
    expect(dry.get(3).soak).toBe(0);
    // Snow: a still player gathers it, a sprinting one shakes it off.
    const still = { ...v, players: v.players.map((p) => ({ ...p, vel: { x: 0, z: 0 } })) };
    const sk = new KitWear();
    for (let i = 0; i < 600; i++) sk.update(still, 1 / 60, 0, null, 1);
    const settled = sk.get(4).snow;
    expect(settled).toBeGreaterThan(0.2);
    expect(settled).toBeLessThanOrEqual(KIT_WEATHER.snowMax);
    const sprint = { ...v, players: v.players.map((p) => ({ ...p, vel: { x: 8, z: 0 } })) };
    for (let i = 0; i < 120; i++) sk.update(sprint, 1 / 60, 0, null, 1);
    expect(sk.get(4).snow).toBeLessThan(settled * 0.5);
    // A substitute comes on dry and tidy.
    sk.fresh(4, later);
    expect(sk.get(4)).toMatchObject({ soak: 0, snow: 0, untucked: 0, socks: 0 });
  });

  it('player rolls are spread evenly', () => {
    const r = names.map((n) => kitRoll(n, 11));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
  });
});

describe('TV cutaways', () => {
  it('plans a close-up of the player, then his manager or the fans', () => {
    const v = liveView(7, 300);
    const st = v.players.find((p) => p.team === 0 && p.role !== 'GK')!;
    const miss = planCutaway('miss', st.id, v, 0.1);
    expect(miss.map((s) => s.kind)).toEqual(['player', 'manager']);
    expect(miss[0].name).toBe(st.def.name);
    expect(miss[1].team).toBe(st.team);
    expect(planCutaway('miss', st.id, v, 0.9)[1].kind).toBe('crowd');
    // A save: the keeper, then the manager of the side that was denied.
    const gk = v.players.find((p) => p.team === 1 && p.role === 'GK')!;
    const save = planCutaway('save', gk.id, v, 0.5);
    expect(save[0].id).toBe(gk.id);
    expect(save[1]).toMatchObject({ kind: 'manager', team: 0 });
    expect(planCutaway('foul', st.id, v, 0.5)).toHaveLength(1);
    expect(cutawayLength(miss)).toBeCloseTo(CUTAWAY.shot * 2);
    expect(cutawayAt(miss, 0.2)!.i).toBe(0);
    expect(cutawayAt(miss, CUTAWAY.shot + 0.1)!.i).toBe(1);
    expect(cutawayAt(miss, CUTAWAY.shot * 2 + 0.1)).toBeNull();
  });

  it('starts only once play stops soon after the moment, with a long gap between cutaways', () => {
    const d = new CutawayDirector();
    d.rand = () => 0;
    d.note('miss', 9, 100);
    expect(d.due(100.3, true)).toBeNull(); // too soon after the moment
    expect(d.due(101, false)).toBeNull(); // play still going
    expect(d.due(101.5, true)).toEqual({ trigger: 'miss', subject: 9 });
    // The next moment, too soon after: nothing.
    d.note('woodwork', 9, 120);
    expect(d.due(121, true)).toBeNull();
    // Long enough after: yes.
    d.note('card', 4, 100 + CUTAWAY.cooldown + 5);
    expect(d.due(100 + CUTAWAY.cooldown + 6, true)).toMatchObject({ trigger: 'card' });
    // Play has to stop within the window.
    d.note('woodwork', 9, 400);
    expect(d.due(400 + CUTAWAY.window + 1, true)).toBeNull();
    // A goal cancels it (the celebration and replay take over).
    d.note('miss', 9, 500);
    d.cancel();
    expect(d.due(501, true)).toBeNull();
    // Not in the opening seconds.
    const e = new CutawayDirector();
    e.rand = () => 0;
    e.note('woodwork', 9, 5);
    expect(e.due(6, true)).toBeNull();
  });

  it('a stronger moment replaces a weaker one waiting for the stoppage, and chances decide the rest', () => {
    const d = new CutawayDirector();
    d.rand = () => 0;
    d.note('woodwork', 9, 100);
    d.note('foul', 3, 100.5);
    expect(d.due(101.5, true)).toMatchObject({ trigger: 'woodwork', subject: 9 });
    const f = new CutawayDirector();
    f.rand = () => 0.99;
    f.note('foul', 3, 100);
    expect(f.due(101, true)).toBeNull();
    expect(CUT_CHANCE.woodwork).toBe(1);
    expect(defaultSettings().cutaways).toBe(true);
  });
});
