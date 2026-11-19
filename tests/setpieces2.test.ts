// Called runs, timed free kicks and penalties, keeper rushes (manual and one-on-one) and quick restarts.
import { describe, expect, it } from 'vitest';
import { MATCH, PITCH } from '../src/shared/config';
import { solveShot, timingAccuracy, timingRing } from '../src/shared/kick';
import { Match, defaultConfig } from '../src/shared/match';
import { Rng } from '../src/shared/rng';
import type { InputEvent, MatchConfig, Player, RestartType, TeamIndex } from '../src/shared/types';

type Internals = { award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void };
const I = (m: Match) => m as unknown as Internals;
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = [], sprint = false) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev });
function open(seed = 5, over: Partial<MatchConfig> = {}) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, ...over }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.ctrl[0].autoSwitch = false;
  return m;
}
const none = { type: 'none', t: 0, dur: 0 } as Player['action'];
function give(m: Match, p: Player) {
  p.action = { ...none };
  m.takePossession(p, true);
  m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 };
  m.ball.vel = { x: 0, y: 0, z: 0 };
}

describe('timing ring', () => {
  it('closes to a point half way through each period and is widest at its start', () => {
    expect(timingRing(0)).toBeCloseTo(1, 5);
    expect(timingRing(MATCH.timingPeriod / 2)).toBeCloseTo(0, 5);
    expect(timingRing(MATCH.timingPeriod)).toBeCloseTo(1, 5);
    expect(timingAccuracy(0)).toBeLessThan(0.5);
    expect(timingAccuracy(1)).toBeGreaterThan(2);
  });
  it('good timing tightens a shot; bad timing widens it', () => {
    const m = open();
    const k = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    k.pos = { x: 30, z: 0 }; k.facing = 0; k.vel = { x: 0, z: 0 };
    const spread = (acc: number) => {
      const a: number[] = [];
      for (let s = 1; s <= 200; s++) { const r = solveShot({ kicker: k, ballPos: { x: 30.4, y: 0.11, z: 0 }, pressure: 0, rng: new Rng(s), accuracy: acc }, { side: 1, aimZ: 2, power: 0.6, placed: false }); a.push(Math.atan2(r.vel.z, r.vel.x)); }
      const mean = a.reduce((x, y) => x + y) / a.length;
      return Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
    };
    expect(spread(timingAccuracy(1))).toBeGreaterThan(spread(timingAccuracy(0)) * 3);
  });
  it("a human penalty carries the ring's accuracy at the moment of the kick", () => {
    const m = open(12);
    const dir = m.attackDir(0);
    I(m).award('penalty', 0, { x: dir * (PITCH.halfLength - PITCH.penaltySpot), z: 0 });
    for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
    const r = m.restart!;
    while (r.readyT < MATCH.timingPeriod / 2 - 0.02) { input(m, 0); m.step(); }
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.55 }]);
    m.step();
    const taker = m.players[r.taker];
    // The press starts the run-up; the kick follows when the taker reaches the ball.
    expect(r.runup).toBeTruthy();
    for (let i = 0; i < 150 && taker.action.type !== 'kick'; i++) { input(m, 0); m.step(); }
    expect(taker.action.type).toBe('kick');
    expect(taker.action.accuracy).toBeLessThan(0.6);
  });
});

describe('called runs', () => {
  it('the switch button with the ball sends a forward in behind the defence', () => {
    const m = open(7);
    const dir = m.attackDir(0);
    const p = m.teamPlayers(0).find((q) => q.role === 'LCM')!;
    m.ctrl[0].pid = p.id;
    p.pos = { x: dir * 5, z: -6 }; p.facing = dir > 0 ? 0 : Math.PI;
    give(m, p);
    input(m, 0, 0, 0, [{ k: 'switch' }]);
    m.step();
    const st = m.players[m.calledRun[0].pid];
    expect(['ST', 'LW', 'RW']).toContain(st.role);
    expect(m.drainEvents().some((e) => e.type === 'call' && e.player === st.id)).toBe(true);
    const x0 = st.pos.x * dir;
    for (let i = 0; i < 90; i++) { input(m, 0); p.vel = { x: 0, z: 0 }; m.step(); }
    expect(m.ctrl[0].pid).toBe(p.id); // the switch button never takes control away from the carrier
    expect(st.pos.x * dir - x0).toBeGreaterThan(4);
  });
  it('the stick picks which teammate runs', () => {
    const m = open(7);
    const dir = m.attackDir(0);
    const p = m.teamPlayers(0).find((q) => q.role === 'CDM')!;
    m.ctrl[0].pid = p.id;
    p.pos = { x: dir * 0, z: 0 };
    give(m, p);
    const rw = m.teamPlayers(0).find((q) => q.role === 'RW')!;
    // Point the stick at the right winger.
    const v = { x: rw.pos.x - p.pos.x, z: rw.pos.z - p.pos.z }, l = Math.hypot(v.x, v.z);
    input(m, 0, v.x / l, v.z / l, [{ k: 'switch' }]);
    m.step();
    expect(m.calledRun[0].pid).toBe(rw.id);
  });
});

/**
 * Both sides human: team 1's striker has the ball, alone, from `d` metres out, and is steered
 * at team 0's goal each step by `push`. Team 0's keeper is computer-run as always.
 */
function through(m: Match, d: number) {
  const ourGoal = m.ownGoalX(0);
  const side = Math.sign(ourGoal);
  const st = m.teamPlayers(1).find((q) => q.role === 'ST')!;
  for (const q of m.players) if (q !== st && q.role !== 'GK') { q.pos = { x: -side * 40, z: (q.id % 11) * 5 - 25 }; q.vel = { x: 0, z: 0 }; }
  st.pos = { x: ourGoal - side * d, z: 2 }; st.facing = side > 0 ? 0 : Math.PI;
  m.ctrl[1].pid = st.id; m.ctrl[1].autoSwitch = false;
  give(m, st);
  const gk = m.keeper(0);
  gk.pos = { x: ourGoal - side * 1, z: 0 }; gk.vel = { x: 0, z: 0 };
  const push = (speed = 1) => input(m, 1, side * speed, 0);
  return { st, gk, side, ourGoal, push };
}
const both = (seed: number) => open(seed, { humans: [true, true] });

describe('keepers', () => {
  it('a computer keeper comes out to a striker clean through, but not with a defender covering', () => {
    const run = (covered: boolean) => {
      const m = both(9);
      const { gk, ourGoal, side, push } = through(m, 15);
      if (covered) { const cb = m.teamPlayers(0).find((q) => q.role === 'RCB')!; cb.pos = { x: ourGoal - side * 6, z: 2 }; }
      for (let i = 0; i < 60; i++) { push(); input(m, 0); m.step(); }
      return Math.abs(gk.pos.x - ourGoal);
    };
    expect(run(false)).toBeGreaterThan(run(true) + 1);
  });
  it('the keeper-rush button sends the keeper at a striker who is not yet clean through', () => {
    const run = (rush: boolean) => {
      const m = both(9);
      const { gk, ourGoal, side, push } = through(m, 24);
      // A covering defender keeps the computer keeper on the line.
      const cb = m.teamPlayers(0).find((q) => q.role === 'RCB')!;
      cb.pos = { x: ourGoal - side * 8, z: 2 };
      // Skill takes control of the keeper; pass then sends him out.
      if (rush) { input(m, 0, 0, 0, [{ k: 'skill' }]); m.step(); input(m, 0, 0, 0, [{ k: 'pass' }]); }
      for (let i = 0; i < 70; i++) { push(0.4); input(m, 0); m.step(); }
      return Math.abs(gk.pos.x - ourGoal);
    };
    expect(run(true)).toBeGreaterThan(run(false) + 1.5);
  });
  it('a keeper reaching a striker in the area smothers the ball or ends up on the ground', () => {
    let won = 0, beaten = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const m = both(seed);
      const { st, gk, push } = through(m, 9);
      gk.pos = { x: st.pos.x + (gk.pos.x > st.pos.x ? 2 : -2), z: st.pos.z };
      for (let i = 0; i < 40; i++) {
        push(0.3); input(m, 0);
        m.step();
        if (m.ball.owner === gk.id) { won++; break; }
        if (gk.action.type === 'down') { beaten++; break; }
      }
    }
    expect(won).toBeGreaterThan(0);
    expect(won + beaten).toBeGreaterThan(8);
  });
});

describe('quick restarts', () => {
  const setup = (quick: boolean) => {
    const m = open(4, { quickRestarts: [quick, true] });
    const dir = m.attackDir(0);
    I(m).award('throwin', 0, { x: dir * 10, z: PITCH.halfWidth });
    return m;
  };
  it('a press as the taker reaches the ball takes the throw-in before everyone is set', () => {
    const m = setup(true);
    let taken = -1;
    for (let i = 0; i < 400 && taken < 0; i++) {
      input(m, 0, 0, -1, m.restart && m.restart.t > 0.8 && i % 20 === 0 ? [{ k: 'pass', p: 0.2 }] : []);
      m.step();
      if (m.phase === 'play') taken = i;
    }
    expect(taken).toBeGreaterThan(0);
    expect(taken / 60).toBeLessThan(MATCH.restartSetupMax);
  });
  it('with quick restarts off, nothing is taken before the restart is set', () => {
    const m = setup(false);
    for (let i = 0; i < 60 * 1.2; i++) { input(m, 0, 0, -1, i % 20 === 0 ? [{ k: 'pass', p: 0.2 }] : []); m.step(); }
    expect(m.phase === 'restart' && !m.restart!.ready).toBe(true);
  });
  it('presses while the ball is still being fetched are ignored', () => {
    const m = setup(true);
    input(m, 0, 0, 0, [{ k: 'pass', p: 0.2 }]);
    for (let i = 0; i < 60; i++) { input(m, 0); m.step(); }
    expect(m.phase).toBe('restart');
  });
});
