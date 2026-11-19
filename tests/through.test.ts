// A person's through ball to a running teammate (19 Nov 2026): the stick picks the runner it points
// at, the ball goes where he and it meet in his stride, slower than he runs, and he takes it on the run.
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { selectReceiver, throughPlan } from '../src/shared/kick';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

function freshMatch(seed = 4) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  return m;
}
function park(m: Match, keep: Player[]) {
  for (const q of m.players) if (!keep.includes(q)) { q.pos = { x: q.team ? 50 : -50, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
}

describe('through ball receiver choice', () => {
  it('the stick at a runner picks him, even on a tap that would pick the near teammate', () => {
    const m = freshMatch();
    const dir = m.attackDir(0);
    const [p, near, runner] = m.teamPlayers(0).filter((x) => x.role !== 'GK');
    park(m, [p, near, runner]);
    p.pos = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI;
    near.pos = { x: 10 * dir, z: 3 }; near.vel = { x: 0, z: 0 };
    runner.pos = { x: 18 * dir, z: 10 }; runner.vel = { x: 8 * dir, z: 0 };
    const sx = 18 * dir, sz = 10;
    expect(selectReceiver(m.players, p, sx, sz, 'through', dir, { power: 0.05 }).receiver).toBe(near.id);
    expect(selectReceiver(m.players, p, sx, sz, 'through', dir, { power: 0.05, runner: true }).receiver).toBe(runner.id);
  });
});

describe('through ball into the stride', () => {
  it('meets the runner on his line, ahead of him, rolling slower than he runs, inside the pitch', () => {
    const m = freshMatch();
    const dir = m.attackDir(0);
    const [p, runner] = m.teamPlayers(0).filter((x) => x.role !== 'GK');
    park(m, [p, runner]);
    p.pos = { x: 0, z: -4 };
    runner.pos = { x: 3 * dir, z: 12 }; runner.vel = { x: 7 * dir, z: 0 };
    const plan = throughPlan(m.players, p, runner, p.pos, dir)!;
    expect(plan).not.toBeNull();
    expect((plan.point.x - runner.pos.x) * dir).toBeGreaterThan(6);
    expect(Math.abs(plan.point.z - 12)).toBeLessThan(0.5);
    expect(plan.arrive).toBeLessThan(8.5);
    expect(Math.abs(plan.point.x)).toBeLessThan(PITCH.halfLength - 4);
  });

  it('a person\'s through ball is taken by the runner at speed', () => {
    let ok = 0, fast = 0;
    for (const seed of [4, 5, 6, 7]) {
      const m = freshMatch(seed);
      const dir = m.attackDir(0);
      const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
      const runner = m.teamPlayers(0).find((x) => x.role === 'ST')!;
      park(m, [p, runner]);
      // The opponents well behind the play, but for the keeper and one defender far out on the other wing (so he is onside).
      for (const q of m.teamPlayers(1)) q.pos = q.role === 'GK' ? { x: 51 * dir, z: 0 } : q.role === 'RB' ? { x: 44 * dir, z: 30 } : { x: -45 * dir, z: q.pos.z };
      p.pos = { x: -10 * dir, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI;
      runner.pos = { x: 2 * dir, z: 6 }; runner.vel = { x: 8 * dir, z: 0 }; runner.facing = p.facing;
      m.takePossession(p, true);
      m.ball.pos = { x: p.pos.x + 0.4 * dir, y: 0.11, z: 0 };
      m.ctrl[0].pid = p.id;
      m.drainEvents();
      let seq = 1;
      const toR = { x: runner.pos.x - p.pos.x, z: runner.pos.z - p.pos.z };
      const L = Math.hypot(toR.x, toR.z);
      m.applyInput(0, { seq: seq++, mx: toR.x / L, mz: toR.z / L, sprint: false, jockey: false, contain: false, ev: [{ k: 'through', p: 0.3 }] });
      let speed = 0;
      for (let i = 0; i < 60 * 6; i++) {
        m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [] });
        m.step();
        for (const e of m.drainEvents()) if (e.type === 'kick' && e.player === p.id) expect(m.stride?.receiver).toBe(runner.id);
        if (m.ball.owner >= 0 && m.ball.owner !== p.id) { speed = Math.hypot(m.players[m.ball.owner].vel.x, m.players[m.ball.owner].vel.z); break; }
      }
      if (m.ball.owner === runner.id) { ok++; if (speed > 6) fast++; }
    }
    expect(ok).toBeGreaterThanOrEqual(3);
    expect(fast).toBeGreaterThanOrEqual(3);
  });
});
