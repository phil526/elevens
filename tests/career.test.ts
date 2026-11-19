import { describe, expect, it } from 'vitest';
import { applySquads, buyPlayer, careerTeam, endSeason, isCareer, leagueClubs, newCareer, nextFixture, ovrOf, pickEleven, promoteYouth, recordCareerMatch, sellPlayer, seasonOver, swapLineup, teamSheet, valueOf, SQUAD_MIN } from '../src/shared/career';
import { ALL_CLUBS, ROLES, clearSquadOverrides, teamById } from '../src/shared/teams';
import { Match, defaultConfig } from '../src/shared/match';

const play = (c: ReturnType<typeof newCareer>, gf = 2, ga = 1) => {
  const xi = teamSheet(c, c.club).xi;
  return recordCareerMatch(c, { gf, ga, scorers: gf ? [xi[9].short] : [], played: xi.map((p) => p.short) });
};

describe('career mode', () => {
  it('starts with every club squad, a league and a cup', () => {
    const c = newCareer('redmoor', 42, 12);
    expect(isCareer(c)).toBe(true);
    expect(Object.keys(c.squads).length).toBe(ALL_CLUBS.length);
    for (const sq of Object.values(c.squads)) expect(sq.length).toBeGreaterThanOrEqual(SQUAD_MIN);
    expect(leagueClubs(c)).toContain('redmoor');
    expect(leagueClubs(c).length).toBe(12);
    expect(c.academy.length).toBe(3);
    expect(c.market.length).toBeGreaterThan(5);
    expect(nextFixture(c)?.comp).toBe('league');
    expect(new Set(c.squads.redmoor.map((p) => p.number)).size).toBe(c.squads.redmoor.length);
  });

  it('picks a full eleven with a keeper and fields career squads in a match', () => {
    const c = newCareer('kestrel', 7, 8);
    const ids = pickEleven(c.squads.kestrel);
    expect(ids.length).toBe(11);
    expect(new Set(ids).size).toBe(11);
    expect(c.squads.kestrel.find((p) => p.id === ids[0])!.pos).toBe('GK');
    const t = careerTeam(c, 'kestrel', teamById('kestrel'));
    expect(t.players.map((p) => p.role)).toEqual(ROLES);
    expect(t.bench!.length).toBeGreaterThanOrEqual(5);
    applySquads(c);
    const m = new Match(defaultConfig({ teams: ['kestrel', 'redmoor'], humans: [false, false], seed: 3, realMinutes: 2 }));
    expect(m.players[0].def.name).toBe(t.players[0].name);
    expect(m.bench[0].length).toBe(t.bench!.length);
    clearSquadOverrides();
  });

  it('swaps line-up places', () => {
    const c = newCareer('redmoor', 9, 8);
    const sheet = teamSheet(c, 'redmoor');
    const reserve = sheet.bench.find((p) => p.pos !== 'GK')!;
    swapLineup(c, sheet.xi[9].id, reserve.id);
    expect(teamSheet(c, 'redmoor').xi[9].id).toBe(reserve.id);
  });

  it('buys, sells and promotes', () => {
    const c = newCareer('redmoor', 11, 12);
    c.budgets.redmoor = 1e6;
    const target = c.market[0];
    const before = c.squads.redmoor.length;
    expect(buyPlayer(c, target.id).ok).toBe(true);
    expect(c.squads.redmoor.length).toBe(before + 1);
    expect(c.squads[target.club].some((p) => p.id === target.id)).toBe(false);
    expect(c.squads[target.club].length).toBeGreaterThanOrEqual(SQUAD_MIN);
    const seller = c.squads.redmoor[c.squads.redmoor.length - 1];
    expect(sellPlayer(c, seller.id).ok).toBe(true);
    expect(c.squads.redmoor.some((p) => p.id === seller.id)).toBe(false);
    const y = c.academy[0];
    expect(promoteYouth(c, y.id).ok).toBe(true);
    expect(c.squads.redmoor.some((p) => p.id === y.id)).toBe(true);
    c.budgets.redmoor = 0;
    expect(buyPlayer(c, c.market[0].id).ok).toBe(false);
  });

  it('plays a whole season with cup rounds in between, then starts the next', () => {
    const c = newCareer('northgate', 5, 8);
    let cups = 0, n = 0;
    while (!seasonOver(c) && n < 40) { const f = nextFixture(c)!; if (f.comp === 'cup') cups++; play(c, 3, 0); n++; }
    expect(seasonOver(c)).toBe(true);
    expect(cups).toBe(3); // won every round: quarter, semi and final
    expect(c.cup.champion).toBe('northgate');
    const oldAges = c.squads.northgate.map((p) => p.age);
    const { summary } = endSeason(c);
    expect(summary.pos).toBe(1);
    expect(summary.cup).toBe('Winners');
    expect(c.honours.length).toBe(2);
    expect(c.season).toBe(2);
    expect(nextFixture(c)).not.toBeNull();
    expect(leagueClubs(c).length).toBe(8);
    expect(c.squads.northgate.length).toBeGreaterThanOrEqual(SQUAD_MIN);
    expect(Math.max(...c.squads.northgate.map((p) => p.age))).toBeLessThanOrEqual(Math.max(...oldAges) + 1);
    expect(c.history.length).toBe(1);
  });

  it('young players grow and old players decline over seasons', () => {
    const c = newCareer('redmoor', 21, 8);
    const kid = c.academy[0];
    kid.potential = 90;
    promoteYouth(c, kid.id);
    const v0 = ovrOf(kid), val0 = valueOf(kid);
    for (let s = 0; s < 3; s++) { while (!seasonOver(c)) play(c, 1, 1); endSeason(c); }
    expect(ovrOf(kid)).toBeGreaterThan(v0 + 4);
    expect(valueOf(kid)).toBeGreaterThan(val0);
  });
});
