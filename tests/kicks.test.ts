// Charged passing, steered first touch, chip and low shots, weak foot, driven and lofted passes.
import { describe, expect, it } from 'vitest';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { flyTo } from '../src/shared/ball';
import { PITCH } from '../src/shared/config';
import { selectReceiver, solveGroundPass, solveShot, wantedDistance, weakFootUsed } from '../src/shared/kick';
import { Match, defaultConfig, kickStyle } from '../src/shared/match';
import { parseClientMsg } from '../src/shared/protocol';
import { Rng } from '../src/shared/rng';
import { footProfile, TEAMS } from '../src/shared/teams';
import type { InputEvent, Player } from '../src/shared/types';

class Fake implements InputSource {
  device = 'gamepad' as const;
  s: RawState = emptyRaw();
  read() { return { ...this.s }; }
  clear() { this.s = emptyRaw(); }
}
const ATT = { attacking: true };

describe('charged kick buttons', () => {
  it('a pass charges while held and fires on release with its power', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.pass = true;
    expect(a.sample(0, ATT).ev).toEqual([]);
    expect(a.charging(450)?.label).toBe('PASS');
    f.s.pass = false;
    const ev = a.sample(450, ATT).ev;
    expect(ev).toHaveLength(1);
    expect(ev[0].k).toBe('pass');
    expect(ev[0].p).toBeCloseTo(0.5, 1);
    expect(ev[0].m).toBe(false);
  });
  it('the modifier makes a driven pass and a lofted through ball', () => {
    for (const k of ['pass', 'through'] as const) {
      const f = new Fake();
      const a = new ActionLayer([f]);
      f.s[k] = true; f.s.jockey = true;
      a.sample(0, ATT);
      expect(a.charging(100)?.label).toBe(k === 'pass' ? 'DRIVEN PASS' : 'LOFTED THROUGH');
      f.s[k] = false;
      const ev = a.sample(100, ATT).ev;
      expect(ev).toEqual([{ k, p: expect.any(Number), m: true }]);
    }
  });
  it('lob held with shoot chips; through held with shoot drives it low; neither pass is played', () => {
    for (const [mod, v] of [['lob', 'chip'], ['through', 'low']] as const) {
      const f = new Fake();
      const a = new ActionLayer([f]);
      f.s[mod] = true;
      a.sample(0, ATT);
      f.s.shoot = true;
      a.sample(16, ATT);
      expect(a.charging(300)?.label).toBe(v === 'chip' ? 'CHIP' : 'LOW DRIVE');
      f.s[mod] = false; // letting go of the second button first does not play a pass
      expect(a.sample(200, ATT).ev).toEqual([]);
      f.s.shoot = false;
      const ev = a.sample(400, ATT).ev;
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ k: 'shoot', v });
    }
  });
  it('pressing the second button during a shot charge also sets the style', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.shoot = true; a.sample(0, ATT);
    f.s.lob = true; a.sample(16, ATT);
    f.s.shoot = false; f.s.lob = false;
    expect(a.sample(300, ATT).ev[0]).toMatchObject({ k: 'shoot', v: 'chip' });
  });
  it('defending, the buttons still act on the press', () => {
    const f = new Fake();
    const a = new ActionLayer([f]);
    f.s.lob = true;
    expect(a.sample(0, { attacking: false }).ev).toEqual([{ k: 'lob' }]);
  });
  it('the shot style survives the wire protocol, and junk is refused', () => {
    const ok = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'shoot', p: 0.5, v: 'chip' }] }] }));
    expect(ok && ok.t === 'in' && ok.f[0].ev[0].v).toBe('chip');
    expect(parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, ev: [{ k: 'shoot', p: 0.5, v: 'rabona' }] }] }))).toBeNull();
  });
  it('events map to kick styles', () => {
    const st = (e: InputEvent) => kickStyle(e);
    expect(st({ k: 'pass', p: 0.3, m: true })).toMatchObject({ variant: 'driven', charged: true });
    expect(st({ k: 'through', p: 0.3, m: true })).toMatchObject({ variant: 'lofted', charged: true });
    expect(st({ k: 'shoot', p: 0.3, m: true })).toMatchObject({ placed: false, variant: 'finesse' }); // modifier = finesse (19 Nov 2026)
    expect(st({ k: 'shoot', p: 0.3, m: true, v: 'chip' })).toMatchObject({ placed: false, variant: 'chip' });
    expect(st({ k: 'pass' }).charged).toBeUndefined(); // computer and old clients: no charge
  });
});

function freshMatch(seed = 4) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  return m;
}
/** Move everyone out of the way except the listed players. */
function park(m: Match, keep: Player[]) {
  for (const q of m.players) if (!keep.includes(q)) { q.pos = { x: q.team ? 50 : -50, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
}

describe('charged pass receiver choice', () => {
  it('a tap finds the near teammate in the lane, a full charge the far one', () => {
    const m = freshMatch();
    const [p, near, far] = m.teamPlayers(0).filter((x) => x.role !== 'GK');
    park(m, [p, near, far]);
    p.pos = { x: 0, z: 0 }; p.facing = 0;
    near.pos = { x: 9, z: 1 }; far.pos = { x: 26, z: -1 };
    const dir = m.attackDir(0);
    expect(selectReceiver(m.players, p, 1, 0, 'pass', dir, { power: 0.05 }).receiver).toBe(near.id);
    expect(selectReceiver(m.players, p, 1, 0, 'pass', dir, { power: 1 }).receiver).toBe(far.id);
    expect(wantedDistance('pass', 1)).toBeGreaterThan(wantedDistance('pass', 0) + 20);
  });
  it('direction still wins over distance: a tap does not pass sideways', () => {
    const m = freshMatch();
    const [p, side, ahead] = m.teamPlayers(0).filter((x) => x.role !== 'GK');
    park(m, [p, side, ahead]);
    p.pos = { x: 0, z: 0 };
    side.pos = { x: 0.5, z: 9 }; ahead.pos = { x: 16, z: 0 };
    expect(selectReceiver(m.players, p, 1, 0, 'pass', 1, { power: 0.05 }).receiver).toBe(ahead.id);
  });
});

describe('kick solvers', () => {
  const m = freshMatch();
  const k = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  const side = 1 as const;
  const setAt = (x: number, z: number, facing = 0) => { k.pos = { x, z }; k.vel = { x: 0, z: 0 }; k.facing = facing; k.sprinting = false; };

  it('a driven pass is played much harder than a normal one', () => {
    setAt(0, 0);
    const ctx = { kicker: k, ballPos: { x: 0.4, y: 0.11, z: 0 }, pressure: 0, rng: new Rng(1) };
    const n = solveGroundPass(ctx, { x: 25, z: 0 }, 'pass');
    const d = solveGroundPass({ ...ctx, rng: new Rng(1) }, { x: 25, z: 0 }, 'pass', true);
    expect(Math.hypot(d.vel.x, d.vel.z)).toBeGreaterThan(Math.hypot(n.vel.x, n.vel.z) + 3);
  });
  it('a chip rises high and drops under the bar; an over-hit chip clears it', () => {
    setAt(PITCH.halfLength - 18, 0);
    const ballPos = { x: k.pos.x + 0.4, y: 0.11, z: 0 };
    const yAtLine = (power: number) => {
      const r = solveShot({ kicker: k, ballPos, pressure: 0, rng: new Rng(3) }, { side, aimZ: 0, power, placed: false, style: 'chip' });
      const vh = Math.hypot(r.vel.x, r.vel.z);
      const peak = flyTo(vh, r.vel.y, ballPos.y, (PITCH.halfLength - ballPos.x) * 0.55).y;
      return { line: flyTo(vh, r.vel.y, ballPos.y, PITCH.halfLength - ballPos.x).y, peak, vh };
    };
    const good = yAtLine(0.5);
    expect(good.peak).toBeGreaterThan(3);
    expect(good.line).toBeLessThan(PITCH.goalHeight);
    expect(good.vh).toBeLessThan(17); // slow enough for defenders and keepers to deal with it
    expect(yAtLine(1).line).toBeGreaterThan(PITCH.goalHeight);
  });
  it('a low drive stays low even at full power', () => {
    setAt(PITCH.halfLength - 16, 0);
    const ballPos = { x: k.pos.x + 0.4, y: 0.11, z: 0 };
    for (let s = 1; s < 30; s++) {
      const r = solveShot({ kicker: k, ballPos, pressure: 0, rng: new Rng(s) }, { side, aimZ: 2, power: 1, placed: false, style: 'low' });
      const y = flyTo(Math.hypot(r.vel.x, r.vel.z), r.vel.y, ballPos.y, PITCH.halfLength - ballPos.x).y;
      expect(y).toBeLessThan(1.2);
    }
  });
});

describe('weak foot', () => {
  it('every player has a fixed stronger foot and a 2-5 star weak foot; about a fifth are left-footed', () => {
    const all = TEAMS.flatMap((t) => t.players);
    const prof = all.map((d) => footProfile(d));
    expect(prof.every((f) => f.stars >= 2 && f.stars <= 5)).toBe(true);
    const lefties = prof.filter((f) => f.foot === -1).length / prof.length;
    expect(lefties).toBeGreaterThan(0.08);
    expect(lefties).toBeLessThan(0.4);
    expect(footProfile(all[3])).toEqual(footProfile({ ...all[3] }));
  });
  it('shooting across to the weaker side uses the weaker foot and is less accurate', () => {
    const m = freshMatch();
    const k = m.teamPlayers(0).find((x) => footProfile(x.def).stars <= 3)!;
    const right = footProfile(k.def).foot === 1;
    k.vel = { x: 0, z: 0 }; k.facing = 0; // facing +x, towards the goal at x = 52.5
    // A right-footer shooting well to their right (+z when facing +x) needs the left foot.
    const ws = right ? 1 : -1;
    k.pos = { x: 30, z: 0 };
    expect(weakFootUsed(k, { x: 30.4, z: 0 }, 10, ws * 8)).toBe(true);
    expect(weakFootUsed(k, { x: 30.4, z: 0 }, 10, -ws * 8)).toBe(false);
    expect(weakFootUsed(k, { x: 30.4, z: 0 }, 20, 0)).toBe(false);
    // Mirror-image chances: from one side the shot goes across to the weak side, from the other to the strong side.
    k.pos = { x: 44, z: -ws * 6 };
    const weak = spreadAt(k, ws * 3.2);
    k.pos = { x: 44, z: ws * 6 };
    const strong = spreadAt(k, -ws * 3.2);
    expect(weak).toBeGreaterThan(strong * 1.3);
  });
});

function spreadAt(k: Player, aimZ: number) {
  const zs: number[] = [];
  for (let s = 1; s <= 300; s++) {
    const r = solveShot({ kicker: k, ballPos: { x: k.pos.x + 0.4, y: 0.11, z: k.pos.z }, pressure: 0, rng: new Rng(s) }, { side: 1, aimZ, power: 0.6, placed: false });
    zs.push(Math.atan2(r.vel.z, r.vel.x));
  }
  const mean = zs.reduce((a, b) => a + b) / zs.length;
  return Math.sqrt(zs.reduce((a, b) => a + (b - mean) ** 2, 0) / zs.length);
}

describe('steered first touch', () => {
  let seq = 1;
  function receive(mx: number, mz: number, sprint: boolean) {
    const m = freshMatch(9);
    m.ctrl[0].autoSwitch = false;
    const [p, passer] = m.teamPlayers(0).filter((x) => x.role === 'ST' || x.role === 'RCM');
    park(m, [p, passer]);
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = Math.PI; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
    passer.pos = { x: 30, z: 20 };
    m.ctrl[0].pid = p.id;
    // A pass rolling in from +x towards the receiver.
    const b = m.ball;
    b.pos = { x: 6, y: 0.11, z: 0 }; b.vel = { x: -9, y: 0, z: 0 }; b.spin = 0;
    b.state = 'flight'; b.flight = 'pass'; b.owner = -1; b.receiver = p.id; b.lastTouch = passer.id; b.lastTouchTeam = 0; b.kicker = passer.id; b.kickLock = 0;
    let got = -1;
    for (let i = 0; i < 120; i++) {
      // Hold the stick only as the ball arrives, like a player setting up the touch.
      const near = got >= 0 || Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 2.5;
      m.applyInput(0, { seq: seq++, mx: near ? mx : 0, mz: near ? mz : 0, sprint, jockey: false, contain: false, ev: [] });
      for (const q of m.players) if (q !== p) { q.vel = { x: 0, z: 0 }; }
      m.step();
      if (got < 0 && (b.owner === p.id || b.kicker === p.id)) got = i;
      if (got >= 0 && i - got >= 12) break;
    }
    return { m, p, b };
  }
  it('no direction kills the ball dead at the feet', () => {
    const { p, b } = receive(0, 0, false);
    expect(b.owner).toBe(p.id);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeLessThan(1.2);
    expect(Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z)).toBeLessThan(1.2);
  });
  it('a direction takes the first touch that way, even across the pass', () => {
    const { p, b } = receive(0, 1, false);
    expect(b.owner).toBe(p.id);
    expect(b.pos.z - p.pos.z).toBeGreaterThan(-0.2);
    expect(b.pos.z).toBeGreaterThan(0.6);
  });
  it('sprint pushes the ball ahead into space, still the receiver\'s ball', () => {
    const { p, b } = receive(0, 1, true);
    // 0.2 s after the touch the ball is clear and running on, but not knocked loose.
    expect(b.pos.z).toBeGreaterThan(1.1);
    expect(b.vel.z).toBeGreaterThan(2.5);
    expect(b.pos.z).toBeGreaterThan(p.pos.z - 0.5);
    expect(b.owner).toBe(p.id);
  });
});

describe('shot style through the match input', () => {
  it('a chip event reaches the kick as a chip', () => {
    const m = freshMatch(12);
    const p = m.players[m.ctrl[0].pid];
    park(m, [p]);
    p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
    m.takePossession(p, true);
    m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 };
    m.ball.vel = { x: 0, y: 0, z: 0 };
    m.applyInput(0, { seq: 99999, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [{ k: 'shoot', p: 0.5, v: 'chip' }] });
    m.step();
    expect(p.action.variant).toBe('chip');
  });
});
