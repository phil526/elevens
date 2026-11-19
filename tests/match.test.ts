import { describe, expect, it } from 'vitest';
import { MATCH, PITCH } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import type { Phase } from '../src/shared/types';
import { aiMatch, clearArea, launch, toOpenPlay } from './helpers';

// Private rule helpers are reached through this cast; the rules are what is under test.
type Internals = { evaluateOffside(p: unknown, exempt: boolean): void; checkOffsideInvolvement(p: unknown): boolean; foul(a: unknown, b: unknown): void };
const internals = (m: Match) => m as unknown as Internals;

function stepN(m: Match, n: number) {
  for (let i = 0; i < n; i++) m.step();
}

describe('match flow', () => {
  it('plays a full AI match through both halves to full time', () => {
    const m = aiMatch({ seed: 3 });
    const seen: Phase[] = [];
    let ticks = 0;
    while (m.phase !== 'fulltime' && ticks < 60 * 60 * 6) {
      m.step();
      if (seen[seen.length - 1] !== m.phase) seen.push(m.phase);
      if (m.phase === 'halftime') m.continueAfterHalftime();
      ticks++;
    }
    expect(m.phase).toBe('fulltime');
    expect(seen[0]).toBe('kickoff');
    expect(seen).toContain('play');
    expect(seen).toContain('halftime');
    expect(m.half).toBe(2);
    expect(Math.round(m.displayClock)).toBe(90 * 60 + m.addedTime * 60); // the clock runs on into added time
    // 2 real minutes of match time (plus stoppages) must finish well inside 6 minutes of ticks.
    expect(ticks).toBeLessThan(60 * 60 * 4);
  });

  it('keeps a single, consistent owner and never leaves the ball stuck', () => {
    const m = aiMatch({ seed: 11 });
    let maxStill = 0;
    while (m.phase !== 'fulltime') {
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      const b = m.ball;
      if (b.owner >= 0) expect(['dribble', 'held']).toContain(b.state);
      if (b.state === 'dribble' || b.state === 'held') expect(b.owner).toBeGreaterThanOrEqual(0);
      if (m.phase === 'play') maxStill = Math.max(maxStill, b.stillTime);
      expect(Number.isFinite(b.pos.x) && Number.isFinite(b.pos.z)).toBe(true);
    }
    expect(maxStill).toBeLessThanOrEqual(MATCH.stuckBallSeconds + 0.05);
  });

  it('swaps ends and the kick-off team for the second half', () => {
    const m = aiMatch({ seed: 9 });
    const firstTeam = m.restart!.team;
    const dir0 = m.attackDir(0);
    while (m.phase !== 'halftime') m.step();
    m.continueAfterHalftime();
    expect(m.half).toBe(2);
    expect(m.restart?.type).toBe('kickoff');
    expect(m.restart?.team).toBe(1 - firstTeam);
    expect(m.attackDir(0)).toBe(-dir0);
    expect(m.clock).toBe(0);
  });

  it('is deterministic for a given seed', () => {
    const a = aiMatch({ seed: 21 }), b = aiMatch({ seed: 21 });
    stepN(a, 3000); stepN(b, 3000);
    expect(a.ball.pos).toEqual(b.ball.pos);
    expect(a.score).toEqual(b.score);
  });

  it('both teams can score (over a handful of seeded AI matches)', () => {
    const goals = [0, 0];
    for (let seed = 11; seed < 31 && (goals[0] === 0 || goals[1] === 0); seed++) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
      while (m.phase !== 'fulltime') { m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); }
      goals[0] += m.score[0]; goals[1] += m.score[1];
    }
    expect(goals[0]).toBeGreaterThan(0);
    expect(goals[1]).toBeGreaterThan(0);
  }, 120_000);
});

describe('goals and restarts', () => {
  it('a shot into the goal counts once and the conceding side kicks off', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const end = m.attackDir(0) * PITCH.halfLength;
    clearArea(m, end, 0, 25);
    for (const t of [0, 1]) m.keeper(t).pos = { x: m.keeper(t).pos.x, z: 30 };
    launch(m, { x: end - m.attackDir(0) * 8, y: 0.5, z: 0 }, { x: m.attackDir(0) * 30, y: 1, z: 0 }, 0, 'shot');
    stepN(m, 30);
    expect(m.score).toEqual([1, 0]);
    expect(m.phase).toBe('goal');
    stepN(m, 60 * (MATCH.goalCelebration + 0.5));
    expect(m.score).toEqual([1, 0]);
    expect(m.restart?.type).toBe('kickoff');
    expect(m.restart?.team).toBe(1);
  });

  it('touchline: throw-in to the other team at the crossing point', () => {
    const m = aiMatch();
    toOpenPlay(m);
    clearArea(m, 10, PITCH.halfWidth, 15);
    launch(m, { x: 10, y: 0.11, z: PITCH.halfWidth - 1 }, { x: 0, y: 0, z: 10 }, 0);
    stepN(m, 20);
    expect(m.restart?.type).toBe('throwin');
    expect(m.restart?.team).toBe(1);
    expect(Math.abs(m.restart!.spot.x - 10)).toBeLessThan(0.6);
  });

  it('goal line: goal kick if the attackers touched it last, corner if the defenders did', () => {
    for (const [lastTeam, expected, team] of [[0, 'goalkick', 1], [1, 'corner', 0]] as const) {
      const m = aiMatch();
      toOpenPlay(m);
      const end = m.attackDir(0) * PITCH.halfLength; // team 1 defends this end
      clearArea(m, end, 15, 22);
      launch(m, { x: end - m.attackDir(0) * 2, y: 0.11, z: 15 }, { x: m.attackDir(0) * 10, y: 0, z: 0 }, lastTeam);
      stepN(m, 30);
      expect(m.restart?.type).toBe(expected);
      expect(m.restart?.team).toBe(team);
    }
  });

  it('offside: flags a forward beyond the second-last defender and awards an indirect free kick when involved', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const dir = m.attackDir(0);
    const passer = m.teamPlayers(0).find((p) => p.role === 'CDM')!;
    const st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    const onside = m.teamPlayers(0).find((p) => p.role === 'LW')!;
    // Defenders (team 1) on a line at fx 30, keeper at 50.
    for (const d of m.teamPlayers(1)) d.pos = { x: dir * (d.role === 'GK' ? 50 : 30 - Math.random()), z: d.pos.z };
    for (const p of m.teamPlayers(0)) if (p !== passer && p !== st && p !== onside) p.pos = { x: dir * -10, z: p.pos.z };
    passer.pos = { x: dir * 10, z: 0 };
    m.ball.pos = { x: dir * 10.5, y: 0.11, z: 0 };
    st.pos = { x: dir * 36, z: 2 };
    onside.pos = { x: dir * 29, z: -10 };
    internals(m).evaluateOffside(passer, false);
    expect(m.offside.flagged.has(st.id)).toBe(true);
    expect(m.offside.flagged.has(onside.id)).toBe(false);
    expect(internals(m).checkOffsideInvolvement(st)).toBe(true);
    expect(m.restart?.type).toBe('freekick');
    expect(m.restart?.team).toBe(1);
    expect(m.restart?.indirect).toBe(true);
  });

  it('offside is never given from a player in their own half or from a throw-in', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const dir = m.attackDir(0);
    const passer = m.teamPlayers(0).find((p) => p.role === 'RCB')!;
    const st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    for (const d of m.teamPlayers(1)) d.pos = { x: dir * 5, z: d.pos.z };
    passer.pos = { x: dir * -30, z: 0 };
    m.ball.pos = { x: dir * -30, y: 0.11, z: 0 };
    st.pos = { x: dir * -2, z: 0 };
    internals(m).evaluateOffside(passer, false);
    expect(m.offside.flagged.has(st.id)).toBe(false);
    st.pos = { x: dir * 30, z: 0 };
    internals(m).evaluateOffside(passer, true);
    expect(m.offside.flagged.size).toBe(0);
  });

  it('fouls: a free kick at the spot, or a penalty inside the area', () => {
    const m = aiMatch();
    toOpenPlay(m);
    const dir = m.attackDir(0);
    const victim = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    const offender = m.teamPlayers(1).find((p) => p.role === 'RCB')!;
    victim.pos = { x: dir * 20, z: 5 };
    internals(m).foul(offender, victim);
    expect(m.restart).toMatchObject({ type: 'freekick', team: 0 });
    expect(m.stats[1].fouls).toBe(1);

    const m2 = aiMatch();
    toOpenPlay(m2);
    const v2 = m2.teamPlayers(0).find((p) => p.role === 'ST')!;
    v2.pos = { x: dir * 45, z: 3 };
    internals(m2).foul(m2.teamPlayers(1).find((p) => p.role === 'RCB')!, v2);
    expect(m2.restart?.type).toBe('penalty');
    expect(Math.abs(m2.restart!.spot.x)).toBeCloseTo(PITCH.halfLength - PITCH.penaltySpot, 5);
  });
});

describe('human control', () => {
  it('a pass input from the human kick-off taker takes the kick-off', () => {
    const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 5 }));
    const team = m.restart!.team;
    m.setHuman(team, true);
    const frame = (seq: number, ev: { k: 'pass' }[] = []) => ({ seq, mx: ev.length ? -m.attackDir(team) : 0, mz: 0, sprint: false, jockey: false, ev });
    let seq = 0;
    for (let i = 0; i < 120; i++) { m.applyInput(team, frame(++seq)); m.step(); }
    expect(m.phase).toBe('kickoff'); // an AI taker would have gone by now; the human is waited for
    m.applyInput(team, frame(++seq, [{ k: 'pass' }]));
    let kicker = -1;
    for (let i = 0; i < 40; i++) {
      m.step();
      m.applyInput(team, frame(++seq));
      for (const e of m.drainEvents()) if (e.type === 'kick' && kicker < 0) kicker = e.player!;
    }
    expect(m.phase).toBe('play');
    expect(m.players[kicker].team).toBe(team);
  });

  it('clamps oversized movement input', () => {
    const m = new Match(defaultConfig({ humans: [true, false] }));
    m.applyInput(0, { seq: 1, mx: 50, mz: 50, sprint: false, jockey: false, ev: [] });
    expect(Math.hypot(m.ctrl[0].input.mx, m.ctrl[0].input.mz)).toBeCloseTo(1, 5);
  });

  it('an AI-controlled team ignores input', () => {
    const m = aiMatch();
    m.applyInput(0, { seq: 1, mx: 1, mz: 0, sprint: true, jockey: false, ev: [{ k: 'shoot', p: 1 }] });
    expect(m.ctrl[0].input.mx).toBe(0);
  });
});
