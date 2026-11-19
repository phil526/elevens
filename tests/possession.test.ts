// Possession play: situational pass accuracy, passes into a runner's stride, one-twos, the dummy,
// receivers coming to the ball, support triangles and tighter dribbling at jogging pace.
import { describe, expect, it } from 'vitest';
import { leadTarget, passDifficulty, type KickContext } from '../src/shared/kick';
import { Match, defaultConfig } from '../src/shared/match';
import { Rng } from '../src/shared/rng';
import { wrapAngle } from '../src/shared/math';
import type { Player } from '../src/shared/types';

let seq = 1;
function freshMatch(seed = 4, humans: [boolean, boolean] = [true, false]) {
  const m = new Match(defaultConfig({ humans, realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  m.ctrl[0].autoSwitch = false;
  return m;
}
function park(m: Match, keep: Player[]) {
  for (const q of m.players) if (!keep.includes(q)) { q.pos = { x: q.team ? 50 : -50, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
}
const idle = { type: 'none', t: 0, dur: 0 } as Player['action'];
function input(m: Match, o: { mx?: number; mz?: number; sprint?: boolean; jockey?: boolean; ev?: Parameters<Match['applyInput']>[1]['ev'] } = {}) {
  m.applyInput(0, { seq: seq++, mx: o.mx ?? 0, mz: o.mz ?? 0, sprint: !!o.sprint, jockey: !!o.jockey, contain: false, ev: o.ev ?? [] });
}
/** A human carrier at (-10, 0) facing +x with the ball, and a teammate 16 m ahead. */
function carrierSetup(seed = 9) {
  const m = freshMatch(seed);
  const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
  const mate = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  park(m, [p, mate]);
  m.ctrl[0].pid = p.id;
  p.pos = { x: -10, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.action = { ...idle };
  m.takePossession(p, true); m.ball.pos = { x: -9.55, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  mate.pos = { x: 6, z: 2 }; mate.vel = { x: 0, z: 0 };
  return { m, p, mate };
}

describe('situational pass accuracy', () => {
  const m = freshMatch();
  const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
  const ctx = (o: Partial<KickContext> = {}): KickContext => ({ kicker: p, ballPos: { x: p.pos.x + 0.4, y: 0.11, z: p.pos.z }, pressure: 0, rng: new Rng(1), ...o });
  it('a simple short pass with time is cleaner than one under pressure, first time or across the body', () => {
    p.vel = { x: 0, z: 0 }; p.sprinting = false; p.facing = 0;
    const easy = passDifficulty(ctx(), 10, 0, 10);
    expect(easy).toBeLessThan(1);
    expect(passDifficulty(ctx({ pressure: 1 }), 10, 0, 10)).toBeGreaterThan(easy * 2.5);
    expect(passDifficulty(ctx({ firstTime: true }), 20, 0, 20)).toBeGreaterThan(passDifficulty(ctx(), 20, 0, 20));
    expect(passDifficulty(ctx(), -10, 0, 10)).toBeGreaterThan(easy * 2); // behind the body
    p.vel = { x: 8.5, z: 0 }; p.sprinting = true;
    expect(passDifficulty(ctx(), 10, 0, 10)).toBeGreaterThan(easy * 1.5);
    p.vel = { x: 0, z: 0 }; p.sprinting = false;
  });
});

describe('passes into space', () => {
  it('a normal pass leads a teammate running forward further than one standing', () => {
    const { m, p, mate } = carrierSetup();
    const still = leadTarget(p, mate, 'pass', 1);
    mate.vel = { x: 7, z: 0 };
    const run = leadTarget(p, mate, 'pass', 1);
    expect(run.x - mate.pos.x).toBeGreaterThan(still.x - mate.pos.x + 4);
    void m;
  });
  it('holding sprint as you pass plays it ahead of the teammate, weighted into their stride', () => {
    const plain = carrierSetup();
    input(plain.m, { mx: 1, ev: [{ k: 'pass', p: 0.5 }] });
    for (let i = 0; i < 30 && plain.m.ball.state !== 'flight'; i++) { input(plain.m, { mx: 1 }); plain.m.step(); }
    const space = carrierSetup();
    input(space.m, { mx: 1, sprint: true, ev: [{ k: 'pass', p: 0.5 }] });
    for (let i = 0; i < 30 && space.m.ball.state !== 'flight'; i++) { input(space.m, { mx: 1, sprint: true }); space.m.step(); }
    expect(plain.m.ball.receiver).toBe(plain.mate.id);
    expect(space.m.ball.receiver).toBe(space.mate.id);
    expect(space.m.ball.flight).toBe('through');
    expect(plain.m.ball.flight).toBe('pass');
  });
});

describe('one-twos', () => {
  it('pressing pass again as the pass arrives sends the passer on and returns the ball into the run', () => {
    const { m, p, mate } = carrierSetup(11);
    input(m, { mx: 1, ev: [{ k: 'pass', p: 0.4 }] });
    for (let i = 0; i < 30 && m.ball.state !== 'flight'; i++) { input(m, { mx: 1 }); m.step(); }
    expect(m.ball.receiver).toBe(mate.id);
    expect(m.ctrl[0].pid).toBe(mate.id);
    input(m, { ev: [{ k: 'pass', p: 0.4 }] }); // second press while the ball travels
    m.step();
    expect(p.giveGoUntil).toBeGreaterThan(m.time);
    let returned = false;
    for (let i = 0; i < 240; i++) {
      input(m);
      m.step();
      if (m.ball.state === 'flight' && m.ball.kicker === mate.id) { returned = true; break; }
    }
    expect(returned).toBe(true);
    expect(m.ball.receiver).toBe(p.id);
    expect(m.ball.flight).toBe('through');
    expect(p.vel.x).toBeGreaterThan(3); // the passer is running on
  });
  it('computer players pass and move after short passes', () => {
    let goes = 0;
    for (const seed of [31, 32]) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 3, seed }));
      const seen = new Set<number>();
      for (let i = 0; i < 60 * 90; i++) {
        m.step();
        for (const q of m.players) if (q.giveGoUntil > m.time && !seen.has(q.giveGoUntil)) { seen.add(q.giveGoUntil); goes++; }
      }
    }
    expect(goes).toBeGreaterThan(5);
  });
});

describe('dummy and receiving', () => {
  function incoming(jockey: boolean) {
    const m = freshMatch(13);
    const [passer, p, behind] = m.teamPlayers(0).filter((x) => x.role === 'RCM' || x.role === 'ST' || x.role === 'LW');
    park(m, [passer, p, behind]);
    passer.pos = { x: -20, z: 0 }; p.pos = { x: 0, z: 0.3 }; behind.pos = { x: 10, z: -0.5 };
    for (const q of [passer, p, behind]) { q.vel = { x: 0, z: 0 }; q.action = { ...idle }; }
    m.ctrl[0].pid = p.id;
    const b = m.ball;
    b.pos = { x: -6, y: 0.11, z: 0 }; b.vel = { x: 13, y: 0, z: 0 }; b.spin = 0;
    b.state = 'flight'; b.flight = 'pass'; b.owner = -1; b.receiver = p.id; b.lastTouch = passer.id; b.lastTouchTeam = 0; b.kicker = passer.id; b.kickLock = 0;
    let owner = -1;
    for (let i = 0; i < 150 && owner < 0; i++) { input(m, { jockey }); m.step(); owner = b.owner; }
    return { m, p, behind, owner };
  }
  it('holding shield as the pass arrives lets it run to the teammate behind, who takes over', () => {
    const r = incoming(true);
    expect(r.owner).toBe(r.behind.id);
    expect(r.m.ctrl[0].pid).toBe(r.behind.id);
  });
  it('without it the receiver takes the ball', () => {
    const r = incoming(false);
    expect(r.owner).toBe(r.p.id);
  });
  it('a human receiver with no stick input steps towards a ground pass instead of waiting', () => {
    const m = freshMatch(13);
    const [passer, p] = m.teamPlayers(0).filter((x) => x.role === 'RCM' || x.role === 'ST');
    park(m, [passer, p]);
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.action = { ...idle };
    m.ctrl[0].pid = p.id;
    const b = m.ball;
    b.pos = { x: -18, y: 0.11, z: 0 }; b.vel = { x: 12, y: 0, z: 0 };
    b.state = 'flight'; b.flight = 'pass'; b.owner = -1; b.receiver = p.id; b.lastTouch = passer.id; b.lastTouchTeam = 0; b.kicker = passer.id; b.kickLock = 0;
    for (let i = 0; i < 20; i++) { input(m); m.step(); }
    expect(p.pos.x).toBeLessThan(-0.15);
  });
});

describe('support triangles', () => {
  it('the carrier gets supporters on different angles, one of them looking for a pocket further on', () => {
    let checked = 0;
    for (const seed of [41, 42, 43]) {
      const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 3, seed }));
      for (let i = 0; i < 60 * 60; i++) {
        m.step();
        const b = m.ball;
        if (i % 30 || b.owner < 0 || b.state !== 'dribble' || m.phase !== 'play') continue;
        const carrier = m.players[b.owner];
        const plan = m.plans[carrier.team]!;
        const spots = [...plan.supportSpots.values()];
        if (spots.length < 2) continue;
        const ang = spots.map((s) => Math.atan2(s.z - b.pos.z, s.x - b.pos.x));
        for (let a = 0; a < ang.length; a++) for (let c = a + 1; c < ang.length; c++) expect(Math.abs(wrapAngle(ang[a] - ang[c]))).toBeGreaterThan(0.3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('close control', () => {
  it('jogging with the ball keeps it closer than sprinting', () => {
    const gap = (sprint: boolean) => {
      const m = freshMatch(17);
      const p = m.teamPlayers(0).find((x) => x.role === 'RCM')!;
      park(m, [p]);
      m.ctrl[0].pid = p.id;
      p.pos = { x: -20, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.action = { ...idle };
      m.takePossession(p, true); m.ball.pos = { x: -19.55, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
      let sum = 0, n = 0;
      for (let i = 0; i < 150; i++) {
        input(m, { mx: 1, sprint });
        m.step();
        if (i > 40 && m.ball.owner === p.id) { sum += Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z); n++; }
      }
      return sum / Math.max(1, n);
    };
    const jog = gap(false), sprint = gap(true);
    expect(jog).toBeLessThan(sprint * 0.8);
    expect(jog).toBeLessThan(1.3);
  });
});
