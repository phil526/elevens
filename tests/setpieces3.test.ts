// Free kicks and penalties (20 Nov 2026): ratings, chosen takers, pressure, the penalty keeper
// duel, techniques, habits, knuckleballs, wall tricks, the referee's ten yards and shootouts.
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { timingRing } from '../src/shared/kick';
import { Match, defaultConfig } from '../src/shared/match';
import { Rng } from '../src/shared/rng';
import { wallFor } from '../src/shared/ai/team';
import { encodeSnapshot } from '../src/shared/snapshot';
import { defaultTactics } from '../src/shared/teams';
import {
  aiPenalty, habitEdge, habitStreak, matchPressure, nerveError, ratingError, ringShake, setPieceRatings, shakyRing, shootoutPressure, shootoutWinnerOf,
} from '../src/shared/setpieces';
import type { InputEvent, MatchConfig, MatchEvent, RestartType, TeamIndex } from '../src/shared/types';

type Internals = {
  award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void;
  startShootout(): void;
  penRetake: unknown;
  knuckle: unknown;
};
const I = (m: Match) => m as unknown as Internals;
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = []) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev });
function open(seed = 5, over: Partial<MatchConfig> = {}) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, ...over }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.ctrl[0].autoSwitch = false;
  return m;
}
const penSpot = (m: Match, team: TeamIndex) => ({ x: m.attackDir(team) * (PITCH.halfLength - PITCH.penaltySpot), z: 0 });

describe('set-piece ratings and takers', () => {
  it('every player has penalty, free-kick and nerve ratings; keepers are poor takers', () => {
    const m = open();
    for (const p of m.players) {
      const r = setPieceRatings(p.def);
      for (const v of [r.pen, r.fk, r.comp]) { expect(v).toBeGreaterThanOrEqual(25); expect(v).toBeLessThanOrEqual(96); }
    }
    const gk = m.keeper(0), st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    expect(setPieceRatings(gk.def).pen).toBeLessThan(setPieceRatings(st.def).pen);
    // A better taker misses by less; nerves only matter under pressure, and less for a composed one.
    expect(ratingError(90)).toBeLessThan(ratingError(40));
    expect(nerveError(0, 40)).toBe(1);
    expect(nerveError(0.8, 40)).toBeGreaterThan(nerveError(0.8, 90));
  });
  it('the chosen penalty, free-kick and corner takers step up', () => {
    const m = open(7);
    const lb = m.teamPlayers(0).find((p) => p.role === 'LB')!;
    const cb = m.teamPlayers(0).find((p) => p.role.includes('CB'))!;
    const rb = m.teamPlayers(0).find((p) => p.role === 'RB')!;
    m.cfg.tactics = [{ ...defaultTactics(), takers: { pen: lb.def.name, fk: cb.def.name, corner: rb.def.name } }, defaultTactics()];
    I(m).award('penalty', 0, penSpot(m, 0));
    expect(m.restart!.taker).toBe(lb.id);
    I(m).award('freekick', 0, { x: m.attackDir(0) * (PITCH.halfLength - 24), z: 6 });
    expect(m.restart!.taker).toBe(cb.id);
    I(m).award('corner', 0, { x: m.attackDir(0) * PITCH.halfLength, z: PITCH.halfWidth });
    expect(m.restart!.taker).toBe(rb.id);
  });
  it('with no chosen taker the best penalty taker takes it', () => {
    const m = open(8);
    I(m).award('penalty', 0, penSpot(m, 0));
    const best = Math.max(...m.teamPlayers(0).map((p) => setPieceRatings(p.def).pen));
    expect(setPieceRatings(m.players[m.restart!.taker].def).pen).toBe(best);
  });
});

describe('pressure', () => {
  it('rises late in a close game and in a shootout', () => {
    const base = { cfg: {}, half: 1, clock: 600, score: [0, 0] as [number, number], shootout: null };
    const early = matchPressure(base, 0);
    const late = matchPressure({ ...base, half: 2, clock: 40 * 60 }, 0);
    const blowout = matchPressure({ ...base, half: 2, clock: 40 * 60, score: [4, 0] }, 0);
    expect(late).toBeGreaterThan(early);
    expect(blowout).toBeLessThan(late);
    expect(matchPressure({ ...base, cfg: { practice: 'pens' } }, 0)).toBe(0);
    // Sudden death, and a kick that decides it, weigh more than the first kick.
    const first = shootoutPressure([[], []], 0);
    const sudden = shootoutPressure([[true, true, true, true, true], [true, true, true, true, true]], 0);
    expect(sudden).toBeGreaterThan(first);
  });
  it('the timing ring only shakes under real pressure, and less for a composed taker', () => {
    expect(ringShake(0.3, 40)).toBe(0);
    expect(ringShake(0.8, 40)).toBeGreaterThan(ringShake(0.8, 90));
    for (const t of [0, 0.3, 0.7, 1.1]) expect(shakyRing(t, 0)).toBeCloseTo(timingRing(t), 6);
    let moved = 0;
    for (let t = 0; t < 1.4; t += 0.05) if (Math.abs(shakyRing(t, 0.8) - timingRing(t)) > 0.02) moved++;
    expect(moved).toBeGreaterThan(5);
  });
});

describe('penalty techniques and habits', () => {
  it('the computer mixes its techniques: mostly placed or normal, a few blasts, very few Panenkas', () => {
    const rng = new Rng(3);
    const n: Record<string, number> = {};
    let stutters = 0;
    for (let i = 0; i < 2000; i++) { const a = aiPenalty(rng, { pen: 80, fk: 70, comp: 85 }); n[a.tech] = (n[a.tech] ?? 0) + 1; if (a.stutter) stutters++; }
    expect((n.placed ?? 0) + (n.normal ?? 0)).toBeGreaterThan(1200);
    expect(n.blast ?? 0).toBeGreaterThan(100);
    expect(n.panenka ?? 0).toBeGreaterThan(5);
    expect(n.panenka ?? 0).toBeLessThan(200);
    expect(stutters).toBeGreaterThan(100);
    // A nervous taker never tries a Panenka.
    const r2 = new Rng(4);
    for (let i = 0; i < 500; i++) expect(aiPenalty(r2, { pen: 60, fk: 50, comp: 40 }).tech).not.toBe('panenka');
  });
  it('a streak to one side is noticed, and helps the keeper guess', () => {
    expect(habitStreak([1, 1, 1])).toEqual({ side: 1, n: 3 });
    expect(habitStreak([-1, 1, 1]).n).toBe(2);
    const m = { penHistory: [[1, 1, 1, 1], []] as [number[], number[]] };
    const gk = { team: 1, a: { goalkeeping: 0.8 } };
    expect(habitEdge(m, gk, 1)).toBeGreaterThan(0);
    expect(habitEdge(m, gk, -1)).toBeLessThan(0);
    expect(Math.abs(habitEdge(m, gk, 1))).toBeLessThanOrEqual(0.2);
  });
  it('a chipped human penalty is a Panenka', () => {
    const m = open(12);
    I(m).award('penalty', 0, penSpot(m, 0));
    for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
    for (let i = 0; i < 30; i++) { input(m, 0); m.step(); }
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.5, v: 'chip' }]);
    m.step();
    for (let i = 0; i < 200 && m.penKickTime <= 0; i++) { input(m, 0); m.step(); }
    expect(m.penTech).toBe('panenka');
    expect(Math.hypot(m.ball.vel.x, m.ball.vel.z)).toBeLessThan(16);
  });
  it('the skill button puts a stutter in the run-up', () => {
    const m = open(13);
    I(m).award('penalty', 0, penSpot(m, 0));
    for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
    input(m, 0, 0, 0, [{ k: 'skill' }]); m.step();
    expect(m.restart!.stutter).toBe(true);
  });
});

describe('penalty keeper duel', () => {
  it('a human facing a penalty is given his keeper', () => {
    const m = new Match(defaultConfig({ humans: [false, true], realMinutes: 6, seed: 21 }));
    m.phase = 'play';
    I(m).award('penalty', 0, penSpot(m, 0));
    expect(m.ctrl[1].pid).toBe(m.keeper(1).id);
    expect(m.restart!.gk).toBeTruthy();
  });
  /** Scripted human keeper; returns how many of n penalties were scored. */
  function duel(n: number, mode: 'right' | 'wrong' | 'early') {
    let goals = 0, retakes = 0;
    for (let i = 0; i < n; i++) {
      const m = new Match(defaultConfig({ humans: [false, true], realMinutes: 6, seed: 7000 + i }));
      m.phase = 'play';
      I(m).award('penalty', 0, penSpot(m, 0));
      const g0 = m.score[0];
      let committed = false, struck = -1;
      for (let t = 0; t < 60 * 14; t++) {
        const r = m.restart;
        if (r?.ready && !committed && r.runup && r.runup.t > (mode === 'early' ? 0 : 0.3)) {
          const s = Math.sign(r.runup.req.target?.z ?? 0) || 1;
          input(m, 1, 0, mode === 'wrong' ? -s : s, [{ k: 'shoot', p: 0.4 }]);
          committed = true;
        }
        m.step();
        if (struck < 0 && m.penKickTime > 0) { struck = m.time; if (I(m).penRetake) retakes++; }
        if (struck >= 0 && (m.score[0] !== g0 || m.time - struck > 3 || m.ball.state === 'held' || m.restart)) break;
      }
      if (m.score[0] !== g0) goals++;
    }
    return { goals, retakes };
  }
  it('guessing the right way saves far more than guessing wrong; going early gets read and risks a retake', () => {
    const right = duel(16, 'right'), wrong = duel(16, 'wrong'), early = duel(8, 'early');
    expect(right.goals).toBeLessThan(wrong.goals - 4);
    expect(early.retakes).toBeGreaterThan(0);
  });
});

describe('free kicks', () => {
  const fkSpot = (m: Match) => ({ x: m.attackDir(0) * (PITCH.halfLength - 24), z: 3 });
  it('a power-shot free kick over a wall is a knuckleball that wobbles both ways', () => {
    const m = open(31);
    I(m).award('freekick', 0, fkSpot(m));
    for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
    for (let i = 0; i < 20; i++) { input(m, 0); m.step(); }
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.8, v: 'power' }]);
    m.step();
    const spins: number[] = [];
    let seen = false;
    for (let i = 0; i < 300; i++) {
      input(m, 0); m.step();
      if (I(m).knuckle) { seen = true; spins.push(m.ball.spin ?? 0); } else if (seen) break;
    }
    expect(seen).toBe(true);
    expect(spins.some((s) => s > 0.5)).toBe(true);
    expect(spins.some((s) => s < -0.5)).toBe(true);
  });
  it('a wall with a man lying behind it names him and his spot', () => {
    const m = open(32);
    I(m).award('freekick', 0, fkSpot(m));
    const r = m.restart!;
    r.wall = { n: 4, shift: 0, lie: true };
    const w = wallFor(m, r)!;
    expect(w.lier).toBeGreaterThanOrEqual(0);
    expect(w.ids).not.toContain(w.lier);
    expect(Math.hypot(w.lieSpot!.x - r.spot.x, w.lieSpot!.z - r.spot.z)).toBeGreaterThan(Math.hypot(w.centre.x - r.spot.x, w.centre.z - r.spot.z));
  });
  it('a computer wall creeps in while a human waits; the referee pushes it back, then books someone', () => {
    const m = open(33);
    I(m).award('freekick', 0, fkSpot(m));
    const ev: MatchEvent[] = [];
    for (let i = 0; i < 60 * 12 && m.restart; i++) { input(m, 0); m.step(); ev.push(...m.drainEvents()); }
    const backs = ev.filter((e) => e.type === 'call' && e.text === 'wallback');
    expect(backs.length).toBeGreaterThanOrEqual(2);
    expect(ev.some((e) => e.type === 'card' && e.team === 1)).toBe(true);
  });
});

describe('shootout and snapshot', () => {
  it('a shootout lines both teams up on the halfway line with the taker walking up', () => {
    const m = open(41);
    m.phase = 'play';
    I(m).startShootout();
    for (let i = 0; i < 120; i++) m.step();
    const r = m.restart!;
    const gkIn = m.keeper((1 - r.team) as TeamIndex);
    const line = m.players.filter((p) => p.id !== r.taker && p.id !== gkIn.id && p.role !== 'GK');
    const near = line.filter((p) => Math.abs(p.pos.x) < 3 && Math.abs(p.pos.z) < 9);
    expect(near.length).toBeGreaterThan(line.length * 0.8);
    expect(shootoutWinnerOf([[true, true, true], [false, false, false]])).toBe(0);
    expect(shootoutWinnerOf([[true], [false]])).toBe(-1);
  });
  it('the ring shake, a stutter and the keeper commit go out in the snapshot', () => {
    const m = open(42);
    I(m).award('penalty', 0, penSpot(m, 0));
    const r = m.restart!;
    r.shake = 0.5; r.stutter = true; r.gk = { shift: 0, dance: 0, commit: { side: -1, t: 0 } };
    const s = encodeSnapshot(m, 0, [], false);
    const a = s.r as number[];
    expect(a[12]).toBeCloseTo(0.5, 2);
    expect(a[13]).toBe(1);
    expect(a[14]).toBe(1);
  });
});
