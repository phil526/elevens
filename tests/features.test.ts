// Set pieces, cards and advantage, slide tackles, skill moves, bursts, directed switching and contain.
import { describe, expect, it } from 'vitest';
import { MATCH, PITCH, PLAYER } from '../src/shared/config';
import { predictGoalLine } from '../src/shared/ball';
import { Match, defaultConfig } from '../src/shared/match';
import { parseClientMsg } from '../src/shared/protocol';
import { encodeSnapshot } from '../src/shared/snapshot';
import type { InputEvent, MatchEvent, Player, RestartType, TeamIndex } from '../src/shared/types';
import { aiMatch, clearArea, toOpenPlay } from './helpers';

type Internals = {
  award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void;
  foul(a: Player, b: Player, how?: { slide?: boolean; fromBehind?: boolean }): void;
  giveCard(p: Player, card: 0 | 1 | 2): void;
  startKickoff(team: TeamIndex): void;
};
const I = (m: Match) => m as unknown as Internals;
const stepN = (m: Match, n: number) => { for (let i = 0; i < n; i++) m.step(); };
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = [], extra: { contain?: boolean; sprint?: boolean } = {}) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: !!extra.sprint, jockey: false, contain: !!extra.contain, ev });
const humanMatch = (seed = 5) => new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
const events = (m: Match): MatchEvent[] => m.drainEvents();
const giveBall = (m: Match, p: Player) => { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.4, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.4 }; };

function readyRestart(m: Match, type: RestartType, team: TeamIndex, spot: { x: number; z: number }) {
  I(m).award(type, team, spot);
  for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
  expect(m.restart!.ready).toBe(true);
  return m.restart!;
}

describe('aimed set pieces', () => {
  it('the stick moves the target, and a lofted free kick lands near it', () => {
    const m = humanMatch();
    const dir = m.attackDir(0);
    const r = readyRestart(m, 'freekick', 0, { x: -dir * 10, z: 0 });
    expect(m.ctrl[0].pid).toBe(r.taker);
    const z0 = r.aim.z;
    for (let i = 0; i < 30; i++) { input(m, 0, 0, 1); m.step(); }
    expect(r.aim.z - z0).toBeGreaterThan(MATCH.aimSpeed * 0.4);
    // Put the target 30 m ahead and wide, then lob it there.
    r.aim = { x: -dir * 10 + dir * 30, z: 14 };
    input(m, 0, 0, 0, [{ k: 'lob' }]);
    let landed: { x: number; z: number } | null = null, peak = 0;
    for (let i = 0; i < 300 && !landed; i++) {
      m.step();
      input(m, 0);
      const b = m.ball;
      peak = Math.max(peak, b.pos.y);
      if (peak > 3 && b.pos.y < 0.3) landed = { x: b.pos.x, z: b.pos.z };
    }
    expect(landed).not.toBeNull();
    expect(Math.hypot(landed!.x - r.aim.x, landed!.z - r.aim.z)).toBeLessThan(4);
  });

  it('a powered direct free kick rises over the wall', () => {
    const m = humanMatch(8);
    const dir = m.attackDir(0);
    const spot = { x: dir * (PITCH.halfLength - 22), z: 3 };
    const r = readyRestart(m, 'freekick', 0, spot);
    r.aim = { x: dir * PITCH.halfLength, z: -2.6 };
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.75 }]);
    let wallY = -1;
    for (let i = 0; i < 120 && wallY < 0; i++) {
      m.step();
      input(m, 0);
      if (m.ball.state === 'flight' && Math.hypot(m.ball.pos.x - spot.x, m.ball.pos.z - spot.z) > MATCH.freeKickDistance + 0.4) wallY = m.ball.pos.y;
    }
    // Over a standing wall (a jumping one, timed right, can still get a head to it).
    expect(wallY).toBeGreaterThan(PLAYER.wallTop + 0.15);
  });

  it('a penalty goes to the side of the goal the target was moved to', () => {
    const m = humanMatch(12);
    const dir = m.attackDir(0);
    const r = readyRestart(m, 'penalty', 0, { x: dir * (PITCH.halfLength - PITCH.penaltySpot), z: 0 });
    expect(r.aim.x).toBeCloseTo(dir * PITCH.halfLength, 5);
    for (let i = 0; i < 90; i++) { input(m, 0, 0, 1); m.step(); }
    expect(r.aim.z).toBeGreaterThan(PITCH.goalHalfWidth - 0.5);
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.55 }]);
    // (The taker runs in from a few strides back first.)
    for (let i = 0; i < 150 && m.ball.state !== 'flight'; i++) { m.step(); input(m, 0); }
    const cross = predictGoalLine(m.ball, dir, 3);
    expect(cross).not.toBeNull();
    expect(cross!.z).toBeGreaterThan(0.8);
  });
});

describe('cards and advantage', () => {
  it('a second yellow sends the player off; the team plays on with ten', () => {
    const m = aiMatch({ seed: 21 });
    toOpenPlay(m);
    const cb = m.teamPlayers(1).find((p) => p.role === 'RCB')!;
    I(m).giveCard(cb, 1);
    expect(cb.cards).toBe(1);
    expect(cb.off).toBe(false);
    I(m).giveCard(cb, 1);
    expect(cb.off).toBe(true);
    expect(m.stats[1].yellows).toBe(2);
    expect(m.stats[1].reds).toBe(1);
    expect(m.teamPlayers(1)).toHaveLength(10);
    const parked = { ...cb.pos };
    for (let i = 0; i < 60 * 40; i++) {
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      expect(m.ball.owner).not.toBe(cb.id);
    }
    expect(cb.pos).toEqual(parked);
    // The sent-off player shows in snapshots as off.
    const s = encodeSnapshot(m, 0, [], false);
    expect(s.p[cb.id * 11 + 10] & 8).toBe(8);
  });

  it('kick-off still works when the striker has been sent off', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const st = m.teamPlayers(1).find((p) => p.role === 'ST')!;
    I(m).giveCard(st, 2);
    I(m).startKickoff(1);
    const taker = m.players[m.restart!.taker];
    expect(taker.off).toBe(false);
    expect(taker.team).toBe(1);
    stepN(m, 120);
    expect(m.phase).toBe('play');
  });

  it('a foul that denies an obvious goal-scoring chance is a straight red', () => {
    const m = aiMatch({ seed: 4 });
    toOpenPlay(m);
    const dir = m.attackDir(0);
    const st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    st.pos = { x: dir * 33, z: 2 };
    st.facing = dir > 0 ? 0 : Math.PI;
    giveBall(m, st);
    // Every outfield defender is behind the attacker.
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: dir * 20, z: o.pos.z * 0.3 };
    const cb = m.teamPlayers(1).find((p) => p.role === 'LCB')!;
    events(m);
    I(m).foul(cb, st);
    expect(cb.off).toBe(true);
    expect(events(m).some((e) => e.type === 'card' && e.text === 'red')).toBe(true);
    expect(m.restart?.type).toBe('freekick');
  });

  it('advantage: play goes on, and the free kick comes back if the ball is lost', () => {
    const m = aiMatch({ seed: 6 });
    toOpenPlay(m);
    const dir = m.attackDir(0);
    const lw = m.teamPlayers(0).find((p) => p.role === 'LW')!;
    lw.pos = { x: dir * 25, z: -12 };
    giveBall(m, lw);
    const def = m.teamPlayers(1).find((p) => p.role === 'RB')!;
    const chance = m.rng.chance.bind(m.rng);
    m.rng.chance = () => true; // the winger stays on their feet
    I(m).foul(def, lw, {});
    m.rng.chance = chance;
    expect(m.phase).toBe('play');
    expect(m.advantage).not.toBeNull();
    const spot = { ...m.advantage!.spot };
    // The opponents win the ball inside the advantage period: free kick at the original spot.
    const cdm = m.teamPlayers(1).find((p) => p.role === 'CDM')!;
    cdm.pos = { x: lw.pos.x + 1, z: lw.pos.z };
    giveBall(m, cdm);
    m.step();
    expect(m.advantage).toBeNull();
    expect(m.restart).toMatchObject({ type: 'freekick', team: 0 });
    expect(m.restart!.spot).toEqual(spot);
  });

  it('advantage that runs its course ends without a stoppage', () => {
    const m = aiMatch({ seed: 6 });
    toOpenPlay(m);
    m.advantage = { team: 0, spot: { x: 10, z: 0 }, until: m.time - 0.01, offender: m.teamPlayers(1)[3].id, card: 1 };
    m.step();
    expect(m.advantage).toBeNull();
    // The booking waits for the next stoppage, as a referee would.
    const off = m.players[m.teamPlayers(1)[3].id];
    expect(off.cards).toBe(0);
    expect(m.pendingBookings.length).toBe(1);
    expect(m.phase).toBe('play');
  });
});

describe('slide tackles', () => {
  function setup(fromBehind: boolean) {
    const m = aiMatch({ seed: 15 });
    toOpenPlay(m);
    clearArea(m, -20, 0, 15);
    const carrier = m.teamPlayers(0).find((p) => p.role === 'RCM')!;
    const def = m.teamPlayers(1).find((p) => p.role === 'CDM')!;
    carrier.pos = { x: -20, z: 0 };
    carrier.facing = 0; // facing +x
    carrier.action = { type: 'none', t: 0, dur: 0 };
    carrier.aiNextDecision = m.time + 10; // stands still with the ball
    carrier.aiTarget = { ...carrier.pos };
    giveBall(m, carrier);
    if (fromBehind) { def.pos = { x: -22.6, z: 0 }; def.facing = 0; }
    else { def.pos = { x: -17.2, z: 0 }; def.facing = Math.PI; }
    def.vel = { x: 0, z: 0 };
    def.tackleCooldown = 0;
    def.action = { type: 'none', t: 0, dur: 0 };
    events(m);
    m.startSlide(def);
    return { m, carrier, def };
  }
  it('a slide from the front reaches the ball from a couple of metres and knocks it away', () => {
    const { m, carrier, def } = setup(false);
    expect(def.action.type).toBe('slide');
    const evs: MatchEvent[] = [];
    for (let i = 0; i < 40; i++) { m.step(); evs.push(...events(m)); }
    expect(evs.some((e) => e.type === 'tackle' && e.player === def.id)).toBe(true);
    expect(evs.some((e) => e.type === 'foul')).toBe(false);
    expect(m.ball.owner).not.toBe(carrier.id);
  });
  it('a slide from behind that takes the player is a foul', () => {
    const { m, def } = setup(true);
    const evs: MatchEvent[] = [];
    for (let i = 0; i < 40; i++) { m.step(); evs.push(...events(m)); }
    expect(evs.some((e) => e.type === 'foul' && e.player === def.id)).toBe(true);
    expect(m.stats[1].fouls).toBe(1);
  });
});

describe('skill moves and sprint burst', () => {
  function carrier(seed = 31) {
    const m = aiMatch({ seed });
    toOpenPlay(m);
    clearArea(m, 0, 0, 12);
    const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
    p.pos = { x: 0, z: 0 };
    p.vel = { x: 0, z: 0 };
    p.facing = 0;
    p.skillCd = 0;
    p.action = { type: 'none', t: 0, dur: 0 };
    p.aiNextDecision = m.time + 10;
    p.aiTarget = { x: 0, z: 0 };
    giveBall(m, p);
    return { m, p };
  }
  it('forward: a knock-on pushes the ball well ahead and the player bursts after it', () => {
    const { m, p } = carrier();
    expect(m.startSkill(p, 1, 0)).toBe('knockon');
    expect(m.ball.owner).toBe(-1);
    expect(m.ball.vel.x).toBeGreaterThan(6);
    expect(p.burst).toBeGreaterThan(0);
  });
  it('back: a drag-back turns the player round with the ball', () => {
    const { m, p } = carrier();
    expect(m.startSkill(p, -1, 0)).toBe('dragback');
    stepN(m, 22);
    expect(Math.abs(Math.cos(p.facing) + 1)).toBeLessThan(0.15);
    expect(m.ball.owner).toBe(p.id);
  });
  it('sideways: a step-over can wrong-foot a defender squared up in front', () => {
    const { m, p } = carrier();
    const d = m.teamPlayers(1).find((q) => q.role === 'LCB')!;
    d.pos = { x: 2.2, z: 0 };
    d.action = { type: 'none', t: 0, dur: 0 };
    const chance = m.rng.chance.bind(m.rng);
    m.rng.chance = () => true;
    expect(m.startSkill(p, 0, 1)).toBe('stepover');
    stepN(m, 16);
    m.rng.chance = chance;
    expect(d.beaten).toBeGreaterThan(0);
  });
  it('a skill move needs the ball and has a cooldown', () => {
    const { m, p } = carrier();
    expect(m.startSkill(p, 0, 1)).toBe('stepover');
    p.action = { type: 'none', t: 0, dur: 0 };
    expect(m.startSkill(p, 0, 1)).toBeNull();
    const other = m.teamPlayers(0).find((q) => q.role === 'LW')!;
    expect(m.startSkill(other, 1, 0)).toBeNull();
  });
  it('pressing sprint from a standstill gives a burst that costs stamina', () => {
    const m = humanMatch(3);
    toOpenPlay(m);
    const p = m.players[m.ctrl[0].pid];
    p.vel = { x: 0, z: 0 };
    p.burst = 0;
    const st = p.stamina;
    input(m, 0, 1, 0, [], { sprint: true });
    m.step();
    expect(p.burst).toBeGreaterThan(0);
    expect(p.stamina).toBeLessThan(st - PLAYER.burstCost * 0.9);
  });
});

describe('switching and contain', () => {
  it('a flick switches to the teammate in that direction; a click picks the nearest to a point', () => {
    const m = humanMatch(9);
    toOpenPlay(m);
    const team = m.teamPlayers(0).filter((p) => p.role !== 'GK');
    const cur = team[0];
    m.ctrl[0].pid = cur.id;
    if (m.ball.owner === cur.id) { m.ball.owner = -1; m.ball.state = 'free'; }
    cur.pos = { x: 0, z: 0 };
    const north = team[1], east = team[2];
    north.pos = { x: 1, z: -15 };
    east.pos = { x: 18, z: 2 };
    for (const p of team.slice(3)) p.pos = { x: -30, z: 30 };
    m.switchTowards(0, 0, -1, false);
    expect(m.ctrl[0].pid).toBe(north.id);
    m.switchTowards(0, 17, 3, true);
    expect(m.ctrl[0].pid).toBe(east.id);
  });
  it('holding contain sends the nearest teammate to press the ball carrier', () => {
    const m = humanMatch(10);
    toOpenPlay(m);
    const carrier = m.teamPlayers(1).find((p) => p.role === 'RCM')!;
    carrier.pos = { x: 0, z: 0 };
    carrier.action = { type: 'none', t: 0, dur: 0 };
    carrier.aiNextDecision = m.time + 10;
    carrier.aiTarget = { x: 0, z: 0 };
    giveBall(m, carrier);
    const me = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    m.ctrl[0].pid = me.id;
    m.ctrl[0].autoSwitch = false; // keep control of the striker, far from the ball
    me.pos = { x: 25, z: 25 };
    input(m, 0, 0, 0, [], { contain: true });
    m.step();
    const helper = m.contain[0];
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(helper).not.toBe(me.id);
    const h = m.players[helper];
    const d0 = Math.hypot(h.pos.x - carrier.pos.x, h.pos.z - carrier.pos.z);
    for (let i = 0; i < 75 && m.ball.owner === carrier.id; i++) { input(m, 0, 0, 0, [], { contain: true }); m.step(); }
    expect(m.contain[0]).toBe(helper);
    const d1 = Math.hypot(h.pos.x - carrier.pos.x, h.pos.z - carrier.pos.z);
    expect(d1).toBeLessThan(Math.max(1.6, d0 - 1));
    input(m, 0, 0, 0, [], { contain: false });
    m.step();
    expect(m.contain[0]).toBe(-1);
  });
});

describe('protocol for the new inputs', () => {
  it('accepts skill events, directions, click points and contain; rejects out-of-range points', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, contain: true, ev: [{ k: 'skill', x: 0.5, z: -0.5 }, { k: 'switch', x: 20, z: -5, at: true }] }] }));
    expect(ok).not.toBeNull();
    const f = (ok as { f: { contain: boolean; ev: InputEvent[] }[] }).f[0];
    expect(f.contain).toBe(true);
    expect(f.ev[0]).toMatchObject({ k: 'skill', x: 0.5, z: -0.5, at: false });
    expect(f.ev[1]).toMatchObject({ k: 'switch', x: 20, z: -5, at: true });
    expect(parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'switch', x: 500, z: 0 }] }] }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'switch', x: 1 }] }] }))).toBeNull();
  });
  it('snapshots carry the set-piece target', () => {
    const m = humanMatch();
    const r = readyRestart(m, 'corner', 0, { x: m.attackDir(0) * (PITCH.halfLength - 0.4), z: PITCH.halfWidth - 0.4 });
    const s = encodeSnapshot(m, 0, [], false);
    expect((s.r as number[])[7]).toBeCloseTo(r.aim.x, 1);
    expect((s.r as number[])[8]).toBeCloseTo(r.aim.z, 1);
  });
});
