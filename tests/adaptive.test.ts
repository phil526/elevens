// Adaptive difficulty: the computer side sharpens up when it is losing and eases off when it is well ahead.
import { describe, expect, it } from 'vitest';
import { ADAPTIVE, DIFFICULTY, adaptiveParams } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import { levelOf } from '../src/shared/ai/team';

describe('adaptive difficulty', () => {
  it('levels run from Pro through Elite to World class', () => {
    expect(adaptiveParams(1)).toEqual(DIFFICULTY.pro);
    expect(adaptiveParams(2)).toEqual(DIFFICULTY.elite);
    const wc = adaptiveParams(3);
    expect(wc.reaction).toBeLessThan(DIFFICULTY.elite.reaction);
    expect(wc.noise).toBeLessThan(DIFFICULTY.elite.noise);
    expect(adaptiveParams(9)).toEqual(wc);
  });
  it('rises while the other side is ahead and falls while it is behind', () => {
    const run = (lead: number) => {
      const m = new Match(defaultConfig({ humans: [false, false], difficulty: ['pro', 'adaptive'], realMinutes: 3, seed: 2, adaptiveStart: 2 }));
      for (let i = 0; i < 60 * 60 && m.displayClock < 25 * 60; i++) { m.step(); m.score = lead > 0 ? [lead, 0] : [0, -lead]; }
      return m;
    };
    const up = run(2), down = run(-2);
    expect(up.adaptiveLevel).toBeGreaterThan(2.5);
    expect(down.adaptiveLevel).toBeLessThan(1.5);
    expect(down.adaptiveLevel).toBeGreaterThanOrEqual(ADAPTIVE.min);
    expect(levelOf(up, 1).reaction).toBeLessThan(levelOf(down, 1).reaction);
    expect(levelOf(up, 0)).toEqual(DIFFICULTY.pro); // a fixed level never moves
  });
});
