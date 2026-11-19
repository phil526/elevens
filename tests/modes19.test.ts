import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { SCENARIOS, applyScenario, dailyScenario, scenarioMet, scenarioMinutes } from '../src/shared/scenarios';
import { freshTargets } from '../src/shared/skillgames';
import { INJURY, startInjury, injuryChance } from '../src/shared/injury';
import { PITCH } from '../src/shared/config';
import { toOpenPlay } from './helpers';

describe('daily scenarios', () => {
  it('the same date gives the same scenario and clubs, different dates vary', () => {
    const a = dailyScenario('2026-11-19'), b = dailyScenario('2026-11-19');
    expect(a).toEqual(b);
    expect(a.club).not.toBe(a.opp);
    const ids = new Set(Array.from({ length: 30 }, (_, i) => dailyScenario(`2026-12-${String(i + 1).padStart(2, '0')}`).scenario.id));
    expect(ids.size).toBeGreaterThan(8);
  });

  it('picks the match up at the minute and score with red cards', () => {
    const s = SCENARIOS.find((x) => x.id === 'down-to-nine')!;
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: scenarioMinutes(s), seed: 3 }));
    applyScenario(m, s);
    expect(m.half).toBe(2);
    expect(m.displayClock).toBe(75 * 60);
    expect(m.score).toEqual([1, 1]);
    expect(m.goals.length).toBe(2);
    expect(m.players.filter((p) => p.team === 0 && p.off).length).toBe(2);
    // The rest of the match plays out to full time from there.
    let n = 0;
    while (m.phase !== 'fulltime' && n++ < 60 * 60 * 6) m.step();
    expect(m.phase).toBe('fulltime');
    expect(m.half).toBe(2);
  });

  it('judges the target', () => {
    const two = SCENARIOS.find((x) => x.id === 'two-down')!;
    expect(scenarioMet(two, [2, 2])).toBe(true);
    expect(scenarioMet(two, [1, 2])).toBe(false);
    const gd = SCENARIOS.find((x) => x.id === 'goal-difference')!;
    expect(scenarioMet(gd, [2, 0])).toBe(true);
    expect(scenarioMet(gd, [2, 1])).toBe(false);
    const clean = SCENARIOS.find((x) => x.id === 'park-the-bus')!;
    expect(scenarioMet(clean, [1, 0])).toBe(true);
    expect(scenarioMet(clean, [2, 1])).toBe(false);
  });
});

describe('skill games', () => {
  it('crossbar challenge: ten free kicks alone against an empty goal, scored in points', () => {
    const m = new Match(defaultConfig({ humans: [false, false], practice: 'crossbar', challenge: 10, seed: 9 }));
    let n = 0;
    while (m.phase !== 'fulltime' && n++ < 60 * 200) m.step();
    expect(m.phase).toBe('fulltime');
    expect(m.drillAttempts).toBe(10);
    expect(m.skill!.points).toBe(m.score[0]);
    expect(m.players.filter((p) => !p.off).length).toBe(1);
    expect(m.score[1]).toBe(0);
  });

  it('target practice scores a target the ball goes through', () => {
    const m = new Match(defaultConfig({ humans: [false, false], practice: 'targets', challenge: 10, seed: 2 }));
    for (let i = 0; i < 30; i++) m.step();
    const t = m.skill!.targets[0];
    // Ball flying into the top corner of the goal the striker attacks.
    const dir = m.attackDir(0);
    m.phase = 'play'; m.restart = null;
    const b = m.ball;
    b.pos = { x: dir * (PITCH.halfLength - 1), y: t.y, z: t.z }; b.vel = { x: dir * 20, y: 0, z: 0 }; b.state = 'flight'; b.flight = 'shot'; b.owner = -1; b.lastTouchTeam = 0; b.lastTouch = 9;
    for (let i = 0; i < 10; i++) m.step();
    expect(m.skill!.points).toBe(3);
    expect(m.skill!.targets[0].hit).toBe(true);
    expect(freshTargets().length).toBe(5);
  });
});

describe('injuries', () => {
  it('a hurt player is treated, carried off and replaced before the restart', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 5, injuries: true }));
    toOpenPlay(m);
    const v = m.players[6];
    // A foul stops play: the restart waits while he is treated.
    (m as unknown as { award: (t: string, team: number, spot: { x: number; z: number }) => void }).award('freekick', 0, { ...v.pos });
    startInjury(m, v, 2);
    const name = v.def.name, short = v.def.short;
    const clock0 = m.clock;
    let steps = 0, sawCarry = false, offText = '';
    while (m.injury && steps++ < 60 * 30) {
      m.step();
      if (m.injury?.stage === 'carry') sawCarry = true;
      expect(m.restart?.ready ?? false).toBe(false);
      for (const e of m.events) if (e.type === 'injury' && e.text) offText = e.text;
    }
    // The event names him, not the substitute who now has his id.
    expect(offText).toBe(`subbed:${short}`);
    expect(sawCarry).toBe(true);
    expect(steps).toBeGreaterThan(60 * (INJURY.down + INJURY.runOn + INJURY.treat));
    expect(m.clock).toBeGreaterThan(clock0);
    expect(m.injuries[0].name).toBe(name);
    expect(m.injuries[0].matches).toBeGreaterThan(0);
    expect(m.players[6].def.name).not.toBe(name); // a substitute came on
    expect(m.players[6].off).toBe(false);
    expect(m.subsLog.length).toBe(1);
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    expect(m.phase).toBe('play');
  });

  it('a knock: he gets up and plays on', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 6, injuries: true }));
    toOpenPlay(m);
    const v = m.players[8];
    (m as unknown as { award: (t: string, team: number, spot: { x: number; z: number }) => void }).award('freekick', 0, { ...v.pos });
    startInjury(m, v, 1);
    let steps = 0;
    while (m.injury && steps++ < 60 * 20) m.step();
    expect(m.players[8].def.name).toBe(v.def.name);
    expect(m.subsLog.length).toBe(0);
    expect(m.injuries[0].severity).toBe(1);
  });

  it('happen in a match with injuries on, never with them off', () => {
    expect(injuryChance({ slide: true, fromBehind: true }, 2)).toBeGreaterThan(injuryChance({}, 0));
    let on = 0, off = 0;
    for (const inj of [true, false]) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 77, injuries: inj }));
      toOpenPlay(m);
      for (let k = 0; k < 40; k++) {
        m.injury = null;
        m.phase = 'play';
        (m as unknown as { foul: (a: unknown, b: unknown, h: unknown) => void }).foul(m.players[14], m.players[6], { slide: true });
        if (m.injury) { if (inj) on++; else off++; }
      }
    }
    expect(off).toBe(0);
    expect(on).toBeGreaterThan(0);
  });
});
