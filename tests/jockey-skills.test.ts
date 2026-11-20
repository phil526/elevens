// Jockey and contain defending, roulette and fake shot skill moves, and right-stick flick switching (18 Nov).
import { describe, expect, it } from 'vitest';
import { PLAYER } from '../src/shared/config';
import { Match, defaultConfig } from '../src/shared/match';
import { parseClientMsg } from '../src/shared/protocol';
import { encodeSnapshot, SKILLS } from '../src/shared/snapshot';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import type { InputEvent, Player, TeamIndex } from '../src/shared/types';
import { aiMatch, clearArea, toOpenPlay } from './helpers';

const stepN = (m: Match, n: number) => { for (let i = 0; i < n; i++) m.step(); };
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = [], extra: { jockey?: boolean; sprint?: boolean } = {}) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: !!extra.sprint, jockey: !!extra.jockey, ev });
const humanMatch = (seed = 5) => new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
const giveBall = (m: Match, p: Player) => { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.4, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.4 }; };
const freeze = (m: Match, p: Player) => { p.action = { type: 'none', t: 0, dur: 0 }; p.aiNextDecision = m.time + 30; p.aiTarget = { ...p.pos }; };

function carrier(seed = 31) {
  const m = aiMatch({ seed });
  toOpenPlay(m);
  clearArea(m, 0, 0, 12);
  const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
  p.pos = { x: 0, z: 0 };
  p.vel = { x: 0, z: 0 };
  p.facing = 0;
  p.skillCd = 0;
  freeze(m, p);
  giveBall(m, p);
  return { m, p };
}

/** Human team 0 defending: an opposing carrier at (0, 0) facing team 0's goal, and our controlled player. */
function defending(seed = 12) {
  const m = humanMatch(seed);
  toOpenPlay(m);
  clearArea(m, 0, 0, 15);
  const goalX = m.ownGoalX(0);
  const c = m.teamPlayers(1).find((p) => p.role === 'RCM')!;
  c.pos = { x: 0, z: 0 };
  c.vel = { x: 0, z: 0 };
  c.facing = goalX > 0 ? 0 : Math.PI;
  freeze(m, c);
  giveBall(m, c);
  const me = m.teamPlayers(0).find((p) => p.role === 'LCB')!;
  m.ctrl[0].pid = me.id;
  m.ctrl[0].autoSwitch = false;
  me.action = { type: 'none', t: 0, dur: 0 };
  return { m, c, me, goalX };
}

describe('jockey and contain', () => {
  it('jockey with no stick holds a goal-side spot about 2 m in front of the carrier, side-on to the ball', () => {
    const { m, c, me, goalX } = defending();
    const s = Math.sign(goalX);
    me.pos = { x: s * 7, z: 5 };
    for (let i = 0; i < 150; i++) { c.aiNextDecision = m.time + 30; c.wish = { x: 0, z: 0, mode: 'walk', face: null }; input(m, 0, 0, 0, [], { jockey: true }); m.step(); }
    expect(m.ball.owner).toBe(c.id);
    const d = Math.hypot(me.pos.x - c.pos.x, me.pos.z - c.pos.z);
    expect(d).toBeGreaterThan(1.4);
    expect(d).toBeLessThan(3);
    // Between the carrier and our goal.
    expect((me.pos.x - c.pos.x) * s).toBeGreaterThan(1.2);
    expect(Math.abs(me.pos.z - c.pos.z)).toBeLessThan(1);
    expect(me.jockeying).toBe(true);
    expect(me.jockeyT).toBeGreaterThan(PLAYER.jockeySetTime);
  });

  it('sprint while jockeying is a quicker shuffle that stays side-on', () => {
    const run = (sprint: boolean) => {
      const { m, me } = defending(14);
      me.pos = { x: 0, z: 20 };
      me.vel = { x: 0, z: 0 };
      const z0 = me.pos.z;
      for (let i = 0; i < 60; i++) { input(m, 0, 1, 0, [], { jockey: true, sprint }); m.step(); }
      return { moved: Math.abs(me.pos.x) + Math.abs(me.pos.z - z0) * 0, jockeying: me.jockeying, sprinting: me.sprinting };
    };
    const slow = run(false), fast = run(true);
    expect(fast.moved).toBeGreaterThan(slow.moved * 1.3);
    expect(fast.jockeying).toBe(true);
    expect(fast.sprinting).toBe(false);
  });

  it('a standing tackle from a set jockey stance is marked as well timed and recovers quickly if it misses', () => {
    const { m, c, me, goalX } = defending(15);
    const s = Math.sign(goalX);
    me.pos = { x: s * 1.6, z: 0 };
    me.facing = s > 0 ? Math.PI : 0;
    me.jockeying = true;
    me.jockeyT = 1;
    m.startTackle(me);
    expect(me.action.type).toBe('tackle');
    expect(me.action.jockeySet).toBe(true);
    // A tackle without the stance is not.
    const other = m.teamPlayers(0).find((p) => p.role === 'RCB')!;
    other.action = { type: 'none', t: 0, dur: 0 };
    other.jockeying = false;
    other.tackleCooldown = 0;
    m.startTackle(other);
    expect(other.action.jockeySet).toBeFalsy();
    // Missed from the jockey stance: the stumble afterwards is short.
    const chance = m.rng.chance.bind(m.rng);
    m.rng.chance = () => false;
    for (let i = 0; i < 40 && me.action.type === 'tackle'; i++) { c.aiNextDecision = m.time + 30; m.step(); }
    m.rng.chance = chance;
    if (me.action.type === 'stumble') expect(me.action.dur).toBeLessThan(PLAYER.stumbleTime * 0.6);
  });

  it('a carrier running at a set, goal-side jockeying defender is slowed', () => {
    const run = (jockey: boolean) => {
      const { m, c, me, goalX } = defending(16);
      const s = Math.sign(goalX);
      me.pos = { x: s * 2, z: 0 };
      me.facing = s > 0 ? Math.PI : 0;
      let top = 0;
      for (let i = 0; i < 90; i++) {
        c.aiNextDecision = m.time + 30;
        c.aiTarget = { x: c.pos.x + s * 30, z: 0 };
        me.pos = { x: c.pos.x + s * 2.4, z: c.pos.z };
        me.jockeying = jockey; me.jockeyT = jockey ? 1 : 0;
        input(m, 0, 0, 0, [], { jockey });
        m.step();
        top = Math.max(top, Math.hypot(c.vel.x, c.vel.z));
      }
      return top;
    };
    expect(run(true)).toBeLessThan(run(false) * 0.95);
  });
});

describe('roulette and fake shot', () => {
  it('diagonally back is a roulette: a full turn with the ball kept, drifting to that side', () => {
    const { m, p } = carrier();
    // Facing +x: diagonally back to the +z side.
    expect(m.startSkill(p, -0.6, 0.8)).toBe('roulette');
    let minCos = 1;
    for (let i = 0; i < Math.ceil(PLAYER.rouletteTime * 60) + 2; i++) { m.step(); minCos = Math.min(minCos, Math.cos(p.facing)); }
    expect(minCos).toBeLessThan(-0.8); // turned right round on the way
    expect(Math.cos(p.facing)).toBeGreaterThan(0.7); // and came out facing the same way
    expect(m.ball.owner).toBe(p.id);
    expect(p.pos.z).toBeGreaterThan(0.5);
  });

  it('straight back is still a drag-back and sideways a step-over', () => {
    const { m, p } = carrier();
    expect(m.startSkill(p, -1, 0.1)).toBe('dragback');
    const b = carrier(32);
    expect(b.m.startSkill(b.p, 0.1, 1)).toBe('stepover');
  });

  it('a roulette shields the ball while it spins', () => {
    const { m, p } = carrier();
    const d = m.teamPlayers(1).find((q) => q.role === 'LCB')!;
    d.pos = { x: 1.5, z: 0 };
    expect(m.shieldBonus(p, d)).toBe(0);
    m.startSkill(p, -0.6, 0.8);
    expect(m.shieldBonus(p, d)).toBeGreaterThan(0);
  });

  it('a fake shot can leave a defender rushing in to block on the floor, and the ball is cut across', () => {
    const { m, p } = carrier();
    const d = m.teamPlayers(1).find((q) => q.role === 'LCB')!;
    d.pos = { x: 4, z: 0.3 };
    d.vel = { x: -4, z: 0 };
    freeze(m, d);
    const chance = m.rng.chance.bind(m.rng);
    m.rng.chance = () => true;
    expect(m.startSkill(p, 0, 1, true)).toBe('fakeshot');
    stepN(m, 40);
    m.rng.chance = chance;
    expect(d.beaten).toBeGreaterThan(0);
    expect(m.ball.owner).toBe(p.id);
    expect(p.pos.z).toBeGreaterThan(0.2); // broke towards the stick
  });

  it('a set, jockeying defender is harder to beat than one charging in', () => {
    const rate = (set: boolean) => {
      let beaten = 0;
      for (let k = 0; k < 60; k++) {
        const { m, p } = carrier(100 + k);
        const d = m.teamPlayers(1).find((q) => q.role === 'LCB')!;
        d.pos = { x: 2.2, z: 0 };
        freeze(m, d);
        d.vel = set ? { x: 0, z: 0 } : { x: -6, z: 0 };
        d.jockeying = set; d.jockeyT = set ? 1 : 0;
        m.startSkill(p, 0, 1);
        for (let i = 0; i < 16; i++) { d.jockeying = set; d.jockeyT = set ? 1 : 0; d.aiNextDecision = m.time + 30; m.step(); }
        if (d.beaten > 0) beaten++;
      }
      return beaten;
    };
    expect(rate(true)).toBeLessThan(rate(false));
  });

  it('holding shoot and tapping pass sends a fake shot instead of a shot', () => {
    const raw: RawState = emptyRaw();
    const src: InputSource = { device: 'keyboard', read: () => ({ ...raw }), clear: () => {} };
    const a = new ActionLayer([src]);
    let t = 0;
    const sample = () => a.sample((t += 16), { attacking: true });
    raw.shoot = true; sample(); sample();
    raw.pass = true;
    const f = sample();
    expect(f.ev).toEqual([expect.objectContaining({ k: 'skill', v: 'fake' })]);
    raw.pass = false; raw.shoot = false;
    expect(sample().ev).toEqual([]); // releasing shoot afterwards doesn't shoot
  });

  it('a fake-shot event applied to the match starts a fake shot', () => {
    const m = humanMatch(21);
    toOpenPlay(m);
    clearArea(m, 0, 0, 12);
    const p = m.teamPlayers(0).find((q) => q.role === 'ST')!;
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.skillCd = 0; p.action = { type: 'none', t: 0, dur: 0 };
    giveBall(m, p);
    m.ctrl[0].pid = p.id;
    input(m, 0, 0, 0, [{ k: 'skill', v: 'fake', x: 0, z: 1 }]);
    m.step();
    expect(p.action.skill).toBe('fakeshot');
  });

  it('skill moves and their side reach online clients in the snapshot', () => {
    const { m, p } = carrier();
    m.startSkill(p, -0.6, -0.8); // roulette to the -z side
    const s = encodeSnapshot(m, 0, [], false);
    const code = s.p[p.id * 11 + 9];
    expect(SKILLS[code & 31]).toBe('roulette');
    expect(code & 32).toBe(32);
  });

  it('the protocol accepts a fake-shot skill event and the right-stick switch reference', () => {
    const msg = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, sprint: false, jockey: false, ev: [{ k: 'skill', v: 'fake', x: 0, z: 1 }, { k: 'switch', x: 1, z: 0, m: true }] }] }));
    expect(msg).not.toBeNull();
  });
});

describe('right-stick flick switching', () => {
  function setup() {
    const m = humanMatch(9);
    toOpenPlay(m);
    const team = m.teamPlayers(0).filter((p) => p.role !== 'GK');
    const cur = team[0];
    m.ctrl[0].pid = cur.id;
    if (m.ball.owner === cur.id) { m.ball.owner = -1; m.ball.state = 'free'; }
    cur.pos = { x: 0, z: 0 };
    for (const p of team.slice(1)) p.pos = { x: -40, z: 30 };
    return { m, team, cur };
  }
  it('widens the cone when nobody is close to the line of the flick', () => {
    const { m, team } = setup();
    const diag = team[1];
    diag.pos = { x: 10, z: -12 }; // about 50-55 degrees off a flick straight along +x
    m.switchTowards(0, 1, 0, false);
    expect(m.ctrl[0].pid).toBe(diag.id);
  });
  it('can measure the flick from the ball instead of the controlled player', () => {
    const { m, team, cur } = setup();
    const a = team[1], b = team[2];
    m.ball.pos = { x: 30, y: 0.11, z: 0 };
    a.pos = { x: 8, z: 0 }; // straight ahead of the controlled player, behind the ball
    b.pos = { x: 30, z: -12 }; // straight "up" from the ball
    m.switchTowards(0, 0, -1, false, true);
    expect(m.ctrl[0].pid).toBe(b.id);
    m.ctrl[0].pid = cur.id;
    m.switchTowards(0, 1, 0, false, false);
    expect(m.ctrl[0].pid).toBe(a.id);
  });
  it('a right-stick flick while defending carries the switch reference setting', () => {
    const raw: RawState = emptyRaw();
    const src: InputSource = { device: 'gamepad', read: () => ({ ...raw }), clear: () => {} };
    const a = new ActionLayer([src]);
    a.stickSwitch = 'ball';
    raw.rsx = 1;
    const f = a.sample(16, { attacking: false });
    expect(f.ev[0]).toMatchObject({ k: 'switch', m: true });
  });
});
