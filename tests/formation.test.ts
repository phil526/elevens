// Formations and tactic sliders.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { basePos, formationTarget, mentalityOf } from '../src/shared/ai/team';
import { cleanTactics, defaultTactics, type Tactics } from '../src/shared/teams';
import { parseClientMsg } from '../src/shared/protocol';

const withTactics = (t: Partial<Tactics>) => new Match(defaultConfig({ humans: [false, false], seed: 4, tactics: [{ ...defaultTactics(), ...t }, defaultTactics()] }));
// Your own side (no club playing style on top of the sliders, see shared/playstyle.ts).
const ownTactics = (t: Partial<Tactics>) => new Match(defaultConfig({ humans: [true, false], seed: 4, tactics: [{ ...defaultTactics(), ...t }, defaultTactics()] }));

describe('formations', () => {
  it('4-4-2 drops the wingers into midfield and pushes the holder up front', () => {
    const a = withTactics({}), b = withTactics({ formation: '442' });
    expect(basePos(b, 0, 'RW').x).toBeLessThan(basePos(a, 0, 'RW').x - 5);
    expect(basePos(b, 0, 'CDM').x).toBeGreaterThan(-5);
    expect(basePos(withTactics({ formation: '4231' }), 0, 'LCM').x).toBeGreaterThan(basePos(a, 0, 'LCM').x);
  });
  it('the width slider spreads the team, the line slider moves the block, the press slider sends more players', () => {
    const spread = (m: Match) => {
      for (let i = 0; i < 2000 && !(m.phase === 'play' && m.plans[0]); i++) m.step();
      const plan = { ...m.plans[0]!, inPossession: false };
      const zs = m.teamPlayers(0).filter((p) => p.role !== 'GK').map((p) => formationTarget(m, p, plan).z);
      return Math.max(...zs) - Math.min(...zs);
    };
    expect(spread(withTactics({ width: 2 }))).toBeGreaterThan(spread(withTactics({ width: -2 })) + 5);
    expect(mentalityOf(ownTactics({ line: 2 }), 0).lineOffset).toBe(6);
    expect(mentalityOf(ownTactics({ press: 2 }), 0).pressers).toBe(3);
    expect(mentalityOf(ownTactics({ press: -2 }), 0).pressers).toBe(1);
    expect(mentalityOf(ownTactics({ press: 2 }), 0).pressRadius).toBeGreaterThan(mentalityOf(ownTactics({}), 0).pressRadius);
  });
  it('every formation plays a full match without errors', () => {
    for (const formation of ['442', '4231'] as const) {
      const m = new Match(defaultConfig({ humans: [false, false], seed: 8, realMinutes: 3, tactics: [{ ...defaultTactics(), formation, width: 1, line: -1, press: 2 }, { ...defaultTactics(), formation: '433' }] }));
      while (m.phase !== 'fulltime') { m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); }
      expect(m.stats[0].passes).toBeGreaterThan(20);
    }
  });
  it('tactics are sanitised from the network', () => {
    expect(cleanTactics({ formation: 'xyz' as never, width: 9, line: -7.4, press: NaN })).toEqual({ formation: '433', width: 2, line: -2, press: 0 });
    const msg = parseClientMsg(JSON.stringify({ t: 'tactic', mentality: 'attacking', tac: { formation: '442', width: 1, line: 0, press: -1 } }));
    expect(msg && msg.t === 'tactic' && msg.tac?.formation).toBe('442');
    expect(parseClientMsg(JSON.stringify({ t: 'tactic', mentality: 'attacking', tac: 5 }))).toBeNull();
  });
});
