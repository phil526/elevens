import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { acceptOffer, endProSeason, newPro, proNext, proOverall, proTeam, recordProMatch, seasonDone, spendPoint, xpFor } from '../src/shared/pro';
import { ROLES, setSquadOverrides, clearSquadOverrides, teamById } from '../src/shared/teams';
import type { InputFrame } from '../src/shared/types';
import { toOpenPlay } from './helpers';

const look = { skin: 0xc68a5f, hair: 0x1c1410, foot: 'R' as const, number: 21 };

describe('Be a Pro', () => {
  it('keeps control on the locked player all match, including when teammates get the ball', () => {
    const m = new Match(defaultConfig({ humans: [true, false], lock: [6, -1], realMinutes: 2, seed: 11 }));
    const pro = 6;
    toOpenPlay(m);
    let teammateOnBall = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const f: InputFrame = { seq: i + 1, mx: 0, mz: 0, sprint: false, jockey: false, ev: i % 120 === 0 ? [{ k: 'switch' }] : [] };
      m.applyInput(0, f);
      m.step();
      if (m.phase === 'play' || m.phase === 'restart') expect(m.ctrl[0].pid).toBe(pro);
      const o = m.ball.owner;
      if (o >= 0 && o !== pro && m.players[o].team === 0) teammateOnBall++;
    }
    // His teammates had the ball and the computer played it for them.
    expect(teammateOnBall).toBeGreaterThan(30);
  });

  it('calling for the ball makes the carrier pass to you', () => {
    const m = new Match(defaultConfig({ humans: [true, false], lock: [9, -1], realMinutes: 2, seed: 4 }));
    toOpenPlay(m);
    const pro = m.players[9];
    const mate = m.players[6];
    // Give the ball to a teammate with nobody near.
    for (const p of m.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: 40, z: 30 };
    mate.pos = { x: 5, z: 0 }; pro.pos = { x: 20, z: 5 };
    m.ball.pos = { x: 5.5, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 }; m.ball.state = 'dribble'; m.ball.owner = mate.id; mate.action = { type: 'none', t: 0, dur: 0 };
    m.applyInput(0, { seq: 1, mx: 0, mz: 0, sprint: false, jockey: false, ev: [{ k: 'pass', p: 0.5 }] });
    m.step();
    expect(mate.action.type).toBe('kick');
    expect(mate.action.receiver).toBe(pro.id);
    let got = false;
    for (let i = 0; i < 240 && !got; i++) { m.applyInput(0, { seq: i + 2, mx: 0, mz: 0, sprint: false, jockey: false, ev: [] }); m.step(); got = m.ball.owner === pro.id; }
    expect(got).toBe(true);
  });

  it('puts the pro in his club and grows him with experience', () => {
    const p = newPro('Sam Rivers', 'ST', 'northgate', 5, look);
    const t = proTeam(p);
    expect(t.players[ROLES.indexOf('ST')].name).toBe('Sam Rivers');
    setSquadOverrides([t]);
    expect(teamById('northgate').players[9].name).toBe('Sam Rivers');
    clearSquadOverrides();
    expect(xpFor({ rating: 8.5, goals: 2, assists: 1, motm: true, result: 'W' })).toBeGreaterThan(xpFor({ rating: 6, goals: 0, assists: 0, motm: false, result: 'L' }));
    const o0 = proOverall(p);
    let n = 0;
    while (!seasonDone(p) && n++ < 20) recordProMatch(p, { rating: 8, goals: 1, assists: 1, motm: true, gf: 2, ga: 0, oppName: teamById(proNext(p)!.opp).name });
    expect(p.level).toBeGreaterThan(3);
    for (const k of ['shooting', 'control', 'pace', 'acceleration', 'passing'] as const) while (p.points > 0 && spendPoint(p, k));
    expect(proOverall(p)).toBeGreaterThan(o0 + 5);
    const s = endProSeason(p);
    expect(s.apps).toBe(11);
    expect(p.season).toBe(2);
    expect(proNext(p)).not.toBeNull();
    if (p.offer) { acceptOffer(p); expect(p.club).not.toBe('northgate'); }
  });
});
