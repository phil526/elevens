// Shoulder barge: a standing tackle from alongside the carrier is a shoulder-to-shoulder challenge.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

const none = { type: 'none', t: 0, dur: 0 } as Player['action'];
function setup(seed: number, defZ: number, defX = 0, defFacing = 0) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const c = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  const d = m.teamPlayers(1).find((x) => x.role === 'RCB')!;
  c.pos = { x: 0, z: 0 }; c.vel = { x: 6, z: 0 }; c.facing = 0; c.action = { ...none };
  d.pos = { x: defX, z: defZ }; d.vel = { x: defFacing === 0 ? 6 : -6, z: 0 }; d.facing = defFacing; d.action = { ...none }; d.tackleCooldown = 0;
  m.takePossession(c, true);
  m.ball.pos = { x: 0.45, y: 0.11, z: 0 }; m.ball.vel = { x: 6, y: 0, z: 0 };
  return { m, c, d };
}
function park(m: Match, keep: Player[]) {
  for (const q of m.players) if (!keep.includes(q)) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
}

describe('shoulder barge', () => {
  it('a tackle from alongside, running the same way, is a barge', () => {
    const { m, d } = setup(1, 1.2);
    m.startTackle(d);
    expect(d.action.type).toBe('barge');
  });
  it('a tackle from in front is still a standing tackle', () => {
    const { m, d } = setup(1, 0, 1.5, Math.PI);
    m.startTackle(d);
    expect(d.action.type).toBe('tackle');
  });
  it('wins the ball some of the time, loses it some of the time, rarely fouls', () => {
    let won = 0, held = 0, fouls = 0;
    const N = 60;
    for (let s = 1; s <= N; s++) {
      const { m, c, d } = setup(100 + s, 1.2);
      park(m, [c, d]);
      const f0 = m.stats[1].fouls;
      m.startTackle(d);
      for (let i = 0; i < 30; i++) { park(m, [c, d]); m.step(); }
      if (m.stats[1].fouls > f0) fouls++;
      else if (m.ball.owner === c.id) held++;
      else won++;
    }
    expect(won).toBeGreaterThan(N * 0.15);
    expect(held).toBeGreaterThan(N * 0.15);
    expect(fouls).toBeLessThan(N * 0.15);
  });
  it('a winning barge pushes the carrier off their line', () => {
    let pushed = 0;
    for (let s = 1; s <= 40; s++) {
      const { m, c, d } = setup(300 + s, 1.2);
      park(m, [c, d]);
      m.startTackle(d);
      for (let i = 0; i < 12; i++) { park(m, [c, d]); m.step(); }
      if (c.action.type === 'stumble' && c.vel.z < -1) pushed++;
    }
    expect(pushed).toBeGreaterThan(5);
  });
});
