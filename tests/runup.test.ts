// Set-piece run-ups: the taker waits a few strides back and runs in to strike the ball.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig, runupDistance } from '../src/shared/match';
import { PITCH } from '../src/shared/config';
import type { RestartType, TeamIndex, V2 } from '../src/shared/types';

const I = (m: Match) => m as unknown as { award: (t: RestartType, team: TeamIndex, spot: V2) => void };

function watch(type: RestartType, spot: (m: Match) => V2) {
  const m = new Match(defaultConfig({ humans: [false, false], seed: 3 }));
  for (let i = 0; i < 60; i++) m.step();
  I(m).award(type, 0, spot(m));
  for (let i = 0; i < 600 && !m.restart!.ready; i++) m.step();
  const r = m.restart!;
  const taker = m.players[r.taker];
  const waitD = Math.hypot(taker.pos.x - r.spot.x, taker.pos.z - r.spot.z);
  let maxSpeed = 0, kickD = -1;
  for (let i = 0; i < 600 && m.phase === 'restart'; i++) {
    m.step();
    maxSpeed = Math.max(maxSpeed, Math.hypot(taker.vel.x, taker.vel.z));
    if (kickD < 0 && taker.action.type === 'kick') kickD = Math.hypot(taker.pos.x - r.spot.x, taker.pos.z - r.spot.z);
  }
  return { waitD, maxSpeed, kickD, phase: m.phase };
}

describe('set-piece run-ups', () => {
  it('only free kicks, penalties, goal kicks and corners have one', () => {
    expect(runupDistance('freekick')).toBeGreaterThan(2);
    expect(runupDistance('penalty')).toBeGreaterThan(2);
    expect(runupDistance('goalkick')).toBeGreaterThan(3);
    expect(runupDistance('throwin')).toBe(0);
    expect(runupDistance('kickoff')).toBe(0);
  });
  for (const [type, spot] of [
    ['freekick', (m: Match) => ({ x: m.attackDir(0) * 25, z: 6 })],
    ['penalty', (m: Match) => ({ x: m.attackDir(0) * (PITCH.halfLength - PITCH.penaltySpot), z: 0 })],
    ['goalkick', (m: Match) => ({ x: -m.attackDir(0) * (PITCH.halfLength - 5.5), z: 4.5 })],
  ] as const) {
    it(`${type}: the taker waits back, runs in and strikes it from beside the ball`, () => {
      const r = watch(type, spot);
      expect(r.waitD).toBeGreaterThan(runupDistance(type) * 0.9);
      expect(r.maxSpeed).toBeGreaterThan(3);
      expect(r.kickD).toBeGreaterThan(0.5);
      expect(r.kickD).toBeLessThan(1.3);
      expect(r.phase).not.toBe('restart');
    });
  }
});
