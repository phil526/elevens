// 20 Nov 2026: better automatic player switching (human control only). Stick carried over after a
// switch, no switch mid-challenge, steadier switching, quick presses cycle, set-piece defender, the
// pass read as it is wound up, players near the ball preferred, flash events, styles and
// sensitivity, crosses. Computer sides never use any of it.
import { afterEach, describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { encodeSnapshot } from '../src/shared/snapshot';
import { parseClientMsg } from '../src/shared/protocol';
import { SW, SWITCH } from '../src/shared/switches';
import type { MatchEvent, Player, SwitchSens, SwitchStyle } from '../src/shared/types';

let seq = 1;
type Ev = { k: 'pass' | 'lob' | 'through' | 'switch'; p?: number };
const input = (m: Match, mx = 0, mz = 0, ev: Ev[] = [], o: { sprint?: boolean; jockey?: boolean; contain?: boolean } = {}) =>
  m.applyInput(0, { seq: seq++, mx, mz, sprint: !!o.sprint, jockey: !!o.jockey, contain: !!o.contain, ev: ev.map((e) => ({ k: e.k, p: e.p ?? 0 })) });

function match(seed = 7, style: SwitchStyle = 'full', sens: SwitchSens = 'normal') {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, switchStyle: [style, style], switchSens: [sens, sens] }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.drainEvents();
  return m;
}
const role = (m: Match, team: number, r: string) => m.teamPlayers(team).find((p) => p.role === r)!;
/** Place a player in team 0's frame (team 0 attacks +x; our goal is at fx -52.5). */
function put(m: Match, p: Player, fx: number, fz: number, vx = 0, vz = 0) {
  const dir = m.attackDir(0);
  p.pos = { x: fx * dir, z: fz * dir }; p.vel = { x: vx * dir, z: vz * dir };
  p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  p.beaten = 0;
}
const fx = (m: Match, p: { x: number }) => p.x * m.attackDir(0);
function give(m: Match, p: Player) {
  const b = m.ball;
  b.owner = p.id; b.state = 'dribble'; b.flight = 'none'; b.receiver = -1; b.lastTouch = p.id; b.lastTouchTeam = p.team;
  b.pos = { x: p.pos.x, y: 0.11, z: p.pos.z }; b.vel = { x: 0, y: 0, z: 0 };
  m.possessionStart = m.time;
}
/** Team 0 defending deep, team 1 attacking. */
function defending(m: Match) {
  const spots: Record<string, [number, number]> = { GK: [-51, 0], RB: [-38, 20], LB: [-38, -20], RCB: [-40, 6], LCB: [-40, -6], CDM: [-30, 0], RCM: [-24, 10], LCM: [-24, -10], RW: [-8, 24], LW: [-8, -24], ST: [-2, 0] };
  for (const p of m.teamPlayers(0)) { const s = spots[p.role]; put(m, p, s[0], s[1]); }
  const att: Record<string, [number, number]> = { GK: [50, 0], RB: [5, -20], LB: [5, 20], RCB: [10, -6], LCB: [10, 6], CDM: [-10, 0], RCM: [-20, -10], LCM: [-20, 10], RW: [-30, -22], LW: [-30, 22], ST: [-30, 0] };
  for (const o of m.teamPlayers(1)) { const s = att[o.role]; put(m, o, s[0], s[1]); }
}
/** Hold a team-1 carrier still with the ball (the AI would otherwise pass, shoot or dribble). */
let frozen: { m: Match; p: Player; fx: number; fz: number } | null = null;
function freeze(m: Match, p: Player, fxp: number, fzp: number) {
  put(m, p, fxp, fzp);
  give(m, p);
  frozen = { m, p, fx: fxp, fz: fzp };
}
/** One tick with the frozen carrier put back on the ball first. */
function step(m: Match) {
  if (frozen && frozen.m === m && m.phase === 'play') {
    const { p } = frozen;
    if (p.action.type !== 'kick') { put(m, p, frozen.fx, frozen.fz); give(m, p); p.aiNextDecision = m.time + 1; }
    // Our computer-run players don't win the ball meanwhile (that would hand you the winner).
    for (const q of m.teamPlayers(0)) if (q.id !== m.ctrl[0].pid) q.tackleCooldown = 1;
  }
  m.step();
}
const events = (m: Match): MatchEvent[] => m.drainEvents();

afterEach(() => { frozen = null; for (const k of Object.keys(SW)) (SW as Record<string, boolean>)[k] = true; });

/**
 * A carrier dribbling at our box with the human's man (CDM) left far behind, so a switch to a
 * centre-back is due. Returns the match with control on the CDM and the carrier.
 */
function beatenScene(seed = 7, style: SwitchStyle = 'full', sens: SwitchSens = 'normal') {
  const m = match(seed, style, sens);
  defending(m);
  const car = role(m, 1, 'ST');
  freeze(m, car, -22, 0);
  const h = role(m, 0, 'ST');
  put(m, h, -10, 4);
  m.ctrl[0].pid = h.id;
  m.ctrl[0].lastAutoSwitch = -10;
  return { m, car, h };
}

describe('steadier switching', () => {
  it('a better defender must stay better for a moment before control moves', () => {
    const { m, h } = beatenScene();
    input(m); step(m);
    expect(m.ctrl[0].pid).toBe(h.id); // not on the first tick
    let at = -1;
    for (let i = 1; i < 60 && at < 0; i++) { input(m); step(m); if (m.ctrl[0].pid !== h.id) at = i; }
    expect(at).toBeGreaterThan(0);
  });
  it('the next-switch marker stays on its man unless another is clearly better', () => {
    const { m } = beatenScene();
    input(m); step(m);
    const first = m.ctrl[0].next;
    let changes = 0, prev = first;
    for (let i = 0; i < 20; i++) { input(m); step(m); if (m.ctrl[0].next !== prev) { changes++; prev = m.ctrl[0].next; } }
    expect(changes).toBeLessThanOrEqual(2);
  });
});

describe('stick carried over after a switch', () => {
  /** Holding the stick back towards our goal (the new man would run away from the ball), press switch, then hold `after`. */
  const run = (after: [number, number]) => {
    const { m, h, car } = beatenScene();
    const dir = m.attackDir(0);
    input(m, -dir, 0); step(m);
    input(m, -dir, 0, [{ k: 'switch' }]); step(m);
    const p = m.players[m.ctrl[0].pid];
    expect(p.id).not.toBe(h.id);
    const d0 = Math.hypot(p.pos.x - car.pos.x, p.pos.z - car.pos.z);
    for (let i = 0; i < 45; i++) { input(m, after[0] * dir, after[1] * dir); step(m); }
    return { m, p, d0, d1: Math.hypot(p.pos.x - car.pos.x, p.pos.z - car.pos.z) };
  };
  it('the new man closes down the ball while the old stick is still held, and a new stick steers him', () => {
    const held = run([-1, 0]);
    expect(held.d0).toBeGreaterThan(3);
    expect(held.d1).toBeLessThan(held.d0 - 1); // went at the ball, not back towards goal
    const turned = run([0, 1]);
    expect(turned.p.vel.z * turned.m.attackDir(0)).toBeGreaterThan(1); // a fresh direction (across) is obeyed
  });
  it('with the carry switch off, the held stick sends the new man the wrong way', () => {
    SW.carry = false;
    const r = run([-1, 0]);
    expect(r.d1).toBeGreaterThan(r.d0);
  });
  it('online: the snapshot says while the server is ignoring the stick', () => {
    const { m } = beatenScene();
    const dir = m.attackDir(0);
    input(m, dir, 0); step(m);
    input(m, dir, 0, [{ k: 'switch' }]); step(m);
    expect(encodeSnapshot(m, 0, [], false).ca?.[0]).toBe(1);
    input(m, 0, 0); step(m);
    expect(encodeSnapshot(m, 0, [], false).ca).toBeUndefined();
  });
});

describe('no switch mid-challenge', () => {
  it('after a tackle press, control stays for a moment even though a better man exists', () => {
    const { m, h } = beatenScene();
    input(m, 0, 0, [{ k: 'pass' }]);
    step(m);
    for (let i = 0; i < Math.floor(SWITCH.guardAfter * 60) - 4; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).toBe(h.id);
    for (let i = 0; i < 40; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).not.toBe(h.id);
  });
  it('holding jockey keeps your man where the plain rule would switch', () => {
    const scene = (jockey: boolean) => {
      const m = match();
      defending(m);
      const car = role(m, 1, 'ST');
      freeze(m, car, -22, 0);
      const h = role(m, 0, 'RCM');
      const cdm = role(m, 0, 'CDM');
      put(m, cdm, -28, 0);
      // Your man wide of the ball, about 1.5 s worse placed than the CDM (between the plain and the jockey bars).
      const E = m.engagePoint(0);
      let z = 6;
      for (; z < 30; z += 0.5) { put(m, h, -25, z); if (m.engageTime(h, E) - m.engageTime(cdm, E) > 1.5) break; }
      m.ctrl[0].pid = h.id; m.ctrl[0].lastAutoSwitch = -10;
      for (let i = 0; i < 40; i++) { put(m, h, -25, z); input(m, 0, 0, [], { jockey }); step(m); }
      return m.ctrl[0].pid === h.id;
    };
    expect(scene(false)).toBe(false);
    expect(scene(true)).toBe(true);
  });
});

describe('quick presses cycle', () => {
  it('two quick presses visit two different players and never flick back', () => {
    const { m, h } = beatenScene();
    input(m); step(m);
    input(m, 0, 0, [{ k: 'switch' }]); step(m);
    const a = m.ctrl[0].pid;
    for (let i = 0; i < 10; i++) { input(m); step(m); }
    input(m, 0, 0, [{ k: 'switch' }]); step(m);
    const b = m.ctrl[0].pid;
    expect(a).not.toBe(h.id);
    expect(b).not.toBe(a);
    expect(b).not.toBe(h.id);
  });
  it('a single press takes the man under the marker', () => {
    const { m } = beatenScene();
    input(m); step(m);
    const marked = m.ctrl[0].next;
    input(m, 0, 0, [{ k: 'switch' }]); step(m);
    expect(m.ctrl[0].pid).toBe(marked);
  });
  it('switch events say how the switch happened (for the flash and sound)', () => {
    const { m } = beatenScene();
    events(m);
    input(m, 0, 0, [{ k: 'switch' }]); step(m);
    expect(events(m).find((e) => e.type === 'switch')?.text).toBe('manual');
    m.ctrl[0].pid = role(m, 0, 'ST').id; put(m, role(m, 0, 'ST'), -12, 4); m.ctrl[0].lastAutoSwitch = -10; m.ctrl[0].lastManual = -10;
    let t: string | undefined;
    for (let i = 0; i < 60 && !t; i++) { input(m); step(m); t = events(m).find((e) => e.type === 'switch')?.text; }
    expect(t).toBe('auto');
  });
});

describe('reading the next pass', () => {
  /** Team 1's LCM winds up a pass to their LW, wide on our right; the human is on our ST, upfield. */
  function windup(hPos: [number, number]) {
    const m = match();
    defending(m);
    const passer = role(m, 1, 'LCM');
    freeze(m, passer, -20, 10);
    const recv = role(m, 1, 'LW');
    put(m, recv, -32, 24);
    const h = role(m, 0, 'ST');
    put(m, h, hPos[0], hPos[1]);
    m.ctrl[0].pid = h.id; m.ctrl[0].lastAutoSwitch = -10;
    const dir = m.attackDir(0);
    m.startKick(passer, { kind: 'pass', power: 0.5, dir: { x: -12 * dir, z: 14 * dir }, receiver: recv.id, target: { x: recv.pos.x, y: 0, z: recv.pos.z } });
    return { m, passer, recv, h };
  }
  it('the marker moves to the defender nearest the receiver before the ball is struck', () => {
    const { m, recv } = windup([-8, -10]);
    input(m); step(m);
    expect(m.ball.state).toBe('dribble'); // not struck yet
    const nx = m.players[m.ctrl[0].next];
    const others = m.teamPlayers(0).filter((p) => p.role !== 'GK' && p.id !== m.ctrl[0].pid);
    const dn = Math.hypot(nx.pos.x - recv.pos.x, nx.pos.z - recv.pos.z);
    expect(others.filter((p) => Math.hypot(p.pos.x - recv.pos.x, p.pos.z - recv.pos.z) < dn - 3).length).toBe(0);
  });
  it('pressing the passer as he winds up, you are not switched away before the strike', () => {
    const { m, h, passer } = windup([-22, 8]);
    for (let i = 0; i < 40 && m.ball.state === 'dribble' && m.ball.owner === passer.id; i++) { input(m); step(m); expect(m.ctrl[0].pid).toBe(h.id); }
  });
});

describe('their set pieces', () => {
  function corner(style: SwitchStyle = 'full') {
    const m = match(7, style);
    const h = role(m, 0, 'ST');
    m.ctrl[0].pid = h.id;
    // A corner to team 1 at our end (team 0's goal line), near side +z.
    const gx = -52.5 * m.attackDir(0);
    (m as unknown as { award: (t: string, team: number, s: { x: number; z: number }) => void }).award('corner', 1, { x: gx, z: 33.5 });
    for (let i = 0; i < 900 && !m.restart?.ready; i++) { input(m); step(m); }
    return { m, h, gx };
  }
  it('at their corner you start on a defender in your box', () => {
    const { m, h, gx } = corner();
    const p = m.players[m.ctrl[0].pid];
    expect(p.id).not.toBe(h.id);
    expect(p.role).not.toBe('GK');
    expect(Math.abs(p.pos.x - gx)).toBeLessThan(16.5);
    expect(events(m).some((e) => e.type === 'switch' && e.text === 'setpiece')).toBe(true);
  });
  it('the switch button picks another defender while they set up', () => {
    const { m } = corner();
    const a = m.ctrl[0].pid;
    input(m, 0, 0, [{ k: 'switch' }]); step(m);
    const b = m.ctrl[0].pid;
    expect(b).not.toBe(a);
    expect(m.players[b].role).not.toBe('GK');
  });
  it('with auto-switch Off you stay on your man', () => {
    const { m, h } = corner('off');
    expect(m.ctrl[0].pid).toBe(h.id);
  });
});

describe('players near the ball preferred', () => {
  it('a man far up the pitch (likely off screen) only gets the pick when clearly better', () => {
    const m = match();
    defending(m);
    const car = role(m, 1, 'ST');
    freeze(m, car, -5, 0);
    // Our RW 32 m from the ball along the pitch but a touch quicker to it than the CDM.
    const rw = role(m, 0, 'RW');
    put(m, rw, 25, 4);
    const cdm = role(m, 0, 'CDM');
    put(m, cdm, -9 - 28, 0);
    const pick = () => m.bestSwitchCandidate(0, role(m, 0, 'LB').id);
    const withRule = pick();
    SW.onscreen = false;
    const without = pick();
    expect(withRule === rw.id).toBe(false);
    expect(typeof without).toBe('number');
  });
});

describe('styles and sensitivity', () => {
  it('Off never switches for you', () => {
    const { m, h } = beatenScene(7, 'off');
    for (let i = 0; i < 90; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).toBe(h.id);
  });
  it('High balls does not switch for a ball on the ground', () => {
    const { m, h } = beatenScene(7, 'air');
    for (let i = 0; i < 90; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).toBe(h.id);
  });
  it('Assisted switches when the ball has gone past your man', () => {
    const { m, h } = beatenScene(7, 'assisted');
    for (let i = 0; i < 90; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).not.toBe(h.id);
  });
  it('Assisted keeps you on a man still goal-side of the ball', () => {
    const m = match(7, 'assisted');
    defending(m);
    const car = role(m, 1, 'ST');
    freeze(m, car, -18, 0);
    const h = role(m, 0, 'RB');
    put(m, h, -38, 20); // goal-side, far from the ball
    m.ctrl[0].pid = h.id; m.ctrl[0].lastAutoSwitch = -10;
    for (let i = 0; i < 90; i++) { input(m); step(m); }
    expect(m.ctrl[0].pid).toBe(h.id);
  });
  it('Eager moves you sooner than Calm', () => {
    const when = (sens: SwitchSens) => {
      const { m, h } = beatenScene(7, 'full', sens);
      m.ctrl[0].lastAutoSwitch = m.time; // just switched: the cool-down decides
      for (let i = 0; i < 200; i++) { input(m); step(m); if (m.ctrl[0].pid !== h.id) return i; }
      return 999;
    };
    expect(when('eager')).toBeLessThan(when('calm'));
  });
});

describe('crosses', () => {
  it('a cross into the box switches early to the defender who meets it', () => {
    const m = match();
    defending(m);
    const crosser = role(m, 1, 'RW');
    put(m, crosser, -45, -30);
    const target = role(m, 1, 'ST');
    put(m, target, -44, 2);
    const h = role(m, 0, 'ST');
    put(m, h, -12, 4);
    m.ctrl[0].pid = h.id; m.ctrl[0].lastAutoSwitch = m.time - 0.5;
    const dir = m.attackDir(0), b = m.ball;
    b.owner = -1; b.state = 'flight'; b.flight = 'cross'; b.receiver = target.id; b.lastTouch = crosser.id; b.lastTouchTeam = 1; b.kicker = crosser.id; b.kickLock = 0.5;
    b.pos = { x: -45 * dir, y: 0.5, z: -30 * dir }; b.vel = { x: 1 * dir, y: 7, z: 20 * dir }; b.spin = 0;
    m.lastKickTime = m.time;
    let at = -1;
    for (let i = 0; i < 60 && at < 0; i++) { input(m); step(m); if (m.ctrl[0].pid !== h.id) at = i; }
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(20);
    const p = m.players[m.ctrl[0].pid];
    expect(Math.abs(fx(m, p.pos) + 52.5)).toBeLessThan(20); // a defender in or near the box
  });
});

describe('online', () => {
  it('the lobby message carries your style and sensitivity, and junk is ignored', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'lobby', ready: true, sw: ['air', 'eager'] }));
    expect(ok && ok.t === 'lobby' && ok.sw).toEqual(['air', 'eager']);
    const bad = parseClientMsg(JSON.stringify({ t: 'lobby', ready: true, sw: ['always', 'x'] }));
    expect(bad && bad.t === 'lobby' && bad.sw).toBeFalsy();
  });
});
