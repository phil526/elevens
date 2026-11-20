import { describe, expect, it } from 'vitest';
import { CHALLENGES, COSMETICS, equipped, levelOf, matchXp, newLevels, recordLevels, rollWeek, weekOf, weeklyChallenges, xpForLevel, type MatchFacts } from '../src/client/levels';
import { emptyStats } from '../src/shared/types';

const facts = (over: Partial<MatchFacts> = {}): MatchFacts => ({
  mode: 'quick', club: 'a', clubName: 'A', opp: 'b', oppName: 'B', custom: false, difficulty: 'pro', adaptiveWorld: false,
  gf: 2, ga: 0, stats: { ...emptyStats(), onTarget: 5, tackles: 6 }, possession: 0.55, goals: [
    { scorer: 'Smith', kind: 'header', distance: 8, minute: 20 }, { scorer: 'Jones', kind: 'shot', distance: 22, minute: 70 },
  ], sequence: [{ side: 1, minute: 20 }, { side: 1, minute: 70 }], half: 2, passPct: 0.82, kind: 'quick', ...over,
});

describe('club levels', () => {
  it('levels grow with points and need more each time', () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(xpForLevel(1)).level).toBe(2);
    expect(levelOf(xpForLevel(1) + xpForLevel(2) - 1)).toEqual({ level: 2, into: xpForLevel(2) - 1, need: xpForLevel(2) });
    expect(levelOf(1e9).level).toBe(30);
  });

  it('a win with goals and a clean sheet on Elite earns more than a defeat on Casual', () => {
    const big = matchXp(facts({ difficulty: 'elite' })).total, small = matchXp(facts({ gf: 0, ga: 3, difficulty: 'casual', goals: [], sequence: [] })).total;
    expect(big).toBeGreaterThan(small * 2);
    expect(small).toBeGreaterThanOrEqual(80);
  });

  it('three different challenges each week, the same for everyone that week', () => {
    for (const w of ['2026-11-16', '2026-11-23', '2027-01-04']) {
      const a = weeklyChallenges(w), b = weeklyChallenges(w);
      expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
      expect(new Set(a.map((c) => c.id.replace(/\d+$/, ''))).size).toBe(3);
    }
    expect(weekOf(new Date(2026, 10, 20))).toBe('2026-11-16'); // a Friday -> its Monday
    expect(weekOf(new Date(2026, 10, 16))).toBe('2026-11-16');
  });

  it('records progress, finishes challenges, gives the bonus and unlocks rewards', () => {
    const s = newLevels();
    const now = new Date(2026, 10, 20);
    rollWeek(s, now);
    const week = weeklyChallenges(s.week);
    // Enough big wins to finish whatever this week's challenges are, most of the time.
    let finished = 0;
    for (let i = 0; i < 20; i++) {
      const r = recordLevels(s, facts({ gf: 5, ga: 1, difficulty: 'elite', mode: i % 2 ? 'online' : 'cup', goals: [
        { scorer: 'Smith', kind: 'header', distance: 8, minute: 10 }, { scorer: 'Smith', kind: 'volley', distance: 12, minute: 30 }, { scorer: 'Smith', kind: 'freekick', distance: 24, minute: 50 },
        { scorer: 'Jones', kind: 'shot', distance: 25, minute: 60 }, { scorer: 'Jones', kind: 'header', distance: 6, minute: 80 }],
        sequence: [{ side: -1, minute: 5 }, { side: 1, minute: 10 }, { side: 1, minute: 30 }, { side: 1, minute: 50 }, { side: 1, minute: 60 }, { side: 1, minute: 80 }], possession: 0.64, stats: { ...emptyStats(), onTarget: 9, tackles: 12 } }), now);
      finished += r.finished.length;
    }
    expect(finished).toBe(3);
    expect(s.stars).toBe(1);
    expect(s.done.sort()).toEqual(week.map((c) => c.id).sort());
    expect(levelOf(s.xp).level).toBeGreaterThan(5);
    expect(equipped(s, 'ball')).toBe('ball-elevens');
    s.equip.ball = 'ball-classic';
    expect(equipped(s, 'ball')).toBe('ball-classic');
    s.equip.ball = 'ball-gold'; // not unlocked yet
    expect(equipped(s, 'ball')).toBe('ball-elevens');
    // A new week starts afresh.
    rollWeek(s, new Date(2026, 10, 24));
    expect(s.done).toEqual([]);
  });

  it('every challenge can be met by some match and every reward has a level', () => {
    for (const c of CHALLENGES) expect(c.target).toBeGreaterThan(0);
    for (const c of COSMETICS) expect(c.level).toBeGreaterThanOrEqual(1);
  });
});
