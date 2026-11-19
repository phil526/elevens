// The ten gameplay additions of 19 Nov 2026: shot types, new skill moves, physical duels, club
// playing styles, keeper positioning, free-kick curve and dip, tactical fouls, scrambles,
// home crowd momentum and manual shooting.
import { describe, expect, it } from 'vitest';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { playerBuild } from '../src/client/render/look';
import { flyTo } from '../src/shared/ball';
import { PITCH } from '../src/shared/config';
import { manualShotAim, solveShot } from '../src/shared/kick';
import { Match, defaultConfig, kickStyle } from '../src/shared/match';
import { MOMENTUM, Momentum } from '../src/shared/momentum';
import { aerialWin, buildOf, holdOffChance, strengthOf } from '../src/shared/physical';
import { applyPlayStyle, CLUB_STYLES, clubStyle, PLAY_STYLES, styleBias, styleForClub, styleOf } from '../src/shared/playstyle';
import { parseClientMsg } from '../src/shared/protocol';
import { Rng } from '../src/shared/rng';
import { encodeSnapshot, SKILLS } from '../src/shared/snapshot';
import { ALL_CLUBS } from '../src/shared/teams';
import { keeperSpot } from '../src/shared/ai/keeper';
import { MENTALITY } from '../src/shared/config';
import type { InputEvent, MatchEvent, Player, RestartType, TeamIndex } from '../src/shared/types';
import { aiMatch, clearArea, toOpenPlay } from './helpers';

type Internals = {
  award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void;
};
const I = (m: Match) => m as unknown as Internals;
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = [], extra: { jockey?: boolean; sprint?: boolean } = {}) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: !!extra.sprint, jockey: !!extra.jockey, ev });
const humanMatch = (seed = 5) => new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
const giveBall = (m: Match, p: Player) => { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.4, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.4 }; };
const freeze = (m: Match, p: Player) => { p.action = { type: 'none', t: 0, dur: 0 }; p.aiNextDecision = m.time + 30; p.aiTarget = { ...p.pos }; };

class Fake implements InputSource {
  device = 'gamepad' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() { this.s = emptyRaw(); }
}
const ATT = { attacking: true };

describe('shot types', () => {
  it('the modifier is a finesse shot, modifier + sprint a power shot, and the switch button during a charge a placed shot', () => {
    const fin = new Fake(); const a = new ActionLayer([fin]);
    fin.s.jockey = true; fin.s.shoot = true; a.sample(0, ATT);
    expect(a.charging(200)?.label).toBe('FINESSE');
    fin.s.shoot = false;
    expect(a.sample(200, ATT).ev[0]).toMatchObject({ k: 'shoot', m: true });

    const pw = new Fake(); const b = new ActionLayer([pw]);
    pw.s.jockey = true; pw.s.sprint = true; pw.s.shoot = true; b.sample(0, ATT);
    expect(b.charging(200)?.label).toBe('POWER SHOT');
    pw.s.shoot = false;
    expect(b.sample(200, ATT).ev[0]).toMatchObject({ k: 'shoot', v: 'power' });

    const pl = new Fake(); const c = new ActionLayer([pl]);
    pl.s.shoot = true; c.sample(0, ATT);
    pl.s.switch = true;
    const mid = c.sample(16, ATT).ev;
    expect(mid.some((e) => e.k === 'switch')).toBe(false); // picks the shot type, no switch or called run
    expect(c.charging(200)?.label).toBe('PLACED');
    pl.s.shoot = false; pl.s.switch = false;
    expect(c.sample(200, ATT).ev[0]).toMatchObject({ k: 'shoot', v: 'placed' });
  });

  it('kick styles map to shot variants, and manual shooting is passed through', () => {
    expect(kickStyle({ k: 'shoot', p: 0.5, m: true })).toMatchObject({ variant: 'finesse' });
    expect(kickStyle({ k: 'shoot', p: 0.5, v: 'power', m: true })).toMatchObject({ variant: 'power' });
    expect(kickStyle({ k: 'shoot', p: 0.5, v: 'placed' })).toMatchObject({ variant: 'placed' });
    expect(kickStyle({ k: 'shoot', p: 0.5, a: 2 })).toMatchObject({ assist: 2 });
    const ok = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'shoot', p: 0.5, v: 'power' }, { k: 'shoot', p: 0.5, v: 'placed' }] }] }));
    expect(ok).not.toBeNull();
  });

  it('power shots are fastest and wildest, placed shots slowest and tightest', () => {
    const m = aiMatch({ seed: 4 });
    const k = m.teamPlayers(0).find((x) => x.role === 'ST')!;
    k.pos = { x: PITCH.halfLength - 20, z: 0 }; k.vel = { x: 0, z: 0 }; k.facing = 0;
    const ballPos = { x: k.pos.x + 0.4, y: 0.11, z: 0 };
    const stats = (style: 'power' | 'placed' | 'finesse') => {
      let sp = 0; const zs: number[] = [];
      for (let s = 1; s <= 60; s++) {
        const r = solveShot({ kicker: k, ballPos, pressure: 0, rng: new Rng(s) }, { side: 1, aimZ: 0, power: 0.7, placed: false, style });
        sp += Math.hypot(r.vel.x, r.vel.z, r.vel.y);
        zs.push(Math.atan2(r.vel.z, r.vel.x));
      }
      const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
      return { speed: sp / 60, spread: Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length) };
    };
    const pw = stats('power'), pl = stats('placed'), fn = stats('finesse');
    expect(pw.speed).toBeGreaterThan(fn.speed + 2);
    expect(pl.speed).toBeLessThan(fn.speed);
    expect(pw.spread).toBeGreaterThan(pl.spread * 1.5);
  });

  it('manual shooting aims exactly where the stick points, so it can miss', () => {
    const m = aiMatch({ seed: 4 });
    const k = m.teamPlayers(0).find((x) => x.role === 'ST')!;
    k.pos = { x: PITCH.halfLength - 16, z: 0 };
    expect(Math.abs(manualShotAim(k, 1, 1, 0))).toBeLessThan(0.5); // straight at goal
    expect(manualShotAim(k, 1, 0.6, 0.8)).toBeGreaterThan(PITCH.goalHalfWidth); // wide of the post
  });
});

describe('new skill moves', () => {
  function carrier(seed = 31) {
    const m = aiMatch({ seed });
    toOpenPlay(m);
    clearArea(m, 0, 0, 12);
    const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.skillCd = 0;
    p.a = { ...p.a, control: 0.95 };
    freeze(m, p);
    giveBall(m, p);
    return { m, p };
  }
  it('with the modifier: forward elastico, sideways ball roll, back drag-back turn', () => {
    for (const [dx, dz, move] of [[1, 0, 'elastico'], [0, 1, 'ballroll'], [-1, 0, 'dragturn']] as const) {
      const { m, p } = carrier();
      expect(m.startSkill(p, dx, dz, false, true)).toBe(move);
      expect(SKILLS).toContain(move);
    }
  });
  it('the ball roll carries the ball sideways and the drag-back turn ends facing the other way', () => {
    const { m, p } = carrier();
    m.startSkill(p, 0, 1, false, true);
    for (let i = 0; i < 40; i++) { p.aiNextDecision = m.time + 30; m.step(); }
    expect(Math.abs(p.pos.z)).toBeGreaterThan(0.3);
    const t = carrier(32);
    t.m.startSkill(t.p, -1, 0, false, true);
    for (let i = 0; i < 45; i++) { t.p.aiNextDecision = t.m.time + 30; t.m.step(); }
    expect(Math.cos(t.p.facing)).toBeLessThan(-0.3);
  });
  it('step-overs chain: up to three, each to the other side', () => {
    const { m, p } = carrier();
    expect(m.startSkill(p, 0, 1)).toBe('stepover');
    const s1 = p.action.side;
    for (let i = 0; i < 15; i++) m.step();
    expect(m.startSkill(p, 0, 1)).toBe('stepover');
    expect(p.action.side).toBe(-(s1 ?? 1));
    expect(p.action.chain).toBe(1);
  });
});

describe('physical duels', () => {
  it('the sim uses the same build the renderer draws', () => {
    for (const t of ALL_CLUBS) for (const d of t.players) expect(buildOf(d)).toEqual(playerBuild(d));
  });
  it('a stronger, fresher player holds off a slighter, tired one; height wins headers', () => {
    const m = aiMatch({ seed: 2 });
    const cb = m.teamPlayers(0).find((p) => p.role === 'RCB')!;
    const w = m.teamPlayers(1).find((p) => p.role === 'LW')!;
    expect(strengthOf(cb)).toBeGreaterThan(strengthOf(w));
    expect(holdOffChance(cb, w)).toBeGreaterThan(holdOffChance(w, cb));
    const tired = strengthOf(w);
    w.stamina = 0.2;
    expect(strengthOf(w)).toBeLessThan(tired);
    expect(aerialWin(cb, w, 0.5, 0.5)).toBeGreaterThan(0.5);
    expect(aerialWin(cb, w, 1.2, 0.2)).toBeLessThan(aerialWin(cb, w, 0.5, 0.5)); // closer to the ball helps
  });
});

describe('club playing styles', () => {
  it('every built-in club has a style, and styles change the team shape', () => {
    for (const t of ALL_CLUBS) expect(PLAY_STYLES).toContain(CLUB_STYLES[t.id]);
    expect(new Set(Object.values(CLUB_STYLES)).size).toBe(5);
    const base = MENTALITY.balanced;
    expect(applyPlayStyle(base, 'counter').lineOffset).toBeLessThan(base.lineOffset);
    expect(applyPlayStyle(base, 'press').lineOffset).toBeGreaterThan(base.lineOffset);
    expect(applyPlayStyle(base, 'balanced')).toEqual(base);
  });
  it('custom clubs follow their description; human sides have no style', () => {
    expect(styleForClub({ id: 'custom-1', style: 'Patient: they keep the ball' })).toBe('possession');
    expect(styleForClub({ id: 'custom-2', style: 'Sits deep and breaks fast' })).toBe('counter');
    expect(clubStyle('nope', 'defence')).toBe('longball');
    const m = humanMatch();
    expect(styleOf(m, 0)).toBeNull();
    expect(styleOf(m, 1)).toBe(CLUB_STYLES[m.teams[1].id]);
  });
  it('the ball carrier leans the way the club plays', () => {
    expect(styleBias('longball', 'lob', 1, 35, false)).toBeGreaterThan(0.3);
    expect(styleBias('possession', 'lob', 1, 35, false)).toBeLessThan(0);
    expect(styleBias('counter', 'through', 1, 25, true)).toBeGreaterThan(styleBias('counter', 'through', 1, 25, false));
  });
});

describe('keeper positioning', () => {
  it('comes off the line to narrow the angle against a central carrier, and guards the near post from wide', () => {
    const m = aiMatch({ seed: 3 });
    const gk = m.teamPlayers(1).find((p) => p.role === 'GK')!;
    const side = Math.sign(m.ownGoalX(1));
    const gx = side * PITCH.halfLength;
    const st = m.teamPlayers(0).find((p) => p.role === 'ST')!;
    m.takePossession(st, true);
    m.ball.pos = { x: gx - side * 35, y: 0.11, z: 0 };
    const far = keeperSpot(m, gk, side, 1);
    m.ball.pos = { x: gx - side * 14, y: 0.11, z: 0 };
    const near = keeperSpot(m, gk, side, 1);
    expect(Math.abs(gx - near.x)).toBeGreaterThan(Math.abs(gx - far.x));
    m.ball.pos = { x: gx - side * 5, y: 0.11, z: 15 };
    const wide = keeperSpot(m, gk, side, 1);
    expect(wide.z).toBeGreaterThan(PITCH.goalHalfWidth - 1.2);
    expect(Math.abs(gx - wide.x)).toBeLessThan(1.6);
  });
});

describe('free-kick curve and dip', () => {
  it('holding the modifier, the stick across bends it and towards goal adds dip; the shot carries both', () => {
    const m = humanMatch(8);
    const dir = m.attackDir(0);
    I(m).award('freekick', 0, { x: dir * (PITCH.halfLength - 24), z: 2 });
    for (let i = 0; i < 400 && !m.restart!.ready; i++) m.step();
    const r = m.restart!;
    expect(r.ready).toBe(true);
    const aim0 = { ...r.aim };
    for (let i = 0; i < 25; i++) { input(m, 0, 0, dir, [], { jockey: true }); m.step(); }
    expect(Math.abs(r.curve ?? 0)).toBeGreaterThan(0.3);
    for (let i = 0; i < 25; i++) { input(m, 0, dir, 0, [], { jockey: true }); m.step(); }
    expect(r.dip ?? 0).toBeGreaterThan(0.3);
    expect(r.aim).toEqual(aim0); // the target stays put while bending
    const snap = encodeSnapshot(m, 0, [], false);
    expect((snap.r as number[])[10]).toBeCloseTo(r.curve!, 1);
    expect((snap.r as number[])[11]).toBeCloseTo(r.dip!, 1);
    input(m, 0, 0, 0, [{ k: 'shoot', p: 0.7 }]);
    let spin = 0, dip = 0;
    for (let i = 0; i < 200 && m.ball.state !== 'flight'; i++) { m.step(); input(m, 0); }
    spin = m.ball.spin; dip = m.ball.dip ?? 0;
    expect(Math.abs(spin)).toBeGreaterThan(2);
    expect(dip).toBeGreaterThan(1);
  });
  it('dip brings the ball down sooner', () => {
    expect(flyTo(24, 6, 0.11, undefined, 8).dist).toBeLessThan(flyTo(24, 6, 0.11).dist - 2);
    expect(flyTo(24, 6, 0.11, 22, 8).y).toBeLessThan(flyTo(24, 6, 0.11, 22).y - 0.5);
  });
});

describe('tactical fouls', () => {
  it('the modifier + lob near a carrier is a foul with no advantage, and usually a booking', () => {
    let fouls = 0, yellows = 0, calls = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const m = humanMatch(seed);
      toOpenPlay(m);
      clearArea(m, 0, 0, 15);
      const goalX = m.ownGoalX(0);
      const c = m.teamPlayers(1).find((p) => p.role === 'RCM')!;
      c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; c.facing = goalX > 0 ? 0 : Math.PI;
      freeze(m, c);
      giveBall(m, c);
      m.wonBallAt[1] = m.time; // a fresh break
      const me = m.teamPlayers(0).find((p) => p.role === 'LCB')!;
      me.pos = { x: -Math.sign(goalX) * 0.8, z: 0.9 }; me.vel = { x: 0, z: 0 };
      me.action = { type: 'none', t: 0, dur: 0 }; me.tackleCooldown = 0;
      m.ctrl[0].pid = me.id; m.ctrl[0].autoSwitch = false;
      m.drainEvents();
      input(m, 0, 0, 0, [{ k: 'lob', m: true }], { jockey: true });
      const evs: MatchEvent[] = [];
      for (let i = 0; i < 40; i++) { m.step(); input(m, 0); evs.push(...m.drainEvents()); }
      if (evs.some((e) => e.type === 'call' && e.text === 'tactical')) calls++;
      if (evs.some((e) => e.type === 'foul')) fouls++;
      if (evs.some((e) => e.type === 'card' && e.text === 'yellow')) yellows++;
      expect(evs.some((e) => e.type === 'advantage')).toBe(false);
    }
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(fouls).toBe(calls);
    expect(yellows).toBeGreaterThanOrEqual(8);
  });
});

describe('home crowd momentum', () => {
  it('pressure swings it towards the side on top; it drifts back to level; a lift only for the home side on top', () => {
    const mo = new Momentum();
    for (let i = 0; i < 6; i++) mo.push(0, MOMENTUM.shot);
    expect(mo.value).toBeGreaterThan(0.2);
    mo.push(0, MOMENTUM.goal);
    expect(mo.lift()).toBeGreaterThan(0);
    expect(mo.kickError(0)).toBeLessThan(1);
    expect(mo.kickError(1)).toBeGreaterThan(1);
    expect(mo.staminaDrain(0)).toBeLessThan(1);
    expect(mo.staminaDrain(1)).toBe(1);
    const v = mo.value;
    for (let i = 0; i < 60 * 20; i++) mo.step(1 / 60);
    expect(mo.value).toBeLessThan(v * 0.5);
    const away = new Momentum();
    for (let i = 0; i < 10; i++) away.push(1, MOMENTUM.shot);
    expect(away.value).toBeLessThan(0);
    expect(away.lift()).toBe(0);
    const off = new Momentum(false);
    off.push(0, 1);
    expect(off.value).toBe(0);
    expect(off.kickError(0)).toBe(1);
  });
  it('the setting turns it off, practice never has it, and the snapshot carries it', () => {
    expect(aiMatch({ momentum: false }).momentum.on).toBe(false);
    const m = aiMatch({ seed: 9 });
    expect(m.momentum.on).toBe(true);
    m.momentum.value = 0.5;
    expect(encodeSnapshot(m, 0, [], false).mo).toBe(0.5);
  });
});

describe('scrambles and deflections', () => {
  it('AI matches have deflections and goalmouth scrambles', () => {
    const m = aiMatch({ seed: 21, realMinutes: 4 });
    const seen = new Set<string>();
    while (m.phase !== 'fulltime') {
      m.step();
      if (m.phase === 'halftime') m.continueAfterHalftime();
      for (const e of m.drainEvents()) if (e.type === 'call' && e.text) seen.add(e.text);
    }
    expect(seen.has('scramble')).toBe(true);
  });
});
