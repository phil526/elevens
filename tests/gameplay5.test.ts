// The remaining gameplay ideas: weather on the ball, advantage, throw-in options, the wall,
// manual keeper, live game plans and player stats.
import { describe, expect, it } from 'vitest';
import { BALL, GAME_PLANS, MATCH, PLAYER, applyGamePlan, MENTALITY } from '../src/shared/config';
import { CALM, setBallEnv, stepBall } from '../src/shared/ball';
import { Match, defaultConfig } from '../src/shared/match';
import { mentalityOf, throwRange } from '../src/shared/ai/team';
import { accelOf, sprintTop } from '../src/shared/movement';
import { cleanWeather, rollWind, weatherEnv, weatherPlay } from '../src/shared/weather';
import { statLine, teamRatings, TEAMS } from '../src/shared/teams';
import { defaultBindings, keyMap } from '../src/client/input/bindings';
import { parseClientMsg } from '../src/shared/protocol';
import type { InputEvent, Player, RestartType, TeamIndex } from '../src/shared/types';

type Internals = { award(type: RestartType, team: TeamIndex, spot: { x: number; z: number }, indirect?: boolean, taker?: number): void };
const I = (m: Match) => m as unknown as Internals;
let seq = 1;
const input = (m: Match, team: TeamIndex, mx = 0, mz = 0, ev: InputEvent[] = []) =>
  m.applyInput(team, { seq: seq++, mx, mz, sprint: false, jockey: false, contain: false, ev });
const humanMatch = (seed = 7, weather?: Parameters<typeof cleanWeather>[0]) =>
  new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, weather: weather ? cleanWeather(weather) : undefined }));

function readyRestart(m: Match, type: RestartType, team: TeamIndex, spot: { x: number; z: number }) {
  I(m).award(type, team, spot);
  for (let i = 0; i < 600 && !m.restart!.ready; i++) m.step();
  expect(m.restart!.ready).toBe(true);
  return m.restart!;
}

/** Roll a ball along the ground from rest-speed v and return how far it goes. */
function rollDistance(env: ReturnType<typeof weatherEnv>, v = 12) {
  setBallEnv(env);
  const b = { pos: { x: 0, y: BALL.radius, z: 0 }, vel: { x: v, y: 0, z: 0 }, spin: 0 };
  for (let i = 0; i < 60 * 20; i++) stepBall(b, 1 / 60, false);
  setBallEnv(CALM);
  return b.pos.x;
}

describe('weather', () => {
  it('rain lets the ball run on, snow holds it up', () => {
    const clear = rollDistance(weatherEnv({ kind: 'clear', wind: 0, windDir: 0 }));
    const rain = rollDistance(weatherEnv({ kind: 'rain', wind: 0, windDir: 0 }));
    const snow = rollDistance(weatherEnv({ kind: 'snow', wind: 0, windDir: 0 }));
    expect(rain).toBeGreaterThan(clear * 1.15);
    expect(snow).toBeLessThan(clear * 0.85);
  });

  it('wind carries a lofted ball downwind', () => {
    const fly = (wind: number) => {
      setBallEnv(weatherEnv({ kind: 'clear', wind, windDir: Math.PI / 2 })); // blowing towards +z
      const b = { pos: { x: 0, y: BALL.radius, z: 0 }, vel: { x: 18, y: 14, z: 0 }, spin: 0 };
      for (let i = 0; i < 60 * 3 && (i < 5 || b.pos.y > BALL.radius + 0.05); i++) stepBall(b, 1 / 60, false);
      setBallEnv(CALM);
      return b.pos.z;
    };
    expect(Math.abs(fly(0))).toBeLessThan(0.05);
    expect(fly(8)).toBeGreaterThan(1.5);
  });

  it('weather settings are cleaned and rolled within range', () => {
    expect(cleanWeather({ kind: 'hail', wind: 99 })).toEqual({ kind: 'clear', wind: 10, windDir: 0 });
    for (const r of [0, 0.5, 0.99]) {
      const w = rollWind('rain', r, r);
      expect(w.wind).toBeGreaterThanOrEqual(1.5);
      expect(w.wind).toBeLessThanOrEqual(8);
    }
    expect(weatherPlay({ kind: 'rain', wind: 0, windDir: 0 }).catch).toBeLessThan(1);
  });

  it('the match sets the ball physics from its weather', () => {
    const m = humanMatch(3, { kind: 'snow', wind: 4, windDir: 0 });
    expect(m.weather.kind).toBe('snow');
    expect(m.env.roll).toBeGreaterThan(BALL.rollDecel);
    expect(m.env.wx).toBeCloseTo(4);
  });
});

describe('throw-ins', () => {
  it('a long throw goes further than a short one, and inside the thrower\'s range', () => {
    const dist = (k: 'pass' | 'lob') => {
      const m = humanMatch(11);
      const dir = m.attackDir(0);
      const r = readyRestart(m, 'throwin', 0, { x: dir * 5, z: 34 });
      const taker = m.players[r.taker];
      for (let i = 0; i < 10; i++) { input(m, 0, 0, 0); m.step(); }
      input(m, 0, 0, 0, [{ k, p: 1 }]); m.step();
      // Follow the throw until it first comes down.
      let up = false;
      for (let i = 0; i < 180; i++) {
        input(m, 0); m.step();
        if (m.ball.pos.y > 2.3) up = true;
        if (up && m.ball.pos.y < 0.4) break;
      }
      expect(m.drainEvents().some((e) => e.type === 'kick' && e.text === 'throw')).toBe(true);
      return { d: Math.hypot(m.ball.pos.x - r.spot.x, m.ball.pos.z - r.spot.z), range: throwRange(taker) };
    };
    const short = dist('pass');
    const long = dist('lob');
    expect(long.d).toBeGreaterThan(short.d);
    expect(long.d).toBeLessThan(long.range + 6);
  });
});

describe('defensive wall', () => {
  function wallMatch() {
    const m = humanMatch(21);
    const ownGoal = m.ownGoalX(0);
    const r = readyRestart(m, 'freekick', 1, { x: ownGoal - Math.sign(ownGoal) * 22, z: 4 });
    return { m, r };
  }

  it('switch changes how many stand in the wall and the stick shifts it', () => {
    const { m, r } = wallMatch();
    for (let i = 0; i < 3; i++) { input(m, 0); m.step(); }
    const n0 = r.wall!.n;
    input(m, 0, 0, 0, [{ k: 'switch' }]); m.step();
    expect(r.wall!.n).toBe(n0 >= MATCH.wallMax ? MATCH.wallMin : n0 + 1);
    for (let i = 0; i < 30; i++) { input(m, 0, 0, 1); m.step(); }
    expect(Math.abs(r.wall!.shift)).toBeGreaterThan(0.5);
  });

  it('shoot makes the wall jump', () => {
    const { m } = wallMatch();
    for (let i = 0; i < 3; i++) { input(m, 0); m.step(); }
    input(m, 0, 0, 0, [{ k: 'shoot' }]); m.step();
    const jumping = m.players.filter((p) => p.team === 0 && p.action.type === 'jump');
    expect(jumping.length).toBeGreaterThanOrEqual(MATCH.wallMin);
    for (let i = 0; i < 12; i++) m.step();
    expect(Math.max(...jumping.map((p) => m.jumpHeight(p)))).toBeGreaterThan(PLAYER.wallJump * 0.5);
  });
});

describe('manual keeper', () => {
  it('skill without the ball takes the keeper; shoot dives; skill again hands him back', () => {
    const m = humanMatch(31);
    while (m.phase !== 'play') m.step();
    // Give the ball to the other side so we are defending.
    const opp = m.players.find((p) => p.team === 1 && p.role === 'ST')!;
    m.takePossession(opp, true);
    m.ball.pos = { x: opp.pos.x, y: 0.11, z: opp.pos.z };
    input(m, 0, 0, 0, [{ k: 'skill' }]); m.step();
    const gk = m.keeper(0);
    expect(m.ctrl[0].pid).toBe(gk.id);
    input(m, 0, 0, 1, [{ k: 'shoot' }]); m.step();
    expect(gk.action.type).toBe('dive');
    for (let i = 0; i < 5; i++) { input(m, 0); m.step(); }
    input(m, 0, 0, 0, [{ k: 'keeper' }]); m.step();
    expect(m.players[m.ctrl[0].pid].role).not.toBe('GK');
  });
});

describe('game plans', () => {
  it('the plan button steps the plan and changes how the team defends', () => {
    const m = humanMatch(41);
    while (m.phase !== 'play') m.step();
    expect(m.plan[0]).toBe('balanced');
    const before = mentalityOf(m, 0);
    input(m, 0, 0, 0, [{ k: 'plan', p: 3 / 4 }]); m.step();
    expect(m.plan[0]).toBe('press');
    const ev = m.drainEvents().find((e) => e.type === 'call' && e.text === 'plan:press');
    expect(ev).toBeTruthy();
    const bus = applyGamePlan(MENTALITY.balanced, 'bus'), press = applyGamePlan(MENTALITY.balanced, 'press');
    expect(press.pressers).toBeGreaterThan(bus.pressers);
    expect(press.lineOffset).toBeGreaterThan(bus.lineOffset);
    expect(mentalityOf(m, 0).lineOffset).toBeGreaterThan(before.lineOffset);
    expect(GAME_PLANS).toHaveLength(5);
  });

  it('plan events survive the network parser', () => {
    const msg = parseClientMsg(JSON.stringify({ t: 'in', f: [{ seq: 1, mx: 0, mz: 0, sprint: false, jockey: false, contain: false, ev: [{ k: 'plan', p: 0.25 }, { k: 'keeper' }] }] }));
    expect(msg).toBeTruthy();
  });
});

describe('player stats', () => {
  it('pace and acceleration change how fast players run', () => {
    const slow = { pace: 0.6, acceleration: 0.6 } as Player['def']['attrs'];
    const fast = { pace: 0.9, acceleration: 0.9 } as Player['def']['attrs'];
    expect(sprintTop(fast) - sprintTop(slow)).toBeGreaterThan(0.7);
    expect(accelOf(fast)).toBeGreaterThan(accelOf(slow));
  });

  it('every club has a stat line and ratings', () => {
    for (const t of TEAMS) {
      const r = teamRatings(t);
      expect(r.ovr).toBeGreaterThan(40);
      expect(r.ovr).toBeLessThan(99);
      const s = statLine(t.players[0]);
      expect(s.gk).toBeGreaterThan(50);
    }
  });
});

describe('bindings', () => {
  it('new keyboard defaults for keeper and game plan do not clash', () => {
    const b = defaultBindings();
    expect(b.keys.keeper).toEqual(['KeyG']);
    expect(b.keys.plan).toEqual(['KeyY']);
    const km = keyMap(b);
    expect(km.KeyG).toBe('keeper');
    expect(km.KeyY).toBe('plan');
  });
});
