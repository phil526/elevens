// Early/Late pass receiver: Early locks the teammate when the button goes down.
import { describe, expect, it } from 'vitest';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { Match, defaultConfig } from '../src/shared/match';
import { parseClientMsg } from '../src/shared/protocol';
import type { Player } from '../src/shared/types';

class Fake implements InputSource {
  device = 'gamepad' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() { this.s = emptyRaw(); }
}
const ATT = { attacking: true };

describe('receiver lock (input)', () => {
  it('Late sends no receiver; Early sends the one picked on press, whatever happens while held', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    let pick = 7;
    a.pickReceiver = () => pick;
    f.s.pass = true; a.sample(0, ATT); f.s.pass = false;
    expect(a.sample(300, ATT).ev[0].r).toBeUndefined();
    a.receiverMode = 'early';
    f.s.pass = true; a.sample(400, ATT);
    pick = 3; // the stick moves during the hold: the lock stays
    expect(a.charging(600)?.locked).toBe(7);
    f.s.pass = false;
    const ev = a.sample(700, ATT).ev[0];
    expect(ev.r).toBe(7);
    expect(a.charging(800)).toBeNull();
  });
  it('the protocol keeps a valid receiver and rejects a bad one', () => {
    const msg = (r: unknown) => parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'pass', p: 0.5, r }] }] }));
    const ok = msg(5);
    expect(ok && ok.t === 'in' && ok.f[0].ev[0].r).toBe(5);
    expect(msg(40)).toBeNull();
    expect(msg(2.5)).toBeNull();
  });
});

describe('receiver lock (match)', () => {
  let seq = 1;
  function setup() {
    const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 9 }));
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
    const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
    m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
    p.pos = { x: -10, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
    m.takePossession(p, true); m.ball.pos = { x: -9.55, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: 40, z: o.pos.z };
    return { m, p };
  }
  const passTo = (m: Match, r: number | undefined, power = 0.5) => {
    m.applyInput(0, { seq: seq++, mx: 1, mz: 0, sprint: false, jockey: false, contain: false, ev: [{ k: 'pass', p: power, r }] });
    for (let i = 0; i < 20; i++) { m.applyInput(0, { seq: seq++, mx: 1, mz: 0, sprint: false, jockey: false, contain: false, ev: [] }); m.step(); if (m.ball.state === 'flight') break; }
  };
  it('a locked receiver gets the pass even when the stick points elsewhere', () => {
    const { m, p } = setup();
    const behind = m.teamPlayers(0).find((x) => x.role === 'RCB')!;
    behind.pos = { x: -25, z: 6 }; behind.vel = { x: 0, z: 0 };
    passTo(m, behind.id);
    expect(m.ball.state).toBe('flight');
    expect(m.ball.receiver).toBe(behind.id);
    expect(m.ball.vel.x).toBeLessThan(0);
    expect(p.action.locked).toBe(true);
  });
  it('an opponent as the locked receiver is ignored', () => {
    const { m } = setup();
    const opp = m.teamPlayers(1).find((x) => x.role === 'ST')!;
    passTo(m, opp.id);
    expect(m.ball.state).toBe('flight');
    expect(m.players[m.ball.receiver]?.team ?? 0).toBe(0);
  });
  it('with a lock, a longer hold plays a firmer pass', () => {
    const speed = (power: number) => {
      const { m } = setup();
      const t = m.teamPlayers(0).find((x) => x.role === 'LCM')!;
      t.pos = { x: 5, z: -8 }; t.vel = { x: 0, z: 0 };
      passTo(m, t.id, power);
      return Math.hypot(m.ball.vel.x, m.ball.vel.z);
    };
    expect(speed(1)).toBeGreaterThan(speed(0) * 1.2);
  });
});
