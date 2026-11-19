// Third set of teammate behaviours for a human's side (19 Nov): sweeper keeper, box tracking, shot
// blocks, set-piece marking, second balls, blindside runs, underlaps, auto-switching, partnerships
// and teammates on the ball. Computer sides never use them.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { planTeams, restartTargets, TEAMMATE_ON } from '../src/shared/ai/team';
import { blindRun, blindTarget, linkLevel, setPieceDefence, shotBlockLunges, underlapInside, unseenRunner, wantUnderlap } from '../src/shared/ai/mates3';
import { decide } from '../src/shared/ai/carrier';
import type { Player, Restart } from '../src/shared/types';

let seq = 1;
const input = (m: Match, mx = 0, mz = 0, sprint = false) => m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [] });

function match(humans: [boolean, boolean] = [true, false], seed = 7) {
  const m = new Match(defaultConfig({ humans, realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  return m;
}
const role = (m: Match, team: number, r: string) => m.teamPlayers(team).find((p) => p.role === r)!;
/** Place a player in team 0's frame (team 0 attacks +x; our goal is at fx -52.5). */
function put(m: Match, p: Player, fx: number, fz: number, vx = 0, vz = 0) {
  const dir = m.attackDir(0);
  p.pos = { x: fx * dir, z: fz * dir }; p.vel = { x: vx * dir, z: vz * dir };
  p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
}
const fr = (m: Match, p: { x: number; z: number }) => ({ x: p.x * m.attackDir(0), z: p.z * m.attackDir(0) });
function give(m: Match, p: Player) {
  const b = m.ball;
  b.owner = p.id; b.state = 'dribble'; b.flight = 'none'; b.receiver = -1; b.lastTouch = p.id; b.lastTouchTeam = p.team;
  b.pos = { x: p.pos.x, y: 0.11, z: p.pos.z }; b.vel = { x: 0, y: 0, z: 0 };
  m.possessionStart = m.time;
}
/** The ball in flight from team `team` at frame position (fx, fz, y) with frame velocity. */
function fly(m: Match, team: number, kicker: Player, fx: number, fz: number, y: number, vx: number, vy: number, vz: number, flight: 'lob' | 'header' | 'clear' | 'shot' | 'pass' | 'through', receiver = -1) {
  const dir = m.attackDir(0), b = m.ball;
  b.owner = -1; b.state = 'flight'; b.flight = flight; b.receiver = receiver; b.lastTouch = kicker.id; b.lastTouchTeam = team; b.kicker = kicker.id; b.kickLock = flight === 'shot' ? 0.3 : 0;
  b.pos = { x: fx * dir, y, z: fz * dir }; b.vel = { x: vx * dir, y: vy, z: vz * dir }; b.spin = 0;
  m.lastKickTime = m.time - 0.5;
}
const replan = (m: Match) => { m.plans = [null, null]; planTeams(m); return m.plans; };
/** Team 0 defending deep, team 1 attacking. */
function defending(m: Match) {
  const spots: Record<string, [number, number]> = { GK: [-51, 0], RB: [-38, 20], LB: [-38, -20], RCB: [-40, 6], LCB: [-40, -6], CDM: [-30, 0], RCM: [-24, 10], LCM: [-24, -10], RW: [-8, 24], LW: [-8, -24], ST: [-2, 0] };
  for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
  const att: Record<string, [number, number]> = { GK: [50, 0], RB: [5, -20], LB: [5, 20], RCB: [10, -6], LCB: [10, 6], CDM: [-10, 0], RCM: [-20, -10], LCM: [-20, 10], RW: [-30, -22], LW: [-30, 22], ST: [-30, 0] };
  for (const o of m.teamPlayers(1)) { const s = att[o.role]; put(m, o, s[0], s[1]); }
}

describe('sweeper keeper', () => {
  function ballInBehind(on: boolean, humans: [boolean, boolean] = [true, false]) {
    const m = match(humans);
    TEAMMATE_ON.sweep = on;
    try {
      const spots: Record<string, [number, number]> = { GK: [-48, 0], RB: [-6, 20], LB: [-6, -20], RCB: [-8, 6], LCB: [-8, -6], CDM: [0, 0], RCM: [6, 10], LCM: [6, -10], RW: [15, 24], LW: [15, -24], ST: [18, 0] };
      for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
      for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 12 + (o.slot % 3) * 4, (o.slot % 5) * 9 - 18);
      const st = role(m, 1, 'ST');
      put(m, st, -6, 2, -4);
      m.ctrl[0].pid = role(m, 0, 'ST').id;
      // A long ball over the high line, rolling into the space in front of our area.
      fly(m, 1, role(m, 1, 'RCB'), -12, 2, 0.2, -14, 0, 0, 'through', st.id);
      const gk = m.keeper(0);
      const x0 = fr(m, gk.pos).x;
      for (let i = 0; i < 60; i++) { input(m); m.step(); m.drainEvents(); }
      return { m, gk, moved: fr(m, gk.pos).x - x0 };
    } finally { TEAMMATE_ON.sweep = true; }
  }
  it('comes off his line for a ball played in behind a high line', () => {
    const { moved } = ballInBehind(true);
    expect(moved).toBeGreaterThan(2.5);
  });
  it('waits on his line without it, and for computer sides', () => {
    expect(ballInBehind(false).moved).toBeLessThan(1);
    expect(ballInBehind(true, [false, false]).moved).toBeLessThan(1);
  });
});

describe('tracking runners into the box', () => {
  it('a defender stays goal-side of a runner arriving in the box while the ball is wide', () => {
    const m = match();
    defending(m);
    const winger = role(m, 1, 'LW');
    put(m, winger, -42, 26);
    give(m, winger);
    const st = role(m, 1, 'ST');
    put(m, st, -30, -4, -6);
    m.ctrl[0].pid = role(m, 0, 'LW').id;
    const plan = replan(m)[0]!;
    const marker = [...plan.boxMarks].find((id) => plan.marks.get(id) === st.id);
    expect(marker).toBeDefined();
    expect(['RCB', 'LCB', 'RB', 'LB', 'CDM']).toContain(m.players[marker!].role);
  });
  it('is not used by computer sides', () => {
    const m = match([false, false]);
    defending(m);
    const winger = role(m, 1, 'LW');
    put(m, winger, -42, 26);
    give(m, winger);
    put(m, role(m, 1, 'ST'), -30, -4, -6);
    expect(replan(m)[0]!.boxMarks.size).toBe(0);
  });
});

describe('shot blocks', () => {
  it('a teammate near the path throws himself in front of the shot and blocks it', () => {
    const m = match();
    defending(m);
    const shooter = role(m, 1, 'ST');
    put(m, shooter, -32, 0);
    const d = role(m, 0, 'RCB');
    put(m, d, -38, 1.4);
    d.a.tackling = 1;
    for (const p of m.teamPlayers(0)) if (p.id !== d.id && p.role !== 'GK') put(m, p, -20, 30);
    m.ctrl[0].pid = role(m, 0, 'ST').id;
    fly(m, 1, shooter, -32.5, 0, 0.3, -24, 1.5, 0, 'shot');
    const chance = m.rng.chance;
    m.rng.chance = () => true;
    shotBlockLunges(m, shooter);
    m.rng.chance = chance;
    expect(d.action.type).toBe('slide');
    expect(d.action.block).toBe(true);
    let blocked = false;
    for (let i = 0; i < 30 && !blocked; i++) { input(m); m.step(); blocked = m.drainEvents().some((e) => e.type === 'block' && e.player === d.id); }
    expect(blocked).toBe(true);
  });
  it('steps onto the shot line when a carrier is in range', () => {
    const m = match();
    defending(m);
    const st = role(m, 1, 'ST');
    put(m, st, -28, 3);
    give(m, st);
    for (const p of m.teamPlayers(0)) if (p.role !== 'GK') put(m, p, -38, 8 + p.slot);
    m.ctrl[0].pid = role(m, 0, 'ST').id;
    put(m, role(m, 0, 'ST'), -10, 0);
    const plan = replan(m)[0]!;
    expect(plan.blocker).toBeGreaterThanOrEqual(0);
  });
});

describe('set pieces against', () => {
  function corner(marking?: 'man' | 'zonal') {
    const m = match();
    if (marking) (m.cfg.tactics ??= [{ formation: '433', width: 0, line: 0, press: 0 }, { formation: '433', width: 0, line: 0, press: 0 }])[0].marking = marking;
    const dir = m.attackDir(1);
    const r: Restart = { type: 'corner', team: 1, spot: { x: dir * 52.5, z: 34 }, taker: role(m, 1, 'RW').id, t: 2, ready: false, readyT: 0, indirect: false, aim: { x: 0, z: 0 } };
    const T = restartTargets(m, r);
    for (const p of m.players) { p.pos = { ...T[p.id] }; }
    const def = setPieceDefence(m, r, restartTargets(m, r))!;
    return { m, r, def, T: restartTargets(m, r) };
  }
  it('mixed: zones at the near post and the edge, the rest man-mark goal-side', () => {
    const { m, def, T } = corner();
    expect(def.zones.size).toBeGreaterThanOrEqual(3);
    expect(def.marks.size).toBeGreaterThanOrEqual(4);
    const goalX = m.ownGoalX(0);
    for (const [d, a] of def.marks) {
      expect(Math.hypot(T[d].x - T[a].x, T[d].z - T[a].z)).toBeLessThan(1.8);
      expect(Math.abs(T[d].x - goalX)).toBeLessThan(Math.abs(T[a].x - goalX)); // goal-side
    }
  });
  it('zonal: nobody follows a man; man-marking: most do', () => {
    expect(corner('zonal').def.marks.size).toBe(0);
    expect(corner('zonal').def.zones.size).toBeGreaterThanOrEqual(7);
    expect(corner('man').def.marks.size).toBeGreaterThanOrEqual(5);
  });
});

describe('second balls', () => {
  it('one attacks the drop and others wait where it falls next', () => {
    const m = match();
    const spots: Record<string, [number, number]> = { GK: [-50, 0], RB: [-15, 22], LB: [-15, -22], RCB: [-18, 7], LCB: [-18, -7], CDM: [-8, 0], RCM: [-2, 10], LCM: [-2, -10], RW: [10, 24], LW: [10, -24], ST: [14, 0] };
    for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 2 + (o.slot % 3) * 5, (o.slot % 5) * 10 - 20);
    m.ctrl[0].pid = role(m, 0, 'ST').id;
    fly(m, 1, role(m, 1, 'RCB'), 4, 2, 2.2, -8, 6, 0, 'header');
    const plan = replan(m)[0]!;
    expect(plan.secondBall.size).toBeGreaterThanOrEqual(2);
  });
});

describe('blindside runs', () => {
  it('the striker drifts onto the far shoulder of a centre-back, unseen, then goes in behind', () => {
    const m = match();
    const spots: Record<string, [number, number]> = { GK: [-45, 0], RB: [0, 22], LB: [0, -22], RCB: [-5, 7], LCB: [-5, -7], CDM: [5, 0], RCM: [12, 10], LCM: [12, -10], RW: [25, 24], LW: [25, -24], ST: [26, 2] };
    for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') put(m, o, 30 + (o.slot % 2) * 2, (o.slot % 5) * 10 - 20);
    const carrier = role(m, 0, 'RCM');
    put(m, carrier, 14, 12, 3);
    carrier.facing = m.attackDir(0) > 0 ? 0 : Math.PI;
    give(m, carrier);
    m.ctrl[0].pid = carrier.id;
    const plan = replan(m)[0]!;
    const st = role(m, 0, 'ST');
    const chance = m.rng.chance;
    m.rng.chance = () => true;
    blindRun(m, plan, m.teamPlayers(0).filter((p) => p.role !== 'GK'), carrier);
    m.rng.chance = chance;
    expect(st.runLane).toBe(7);
    expect(unseenRunner(m, st, 1)).toBe(true);
    const t = blindTarget(m, st, plan)!;
    expect(t).not.toBeNull();
    // Away from the ball (the ball is at +z): the drift spot is on the -z side of the defender's line.
    expect(fr(m, t.T).z).toBeLessThan(fr(m, st.pos).z + 3);
  });
});

describe('underlaps', () => {
  it('goes inside a wide carrier when the outside is blocked', () => {
    const m = match();
    const w = role(m, 0, 'RW');
    put(m, w, 20, 24);
    const o = role(m, 1, 'LB');
    put(m, o, 24, 27);
    expect(wantUnderlap(m, w, { x: 20, z: 24 }, 0.9)).toBe(true);
    put(m, o, 0, 0);
    expect(wantUnderlap(m, w, { x: 20, z: 24 }, 0.9)).toBe(false);
  });
  it('the full-back runs the inside channel past a winger holding the touchline', () => {
    const m = match();
    const spots: Record<string, [number, number]> = { GK: [-45, 0], RB: [-2, 22], LB: [-2, -22], RCB: [-10, 7], LCB: [-10, -7], CDM: [0, 0], RCM: [10, 10], LCM: [10, -10], RW: [12, 27], LW: [12, -27], ST: [20, 0] };
    for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
    const carrier = role(m, 0, 'CDM');
    carrier.facing = m.attackDir(0) > 0 ? 0 : Math.PI;
    give(m, carrier);
    m.ctrl[0].pid = carrier.id;
    const plan = replan(m)[0]!;
    const chance = m.rng.chance;
    m.rng.chance = () => true;
    const fb = underlapInside(m, plan, m.teamPlayers(0).filter((p) => p.role !== 'GK'), carrier)!;
    m.rng.chance = chance;
    expect(fb).not.toBeNull();
    expect(fb.runLane).toBe(6);
    const to = fr(m, fb.runTo!);
    expect(Math.abs(to.z)).toBeLessThan(18);
    expect(Math.abs(to.z)).toBeGreaterThan(11);
  });
});

describe('auto-switching', () => {
  it('switches to the defender who will meet the receiver of their pass, as it is played', () => {
    const m = match();
    defending(m);
    const recv = role(m, 1, 'LW');
    put(m, recv, -30, 22);
    const rb = role(m, 0, 'LB');
    const h = role(m, 0, 'ST');
    m.ctrl[0].pid = h.id;
    put(m, h, -8, -10);
    fly(m, 1, role(m, 1, 'LCM'), -20, 10, 0.2, -6, 0, 9, 'pass', recv.id);
    m.lastKickTime = m.time;
    m.ctrl[0].lastAutoSwitch = -10;
    for (let i = 0; i < 6; i++) { input(m); m.step(); m.drainEvents(); }
    const now = m.players[m.ctrl[0].pid];
    expect(now.id).not.toBe(h.id);
    expect(Math.hypot(now.pos.x - recv.pos.x, now.pos.z - recv.pos.z)).toBeLessThan(Math.hypot(rb.pos.x - recv.pos.x, rb.pos.z - recv.pos.z) + 6);
  });
  it('does not switch away while the human is in the duel', () => {
    const m = match();
    defending(m);
    const carrier = role(m, 1, 'ST');
    put(m, carrier, -28, 0, -3);
    give(m, carrier);
    const h = role(m, 0, 'CDM');
    put(m, h, -31, 0);
    m.ctrl[0].pid = h.id;
    m.ctrl[0].lastAutoSwitch = -10;
    let pid = h.id;
    for (let i = 0; i < 30; i++) {
      const dir = m.attackDir(0);
      input(m, Math.sign(carrier.pos.x - h.pos.x) || 1, 0);
      m.step(); m.drainEvents();
      if (m.ball.owner !== carrier.id) break;
      pid = m.ctrl[0].pid;
    }
    expect(pid).toBe(h.id);
  });
});

describe('partnerships', () => {
  it('completed passes between a pair build an understanding and say so', () => {
    const m = match();
    const a = role(m, 0, 'RCM'), b = role(m, 0, 'ST');
    expect(linkLevel(m, a.id, b.id)).toBe(0);
    for (let i = 0; i < 3; i++) m.addLink(0, a.id, b.id, 1);
    expect(m.drainEvents().some((e) => e.text === 'link:1')).toBe(false);
    m.addLink(0, b.id, a.id, 1);
    expect(m.drainEvents().some((e) => e.type === 'call' && e.text === 'link:1' && e.player === b.id && e.power === a.id)).toBe(true);
    expect(linkLevel(m, a.id, b.id)).toBeCloseTo(0.4);
    for (let i = 0; i < 10; i++) m.addLink(0, a.id, b.id, 1);
    expect(linkLevel(m, a.id, b.id)).toBe(1);
  });
  it('computer sides build none', () => {
    const m = match([false, false]);
    const a = role(m, 0, 'RCM'), b = role(m, 0, 'ST');
    m.addLink(0, a.id, b.id, 20);
    expect(linkLevel(m, a.id, b.id)).toBe(0);
  });
});

describe('teammates on the ball', () => {
  it("a human's keeper on the ball with an opponent closing clears or passes instead of dribbling", () => {
    const m = match();
    defending(m);
    const gk = m.keeper(0);
    put(m, gk, -40, 4);
    give(m, gk);
    put(m, role(m, 1, 'ST'), -36, 4, -5);
    m.ctrl[0].pid = role(m, 0, 'ST').id;
    m.possessionStart = m.time - 2;
    let dribbles = 0;
    for (let i = 0; i < 20; i++) if (decide(m, gk).label === 'dribble') dribbles++;
    expect(dribbles).toBeLessThan(3);
  });
});

describe('computer sides are untouched', () => {
  it('no new jobs in an AI v AI plan', () => {
    const m = match([false, false]);
    for (let i = 0; i < 1200; i++) {
      m.step();
      m.drainEvents();
      if (i % 30 === 0) for (const p of m.plans) {
        if (!p) continue;
        expect(p.boxMarks.size + p.secondBall.size + p.zones.size).toBe(0);
        expect(p.blocker).toBe(-1);
      }
    }
    expect(m.players.some((p) => p.runLane === 7)).toBe(false);
  });
});
