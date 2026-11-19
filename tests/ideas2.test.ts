// Third-man and decoy runs, defending (runner tracking, passing-lane cover, AI timed runs),
// cross types and keeper distribution.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { solveCross } from '../src/shared/kick';
import { stepBall } from '../src/shared/ball';
import { planTeams, thirdManRun } from '../src/shared/ai/team';
import { chooseDistribution, counterOn, pickDistribution } from '../src/shared/ai/distribution';
import type { InputEvent, Player } from '../src/shared/types';

let seq = 1;
const idle = (m: Match, team: 0 | 1, ev: InputEvent[] = [], mx = 0, mz = 0, jockey = false) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: false, jockey, contain: false, ev });

function humanMatch(seed = 7) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  return m;
}

/** Give our keeper the ball in their hands, everyone else spread out and still. */
function keeperHolds(m: Match) {
  const dir = m.attackDir(0);
  const gk = m.keeper(0);
  gk.pos = { x: -dir * 48, z: 0 }; gk.vel = { x: 0, z: 0 }; gk.facing = dir > 0 ? 0 : Math.PI;
  gk.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  const spots: Record<string, [number, number]> = { RB: [-30, -24], LB: [-30, 24], RCB: [-38, -10], LCB: [-38, 10], CDM: [-20, 0], RCM: [-8, -14], LCM: [-8, 14], RW: [10, -26], LW: [10, 26], ST: [8, 0] };
  for (const p of m.teamPlayers(0)) {
    const s = spots[p.role];
    if (s) { p.pos = { x: s[0] * dir, z: s[1] }; p.vel = { x: 0, z: 0 }; }
  }
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') { o.pos = { x: dir * (25 + (o.slot % 3) * 4), z: (o.slot % 5) * 10 - 20 }; o.vel = { x: 0, z: 0 }; }
  const b = m.ball;
  b.owner = gk.id; b.state = 'held'; b.flight = 'none'; b.lastTouch = gk.id; b.lastTouchTeam = 0;
  b.pos = { x: gk.pos.x, y: 1.15, z: 0 }; b.vel = { x: 0, y: 0, z: 0 };
  m.holdT = 0.6;
  return { gk, dir };
}

/** Release a distribution with one button and follow the ball until it lands or is collected. */
function distribute(k: 'pass' | 'lob' | 'through' | 'shoot', p: number, mx = 0, mz = 0) {
  const m = humanMatch();
  const { gk, dir } = keeperHolds(m);
  idle(m, 0, [{ k, p }], mx * dir, mz);
  let flight = '', maxY = 0, released = false, travel = 0, receiver = -1;
  const start = { ...gk.pos };
  for (let i = 0; i < 360; i++) {
    for (const o of m.teamPlayers(1)) o.vel = { x: 0, z: 0 };
    m.step(); m.drainEvents();
    idle(m, 0);
    if (m.ball.state === 'flight') {
      if (!released) { released = true; flight = m.ball.flight; receiver = m.ball.receiver; }
      maxY = Math.max(maxY, m.ball.pos.y);
      travel = Math.max(travel, Math.hypot(m.ball.pos.x - start.x, m.ball.pos.z - start.z));
    }
    if (released && (m.ball.state !== 'flight' || m.ball.pos.y <= 0.12 && i > 30 && flight !== 'pass')) break;
  }
  return { flight, maxY, travel, receiver, m };
}

describe('keeper distribution', () => {
  it('pass rolls it out along the ground, lob throws it, through drop-kicks it, shoot punts it furthest', () => {
    const roll = distribute('pass', 0.3);
    const thr = distribute('lob', 0.5);
    const drop = distribute('through', 0.6);
    const punt = distribute('shoot', 0.9);
    expect(roll.flight).toBe('pass');
    expect(roll.maxY).toBeLessThan(0.4);
    expect(thr.flight).toBe('throw');
    expect(drop.flight).toBe('lob');
    expect(punt.flight).toBe('lob');
    expect(punt.travel).toBeGreaterThan(drop.travel * 0.9);
    expect(punt.travel).toBeGreaterThan(38);
    expect(punt.maxY).toBeGreaterThan(drop.maxY); // the drop-kick is flatter
  });
  it('the stick picks who it goes to', () => {
    const left = distribute('lob', 0.5, 0.6, 1);
    const right = distribute('lob', 0.5, 0.6, -1);
    expect(left.receiver).toBeGreaterThanOrEqual(0);
    expect(right.receiver).toBeGreaterThanOrEqual(0);
    const zl = left.m.players[left.receiver].pos.z, zr = right.m.players[right.receiver].pos.z;
    expect(zl).toBeGreaterThan(0);
    expect(zr).toBeLessThan(0);
  });
  it('the preview pick follows the stick and the charge (near on a tap, far on a long hold)', () => {
    const m = humanMatch();
    const { gk, dir } = keeperHolds(m);
    const near = pickDistribution(m.players, gk, dir, 0, 'throw', dir, 0);
    const far = pickDistribution(m.players, gk, dir, 0, 'throw', dir, 1);
    expect(near.receiver).toBeGreaterThanOrEqual(0);
    expect(far.receiver).toBeGreaterThanOrEqual(0);
    const d = (id: number) => Math.hypot(m.players[id].pos.x - gk.pos.x, m.players[id].pos.z - gk.pos.z);
    expect(d(far.receiver)).toBeGreaterThan(d(near.receiver));
  });
  it('an AI keeper releases quickly to start a counter when the opponents are caught upfield', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: 5 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const { gk, dir } = keeperHolds(m);
    // Six opponents still deep in our half.
    m.teamPlayers(1).filter((o) => o.role !== 'GK').slice(0, 6).forEach((o, i) => { o.pos = { x: -dir * (30 + i), z: i * 4 - 10 }; });
    expect(counterOn(m, gk)).toBe(true);
    const c = chooseDistribution(m, gk);
    expect(c.quick).toBe(true);
    expect(['throw', 'lob']).toContain(c.req.kind);
    m.holdT = 0.5;
    const t0 = m.time;
    let t = -1;
    for (let i = 0; i < 240; i++) { m.step(); m.drainEvents(); if (m.ball.state === 'flight') { t = m.time - t0; break; } }
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1.2); // well inside the usual 1.4 s+ wait
    expect(m.ball.lastTouch).toBe(gk.id);
  });
});

describe('cross types', () => {
  const m = new Match(defaultConfig({ humans: [false, false], seed: 3 }));
  const p = m.players[7];
  p.facing = -Math.PI / 2;
  const from = { x: 40, y: 0.11, z: 28 }, target = { x: 46, z: 0 };
  const fly = (style: 'floated' | 'whipped') => {
    const r = solveCross({ kicker: p, ballPos: { ...from }, pressure: 0, rng: m.rng }, target, style, 1);
    const b = { pos: { ...from }, vel: { ...r.vel }, spin: r.spin };
    let t = 0, apex = 0, best = 99, hAt = 0, tAt = 0;
    for (let i = 0; i < 480; i++) {
      stepBall(b, 1 / 120, false); t += 1 / 120;
      apex = Math.max(apex, b.pos.y);
      const d = Math.hypot(b.pos.x - target.x, b.pos.z - target.z);
      if (d < best) { best = d; hAt = b.pos.y; tAt = t; }
    }
    return { apex, best, hAt, tAt, spin: r.spin };
  };
  it('a whipped cross is faster and flatter than a floated one, curls, and is still head high at the target', () => {
    const f = fly('floated'), w = fly('whipped');
    expect(w.tAt).toBeLessThan(f.tAt * 0.75);
    expect(w.apex).toBeLessThan(f.apex * 0.6);
    expect(w.spin).not.toBe(0);
    expect(w.best).toBeLessThan(3.5);
    expect(w.hAt).toBeGreaterThan(0.6);
    expect(w.hAt).toBeLessThan(2.4);
    expect(f.apex).toBeGreaterThan(3.5);
  });

  function humanCross(e: InputEvent, jockey = false, at = { x: 38, z: 27 }) {
    const m = humanMatch(4);
    const dir = m.attackDir(0);
    const w = m.teamPlayers(0).find((q) => q.role === (at.z > 0 ? 'LW' : 'RW'))!;
    const st = m.teamPlayers(0).find((q) => q.role === 'ST')!;
    m.ctrl[0].pid = w.id; m.ctrl[0].autoSwitch = false;
    w.pos = { x: at.x * dir, z: at.z }; w.vel = { x: 0, z: 0 }; w.facing = Math.atan2(-at.z, 0);
    st.pos = { x: 44 * dir, z: 2 }; st.vel = { x: dir * 4, z: 0 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: dir * (10 + o.slot), z: -20 + o.slot * 3 };
    m.takePossession(w, true);
    m.ball.pos = { x: w.pos.x, y: 0.11, z: w.pos.z - 0.5 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    idle(m, 0, [e], 0, -1, jockey);
    for (let i = 0; i < 120 && m.ball.state !== 'flight'; i++) { m.step(); m.drainEvents(); idle(m, 0, [], 0, -1, jockey); }
    return { flight: m.ball.flight, spin: m.ball.spin, vy: m.ball.vel.y, receiver: m.ball.receiver, st };
  }
  it('from wide, lob floats a cross; with the modifier it is whipped; a driven pass is a low cross', () => {
    const fl = humanCross({ k: 'lob', p: 0.5 });
    const wh = humanCross({ k: 'lob', p: 0.5, m: true }, true);
    const lo = humanCross({ k: 'pass', p: 0.5, m: true }, true);
    expect(fl.flight).toBe('cross');
    expect(fl.spin).toBe(0);
    expect(wh.flight).toBe('cross');
    expect(wh.spin).not.toBe(0);
    expect(wh.vy).toBeLessThan(fl.vy);
    expect(lo.flight).toBe('pass');
    expect(lo.vy).toBe(0);
  });
  it('an early whipped cross can be played from deeper', () => {
    const wh = humanCross({ k: 'lob', p: 0.5, m: true }, true, { x: 20, z: 24 });
    expect(wh.flight).toBe('cross');
    expect(wh.spin).not.toBe(0);
  });
});

describe('third-man and decoy runs', () => {
  it('a pass sets a teammate beyond the receiver off in behind, sometimes with a decoy the other way', () => {
    let third = 0, decoy = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const m = humanMatch(seed);
      const dir = m.attackDir(0);
      const cm = m.teamPlayers(0).find((q) => q.role === 'RCM')!;
      const recv = m.teamPlayers(0).find((q) => q.role === 'LCM')!;
      cm.pos = { x: -5 * dir, z: -8 }; recv.pos = { x: 8 * dir, z: 6 };
      m.teamPlayers(0).find((q) => q.role === 'ST')!.pos = { x: 18 * dir, z: -4 };
      m.teamPlayers(0).find((q) => q.role === 'LW')!.pos = { x: 16 * dir, z: 22 };
      m.teamPlayers(0).find((q) => q.role === 'RW')!.pos = { x: 16 * dir, z: -22 };
      for (const q of m.players) q.runLane = 0;
      planTeams(m);
      m.plans[0]!.offsideLineFx = 22;
      thirdManRun(m, cm, recv);
      const runner = m.teamPlayers(0).find((q) => q.runLane === 4);
      if (runner) {
        third++;
        expect(runner.runTo).not.toBeNull();
        expect(runner.runTo!.x * dir).toBeGreaterThan(22); // in behind the line
        expect(runner.id).not.toBe(cm.id);
        expect(runner.id).not.toBe(recv.id);
      }
      if (m.teamPlayers(0).some((q) => q.runLane === 5)) decoy++;
    }
    expect(third).toBeGreaterThan(6);
    expect(decoy).toBeGreaterThan(0);
  });
});

describe('defending', () => {
  /** AI v AI: team 1 has the ball in midfield; returns team 0's plan after a few updates. */
  function defendingPlan(prep?: (m: Match, dir: number) => void) {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: 9, difficulty: ['elite', 'pro'] }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const dir = m.attackDir(0); // team 0 defends the goal at -dir
    const c = m.teamPlayers(1).find((q) => q.role === 'RCM')!;
    c.pos = { x: 5 * dir, z: 0 }; c.vel = { x: 0, z: 0 };
    m.takePossession(c, true);
    m.ball.pos = { x: c.pos.x, y: 0.11, z: 0.4 };
    prep?.(m, dir);
    m.plans[0] = null; m.plans[1] = null;
    m.step();
    return { m, plan: m.plans[0]!, dir };
  }
  it('screens the passing lanes to free opponents in front of the carrier (two on Elite)', () => {
    const { plan } = defendingPlan((m, dir) => {
      const st = m.teamPlayers(1).find((q) => q.role === 'ST')!;
      st.pos = { x: -18 * dir, z: 6 };
      const lw = m.teamPlayers(1).find((q) => q.role === 'LW')!;
      lw.pos = { x: -14 * dir, z: -18 };
      for (const p of m.teamPlayers(0)) if (Math.hypot(p.pos.x - st.pos.x, p.pos.z - st.pos.z) < 4) p.pos.z += 6;
    });
    expect(plan.laneCover.size).toBeGreaterThanOrEqual(1);
  });
  it('a defender goes with an opponent running at the back line', () => {
    const { plan, m } = defendingPlan((m, dir) => {
      const st = m.teamPlayers(1).find((q) => q.role === 'ST')!;
      st.pos = { x: -20 * dir, z: 3 }; st.vel = { x: -7 * dir, z: 0 };
    });
    const st = m.teamPlayers(1).find((q) => q.role === 'ST')!;
    const tracker = [...plan.tightMarks].find((id) => plan.marks.get(id) === st.id);
    expect(tracker).toBeDefined();
  });
});
