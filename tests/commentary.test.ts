import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { Commentary, LINES, LINE_COUNT, matchContext } from '../src/shared/commentary';

describe('commentary', () => {
  it('has a big bank of lines with only known placeholders', () => {
    expect(LINE_COUNT).toBeGreaterThan(200);
    const known = new Set(['t0', 't1', 'score', 'm', 'lead', 'p', 't', 'o', 'k', 'out', 'in', 'n', 'winner']);
    for (const [kind, bank] of Object.entries(LINES)) for (const l of bank) for (const k of l.match(/\{(\w+)\}/g) ?? []) expect(known.has(k.slice(1, -1)), `${kind}: ${l}`).toBe(true);
  });

  it('talks through a whole AI match without leftovers and without talking over itself', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 4, seed: 11 }));
    const c = new Commentary(5);
    const lines: { text: string; at: number; kind: string }[] = [];
    let n = 0;
    while (m.phase !== 'fulltime' && n++ < 60 * 60 * 8) {
      m.step();
      if (m.phase === 'halftime' && m.phaseT > 1) m.continueAfterHalftime();
      const ev = m.drainEvents();
      const now = m.time;
      for (const l of c.feed(ev, matchContext(m, ['Home', 'Away'], now))) lines.push({ text: l.text, at: now, kind: l.kind });
    }
    expect(lines.length).toBeGreaterThan(25);
    for (const l of lines) { expect(l.text).not.toMatch(/[{}]|undefined|NaN/); expect(l.text.trim().length).toBeGreaterThan(5); }
    expect(lines.some((l) => l.kind === 'kickoff')).toBe(true);
    expect(lines.some((l) => l.kind.startsWith('fulltime'))).toBe(true);
    if (m.goals.length) expect(lines.filter((l) => l.kind === 'goal').length).toBe(m.goals.length);
    // Different lines, not one on repeat.
    expect(new Set(lines.map((l) => l.text)).size).toBeGreaterThan(lines.length * 0.7);
  });
});
