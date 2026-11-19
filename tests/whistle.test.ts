// Referee whistle: every stoppage and restart the referee would blow for carries its pattern.
import { describe, expect, it } from 'vitest';
import { WHISTLES } from '../src/client/audio/audio';
import { Match, defaultConfig } from '../src/shared/match';

describe('referee whistle', () => {
  it('a whole AI match whistles for kick-offs, the ball going out, goals, fouls, half time and full time', () => {
    const seen = new Map<string, number>();
    const outs = { out: 0, whistled: 0 };
    for (const seed of [21, 22, 23]) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
      while (m.phase !== 'fulltime') {
        m.step();
        if (m.phase === 'halftime') m.continueAfterHalftime();
        const ev = m.drainEvents();
        for (const e of ev) {
          if (e.type === 'whistle') seen.set(e.text ?? '?', (seen.get(e.text ?? '?') ?? 0) + 1);
          if (e.type === 'out') { outs.out++; if (ev.some((w) => w.type === 'whistle' && w.text === 'out')) outs.whistled++; }
        }
      }
    }
    for (const k of ['kickoff', 'out', 'restart', 'foul', 'goal', 'halftime', 'fulltime']) expect(seen.get(k) ?? 0, k).toBeGreaterThan(0);
    expect(seen.get('?') ?? 0).toBe(0);
    expect(seen.get('fulltime')).toBe(3);
    expect(seen.get('halftime')).toBe(3);
    expect(outs.whistled).toBe(outs.out);
    // Every kind the match emits has a pattern to play.
    for (const k of seen.keys()) expect(WHISTLES[k as keyof typeof WHISTLES], k).toBeDefined();
  });
  it('patterns: one long blast for a goal, two at half time, three (the last longest) at full time', () => {
    expect(WHISTLES.goal).toHaveLength(1);
    expect(WHISTLES.goal[0][0]).toBeGreaterThan(WHISTLES.foul[0][0]);
    expect(WHISTLES.out[0][0]).toBeLessThan(WHISTLES.restart[0][0]);
    expect(WHISTLES.halftime).toHaveLength(2);
    expect(WHISTLES.fulltime).toHaveLength(3);
    expect(WHISTLES.fulltime[2][0]).toBeGreaterThan(WHISTLES.fulltime[0][0] * 2);
  });
});
