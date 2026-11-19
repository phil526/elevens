// Practice: the crossing drill and ten-attempt challenges.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { MatchEvent } from '../src/shared/types';

describe('practice challenges', () => {
  it('a penalty challenge ends after ten attempts with the goals as the score', () => {
    const m = new Match(defaultConfig({ humans: [false, false], practice: 'penalty', challenge: 10, seed: 4 }));
    const ev: MatchEvent[] = [];
    for (let i = 0; i < 60 * 300 && (m.phase as string) !== 'fulltime'; i++) { m.step(); ev.push(...m.drainEvents()); }
    expect(m.phase).toBe('fulltime');
    expect(m.drillAttempts).toBe(10);
    const end = ev.find((e) => e.type === 'fulltime');
    expect(end?.text).toBe('challenge');
    expect(end?.power).toBe(m.score[0]);
    expect(m.score[0]).toBeGreaterThanOrEqual(4);
    expect(m.score[0]).toBeLessThanOrEqual(10);
  });
  it('the crossing drill sends a cross to the striker against two defenders and the keeper', () => {
    const m = new Match(defaultConfig({ humans: [true, false], practice: 'crosses', challenge: 5, seed: 9 }));
    const crosses: number[] = [];
    for (let i = 0; i < 60 * 120 && (m.phase as string) !== 'fulltime'; i++) {
      m.applyInput(0, { seq: i + 1, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [] });
      m.step();
      for (const e of m.drainEvents()) if (e.type === 'kick' && e.text === 'cross') crosses.push(m.time);
      if (m.drillAttempts === 1 && m.phase === 'play' && m.ball.flight === 'cross') {
        expect(m.players.filter((p) => !p.off).length).toBe(6);
        expect(m.players[m.ball.receiver].role).toBe('ST');
        expect(m.ctrl[0].pid).toBe(m.ball.receiver);
      }
    }
    expect(crosses.length).toBe(5);
    expect(m.phase).toBe('fulltime');
  });
});
