// Score-aware computer sides, rebounds and loose balls, player ratings / Man of the Match,
// the extra clubs and the cup and league.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { gameState, restartUrgency } from '../src/shared/ai/gamestate';
import { mentalityOf, planTeams, REBOUND } from '../src/shared/ai/team';
import { rateMatch, newPlayerStats } from '../src/shared/ratings';
import { ALL_CLUBS, ROLES, TEAMS, teamById } from '../src/shared/teams';
import { leagueTable, myFixture, newCompetition, opponentOf, recordResult, simulateScore } from '../src/shared/competition';
import { Rng } from '../src/shared/rng';
import { encodeSnapshot } from '../src/shared/snapshot';

function aiMatch(seed = 3, humans: [boolean, boolean] = [true, false]) {
  const m = new Match(defaultConfig({ humans, realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  return m;
}

/** Put the match at a given minute of the second half with a given score. */
function at(m: Match, minute: number, score: [number, number]) {
  m.half = 2;
  m.clock = (minute - 45) * 60;
  m.score = score;
}

describe('score-aware computer sides', () => {
  it('is neutral when level, in the first half, or for the human side', () => {
    const m = aiMatch();
    at(m, 80, [1, 1]);
    expect(gameState(m, 1)).toBe(0);
    at(m, 30, [2, 0]);
    m.half = 1; m.clock = 30 * 60;
    expect(gameState(m, 1)).toBe(0);
    at(m, 85, [0, 1]);
    expect(gameState(m, 0)).toBe(0); // team 0 is human
  });
  it('chases when behind late and protects a lead, more as the clock runs down', () => {
    const m = aiMatch();
    at(m, 70, [1, 0]);
    const mid = gameState(m, 1);
    at(m, 88, [1, 0]);
    const late = gameState(m, 1);
    expect(mid).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(mid);
    expect(late).toBeCloseTo(0.9, 5);
    at(m, 88, [0, 1]);
    expect(gameState(m, 1)).toBeCloseTo(-1, 5);
    at(m, 88, [0, 3]);
    expect(gameState(m, 1)).toBeGreaterThan(-0.6); // a big lead is managed calmly
  });
  it('pushes the line up and presses more when chasing; drops off when protecting', () => {
    const m = aiMatch();
    at(m, 50, [0, 0]);
    const base = mentalityOf(m, 1);
    at(m, 88, [2, 0]);
    const chase = mentalityOf(m, 1);
    at(m, 88, [0, 1]);
    const sit = mentalityOf(m, 1);
    expect(chase.lineOffset).toBeGreaterThan(base.lineOffset + 6);
    expect(chase.pressers).toBeGreaterThan(base.pressers);
    expect(chase.runChance).toBeGreaterThan(base.runChance);
    expect(sit.lineOffset).toBeLessThan(base.lineOffset - 6);
    expect(sit.pressers).toBeLessThanOrEqual(base.pressers);
    expect(sit.runChance).toBeLessThan(base.runChance);
  });
  it('takes its time over restarts when protecting a lead, never when chasing', () => {
    expect(restartUrgency(0.9, 'throwin')).toBe(0);
    expect(restartUrgency(-1, 'goalkick')).toBeGreaterThan(2);
    expect(restartUrgency(-1, 'penalty')).toBe(0);
  });
  it('a computer keeper holds the ball longer when protecting a lead', () => {
    const release = (score: [number, number]) => {
      const m = aiMatch(5, [false, false]);
      at(m, 88, score);
      const gk = m.keeper(1);
      const dir = m.attackDir(1);
      gk.pos = { x: -dir * 48, z: 0 };
      for (const o of m.teamPlayers(0)) if (o.role !== 'GK') { o.pos = { x: dir * 15, z: (o.slot - 5) * 5 }; o.vel = { x: 0, z: 0 }; }
      const b = m.ball;
      b.owner = gk.id; b.state = 'held'; b.flight = 'none'; b.lastTouch = gk.id; b.lastTouchTeam = 1;
      b.pos = { x: gk.pos.x, y: 1.15, z: 0 }; b.vel = { x: 0, y: 0, z: 0 };
      m.holdT = 0;
      const t0 = m.time;
      for (let i = 0; i < 600; i++) { m.step(); if (m.ball.owner !== gk.id) break; }
      return m.time - t0;
    };
    expect(release([0, 1])).toBeGreaterThan(release([1, 0]) + 1);
  });
});

describe('rebounds and loose balls', () => {
  it('after a shot, attackers near the box follow it in', () => {
    const m = aiMatch(9, [false, false]);
    const dir = m.attackDir(1);
    const goalX = dir * 52.5;
    // A parried ball loose in front of goal, just after team 1 shot.
    const b = m.ball;
    b.owner = -1; b.state = 'free'; b.flight = 'deflect'; b.lastTouch = m.keeper(0).id; b.lastTouchTeam = 0;
    b.pos = { x: goalX - dir * 6, y: 0.3, z: 2 }; b.vel = { x: -dir * 4, y: 0, z: 1 };
    m.lastShot = { team: 1, player: 1 * 11 + 9, onTarget: true, time: m.time - 0.4 };
    const fw = m.teamPlayers(1).filter((p) => p.role === 'ST' || p.role === 'RW' || p.role === 'LW');
    fw.forEach((p, i) => { p.pos = { x: goalX - dir * (18 + i * 2), z: (i - 1) * 8 }; p.vel = { x: 0, z: 0 }; });
    for (const p of m.plans) if (p) p.nextAt = 0;
    planTeams(m);
    const plan = m.plans[1]!;
    expect(plan.followIn.size + (plan.chaser >= 0 ? 1 : 0) + (plan.chaser2 >= 0 ? 1 : 0)).toBeGreaterThanOrEqual(2);
    for (const T of plan.followIn.values()) expect(Math.abs(T.x - goalX)).toBeLessThan(REBOUND.depth + 4);
    // Two from each side scramble for the loose ball in the box.
    expect(m.plans[0]!.chaser).toBeGreaterThanOrEqual(0);
  });
  it('hard shots are sometimes spilled into the six-yard area', () => {
    let spills = 0;
    for (let s = 1; s <= 40; s++) {
      const m = aiMatch(s, [false, false]);
      const gk = m.keeper(0);
      const side = Math.sign(m.ownGoalX(0));
      gk.pos = { x: side * 51.5, z: 0 }; gk.vel = { x: 0, z: 0 }; gk.action = { type: 'none', t: 0, dur: 0 } as never;
      const b = m.ball;
      b.owner = -1; b.state = 'flight'; b.flight = 'shot'; b.lastTouch = 20; b.lastTouchTeam = 1; b.kicker = 20; b.kickLock = 0;
      b.pos = { x: side * 44, y: 1.0, z: 0 }; b.vel = { x: side * 30, y: 0.2, z: 0 }; b.spin = 0;
      for (let i = 0; i < 30; i++) {
        m.step();
        if ((b.flight as string) === 'deflect') { if (Math.hypot(b.vel.x, b.vel.z) < 7) spills++; break; }
        if ((b.state as string) === 'held' || m.phase !== 'play') break;
      }
    }
    expect(spills).toBeGreaterThan(0);
  });
});

describe('player ratings and Man of the Match', () => {
  it('rates everyone from 3 to 10 after a full match, with one Man of the Match', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: 11 }));
    for (let i = 0; i < 60 * 60 * 12 && m.phase !== 'fulltime'; i++) { m.step(); if (m.phase === 'halftime' && m.phaseT > 1) m.continueAfterHalftime(); }
    expect(m.phase).toBe('fulltime');
    const r = m.ratings();
    expect(r.length).toBeGreaterThanOrEqual(22);
    for (const x of r) { expect(x.rating).toBeGreaterThanOrEqual(3); expect(x.rating).toBeLessThanOrEqual(10); }
    expect(r.filter((x) => x.motm)).toHaveLength(1);
    // Per-player lines add up to the team stats.
    for (const t of [0, 1]) {
      const mine = r.filter((x) => x.team === t);
      expect(mine.reduce((s, x) => s + x.shots, 0)).toBe(m.stats[t].shots);
      expect(mine.reduce((s, x) => s + x.passes, 0)).toBe(m.stats[t].passes);
      expect(mine.reduce((s, x) => s + x.goals, 0) + r.filter((x) => x.team !== t).reduce((s, x) => s + x.ownGoals, 0)).toBe(m.score[t]);
    }
    // Ratings travel to online players with the full-time stats.
    expect(encodeSnapshot(m, 0, [], true).ps?.length).toBe(r.length);
  });
  it('a hat-trick beats a quiet game, and a keeper pays for goals conceded', () => {
    const def = { name: 'A B', short: 'B', number: 9 };
    const st = { ...newPlayerStats(9, 0, def, 'ST'), goals: 3, shots: 5, onTarget: 4, passes: 10, completed: 8 };
    const mid = { ...newPlayerStats(7, 0, def, 'RCM'), passes: 20, completed: 15 };
    const gk = { ...newPlayerStats(11, 1, def, 'GK'), saves: 1 };
    const goals = [0, 1, 2].map((i) => ({ team: 0 as const, player: 9, minute: 20 + i * 20, ownGoal: false }));
    const r = rateMatch([st, mid, gk], goals, [3, 0], 90);
    expect(r[0].rating).toBeGreaterThan(8.5);
    expect(r[0].motm).toBe(true);
    expect(r[2].rating).toBeLessThan(6);
    expect(r[1].rating).toBeGreaterThan(5.5);
  });
  it('a substitute gets their own line from the minute they came on', () => {
    const m = aiMatch(4, [true, false]);
    m.half = 2; m.clock = 20 * 60;
    (m as unknown as { makeSub(t: number, id: number, b: number): void }).makeSub(0, 9, 4);
    expect(m.statsOff).toHaveLength(1);
    expect(m.statsOff[0].to).toBe(65);
    expect(m.pstats[9].from).toBe(65);
    expect(m.pstats[9].short).not.toBe(m.statsOff[0].short);
  });
});

describe('cup and league', () => {
  it('has twenty valid clubs, with the two main clubs still the online ones', () => {
    expect(TEAMS).toHaveLength(2);
    expect(ALL_CLUBS).toHaveLength(20);
    expect(new Set(ALL_CLUBS.map((t) => t.id)).size).toBe(20);
    expect(new Set(ALL_CLUBS.map((t) => t.abbr)).size).toBe(20);
    expect(new Set(ALL_CLUBS.map((t) => t.name)).size).toBe(20);
    for (const t of ALL_CLUBS) {
      expect(teamById(t.id)).toBe(t);
      expect(new Set(t.players.map((p) => p.role))).toEqual(new Set(ROLES));
      expect(new Set(t.players.map((p) => p.number)).size).toBe(11);
      for (const p of t.players) for (const v of Object.values(p.attrs)) { expect(v).toBeGreaterThanOrEqual(10); expect(v).toBeLessThanOrEqual(99); }
    }
    // A match can be played between any two of them.
    const m = new Match(defaultConfig({ teams: ['saltmarsh', 'portcalder'], humans: [false, false], seed: 2 }));
    for (let i = 0; i < 600; i++) m.step();
    expect(m.teams[0].name).toBe('Saltmarsh United');
  });
  it('a league is seven rounds where everyone plays everyone once', () => {
    let c = newCompetition('league', 'kestrel', 99);
    expect(c.rounds).toHaveLength(7);
    const pairs = new Set<string>();
    for (const r of c.rounds) {
      expect(r).toHaveLength(4);
      const seen = new Set(r.flatMap((f) => [f.home, f.away]));
      expect(seen.size).toBe(8);
      for (const f of r) pairs.add([f.home, f.away].sort().join('-'));
    }
    expect(pairs.size).toBe(28);
    for (let i = 0; i < 7; i++) c = recordResult(c, 1, 0);
    const t = leagueTable(c);
    expect(t.every((r) => r.p === 7)).toBe(true);
    expect(t.find((r) => r.id === 'kestrel')!.pts).toBe(21);
    expect(c.champion).toBe('kestrel');
    expect(myFixture(c)).toBeNull();
  });
  it('a cup is a knockout: win three ties to lift it, lose one and the rest is played out', () => {
    let c = newCompetition('cup', 'redmoor', 5);
    expect(c.rounds[0]).toHaveLength(4);
    const opp = opponentOf(c)!;
    expect(opp).not.toBe('redmoor');
    c = recordResult(c, 1, 1, [5, 4], true);
    expect(c.rounds[0].every((f) => !!f.winner)).toBe(true);
    expect(c.rounds[1]).toHaveLength(2);
    c = recordResult(c, 2, 0);
    c = recordResult(c, 3, 1);
    expect(c.champion).toBe('redmoor');
    let d = newCompetition('cup', 'redmoor', 6);
    d = recordResult(d, 0, 1);
    expect(d.out).toBe(true);
    expect(d.champion).toBeDefined();
    expect(d.rounds).toHaveLength(3);
  });
  it('stronger clubs win simulated matches more often', () => {
    const rng = new Rng(1);
    let strong = 0, weak = 0;
    for (let i = 0; i < 400; i++) {
      const [a, b] = simulateScore(teamById('kestrel'), teamById('portcalder'), rng);
      if (a > b) strong++; else if (b > a) weak++;
    }
    expect(strong).toBeGreaterThan(weak * 1.5);
  });
});
