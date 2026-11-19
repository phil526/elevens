// Goalkeeper animations (19 Nov 2026): catch styles, dive kinds, the one-handed throw's wind-up
// in the simulation and the roll flag in online snapshots.
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { encodeSnapshot } from '../src/shared/snapshot';
import { handWindup } from '../src/shared/kick';
import type { Player } from '../src/shared/types';
import * as P from '../src/client/render/player';
import { CATCH_DUR, KP_CH, anticipatePose, catchPose, catchStyleFor, overarmPose, rollPose } from '../src/client/render/keeperpose';
import { diveKindFor } from '../src/client/render/realplayer';

describe('keeper poses', () => {
  it('uses the same pose channels as the solver', () => {
    for (const [k, v] of Object.entries(KP_CH)) expect((P as unknown as Record<string, number>)[k]).toBe(v);
  });
  it('picks the catch by the ball height (and smothers when coming out fast)', () => {
    expect(catchStyleFor(0.11, 8, 0)).toBe('scoop');
    expect(catchStyleFor(0.11, 18, 0)).toBe('kneel');
    expect(catchStyleFor(0.8, 15, 0)).toBe('waist');
    expect(catchStyleFor(1.3, 15, 0)).toBe('chest');
    expect(catchStyleFor(1.8, 15, 0)).toBe('head');
    expect(catchStyleFor(2.3, 10, 0)).toBe('high');
    expect(catchStyleFor(0.2, 5, 4)).toBe('smother');
  });
  it('every catch ends holding the ball at the chest, standing', () => {
    const end = new Float32Array(17);
    catchPose(end, 'chest', 1, 1);
    for (const s of Object.keys(CATCH_DUR) as (keyof typeof CATCH_DUR)[]) {
      const X = new Float32Array(17);
      catchPose(X, s, 1, 1);
      for (let c = 0; c < 16; c++) expect(X[c]).toBeCloseTo(end[c], 1);
    }
  });
  it('hands come up for a high ball and the keeper jumps into it', () => {
    const X = new Float32Array(17);
    anticipatePose(X, 'high', 1, 1);
    expect(X[KP_CH.BY]).toBeGreaterThan(0.3);
    expect(X[KP_CH.SLX]).toBeLessThan(-2.5);
  });
  it('throws one-handed: the right arm goes back then over the top, the left points the way', () => {
    const w = handWindup();
    const back = new Float32Array(17), rel = new Float32Array(17);
    overarmPose(back, w * 0.55, w);
    overarmPose(rel, w, w);
    expect(back[KP_CH.SRX]).toBeGreaterThan(0.6); // behind the body
    expect(back[KP_CH.SLX]).toBeLessThan(-1.4); // left arm pointing at the target
    expect(rel[KP_CH.SRX]).toBeGreaterThan(Math.PI); // over the top, in front of the head
    const roll = new Float32Array(17);
    rollPose(roll, handWindup('roll'), handWindup('roll'));
    expect(roll[KP_CH.BY]).toBeLessThan(-0.3); // crouched to bowl it along the grass
  });
  it('dives by where the save is', () => {
    expect(diveKindFor(1.0, 0.5)).toBe('collapse');
    expect(diveKindFor(2.4, 0.25)).toBe('low');
    expect(diveKindFor(2.4, 1.2)).toBe('full');
    expect(diveKindFor(2.6, 2.2)).toBe('high');
  });
});

describe('keeper throw in the simulation', () => {
  function holding(m: Match) {
    const gk = m.keeper(0);
    const dir = m.attackDir(0);
    gk.pos = { x: -dir * 48, z: 0 }; gk.vel = { x: 0, z: 0 };
    gk.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
    const b = m.ball;
    b.owner = gk.id; b.state = 'held'; b.flight = 'none'; b.lastTouch = gk.id; b.lastTouchTeam = 0;
    b.pos = { x: gk.pos.x, y: 1.15, z: 0 }; b.vel = { x: 0, y: 0, z: 0 };
    return gk;
  }
  it('winds up for longer than a pass and releases from the hand at the end of it', () => {
    for (const variant of [undefined, 'roll'] as const) {
      const m = new Match(defaultConfig({ humans: [false, false], seed: 4 }));
      for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
      const gk = holding(m);
      m.startKick(gk, { kind: 'throw', variant, power: 0.6, receiver: -1 }, true);
      expect(gk.action.windup).toBe(handWindup(variant));
      const enc = encodeSnapshot(m, 0, [], false);
      expect(((enc.p[gk.id * 11 + 9] as number) & 16) === 16).toBe(variant === 'roll');
      let rel = -1;
      for (let i = 0; i < 120; i++) { m.step(); if (m.ball.state !== 'held' && rel < 0) { rel = gk.action.t; break; } }
      expect(rel).toBeGreaterThan(handWindup(variant) - 0.02);
      expect(rel).toBeLessThan(handWindup(variant) + 0.05);
    }
  });
});

describe('keeper dives while play is stopped', () => {
  it('a keeper who dived for a ball that went behind gets up during the corner set-up (no frozen dive)', () => {
    const m = new Match(defaultConfig({ humans: [false, false], seed: 6 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const gk = m.keeper(1);
    const side = Math.sign(m.ownGoalX(1));
    gk.pos = { x: side * 51.5, z: 0 }; gk.vel = { x: 0, z: 0 };
    gk.action = { type: 'dive', t: 0.2, dur: 0.75, start: { ...gk.pos }, target: { x: side * 51.4, y: 1, z: 2.5 } } as Player['action'];
    // His parry goes behind for a corner.
    const b = m.ball;
    b.pos = { x: side * 51, y: 0.5, z: 6 }; b.vel = { x: side * 12, y: 0, z: 2 };
    b.state = 'free'; b.flight = 'deflect'; b.owner = -1; b.lastTouch = gk.id; b.lastTouchTeam = 1; b.kicker = gk.id; b.kickLock = 0.3;
    let i = 0;
    for (; i < 240 && m.phase === 'play'; i++) { m.step(); m.drainEvents(); }
    expect(m.phase).toBe('restart');
    expect(m.restart?.type).toBe('corner');
    expect(['dive', 'down']).toContain(gk.action.type);
    for (let k = 0; k < 120 * 1.5 && m.phase === 'restart'; k++) { m.step(); m.drainEvents(); }
    expect(gk.action.type).toBe('none');
  });
  it('a keeper who dived for a shot that went wide gets up before taking the goal kick', () => {
    const m = new Match(defaultConfig({ humans: [false, false], seed: 6 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const gk = m.keeper(1);
    const side = Math.sign(m.ownGoalX(1));
    gk.pos = { x: side * 51.5, z: 0 }; gk.vel = { x: 0, z: 0 };
    gk.action = { type: 'dive', t: 0.2, dur: 0.75, start: { ...gk.pos }, target: { x: side * 51.4, y: 1, z: 3.6 } } as Player['action'];
    const b = m.ball;
    const shooter = m.teamPlayers(0).find((p) => p.role !== 'GK')!;
    b.pos = { x: side * 51, y: 0.8, z: 5 }; b.vel = { x: side * 14, y: 0, z: 1 };
    b.state = 'flight'; b.flight = 'shot'; b.owner = -1; b.lastTouch = shooter.id; b.lastTouchTeam = 0; b.kicker = shooter.id; b.kickLock = 0.3;
    for (let i = 0; i < 240 && m.phase === 'play'; i++) { m.step(); m.drainEvents(); }
    expect(m.restart?.type).toBe('goalkick');
    const seen: string[] = [];
    for (let k = 0; k < 120 * 8 && m.phase === 'restart'; k++) { m.step(); m.drainEvents(); if (seen[seen.length - 1] !== gk.action.type) seen.push(gk.action.type); }
    expect(seen.indexOf('down')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('none')).toBeGreaterThan(seen.indexOf('down'));
    expect(m.phase).toBe('play');
  });
});
