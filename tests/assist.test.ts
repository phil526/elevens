// Pass assistance: Assisted (default) picks and weighs the pass, Semi aims at a teammate in a narrow cone with the
// charge setting the distance, Manual goes where the stick points as far as the charge says.
import { describe, expect, it } from 'vitest';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { Match, defaultConfig } from '../src/shared/match';
import { parseClientMsg } from '../src/shared/protocol';
import type { InputEvent, Player } from '../src/shared/types';

class Fake implements InputSource {
  device = 'gamepad' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() { this.s = emptyRaw(); }
}

let seq = 1;
function setup() {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 9 }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  p.pos = { x: -10, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  m.takePossession(p, true); m.ball.pos = { x: -9.55, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: 45, z: o.pos.z };
  // One teammate 20 m ahead and slightly right; everyone else out of the way.
  const mate = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  for (const t of m.teamPlayers(0)) if (t !== p && t.role !== 'GK') { t.pos = { x: -30, z: t.pos.z > 0 ? 30 : -30 }; t.vel = { x: 0, z: 0 }; }
  mate.pos = { x: 10, z: 4 }; mate.vel = { x: 0, z: 0 };
  return { m, p, mate };
}
/** Plays a pass with the stick at angle (deg) and returns where the ball first comes to rest or is reached. */
function play(m: Match, ev: InputEvent, deg: number) {
  const mx = Math.cos((deg * Math.PI) / 180), mz = Math.sin((deg * Math.PI) / 180);
  m.applyInput(0, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev: [ev] });
  for (let i = 0; i < 30; i++) { m.applyInput(0, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev: [] }); m.step(); if (m.ball.state === 'flight') break; }
  return { receiver: m.ball.receiver, vel: { ...m.ball.vel } };
}

describe('pass assistance', () => {
  it('Assisted finds the teammate from a stick 40 degrees off; Semi and Manual do not', () => {
    const a = setup();
    expect(play(a.m, { k: 'pass', p: 0.5 }, 40).receiver).toBe(a.mate.id);
    const s = setup();
    expect(play(s.m, { k: 'pass', p: 0.5, a: 1 }, 40).receiver).toBe(-1);
    const n = setup();
    const r = play(n.m, { k: 'pass', p: 0.5, a: 2 }, 40);
    expect(r.receiver).toBe(-1);
    // Manual goes along the stick.
    expect(Math.atan2(r.vel.z, r.vel.x) * 180 / Math.PI).toBeGreaterThan(28);
  });
  it('Semi aims at the teammate the stick points near, and the charge sets how hard', () => {
    const soft = setup();
    const a = play(soft.m, { k: 'pass', p: 0.05, a: 1 }, 10);
    expect(a.receiver).toBe(soft.mate.id);
    const hard = setup();
    const b = play(hard.m, { k: 'pass', p: 1, a: 1 }, 10);
    expect(b.receiver).toBe(hard.mate.id);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeGreaterThan(Math.hypot(a.vel.x, a.vel.z) * 1.2);
  });
  it('Manual: a longer hold sends the ball further', () => {
    const s = setup(), l = setup();
    const a = play(s.m, { k: 'pass', p: 0.1, a: 2 }, 0), b = play(l.m, { k: 'pass', p: 0.9, a: 2 }, 0);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeGreaterThan(Math.hypot(a.vel.x, a.vel.z) * 1.2);
  });
  it('the input layer tags passes, not shots, and never locks a receiver in Manual', () => {
    const f = new Fake();
    const x = new ActionLayer([f]);
    x.pickReceiver = () => 4;
    x.receiverMode = 'early';
    x.passAssist = 'manual';
    f.s.pass = true; x.sample(0, { attacking: true }); f.s.pass = false;
    const e = x.sample(200, { attacking: true }).ev[0];
    expect(e.a).toBe(2);
    expect(e.r).toBeUndefined();
    f.s.shoot = true; x.sample(300, { attacking: true }); f.s.shoot = false;
    expect(x.sample(500, { attacking: true }).ev[0].a).toBeUndefined();
  });
  it('the protocol keeps 1 and 2 and rejects anything else', () => {
    const msg = (a: unknown) => parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'pass', p: 0.5, a }] }] }));
    const ok = msg(2);
    expect(ok && ok.t === 'in' && ok.f[0].ev[0].a).toBe(2);
    expect(msg(3)).toBeNull();
    expect(msg('x')).toBeNull();
  });
});
