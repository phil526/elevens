// Compact snapshot encoding for the network (server -> client, 20 Hz).
// Numbers are rounded to centimetres; enums are sent as indices.

import { GAME_PLANS, MATCH, halfLength, halfStart, type Half } from './config';
import type { Match } from './match';
import type { Rated } from './ratings';
import type { ActionType, BallState, FlightKind, GoalRecord, KickKind, MatchEvent, Phase, RestartType, SkillMove, TeamStats } from './types';

export const PHASES: Phase[] = ['kickoff', 'play', 'restart', 'goal', 'halftime', 'fulltime'];
export const BALL_STATES: BallState[] = ['free', 'dribble', 'flight', 'held', 'dead'];
export const FLIGHTS: FlightKind[] = ['none', 'pass', 'through', 'lob', 'cross', 'shot', 'header', 'clear', 'throw', 'deflect'];
export const ACTIONS: ActionType[] = ['none', 'kick', 'tackle', 'stumble', 'dive', 'celebrate', 'throw', 'header', 'catch', 'down', 'slide', 'skill', 'barge', 'jump'];
export const KICKS: (KickKind | undefined)[] = [undefined, 'pass', 'through', 'lob', 'shot', 'clear', 'cross', 'throw'];
/** Skill moves; a skill action sends its index here in the kick slot, plus 8 when it breaks to the left (side -1). */
export const SKILLS: SkillMove[] = ['stepover', 'dragback', 'knockon', 'roulette', 'fakeshot', 'ballroll', 'elastico', 'dragturn'];
export const RESTARTS: RestartType[] = ['kickoff', 'throwin', 'goalkick', 'corner', 'freekick', 'penalty', 'dropball'];

export const PLAYER_STRIDE = 11;

export interface Snapshot {
  k: 's';
  t: number; // server tick
  ph: number;
  pt: number; // phase time
  h: Half;
  so?: [number[], number[], number, number];
  sb?: [number, number, number][]; // substitutions so far: team, slot, bench index // shootout: kicks (1 scored), team kicking, winner (-1 undecided)
  c: number; // display clock seconds
  ex?: number; // added time this half, whole minutes (0 until announced)
  sc: [number, number];
  b: number[]; // x,y,z,vx,vy,vz,state,owner,flight,lastTouchTeam
  p: number[]; // PLAYER_STRIDE per player
  dv: number[][]; // [id, tx, ty, tz] for diving keepers
  r: number[] | 0; // restart: type, team, taker, ready, x, z, readyT, aimX, aimZ
  ctl: [number, number];
  nx: [number, number];
  hu: [0 | 1, 0 | 1];
  ad: [number, number]; // attack direction of each team
  ack: number; // last input seq applied for the receiving client
  ev: MatchEvent[];
  g: GoalRecord[];
  st?: [TeamStats, TeamStats];
  ps?: Rated[]; // player ratings, sent with the stats at half time and full time
  hold: number;
  gp?: [number, number]; // each side's game plan (index into GAME_PLANS), sent when not both Balanced
  mo?: number; // home crowd momentum, -1 (away on top) .. 1 (home on top), sent when not level
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function encodeSnapshot(m: Match, ack: number, events: MatchEvent[], withStats: boolean): Snapshot {
  const b = m.ball;
  const p: number[] = [];
  const dv: number[][] = [];
  for (const pl of m.players) {
    const a = pl.action;
    p.push(
      r2(pl.pos.x), r2(pl.pos.z), r2(pl.vel.x), r2(pl.vel.z), r2(pl.facing), Math.round(pl.stamina * 100),
      ACTIONS.indexOf(a.type), Math.round(a.t * 1000), Math.round(a.dur * 1000), a.type === 'skill' ? Math.max(0, SKILLS.indexOf(a.skill ?? 'stepover')) + ((a.side ?? 1) < 0 ? 8 : 0) : Math.max(0, KICKS.indexOf(a.kind)) + (a.variant === 'roll' ? 16 : 0), (pl.sprinting ? 1 : 0) | (pl.jockeying ? 2 : 0) | (pl.cards > 0 ? 4 : 0) | (pl.off ? 8 : 0) | (pl.callUntil > m.time ? 16 : 0),
    );
    if (a.type === 'dive' && a.target) dv.push([pl.id, r2(a.target.x), r2(a.target.y), r2(a.target.z)]);
  }
  const r = m.restart;
  return {
    k: 's', t: m.tick, ph: PHASES.indexOf(m.phase), pt: r2(m.phaseT), h: m.half, c: Math.round(m.displayClock * 10) / 10, sc: [...m.score] as [number, number], ex: m.addedTime,
    sb: m.subsLog.length ? m.subsLog.map((x) => [...x] as [number, number, number]) : undefined,
    so: m.shootout ? [m.shootout.kicks[0].map((k: boolean) => (k ? 1 : 0)), m.shootout.kicks[1].map((k: boolean) => (k ? 1 : 0)), m.shootout.team, m.shootout.winner] : undefined,
    b: [r2(b.pos.x), r2(b.pos.y), r2(b.pos.z), r2(b.vel.x), r2(b.vel.y), r2(b.vel.z), BALL_STATES.indexOf(b.state), b.owner, FLIGHTS.indexOf(b.flight), b.lastTouchTeam],
    p, dv,
    r: r ? [RESTARTS.indexOf(r.type), r.team, r.taker, r.ready ? 1 : 0, r2(r.spot.x), r2(r.spot.z), r2(r.readyT), r2(r.aim.x), r2(r.aim.z), r.quick ? 1 : 0, r2(r.curve ?? 0), r2(r.dip ?? 0)] : 0,
    ctl: [m.ctrl[0].pid, m.ctrl[1].pid], nx: [m.ctrl[0].next, m.ctrl[1].next], hu: [m.ctrl[0].human ? 1 : 0, m.ctrl[1].human ? 1 : 0],
    ad: [m.attackDir(0), m.attackDir(1)], ack, ev: events, g: m.goals.slice(), st: withStats ? [m.stats[0], m.stats[1]] : undefined,
    ps: withStats && (m.phase === 'fulltime' || m.phase === 'halftime') ? m.ratings() : undefined,
    hold: r2(m.holdT),
    gp: m.plan[0] !== 'balanced' || m.plan[1] !== 'balanced' ? [GAME_PLANS.indexOf(m.plan[0]), GAME_PLANS.indexOf(m.plan[1])] : undefined,
    mo: Math.abs(m.momentum.value) > 0.005 ? r2(m.momentum.value) : undefined,
  };
}

/** Basic structural validation of a decoded snapshot (client side). */
export function isSnapshot(x: unknown): x is Snapshot {
  const s = x as Snapshot;
  return !!s && s.k === 's' && Array.isArray(s.p) && s.p.length === 22 * PLAYER_STRIDE && Array.isArray(s.b) && s.b.length >= 9;
}

/** Match clock text. In added time it shows the end of the half and the minutes over: "45:00 +1:20". */
/** Match minute for goal lists, e.g. 23' or 45+2'. */
export const minuteText = (sec: number, half: Half) => {
  const end = halfStart(half) + halfLength(half), m = Math.floor(sec / 60) + 1;
  return sec >= end ? `${end / 60}+${Math.floor((sec - end) / 60) + 1}'` : `${m}'`;
};
export const clockText = (sec: number, half?: Half) => {
  const end = half ? halfStart(half) + halfLength(half) : (sec > MATCH.footballSecondsPerHalf ? 2 : 1) * MATCH.footballSecondsPerHalf;
  const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  if (half && sec > end) { const o = sec - end; return `${end / 60}:00 +${Math.floor(o / 60)}:${String(Math.floor(o % 60)).padStart(2, '0')}`; }
  return mmss(Math.min(sec, half ? end : MATCH.footballSecondsPerHalf * 2));
};
