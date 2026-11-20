import { describe, expect, it } from 'vitest';
import { NATIONS, NATION_SPECS, groupTable, isTournament, myTourFixture, newTournament, recordTourResult, stageName, tourOpponent } from '../src/shared/tournament';
import { teamById } from '../src/shared/teams';

describe('World tournament', () => {
  it('has sixteen nations with full squads that teamById finds', () => {
    expect(NATIONS).toHaveLength(16);
    expect(new Set(NATION_SPECS.map((n) => n.abbr)).size).toBe(16);
    for (const n of NATIONS) {
      expect(n.players).toHaveLength(11);
      expect(teamById(n.id).name).toBe(n.name);
      expect(new Set(n.players.map((p) => p.short)).size).toBe(11);
    }
  });

  it('draws four groups of four, spreading the strongest sides', () => {
    const t = newTournament('n-ostrova', 5);
    expect(t.groups.flat().sort()).toEqual(NATION_SPECS.map((n) => n.id).sort());
    const top = NATION_SPECS.slice().sort((a, b) => b.strength - a.strength).slice(0, 4).map((n) => n.id);
    for (const g of t.groups) expect(g.filter((id) => top.includes(id)).length).toBe(1);
    // Every group plays a round robin over three matchdays.
    for (const g of t.groups) {
      const games = t.groupDays.flat().filter((f) => g.includes(f.home));
      expect(games).toHaveLength(6);
    }
    expect(stageName(t)).toMatch(/^Group [A-D] · matchday 1$/);
  });

  it('wins all the way to the trophy', () => {
    let t = newTournament('n-aurelia', 11);
    let n = 0;
    while (myTourFixture(t) && n++ < 10) {
      expect(tourOpponent(t)).toBeTruthy();
      t = recordTourResult(t, 3, 0);
    }
    expect(n).toBe(6);
    expect(t.champion).toBe('n-aurelia');
    expect(t.out).toBeFalsy();
    expect(groupTable(t, t.groups.findIndex((g) => g.includes('n-aurelia')))[0].id).toBe('n-aurelia');
    expect(isTournament(JSON.parse(JSON.stringify(t)))).toBe(true);
  });

  it('losing every group game knocks you out and the rest is played to a champion', () => {
    let t = newTournament('n-ostrova', 3);
    for (let i = 0; i < 3; i++) t = recordTourResult(t, 0, 2);
    expect(t.out).toBe(true);
    expect(t.champion).toBeTruthy();
    expect(myTourFixture(t)).toBeNull();
    expect(t.ko).toHaveLength(3);
  });

  it('a level knockout tie needs penalties', () => {
    let t = newTournament('n-aurelia', 11);
    for (let i = 0; i < 3; i++) t = recordTourResult(t, 4, 0);
    expect(t.stage).toBe(3);
    t = recordTourResult(t, 1, 1, [5, 4], true);
    expect(t.stage).toBe(4);
    expect(t.out).toBeFalsy();
  });
});
