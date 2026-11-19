// Substitutions and fatigue.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { encodeSnapshot } from '../src/shared/snapshot';
import { parseClientMsg } from '../src/shared/protocol';
import { TEAMS, benchFor } from '../src/shared/teams';

describe('bench', () => {
  it('every club has five distinct substitutes, numbered 12 to 16, the same on every machine', () => {
    for (const t of TEAMS) {
      const b = benchFor(t);
      expect(b.map((p) => p.number)).toEqual([12, 13, 14, 15, 16]);
      expect(b[0].role).toBe('GK');
      const names = new Set([...t.players.map((p) => p.short), ...b.map((p) => p.short)]);
      expect(names.size).toBe(16);
      expect(benchFor(t)).toEqual(b);
    }
  });
});

describe('fatigue and substitutions', () => {
  it('fatigue builds over a match and caps stamina; the computer brings on fresh players', () => {
    // Seed-dependent: in a short computer match some seeds reach no stoppage where subs are made (2 of 12 on 19 Nov 2026); seed 2 does.
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 3, seed: 2 }));
    const subs: string[] = [];
    while ((m.phase as string) !== 'fulltime') {
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      for (const e of m.drainEvents()) if (e.type === 'sub') subs.push(e.text!);
    }
    const starters = m.players.filter((p) => p.def.number <= 11 && p.role !== 'GK');
    expect(Math.min(...starters.map((p) => p.fatigue))).toBeGreaterThan(0.12);
    for (const p of starters) expect(p.stamina).toBeLessThanOrEqual(1 - p.fatigue + 1e-9);
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(m.subsUsed(0)).toBeLessThanOrEqual(3);
    expect(m.subsUsed(1)).toBeLessThanOrEqual(3);
    const fresh = m.players.filter((p) => p.def.number >= 12);
    expect(fresh.length).toBe(subs.length);
    const snap = encodeSnapshot(m, 0, [], false);
    expect(snap.sb?.length).toBe(subs.length);
  });
  it('a human substitution waits for a stoppage and follows the rules', () => {
    const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 3 }));
    for (let i = 0; i < 1500 && m.phase !== 'play'; i++) m.step();
    const st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    const gk = m.keeper(0);
    expect(m.requestSub(0, gk.id, 3)).toBe(false); // an outfield sub cannot go in goal
    expect(m.requestSub(0, st.id, 0)).toBe(false); // nor the bench keeper up front
    expect(m.requestSub(1, st.id, 4)).toBe(false); // not your player
    if (m.phase === 'play') {
      expect(m.requestSub(0, st.id, 4)).toBe(true);
      expect(st.def.number).toBe(9);
      for (let i = 0; i < 60 * 300 && m.subsUsed(0) === 0; i++) m.step();
    } else expect(m.requestSub(0, st.id, 4)).toBe(true);
    expect(m.subsUsed(0)).toBe(1);
    expect(st.def.number).toBe(16);
    expect(st.role).toBe('ST');
    expect(st.stamina).toBe(1);
    expect(m.requestSub(0, st.id, 4)).toBe(false); // already used
  });
  it('the protocol checks substitution messages', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'sub', id: 9, bench: 4 }))).toEqual({ t: 'sub', id: 9, bench: 4 });
    expect(parseClientMsg(JSON.stringify({ t: 'sub', id: 30, bench: 4 }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'sub', id: 9, bench: 1.5 }))).toBeNull();
  });
});
