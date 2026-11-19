// Aimed headers (a pass button nods a high ball to a teammate) and volleys (a shot struck in the air).
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import type { InputEvent, Player } from '../src/shared/types';

let seq = 1;
function setup(seed = 5) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 1500 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  const dir = m.attackDir(0);
  p.pos = { x: dir * 38, z: 2 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  // Opponents out of the way (except the keeper), teammates far away apart from one at the edge of the box.
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') { o.pos = { x: -dir * 20, z: o.pos.z }; o.vel = { x: 0, z: 0 }; }
  const mate = m.teamPlayers(0).find((x) => x.role === 'LW')!;
  for (const t of m.teamPlayers(0)) if (t !== p && t.role !== 'GK') { t.pos = { x: -dir * 10, z: t.pos.z }; t.vel = { x: 0, z: 0 }; }
  mate.pos = { x: dir * 34, z: -12 }; mate.vel = { x: 0, z: 0 };
  // A cross from the right arriving at the striker at the given height.
  m.ball.owner = -1; m.ball.state = 'flight'; m.ball.flight = 'cross'; m.ball.receiver = -1; m.ball.lastTouch = mate.id; m.ball.lastTouchTeam = 0; m.ball.kicker = -1; m.ball.kickLock = 0;
  m.offside.flagged.clear();
  return { m, p, mate, dir };
}
function cross(m: Match, p: Player, height: number) {
  // Start 4 m to the side, moving straight at the player, falling slowly.
  m.ball.pos = { x: p.pos.x, y: height + 0.1, z: p.pos.z + 4 };
  m.ball.vel = { x: 0, y: 1.6, z: -12 };
}
function run(m: Match, ev: InputEvent, mx: number, mz: number) {
  const events: { type: string; text?: string }[] = [];
  m.applyInput(0, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev: [ev] });
  for (let i = 0; i < 25; i++) {
    m.applyInput(0, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev: [] });
    m.step();
    events.push(...m.drainEvents());
    if (m.ball.lastTouch !== -1 && m.ball.kicker !== -1) break;
  }
  return events;
}

describe('aimed headers', () => {
  it('a pass button nods a high ball to the teammate the stick points at', () => {
    let hits = 0;
    for (const seed of [5, 6, 7, 8]) {
      const { m, p, mate } = setup(seed);
      cross(m, p, 2.0);
      const toMate = { x: mate.pos.x - p.pos.x, z: mate.pos.z - p.pos.z };
      const l = Math.hypot(toMate.x, toMate.z);
      const ev = run(m, { k: 'pass', p: 0.4 }, toMate.x / l, toMate.z / l);
      expect(ev.some((e) => e.type === 'kick' && e.text === 'header')).toBe(true);
      expect(m.ball.receiver).toBe(mate.id);
      const v = m.ball.vel;
      if ((v.x * toMate.x + v.z * toMate.z) / (Math.hypot(v.x, v.z) * l) > 0.9) hits++;
    }
    expect(hits).toBeGreaterThanOrEqual(3);
  });
});

describe('volleys', () => {
  it('a shot pressed as a waist-high ball arrives is struck first time towards goal', () => {
    let toGoal = 0;
    for (const seed of [5, 6, 7, 8, 9, 10]) {
      const { m, p, dir } = setup(seed);
      cross(m, p, 0.75);
      const ev = run(m, { k: 'shoot', p: 0.6 }, dir, 0);
      expect(ev.some((e) => e.type === 'kick' && e.text === 'volley')).toBe(true);
      expect(m.ball.flight).toBe('shot');
      expect(m.ball.owner).toBe(-1);
      if (m.ball.vel.x * dir > 15) toGoal++;
    }
    expect(toGoal).toBeGreaterThanOrEqual(5);
  });
  it('a ball at the feet is not a volley', () => {
    const { m, p, dir } = setup(5);
    cross(m, p, 0.12);
    const ev = run(m, { k: 'shoot', p: 0.6 }, dir, 0);
    expect(ev.some((e) => e.type === 'kick' && e.text === 'volley')).toBe(false);
  });
});
