import { describe, expect, it } from 'vitest';
import { stepBall } from '../src/shared/ball';
import { BALL, PITCH, SIM } from '../src/shared/config';
import type { BallPhys } from '../src/shared/types';

const ball = (x: number, y: number, z: number, vx: number, vy: number, vz: number): BallPhys => ({ pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, spin: 0 });

function run(b: BallPhys, seconds: number) {
  const crossings = [];
  let hitPost = false, hitBar = false;
  for (let i = 0; i < seconds / SIM.dt; i++) {
    const r = stepBall(b, SIM.dt, true);
    if (r.crossing) crossings.push(r.crossing);
    hitPost ||= r.hitPost;
    hitBar ||= r.hitBar;
  }
  return { crossings, hitPost, hitBar };
}

describe('ball physics', () => {
  it('detects a fast shot as exactly one goal crossing', () => {
    const b = ball(PITCH.halfLength - 12, 0.5, 0, 34, 1.5, 0);
    const r = run(b, 1);
    const goals = r.crossings.filter((c) => c.kind === 'goal');
    expect(goals).toHaveLength(1);
    expect(goals[0].side).toBe(1);
  });

  it('does not let a 34 m/s ball tunnel through a post', () => {
    const z = PITCH.goalHalfWidth + PITCH.postRadius * 0.5; // dead centre of the right-hand post
    const b = ball(PITCH.halfLength - 10, 1, z, 34, 0.3, 0);
    const r = run(b, 0.6);
    expect(r.hitPost).toBe(true);
    expect(r.crossings.filter((c) => c.kind === 'goal')).toHaveLength(0);
    expect(b.pos.x).toBeLessThan(PITCH.halfLength); // bounced back into play
  });

  it('a ball over the bar is not a goal', () => {
    const b = ball(PITCH.halfLength - 2, PITCH.goalHeight + 1, 0, 15, 0, 0);
    const r = run(b, 0.5);
    expect(r.crossings[0]?.kind).toBe('byline');
  });

  it('requires the whole ball to cross the line', () => {
    // Ball creeping to rest with its centre just past the line but still overlapping it.
    const b = ball(PITCH.halfLength - 0.5, BALL.radius, 0, 1.5, 0, 0);
    const r = run(b, 2);
    const g = r.crossings.find((c) => c.kind === 'goal');
    if (g) expect(b.pos.x).toBeGreaterThan(PITCH.halfLength + BALL.radius - 0.01);
    else expect(b.pos.x).toBeLessThanOrEqual(PITCH.halfLength + BALL.radius);
  });

  it('reports touchline crossings with side and position', () => {
    const b = ball(10, BALL.radius, PITCH.halfWidth - 1, 0, 0, 12);
    const r = run(b, 0.5);
    expect(r.crossings[0]).toMatchObject({ kind: 'touch', side: 1 });
  });

  it('a rolling ball decelerates and stops', () => {
    const b = ball(0, BALL.radius, 0, 10, 0, 0);
    run(b, 8);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeLessThan(0.05);
    expect(b.pos.x).toBeGreaterThan(15);
    expect(b.pos.x).toBeLessThan(30);
  });
});
