// Dribbling: the ball goes with the player through cuts and turns, and stays close.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
function setup() {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 3 }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  p.pos = { x: -30, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.stamina = 1; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  m.takePossession(p, true); m.ball.pos = { x: p.pos.x + 0.45, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  return { m, p };
}
function step(m: Match, p: Player, mx: number, mz: number, sprint: boolean) {
  m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [] });
  for (const q of m.players) if (q.id !== p.id) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
  m.step();
}

describe('dribbling', () => {
  for (const sprint of [false, true]) for (const deg of [45, 90, 180]) {
    it(`a ${deg}° turn while ${sprint ? 'sprinting' : 'jogging'} keeps the ball and takes it the new way`, () => {
      const { m, p } = setup();
      for (let i = 0; i < 120; i++) step(m, p, 1, 0, sprint);
      expect(m.ball.owner).toBe(p.id);
      const a = (deg * Math.PI) / 180, wx = Math.cos(a), wz = Math.sin(a);
      let maxSep = 0;
      for (let i = 0; i < 90; i++) { step(m, p, wx, wz, sprint); maxSep = Math.max(maxSep, Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z)); }
      expect(m.ball.owner).toBe(p.id);
      expect(maxSep).toBeLessThan(2.2);
      // After 1.5 s the ball is moving roughly the way the stick points.
      const bs = Math.hypot(m.ball.vel.x, m.ball.vel.z);
      expect(bs).toBeGreaterThan(1);
      expect((m.ball.vel.x * wx + m.ball.vel.z * wz) / bs).toBeGreaterThan(0.8);
    });
  }
});
