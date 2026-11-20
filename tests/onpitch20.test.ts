// 20 Nov 2026 evening: solid bodies, timed tackles and the computer learning your habits.
import { afterEach, describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { BODY, separateBodies, tackleTiming, TIMING } from '../src/shared/contact';
import { bookAgainst, expectedCorner, habitBias, habitKick, laneShift, newHabitBook, showSide, stepHabits } from '../src/shared/ai/habits';
import { P20 } from '../src/shared/switches';
import { PLAYER } from '../src/shared/config';
import type { Player } from '../src/shared/types';

afterEach(() => { P20.bodies = true; P20.timing = true; P20.habits = true; });

function inPlay(humans: [boolean, boolean] = [true, false], seed = 5) {
  const m = new Match(defaultConfig({ humans, realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  return m;
}
const still = (p: Player, x: number, z: number) => { p.pos = { x, z }; p.vel = { x: 0, z: 0 }; p.action = { type: 'none', t: 0, dur: 0 } as Player['action']; };

describe('solid bodies', () => {
  it('a runner does not shove a planted centre-back aside, and loses the speed he carries into him', () => {
    const m = inPlay([false, false]);
    const w = m.teamPlayers(0).find((p) => p.role === 'LW')!;
    const cb = m.teamPlayers(1).find((p) => p.role === 'RCB')!;
    still(cb, 0, 0);
    w.pos = { x: -0.7, z: 0 }; w.vel = { x: 8, z: 0 };
    separateBodies([w, cb], PLAYER.radius);
    expect(cb.pos.x).toBeLessThan(0.02); // the planted man barely moves
    expect(w.vel.x).toBeLessThan(4); // the runner loses more than half the speed he carries into him
  });
  it('the old soft push let the runner move the defender half the overlap', () => {
    const m = inPlay([false, false]);
    const w = m.teamPlayers(0).find((p) => p.role === 'LW')!;
    const cb = m.teamPlayers(1).find((p) => p.role === 'RCB')!;
    // Same overlap through Match.moveAll with bodies off: equal shares.
    P20.bodies = false;
    for (const p of m.players) still(p, p.pos.x + 200, p.pos.z); // everyone else far away (off the pitch is fine here)
    still(cb, 0, 0); still(w, -0.5, 0);
    for (const p of [w, cb]) p.wish = { x: 0, z: 0, mode: 'walk', face: null };
    (m as unknown as { moveAll(dt: number): void }).moveAll(0);
    expect(cb.pos.x).toBeGreaterThan(0.08);
  });
  it('teammates mostly slide past each other', () => {
    const m = inPlay([false, false]);
    const [a, b] = m.teamPlayers(0).filter((p) => p.role !== 'GK');
    still(a, 0, 0); still(b, 0.6, 0.1);
    a.vel = { x: 6, z: 0 };
    separateBodies([a, b], PLAYER.radius);
    expect(a.vel.x).toBeGreaterThan(6 - 6 * BODY.mate - 0.01);
  });
  it('a hard bump involving your player is announced (rumble/thud)', () => {
    const m = inPlay();
    const me = m.players[m.ctrl[0].pid];
    const o = m.teamPlayers(1).find((p) => p.role !== 'GK')!;
    for (const p of m.players) if (p !== me && p !== o) still(p, p.pos.x, p.pos.z);
    still(o, 20, 20); me.pos = { x: 19.4, z: 20 }; me.vel = { x: 7, z: 0 };
    m.ball.pos = { x: -40, y: 0.11, z: -30 };
    m.drainEvents();
    (m as unknown as { moveAll(dt: number): void }).moveAll(0);
    expect(m.drainEvents().some((e) => e.type === 'call' && e.text === 'bump')).toBe(true);
  });
});

describe('timed tackles', () => {
  function duel(gap: number, touchSoon = false) {
    const m = inPlay([false, false], 7);
    const c = m.teamPlayers(0).find((p) => p.role === 'RW')!;
    const t = m.teamPlayers(1).find((p) => p.role === 'LB')!;
    still(c, 10, 10); c.vel = { x: 5, z: 0 }; c.facing = 0; c.touchCooldown = touchSoon ? 0 : 0.2;
    still(t, 11.5 + gap * 0.5, 10); t.facing = Math.PI;
    return { m, c, t, ball: { x: 10 + TIMING.foot + gap, y: 0.11, z: 10 } };
  }
  it('the ball off the dribbler\'s boot (and nearer you) is well timed; under his foot is not', () => {
    const good = duel(0.9), bad = duel(0.1), soon = duel(0.9, true);
    expect(tackleTiming(good.t, good.c, good.ball)).toBeGreaterThan(TIMING.perfect);
    expect(tackleTiming(bad.t, bad.c, bad.ball)).toBeLessThan(TIMING.early);
    expect(tackleTiming(soon.t, soon.c, soon.ball)).toBeLessThan(tackleTiming(good.t, good.c, good.ball));
  });
  it('a carrier standing on the ball gives neutral timing', () => {
    const d = duel(0.1);
    d.c.vel = { x: 0, z: 0 };
    expect(tackleTiming(d.t, d.c, d.ball)).toBe(TIMING.standingTiming);
  });
  it('well-timed tackles win the ball far more often than mistimed ones', () => {
    const wins = (gap: number) => {
      let n = 0;
      for (let s = 0; s < 40; s++) {
        const m = inPlay([false, false], 100 + s);
        const c = m.teamPlayers(0).find((p) => p.role === 'RW')!;
        const t = m.teamPlayers(1).find((p) => p.role === 'LB')!;
        for (const p of m.players) if (p !== c && p !== t) still(p, p.pos.x, p.pos.z + (p.pos.z > 0 ? 40 : -40));
        still(c, 10, 10); c.vel = { x: 5, z: 0 }; c.facing = 0; c.touchCooldown = 0.2;
        m.takePossession(c, true);
        m.ball.state = 'dribble'; m.ball.owner = c.id;
        m.ball.pos = { x: 10 + TIMING.foot + gap, y: 0.11, z: 10 }; m.ball.vel = { x: 5, y: 0, z: 0 };
        still(t, 10 + TIMING.foot + gap + 0.8, 10); t.facing = Math.PI;
        t.action = { type: 'tackle', t: 0, dur: PLAYER.tackleDuration } as Player['action'];
        (m as unknown as { resolveTackle(p: Player): void }).resolveTackle(t);
        if (t.action.missed === false && m.ball.owner !== c.id) n++;
      }
      return n;
    };
    expect(wins(0.9)).toBeGreaterThan(wins(0.05) + 15);
  });
});

describe('the computer learns your habits', () => {
  it('records near-post shots, then the keeper expects them and reads them better', () => {
    const m = inPlay();
    const me = m.players[m.ctrl[0].pid];
    const dir = m.attackDir(0);
    me.pos = { x: dir * 38, z: 12 };
    for (let i = 0; i < 6; i++) habitKick(m, me, 'shot', 2.5); // same side as the shooter: near post
    const book = m.habits[0]!;
    expect(habitBias(book, 'corner')).toBeGreaterThan(0.5);
    const ec = expectedCorner(m, 1, me.pos);
    expect(ec.side).toBe(1);
    expect(ec.k).toBeGreaterThan(0.3);
  });
  it('mixing it up wins it back: only recent examples count', () => {
    const m = inPlay();
    const me = m.players[m.ctrl[0].pid];
    me.pos = { x: m.attackDir(0) * 38, z: 12 };
    for (let i = 0; i < 6; i++) habitKick(m, me, 'shot', 2.5);
    for (let i = 0; i < 6; i++) habitKick(m, me, 'shot', -2.5);
    expect(habitBias(m.habits[0]!, 'corner')).toBeLessThan(0);
  });
  it('announces a habit it has spotted, once', () => {
    const m = inPlay();
    const me = m.players[m.ctrl[0].pid];
    me.pos = { x: m.attackDir(0) * 38, z: 12 };
    for (let i = 0; i < 6; i++) habitKick(m, me, 'shot', 2.5);
    m.drainEvents();
    stepHabits(m); stepHabits(m);
    const calls = m.drainEvents().filter((e) => e.type === 'call' && (e.text ?? '').startsWith('habit-corner'));
    expect(calls.length).toBe(1);
    expect(calls[0].team).toBe(0);
  });
  it('the block slides to your favourite side and the man on the ball shows you the other way', () => {
    const m = inPlay();
    const book = (m.habits[0] = newHabitBook());
    book.lane = [6, 0]; book.n.lane = 6; // every attack down the attacking side's left
    book.cut = [6, 0]; book.n.cut = 6; // always cuts inside
    const dir = m.attackDir(0);
    // Their left (frame z < 0) is world z of sign -dir.
    expect(Math.sign(laneShift(m, 1))).toBe(-dir);
    const w = m.players[m.ctrl[0].pid];
    w.pos = { x: dir * 25, z: 20 };
    expect(showSide(m, 1, w)).toBeLessThan(0); // stands on the inside (towards z = 0)
  });
  it('only against a human side: computer v computer is untouched', () => {
    const m = inPlay([false, false]);
    expect(bookAgainst(m, 1)).toBeNull();
    stepHabits(m);
    expect(m.habits[0]).toBeNull();
    const off = inPlay();
    off.cfg.habits = false;
    expect(bookAgainst(off, 1)).toBeNull();
  });
});
