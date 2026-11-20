// 20 Nov 2026: the receiver of a human's pass attacks the ball even while the stick is still
// pushed the way the pass went; a fresh stick direction still steers him. Pass and move.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { encodeSnapshot } from '../src/shared/snapshot';
import type { Player } from '../src/shared/types';

let seq = 1;
function setup(seed = 9) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = true;
  p.pos = { x: -10, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  m.takePossession(p, true); m.ball.pos = { x: -9.55, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: 45, z: o.pos.z };
  const t = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  t.pos = { x: 10, z: -6 }; t.vel = { x: 0, z: 0 };
  return { m, p, t };
}
const input = (m: Match, mx: number, mz: number, ev: { k: 'pass'; p: number }[] = [], sprint = false) =>
  m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev });

/** Pass towards the striker holding the stick that way, then keep holding `after(i)` while it travels. */
function play(after: (i: number) => [number, number], sprint = false, seed = 9) {
  const { m, p, t } = setup(seed);
  const L = Math.hypot(20, -6), mx = 20 / L, mz = -6 / L;
  input(m, mx, mz, [{ k: 'pass', p: 0.5 }], sprint);
  let flightAt = -1, gotAt = -1, minX = t.pos.x;
  for (let i = 0; i < 200 && gotAt < 0; i++) {
    const [ax, az] = flightAt < 0 ? [mx, mz] : after(i - flightAt);
    input(m, ax, az, [], sprint);
    m.step();
    if (flightAt < 0 && m.ball.state === 'flight') flightAt = i;
    if (m.ball.state === 'flight') minX = Math.min(minX, t.pos.x);
    if (m.ball.owner === t.id) gotAt = i;
  }
  return { m, p, t, gotAt, flightAt, minX };
}

describe('run to the pass', () => {
  it('control moves to the receiver and the held stick is carried over', () => {
    const { m, t } = play(() => [20 / Math.hypot(20, 6), -6 / Math.hypot(20, 6)]);
    expect(m.ctrl[0].pid).toBe(t.id);
  });
  it('with the stick still pushed the way of the pass, the receiver comes towards the ball', () => {
    const L = Math.hypot(20, 6);
    const held = play(() => [20 / L, -6 / L]);
    const let_go = play(() => [0, 0]);
    expect(held.minX).toBeLessThan(9); // stepped towards the passer (started at x 10)
    expect(held.gotAt).toBeGreaterThan(0);
    expect(held.gotAt).toBeLessThanOrEqual(let_go.gotAt + 3);
  });
  it('a pass into space (sprint + pass) is run onto, not run away from', () => {
    const L = Math.hypot(20, 6);
    const r = play(() => [20 / L, -6 / L], true);
    expect(r.gotAt).toBeGreaterThan(0);
    expect(r.gotAt).toBeLessThan(130);
  });
  it('pushing the stick a new way still steers the receiver', () => {
    const r = play(() => [0, 1]);
    // Straight across the pitch (+z), not on to the ball's line.
    expect(r.t.pos.z).toBeGreaterThan(-4);
  });
  it('the snapshot carries the receiver so online prediction can follow the server', () => {
    const { m, t } = setup();
    input(m, 1, 0, [{ k: 'pass', p: 0.5 }]);
    for (let i = 0; i < 30 && m.ball.state !== 'flight'; i++) { input(m, 1, 0); m.step(); }
    expect(m.ball.state).toBe('flight');
    const s = encodeSnapshot(m, 0, [], false);
    expect(s.b[10]).toBe(m.ball.receiver);
    expect(m.ball.receiver).toBe(t.id);
  });
});

describe('pass and move', () => {
  it('after a forward pass the human\'s passer often runs on for the next ball', () => {
    let ran = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { m, p } = setup(seed);
      input(m, 1, -0.3, [{ k: 'pass', p: 0.5 }]);
      for (let i = 0; i < 30 && m.ball.state !== 'flight'; i++) { input(m, 1, -0.3); m.step(); }
      if (p.giveGoUntil > m.time) ran++;
    }
    expect(ran).toBeGreaterThanOrEqual(3);
    expect(ran).toBeLessThan(12);
  });
  it('not after a back pass', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { m, p } = setup(seed);
      const back = m.teamPlayers(0).find((x) => x.role === 'RCB')!;
      back.pos = { x: -24, z: 4 }; back.vel = { x: 0, z: 0 };
      input(m, -1, 0.25, [{ k: 'pass', p: 0.5 }]);
      for (let i = 0; i < 30 && m.ball.state !== 'flight'; i++) { input(m, -1, 0.25); m.step(); }
      expect(m.ball.receiver).toBe(back.id);
      expect(p.giveGoUntil).toBeLessThanOrEqual(m.time);
    }
  });
});
