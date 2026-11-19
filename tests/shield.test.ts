// Shielding: the jockey button on the ball turns your back on the opponent and makes you harder to rob.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
const none = { type: 'none', t: 0, dur: 0 } as Player['action'];
function setup(seed: number) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const c = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  const d = m.teamPlayers(1).find((x) => x.role === 'RCB')!;
  m.ctrl[0].pid = c.id; m.ctrl[0].autoSwitch = false;
  c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; c.facing = 0; c.action = { ...none };
  d.pos = { x: -1.3, z: 0 }; d.vel = { x: 0, z: 0 }; d.facing = 0; d.action = { ...none }; d.tackleCooldown = 0;
  m.takePossession(c, true);
  m.ball.pos = { x: 0.45, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  return { m, c, d };
}
const park = (m: Match, keep: Player[]) => { for (const q of m.players) if (!keep.includes(q)) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; } };

describe('shielding', () => {
  it('holding jockey on the ball shields: back to the opponent, jockey pace', () => {
    const { m, c, d } = setup(1);
    d.pos = { x: 1.5, z: 0 }; // in front: the carrier turns away
    for (let i = 0; i < 40; i++) { park(m, [c, d]); m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: true, contain: false, ev: [] }); m.step(); d.pos = { x: c.pos.x + 1.5, z: c.pos.z }; }
    expect(c.shielding).toBe(true);
    expect(Math.abs(Math.cos(c.facing) - -1)).toBeLessThan(0.3); // facing away (towards -x)
    m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [] }); m.step();
    expect(c.shielding).toBe(false);
  });
  it('a standing tackle from behind wins the ball far less often against a shielding carrier', () => {
    const wins = (shield: boolean) => {
      let w = 0;
      for (let s = 1; s <= 60; s++) {
        const { m, c, d } = setup(500 + s);
        park(m, [c, d]);
        m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: shield, contain: false, ev: [] });
        for (let i = 0; i < 20; i++) { park(m, [c, d]); m.step(); d.pos = { x: c.pos.x - Math.cos(c.facing) * 1.2, z: c.pos.z - Math.sin(c.facing) * 1.2 }; d.facing = c.facing; }
        const f0 = m.stats[1].fouls;
        m.startTackle(d);
        for (let i = 0; i < 40; i++) { park(m, [c, d]); m.step(); }
        if (m.stats[1].fouls === f0 && m.ball.owner !== c.id) w++;
      }
      return w;
    };
    const open = wins(false), shielded = wins(true);
    expect(shielded).toBeLessThan(open * 0.75 + 1);
  });
});
