// Team press and offside trap calls.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
function defending(seed = 3) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  // Give the ball to an opposition midfielder in their own half.
  const c = m.teamPlayers(1).find((x) => x.role === 'RCM')!;
  const d1 = m.attackDir(1);
  c.pos = { x: -d1 * 15, z: 0 }; c.vel = { x: 0, z: 0 }; c.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  m.takePossession(c, true); m.ball.pos = { x: c.pos.x + 0.45, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  c.aiNextDecision = m.time + 30; c.aiTarget = { ...c.pos };
  return { m, c };
}
const tick = (m: Match, n: number, ev: { k: 'press' | 'trap' }[] = []) => {
  m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev });
  for (let i = 0; i < n; i++) { if (i) m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [] }); m.step(); }
};

describe('team press', () => {
  it('sends three players at the ball and has a cooldown', () => {
    const { m } = defending();
    tick(m, 2);
    const before = m.plans[0]!.pressers.length;
    tick(m, 12, [{ k: 'press' }]);
    expect(m.teamPress[0]).toBeGreaterThan(m.time);
    expect(m.plans[0]!.pressers.length).toBe(3);
    expect(before).toBeLessThanOrEqual(3);
    const until = m.teamPress[0];
    tick(m, 2, [{ k: 'press' }]);
    expect(m.teamPress[0]).toBe(until); // cooling down
  });
  it('is ignored with the ball', () => {
    const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 3 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const me = m.players[m.ctrl[0].pid];
    m.takePossession(me, true);
    expect(m.startTeamPress(0)).toBe(false);
  });
});

describe('offside trap', () => {
  it('steps the back four up together towards the ball', () => {
    const { m } = defending(5);
    const backs = m.teamPlayers(0).filter((p) => ['RB', 'RCB', 'LCB', 'LB'].includes(p.role));
    const d0 = m.attackDir(0);
    tick(m, 60);
    const line0 = Math.max(...backs.map((p) => p.pos.x * d0));
    tick(m, 60, [{ k: 'trap' }]);
    const line1 = Math.max(...backs.map((p) => p.pos.x * d0));
    expect(line1).toBeGreaterThan(line0 + 3);
  });
});
