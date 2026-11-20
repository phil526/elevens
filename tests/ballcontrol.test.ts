// Ball control (19 Nov 2026): close control, sole stop, chops, attribute dribbling, heavy touches,
// chest/thigh control into the stride, flick-ups, juggling and the flick over a defender.
import { describe, expect, it } from 'vitest';
import { BALLCTL } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import { dribbleTurn, jogSpeed } from '../src/shared/movement';
import { heavyChance } from '../src/shared/ballcontrol';
import { parseClientMsg } from '../src/shared/protocol';
import { encodeSnapshot, SKILLS } from '../src/shared/snapshot';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { cleanBindings, defaultBindings } from '../src/client/input/bindings';
import type { InputEvent, Player } from '../src/shared/types';
import { clearArea, toOpenPlay } from './helpers';

let seq = 1;
type Extra = { sprint?: boolean; jockey?: boolean; close?: boolean };
const input = (m: Match, mx = 0, mz = 0, ev: InputEvent[] = [], x: Extra = {}) =>
  m.applyInput(0, { seq: seq++, mx, mz, sprint: !!x.sprint, jockey: !!x.jockey, close: !!x.close, ev });
const freeze = (m: Match, p: Player) => { p.action = { type: 'none', t: 0, dur: 0 }; p.aiNextDecision = m.time + 30; p.aiTarget = { ...p.pos }; };

/** A human (team 0) striker on the ball at (0, 0), facing +x, nobody within 15 m. */
function carrier(seed = 31, control?: number) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  toOpenPlay(m);
  clearArea(m, 0, 0, 15);
  const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  if (control !== undefined) p.a = { ...p.a, control };
  p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.skillCd = 0; p.stamina = 1;
  freeze(m, p);
  m.takePossession(p, true);
  m.ball.pos = { x: 0.4, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  // Keep everyone else away for the length of a test.
  for (const o of m.players) if (o.id !== p.id) { o.pos = { x: o.pos.x, z: o.team ? 30 : -30 }; freeze(m, o); }
  return { m, p };
}
/** Run `n` ticks with this input, keeping the others out of the way. */
function run(m: Match, p: Player, n: number, mx: number, mz: number, x: Extra = {}, each?: () => void) {
  for (let i = 0; i < n; i++) {
    for (const o of m.players) if (o.id !== p.id && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < 12) o.pos = { x: o.pos.x, z: o.pos.z + (o.pos.z >= p.pos.z ? 15 : -15) };
    input(m, mx, mz, [], x);
    m.step(); m.drainEvents();
    each?.();
  }
}

describe('close control and slow dribbling', () => {
  it('close control: slow, the ball glued within a stride, and it stays his', () => {
    const { m, p } = carrier();
    let far = 0, top = 0;
    run(m, p, 150, 1, 0, { close: true }, () => { far = Math.max(far, Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z)); top = Math.max(top, Math.hypot(p.vel.x, p.vel.z)); });
    expect(m.ball.owner).toBe(p.id);
    expect(top).toBeLessThan(BALLCTL.closeSpeed * jogSpeed(p.a) * 1.02);
    expect(top).toBeGreaterThan(1.5);
    expect(far).toBeLessThan(0.75);
    // Without it he jogs faster and the ball runs further ahead.
    const b = carrier();
    let far2 = 0, top2 = 0;
    run(b.m, b.p, 150, 1, 0, {}, () => { far2 = Math.max(far2, Math.hypot(b.m.ball.pos.x - b.p.pos.x, b.m.ball.pos.z - b.p.pos.z)); top2 = Math.max(top2, Math.hypot(b.p.vel.x, b.p.vel.z)); });
    expect(top2).toBeGreaterThan(top * 1.6);
    expect(far2).toBeGreaterThan(far);
  });

  it('close control turns tighter', () => {
    const turnAfter = (close: boolean) => {
      const { m, p } = carrier();
      run(m, p, 90, 1, 0, { close });
      run(m, p, 5, 0, 1, { close });
      return Math.atan2(p.vel.z, p.vel.x);
    };
    expect(turnAfter(true)).toBeGreaterThan(turnAfter(false));
  });

  it('gentle stick pressure is a slow jog with the ball kept closer', () => {
    const sample = (mag: number) => {
      const { m, p } = carrier();
      let far = 0;
      run(m, p, 60, mag, 0);
      run(m, p, 120, mag, 0, {}, () => { far = Math.max(far, Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z)); });
      return { far, sp: Math.hypot(p.vel.x, p.vel.z), own: m.ball.owner === p.id };
    };
    const soft = sample(0.45), full = sample(1);
    expect(soft.own).toBe(true);
    expect(soft.sp).toBeLessThan(full.sp * 0.6);
    expect(soft.far).toBeLessThan(full.far);
  });

  it('a defender finds it harder to nick the ball off close control', () => {
    // Same carrier, same challenger, many tries: count steals with and without close control held.
    const steals = (close: boolean) => {
      let n = 0;
      for (let s = 0; s < 40; s++) {
        const { m, p } = carrier(100 + s);
        const o = m.teamPlayers(1).find((q) => q.role === 'RCB')!;
        run(m, p, 30, 1, 0, { close });
        o.pos = { x: p.pos.x + 1.6, z: p.pos.z + 0.3 }; o.vel = { x: -2, z: 0 }; freeze(m, o);
        for (let i = 0; i < 40; i++) { input(m, 1, 0, [], { close }); m.step(); m.drainEvents(); }
        if (m.ball.owner !== p.id) n++;
      }
      return n;
    };
    expect(steals(true)).toBeLessThan(steals(false));
  });
});

describe('sole stop, chops and cut-backs', () => {
  it('close control and the stick let go: the ball stops under the sole, then a push of the stick bursts away', () => {
    const { m, p } = carrier();
    run(m, p, 60, 1, 0, { close: true });
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeGreaterThan(BALLCTL.soleMinSpeed);
    input(m, 0, 0, [], { close: true }); m.step(); m.drainEvents();
    expect(p.action.skill).toBe('solestop');
    run(m, p, 20, 0, 0, { close: true });
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeLessThan(0.6);
    expect(Math.hypot(m.ball.vel.x, m.ball.vel.z)).toBeLessThan(0.6);
    expect(Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z)).toBeLessThan(0.5);
    input(m, 0, 1, []); m.step(); m.drainEvents();
    expect(p.burst).toBeGreaterThan(0.3);
    expect(m.ball.vel.z).toBeGreaterThan(2);
    run(m, p, 40, 0, 1, { sprint: true });
    expect(m.ball.owner).toBe(p.id);
  });

  it('a defender chasing the carrier can overrun a sole stop', () => {
    let beaten = 0;
    for (let s = 0; s < 30; s++) {
      const { m, p } = carrier(200 + s);
      run(m, p, 60, 1, 0, { close: true });
      const o = m.teamPlayers(1).find((q) => q.role === 'LCB')!;
      o.pos = { x: p.pos.x - 1.2, z: p.pos.z + 0.8 }; o.vel = { x: 5, z: 0 }; o.action = { type: 'none', t: 0, dur: 0 }; o.beaten = 0;
      input(m, 0, 0, [], { close: true }); m.step();
      if (m.drainEvents().some((e) => e.type === 'call' && e.text === 'beat')) beaten++;
    }
    expect(beaten).toBeGreaterThan(3);
  });

  it('a sharp turn while sprinting is a chop onto the new line; reversing is a cut-back', () => {
    const { m, p } = carrier(41, 0.85);
    run(m, p, 70, 1, 0, { sprint: true });
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeGreaterThan(0.8 * jogSpeed(p.a));
    input(m, 0, 1, [], { sprint: true }); m.step();
    const ev = m.drainEvents();
    expect(p.action.skill).toBe('chop');
    expect(ev.some((e) => e.type === 'skill' && e.text === 'chop')).toBe(true);
    expect(m.ball.vel.z).toBeGreaterThan(Math.abs(m.ball.vel.x));
    run(m, p, 40, 0, 1, { sprint: true });
    expect(m.ball.owner).toBe(p.id);
    expect(p.vel.z).toBeGreaterThan(3);

    const c = carrier(42, 0.85);
    run(c.m, c.p, 70, 1, 0, { sprint: true });
    input(c.m, -1, 0.05, [], { sprint: true }); c.m.step();
    expect(c.p.action.skill).toBe('cutback');
    run(c.m, c.p, 60, -1, 0, { sprint: true });
    expect(c.m.ball.owner).toBe(c.p.id);
    expect(c.p.vel.x).toBeLessThan(-2);
  });

  it('no chop without sprint, or for a gentle change of direction', () => {
    const { m, p } = carrier();
    run(m, p, 70, 1, 0, { sprint: true });
    input(m, 1, 0.6, [], { sprint: true }); m.step(); // about 31 degrees
    expect(p.action.type).toBe('none');
    const b = carrier();
    run(b.m, b.p, 70, 1, 0);
    input(b.m, 0, 1, []); b.m.step();
    expect(b.p.action.type).toBe('none');
  });
});

describe('dribbling by control, and heavy touches', () => {
  it('better control turns tighter; the average player is unchanged', () => {
    const a = (control: number) => ({ pace: 0.7, acceleration: 0.7, stamina: 0.7, control, passing: 0.7, shooting: 0.7, tackling: 0.7, goalkeeping: 0.1 });
    expect(dribbleTurn(a(0.86), false)).toBeGreaterThan(dribbleTurn(a(0.55), false));
    expect(dribbleTurn(a(0.86), true)).toBeGreaterThan(dribbleTurn(a(0.55), true));
    expect(dribbleTurn(a(0.7), false)).toBeCloseTo(1.3, 5);
    expect(dribbleTurn(a(0.7), true)).toBeCloseTo(1, 5);
    expect(dribbleTurn(a(0.7), false, true)).toBeGreaterThan(dribbleTurn(a(0.86), false));
  });

  it('heavy touches: never for good control, likelier under pressure and on a wet pitch', () => {
    const { m, p } = carrier();
    p.a = { ...p.a, control: 0.85 };
    expect(heavyChance(m, p, { sprinting: true })).toBe(0);
    p.a = { ...p.a, control: 0.55 };
    const calm = heavyChance(m, p, { sprinting: false });
    const o = m.teamPlayers(1).find((q) => q.role === 'RCB')!;
    o.pos = { x: p.pos.x + 1, z: p.pos.z };
    const pressed = heavyChance(m, p, { sprinting: false });
    expect(pressed).toBeGreaterThan(calm);
    expect(pressed).toBeLessThanOrEqual(BALLCTL.heavyMax);
    const wet = new Match(defaultConfig({ humans: [true, false], weather: { kind: 'rain', wind: 0, windDir: 0 }, seed: 3 }));
    const q = wet.teamPlayers(0).find((x) => x.role === 'ST')!;
    q.a = { ...q.a, control: 0.55 };
    wet.ctrl[0].pid = -1; // not the human's man: no help
    for (const x of wet.players) if (x.team === 1) x.pos = { x: 40, z: 30 };
    expect(heavyChance(wet, q, { sprinting: false })).toBeGreaterThan(0);
  });

  it('a weak first touch under pressure sometimes bounces away', () => {
    let heavy = 0;
    for (let s = 0; s < 40; s++) {
      const m = new Match(defaultConfig({ humans: [false, false], seed: 300 + s }));
      toOpenPlay(m);
      clearArea(m, 0, 0, 15);
      const p = m.teamPlayers(0).find((q) => q.role === 'CDM')!;
      p.a = { ...p.a, control: 0.5 };
      p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; freeze(m, p);
      const o = m.teamPlayers(1).find((q) => q.role === 'ST')!;
      o.pos = { x: 1, z: 0.4 }; freeze(m, o);
      m.ball.pos = { x: -10, y: 0.11, z: 0 }; m.ball.vel = { x: 16, y: 0, z: 0 };
      m.ball.state = 'flight'; m.ball.flight = 'pass'; m.ball.owner = -1; m.ball.lastTouch = -1; m.ball.lastTouchTeam = 0; m.ball.kicker = -1; m.ball.receiver = p.id;
      p.touchCooldown = 0; p.contestCooldown = 0;
      m.takePossession(p, false);
      if (m.drainEvents().some((e) => e.type === 'call' && e.text === 'heavy')) heavy++;
    }
    expect(heavy).toBeGreaterThan(2);
    expect(heavy).toBeLessThan(25);
  });
});

describe('chest and thigh control, flicks and juggling', () => {
  /** A dropping ball to the human's man at (0, 0): height y, coming in from behind him. */
  function aerial(seed: number, y: number, receiver = true) {
    const { m, p } = carrier(seed);
    m.ball.state = 'flight'; m.ball.flight = 'lob'; m.ball.owner = -1;
    const t = m.teamPlayers(0).find((q) => q.role === 'CDM')!;
    m.ball.lastTouch = t.id; m.ball.lastTouchTeam = 0; m.ball.kicker = t.id; m.ball.kickLock = 0;
    m.ball.receiver = receiver ? p.id : -1;
    m.ball.pos = { x: -2, y: y + 0.3, z: 0 }; m.ball.vel = { x: 10, y: -1.5, z: 0 };
    p.touchCooldown = 0; p.contestCooldown = 0;
    return { m, p };
  }
  it('a dropping ball on the chest goes a stride ahead, into his run', () => {
    let ok = 0;
    for (let s = 0; s < 10; s++) {
      const { m, p } = aerial(400 + s, 1.35);
      p.vel = { x: 5, z: 0 };
      run(m, p, 40, 1, 0, { sprint: true });
      if (m.ball.owner === p.id && m.ball.pos.x > p.pos.x && p.vel.x > 4) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(7);
  });

  it('with close control held, anyone of yours chests a dropping ball down instead of heading it', () => {
    const { m, p } = aerial(51, 1.7, false);
    let headed = false;
    for (let i = 0; i < 30; i++) { input(m, 0, 0, [], { close: true }); m.step(); if (m.drainEvents().some((e) => e.type === 'kick' && e.text === 'header')) headed = true; }
    expect(headed).toBe(false);
    expect(m.ball.owner).toBe(p.id);
  });

  it('close control + skill flicks it up; skill again juggles; forward flicks it over a defender to run onto', () => {
    const { m, p } = carrier(61);
    input(m, 0, 0, [{ k: 'skill', v: 'flick' }], { close: true }); m.step();
    expect(p.action.skill).toBe('flickup');
    let top = 0;
    for (let i = 0; i < 18; i++) { input(m, 0, 0, [], { close: true }); m.step(); top = Math.max(top, m.ball.pos.y); }
    expect(top).toBeGreaterThan(0.7);
    expect(m.ball.owner).toBe(p.id);
    input(m, 0, 0, [{ k: 'skill', v: 'flick' }], { close: true }); m.step();
    expect(p.action.skill).toBe('juggle');
    expect(p.action.chain).toBe(1);
    for (let i = 0; i < 16; i++) { input(m, 0, 0, [], { close: true }); m.step(); }
    m.drainEvents();
    input(m, 1, 0, [{ k: 'skill', v: 'flick', x: 1, z: 0 }], { close: true }); m.step();
    expect(p.action.skill).toBe('flickover');
    expect(m.ball.state).toBe('free');
    expect(m.ball.vel.y).toBeGreaterThan(4);
    let headed = false;
    for (let i = 0; i < 120 && m.ball.owner !== p.id; i++) { input(m, 1, 0, [], { sprint: true }); m.step(); if (m.drainEvents().some((e) => e.type === 'kick' && e.text === 'header')) headed = true; }
    expect(headed).toBe(false);
    expect(m.ball.owner).toBe(p.id);
    expect(p.pos.x).toBeGreaterThan(3);
  });

  it('shooting while juggling is a volley', () => {
    const { m, p } = carrier(62);
    p.pos = { x: m.attackDir(0) * 38, z: 0 }; p.facing = m.attackDir(0) > 0 ? 0 : Math.PI;
    m.ball.pos = { x: p.pos.x + 0.4 * m.attackDir(0), y: 0.11, z: 0 };
    input(m, 0, 0, [{ k: 'skill', v: 'flick' }], { close: true }); m.step();
    for (let i = 0; i < 16; i++) { input(m, 0, 0, [], { close: true }); m.step(); }
    m.drainEvents();
    input(m, 0, 0, [{ k: 'shoot', p: 0.6 }]); m.step();
    expect(m.drainEvents().some((e) => e.type === 'kick' && e.text === 'volley')).toBe(true);
    expect(m.ball.flight).toBe('shot');
  });

  it('a first touch away from a charging defender can turn him', () => {
    let turned = 0, toward = 0;
    for (let s = 0; s < 40; s++) {
      for (const away of [true, false]) {
        const { m, p } = carrier(500 + s);
        const o = m.teamPlayers(1).find((q) => q.role === 'RCB')!;
        o.pos = { x: 0, z: 2 }; o.vel = { x: 0, z: -5 }; o.action = { type: 'none', t: 0, dur: 0 }; o.beaten = 0;
        const t = m.teamPlayers(0).find((q) => q.role === 'CDM')!;
        m.ball.state = 'flight'; m.ball.flight = 'pass'; m.ball.owner = -1; m.ball.lastTouch = t.id; m.ball.lastTouchTeam = 0; m.ball.kicker = t.id; m.ball.receiver = p.id;
        m.ball.pos = { x: -1, y: 0.11, z: 0 }; m.ball.vel = { x: 8, y: 0, z: 0 };
        input(m, 0, away ? -1 : 1, []); m.step();
        m.takePossession(p, false);
        if (m.drainEvents().some((e) => e.type === 'call' && e.text === 'turned')) { if (away) turned++; else toward++; }
      }
    }
    expect(turned).toBeGreaterThan(3);
    expect(toward).toBe(0);
  });
});

describe('inputs, bindings and the wire', () => {
  class Fake implements InputSource {
    device = 'gamepad' as const;
    s: RawState = emptyRaw();
    read() { return { ...this.s }; }
    clear() {}
  }
  it('close control is sent with every frame, and with skill it is a flick', () => {
    const src = new Fake();
    const l = new ActionLayer([src]);
    src.s = { ...emptyRaw(), close: true };
    expect(l.sample(0, { attacking: true }).close).toBe(true);
    src.s = { ...emptyRaw(), close: true, skill: true };
    expect(l.sample(16, { attacking: true }).ev[0]).toMatchObject({ k: 'skill', v: 'flick' });
    src.s = { ...emptyRaw(), close: true, rsx: 0, rsy: 1 };
    expect(l.sample(32, { attacking: true }).ev[0]).toMatchObject({ k: 'skill', v: 'flick' });
  });

  it('RB is close control; an old saved pad layout gives it up from sprint, and keys never steal a saved key', () => {
    expect(defaultBindings().pad.close).toEqual([5]);
    expect(defaultBindings().keys.close).toEqual(['KeyC']);
    const old = defaultBindings() as unknown as { pad: Record<string, number[]>; keys: Record<string, string[]> };
    delete old.pad.close; delete old.keys.close;
    old.pad.sprint = [7, 5];
    old.keys.teamPress = ['KeyC'];
    const b = cleanBindings(old);
    expect(b.pad.sprint).toEqual([7]);
    expect(b.pad.close).toEqual([5]);
    expect(b.keys.teamPress).toEqual(['KeyC']);
    expect(b.keys.close).toEqual([]);
  });

  it('the server accepts close control and flicks; placed and power shots now reach the simulation', () => {
    const msg = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, close: true, ev: [{ k: 'skill', v: 'flick' }] }] }));
    expect(msg).not.toBeNull();
    const f = (msg as { f: { close?: boolean; ev: InputEvent[] }[] }).f[0];
    expect(f.close).toBe(true);
    expect(f.ev[0].v).toBe('flick');
    for (const v of ['power', 'placed'] as const) {
      const { m, p } = carrier(71);
      input(m, 1, 0, [{ k: 'shoot', p: 0.6, v, m: v === 'power' }]); m.step();
      expect(p.action.type).toBe('kick');
      expect(p.action.variant).toBe(v);
    }
  });

  it('the new moves and their side go out in the snapshot', () => {
    const { m, p } = carrier(81, 0.85);
    run(m, p, 70, 1, 0, { sprint: true });
    input(m, 0, -1, [], { sprint: true }); m.step(); // chop to the -z side
    expect(p.action.skill).toBe('chop');
    const s = encodeSnapshot(m, 0, [], false);
    const code = s.p[p.id * 11 + 9];
    expect(SKILLS[code & 31]).toBe('chop');
    expect(code & 32).toBe(p.action.side! < 0 ? 32 : 0);
  });
});

describe('ball control drill', () => {
  it('a scripted player scores gates, passes and touches inside 60 seconds, then it ends with the points', () => {
    const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 9, practice: 'control', challenge: 60 }));
    const calls: string[] = [];
    let passed = -10;
    for (let i = 0; i < 60 * 75 && m.phase !== 'fulltime'; i++) {
      const d = m.ctlDrill;
      let mx = 0, mz = 0;
      const ev: InputEvent[] = [];
      if (d) {
        const p = m.players[d.player], c = m.players[d.coach], b = m.ball;
        const to = (x: number, z: number) => { const l = Math.hypot(x - p.pos.x, z - p.pos.z) || 1; mx = (x - p.pos.x) / l; mz = (z - p.pos.z) / l; };
        if (b.owner === p.id && d.gate && (d.stage === 'gate' || d.stage === 'judge')) {
          const g = d.gate, nx = g.az, nz = -g.ax;
          const side = (p.pos.x - g.x) * nx + (p.pos.z - g.z) * nz >= 0 ? 1 : -1;
          // Line up a metre in front of the gate, then go through it.
          const ax = g.x + nx * side * 2.5, az = g.z + nz * side * 2.5;
          if (Math.hypot(p.pos.x - ax, p.pos.z - az) > 1.2 && Math.abs((p.pos.x - g.x) * nx + (p.pos.z - g.z) * nz) > 1.5) to(ax, az);
          else to(g.x - nx * side * 3, g.z - nz * side * 3);
          passed = -10;
        } else if (b.owner === p.id && d.stage === 'pass' && m.time - passed > 2) { to(c.pos.x, c.pos.z); ev.push({ k: 'pass', p: 0.3 }); passed = m.time; }
        else if (d.stage === 'receive' && d.gate) to(d.gate.x, d.gate.z);
        else if (b.owner !== p.id && b.owner !== c.id && b.state !== 'flight') to(b.pos.x, b.pos.z);
      }
      m.applyInput(0, { seq: seq++, mx, mz, sprint: false, jockey: false, close: false, ev });
      m.step();
      for (const e of m.drainEvents()) if (e.type === 'call' && e.text?.startsWith('skill:')) calls.push(e.text);
    }
    expect(m.phase).toBe('fulltime');
    expect(calls.some((t) => t.includes('Gate'))).toBe(true);
    expect(calls.some((t) => t.includes(':Pass'))).toBe(true);
    expect(calls.some((t) => t.includes('first touch') || t.includes('Brought it down') || t.includes('Loose touch'))).toBe(true);
    expect(m.score[0]).toBeGreaterThan(200);
    expect(m.ctlDrill!.timeLeft).toBe(0);
  });
});
