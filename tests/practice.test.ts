// Practice mode: no clock; free kicks and penalties on repeat.
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import type { InputEvent, MatchConfig } from '../src/shared/types';

let seq = 1;
const make = (practice: MatchConfig['practice'], seed = 4) => new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, practice }));
const idle = (m: Match, ev: InputEvent[] = []) =>
  m.applyInput(0, { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev });

describe('practice mode', () => {
  it('free play has no clock and no half time', () => {
    const m = make('free');
    for (let i = 0; i < 60 * 60 * 3; i++) m.step();
    expect(m.displayClock).toBe(0);
    expect(m.half).toBe(1);
    expect(['play', 'restart', 'kickoff', 'goal']).toContain(m.phase);
  });
  it('penalties: a penalty for you straight away, and another after each attempt', () => {
    const m = make('penalty');
    m.step();
    expect(m.phase).toBe('restart');
    const first = m.restart!;
    expect(first.type).toBe('penalty');
    expect(first.team).toBe(0);
    expect(Math.abs(m.ball.pos.x)).toBeCloseTo(PITCH.halfLength - PITCH.penaltySpot, 1);
    let attempts = 0, last = first;
    for (let i = 0; i < 60 * 40 && attempts < 3; i++) {
      const r = m.restart;
      idle(m, r && r.ready && r.readyT > 0.4 ? [{ k: 'shoot', p: 0.6 }] : []);
      m.step();
      if (m.restart && m.restart !== last && m.restart.type === 'penalty') { attempts++; last = m.restart; }
    }
    expect(attempts).toBe(3);
    expect(m.displayClock).toBe(0);
  });
  it('free kicks move around in shooting range', () => {
    const m = make('freekick', 8);
    const spots: number[] = [];
    m.step();
    for (let k = 0; k < 4; k++) {
      const r = m.restart!;
      expect(r.type).toBe('freekick');
      expect(r.team).toBe(0);
      const d = PITCH.halfLength - Math.abs(r.spot.x);
      expect(d).toBeGreaterThan(16);
      expect(d).toBeLessThan(31);
      spots.push(r.spot.z);
      m.nextDrill();
    }
    expect(new Set(spots.map((z) => Math.round(z))).size).toBeGreaterThan(1);
  });
});
