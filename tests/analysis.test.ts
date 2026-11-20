import { describe, expect, it } from 'vitest';
import { xgFor, goalAngle } from '../src/shared/xg';
import { MatchAnalysis, analysisHtml } from '../src/client/analysis';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';

describe('expected goals', () => {
  it('rates close central shots far above long range ones', () => {
    const six = xgFor(52.5 - 6, 0, 1), spot = xgFor(52.5 - 11, 0, 1), twenty = xgFor(52.5 - 20, 0, 1), thirty = xgFor(52.5 - 30, 0, 1);
    expect(six).toBeGreaterThan(0.35);
    expect(six).toBeLessThan(0.6);
    expect(spot).toBeGreaterThan(0.15);
    expect(twenty).toBeLessThan(0.1);
    expect(thirty).toBeLessThan(0.03);
    expect(xgFor(52.5 - 11, 0, 1, 'pen')).toBeCloseTo(0.76);
    expect(xgFor(52.5 - 8, 0, 1, 'header')).toBeLessThan(xgFor(52.5 - 8, 0, 1));
    expect(xgFor(52.5 - 6, 20, 1)).toBeLessThan(six / 2); // tight angle
    expect(xgFor(-52.5 + 10, 0, -1)).toBeCloseTo(xgFor(52.5 - 10, 0, 1));
    expect(goalAngle(52.5 - 11, 0, 1)).toBeCloseTo(2 * Math.atan(3.66 / 11), 3);
  });
});

describe('match analysis from a whole AI match', () => {
  it('records shots, passes, heat and pressure that match the stats', () => {
    const cfg = defaultConfig({ humans: [false, false], realMinutes: 4, seed: 1003 });
    const m = new Match(cfg);
    const b = new MatchViewBuilder(m);
    const a = new MatchAnalysis();
    a.reset(true);
    let guard = 0;
    while (m.phase !== 'fulltime' && guard++ < 60 * 60 * 6) {
      b.capture();
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      a.frame(b.build(1), m.drainEvents());
    }
    const v = b.build(1);
    const shots = v.stats[0].shots + v.stats[1].shots;
    expect(a.shots.length).toBeGreaterThanOrEqual(Math.floor(shots * 0.7));
    expect(a.passes.length).toBeGreaterThan(40);
    const ok = a.passes.filter((p) => p.ok).length / a.passes.length;
    expect(ok).toBeGreaterThan(0.5);
    expect(a.heat[0].reduce((n, x) => n + x, 0)).toBeGreaterThan(100);
    expect(a.pressure[0].length).toBeGreaterThan(5);
    const goalsFromShots = a.shots.filter((s) => s.goal).length;
    expect(goalsFromShots).toBeLessThanOrEqual(v.score[0] + v.score[1]);
    for (const tab of ['shots', 'heat', 'passes', 'momentum'] as const) {
      const html = analysisHtml(a, v, tab, 0, 0);
      expect(html).toContain('Coach');
      expect(html.length).toBeGreaterThan(200);
    }
  }, 60_000);
});
