// Weather, broadcast graphics, crowd moments and players' reactions after the whistle.
import { describe, expect, it } from 'vitest';
import { MatchViewBuilder } from '../src/client/view';
import { ReactionDirector, reactionPose, type ReactionKind } from '../src/client/render/reactions';
import { SLX, SRX, SPX, NKX, ELX } from '../src/client/render/player';
import { rollWeather, weatherLook, WEATHER_COUNTS } from '../src/client/render/weather';
import { LOOKS } from '../src/client/render/vfx';
import { CrowdMoments, moments } from '../src/client/render/crowdlife';
import { statsGraphic } from '../src/client/ui/tvgfx';
import { aiMatch, toOpenPlay } from './helpers';

describe('weather', () => {
  it('Random is mostly dry, often rain and sometimes snow', () => {
    const n = { clear: 0, rain: 0, snow: 0 };
    for (let i = 0; i < 1000; i++) n[rollWeather(i / 1000)]++;
    expect(n.clear).toBe(550);
    expect(n.rain).toBe(300);
    expect(n.snow).toBe(150);
  });

  it('greys the light for rain and snow and leaves clear skies alone', () => {
    for (const t of ['day', 'dusk', 'night'] as const) {
      expect(weatherLook(LOOKS[t], 'clear')).toBe(LOOKS[t]);
      const r = weatherLook(LOOKS[t], 'rain');
      expect(r.sunI).toBeLessThan(LOOKS[t].sunI);
      expect(r.fogFar).toBeLessThan(LOOKS[t].fogFar);
      expect(r.grade.sat).toBeLessThan(LOOKS[t].grade.sat);
    }
  });

  it('keeps Low cheap: fewer drops, no splashes', () => {
    expect(WEATHER_COUNTS.rain[0]).toBeLessThanOrEqual(1500);
    expect(WEATHER_COUNTS.splash[0]).toBe(0);
    for (const k of ['rain', 'snow', 'splash'] as const) for (let q = 1; q < 4; q++) expect(WEATHER_COUNTS[k][q]).toBeGreaterThanOrEqual(WEATHER_COUNTS[k][q - 1]);
  });
});

describe('player reactions', () => {
  it('poses: hands on head raise both arms, dejected drops the head', () => {
    const P = new Float32Array(17);
    reactionPose('headInHands', 0.5, 0.2, P);
    expect(P[SLX]).toBeLessThan(-2);
    expect(P[SRX]).toBeLessThan(-2);
    expect(P[ELX]).toBeLessThan(-1.5);
    P.fill(0);
    reactionPose('dejected', 0.5, 0.2, P);
    expect(P[NKX]).toBeGreaterThan(0.4);
    P.fill(0);
    reactionPose('crouch', 0.5, 0.2, P);
    expect(P[SPX]).toBeGreaterThan(0.6);
  });

  it('eases in and out and ends', () => {
    const d = new ReactionDirector();
    d.add(3, 'protest', 2);
    d.update(0.05);
    const early = d.frame(3)!.w;
    d.update(0.5);
    expect(d.frame(3)!.w).toBeGreaterThan(early);
    expect(d.frame(3)!.w).toBeCloseTo(1, 2);
    d.update(2);
    expect(d.frame(3)).toBeNull();
  });

  it('a goal: the side that conceded looks dejected, the scorers celebrate', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const vb = new MatchViewBuilder(m);
    const v = vb.build(1);
    const scorer = v.players.find((p) => p.team === 0 && p.role === 'ST')!;
    v.score = [1, 0];
    const d = new ReactionDirector();
    d.onEvents(v, [{ id: 1, type: 'goal', tick: 0, team: 0, player: scorer.id }]);
    d.update(1.5);
    const sad: ReactionKind[] = ['handsOnHips', 'dejected', 'headInHands', 'crouch', 'protest'];
    const conceded = v.players.filter((p) => p.team === 1).map((p) => d.kindOf(p.id));
    expect(conceded.every((k) => k !== null && sad.includes(k))).toBe(true);
    expect(d.kindOf(scorer.id)).toBeNull(); // the scorer has his own celebration
    const happy = v.players.filter((p) => p.team === 0 && p.id !== scorer.id).map((p) => d.kindOf(p.id)).filter((k) => k);
    expect(happy.length).toBeGreaterThan(2);
    for (const k of happy) expect(['highFive', 'fistPump', 'clap', 'armsUp']).toContain(k);
  });

  it('a foul: the offender protests; a missed shot: hands on head', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const v = new MatchViewBuilder(m).build(1);
    const d = new ReactionDirector();
    d.onEvents(v, [{ id: 1, type: 'foul', tick: 0, team: 1, player: 14 }]);
    d.update(0.5);
    expect(d.kindOf(14)).toBe('protest');
    d.onEvents(v, [{ id: 2, type: 'kick', tick: 0, team: 0, player: 9, text: 'shot' }]);
    d.update(1);
    d.onEvents(v, [{ id: 3, type: 'restart', tick: 0, team: 1, text: 'goalkick' }]);
    d.update(0.5);
    expect(['headInHands', 'crouch']).toContain(d.kindOf(9));
  });

  it('full time: winners celebrate, losers are down', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const v = new MatchViewBuilder(m).build(1);
    v.score = [0, 2];
    const d = new ReactionDirector();
    d.onEvents(v, [{ id: 1, type: 'fulltime', tick: 0 }]);
    d.update(2);
    for (const p of v.players) {
      const k = d.kindOf(p.id);
      if (p.team === 1) expect(['armsUp', 'clap', 'fistPump', 'highFive']).toContain(k);
      else expect(['crouch', 'dejected', 'handsOnHips', 'headInHands']).toContain(k);
    }
  });
});

describe('crowd moments', () => {
  it('chants raise scarves on one side, near misses put hands on heads, both fade', () => {
    const c = new CrowdMoments();
    c.trigger('chant', 1);
    c.trigger('miss', 0);
    for (let i = 0; i < 60; i++) c.update(1 / 30, false);
    expect(moments.uSing.value.y).toBeGreaterThan(0.9);
    expect(moments.uSing.value.x).toBeLessThan(0.05);
    expect(moments.uMiss.value.x).toBeGreaterThan(0.9);
    for (let i = 0; i < 30 * 12; i++) c.update(1 / 30, false);
    expect(moments.uSing.value.y).toBeLessThan(0.05);
    expect(moments.uMiss.value.x).toBeLessThan(0.05);
  });

  it('a Mexican wave goes round about one and a half times, then stops', () => {
    const c = new CrowdMoments();
    c.trigger('wave');
    let travelled = 0, last = moments.uWave.value.x, peak = 0, t = 0;
    while (c.state.wave && t < 60) {
      c.update(1 / 30, true);
      t += 1 / 30;
      const a = moments.uWave.value.x;
      travelled += (a - last + Math.PI * 2) % (Math.PI * 2);
      last = a;
      peak = Math.max(peak, moments.uWave.value.y);
    }
    expect(c.state.wave).toBe(false);
    expect(peak).toBeGreaterThan(0.9);
    expect(travelled / (Math.PI * 2)).toBeGreaterThan(1.3);
    expect(t).toBeLessThan(30);
  });
});

describe('TV stats graphic', () => {
  it('shows each stat with both values and a bar split by share', () => {
    const m = aiMatch();
    const v = new MatchViewBuilder(m).build(1);
    v.stats[0].shots = 6; v.stats[1].shots = 2;
    v.stats[0].possessionTicks = 600; v.stats[1].possessionTicks = 400;
    const html = statsGraphic(v);
    expect(html).toContain('Possession');
    expect(html).toContain('60%');
    expect(html).toContain('40%');
    expect(html).toMatch(/<small>Shots<\/small><div class="bar"><i style="width:75.0%/);
    expect(html).not.toContain('Red cards'); // none shown when nobody was sent off
  });
});
