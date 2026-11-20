// The animation gap pack (20 Nov 2026, "Build all the animations"): overhead kicks, scissor volleys
// and diving headers, the body feint and the Berba and McGeady spins, backpedalling and
// side-stepping, keeper punches, fingertip, foot and star saves, injuries and limping, the
// officials on the pitch and the pre-match huddle.
import { describe, expect, it } from 'vitest';
import { AERIAL7, Match, SKILL7, defaultConfig } from '../src/shared/match';
import { SKILLS } from '../src/shared/snapshot';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import type { InputEvent, Player } from '../src/shared/types';
import {
  airKickFor, backpedalPose, divingHeaderPose, injuredPose, limpPose, moveDirFor, overheadPose, punchPose, quickSaveFor,
  quickSavePose, scissorPose, sidestepPose, skill7Pose,
} from '../src/client/render/moves7';
import { assistantX, refereeColour, refereeSpot, OFFICIALS } from '../src/client/render/officials';
import { reactionPose } from '../src/client/render/reactions';
import { OFFICIALS_LINE_X, PREMATCH, PREMATCH_LENGTH, huddleSpot, lineSpot, preStage, stagePrematch } from '../src/client/render/prematch';
import * as P from '../src/client/render/player';
import type { ViewState } from '../src/client/view';
import type { Kit } from '../src/shared/teams';
import { aiMatch, clearArea, toOpenPlay } from './helpers';

let seq = 1;
const freeze = (m: Match, p: Player) => { p.action = { type: 'none', t: 0, dur: 0 }; p.aiNextDecision = m.time + 30; p.aiTarget = { ...p.pos }; };
const giveBall = (m: Match, p: Player) => { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.4, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.4 }; };

/** Team 0 human, our striker 38 m up the pitch with the ball in the air coming at him. */
function aerial(seed = 5) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 1500 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  const dir = m.attackDir(0);
  p.pos = { x: dir * 38, z: 2 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') { o.pos = { x: -dir * 20, z: o.pos.z }; o.vel = { x: 0, z: 0 }; }
  const mate = m.teamPlayers(0).find((x) => x.role === 'LW')!;
  for (const t of m.teamPlayers(0)) if (t !== p && t.role !== 'GK') { t.pos = { x: -dir * 10, z: t.pos.z }; t.vel = { x: 0, z: 0 }; }
  m.ball.owner = -1; m.ball.state = 'flight'; m.ball.flight = 'cross'; m.ball.receiver = -1; m.ball.lastTouch = mate.id; m.ball.lastTouchTeam = 0; m.ball.kicker = -1; m.ball.kickLock = 0;
  m.offside.flagged.clear();
  return { m, p, dir };
}
function play(m: Match, ev: InputEvent, mx: number, mz: number, sprint = false) {
  const events: { type: string; text?: string }[] = [];
  m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [ev] });
  for (let i = 0; i < 25; i++) {
    m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [] });
    m.step();
    events.push(...m.drainEvents());
    if (m.ball.kicker !== -1) break;
  }
  return events;
}

describe('overhead kicks and diving headers', () => {
  it('a shot as a high ball arrives with the back to goal is an overhead kick', () => {
    let n = 0;
    for (const seed of [5, 6, 7, 8]) {
      const { m, p, dir } = aerial(seed);
      p.facing = dir > 0 ? Math.PI : 0; // back to goal
      m.ball.pos = { x: p.pos.x, y: 2.0, z: p.pos.z + 4 };
      m.ball.vel = { x: 0, y: 1.6, z: -12 };
      const ev = play(m, { k: 'shoot', p: 0.6 }, 0, 0);
      if (ev.some((e) => e.type === 'kick' && e.text === 'overhead')) {
        n++;
        expect(m.ball.flight).toBe('shot');
        expect(m.ball.vel.x * dir).toBeGreaterThan(0); // goes back over his head, towards goal
      }
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('facing the goal the same ball is headed as before, not an overhead', () => {
    const { m, p } = aerial(5);
    m.ball.pos = { x: p.pos.x, y: 2.0, z: p.pos.z + 4 };
    m.ball.vel = { x: 0, y: 1.6, z: -12 };
    const ev = play(m, { k: 'shoot', p: 0.6 }, 0, 0);
    expect(ev.some((e) => e.type === 'kick' && e.text === 'overhead')).toBe(false);
  });

  it('a shot at full tilt onto a low cross near goal is a diving header', () => {
    let n = 0;
    for (const seed of [5, 6, 7, 8]) {
      const { m, p } = aerial(seed);
      p.vel = { x: 0, z: 6 };
      p.facing = Math.PI / 2;
      m.ball.pos = { x: p.pos.x, y: 0.75, z: p.pos.z + 4 };
      m.ball.vel = { x: 0, y: 0.6, z: -11 };
      const ev = play(m, { k: 'shoot', p: 0.6 }, 0, 1, true);
      if (ev.some((e) => e.type === 'kick' && e.text === 'header') && p.action.type === 'header' && p.action.dur === AERIAL7.diveTime) n++;
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('air kick styles: overhead for a high ball behind, scissor for a waist-high ball across', () => {
    expect(airKickFor(1.8, Math.PI)).toBe('overhead');
    expect(airKickFor(1.1, 1.3)).toBe('scissor');
    expect(airKickFor(1.1, 0.2)).toBeNull();
    expect(airKickFor(0.3, Math.PI)).toBeNull();
  });

  it('the poses leave the ground and fall back', () => {
    const X = new Float32Array(17);
    overheadPose(X, 0.3, 1);
    expect(X[P.BY]).toBeGreaterThan(0.2);
    X.fill(0); scissorPose(X, 0.3, 1, 1);
    expect(X[P.BY]).toBeGreaterThan(0.1);
    X.fill(0); const shift = divingHeaderPose(X, 0.4);
    expect(shift).toBeLessThan(0);
    expect(X[P.BRX]).toBeGreaterThan(0.6); // body flat out forwards
  });
});

describe('body feint, Berba and McGeady spins', () => {
  function carrier(human: boolean, seed = 31) {
    const m = human ? new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed })) : aiMatch({ seed });
    toOpenPlay(m);
    clearArea(m, 0, 0, 12);
    const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.skillCd = 0;
    freeze(m, p);
    giveBall(m, p);
    if (human) { m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false; }
    return { m, p };
  }
  it('modifier diagonals: forward is a Berba spin, back is a McGeady spin; straight ones are unchanged', () => {
    const cases = [[0.7, 0.7, 'berba'], [-0.7, 0.7, 'mcgeady'], [1, 0, 'elastico'], [-1, 0, 'dragturn'], [0, 1, 'ballroll']] as const;
    for (const [dx, dz, move] of cases) {
      const { m, p } = carrier(false);
      expect(m.startSkill(p, dx, dz, false, true)).toBe(move);
      expect(SKILLS).toContain(move);
    }
  });
  it('sideways at full speed a human drops the shoulder; the AI does its old step-over', () => {
    const h = carrier(true);
    h.p.vel = { x: 6, z: 0 };
    expect(h.m.startSkill(h.p, 0, 1)).toBe('bodyfeint');
    const a = carrier(false);
    a.p.vel = { x: 6, z: 0 };
    expect(a.m.startSkill(a.p, 0, 1)).not.toBe('bodyfeint');
  });
  it('each move keeps the ball and comes out going the new way', () => {
    for (const [dx, dz, move] of [[0.7, 0.7, 'berba'], [-0.7, 0.7, 'mcgeady']] as const) {
      const { m, p } = carrier(false, 33);
      m.startSkill(p, dx, dz, false, true);
      const dur = SKILL7.time[move];
      for (let i = 0; i < Math.ceil(dur * 60) + 6; i++) { p.aiNextDecision = m.time + 30; m.step(); }
      expect(m.ball.owner).toBe(p.id);
      expect(Math.abs(p.pos.z)).toBeGreaterThan(0.25); // broke off sideways
    }
    const { m, p } = carrier(true, 34);
    p.vel = { x: 6, z: 0 };
    m.startSkill(p, 0, 1);
    for (let i = 0; i < Math.ceil(SKILL7.time.bodyfeint * 60) + 6; i++) { m.applyInput(0, { seq: seq++, mx: 0, mz: 1, sprint: true, jockey: false, contain: false, ev: [] }); m.step(); }
    expect(m.ball.owner).toBe(p.id);
    expect(p.vel.z).toBeGreaterThan(1.5);
  });
  it('snapshots carry the new moves and which way they go', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(14);
    expect(SKILLS.length).toBeLessThanOrEqual(32); // 5 bits, the side bit is 32
    for (const mv of ['bodyfeint', 'berba', 'mcgeady'] as const) {
      const X = new Float32Array(17);
      for (const u of [0, 0.3, 0.6, 0.95]) { skill7Pose(X, mv, u, 1); for (const v of X) expect(Number.isFinite(v)).toBe(true); }
    }
  });
});

describe('backpedal, side-step, injuries', () => {
  it('works out backwards and sideways movement relative to facing', () => {
    expect(moveDirFor(0, -3, 0).back).toBeGreaterThan(0.9);
    expect(moveDirFor(0, 3, 0).back).toBe(0);
    const s = moveDirFor(0, 0, 3);
    expect(s.side).toBeGreaterThan(0.9);
    expect(moveDirFor(0, 0, -3).dir).toBe(-s.dir);
  });
  it('backpedal stays over the toes, side-step spreads the legs, injured lies then sits up, limp favours one leg', () => {
    const X = new Float32Array(17);
    backpedalPose(X, 0.5, 1);
    expect(X[P.SPX]).toBeGreaterThan(0.1); // weight forward over the toes
    X.fill(0); sidestepPose(X, Math.PI / 2, 1, 1);
    expect(Math.abs(X[P.HLZ]) + Math.abs(X[P.HRZ])).toBeGreaterThan(0.1);
    X.fill(0); injuredPose(X, 1, 0);
    expect(X[P.BRX]).toBeLessThan(-1.2); // flat on his back
    X.fill(0); injuredPose(X, 1, 1);
    expect(X[P.BRX]).toBeGreaterThan(-0.8); // sitting up for the physio
    X.fill(0); limpPose(X, 0.3, 1);
    for (const v of X) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('keeper saves', () => {
  it('star block up close, foot save for a low shot just wide of him, a normal dive otherwise', () => {
    expect(quickSaveFor(6, 1.0, 1.0)).toBe('star');
    expect(quickSaveFor(12, 0.8, 0.15)).toBe('foot');
    expect(quickSaveFor(20, 3, 0.4)).toBeNull();
  });
  it('punch reaches high, the star save spreads arms and legs', () => {
    const X = new Float32Array(17);
    punchPose(X, 2.2, 0.5);
    expect(Math.min(X[P.SLX], X[P.SRX])).toBeLessThan(-2);
    X.fill(0); quickSavePose(X, 'star', 0.2, 1);
    expect(Math.abs(X[P.SLZ]) + Math.abs(X[P.SRZ])).toBeGreaterThan(1);
  });
});

describe('officials', () => {
  const view = (ball: { x: number; z: number }, attackDir: [number, number], xs0: number[], xs1: number[]) => ({
    ball: { pos: { x: ball.x, y: 0.11, z: ball.z } }, attackDir,
    players: [...xs0.map((x) => ({ team: 0, off: false, pos: { x, z: 0 } })), ...xs1.map((x) => ({ team: 1, off: false, pos: { x, z: 0 } }))],
  }) as unknown as ViewState;

  it('the referee keeps 9-16 m from the ball wherever it is, on the pitch', () => {
    for (const [bx, bz] of [[0, 0], [40, 20], [-50, -30], [10, -5], [-30, 25]]) {
      const s = refereeSpot(bx, bz);
      const d = Math.hypot(s.x - bx, s.z - bz);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(48);
      expect(Math.abs(s.z)).toBeLessThanOrEqual(31);
      if (Math.abs(bx) < 40 && Math.abs(bz) < 22) { expect(d).toBeGreaterThanOrEqual(OFFICIALS.refMin - 0.01); expect(d).toBeLessThanOrEqual(OFFICIALS.refMax + 0.01); }
    }
  });
  it('an assistant is level with the second-last defender, never past halfway', () => {
    // Team 1 defends the +x end (team 0 attacks +x).
    const v = view({ x: 5, z: 0 }, [1, -1], [0, 10], [50, 30, 20, 10]);
    expect(assistantX(v, 1)).toBe(30);
    // Ball nearer the goal line than the defender: the ball.
    const w = view({ x: 40, z: 0 }, [1, -1], [0], [50, 30, 20]);
    expect(assistantX(w, 1)).toBe(40);
    // Everyone in the other half: halfway.
    const h = view({ x: -20, z: 0 }, [1, -1], [-30], [50, -5, -10]);
    expect(assistantX(h, 1)).toBe(0);
  });
  it('the referee wears a colour well away from both kits', () => {
    const kit = (shirt: number): Kit => ({ shirt, sleeves: shirt, shorts: 0xffffff, socks: shirt, number: 0xffffff, keeper: 0x22aa22, pattern: 'plain' } as Kit);
    expect(refereeColour([kit(0x101114), kit(0xf3e21a)])).not.toBe(0x101114);
    expect(refereeColour([kit(0xd01020), kit(0x1030c0)])).toBe(0x101114);
  });
  it('signals have their own poses: card up high, flag up, advantage both arms forward', () => {
    const X = new Float32Array(17);
    reactionPose('refCard', 0.5, 0.3, X);
    expect(X[P.SRX]).toBeLessThan(-2.2);
    X.fill(0); reactionPose('flagUp', 0.5, 0.3, X);
    expect(X[P.SRX]).toBeLessThan(-2.2);
    X.fill(0); reactionPose('refAdvantage', 0.5, 0.3, X);
    expect(X[P.SLX]).toBeLessThan(-0.8);
    expect(X[P.SRX]).toBeLessThan(-0.8);
  });
});

describe('pre-match line-up and huddle', () => {
  function liveView(): ViewState {
    const m = aiMatch({ seed: 3 });
    const players = m.players.map((p) => ({ id: p.id, team: p.team, role: p.role, def: p.def, pos: { ...p.pos }, vel: { x: 0, z: 0 }, facing: 0, stamina: 1, sprinting: false, jockeying: false, cards: 0, off: false, action: { type: 'none', t: 0, dur: 0 } }));
    return { players, ball: { pos: { x: 0, y: 0.11, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1 }, humans: [false, false], restart: null } as unknown as ViewState;
  }
  it('leaves room in the middle of the line for the referee and his assistants', () => {
    const inner = Math.min(Math.abs(lineSpot(0, 0).x), Math.abs(lineSpot(1, 0).x));
    for (const x of OFFICIALS_LINE_X) expect(inner - Math.abs(x)).toBeGreaterThan(0.6);
  });
  it('ends with each team in a ring in its own half, everyone facing the middle, arms round each other', () => {
    expect(preStage(PREMATCH_LENGTH - 0.1).stage).toBe('huddle');
    const v = stagePrematch(liveView(), PREMATCH_LENGTH - PREMATCH.huddle + 0.5);
    for (const p of v.players) {
      if (p.off) continue;
      const cx = (p.team === 0 ? -1 : 1) * PREMATCH.huddleX;
      expect(Math.hypot(p.pos.x - cx, p.pos.z)).toBeCloseTo(PREMATCH.huddleR, 5);
      const toMid = Math.atan2(-p.pos.z, cx - p.pos.x);
      expect(Math.cos(toMid - p.facing)).toBeGreaterThan(0.999);
    }
    expect(huddleSpot(0, 0, 11).x).toBeLessThan(0);
    const X = new Float32Array(17);
    reactionPose('teamHuddle', 1, 0.2, X);
    expect(X[P.SPX]).toBeGreaterThan(0.3); // leaning in
    expect(X[P.SLZ]).toBeGreaterThan(0.8); // arm out round the next man
  });
});

describe('captured limp and backwards walk (20 Nov 2026)', () => {
  it('the backwards walk plays slow backpedals, the procedural steps fast ones', async () => {
    const { backwalkShare, gaitClipWeights } = await import('../src/client/render/realplayer');
    expect(backwalkShare(1, 1.5)).toBe(1);
    expect(backwalkShare(1, 3.1)).toBeGreaterThan(0.2);
    expect(backwalkShare(1, 3.1)).toBeLessThan(0.8);
    expect(backwalkShare(1, 4)).toBe(0);
    expect(backwalkShare(0, 1.5)).toBe(0);
    // Standing still plays neither gait.
    expect(gaitClipWeights(1, 1, 0)).toEqual({ backwalk: 0, limp: 0 });
    // A knocked player limps at walking pace, less at a jog, not at all when sprinting.
    expect(gaitClipWeights(0, 1, 1.5).limp).toBe(1);
    expect(gaitClipWeights(0, 1, 3.4).limp).toBeLessThan(0.7);
    expect(gaitClipWeights(0, 1, 6).limp).toBe(0);
    // A light knock is a partial limp; backpedalling takes over from it.
    expect(gaitClipWeights(0, 0.3, 1.5).limp).toBeCloseTo(0.48, 2);
    expect(gaitClipWeights(1, 1, 1.5)).toEqual({ backwalk: 1, limp: 0 });
  });
});
