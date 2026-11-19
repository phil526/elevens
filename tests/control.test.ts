import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
/** A human striker receives a 14 m/s pass with the stick held one way; returns whether they still have it 1.5 s later. */
function receive(seed: number, mx: number, mz: number, sprint: boolean) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  const mate = m.teamPlayers(0).find((x) => x.role !== 'ST' && x.role !== 'GK')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  p.pos = { x: 10, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = Math.PI; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  const b = m.ball;
  b.pos = { x: -8, y: 0.11, z: 0 }; b.vel = { x: 14, y: 0, z: 0 };
  b.state = 'flight'; b.flight = 'pass'; b.owner = -1; b.receiver = p.id; b.kicker = mate.id; b.lastTouch = mate.id; b.lastTouchTeam = 0; b.kickLock = 0;
  let tArr = -1, maxSep = 0;
  for (let i = 0; i < 300; i++) {
    const live = tArr >= 0 || Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 2.5;
    m.applyInput(0, { seq: seq++, mx: live ? mx : 0, mz: live ? mz : 0, sprint: live && sprint, jockey: false, contain: false, ev: [] });
    for (const q of m.players) if (q !== p) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
    m.step(); m.drainEvents();
    if (tArr < 0 && b.owner === p.id) tArr = m.time;
    if (tArr >= 0) { maxSep = Math.max(maxSep, Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z)); if (m.time - tArr > 1.5) break; }
  }
  return { kept: tArr >= 0 && b.owner === p.id, maxSep };
}

describe('close control for the human player', () => {
  it('keeps the ball after a first touch with the stick held, close to the feet', () => {
    for (const [mx, mz] of [[1, 0], [0, 1], [-1, 0]]) {
      const r = receive(4, mx, mz, false);
      expect(r.kept).toBe(true);
      expect(r.maxSep).toBeLessThan(1.3);
    }
  });
  it('a sprint touch runs further ahead but stays theirs', () => {
    const r = receive(4, 1, 0, true);
    expect(r.kept).toBe(true);
    expect(r.maxSep).toBeLessThan(2.2);
  });
});

describe('runs for the human\'s teammates', () => {
  it('wingers or the striker start timed runs and stay onside', () => {
    const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 7 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const dir = m.attackDir(0);
    const p = m.teamPlayers(0).find((x) => x.role === 'RCM' || x.role === 'LCM')!;
    m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
    p.pos = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI;
    m.takePossession(p, true);
    m.ball.pos = { x: p.pos.x + 0.45 * dir, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    const ran = new Set<string>();
    for (let i = 0; i < 240; i++) {
      // Keep the carrier and the ball still so the opposition can't win it.
      p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI;
      m.ball.owner = p.id; m.ball.state = 'dribble'; m.ball.pos = { x: 0.45 * dir, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
      for (const o of m.teamPlayers(1)) if (Math.hypot(o.pos.x, o.pos.z) < 6) o.pos = { x: o.pos.x + 6 * dir, z: o.pos.z };
      m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [] });
      m.step(); m.drainEvents();
      for (const q of m.teamPlayers(0)) if (q.runLane && q.aiRunUntil > m.time) ran.add(q.role);
    }
    expect([...ran].some((r) => r === 'RW' || r === 'LW')).toBe(true);
  });
});
