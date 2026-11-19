// Human help (18 Nov 2026): a human's kicks are tighter against easier AI levels; the AI's own kicks never change.
import { describe, expect, it } from 'vitest';
import { DIFFICULTY, adaptiveParams } from '../src/shared/config';
import { humanHelp, solveGroundPass, solveShot, type KickContext } from '../src/shared/kick';
import { Match, defaultConfig } from '../src/shared/match';
import { Rng } from '../src/shared/rng';

function spread(help: number, shot: boolean) {
  const m = new Match(defaultConfig({ humans: [false, false], seed: 3 }));
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  p.pos = { x: 34, z: 4 }; p.vel = { x: 0, z: 0 }; p.facing = 0;
  const rng = new Rng(77);
  let s = 0, n = 400, on = 0;
  for (let i = 0; i < n; i++) {
    const ctx: KickContext = { kicker: p, ballPos: { x: 34.4, y: 0.11, z: 4 }, pressure: 0.4, rng, help };
    if (shot) {
      const r = solveShot(ctx, { side: 1, aimZ: -3, power: 0.88, placed: false });
      const t = (52.5 - 34.4) / r.vel.x, z = 4 + r.vel.z * t;
      if (Math.abs(z) < 3.66) on++;
    } else {
      const r = solveGroundPass(ctx, { x: 54, z: 20 }, 'pass');
      s += Math.abs(Math.atan2(r.vel.z, r.vel.x) - Math.atan2(16, 19.6));
    }
  }
  return shot ? on / n : s / n;
}

describe('human help', () => {
  it('levels give less help as they get harder, and Adaptive follows its level', () => {
    expect(DIFFICULTY.casual.help).toBeGreaterThan(DIFFICULTY.pro.help);
    expect(DIFFICULTY.pro.help).toBeGreaterThan(DIFFICULTY.elite.help);
    expect(adaptiveParams(3).help).toBeLessThan(adaptiveParams(1).help);
    expect(humanHelp.passError(0)).toBe(1);
    expect(humanHelp.shotError(0)).toBe(1);
  });
  it('tightens a human pass and keeps more shots on target', () => {
    expect(spread(0.8, false)).toBeLessThan(spread(0, false) * 0.7);
    expect(spread(0.8, true)).toBeGreaterThan(spread(0, true));
  });
  it('only a human-controlled kicker gets help', () => {
    const m = new Match(defaultConfig({ humans: [true, false], seed: 4, difficulty: ['pro', 'pro'] }));
    const me = m.players[m.ctrl[0].pid];
    expect(m.helpFor(me)).toBe(DIFFICULTY.pro.help);
    const mate = m.teamPlayers(0).find((x) => x.id !== me.id)!;
    expect(m.helpFor(mate)).toBe(0);
    expect(m.helpFor(m.teamPlayers(1)[3])).toBe(0);
  });
});
