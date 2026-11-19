import { describe, it, expect } from 'vitest';
import { aiMatch, toOpenPlay } from './helpers';
import type { Match } from '../src/shared/match';
import type { InputFrame } from '../src/shared/types';

let seq = 0;
const frame = (mx: number, mz: number, ev: InputFrame['ev'] = [], sprint = false): InputFrame => ({ seq: ++seq, mx, mz, sprint, jockey: false, ev });

/** Steps with both co-op humans (or both versus humans) pushing their sticks. */
function run(m: Match, ticks: number, feed: () => void) {
  for (let i = 0; i < ticks; i++) { feed(); m.step(); }
}

describe('local multiplayer: co-op', () => {
  it('two humans on one side each steer their own player', () => {
    const m = aiMatch({ humans: [true, false], mates: [true, false] });
    toOpenPlay(m);
    const c = m.ctrl[0], mt = m.mates[0]!;
    expect(mt).toBeTruthy();
    expect(mt.pid).not.toBe(c.pid);
    const a = m.players[c.pid], b = m.players[mt.pid];
    // Only steer players who are not on the ball (so a pass can't change who is who).
    m.ball.owner = -1; m.ball.state = 'free'; m.ball.pos = { x: 0, y: 0.11, z: 30 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    const a0 = { ...a.pos }, b0 = { ...b.pos };
    run(m, 60, () => { m.applyInput(0, frame(0, -1)); m.applyInput(0, frame(0, 1), 1); });
    expect(a.pos.z - a0.z).toBeLessThan(-2);
    expect(b.pos.z - b0.z).toBeGreaterThan(2);
  });

  it('a switch never takes the other human\'s player', () => {
    const m = aiMatch({ humans: [true, false], mates: [true, false] });
    toOpenPlay(m);
    for (let i = 0; i < 30; i++) {
      m.switchPlayer(0, true);
      expect(m.ctrl[0].pid).not.toBe(m.mates[0]!.pid);
      m.asMate(0, () => m.switchPlayer(0, true));
      expect(m.ctrl[0].pid).not.toBe(m.mates[0]!.pid);
      m.step();
    }
  });

  it('a pass to the other human\'s player leaves both humans where they are', () => {
    const m = aiMatch({ humans: [true, false], mates: [true, false] });
    toOpenPlay(m);
    const c = m.ctrl[0], mt = m.mates[0]!;
    const passer = m.players[c.pid], target = m.players[mt.pid];
    // Clear space: the two teammates 12 m apart, opponents far away.
    passer.pos = { x: 0, z: 0 }; target.pos = { x: 0, z: 12 };
    for (const p of m.teamPlayers(1)) p.pos = { x: 40, z: p.pos.z };
    const b = m.ball;
    b.owner = passer.id; b.state = 'dribble'; b.pos = { x: 0.4, y: 0.11, z: 0 }; b.vel = { x: 0, y: 0, z: 0 }; b.lastTouch = passer.id; b.lastTouchTeam = 0;
    const p0 = passer.id;
    run(m, 1, () => m.applyInput(0, frame(0, 1, [{ k: 'pass', p: 0.3 }])));
    run(m, 90, () => {});
    expect(m.mates[0]!.pid).toBe(target.id);
    expect(m.ctrl[0].pid).toBe(p0);
    expect(m.ctrl[0].pid).not.toBe(m.mates[0]!.pid);
  });

  it('the second human can take a restart: the nearer human gets the taker', () => {
    const m = aiMatch({ humans: [true, false], mates: [true, false] });
    toOpenPlay(m);
    const c = m.ctrl[0], mt = m.mates[0]!;
    const award = (m as unknown as { award: (t: string, team: number, s: { x: number; z: number }) => void }).award.bind(m);
    // Put the mate's player right by the touchline and the primary's far away.
    m.players[mt.pid].pos = { x: 10, z: 32 };
    m.players[c.pid].pos = { x: -30, z: -20 };
    award('throwin', 0, { x: 10, z: 34.15 });
    const taker = m.restart!.taker;
    expect([c.pid, mt.pid]).toContain(taker);
    expect(mt.pid).toBe(taker);
    // The mate's throw happens when the mate presses pass.
    for (let i = 0; i < 60 * 6 && m.phase === 'restart'; i++) {
      if (m.restart?.ready) m.applyInput(0, frame(0, 0, [{ k: 'pass', p: 0.4 }]), 1);
      m.step();
    }
    expect(m.phase).toBe('play');
    expect(m.ball.lastTouch).toBe(taker);
  });

  it('kick-off gives the two humans different players and no keeper', () => {
    const m = aiMatch({ humans: [true, true], mates: [true, true] });
    for (const t of [0, 1]) {
      expect(m.ctrl[t].pid).not.toBe(m.mates[t]!.pid);
      expect(m.players[m.mates[t]!.pid].role).not.toBe('GK');
      expect(m.isHumanControlled(m.players[m.mates[t]!.pid])).toBe(true);
    }
  });
});

describe('local multiplayer: versus', () => {
  it('each side\'s human moves their own player', () => {
    const m = aiMatch({ humans: [true, true], autoSwitch: [false, false] });
    toOpenPlay(m);
    m.ball.owner = -1; m.ball.state = 'free'; m.ball.pos = { x: 0, y: 0.11, z: 30 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    const a = m.players[m.ctrl[0].pid], b = m.players[m.ctrl[1].pid];
    const a0 = { ...a.pos }, b0 = { ...b.pos };
    run(m, 60, () => { m.applyInput(0, frame(0, -1)); m.applyInput(1, frame(0, 1)); });
    expect(a.pos.z - a0.z).toBeLessThan(-2);
    expect(b.pos.z - b0.z).toBeGreaterThan(2);
  });

  it('a whole human-v-human match runs to full time without errors', () => {
    const m = aiMatch({ humans: [true, true], mates: [true, false], seed: 3 });
    let t = 0;
    for (let i = 0; i < 60 * 60 * 5 && m.phase !== 'fulltime'; i++) {
      t++;
      const ang = t / 90;
      m.applyInput(0, frame(Math.cos(ang), Math.sin(ang), t % 70 === 0 ? [{ k: 'pass', p: 0.5 }] : t % 333 === 0 ? [{ k: 'shoot', p: 0.7 }] : []));
      m.applyInput(0, frame(Math.sin(ang), Math.cos(ang), t % 55 === 0 ? [{ k: 'switch' }] : []), 1);
      m.applyInput(1, frame(-Math.cos(ang), 0.3, t % 80 === 0 ? [{ k: 'shoot', p: 0.5 }] : []));
      if (m.phase === 'halftime') m.continueAfterHalftime();
      m.step();
      if (m.phase === 'play') expect(m.ctrl[0].pid).not.toBe(m.mates[0]!.pid);
    }
    expect(m.phase).toBe('fulltime');
  });
});
