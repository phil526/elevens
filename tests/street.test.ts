import { afterAll, describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { FULL_PITCH, PITCH, STREET_PITCH, setPitch } from '../src/shared/config';
import { stepBall } from '../src/shared/ball';
import { addStreetResult } from '../src/client/modes/street';
import type { BallPhys } from '../src/shared/types';

afterAll(() => setPitch(FULL_PITCH));

const ball = (x: number, z: number, vx: number, vz: number, y = 0.11): BallPhys => ({ pos: { x, y, z }, vel: { x: vx, y: 0, z: vz }, spin: 0 });

describe('street cage', () => {
  it('bounces the ball back off the side and end walls, but lets it into the goal', () => {
    setPitch(STREET_PITCH);
    const side = ball(0, 10, 0, 15);
    for (let i = 0; i < 30; i++) stepBall(side, 1 / 60, true);
    expect(side.vel.z).toBeLessThan(0);
    expect(Math.abs(side.pos.z)).toBeLessThan(PITCH.halfWidth);
    const end = ball(17, 6, 18, 0);
    let crossed = false;
    for (let i = 0; i < 30; i++) if (stepBall(end, 1 / 60, true).crossing) crossed = true;
    expect(crossed).toBe(false);
    expect(end.vel.x).toBeLessThan(0);
    const shot = ball(15, 0.3, 20, 0);
    let goal = false;
    for (let i = 0; i < 40; i++) if (stepBall(shot, 1 / 60, true).crossing?.kind === 'goal') goal = true;
    expect(goal).toBe(true);
    setPitch(FULL_PITCH);
    const out = ball(0, 32, 0, 15);
    let touch = false;
    for (let i = 0; i < 30; i++) if (stepBall(out, 1 / 60, true).crossing?.kind === 'touch') touch = true;
    expect(touch).toBe(true);
  });

  it('plays a whole AI match five a side with no throw-ins, corners or goal kicks', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 77, street: true }));
    expect(PITCH.length).toBe(40);
    expect(m.players.filter((p) => !p.off).length).toBe(10);
    expect(m.maxSubs).toBe(0);
    const restarts = new Set<string>();
    let guard = 0, outside = 0;
    while (m.phase !== 'fulltime' && guard++ < 60 * 60 * 5) {
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      if (m.restart) restarts.add(m.restart.type);
      if (Math.abs(m.ball.pos.z) > PITCH.halfWidth + 0.01) outside++;
      for (const p of m.players) if (!p.off && (Math.abs(p.pos.x) > PITCH.halfLength || Math.abs(p.pos.z) > PITCH.halfWidth)) outside++;
      m.drainEvents();
    }
    expect(m.phase).toBe('fulltime');
    expect(outside).toBe(0);
    for (const r of ['throwin', 'corner', 'goalkick']) expect(restarts.has(r)).toBe(false);
    expect(m.stats[0].shots + m.stats[1].shots).toBeGreaterThan(2);
    expect(m.stats[0].offsides + m.stats[1].offsides).toBe(0);
    // The next normal match is back on a full pitch.
    const n = new Match(defaultConfig({ humans: [false, false], seed: 1 }));
    expect(PITCH.length).toBe(105);
    expect(n.players.filter((p) => !p.off).length).toBe(22);
  });

  it('keeps a street record with the best win', () => {
    let r = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, best: null as [number, number] | null };
    r = addStreetResult(r, 3, 1);
    r = addStreetResult(r, 2, 2);
    r = addStreetResult(r, 5, 1);
    r = addStreetResult(r, 0, 1);
    expect(r).toMatchObject({ p: 4, w: 2, d: 1, l: 1, gf: 10, ga: 5, best: [5, 1] });
  });
});
