// Extra time and penalty shootouts after a draw (when the match settings ask for them).
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { clockText } from '../src/shared/snapshot';
import { encodeSnapshot } from '../src/shared/snapshot';

/** Runs an AI match, levelling the score just before the end of the given halves. */
function play(draw: 'stand' | 'extra' | 'pens', levelIn: number[], seed = 12) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 3, seed, draw }));
  const halves: number[] = [];
  const events: { type: string; text?: string; team?: number }[] = [];
  let ticks = 0;
  while ((m.phase as string) !== 'fulltime' && ticks++ < 60 * 60 * 20) {
    if (levelIn.includes(m.half) && !m.shootout && m.clock > (m.half <= 2 ? 2600 : 820)) { const g = Math.max(...m.score); m.score = [g, g]; }
    m.step();
    events.push(...m.drainEvents());
    if (m.phase === 'halftime') { halves.push(m.half); m.continueAfterHalftime(); }
  }
  return { m, halves, events };
}

describe('extra time and penalties', () => {
  it('draws stand by default', () => {
    const { m, events } = play('stand', [2]);
    expect(m.half).toBe(2);
    expect(m.shootout).toBeNull();
    expect(events.some((e) => e.type === 'pen')).toBe(false);
  });
  it('a draw goes to two halves of extra time, then a shootout that someone wins', () => {
    const { m, halves, events } = play('extra', [2, 4]);
    expect(halves).toEqual([1, 2, 3]);
    expect(m.half).toBe(4);
    expect(m.displayClock).toBeGreaterThanOrEqual(120 * 60);
    expect(m.score[0]).toBe(m.score[1]);
    const so = m.shootout!;
    expect(so.winner === 0 || so.winner === 1).toBe(true);
    const [a, b] = so.kicks;
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
    expect(a.length).toBeGreaterThanOrEqual(3);
    const ga = a.filter(Boolean).length, gb = b.filter(Boolean).length;
    expect(ga === gb).toBe(false);
    expect(so.winner).toBe(ga > gb ? 0 : 1);
    expect(events.filter((e) => e.type === 'pen' && e.text !== 'start').length).toBe(a.length + b.length);
    expect(events.some((e) => e.type === 'fulltime' && e.text === 'pens')).toBe(true);
    const snap = encodeSnapshot(m, 0, [], false);
    expect(snap.so?.[3]).toBe(so.winner);
  });
  it('a win in extra time needs no shootout; penalties-only skips extra time', () => {
    const et = play('extra', [2]);
    expect(et.halves).toEqual([1, 2, 3]);
    if (et.m.score[0] !== et.m.score[1]) expect(et.m.shootout).toBeNull();
    const pens = play('pens', [2], 13);
    expect(pens.halves).toEqual([1]);
    expect(pens.m.shootout?.winner).toBeGreaterThanOrEqual(0);
  });
  it('the clock reads into extra time', () => {
    expect(clockText(90 * 60 + 300, 3)).toBe('95:00');
    expect(clockText(105 * 60 + 70, 3)).toBe('105:00 +1:10');
    expect(clockText(120 * 60, 4)).toBe('120:00');
  });
});
