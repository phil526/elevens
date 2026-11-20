import { drillTask } from '../shared/controldrill';
import type { GamePlan, Half } from '../shared/config';
import type { MatchWeather } from '../shared/weather';
import type { Rated } from '../shared/ratings';
import type { Shootout } from '../shared/types';
// What the renderer, HUD and audio read each frame. Offline it is built from
// the local Match; online it is built from interpolated server snapshots.

import type { Match } from '../shared/match';
import type { PlayerDef, Role, TeamDef } from '../shared/teams';
import type { ActionType, BallState, FlightKind, GoalRecord, KickKind, MatchEvent, Phase, RestartType, SkillMove, TeamStats, V2, V3 } from '../shared/types';

export interface ViewPlayer {
  id: number;
  team: 0 | 1;
  role: Role;
  def: PlayerDef;
  pos: V2;
  vel: V2;
  facing: number;
  stamina: number;
  sprinting: boolean;
  jockeying: boolean;
  cards: number; // 0 none, 1 booked, 2 sent off
  off: boolean;
  /** Calling for the ball (arm up). */
  calling?: boolean;
  action: { type: ActionType; t: number; dur: number; kind?: KickKind; target?: V3; skill?: SkillMove; side?: number; variant?: string; windup?: number };
}

export interface ViewState {
  teams: [TeamDef, TeamDef];
  kits: ['home' | 'away', 'home' | 'away'];
  players: ViewPlayer[];
  ball: { pos: V3; vel: V3; state: BallState; owner: number; flight: FlightKind; lastTouchTeam: number };
  phase: Phase;
  phaseT: number;
  half: Half;
  shootout: Shootout | null;
  subs: [number, number, number][];
  attempts: number; // practice: attempts so far // substitutions made: team, slot, bench index
  clock: number;
  addedTime: number;
  score: [number, number];
  restart: { type: RestartType; team: number; taker: number; ready: boolean; spot: V2; readyT: number; aim: V2; quick?: boolean; curve?: number; dip?: number; shake?: number; stutter?: boolean; gkCommit?: number } | null;
  /** Home crowd momentum, -1 (away side on top) .. 1 (home side on top); 0 when the setting is off. */
  momentum?: number;
  ctl: [number, number];
  next: [number, number];
  humans: [boolean, boolean];
  /** Local co-op: the second human's player on each side (-1: none). */
  mates?: [number, number];
  attackDir: [number, number];
  goals: GoalRecord[];
  stats: [TeamStats, TeamStats];
  /** Player ratings, at half time and full time. */
  ratings?: Rated[];
  holdT: number;
  realMinutes: number;
  /** Each side's game plan (live tactics). */
  plans: [GamePlan, GamePlan];
  /** The match's weather (what it does to the ball is in the simulation). */
  weather: MatchWeather;
  /** An injured player being treated (offline matches), for the physios and stretcher. */
  injury?: { pid: number; severity: number; t: number; stage: string; at: V2; edge: V2 } | null;
  /** Skill games: the targets in the goal, and which way team 0 attacks. */
  skill?: { game: string; points: number; targets: { z: number; y: number; r: number; pts: number; hit: boolean }[]; dir: number; gate?: { x: number; z: number; ax: number; az: number; w: number } | null; timeLeft?: number; task?: string } | null;
}

export function possessionTeam(v: ViewState): number {
  if (v.ball.owner >= 0) return v.players[v.ball.owner].team;
  if (v.ball.state === 'flight' && v.ball.flight !== 'deflect') return v.ball.lastTouchTeam;
  return -1;
}

/** Live view of a local Match. Positions are interpolated between the previous and current tick. */
export class MatchViewBuilder {
  private prevPos: V2[] = [];
  private prevBall: V3 = { x: 0, y: 0, z: 0 };
  view: ViewState;

  constructor(private m: Match) {
    this.view = {
      teams: m.teams, kits: m.cfg.kits, players: [], ball: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1, flight: 'none', lastTouchTeam: -1 },
      phase: m.phase, phaseT: 0, half: 1, clock: 0, addedTime: 0, shootout: null, subs: [], attempts: 0, score: [0, 0], restart: null, ctl: [0, 0], next: [-1, -1], humans: [false, false], attackDir: [1, -1],
      goals: [], stats: m.stats, holdT: 0, realMinutes: m.cfg.realMinutes, plans: [...m.plan] as [GamePlan, GamePlan], weather: m.weather,
    };
    this.view.players = m.players.map((p) => ({ id: p.id, team: p.team, role: p.role, def: p.def, pos: { ...p.pos }, vel: { ...p.vel }, facing: p.facing, stamina: p.stamina, sprinting: false, jockeying: false, cards: 0, off: false, action: { type: 'none', t: 0, dur: 0 } }));
    this.capture();
  }

  /** Call before each simulation step. */
  capture() {
    this.prevPos = this.m.players.map((p) => ({ ...p.pos }));
    this.prevBall = { ...this.m.ball.pos };
  }

  build(alpha: number): ViewState {
    const m = this.m;
    const v = this.view;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    m.players.forEach((p, i) => {
      const vp = v.players[i];
      const pp = this.prevPos[i] ?? p.pos;
      // Teleports (restarts) must not be smeared across the screen.
      const jump = Math.abs(pp.x - p.pos.x) + Math.abs(pp.z - p.pos.z) > 3;
      vp.pos.x = jump ? p.pos.x : lerp(pp.x, p.pos.x);
      vp.pos.z = jump ? p.pos.z : lerp(pp.z, p.pos.z);
      vp.vel.x = p.vel.x; vp.vel.z = p.vel.z;
      vp.facing = p.facing;
      vp.stamina = p.stamina;
      vp.def = p.def; // changes with a substitution
      vp.sprinting = p.sprinting;
      vp.jockeying = p.jockeying;
      vp.cards = p.cards;
      vp.off = p.off;
      vp.calling = p.callUntil > m.time;
      vp.action = p.action;
    });
    const b = m.ball;
    const jump = Math.abs(this.prevBall.x - b.pos.x) + Math.abs(this.prevBall.z - b.pos.z) > 3;
    v.ball.pos = jump ? { ...b.pos } : { x: lerp(this.prevBall.x, b.pos.x), y: lerp(this.prevBall.y, b.pos.y), z: lerp(this.prevBall.z, b.pos.z) };
    v.ball.vel = b.vel;
    v.ball.state = b.state;
    v.ball.owner = b.owner;
    v.ball.flight = b.flight;
    v.ball.lastTouchTeam = b.lastTouchTeam;
    v.phase = m.phase;
    v.phaseT = m.phaseT;
    v.half = m.half;
    v.clock = m.displayClock;
    v.addedTime = m.addedTime;
    v.subs = m.subsLog;
    v.attempts = m.drillAttempts;
    v.shootout = m.shootout ? { kicks: [[...m.shootout.kicks[0]], [...m.shootout.kicks[1]]], team: m.shootout.team, winner: m.shootout.winner } : null;
    v.score = m.score;
    const r = m.restart;
    v.restart = r ? { type: r.type, team: r.team, taker: r.taker, ready: r.ready, spot: r.spot, readyT: r.readyT, aim: r.aim, quick: !!r.quick, curve: r.curve ?? 0, dip: r.dip ?? 0, shake: r.shake ?? 0, stutter: !!r.stutter, gkCommit: r.gk?.commit ? r.gk.commit.side : undefined } : null;
    v.momentum = m.momentum.on ? m.momentum.value : undefined;
    v.ctl = [m.ctrl[0].pid, m.ctrl[1].pid];
    v.next = [m.ctrl[0].next, m.ctrl[1].next];
    v.humans = [m.ctrl[0].human, m.ctrl[1].human];
    v.mates = [m.mates[0]?.human ? m.mates[0].pid : -1, m.mates[1]?.human ? m.mates[1].pid : -1];
    v.attackDir = [m.attackDir(0), m.attackDir(1)];
    v.goals = m.goals;
    v.stats = m.stats;
    v.ratings = m.phase === 'fulltime' || m.phase === 'halftime' ? m.ratings() : undefined;
    v.holdT = m.holdT;
    v.plans = m.plan;
    const j = m.injury;
    v.injury = j ? { pid: j.pid, severity: j.severity, t: j.t, stage: j.stage, at: j.at, edge: j.edge } : null;
    const cd = m.ctlDrill;
    v.skill = m.skill ? { game: m.skill.game, points: m.skill.points, targets: m.skill.targets, dir: m.attackDir(0), gate: cd?.gate ?? null, timeLeft: cd?.timeLeft, task: cd ? drillTask(cd) : undefined } : null;
    return v;
  }
}

export type { MatchEvent };
