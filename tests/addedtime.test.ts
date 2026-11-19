// Added time: the fourth official shows a board near the end of each half and play runs on for that long.
import { describe, it, expect } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { MATCH } from '../src/shared/config';
import { clockText, minuteText } from '../src/shared/snapshot';

describe('added time', () => {
  it('shows the board once per half and each half ends after its added minutes', () => {
    for (const seed of [31, 32]) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
      const boards: number[] = [];
      const ends: { half: number; clock: number; added: number }[] = [];
      let prev: string = m.phase;
      while ((m.phase as string) !== 'fulltime') {
        const half = m.half, clock = m.clock, added = m.addedTime;
        m.step();
        if (m.phase !== prev && (m.phase === 'halftime' || m.phase === 'fulltime')) ends.push({ half, clock, added });
        prev = m.phase;
        if (m.phase === 'halftime') { m.continueAfterHalftime(); prev = m.phase; }
        for (const e of m.drainEvents()) if (e.type === 'addedtime') boards.push(e.power ?? 0);
      }
      expect(boards.length).toBe(2);
      for (const b of boards) { expect(b).toBeGreaterThanOrEqual(1); expect(b).toBeLessThanOrEqual(6); }
      expect(ends.length).toBe(2);
      ends.forEach((e, i) => {
        expect(e.added).toBe(boards[i]);
        expect(e.clock).toBeGreaterThanOrEqual(MATCH.footballSecondsPerHalf + e.added * 60 - 1);
      });
    }
  });

  it('formats the clock and goal minutes in added time', () => {
    expect(clockText(2700 + 83, 1)).toBe('45:00 +1:23');
    expect(clockText(1200, 1)).toBe('20:00');
    expect(clockText(5400 + 5, 2)).toBe('90:00 +0:05');
    expect(minuteText(2700 + 70, 1)).toBe("45+2'");
    expect(minuteText(600, 1)).toBe("11'");
    expect(minuteText(5400 + 10, 2)).toBe("90+1'");
  });
});
