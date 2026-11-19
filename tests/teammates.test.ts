// Smarter teammates for a human's side: cover when the human presses, counter-press after losing
// the ball, and overlapping full-backs.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { basePos, formationTarget, planTeams, TEAMMATE_ON } from '../src/shared/ai/team';
import type { Player } from '../src/shared/types';

let seq = 1;
const input = (m: Match, mx = 0, mz = 0, sprint = false) => m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [] });

function match(humans: [boolean, boolean] = [true, false], seed = 7) {
  const m = new Match(defaultConfig({ humans, realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  return m;
}
const role = (m: Match, team: number, r: string) => m.teamPlayers(team).find((p) => p.role === r)!;
/** Place a player in team 0's frame (attacking +x). */
function put(m: Match, p: Player, fx: number, fz: number, vx = 0) {
  const dir = m.attackDir(0);
  p.pos = { x: fx * dir, z: fz * dir }; p.vel = { x: vx * dir, z: 0 };
  p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
}
/** Give the ball to p at their feet. */
function give(m: Match, p: Player) {
  const b = m.ball;
  b.owner = p.id; b.state = 'dribble'; b.flight = 'none'; b.receiver = -1; b.lastTouch = p.id; b.lastTouchTeam = p.team;
  b.pos = { x: p.pos.x, y: 0.11, z: p.pos.z }; b.vel = { x: 0, y: 0, z: 0 };
  m.possessionStart = m.time;
}
const replan = (m: Match) => { m.plans = [null, null]; planTeams(m); return m.plans[0]!; };
/** Team 0 spread in a 4-3-3 block in their own half, team 1 around halfway. */
function spread(m: Match) {
  const spots: Record<string, [number, number]> = { GK: [-50, 0], RB: [-30, 24], LB: [-30, -24], RCB: [-36, 9], LCB: [-36, -9], CDM: [-24, 0], RCM: [-14, 12], LCM: [-14, -12], RW: [0, 26], LW: [0, -26], ST: [2, 0] };
  for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 4 + (o.slot % 3) * 6, (o.slot % 5) * 11 - 22);
}

describe('cover when the human presses', () => {
  it('fills the space a centre-back leaves when stepping out to press', () => {
    const m = match();
    spread(m);
    const opp = role(m, 1, 'ST');
    put(m, opp, -20, 6);
    give(m, opp);
    const h = role(m, 0, 'RCB');
    m.ctrl[0].pid = h.id;
    const plan0 = replan(m);
    const home = formationTarget(m, h, plan0);
    // The human charges out from the back line at the striker.
    put(m, h, -24, 7, 6);
    const plan = replan(m);
    expect(plan.fill.size).toBeGreaterThan(0);
    expect(plan.fill.has(h.id)).toBe(false);
    const [fid, zone] = [...plan.fill][0];
    expect(Math.hypot(zone.x - home.x, zone.z - home.z)).toBeLessThan(3);
    expect(['LCB', 'RB', 'LB', 'CDM', 'RCM', 'LCM']).toContain(m.players[fid].role);
    // The filler actually moves into the gap over the next second.
    const f = m.players[fid];
    const d0 = Math.hypot(f.pos.x - zone.x, f.pos.z - zone.z);
    for (let i = 0; i < 60; i++) { input(m, (opp.pos.x - h.pos.x) > 0 ? 1 : -1, 0, true); m.step(); m.drainEvents(); }
    expect(Math.hypot(f.pos.x - zone.x, f.pos.z - zone.z)).toBeLessThan(d0 - 2);
  });

  it('does nothing while the human holds position', () => {
    const m = match();
    spread(m);
    const opp = role(m, 1, 'ST');
    put(m, opp, -20, 6);
    give(m, opp);
    const h = role(m, 0, 'RCB');
    m.ctrl[0].pid = h.id;
    const plan = replan(m);
    put(m, h, formationTarget(m, h, plan).x * m.attackDir(0), formationTarget(m, h, plan).z * m.attackDir(0));
    expect(replan(m).fill.size).toBe(0);
  });
});

describe('counter-press', () => {
  function turnover(humans: [boolean, boolean]) {
    const m = match(humans);
    spread(m);
    const mine = role(m, 0, 'RCM');
    put(m, mine, 10, 8);
    const mates = [role(m, 0, 'ST'), role(m, 0, 'RW'), role(m, 0, 'LCM')];
    put(m, mates[0], 16, 2); put(m, mates[1], 14, 18); put(m, mates[2], 4, -2);
    const h = role(m, 0, 'RB');
    m.ctrl[0].pid = h.id;
    give(m, mine);
    replan(m);
    // Lost it: an opponent nicks the ball off the RCM.
    m.time += 0.3;
    const thief = role(m, 1, 'RCM');
    put(m, thief, 10.5, 9);
    const opts = [role(m, 1, 'LCM'), role(m, 1, 'CDM')];
    put(m, opts[0], 4, 16); put(m, opts[1], 0, 4);
    give(m, thief);
    m.plans[0]!.nextAt = 0;
    planTeams(m);
    return { m, plan: m.plans[0]!, thief };
  }
  it('sends the nearest teammates straight at the ball and into the passing lanes', () => {
    const { m, plan, thief } = turnover([true, false]);
    expect(plan.counter.size).toBeGreaterThanOrEqual(2);
    const hunter = [...plan.counter].find(([, v]) => v === null)?.[0];
    expect(hunter).toBeDefined();
    expect(plan.pressers[0]).toBe(hunter);
    const hp = m.players[hunter!];
    const d0 = Math.hypot(hp.pos.x - thief.pos.x, hp.pos.z - thief.pos.z);
    let closest = d0;
    for (let i = 0; i < 40; i++) { input(m); m.step(); m.drainEvents(); closest = Math.min(closest, Math.hypot(hp.pos.x - m.ball.pos.x, hp.pos.z - m.ball.pos.z)); }
    expect(closest).toBeLessThan(Math.max(1.6, d0 - 1));
  });
  it('stops after the window and leaves AI v AI alone', () => {
    const { m } = turnover([true, false]);
    m.time += 3.5;
    m.plans[0]!.nextAt = 0;
    planTeams(m);
    expect(m.plans[0]!.counter.size).toBe(0);
    expect(turnover([false, false]).plan.counter.size).toBe(0);
  });
  it('can be switched off', () => {
    TEAMMATE_ON.counter = false;
    try { expect(turnover([true, false]).plan.counter.size).toBe(0); } finally { TEAMMATE_ON.counter = true; }
  });
});

describe('overlapping full-back', () => {
  it('runs past the human winger on the outside while the holding midfielder minds the gap', () => {
    const m = match();
    spread(m);
    const dir = m.attackDir(0);
    const w = role(m, 0, 'RW');
    const side = Math.sign(basePos(m, 0, 'RW').z);
    const fb = m.teamPlayers(0).find((p) => (p.role === 'RB' || p.role === 'LB') && Math.sign(basePos(m, 0, p.role).z) === side)!;
    put(m, w, 8, side * 22);
    w.facing = dir > 0 ? 0 : Math.PI;
    put(m, fb, -6, side * 24);
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 30 + (o.slot % 3) * 4, (o.slot % 5) * 6 - 12);
    m.ctrl[0].pid = w.id;
    give(m, w);
    replan(m);
    let started = -1, filled = false, maxAhead = -99;
    for (let i = 0; i < 300; i++) {
      for (const o of m.teamPlayers(1)) o.vel = { x: 0, z: 0 };
      input(m, 0.25 * dir, 0, false); // the human walks it forward
      m.step(); m.drainEvents();
      if (m.ball.owner !== w.id) give(m, w);
      if (fb.runLane === 6 && started < 0) started = i;
      if (m.plans[0]!.fill.has(role(m, 0, 'CDM').id)) filled = true;
      maxAhead = Math.max(maxAhead, (fb.pos.x - w.pos.x) * dir);
    }
    expect(started).toBeGreaterThanOrEqual(0);
    expect(maxAhead).toBeGreaterThan(4); // went past the winger
    expect(filled).toBe(true);
  });
  it('does not happen for AI teams', () => {
    const m = match([false, false]);
    spread(m);
    const w = role(m, 0, 'RW');
    put(m, w, 8, 22);
    give(m, w);
    for (let i = 0; i < 60; i++) { m.step(); m.drainEvents(); }
    expect(m.teamPlayers(0).some((p) => p.runLane === 6)).toBe(false);
  });
});

describe('more teammate behaviours (ideas 4-10)', () => {
  it('steps the back line up together on a back pass', () => {
    const m = match();
    spread(m);
    const dir = m.attackDir(0);
    const opp = role(m, 1, 'RCM');
    put(m, opp, -10, 0);
    give(m, opp);
    const h = role(m, 0, 'ST');
    m.ctrl[0].pid = h.id;
    const before = replan(m);
    const cb = role(m, 0, 'RCB');
    const x0 = formationTarget(m, cb, before).x * dir;
    // They play it back towards their own goal.
    const b = m.ball;
    b.owner = -1; b.state = 'flight'; b.flight = 'pass'; b.lastTouchTeam = 1; b.vel = { x: 9 * dir, y: 0, z: 0 };
    const plan = replan(m);
    expect(plan.stepUpUntil).toBeGreaterThan(m.time);
    expect(formationTarget(m, cb, plan).x * dir).toBeGreaterThan(x0 + 3);
  });

  it('free teammates call for the ball, and a midfielder drops in when the carrier is pressed', () => {
    const m = match();
    spread(m);
    const c = role(m, 0, 'RCM');
    put(m, c, -10, 10);
    m.ctrl[0].pid = c.id;
    give(m, c);
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 30 + (o.slot % 3) * 3, (o.slot % 5) * 8 - 16);
    const plan = replan(m);
    expect(plan.callers.length).toBeGreaterThan(0);
    expect(m.players[plan.callers[0]].callUntil).toBeGreaterThan(m.time);
    // Now an opponent closes the carrier down from the front.
    put(m, role(m, 1, 'ST'), -8, 10);
    const pressed = replan(m);
    expect(pressed.helper).toBeGreaterThanOrEqual(0);
    const hp = m.players[pressed.helper];
    expect(['CDM', 'LCM', 'RCM']).toContain(hp.role);
    const spot = pressed.supportSpots.get(hp.id)!;
    expect(Math.hypot(spot.x - c.pos.x, spot.z - c.pos.z)).toBeLessThan(11);
  });

  it('attacks the near post, far post, spot and edge when the human crosses', () => {
    const m = match();
    spread(m);
    const w = role(m, 0, 'RW');
    const side = Math.sign(basePos(m, 0, 'RW').z);
    put(m, w, 40, side * 28);
    m.ctrl[0].pid = w.id;
    give(m, w);
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 44 + (o.slot % 3), (o.slot % 5) * 4 - 8);
    const plan = replan(m);
    expect(plan.boxGo).toBe(true);
    const dir = m.attackDir(0);
    const zs = [...plan.boxTargets.values()].map((t) => ({ x: t.x * dir, z: t.z * dir }));
    expect(zs.length).toBeGreaterThanOrEqual(4);
    expect(zs.some((t) => t.x > 45 && t.z * side > 1)).toBe(true); // near post
    expect(zs.some((t) => t.x > 44 && t.z * side < -3)).toBe(true); // far post
    expect(zs.some((t) => t.x < 37)).toBe(true); // edge of the box
  });

  it('keeps the far winger wide for a switch', () => {
    const m = match();
    spread(m);
    const c = role(m, 0, 'RCM');
    const side = Math.sign(basePos(m, 0, 'RCM').z);
    put(m, c, 18, side * 20);
    m.ctrl[0].pid = c.id;
    give(m, c);
    const plan = replan(m);
    const farWing = m.teamPlayers(0).find((p) => (p.role === 'LW' || p.role === 'RW') && Math.sign(basePos(m, 0, p.role).z) === -side)!;
    expect(Math.abs(formationTarget(m, farWing, plan).z)).toBeGreaterThan(28);
  });

  it('player instructions move players and stop runs; they arrive as input events', () => {
    const m = match();
    spread(m);
    const c = role(m, 0, 'RCM');
    put(m, c, 10, 0);
    m.ctrl[0].pid = c.id;
    give(m, c);
    const lb = role(m, 0, 'LB');
    const plan = replan(m);
    const dir = m.attackDir(0);
    const x0 = formationTarget(m, lb, plan).x * dir;
    m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [{ k: 'instr', p: (lb.slot * 3 + 0) / 32 }] });
    expect(m.instr[0][lb.slot]).toBe(-1);
    expect(formationTarget(m, lb, replan(m)).x * dir).toBeLessThan(x0 - 3);
    m.setInstruction(0, lb.slot, 1);
    expect(formationTarget(m, lb, replan(m)).x * dir).toBeGreaterThan(x0 + 3);
  });

  it('marks callers in the network snapshot', async () => {
    const { encodeSnapshot } = await import('../src/shared/snapshot');
    const m = match();
    const p = role(m, 0, 'ST');
    p.callUntil = m.time + 1;
    const s = encodeSnapshot(m, 0, [], false);
    expect(s.p[p.id * 11 + 10] & 16).toBe(16);
  });
});
