// Corner and free-kick routines: the taker's switch button cycles them, teammates move, and the kick goes to the routine's target.
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import { ROUTINES, routineAim } from '../src/shared/ai/team';
import type { InputEvent, MatchEvent, RestartType, TeamIndex } from '../src/shared/types';

type Internals = { award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void };
const I = (m: Match) => m as unknown as Internals;
let seq = 1;
const input = (m: Match, ev: InputEvent[] = []) => m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev });

function corner(seed = 5) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, quickRestarts: [false, true] }));
  for (let i = 0; i < 1500 && m.phase !== 'play'; i++) m.step();
  const dir = m.attackDir(0);
  I(m).award('corner', 0, { x: dir * (PITCH.halfLength - 0.5), z: PITCH.halfWidth - 0.5 });
  for (let i = 0; i < 60 * 15 && !m.restart?.ready; i++) { input(m); m.step(); }
  m.drainEvents();
  return { m, dir };
}

describe('set-piece routines', () => {
  it('the switch button cycles corner routines and announces each one', () => {
    const { m } = corner();
    const seen: number[] = [];
    for (let k = 0; k < ROUTINES.corner.length; k++) {
      input(m, [{ k: 'switch' }]);
      m.step();
      const ev = m.drainEvents().find((e: MatchEvent) => e.type === 'call' && e.text === 'routine:corner');
      seen.push(ev?.power ?? -1);
    }
    expect(seen).toEqual([1, 2, 3, 4, 0]);
  });
  it('a near-post routine crowds the near post and the cross goes there', () => {
    const { m, dir } = corner();
    input(m, [{ k: 'switch' }]);
    for (let i = 0; i < 400; i++) { input(m); m.step(); }
    const aim = routineAim(m, m.restart!)!;
    expect(m.restart!.aim.z).toBeCloseTo(aim.z, 1);
    const near = m.teamPlayers(0).filter((p) => Math.abs(p.pos.x - dir * PITCH.halfLength) < 8 && p.pos.z > 0 && p.pos.z < 8).length;
    expect(near).toBeGreaterThanOrEqual(2);
    input(m, [{ k: 'lob', p: 0.5 }]);
    for (let i = 0; i < 40 && m.ball.state !== 'flight'; i++) { input(m); m.step(); }
    expect(m.ball.state).toBe('flight');
    const recv = m.players[m.ball.receiver];
    expect(recv && recv.team).toBe(0);
    expect(Math.hypot(recv.pos.x - aim.x, recv.pos.z - aim.z)).toBeLessThan(6);
  });
  it('a short corner brings a teammate to the flag and a pass goes to them', () => {
    const { m } = corner(6);
    input(m, [{ k: 'switch' }]); m.step();
    input(m, [{ k: 'switch' }]); m.step();
    input(m, [{ k: 'switch' }]); m.step();
    expect(m.restart!.routine).toBe(3);
    for (let i = 0; i < 400; i++) { input(m); m.step(); }
    input(m, [{ k: 'pass', p: 0.3 }]);
    for (let i = 0; i < 40 && m.ball.state !== 'flight'; i++) { input(m); m.step(); }
    const recv = m.players[m.ball.receiver];
    expect(recv?.role).toBe('RCM');
  });
  it('the computer varies its corners', () => {
    const routines = new Set<number>();
    for (let seed = 1; seed < 12; seed++) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
      for (let i = 0; i < 700 && m.phase !== 'play'; i++) m.step();
      I(m).award('corner', 1, { x: m.attackDir(1) * (PITCH.halfLength - 0.5), z: -(PITCH.halfWidth - 0.5) });
      for (let i = 0; i < 60 * 15 && !m.restart?.ready; i++) m.step();
      routines.add(m.restart?.routine ?? 0);
    }
    expect(routines.size).toBeGreaterThanOrEqual(3);
  });
});
