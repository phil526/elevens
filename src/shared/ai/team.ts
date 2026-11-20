// Layered AI (DESIGN §8): team plan -> role positions -> individual behaviour.
// Plans refresh at 10 Hz; per-player movement intentions every tick.

import { DIFFICULTY, MENTALITY, PITCH, applyGamePlan, type MentalityParams } from '../config';
import { laneBlock, pressureOn } from '../kick';
import { angleOf, clamp, dist, norm, wrapAngle } from '../math';
import { jogSpeed, sprintTop } from '../movement';
import { FORMATION_POS, defaultTactics, footProfile, isDefender, isForward, isMidfielder, type Role, type Tactics } from '../teams';
import type { Match, KickRequest } from '../match';
import type { Player, Restart, V2 } from '../types';
import { carrierAI } from './carrier';
import { gameState, scoreMentality } from './gamestate';
import { applyPlayStyle, styleOf } from '../playstyle';
import { SP_ON, aiPenalty, favouriteSide, setPieceRatings, takerSideZ, techVariant } from '../setpieces';
import { G6 } from '../switches';
import { updateHumanKeeper, updateKeeper } from './keeper';
import { LINK, applySetPiece, bestPartner, forwardRestartOption, blindRun, blindTarget, boxMarkSpot, linkLevel, overlapAround, secondBalls, setPieceDefence, setPieceMarkSpot, shotLine, trackBoxRunners, underlapInside, underlapTo, unseenRunner, wantUnderlap, MATES3 } from './mates3';

/** A team's instructions (formation and sliders). */
export const tacticsOf = (m: Match, team: number): Tactics => m.cfg.tactics?.[team] ?? DEFAULT_TACTICS;
const DEFAULT_TACTICS = defaultTactics();
/** Reference position for a role in the team's formation. */
export const basePos = (m: Match, team: number, role: Role) => FORMATION_POS[tacticsOf(m, team).formation][role];
/** Mentality with the sliders applied: line height moves the block, pressing changes how many go and from how far. */
export function mentalityOf(m: Match, team: number): MentalityParams {
  const base = scoreMentality(applyGamePlan(applyPlayStyle(slidersOf(m, team), styleOf(m, team)), m.plan[team]), gameState(m, team));
  // The home crowd's lift (19 Nov 2026): a computer-run home side on top hunts the ball harder.
  const lift = team === 0 && !m.ctrl[team].human ? m.momentum.lift() : 0;
  return lift > 0.4 ? { ...base, pressers: Math.min(4, base.pressers + 1), pressRadius: base.pressRadius + 3 * lift } : base;
}
function slidersOf(m: Match, team: number): MentalityParams {
  const ment = MENTALITY[m.cfg.mentality[team]];
  const t = tacticsOf(m, team);
  if (!t.line && !t.press) return ment;
  return { ...ment, lineOffset: ment.lineOffset + 3 * t.line, pressers: Math.max(1, Math.min(4, ment.pressers + Math.round(t.press / 2 + (t.press > 0 ? 0.01 : -0.01)))), pressRadius: ment.pressRadius + 2.5 * t.press };
}
/** Width slider: how far the team spreads across the pitch. */
const widthK = (m: Match, team: number) => 1 + 0.08 * tacticsOf(m, team).width;

/** Set-piece routines, cycled by the taker's switch button (Q / LB / RUN) before the kick. */
export const ROUTINES = {
  corner: ['Standard', 'Near post', 'Far post', 'Short corner', 'Edge of the box'],
  freekick: ['Standard', 'Lay-off', 'Far post', 'Two over the ball', 'Attackers in the wall'],
  throwin: ['Short', 'Long throw into the box'],
} as const;

/** Throw-ins this far up the pitch (team frame x) can be launched into the box. */
export const LONG_THROW_FX = 22;
/** How far a player can throw the ball (m): stronger players launch it further. */
export function throwRange(p: Player): number {
  return 20 + 14 * clamp((throwStrength(p) - 0.5) / 0.35, 0, 1);
}
/** Arm strength for throw-ins, from the player's tackling (physical) and stamina. */
export const throwStrength = (p: Player) => 0.6 * p.a.tackling + 0.4 * p.a.stamina;
/** The team's long-throw specialist: the strongest thrower among the outfield players. */
export function longThrower(m: Match, team: number): Player {
  return m.teamPlayers(team).filter((p) => p.role !== 'GK').sort((a, b) => throwStrength(b) - throwStrength(a))[0];
}

/** Where a routine wants the ball (world coordinates), or null for the standard aim. */
export function routineAim(m: Match, r: Restart): V2 | null {
  const n = r.routine ?? 0;
  if (!n) return null;
  const dir = m.attackDir(r.team);
  const s = Math.sign(toFrame(dir, r.spot).z) || 1;
  if (r.type === 'corner') {
    const f = [null, { x: 47.5, z: s * 3.5 }, { x: 46.5, z: -s * 5 }, { x: 46, z: s * 27 }, { x: 35, z: 0 }][n];
    return f ? fromFrame(dir, f) : null;
  }
  if (r.type === 'freekick') {
    if (n === 1) return layoffSpot(m, r);
    if (n === 2) return fromFrame(dir, { x: 46.5, z: -s * 5.5 });
  }
  return null;
}
/** The lay-off man: the best-shooting midfielder or forward who is not taking the kick. */
export function layoffTaker(m: Match, r: Restart): number {
  const c = m.teamPlayers(r.team).filter((p) => p.id !== r.taker && p.role !== 'GK' && !isDefender(p.role)).sort((a, b) => b.a.shooting - a.a.shooting)[0];
  return c ? c.id : -1;
}
/**
 * Two over the ball (20 Nov 2026): the other free-kick specialist (the opposite foot if there is
 * one) stands beside the ball and runs over it first as a dummy.
 */
export function secondTaker(m: Match, r: Restart): number {
  const tf = footProfile(m.players[r.taker].def).foot;
  const c = m.teamPlayers(r.team).filter((p) => p.id !== r.taker && p.role !== 'GK')
    .sort((a, b) => (footProfile(b.def).foot !== tf ? 12 : 0) + setPieceRatings(b.def).fk - ((footProfile(a.def).foot !== tf ? 12 : 0) + setPieceRatings(a.def).fk))[0];
  return c ? c.id : -1;
}
/** Where the dummy stands: beside the ball on the far side from the taker's run-up. */
export function dummySpot(m: Match, r: Restart): V2 {
  const g = norm(m.attackDir(r.team) * PITCH.halfLength - r.spot.x, -r.spot.z);
  const foot = footProfile(m.players[r.taker].def).foot;
  const lx = g.z, lz = -g.x; // the taker's run comes in from this side for a right-footer
  return { x: r.spot.x - g.x * 1.6 - lx * foot * 1.5, z: r.spot.z - g.z * 1.6 - lz * foot * 1.5 };
}
/** Attackers in the wall: two forwards stand on the end of the defenders' wall, blocking the keeper's view. */
export function wallAttackers(m: Match, r: Restart): number[] {
  return m.teamPlayers(r.team).filter((p) => p.id !== r.taker && p.role !== 'GK' && (isForward(p.role) || p.role === 'RCM' || p.role === 'LCM')).sort((a, b) => b.def.attrs.tackling - a.def.attrs.tackling || a.id - b.id).slice(0, 2).map((p) => p.id);
}

/** Lay-off: a teammate stands beside the ball, a step towards the middle, to set it for a strike. */
function layoffSpot(m: Match, r: Restart): V2 {
  const dir = m.attackDir(r.team);
  const f = toFrame(dir, r.spot);
  return fromFrame(dir, { x: f.x + 1, z: f.z - (Math.sign(f.z) || 1) * 4 });
}

const RUN_CHANCE = 0.4; // chance per plan update (scaled by mentality) that an eligible attacker starts a forward run
// Timed runs for the human's teammates: a short check towards the ball, then a sprint onto the
// shoulder of the last defender, bending along the line so they stay onside until the pass.
// fromFx: runs start once the human's ball is past this depth (frame x; -15 until 20 Nov 2026, now from
// deep in their own half too, so a build-up from the back has someone going forward). reach: how far
// behind the opponents' line a runner can start from (22 until 20 Nov 2026).
const HUMAN_RUN = { chance: 0.14, check: 0.45, length: 2.8, rest: 1.6, maxRunners: 2, fromFx: -30, reach: 30 };
const SHAPE_FROM = 10; // ball depth (m into the opponents' half) from which the attacking shape applies
const AI_RUN_CHANCE = 0.09; // AI teams: per plan update, scaled by mentality and difficulty
// Third-man runs: when a pass is played, a teammate beyond the receiver sets off in behind so the
// receiver can find them first time; a decoy run drags a defender the other way.
const THIRD_MAN = { ai: 0.35, human: 0.45, length: 2.6, decoy: 0.5, decoyLength: 2.2 };

/**
 * Smarter teammates for a human's side (19 Nov). Cover: when the human steps out to press,
 * a teammate drops into the space they left (and, for a defender, the next man in fills behind).
 * Counter-press: for a few seconds after the human's team loses the ball near it, the nearest
 * teammates hunt the carrier and cut the short passes. Overlap: the ball-side full-back runs
 * past a wide carrier on the outside (or inside when the carrier hugs the line).
 */
export const TEAMMATE = {
  /** Cover: the human has stepped this far out of their zone towards the ball. */
  pressOut: 6, pressRange: 13, pressHold: 1.0, fillReach: 24,
  /** Counter-press: how long after the turnover, how close to the ball, and how many go (the human counts). */
  counterWindow: 3.0, counterTurnover: 1.2, counterReach: 16, counterMax: 3, counterTackle: 1.4,
  /** Overlap: chance per plan update once the carrier is wide, run length and rest. */
  overlapChance: 0.12, overlapLength: 3.6, overlapRest: 3.0,
} as const;

/** Switches for the three teammate behaviours (benchmarks turn them off to compare). */
export const TEAMMATE_ON = {
  cover: true, counter: true, overlap: true, stepUp: true, box: true, width: true, call: true, help: true, intercept: true,
  // Third set (ai/mates3.ts): sweeper keeper, box tracking, shot blocks, set-piece marking, second balls,
  // blindside runs, underlaps, auto-switching, partnerships, teammates on the ball.
  sweep: true, track: true, block: true, setPiece: true, second: true, blind: true, underlap: true, switching: true, links: true, onBall: true,
};
/** A player's instruction (-1 stay back, 0 normal, 1 get forward). Only humans can set them. */
export const instrOf = (m: Match, p: Player) => m.instr[p.team]?.[p.slot] ?? 0;
/** Teammates of a human get the smarter off-ball behaviours. */
const humanSide = (m: Match, team: number) => m.ctrl[team].human;
/**
 * More teammate behaviours (19 Nov, ideas 4-10). Step up: the back line pushes up together when the
 * opponents play it backwards or we clear it. Calls: free teammates put an arm up for the ball.
 * Help: a midfielder drops in beside a pressed carrier. Intercept: teammates read passes sooner.
 */
export const MATES2 = {
  stepUp: 6, stepUpHold: 1.3, backPass: 3,
  callMin: 8, callMax: 40, callSpace: 4.5, callLane: 0.25, callers: 2, callHold: 0.6,
  helpPress: 0.5, helpDist: 9,
  interceptAwareness: 0.92, interceptReaction: 0.14, interceptReach: 1.5,
} as const;

export interface TeamPlan {
  team: number;
  inPossession: boolean;
  loose: boolean;
  bx: number; // ball x in team frame (attacking towards +x)
  bz: number;
  pressers: number[];
  cover: number;
  chaser: number;
  /** A second player attacking a loose ball in or around either box (rebounds, scrambles). */
  chaser2: number;
  /** Attackers following a shot in for the rebound, and where they head. */
  followIn: Map<number, V2>;
  interceptor: number;
  interceptPoint: V2 | null;
  supportSpots: Map<number, V2>;
  runners: Set<number>;
  boxTargets: Map<number, V2>;
  marks: Map<number, number>;
  /** Defenders tracking a runner tight, goal-side (sprinting with them), rather than zonally. */
  tightMarks: Set<number>;
  /** Players screening a passing lane from the carrier to a dangerous free opponent. */
  laneCover: Map<number, V2>;
  offsideLineFx: number;
  /** Teammates moving into the space a pressing human (or an overlapping full-back) has left. */
  fill: Map<number, V2>;
  /** Counter-press after losing the ball: null = go at the carrier, a point = cut that passing lane. */
  counter: Map<number, V2 | null>;
  /** Last time this team had the ball, and until when the human's press is treated as on. */
  ownBallAt: number;
  humanPressUntil: number;
  /** Counter-press on until this time, from where the ball was lost. */
  counterUntil: number;
  counterFrom: V2 | null;
  /** The back line steps up together until this time. */
  stepUpUntil: number;
  /** Teammates calling for the ball, and the midfielder dropping in to help a pressed carrier. */
  callers: number[];
  helper: number;
  /** Cross box movement: true once the runners attack their spaces. */
  boxGo?: boolean;
  /** Markers tracking a man in or into our box (goal-side and ball-side of him). */
  boxMarks: Set<number>;
  /** The teammate stepping onto the shot line, and where. */
  blocker: number;
  blockSpot: V2 | null;
  /** Second balls: who attacks where a header or clearance drops, and who waits where it falls next. */
  secondBall: Map<number, V2>;
  /** Zones held for a few seconds after a set piece against us. */
  zones: Map<number, V2>;
  nextAt: number;
  interceptKick: number; // lastKickTime the interception decision was made for
  interceptGo: boolean;
}

const toFrame = (dir: number, p: V2): V2 => ({ x: p.x * dir, z: p.z * dir });
const fromFrame = toFrame;

export const levelOf = (m: Match, team: number) => (m.cfg.difficulty[team] === 'adaptive' ? m.adaptiveLevelParams : DIFFICULTY[m.cfg.difficulty[team]]);

/**
 * Attacking shape once the ball is well into the opponents' half (team frame, attacking +x).
 * The team moves up together: the striker and the far winger occupy the box on the offside
 * line, the far midfielder arrives at its edge, the ball-side players support close behind,
 * and the defence steps up so the gaps between the lines stay short.
 */
function attackingShape(m: Match, p: Player, plan: TeamPlan): V2 {
  const ment = mentalityOf(m, p.team);
  const L = Math.min(plan.offsideLineFx, PITCH.halfLength - 5);
  const bx = plan.bx, bz = plan.bz;
  const s = Math.abs(bz) < 5 ? 0 : Math.sign(bz); // ball side (0: central)
  const side = (home: number) => (s === 0 ? Math.sign(home) || 1 : home * s > 0 ? 1 : -1); // +1 ball side, -1 far side
  const base = basePos(m, p.team, p.role);
  const hz = base.z;
  const f = tacticsOf(m, p.team).formation;
  let x: number, z: number;
  // Formation-specific jobs: 4-4-2's second striker; 4-2-3-1's second holder and No. 10.
  const wide = humanSide(m, p.team) && TEAMMATE_ON.width;
  const job = f === '442' && p.role === 'CDM' ? 'ST2' : f === '4231' && p.role === 'RCM' ? 'DM2' : f === '4231' && p.role === 'LCM' ? 'AM' : p.role;
  switch (job) {
    case 'ST': x = L - 1; z = clamp(bz * 0.15, -4, 4) + (f === '442' ? 3 : 0); break;
    case 'ST2': x = L - 2; z = clamp(bz * 0.15, -4, 4) - 6; break;
    case 'DM2': x = bx - 14; z = clamp(bz * 0.3, -8, 8) + 6; break;
    case 'AM': x = Math.min(L - 5, bx + 3); z = clamp(bz * 0.35, -10, 10); break;
    case 'LW': case 'RW':
      if (side(hz) > 0) { x = Math.min(L - 1, bx + 4); z = Math.sign(hz) * 26; }
      else if (wide && bx < 28 && s !== 0) { x = Math.min(L - 2, bx + 6); z = Math.sign(hz) * 30.5; } // hold the width for the switch
      else { x = L - 1.5; z = Math.sign(hz) * (s === 0 ? 11 : 8); }
      break;
    case 'LCM': case 'RCM':
      if (side(hz) > 0) { x = bx - 7; z = clamp(bz * 0.6, -18, 18) + Math.sign(hz) * 3; }
      else if (bx > 38 && Math.abs(bz) > 9) { x = Math.min(L - 1, 41); z = -Math.sign(bz) * 2; } // arrive for the cut-back
      else { x = Math.min(L - 6, 37); z = Math.sign(hz) * 6; }
      break;
    case 'CDM': x = bx - 15; z = clamp(bz * 0.3, -8, 8) - (f === '4231' ? 6 : 0); break;
    case 'LB': case 'RB':
      if (side(hz) > 0 && (ment.fullbackOverlap || bx > 25)) { x = bx - 5; z = Math.sign(hz) * 30; }
      else if (wide && side(hz) < 0 && s !== 0) { x = bx - 14; z = Math.sign(hz) * 25; }
      else { x = bx - 20; z = Math.sign(hz) * 20; }
      break;
    default: x = Math.min(bx - 24, 14 + ment.lineOffset); z = Math.sign(hz) * 10; // centre-backs
  }
  z *= widthK(m, p.team);
  const ins = instrOf(m, p);
  if (ins > 0) x = Math.min(x + 6, plan.offsideLineFx - 0.6);
  else if (ins < 0) x -= isDefender(p.role) ? 6 : 10;
  x = clamp(x, -PITCH.halfLength + 4, PITCH.halfLength - 3);
  z = clamp(z, -PITCH.halfWidth + 2, PITCH.halfWidth - 2);
  return fromFrame(m.attackDir(p.team), { x, z });
}

/** Role position for player p given the plan (world coordinates). */
export function formationTarget(m: Match, p: Player, plan: TeamPlan): V2 {
  const dir = m.attackDir(p.team);
  const ment = mentalityOf(m, p.team);
  if (plan.inPossession && plan.bx > SHAPE_FROM && p.role !== 'GK') return attackingShape(m, p, plan);
  const base = basePos(m, p.team, p.role);
  const attack = plan.inPossession;
  const pressing = !attack && m.teamPress[p.team] > m.time;
  const blockX = clamp(plan.bx * 0.6 + (attack ? 14 : -2) + ment.lineOffset + (pressing ? 8 : 0), -14, 30);
  let x = base.x * (attack ? 1.0 : 0.8) + blockX;
  let z = base.z * (attack ? 1.12 : 0.78) * widthK(m, p.team) + plan.bz * (attack ? 0.25 : 0.42);
  // Game plans out of possession: drop the forwards and midfield back (park the bus), or keep the forwards up to break (counter).
  if (!attack && ment.dropBack && p.role !== 'GK') x -= ment.dropBack * (isForward(p.role) ? 1 : isMidfielder(p.role) ? 0.5 : 0.15);
  if (!attack && ment.stayHigh && isForward(p.role)) x = Math.max(x, Math.min(plan.bx - 6, -3));
  if (!attack && ment.narrow) z *= 1 - ment.narrow;
  if (!attack && isDefender(p.role)) {
    // Offside trap: the back four step up together towards the ball.
    if (m.offsideTrap[p.team] > m.time) x += 9;
    // A human's back line steps up together when the ball goes backwards (see stepUpCheck).
    else if (plan.stepUpUntil > m.time) x += MATES2.stepUp;
    // Stay goal-side of the ball and never push beyond it.
    x = Math.min(x, plan.bx - (m.offsideTrap[p.team] > m.time ? 1.5 : plan.stepUpUntil > m.time ? 3 : 4));
  }
  const ins = p.role === 'GK' ? 0 : instrOf(m, p);
  if (ins > 0 && attack) x += 6;
  else if (ins > 0 && !isDefender(p.role)) x = Math.max(x, Math.min(plan.bx - 8, x + 6)); // stays up for the break
  else if (ins < 0 && attack) x -= isDefender(p.role) ? 6 : 9;
  // Width for the switch: the far winger and full-back hold the touchline while the ball is on the other wing.
  if (attack && humanSide(m, p.team) && TEAMMATE_ON.width && Math.abs(plan.bz) > 10 && (p.role === 'LW' || p.role === 'RW' || p.role === 'LB' || p.role === 'RB') && Math.sign(base.z) * Math.sign(plan.bz) < 0) {
    z = Math.sign(base.z) * (isForward(p.role) ? 30.5 : 26);
  }
  // Forwards stretch the opposing back line once the ball is past halfway.
  if (attack && isForward(p.role) && plan.bx > -10) x = Math.max(x, plan.offsideLineFx - 3);
  if (attack && (isForward(p.role) || ins > 0)) x = Math.min(x, plan.offsideLineFx - 0.6);
  if (attack && (p.role === 'RCB' || p.role === 'LCB')) x = Math.min(x, plan.bx - 8, 8 + ment.lineOffset);
  if (attack && (p.role === 'RB' || p.role === 'LB') && !ment.fullbackOverlap) x = Math.min(x, plan.bx - 2);
  x = clamp(x, -PITCH.halfLength + 4, PITCH.halfLength - 3);
  z = clamp(z, -PITCH.halfWidth + 2, PITCH.halfWidth - 2);
  return fromFrame(dir, { x, z });
}

/** Time for p to reach the ball's path, scanning the shared ball prediction cheaply. */
function interceptTime(m: Match, p: Player, maxT = 2.2): { t: number; pt: V2 } | null {
  const pt = m.meetPoint(p, maxT, 2.2);
  if (!pt) return null;
  return { t: dist(p.pos, pt) / (sprintTop(p.a) * 0.9), pt };
}

/** Rebounds: how long after a shot attackers follow in, how many, and how far out they aim for. */
export const REBOUND = { window: 2.4, followers: 2, depth: 7 } as const;
/** A loose ball worth a scramble: within about 22 m of either goal line and inside the width of the area plus a bit. */
const looseInBox = (pos: V2) => Math.abs(pos.x) > PITCH.halfLength - 22 && Math.abs(pos.z) < 24;

export function planTeams(m: Match) {
  for (const team of [0, 1]) {
    const old = m.plans[team as 0 | 1];
    if (old && m.time < old.nextAt) continue;
    // Skill games leave a side with nobody on the pitch: no plan to make.
    if (!m.teamPlayers(team).some((p) => p.role !== 'GK')) continue;
    aiOffsideTrap(m, team);
    m.plans[team as 0 | 1] = buildPlan(m, team, old);
  }
}

/** Pressing sides run the offside trap (19 Nov 2026): chance per plan update when a forward pass is on. */
export const AI_TRAP = { chance: 0.05, lineGap: 3 } as const;

/**
 * A computer side that presses high springs the offside trap when the opposing carrier in midfield
 * is facing forward and an attacker is on the shoulder of its last defender, running in behind.
 */
function aiOffsideTrap(m: Match, team: number) {
  if (!G6.aiTrap || m.ctrl[team].human || styleOf(m, team) !== 'press' || m.offsideTrap[team] > m.time) return;
  const b = m.ball;
  if (b.state !== 'dribble' || b.owner < 0) return;
  const c = m.players[b.owner];
  if (c.team === team) return;
  const own = Math.sign(m.ownGoalX(team));
  const cfx = c.pos.x * -own; // how far the carrier is into our half (+ = in our half)
  if (cfx < -15 || cfx > 25) return;
  const facing = Math.cos(c.facing) * own > 0.4; // facing our goal
  if (!facing) return;
  let line = Infinity;
  for (const p of m.teamPlayers(team)) if (p.role !== 'GK') line = Math.min(line, Math.abs(p.pos.x - own * PITCH.halfLength));
  const runner = m.teamPlayers(1 - team).some((o) => o.id !== c.id && Math.abs(Math.abs(o.pos.x - own * PITCH.halfLength) - line) < AI_TRAP.lineGap && o.vel.x * own > 3);
  if (runner && m.rng.chance(AI_TRAP.chance)) m.startOffsideTrap(team as 0 | 1);
}

function buildPlan(m: Match, team: number, old: TeamPlan | null): TeamPlan {
  const b = m.ball;
  const dir = m.attackDir(team);
  const lvl = levelOf(m, team);
  const ment = mentalityOf(m, team);
  const bf = toFrame(dir, b.pos);
  const pt = m.possessionTeam();
  const inPossession = pt === team;
  const loose = pt < 0;
  const squad = m.teamPlayers(team).filter((p) => p.role !== 'GK');
  const opp = m.teamPlayers(1 - team);
  const oppFx = opp.map((o) => o.pos.x * dir).sort((a, c) => c - a);
  const plan: TeamPlan = {
    team, inPossession, loose, bx: bf.x, bz: bf.z, pressers: [], cover: -1, chaser: -1, chaser2: -1, followIn: new Map(), interceptor: -1, interceptPoint: null,
    supportSpots: new Map(), runners: new Set(), boxTargets: new Map(), marks: new Map(), tightMarks: new Set(), laneCover: new Map(),
    offsideLineFx: Math.max(oppFx[1] ?? 0, bf.x, 0), nextAt: m.time + 0.1,
    fill: new Map(), counter: new Map(), ownBallAt: inPossession ? m.time : old?.ownBallAt ?? -99, humanPressUntil: old?.humanPressUntil ?? -1,
    counterUntil: inPossession ? -1 : old?.counterUntil ?? -1, counterFrom: inPossession ? null : old?.counterFrom ?? null,
    stepUpUntil: inPossession ? -1 : old?.stepUpUntil ?? -1, callers: [], helper: -1,
    boxMarks: new Set(), blocker: -1, blockSpot: null, secondBall: new Map(), zones: new Map(),
    interceptKick: old?.interceptKick ?? -1, interceptGo: old?.interceptGo ?? false,
  };

  const byTime = squad
    .map((p) => ({ p, t: dist(p.pos, b.pos) / jogSpeed(p.a) }))
    .sort((a, c) => a.t - c.t);

  // Ball in flight from the opponents: decide (once per kick, with awareness) whether to attack the lane.
  // A human's teammates read the opponents' passes sooner and step in from further away.
  const sharp = humanSide(m, team) && TEAMMATE_ON.intercept;
  const reaction = sharp ? Math.min(lvl.reaction, MATES2.interceptReaction) : lvl.reaction;
  const awareness = sharp ? Math.max(lvl.interceptAwareness, MATES2.interceptAwareness) : lvl.interceptAwareness;
  if (b.state === 'flight' && b.lastTouchTeam !== team && b.lastTouchTeam >= 0 && m.time - m.lastKickTime > reaction + 0.1 * m.lastKickHelp) {
    if (plan.interceptKick !== m.lastKickTime) {
      plan.interceptKick = m.lastKickTime;
      plan.interceptGo = m.rng.chance(awareness * (1 - 0.3 * m.lastKickHelp));
    }
    if (plan.interceptGo) {
      // Only players already close to the lane can realistically step in.
      const sp = Math.hypot(b.vel.x, b.vel.z);
      const ux = sp > 0.5 ? b.vel.x / sp : 0, uz = sp > 0.5 ? b.vel.z / sp : 0;
      const laneReach = 2.5 + 2.5 * awareness + (sharp ? MATES2.interceptReach : 0);
      let best: { p: Player; t: number; pt: V2 } | null = null;
      for (const { p } of byTime.slice(0, sharp ? 7 : 6)) {
        if (sharp && m.isHumanControlled(p)) continue;
        const rx = p.pos.x - b.pos.x, rz = p.pos.z - b.pos.z;
        const along = rx * ux + rz * uz;
        const perp = Math.abs(rx * uz - rz * ux);
        if (along < 0 || perp > laneReach) continue;
        const it = interceptTime(m, p);
        if (it && (!best || it.t < best.t)) best = { p, ...it };
      }
      if (best) { plan.interceptor = best.p.id; plan.interceptPoint = best.pt; }
    }
  }

  if (loose || (b.state === 'flight' && b.flight === 'deflect')) {
    // Loose ball: the quickest player chases; one more if close.
    let best: Player | null = null, bt = Infinity;
    for (const { p } of byTime.slice(0, 4)) {
      const it = interceptTime(m, p, 2.5);
      const t = it ? it.t : dist(p.pos, b.pos) / sprintTop(p.a);
      if (t < bt) { bt = t; best = p; }
    }
    if (best) plan.chaser = best.id;
    // In or around either box, a second player from each side attacks the loose ball too.
    if (best && looseInBox(b.pos)) {
      let second: Player | null = null, st = Infinity;
      for (const { p } of byTime.slice(0, 4)) {
        if (p.id === best.id || dist(p.pos, b.pos) > 16) continue;
        const it = interceptTime(m, p, 2.5);
        const t = it ? it.t : dist(p.pos, b.pos) / sprintTop(p.a);
        if (t < st) { st = t; second = p; }
      }
      if (second) plan.chaser2 = second.id;
    }
  }

  // Follow a shot in: after our shot, up to two attackers near the box gamble on the rebound.
  const ls = m.lastShot;
  if (ls && ls.team === team && m.time - ls.time < REBOUND.window && b.owner < 0 && b.state !== 'dead') {
    const goalX = dir * PITCH.halfLength;
    const cand = squad
      .filter((p) => p.id !== plan.chaser && p.pos.x * dir > PITCH.halfLength - 30 && Math.abs(p.pos.z) < 24 && !isDefender(p.role))
      .sort((a, c) => dist(a.pos, { x: goalX, z: 0 }) - dist(c.pos, { x: goalX, z: 0 }))
      .slice(0, REBOUND.followers);
    cand.forEach((p, i) => {
      const side = cand.length === 1 ? Math.sign(p.pos.z) * 0.5 : i === 0 ? -1 : 1;
      plan.followIn.set(p.id, { x: goalX - dir * (REBOUND.depth + i * 1.5), z: clamp(side * 3.5, -6, 6) });
    });
  }

  if (!inPossession) {
    // Pressing: the nearest always engages; more by mentality if within the press radius.
    plan.pressers.push(byTime[0].p.id);
    if (m.teamPress[team] > m.time) {
      // Team press called: the three nearest all hunt the ball, wherever it is.
      for (const { p } of byTime.slice(1, 3)) plan.pressers.push(p.id);
    } else for (const { p } of byTime.slice(1, ment.pressers)) {
      if (dist(p.pos, b.pos) < ment.pressRadius) plan.pressers.push(p.id);
    }
    if (m.ctrl[team].human && TEAMMATE_ON.counter) counterPress(m, plan, squad, opp, old);
    if (m.ctrl[team].human && TEAMMATE_ON.stepUp) stepUpCheck(m, plan, opp);
    const busy = (id: number) => plan.pressers.includes(id) || plan.counter.has(id);
    // Cover: the next player best placed between ball and goal.
    const ownGoal = { x: m.ownGoalX(team), z: 0 };
    const coverPt = { x: b.pos.x + norm(ownGoal.x - b.pos.x, -b.pos.z).x * 8, z: b.pos.z + norm(ownGoal.x - b.pos.x, -b.pos.z).z * 8 };
    let cbest = -1, cd = Infinity;
    for (const p of squad) {
      if (busy(p.id) || isForward(p.role) || m.isHumanControlled(p)) continue;
      const d = dist(p.pos, coverPt);
      if (d < cd) { cd = d; cbest = p.id; }
    }
    plan.cover = cbest;
    if (m.ctrl[team].human && TEAMMATE_ON.cover) coverHumanPress(m, plan, squad, old);
    // Track runners entering defenders' zones. Opponents already making a run at our back line
    // are picked up first by the nearest defender, who goes with them goal-side.
    const taken = new Set<number>();
    const trap = m.offsideTrap[team] > m.time || plan.stepUpUntil > m.time;
    if (humanSide(m, team)) {
      // A set piece against us: markers stay with their men, zones are held, for the scramble.
      if (TEAMMATE_ON.setPiece) { applySetPiece(m, plan); for (const a of plan.marks.values()) taken.add(a); }
      // Runners into our box are tracked, goal-side, rather than left while everyone watches the ball.
      if (TEAMMATE_ON.track && !trap) trackBoxRunners(m, plan, squad, opp, old, busy, taken);
    }
    if (!trap) {
      // (A blindside runner isn't picked up until a defender notices him.)
      const runners = opp.filter((o) => o.role !== 'GK' && !o.off && o.id !== b.owner && o.pos.x * dir < 0 && (o.vel.x * -dir > 4.5 || (o.runLane > 0 && o.aiRunUntil > m.time) || o.giveGoUntil > m.time) && !taken.has(o.id) && !unseenRunner(m, o, team));
      for (const o of runners) {
        let best: Player | null = null, bd = 16;
        for (const p of squad) {
          if (!(isDefender(p.role) || p.role === 'CDM') || busy(p.id) || plan.fill.has(p.id) || p.id === plan.cover || plan.marks.has(p.id)) continue;
          const d = dist(p.pos, o.pos);
          if (d < bd) { bd = d; best = p; }
        }
        if (best) { plan.marks.set(best.id, o.id); plan.tightMarks.add(best.id); taken.add(o.id); }
      }
    }
    for (const p of squad) {
      if (plan.marks.has(p.id)) continue;
      if (trap) break; // stepping up together: nobody follows a runner
      if (!(isDefender(p.role) || p.role === 'CDM')) continue;
      if (busy(p.id) || plan.fill.has(p.id) || p.id === plan.cover) continue;
      const home = formationTarget(m, p, plan);
      let mk = -1, md = 11;
      for (const o of opp) {
        if (o.role === 'GK' || taken.has(o.id) || o.id === b.owner || unseenRunner(m, o, team)) continue;
        if (o.pos.x * dir > 5) continue; // only runners in our half
        const d = dist(o.pos, home);
        if (d < md) { md = d; mk = o.id; }
      }
      if (mk >= 0) { plan.marks.set(p.id, mk); taken.add(mk); }
    }
    // Shot line: someone gets between a carrier in range and our goal.
    if (humanSide(m, team) && TEAMMATE_ON.block) shotLine(m, plan, squad);
    coverLanes(m, plan, squad, opp, lvl.interceptAwareness * (m.ball.owner >= 0 && m.ctrl[1 - team].human ? 1 - 0.35 * lvl.help : 1));
  } else {
    const carrier = b.owner >= 0 ? m.players[b.owner] : null;
    if (carrier && carrier.team === team) {
      // Support triangles: the two nearest teammates offer short options on clear lanes, on different
      // angles from the carrier (never stacked in one line), and a third looks for a pocket between
      // the opponents' lines. Spots with room to turn beat spots with a marker tight on the goal side.
      const opps = opp.filter((o) => !o.off);
      const usedAng: number[] = [];
      const press = pressureOn(carrier, m.players);
      const supporters = byTime.filter(({ p }) => p.id !== carrier.id && p.giveGoUntil <= m.time && !(p.runLane >= 4 && p.aiRunUntil > m.time)).slice(0, 3);
      // A teammate with a good understanding with the carrier comes to offer himself (as the third option).
      const partner = humanSide(m, team) && TEAMMATE_ON.links ? bestPartner(m, carrier, 0.4) : null;
      if (partner && !supporters.some(({ p }) => p.id === partner.id) && supporters.length === 3) {
        const q = m.players[partner.id];
        if (!q.off && !m.isHumanControlled(q) && dist(q.pos, carrier.pos) < 25 && q.role !== 'GK' && !(q.runLane >= 4 && q.aiRunUntil > m.time)) supporters[2] = { p: q, t: 0 };
      }
      supporters.forEach(({ p }, i) => {
        const pocket = i === 2;
        let bestSpot: V2 | null = null, bs = -Infinity, bestAng = 0;
        for (const deg of [-150, -120, -90, -60, -35, -15, 15, 35, 60, 90, 120, 150]) {
          if (pocket && Math.abs(deg) > 60) continue;
          const a = (deg * Math.PI) / 180;
          const fx = Math.cos(a), fz = Math.sin(a);
          for (const k of pocket ? [1.5, 1.9] : [0.75, 1, 1.3]) {
            const R = ment.supportDistance * k * (press > 0.5 ? 0.85 : 1); // closer when the carrier is pressed
            const spot = fromFrame(dir, { x: bf.x + fx * R, z: bf.z + fz * R });
            if (Math.abs(spot.x) > PITCH.halfLength - 2 || Math.abs(spot.z) > PITCH.halfWidth - 2) continue;
            const sfx = toFrame(dir, spot).x;
            if (sfx > plan.offsideLineFx - 0.5) continue; // stay onside
            let near = 99, density = 0, tight = 0;
            for (const o of opps) {
              const d = dist(o.pos, spot);
              near = Math.min(near, d);
              if (d < 6) density++;
              if (d < 3 && o.pos.x * dir > sfx) tight = 1; // marker goal-side: hard to turn
            }
            let s = fx * 0.5 - laneBlock(carrier.pos, spot, opps) * 1.2 - dist(p.pos, spot) / 25;
            s -= clamp((4 - near) / 4, 0, 1) + 0.12 * density + 0.35 * tight;
            s += clamp((near - 4) / 6, 0, 0.5); // room to receive and turn
            if (pocket && near > 5 && sfx < plan.offsideLineFx - 4) s += 0.4; // between the lines
            for (const ua of usedAng) {
              const sep = Math.abs(wrapAngle(a - ua));
              if (sep < 0.9) s -= (0.9 - sep) * 2.5; // never stacked in one line
            }
            if (usedAng.length === 1 && !pocket && Math.sign(deg) !== Math.sign(usedAng[0])) s += 0.15; // either side
            if (s > bs) { bs = s; bestSpot = spot; bestAng = a; }
          }
        }
        // Near the touchline a pocket can only be found behind another supporter: skip it then.
        if (pocket && usedAng.some((ua) => Math.abs(wrapAngle(bestAng - ua)) < 0.35)) bestSpot = null;
        if (bestSpot) { plan.supportSpots.set(p.id, bestSpot); usedAng.push(bestAng); }
      });
      const cf = toFrame(dir, carrier.pos);
      if (m.ctrl[team].human && TEAMMATE_ON.overlap && m.isHumanControlled(carrier)) overlapRun(m, plan, squad, carrier);
      if (humanSide(m, team) && m.isHumanControlled(carrier)) {
        // Blindside run off the last defender; an underlap inside a winger holding the touchline.
        if (TEAMMATE_ON.blind) blindRun(m, plan, squad, carrier);
        if (TEAMMATE_ON.underlap) { const fb = underlapInside(m, plan, squad, carrier); if (fb) { plan.runners.add(fb.id); plan.supportSpots.delete(fb.id); plan.boxTargets.delete(fb.id); } }
      }
      // Crossing positions when the carrier is wide in the final third.
      if (cf.x > 28 && Math.abs(cf.z) > 13 && humanSide(m, team) && m.isHumanControlled(carrier) && TEAMMATE_ON.box) {
        crossBox(m, plan, squad, carrier, cf);
      } else if (cf.x > 28 && Math.abs(cf.z) > 13) {
        const s = Math.sign(cf.z);
        const slots: [string, V2][] = [['ST', { x: 47.5, z: s * 3 }], [s > 0 ? 'LW' : 'RW', { x: 46, z: -s * 5 }], [s > 0 ? 'RW' : 'LW', { x: 42, z: 0 }], [s > 0 ? 'LCM' : 'RCM', { x: 36, z: -s * 2 }]];
        for (const [role, pt] of slots) {
          const p = squad.find((q) => q.role === role);
          // Stay onside: no further forward than the second-last defender or the ball.
          const onside = { x: Math.min(pt.x, Math.max(plan.offsideLineFx, cf.x) - 0.5), z: pt.z };
          if (p && p.id !== carrier.id) plan.boxTargets.set(p.id, fromFrame(dir, onside));
        }
      } else if (cf.x > HUMAN_RUN.fromFx && m.isHumanControlled(carrier)) {
        humanTeamRuns(m, plan, squad, carrier, ment.fullbackOverlap, HUMAN_RUN.chance);
      } else if (cf.x > -15) {
        // AI attackers time their runs on the opponents' back line too: a check, then a sprint
        // onto the last defender's shoulder, bending along the line to stay onside.
        humanTeamRuns(m, plan, squad, carrier, ment.fullbackOverlap, AI_RUN_CHANCE * (0.5 + ment.runChance * 2) * (0.6 + 0.5 * lvl.interceptAwareness));
      } else if (cf.x > -15) {
        // Selective forward runs.
        for (const p of squad) {
          if (p.id === carrier.id || plan.supportSpots.has(p.id) || p.giveGoUntil > m.time) continue;
          const eligible = isForward(p.role) || (ment.fullbackOverlap && (p.role === 'RB' || p.role === 'LB'));
          if (!eligible) continue;
          if (p.aiRunUntil > m.time) { plan.runners.add(p.id); continue; }
          if (p.aiHoldUntil > m.time) continue;
          if (m.rng.chance(ment.runChance * RUN_CHANCE)) {
            p.aiRunUntil = m.time + 2.5;
            p.aiHoldUntil = m.time + 4.5;
            plan.runners.add(p.id);
          }
        }
      }
      if (humanSide(m, team) && m.isHumanControlled(carrier)) {
        if (TEAMMATE_ON.help) dropToHelp(m, plan, squad, carrier);
        if (TEAMMATE_ON.call) callForBall(m, plan, squad, carrier);
      }
    } else if (old && humanSide(m, team) && TEAMMATE_ON.box && b.state === 'flight' && b.lastTouchTeam === team && (b.flight === 'cross' || b.flight === 'lob')) {
      // The cross is on its way: the box runners keep attacking their spaces.
      for (const [id, T] of old.boxTargets) if (id !== b.receiver) plan.boxTargets.set(id, T);
    }
  }
  if (humanSide(m, team) && TEAMMATE_ON.second) secondBalls(m, plan, squad);
  return plan;
}

/**
 * Step up: a human's back four push up together, a few metres in one line, when the opponents
 * play the ball backwards (a back pass or a carrier turning back) or we clear it upfield, so their
 * forwards are left offside. Not while one of them is already running at our line.
 */
function stepUpCheck(m: Match, plan: TeamPlan, opp: Player[]) {
  const b = m.ball;
  const dir = m.attackDir(plan.team);
  if (m.restart || b.state === 'dead' || b.state === 'held') { plan.stepUpUntil = -1; return; }
  if (plan.bx < -36) return; // around our box: hold the line, don't step
  const away = (b.vel.x * dir); // + = towards the opponents' goal (away from ours)
  const carrier = b.owner >= 0 ? m.players[b.owner] : null;
  const backPass = b.state === 'flight' && b.lastTouchTeam === 1 - plan.team && away > MATES2.backPass && b.flight !== 'shot';
  const clearance = b.state === 'flight' && b.lastTouchTeam === plan.team && away > 6;
  const turned = !!carrier && carrier.team !== plan.team && carrier.vel.x * dir > MATES2.backPass && Math.cos(carrier.facing) * dir > 0.3;
  if (!(backPass || clearance || turned)) return;
  const running = opp.some((o) => !o.off && o.role !== 'GK' && o.id !== b.owner && o.pos.x * dir < plan.bx && o.vel.x * -dir > 4.5);
  if (running) return;
  plan.stepUpUntil = m.time + MATES2.stepUpHold;
}

/**
 * Box movement for a human's cross: the striker attacks the near post, the far winger the far
 * post, a midfielder arrives late at the penalty spot and another waits on the edge for the
 * clearance or a cut-back. They hold a few metres back until the cross is coming (the carrier is
 * close to the byline or past 36 m), then sprint into their spaces, staying onside. On some
 * attacks the striker and far winger swap posts.
 */
function crossBox(m: Match, plan: TeamPlan, squad: Player[], carrier: Player, cf: V2) {
  const dir = m.attackDir(plan.team);
  const s = Math.sign(cf.z);
  // Near and far are decided by each player's own home side in the formation.
  const wingNear = squad.find((p) => (p.role === 'LW' || p.role === 'RW') && Math.sign(basePos(m, p.team, p.role).z) === s);
  const wingFar = squad.find((p) => (p.role === 'LW' || p.role === 'RW') && Math.sign(basePos(m, p.team, p.role).z) === -s);
  const cmNear = squad.find((p) => (p.role === 'LCM' || p.role === 'RCM') && Math.sign(basePos(m, p.team, p.role).z) === s);
  const cmFar = squad.find((p) => (p.role === 'LCM' || p.role === 'RCM') && Math.sign(basePos(m, p.team, p.role).z) === -s);
  const swap = Math.floor(m.possessionStart * 3) % 3 === 0;
  const st = squad.find((p) => p.role === 'ST');
  const slots: [Player | undefined, V2][] = [
    [swap ? wingFar : st, { x: 47.5, z: s * 3 }], // near post
    [swap ? st : wingFar, { x: 46.5, z: -s * 5.5 }], // far post
    [cmFar, { x: 41.5, z: -s * 1 }], // penalty spot, arriving late
    [cmNear ?? wingNear, { x: 35, z: s * 4 }], // edge of the box
  ];
  if (wingNear && wingNear !== carrier && cmNear) slots.push([wingNear, { x: 44, z: s * 10 }]); // cut-back option
  const go = cf.x > 36 || Math.abs(cf.z) > 27 || m.ctrl[plan.team].input.jockey;
  const used = new Set<number>();
  for (const [p, pt] of slots) {
    if (!p || p.id === carrier.id || p.off || used.has(p.id) || m.isHumanControlled(p) || instrOf(m, p) < 0) continue;
    used.add(p.id);
    // Hold a few metres back and wider, then attack the space.
    const T = go ? pt : { x: pt.x - 5, z: pt.z * 1.4 };
    const onside = { x: Math.min(T.x, Math.max(plan.offsideLineFx, cf.x) - 0.5), z: T.z };
    plan.boxTargets.set(p.id, fromFrame(dir, onside));
    plan.supportSpots.delete(p.id);
  }
  plan.boxGo = go;
}

/**
 * A midfielder drops in to help: when the human on the ball is under pressure, the nearest central
 * midfielder comes to a spot about 9 m away on the side away from the presser, slightly behind,
 * with a clear lane, as the safe way out.
 */
function dropToHelp(m: Match, plan: TeamPlan, squad: Player[], carrier: Player) {
  const opps = m.teamPlayers(1 - plan.team).filter((o) => !o.off);
  if (pressureOn(carrier, m.players) < MATES2.helpPress) return;
  const dir = m.attackDir(plan.team);
  let presser = opps[0], pd = Infinity;
  for (const o of opps) { const d = dist(o.pos, carrier.pos); if (d < pd) { pd = d; presser = o; } }
  const cf = toFrame(dir, carrier.pos), pf = toFrame(dir, presser.pos);
  const away = norm(cf.x - pf.x, cf.z - pf.z);
  const helpers = squad.filter((p) => !p.off && p.id !== carrier.id && !m.isHumanControlled(p) && (p.role === 'CDM' || p.role === 'LCM' || p.role === 'RCM') && instrOf(m, p) <= 0 && !(p.runLane && p.aiRunUntil > m.time))
    .sort((a, c) => dist(a.pos, carrier.pos) - dist(c.pos, carrier.pos));
  const h = helpers[0];
  if (!h || dist(h.pos, carrier.pos) > 30) return;
  let best: V2 | null = null, bs = -Infinity;
  for (const deg of [90, 120, 150, 180, -150, -120, -90]) {
    const a = (deg * Math.PI) / 180;
    const sp = { x: cf.x + Math.cos(a) * MATES2.helpDist, z: cf.z + Math.sin(a) * MATES2.helpDist };
    if (Math.abs(sp.z) > PITCH.halfWidth - 2 || Math.abs(sp.x) > PITCH.halfLength - 3) continue;
    const w = fromFrame(dir, sp);
    let near = 99;
    for (const o of opps) near = Math.min(near, dist(o.pos, w));
    const sc = (Math.cos(a) * away.x + Math.sin(a) * away.z) * 0.8 + Math.min(near, 8) / 8 - laneBlock(carrier.pos, w, opps) * 1.5 - dist(h.pos, w) / 30;
    if (sc > bs) { bs = sc; best = w; }
  }
  if (!best) return;
  plan.supportSpots.set(h.id, best);
  plan.boxTargets.delete(h.id);
  plan.runners.delete(h.id);
  plan.helper = h.id;
}

/**
 * Calling for the ball: up to two teammates who are free (no one within 4.5 m), onside, in range
 * and with a clear lane put an arm up. Forward options and the far side (a switch) count most.
 */
function callForBall(m: Match, plan: TeamPlan, squad: Player[], carrier: Player) {
  const dir = m.attackDir(plan.team);
  const opps = m.teamPlayers(1 - plan.team).filter((o) => !o.off);
  const cf = toFrame(dir, carrier.pos);
  const cand: { p: Player; s: number }[] = [];
  for (const p of squad) {
    if (p.off || p.id === carrier.id || m.isHumanControlled(p)) continue;
    const d = dist(p.pos, carrier.pos);
    if (d < MATES2.callMin || d > MATES2.callMax) continue;
    const f = toFrame(dir, p.pos);
    if (f.x > plan.offsideLineFx + 0.2) continue;
    let near = 99;
    for (const o of opps) near = Math.min(near, dist(o.pos, p.pos));
    if (near < MATES2.callSpace) continue;
    const lane = laneBlock(carrier.pos, p.pos, opps);
    if (lane > MATES2.callLane) continue;
    const s = (f.x - cf.x) / 20 + Math.min(near, 12) / 12 - lane + (Math.abs(cf.z) > 10 && Math.sign(f.z) !== Math.sign(cf.z) && Math.abs(f.z) > 20 ? 0.5 : 0) + (p.callUntil > m.time ? 0.3 : 0) + LINK.call * linkLevel(m, carrier.id, p.id);
    if (s > 0.2) cand.push({ p, s });
  }
  cand.sort((a, c) => c.s - a.s);
  for (const { p } of cand.slice(0, MATES2.callers)) {
    p.callUntil = Math.max(p.callUntil, m.time + MATES2.callHold);
    plan.callers.push(p.id);
  }
}

/**
 * The human has stepped out of their zone to press the ball: the space they left is filled by the
 * nearest teammate from the same line or the one behind, and when a defender moves across, the
 * next man (a holding or central midfielder) drops into the defender's place in turn.
 */
function coverHumanPress(m: Match, plan: TeamPlan, squad: Player[], old: TeamPlan | null) {
  const hc = m.ctrl[plan.team];
  const h = m.players[hc.pid];
  const b = m.ball;
  if (!h || h.off || h.role === 'GK' || b.state === 'dead' || m.restart) return;
  const home = formationTarget(m, h, plan);
  const dBall = dist(h.pos, b.pos);
  const out = dist(h.pos, home);
  const towards = dist(home, b.pos) - dBall; // how much closer to the ball the human is than their zone
  const closing = (h.vel.x * (b.pos.x - h.pos.x) + h.vel.z * (b.pos.z - h.pos.z)) / Math.max(0.5, dBall) > 2 || dBall < 3.5;
  if (dBall < TEAMMATE.pressRange && out > TEAMMATE.pressOut && towards > 3 && closing) plan.humanPressUntil = m.time + TEAMMATE.pressHold;
  if (plan.humanPressUntil <= m.time) return;
  const dir = m.attackDir(plan.team);
  const taken = (p: Player) => p.id === h.id || p.off || plan.pressers.includes(p.id) || plan.counter.has(p.id) || p.id === plan.cover || plan.fill.has(p.id);
  // Deeper players are preferred (they keep the shape behind the ball); forwards only cover forwards.
  const pick = (zone: V2, pool: Player[], reach: number): Player | null => {
    let best: Player | null = null, bs = reach;
    for (const p of pool) {
      if (taken(p)) continue;
      let s = dist(p.pos, zone);
      if (s > reach) continue;
      if ((p.pos.x - zone.x) * dir > 2) s += 5; // has to run back to get there
      if (old?.fill.has(p.id)) s -= 4; // keep the same man on the job
      if (s < bs) { bs = s; best = p; }
    }
    return best;
  };
  const line = (r: Role) => (isDefender(r) ? 0 : isMidfielder(r) ? 1 : 2);
  const hl = line(h.role);
  // A defender's gap: another defender or a midfielder; a midfielder's: another midfielder; a forward's: midfield or attack.
  const pool = squad.filter((p) => (hl === 0 ? line(p.role) <= 1 : hl === 1 ? line(p.role) === 1 : line(p.role) >= 1));
  // Zone a little goal-side of where it would be, so the filler also screens the ball.
  const g = norm(m.ownGoalX(plan.team) - home.x, -home.z);
  const zone = { x: home.x + g.x * 1.5, z: home.z + g.z * 1.5 };
  const f1 = pick(zone, pool, TEAMMATE.fillReach);
  if (!f1) return;
  plan.fill.set(f1.id, zone);
  // A defender shifting across leaves a gap in the back line: the holding or a central midfielder drops in.
  if (isDefender(f1.role)) {
    const z2 = formationTarget(m, f1, plan);
    const f2 = pick(z2, squad.filter((p) => p.role === 'CDM' || p.role === 'LCM' || p.role === 'RCM'), 20);
    if (f2) plan.fill.set(f2.id, z2);
  }
}

/**
 * Counter-press: straight after the human's team loses the ball, the nearest teammates (up to
 * three including the human) hunt it. The first goes at the carrier, the others cut the short
 * passes to the carrier's nearest teammates. Lasts a few seconds, then the team drops into shape.
 */
function counterPress(m: Match, plan: TeamPlan, squad: Player[], opp: Player[], old: TeamPlan | null) {
  const b = m.ball;
  if (m.restart || b.state === 'dead' || b.state === 'held') { plan.counterUntil = -1; return; }
  // The opponent with the ball, or about to receive a pass (pressed as it arrives).
  const carrier = b.owner >= 0 && b.state === 'dribble' ? m.players[b.owner] : b.state === 'flight' && b.lastTouchTeam === 1 - plan.team && b.receiver >= 0 ? m.players[b.receiver] : null;
  if (!carrier || carrier.team === plan.team || carrier.role === 'GK') return;
  // A turnover: the opponents have just won it. The press lasts a few seconds, through their first passes.
  const lostAt = old?.ownBallAt ?? -99;
  if (plan.counterUntil < 0 && b.owner === carrier.id && m.possessionStart - lostAt <= TEAMMATE.counterTurnover && m.time - m.possessionStart < 0.5) {
    plan.counterUntil = m.possessionStart + TEAMMATE.counterWindow;
    plan.counterFrom = { ...carrier.pos };
  }
  if (plan.counterUntil <= m.time) return;
  // They have got out of it: the ball has gone well away from where it was lost.
  if (plan.counterFrom && dist(b.pos, plan.counterFrom) > 25) { plan.counterUntil = -1; return; }
  const dir = m.attackDir(plan.team);
  const h = m.players[m.ctrl[plan.team].pid];
  const humanNear = !!h && !h.off && dist(h.pos, carrier.pos) < 8;
  const deep = toFrame(dir, carrier.pos).x < -30; // in our own third the normal press and cover take over
  const cand = squad
    .filter((p) => !p.off && !m.isHumanControlled(p) && p.role !== 'RCB' && p.role !== 'LCB' && dist(p.pos, carrier.pos) < TEAMMATE.counterReach && !(deep && isDefender(p.role)))
    .filter((p) => !((p.role === 'RB' || p.role === 'LB') && dist(p.pos, carrier.pos) > 10))
    .sort((a, c) => dist(a.pos, carrier.pos) / sprintTop(a.a) - dist(c.pos, carrier.pos) / sprintTop(c.a));
  const n = TEAMMATE.counterMax - (humanNear ? 1 : 0);
  const go = cand.slice(0, n);
  if (!go.length) return;
  // Short options: the carrier's nearest free teammates.
  const lanes = opp
    .filter((o) => !o.off && o.id !== carrier.id && o.role !== 'GK' && dist(o.pos, carrier.pos) < 22)
    .sort((a, c) => dist(a.pos, carrier.pos) - dist(c.pos, carrier.pos))
    .map((o) => ({ x: carrier.pos.x + (o.pos.x - carrier.pos.x) * 0.5, z: carrier.pos.z + (o.pos.z - carrier.pos.z) * 0.5 }));
  let first = true;
  for (const p of go) {
    if (first && !humanNear) { plan.counter.set(p.id, null); first = false; continue; }
    first = false;
    let bi = -1, bd = 14;
    lanes.forEach((L, i) => { const d = dist(p.pos, L); if (d < bd) { bd = d; bi = i; } });
    if (bi < 0) continue;
    plan.counter.set(p.id, lanes[bi]);
    lanes.splice(bi, 1);
  }
  // The man going at the carrier replaces the ordinary first presser.
  for (const [id, T] of plan.counter) if (T === null && !plan.pressers.includes(id)) plan.pressers.unshift(id);
}

/**
 * Overlap: the human carries the ball wide, so the full-back on that side runs past them on the
 * outside, or on the inside (underlap) when the carrier is already hugging the touchline. The
 * holding midfielder slides across into the full-back's place while the run is on.
 */
function overlapRun(m: Match, plan: TeamPlan, squad: Player[], carrier: Player) {
  const dir = m.attackDir(plan.team);
  const cf = toFrame(dir, carrier.pos);
  const s = Math.sign(cf.z) || 1;
  const fb = squad.find((p) => (p.role === 'LB' || p.role === 'RB') && Math.sign(basePos(m, p.team, p.role).z) === s);
  if (!fb || fb.off || fb.id === carrier.id || m.isHumanControlled(fb) || instrOf(m, fb) < 0) return;
  const running = fb.runLane === 6 && fb.aiRunUntil > m.time;
  if (!running) {
    if (Math.abs(cf.z) < 10 || cf.x < -15 || cf.x > 40 || fb.aiHoldUntil > m.time || fb.giveGoUntil > m.time) return;
    const ff = toFrame(dir, fb.pos);
    if (ff.x > cf.x - 1 || dist(fb.pos, carrier.pos) > 32) return; // must come from behind
    if (Math.cos(carrier.facing) * dir < -0.2) return; // carrier facing back
    if (!m.rng.chance(TEAMMATE.overlapChance * (instrOf(m, fb) > 0 ? 2 : 1))) return;
    const under = TEAMMATE_ON.underlap ? wantUnderlap(m, carrier, cf, m.rng.next()) : Math.abs(cf.z) > PITCH.halfWidth - 8;
    fb.runLane = 6;
    fb.runStart = m.time;
    overlapAround.delete(fb);
    fb.runTo = fromFrame(dir, under && TEAMMATE_ON.underlap ? underlapTo(cf, s) : { x: Math.min(cf.x + 14, PITCH.halfLength - 6), z: under ? s * (Math.abs(cf.z) - 9) : s * Math.min(PITCH.halfWidth - 2.5, Math.abs(cf.z) + 6) });
    fb.aiRunUntil = m.time + TEAMMATE.overlapLength;
    fb.aiHoldUntil = m.time + TEAMMATE.overlapLength + TEAMMATE.overlapRest;
  }
  plan.runners.add(fb.id);
  plan.supportSpots.delete(fb.id);
  plan.boxTargets.delete(fb.id);
  // Someone minds the full-back's zone: the holding midfielder, else the near centre-back.
  const zone = fromFrame(dir, { x: clamp(plan.bx - 22, -40, 15), z: s * 18 });
  const minder = squad.find((p) => p.role === 'CDM' && !p.off && !plan.supportSpots.has(p.id) && !m.isHumanControlled(p))
    ?? squad.find((p) => (s * Math.sign(basePos(m, p.team, p.role).z) > 0) && (p.role === 'RCB' || p.role === 'LCB') && !m.isHumanControlled(p));
  if (minder) plan.fill.set(minder.id, zone);
}

/** Target for an overlapping full-back (runLane 6), or null when the run is over. */
function overlapTarget(m: Match, p: Player, plan: TeamPlan): V2 | null {
  if (p.runLane !== 6 || p.aiRunUntil <= m.time || !p.runTo) return null;
  if (!plan.inPossession) { p.aiRunUntil = 0; return null; }
  const dir = m.attackDir(p.team);
  const f = toFrame(dir, p.pos);
  const to = toFrame(dir, p.runTo);
  // Around the carrier (or, on an inside run, the winger holding the touchline): past them, then on into the space.
  const ar = overlapAround.get(p);
  const c = ar !== undefined ? m.players[ar] : m.ball.owner >= 0 ? m.players[m.ball.owner] : null;
  const cz = c ? toFrame(dir, c.pos).z : to.z;
  const cx = c ? toFrame(dir, c.pos).x : f.x;
  const passing = f.x < cx + 1 && Math.abs(f.z - cz) < 2.5;
  const z = passing ? cz + (Math.sign(to.z - cz) || Math.sign(to.z)) * 3.5 : to.z;
  const x = Math.min(Math.max(to.x, cx + 8), plan.offsideLineFx - 0.6, PITCH.halfLength - 5);
  return fromFrame(dir, { x, z: clamp(z, -PITCH.halfWidth + 1.5, PITCH.halfWidth - 1.5) });
}

/**
 * Runs for the human's teammates while the human has the ball, so there is always someone to
 * find: wingers alternate an outside run down the line and a diagonal run inside, the striker
 * runs the channel away from the ball, and (in an attacking mentality) the ball-side full-back
 * overlaps. At most two go at once, and only when the carrier is facing forward.
 */
function humanTeamRuns(m: Match, plan: TeamPlan, squad: Player[], carrier: Player, overlap: boolean, chance: number) {
  const dir = m.attackDir(plan.team);
  const facing = Math.cos(carrier.facing) * dir > -0.2;
  let running = 0;
  const idle: Player[] = [];
  for (const p of squad) {
    if (p.id === carrier.id || p.giveGoUntil > m.time || p.off) continue;
    if (p.runLane >= 4 && p.aiRunUntil > m.time) { plan.runners.add(p.id); plan.supportSpots.delete(p.id); running++; continue; } // third-man or decoy run
    const winger = p.role === 'RW' || p.role === 'LW';
    const fullback = overlap && (p.role === 'RB' || p.role === 'LB') && Math.sign(basePos(m, p.team, p.role).z) === Math.sign(plan.bz || 1);
    const ins = instrOf(m, p);
    if (ins < 0) continue; // stay back: no runs
    const forward = ins > 0 && (p.role === 'LCM' || p.role === 'RCM' || p.role === 'CDM' || p.role === 'RB' || p.role === 'LB');
    if (!winger && p.role !== 'ST' && !fullback && !forward) continue;
    if (p.runLane && p.aiRunUntil > m.time) { plan.runners.add(p.id); plan.supportSpots.delete(p.id); running++; continue; }
    p.runLane = 0;
    if (p.aiHoldUntil > m.time || plan.supportSpots.has(p.id)) continue;
    idle.push(p);
  }
  if (!facing) return;
  for (const p of idle) {
    if (running >= HUMAN_RUN.maxRunners || !m.rng.chance(chance)) continue;
    const f = toFrame(dir, p.pos);
    if (f.x < plan.offsideLineFx - (m.isHumanControlled(carrier) ? HUMAN_RUN.reach : 22)) continue; // too far back to threaten the line
    p.runLane = p.role === 'ST' ? 3 : p.role === 'RB' || p.role === 'LB' ? 1 : p.role === 'LCM' || p.role === 'RCM' || p.role === 'CDM' ? 2 : (m.rng.chance(0.5) ? 1 : 2);
    p.runStart = m.time;
    p.aiRunUntil = m.time + HUMAN_RUN.length;
    p.aiHoldUntil = m.time + HUMAN_RUN.length + HUMAN_RUN.rest;
    plan.runners.add(p.id);
    running++;
    if (running < HUMAN_RUN.maxRunners + 1 && m.rng.chance(THIRD_MAN.decoy * 0.5)) {
      if (startDecoy(m, p, squad.filter((q) => q.id !== carrier.id))) running++;
    }
  }
}

/**
 * Third-man run: a pass has just been played from `passer` to `receiver`. A teammate level with or
 * beyond the receiver sets off in behind the opponents' back line, timed so they are still onside
 * as the receiver takes the ball; the receiver can then find them first time. Sometimes another
 * attacker makes a decoy run the other way to drag a defender out of the gap.
 */
export function thirdManRun(m: Match, passer: Player, receiver: Player) {
  const team = passer.team;
  const plan = m.plans[team as 0 | 1];
  if (!plan || receiver.team !== team || passer.role === 'GK') return;
  const dir = m.attackDir(team);
  const rf = toFrame(dir, receiver.pos);
  if (rf.x < -12 || rf.x > 40) return;
  const human = m.ctrl[team].human;
  const ment = mentalityOf(m, team);
  const chance = human ? THIRD_MAN.human : THIRD_MAN.ai * (0.5 + ment.runChance * 2);
  if (!m.rng.chance(chance)) return;
  const line = plan.offsideLineFx;
  let best: Player | null = null, bs = -Infinity;
  for (const p of m.teamPlayers(team)) {
    if (p.id === passer.id || p.id === receiver.id || p.off || p.role === 'GK' || p.role === 'RCB' || p.role === 'LCB') continue;
    if ((p.runLane >= 4 && p.aiRunUntil > m.time) || p.giveGoUntil > m.time || m.isHumanControlled(p) || instrOf(m, p) < 0) continue;
    const f = toFrame(dir, p.pos);
    const d = dist(p.pos, receiver.pos);
    if (d < 7 || d > 30 || f.x < rf.x - 6 || f.x < line - 25 || f.x > line + 0.5) continue;
    let s = (isForward(p.role) ? 0.6 : p.role === 'LCM' || p.role === 'RCM' ? 0.35 : 0.1) + (f.x - rf.x) / 20 - Math.abs(d - 16) / 30;
    if (p.role === 'RB' || p.role === 'LB') s -= 0.3;
    s += 0.3 * instrOf(m, p) + 0.4 * linkLevel(m, receiver.id, p.id);
    if (s > bs) { bs = s; best = p; }
  }
  if (!best) return;
  const f = toFrame(dir, best.pos);
  // In behind: through the nearest gap in the back line, angled a little towards goal.
  const z = clamp(f.z * 0.7, -22, 22);
  best.runLane = 4;
  best.runStart = m.time;
  best.runTo = fromFrame(dir, { x: Math.min(line + 9, PITCH.halfLength - 7), z });
  best.aiRunUntil = m.time + THIRD_MAN.length;
  best.aiHoldUntil = m.time + THIRD_MAN.length + 1.5;
  thirdMen.set(best, receiver.id);
  if (m.rng.chance(THIRD_MAN.decoy)) startDecoy(m, best, m.teamPlayers(team).filter((q) => q.id !== passer.id && q.id !== receiver.id));
}

/**
 * Pass and move for the human (20 Nov 2026): after a human plays the ball forward or square, the
 * passer (now a computer player) often runs on past the receiver into space for the next ball, as
 * the computer's own midfielders do. Not centre-backs or the keeper, not after a back pass, not
 * when told to stay back.
 */
export const PASS_MOVE = { chance: 0.55, back: 3, maxDist: 25, time: 2.2 };
export function humanPassAndMove(m: Match, passer: Player, receiver: Player) {
  if (passer.role === 'GK' || passer.role === 'LCB' || passer.role === 'RCB' || passer.off || instrOf(m, passer) < 0) return;
  const dir = m.attackDir(passer.team);
  const fx = passer.pos.x * dir;
  if (fx < -30 || fx > 40) return;
  if ((receiver.pos.x - passer.pos.x) * dir < -PASS_MOVE.back || dist(passer.pos, receiver.pos) > PASS_MOVE.maxDist) return;
  if (m.rng.chance(PASS_MOVE.chance)) passer.giveGoUntil = m.time + PASS_MOVE.time;
}

/** Who a third-man runner is waiting on (the receiver of the pass that set the run off). */
const thirdMen = new WeakMap<Player, number>();

/** A decoy run by another forward, away from `runner`'s run, to pull a defender out of the gap. */
function startDecoy(m: Match, runner: Player, pool: Player[]): boolean {
  const dir = m.attackDir(runner.team);
  const plan = m.plans[runner.team as 0 | 1];
  if (!plan) return false;
  const rz = toFrame(dir, runner.runTo ?? runner.pos).z;
  const c = pool.filter((p) => p.id !== runner.id && !p.off && isForward(p.role) && !(p.runLane && p.aiRunUntil > m.time) && !m.isHumanControlled(p) && p.giveGoUntil <= m.time && instrOf(m, p) >= 0)
    .sort((a, b) => Math.abs(toFrame(dir, b.pos).z - rz) - Math.abs(toFrame(dir, a.pos).z - rz))[0];
  if (!c) return false;
  const f = toFrame(dir, c.pos);
  const away = -(Math.sign(rz - f.z) || 1);
  c.runLane = 5;
  c.runStart = m.time;
  // Diagonal across the line towards the near post on the other side, at full speed.
  c.runTo = fromFrame(dir, { x: Math.min(plan.offsideLineFx - 0.6, PITCH.halfLength - 9), z: clamp(f.z + away * 11, -24, 24) });
  c.aiRunUntil = m.time + THIRD_MAN.decoyLength;
  c.aiHoldUntil = m.time + THIRD_MAN.decoyLength + 1.5;
  return true;
}

/** Target for a third-man (4) or decoy (5) run now, or null when the run is over. */
function specialRunTarget(m: Match, p: Player, plan: TeamPlan): { T: V2; mode: 'jog' | 'sprint' } | null {
  if (p.runLane < 4 || p.runLane > 5 || p.aiRunUntil <= m.time || !p.runTo) return null;
  if (!plan.inPossession && !(m.ball.state === 'flight' && m.ball.lastTouchTeam === p.team)) { p.aiRunUntil = 0; return null; }
  const dir = m.attackDir(p.team);
  const f = toFrame(dir, p.pos);
  const to = toFrame(dir, p.runTo);
  if (p.runLane === 5) {
    // Decoy: stay onside, but make it look urgent.
    const x = Math.min(to.x, plan.offsideLineFx - 0.6);
    return { T: fromFrame(dir, { x, z: to.z }), mode: 'sprint' };
  }
  const recv = thirdMen.get(p);
  const received = recv !== undefined && m.ball.owner === recv;
  if (!received) {
    // Timing: drift up to the line while the ball travels to the receiver, staying onside.
    const x = Math.min(to.x, plan.offsideLineFx - 1.2);
    return { T: fromFrame(dir, { x, z: f.z + (to.z - f.z) * 0.3 }), mode: f.x < x - 4 ? 'sprint' : 'jog' };
  }
  // The receiver has it: go in behind.
  if (m.time - m.possessionStart > 1.6) { p.aiRunUntil = 0; return null; } // the moment has gone
  return { T: p.runTo, mode: 'sprint' };
}

/**
 * Passing-lane cover: midfielders and forwards not pressing, covering or marking stand in the
 * lanes from the carrier to the two most dangerous free opponents, so the easy forward pass is
 * cut out (more on higher difficulties).
 */
function coverLanes(m: Match, plan: TeamPlan, squad: Player[], opp: Player[], awareness: number) {
  const b = m.ball;
  const carrier = b.owner >= 0 ? m.players[b.owner] : null;
  if (!carrier || carrier.team === plan.team || b.state !== 'dribble') return;
  const n = awareness > 0.9 ? 2 : awareness > 0.6 ? 1 : 0; // Casual none, Pro one lane, Elite two
  if (!n) return;
  const dir = m.attackDir(plan.team);
  const ours = m.teamPlayers(plan.team).filter((p) => !p.off);
  const threats: { o: Player; s: number }[] = [];
  for (const o of opp) {
    if (o.off || o.role === 'GK' || o.id === carrier.id) continue;
    const d = dist(o.pos, carrier.pos);
    if (d < 8 || d > 32) continue;
    // Forward of the carrier (towards our goal), free, and the lane still open.
    const ahead = (carrier.pos.x - o.pos.x) * dir; // >0: nearer our goal than the carrier
    if (ahead < 2) continue;
    let free = 99;
    for (const q of ours) free = Math.min(free, dist(q.pos, o.pos));
    if (free < 3) continue;
    const lane = laneBlock(carrier.pos, o.pos, ours);
    if (lane > 0.5) continue;
    threats.push({ o, s: ahead / 15 + Math.min(free, 10) / 10 - lane });
  }
  threats.sort((a, c) => c.s - a.s);
  const used = new Set<number>();
  for (const { o } of threats.slice(0, n)) {
    const L = { x: carrier.pos.x + (o.pos.x - carrier.pos.x) * 0.55, z: carrier.pos.z + (o.pos.z - carrier.pos.z) * 0.55 };
    let best: Player | null = null, bd = 13;
    for (const p of squad) {
      if (used.has(p.id) || plan.pressers.includes(p.id) || plan.counter.has(p.id) || plan.fill.has(p.id) || p.id === plan.cover || plan.marks.has(p.id) || isDefender(p.role) || p.id === plan.blocker || plan.zones.has(p.id)) continue;
      const d = dist(p.pos, L);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { plan.laneCover.set(best.id, L); used.add(best.id); }
  }
}

/** Where a timed run is heading now (world coordinates), or null for an ordinary forward run. */
function humanRunTarget(m: Match, p: Player, plan: TeamPlan): { T: V2; mode: 'jog' | 'sprint' } | null {
  if (!p.runLane || p.aiRunUntil <= m.time) return null;
  const dir = m.attackDir(p.team);
  const f = toFrame(dir, p.pos);
  const side = Math.sign(basePos(m, p.team, p.role).z) || 1;
  const line = Math.min(plan.offsideLineFx - 0.4, PITCH.halfLength - 7);
  if (m.time - p.runStart < HUMAN_RUN.check) {
    // Check: a few steps towards the ball to pull the marker, then go.
    return { T: fromFrame(dir, { x: f.x - 3, z: f.z + (plan.bz - f.z) * 0.15 }), mode: 'jog' };
  }
  let z: number;
  if (p.runLane === 1) z = side * 25;
  else if (p.runLane === 2) z = side * 8;
  else z = clamp(-Math.sign(plan.bz || side) * 9, -12, 12);
  // Bend along the line once level with it: keep moving across rather than stopping offside.
  if (f.x > line - 1.5) z = f.z + clamp(z - f.z, -6, 6);
  return { T: fromFrame(dir, { x: Math.max(line, f.x - 2), z: clamp(z, -PITCH.halfWidth + 2, PITCH.halfWidth - 2) }), mode: 'sprint' };
}

/** Per-tick behaviour for every AI-controlled player. */
export function updateAI(m: Match, dt: number) {
  planTeams(m);
  // A keeper holding the ball (after a save or catch, ready to kick or throw it out).
  const holder = m.ball.state === 'held' && m.ball.owner >= 0 ? m.players[m.ball.owner] : null;
  for (const p of m.players) {
    if (p.off) continue;
    if (m.isHumanControlled(p)) {
      // A keeper the human has taken over still positions himself until steered, and still saves what they don't dive for.
      if (p.role === 'GK' && !(m.ball.owner === p.id && m.ball.state === 'dribble')) {
        const c = m.controlOf(p)!;
        updateHumanKeeper(m, p, dt, Math.hypot(c.input.mx, c.input.mz) > 0.25);
      }
      continue;
    }
    const at = p.action.type;
    if (at === 'stumble' || at === 'down' || at === 'dive' || at === 'tackle' || at === 'slide' || at === 'skill' || at === 'barge') continue;
    // Opponents can't challenge a keeper with the ball in hand: they clear out of the area and wait.
    if (holder && holder.team !== p.team && p.role !== 'GK' && m.inPenaltyArea(holder.team, p.pos, 1.5)) { leaveArea(m, p, holder.team); continue; }
    // A keeper with the ball at their feet (e.g. from a back-pass) plays like an outfield carrier.
    if (m.ball.owner === p.id && m.ball.state === 'dribble') { carrierAI(m, p, dt); continue; }
    if (p.role === 'GK') { updateKeeper(m, p, dt); continue; }
    offBall(m, p, dt);
  }
}

/** Walk or run out of `team`'s penalty area by the shortest way: past the edge of the box or out to its side. */
export function leaveArea(m: Match, p: Player, team: number) {
  const gx = m.ownGoalX(team);
  const dir = m.attackDir(team);
  const front = { x: gx + dir * (PITCH.penaltyAreaDepth + 2.5), z: p.pos.z };
  const side = { x: p.pos.x, z: (Math.sign(p.pos.z) || 1) * (PITCH.penaltyAreaHalfWidth + 2.5) };
  const T = dist(p.pos, side) < dist(p.pos, front) ? side : front;
  m.arrive(p, T, dist(p.pos, T) > 6 ? 'sprint' : 'jog', faceBall(m, p));
}

function faceBall(m: Match, p: Player) {
  return angleOf(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z);
}

function offBall(m: Match, p: Player, dt: number) {
  const plan = m.plans[p.team]!;
  const b = m.ball;
  const lvl = levelOf(m, p.team);
  const dir = m.attackDir(p.team);
  const fb = faceBall(m, p);

  if (plan.interceptor === p.id && plan.interceptPoint) {
    m.arrive(p, plan.interceptPoint, 'sprint');
    return;
  }
  if (b.state === 'flight' && b.receiver === p.id) {
    const meet = receivePoint(m, p);
    if (meet) { m.arrive(p, meet, dist(p.pos, meet) > 2 ? 'sprint' : 'jog', openBody(m, p, fb)); return; }
  }
  if (plan.chaser === p.id || plan.chaser2 === p.id) {
    const meet = m.meetPoint(p) ?? { x: b.pos.x, z: b.pos.z };
    m.arrive(p, meet, 'sprint');
    return;
  }
  const follow = plan.followIn.get(p.id);
  if (follow && b.owner < 0) {
    m.arrive(p, follow, 'sprint', fb);
    return;
  }
  // Second balls: attack where the header or clearance drops, or wait where it will fall next.
  const sb = plan.secondBall.get(p.id);
  if (sb) {
    m.arrive(p, sb, dist(p.pos, sb) > 1.5 ? 'sprint' : 'jog', fb);
    return;
  }
  const carrier = b.owner >= 0 ? m.players[b.owner] : null;
  if (plan.counter.has(p.id) && b.state === 'flight' && b.receiver >= 0) {
    // Counter-press while their pass travels: close down the receiver, or keep cutting the lane.
    const L = plan.counter.get(p.id) as V2 | null;
    const r = m.players[b.receiver];
    const T = L ?? { x: r.pos.x + (m.ownGoalX(p.team) - r.pos.x > 0 ? 1 : -1) * 1.2, z: r.pos.z };
    m.arrive(p, T, 'sprint', fb);
    return;
  }
  if (!plan.inPossession && carrier && carrier.team !== p.team) {
    const ownGoal = { x: m.ownGoalX(p.team), z: 0 };
    const g = norm(ownGoal.x - carrier.pos.x, ownGoal.z - carrier.pos.z);
    // Contain: the human asked this teammate to press the carrier.
    if (m.contain[p.team] === p.id) {
      const approach = { x: carrier.pos.x + g.x * 1.5, z: carrier.pos.z + g.z * 1.5 };
      const d = dist(p.pos, carrier.pos);
      m.arrive(p, approach, d > 4 ? 'sprint' : 'jockey', d > 4 ? null : fb);
      maybeTackle(m, p, carrier, dt, lvl.tackleEagerness * 0.6);
      return;
    }
    if (plan.counter.has(p.id)) {
      const L = plan.counter.get(p.id) as V2 | null;
      if (L === null) {
        // Counter-press: straight at the ball, no backing off, a sharper tackle.
        const approach = { x: carrier.pos.x + g.x * 0.9, z: carrier.pos.z + g.z * 0.9 };
        const d = dist(p.pos, carrier.pos);
        m.arrive(p, approach, d > 2.5 ? 'sprint' : 'jockey', d > 2.5 ? null : fb);
        maybeTackle(m, p, carrier, dt, lvl.tackleEagerness * TEAMMATE.counterTackle);
      } else {
        m.arrive(p, L, dist(p.pos, L) > 1.5 ? 'sprint' : 'jog', fb);
        maybeTackle(m, p, carrier, dt, lvl.tackleEagerness * 0.5);
      }
      return;
    }
    if (plan.blocker === p.id) {
      // On the shot line, a few metres off the carrier, ready to throw a body in front of it.
      const S = { x: carrier.pos.x + g.x * MATES3.blockStand, z: carrier.pos.z + g.z * MATES3.blockStand };
      m.arrive(p, S, dist(p.pos, S) > 2.5 ? 'sprint' : 'jog', fb);
      return;
    }
    if (plan.pressers[0] === p.id) {
      const approach = { x: carrier.pos.x + g.x * 1.3, z: carrier.pos.z + g.z * 1.3 };
      const d = dist(p.pos, carrier.pos);
      if (d > 5) m.arrive(p, approach, 'sprint');
      else m.arrive(p, approach, 'jockey', fb);
      maybeTackle(m, p, carrier, dt, lvl.tackleEagerness);
      return;
    }
    if (plan.pressers.includes(p.id)) {
      const pt = { x: carrier.pos.x + g.x * 4, z: carrier.pos.z + g.z * 4 + (p.pos.z > carrier.pos.z ? 2 : -2) };
      m.arrive(p, pt, dist(p.pos, pt) > 6 ? 'sprint' : 'jog', fb);
      maybeTackle(m, p, carrier, dt, lvl.tackleEagerness * 0.5);
      return;
    }
    if (plan.cover === p.id) {
      const pt = { x: carrier.pos.x + g.x * 8, z: carrier.pos.z + g.z * 8 };
      m.arrive(p, pt, dist(p.pos, pt) > 8 ? 'sprint' : 'jog', fb);
      return;
    }
  }
  if (!plan.inPossession && plan.marks.has(p.id)) {
    const o = m.players[plan.marks.get(p.id)!];
    const ownGoal = { x: m.ownGoalX(p.team), z: 0 };
    const g = norm(ownGoal.x - o.pos.x, ownGoal.z - o.pos.z);
    if (plan.boxMarks.has(p.id)) {
      // Tracking a runner in our box: goal-side and ball-side of him, eyes on the man.
      const mark = boxMarkSpot(m, p, o);
      m.arrive(p, mark, dist(p.pos, mark) > 1.2 ? 'sprint' : 'jog', fb);
      return;
    }
    if (plan.tightMarks.has(p.id)) {
      // Going with a runner: goal-side, a step ahead of where they are heading.
      const mark = { x: o.pos.x + o.vel.x * 0.35 + g.x * 1.2, z: o.pos.z + o.vel.z * 0.35 + g.z * 1.2 };
      m.arrive(p, mark, dist(p.pos, mark) > 1.5 ? 'sprint' : 'jog', fb);
      return;
    }
    const mark = { x: o.pos.x + g.x * 1.8, z: o.pos.z + g.z * 1.8 };
    const home = formationTarget(m, p, plan);
    const T = { x: mark.x * 0.7 + home.x * 0.3, z: mark.z * 0.7 + home.z * 0.3 };
    m.arrive(p, T, dist(p.pos, T) > 7 ? 'sprint' : 'jog', fb);
    return;
  }
  if (!plan.inPossession && plan.zones.has(p.id)) {
    // Holding a zone after a set piece against us (the ball itself is attacked by the chaser and interceptor).
    const Z = plan.zones.get(p.id)!;
    m.arrive(p, Z, dist(p.pos, Z) > 3 ? 'sprint' : 'jog', fb);
    return;
  }
  if (plan.fill.has(p.id)) {
    // Filling the space a pressing human or an overlapping full-back has left.
    const F = plan.fill.get(p.id)!;
    m.arrive(p, F, dist(p.pos, F) > 5 ? 'sprint' : 'jog', fb);
    return;
  }
  if (!plan.inPossession && plan.laneCover.has(p.id)) {
    const L = plan.laneCover.get(p.id)!;
    m.arrive(p, L, dist(p.pos, L) > 6 ? 'sprint' : 'jog', fb);
    return;
  }
  // Attacking the box for a cross takes priority over offering a short option.
  if (plan.boxTargets.has(p.id)) {
    const s = plan.boxTargets.get(p.id)!;
    m.arrive(p, s, dist(p.pos, s) > (plan.boxGo ? 1.5 : 5) ? 'sprint' : 'jog', fb);
    return;
  }
  if (p.giveGoUntil > m.time && plan.inPossession) {
    // Pass and move: run on past the man for the return ball, staying onside.
    const f = toFrame(dir, p.pos);
    const x = Math.max(Math.min(f.x + 12, plan.offsideLineFx - 0.5, PITCH.halfLength - 6), f.x - 1);
    m.arrive(p, fromFrame(dir, { x, z: clamp(f.z * 0.85, -28, 28) }), 'sprint');
    return;
  }
  if (plan.supportSpots.has(p.id)) {
    const s = plan.supportSpots.get(p.id)!;
    m.arrive(p, s, dist(p.pos, s) > (plan.helper === p.id ? 3 : 9) ? 'sprint' : 'jog', fb);
    return;
  }
  const call = m.calledRun[p.team];
  if (call.pid === p.id && call.until > m.time && plan.inPossession) {
    // Called run: straight past the defensive line, angling in towards goal.
    const f = toFrame(dir, p.pos);
    const T = fromFrame(dir, { x: Math.min(Math.max(plan.offsideLineFx, f.x) + 9, PITCH.halfLength - 6), z: clamp(f.z * 0.65, -24, 24) });
    m.arrive(p, T, 'sprint');
    return;
  }
  const ov = overlapTarget(m, p, plan);
  if (ov) {
    m.arrive(p, ov, 'sprint');
    return;
  }
  const hr = specialRunTarget(m, p, plan) ?? blindTarget(m, p, plan) ?? (plan.runners.has(p.id) ? humanRunTarget(m, p, plan) : null);
  if (hr) {
    m.arrive(p, hr.T, hr.mode);
    return;
  }
  if (plan.runners.has(p.id)) {
    // Run along the offside line into space, staying onside until the pass.
    const home = basePos(m, p.team, p.role);
    const T = fromFrame(dir, { x: Math.min(plan.offsideLineFx - 0.4, PITCH.halfLength - 8), z: clamp(home.z * 0.55, -26, 26) });
    m.arrive(p, T, 'sprint');
    return;
  }
  const T = formationTarget(m, p, plan);
  const behindBall = (b.pos.x - p.pos.x) * dir < 0; // ball is between me and my own goal
  const dT = dist(p.pos, T);
  // Break forward quickly when we win the ball; otherwise only sprint to recover big gaps.
  const breaking = plan.inPossession && (T.x - p.pos.x) * dir > 5 && !isDefender(p.role);
  const far = dT > 12;
  m.arrive(p, T, (far && (behindBall || plan.inPossession)) || (breaking && dT > 6) ? 'sprint' : 'jog', dT < 2 ? fb : null);
}

/**
 * Open body: a receiver with no one tight on them half-turns towards the goal they attack while
 * the ball arrives, so the first touch and the next pass can go forward.
 */
function openBody(m: Match, p: Player, fb: number): number {
  let near = 99;
  for (const o of m.players) if (o.team !== p.team && !o.off) near = Math.min(near, dist(o.pos, p.pos));
  if (near < 2.5) return fb;
  const dir = m.attackDir(p.team);
  const vx = Math.cos(fb) + 0.75 * dir, vz = Math.sin(fb);
  return Math.hypot(vx, vz) < 0.3 ? fb : angleOf(vx, vz);
}

/** Get into the line of a ground pass (robust), or meet a lofted ball where it comes down. */
export function receivePoint(m: Match, p: Player, eager = false): V2 | null {
  const b = m.ball;
  const sp = Math.hypot(b.vel.x, b.vel.z);
  // Balls played into space: run to where the ball can be reached in time.
  if (b.flight === 'through') return m.meetPoint(p) ?? null;
  if (b.pos.y < 0.5 && sp > 1) {
    const ux = b.vel.x / sp, uz = b.vel.z / sp;
    const along = (p.pos.x - b.pos.x) * ux + (p.pos.z - b.pos.z) * uz;
    const stopDist = (sp * sp) / (2 * 2.2);
    // Come towards the ball rather than waiting for it (more so with a marker close by).
    let nearOpp = 99;
    for (const o of m.players) if (o.team !== p.team) nearOpp = Math.min(nearOpp, dist(o.pos, p.pos));
    // A human's receiver (stick let go) attacks the pass harder: a few strides towards it.
    const meet = eager ? (nearOpp < 5 ? 4 : 2.5) : nearOpp < 5 ? 3 : 1.5;
    const a = clamp(along - meet, 1, Math.max(1, stopDist - 0.5));
    const onLine = { x: b.pos.x + ux * a, z: b.pos.z + uz * a };
    // If the ball will be past that point before we get there, run to where it can still be caught.
    const tBall = a / Math.max(1, sp);
    if (dist(p.pos, onLine) / sprintTop(p.a) > tBall + 0.15) return m.meetPoint(p, 3) ?? onLine;
    return onLine;
  }
  return m.meetPoint(p);
}

function maybeTackle(m: Match, p: Player, carrier: Player, dt: number, eagerness: number) {
  if (p.tackleCooldown > 0 || p.action.type !== 'none') return;
  const b = m.ball;
  const d = dist(p.pos, b.pos);
  const booked0 = p.cards > 0;
  // Tactical foul (19 Nov 2026): a computer side caught on the break, beaten by the carrier in
  // midfield, sometimes pulls them back and takes the booking (never when already booked).
  if (!booked0 && G6.aiFoul && !m.ctrl[p.team].human && d < 2.3 && aiTacticalFoul(m, p, carrier, dt)) return;
  if (p.beaten > 0) return;
  const toBall = angleOf(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
  const facingBall = Math.abs(((toBall - p.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  const behind = Math.abs(((angleOf(p.pos.x - carrier.pos.x, p.pos.z - carrier.pos.z) - carrier.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 1.9;
  const booked = booked0;
  // Slide when a carrier is getting away and the ball is a stride or two out of reach (never from behind).
  if (d > 1.8 && d < 3.0 && facingBall < 0.5 && !behind && Math.hypot(carrier.vel.x, carrier.vel.z) > 4.5) {
    const rate = levelOf(m, p.team).slide * (booked ? 0.3 : 1);
    if (m.rng.chance(rate * dt)) m.startSlide(p);
    return;
  }
  if (d > 1.5) return;
  if (facingBall > 1.0) return;
  if (behind && (booked || !m.rng.chance(0.1))) return; // AI rarely tackles from behind, never when booked
  let rate = eagerness * 1.2 * (booked ? 0.7 : 1);
  if (dist(carrier.pos, b.pos) > 0.55) rate *= 4; // timing: the ball is off the carrier's foot
  if (m.rng.chance(rate * dt)) m.startTackle(p);
}

// ------------------------------------------------------------------ restarts

function pushOut(pt: V2, from: V2, r: number, awayFallback: V2): V2 {
  const d = dist(pt, from);
  if (d >= r) return pt;
  const n = d > 1e-3 ? norm(pt.x - from.x, pt.z - from.z) : awayFallback;
  return { x: from.x + n.x * (r + 0.2), z: from.z + n.z * (r + 0.2) };
}

const clampPitch = (p: V2): V2 => ({ x: clamp(p.x, -PITCH.halfLength + 0.6, PITCH.halfLength - 0.6), z: clamp(p.z, -PITCH.halfWidth + 0.6, PITCH.halfWidth - 0.6) });

/** Target positions for every player at a restart (kick-off, throw-in, corner, ...). */
export function restartTargets(m: Match, r: Restart): V2[] {
  const out: V2[] = new Array(m.players.length);
  const spot = r.spot;
  for (const team of [0, 1]) {
    const dir = m.attackDir(team);
    const attacking = team === r.team;
    const sf = toFrame(dir, spot);
    const plan: TeamPlan = {
      team, inPossession: attacking, loose: false, bx: sf.x, bz: sf.z, pressers: [], cover: -1, chaser: -1, chaser2: -1, followIn: new Map(), interceptor: -1, interceptPoint: null,
      supportSpots: new Map(), runners: new Set(), boxTargets: new Map(), marks: new Map(), tightMarks: new Set(), laneCover: new Map(), offsideLineFx: Math.max(sf.x, 0) + 12, nextAt: 0, interceptKick: -1, interceptGo: false,
      fill: new Map(), counter: new Map(), ownBallAt: -99, humanPressUntil: -1, counterUntil: -1, counterFrom: null, stepUpUntil: -1, callers: [], helper: -1,
      boxMarks: new Set(), blocker: -1, blockSpot: null, secondBall: new Map(), zones: new Map(),
    };
    for (const p of m.teamPlayers(team)) {
      let T = formationTarget(m, p, plan);
      const f = toFrame(dir, T);
      if (p.role === 'GK') {
        const gf = r.type === 'penalty' && !attacking ? { x: -PITCH.halfLength + 0.2, z: 0 } : { x: -PITCH.halfLength + 1.5 + Math.max(0, sf.x + 52.5) * 0.08, z: clamp(sf.z * 0.1, -2, 2) };
        T = fromFrame(dir, gf);
      }
      switch (r.type) {
        case 'kickoff': {
          const base = basePos(m, p.team, p.role);
          let k = { x: Math.min(base.x * 0.95 - 1, -1), z: base.z };
          if (p.role === 'GK') k = { x: -PITCH.halfLength + 1.2, z: 0 };
          if (attacking && p.id === r.taker) k = { x: -0.4, z: 0.1 };
          if (attacking && p.role === 'LCM') k = { x: -2, z: -7 };
          if (attacking && p.role === 'RCM') k = { x: -2, z: 7 };
          if (!attacking) {
            const d = Math.hypot(k.x, k.z);
            if (d < PITCH.centreCircleRadius + 0.5) { const n = norm(k.x, k.z); k = { x: n.x * 9.8, z: n.z * 9.8 }; }
            k.x = Math.min(k.x, -1);
          }
          T = fromFrame(dir, k);
          break;
        }
        case 'throwin':
        case 'corner': {
          if (r.type === 'throwin') {
            if (r.routine !== 1) {
              // Short options: the two nearest teammates come towards the ball and down the line.
              if (attacking && p.role !== 'GK') {
                const near = m.teamPlayers(team).filter((q) => q.id !== r.taker && q.role !== 'GK').sort((a, b) => dist(a.pos, spot) - dist(b.pos, spot));
                const s = Math.sign(sf.z) || 1;
                if (near[0]?.id === p.id) T = fromFrame(dir, { x: clamp(sf.x - 4, -48, 48), z: sf.z - s * 8 });
                else if (near[1]?.id === p.id) T = fromFrame(dir, { x: clamp(sf.x + 13, -46, 47), z: sf.z - s * 4 });
              }
              break;
            }
          }
          const s = Math.sign(sf.z) || 1;
          if (attacking && p.role !== 'GK') {
            const slots: Partial<Record<string, V2>> = { ST: { x: 48.5, z: s * 2.5 }, RCB: { x: 46, z: -s * 4 }, LCB: { x: 42, z: s * 1 }, LCM: { x: 44, z: -s * 8 }, RCM: { x: 36, z: s * 3 }, LW: { x: 47, z: -s * 1 }, RW: { x: 37, z: -s * 6 } };
            const rt = r.routine ?? 0;
            // Routines move the attackers: crowd the near post, overload the far post, a short option, or a shooter on the edge.
            if (rt === 1) Object.assign(slots, { ST: { x: 49, z: s * 3.5 }, LW: { x: 47.5, z: s * 5 }, RCB: { x: 46, z: s * 1.5 } });
            if (rt === 2) Object.assign(slots, { ST: { x: 48, z: -s * 4.5 }, RCB: { x: 46.5, z: -s * 6 }, LCB: { x: 45, z: -s * 2.5 } });
            if (rt === 3) Object.assign(slots, { RCM: { x: 46, z: s * 27 } });
            if (rt === 4) Object.assign(slots, { RCM: { x: 35, z: 0 }, LCM: { x: 36, z: -s * 6 } });
            const sl = slots[p.role];
            if (sl) T = fromFrame(dir, sl);
            else if (p.role === 'CDM') T = fromFrame(dir, { x: 18, z: 0 });
            else T = fromFrame(dir, { x: 8, z: (p.role === 'RB' ? 1 : -1) * 18 });
          } else if (!attacking && p.role !== 'GK') {
            const slots: Partial<Record<string, V2>> = { RB: { x: -50.5, z: -s * -3.2 }, RCB: { x: -47, z: -s * -1.5 }, LCB: { x: -46, z: s * 1.5 }, LB: { x: -48, z: s * 4.5 }, CDM: { x: -43, z: 0 }, RCM: { x: -38, z: -s * -5 }, LCM: { x: -38, z: s * 5 }, LW: { x: -44, z: s * 8 } };
            const sl = slots[p.role];
            T = sl ? fromFrame(dir, sl) : fromFrame(dir, { x: -12, z: p.role === 'ST' ? 0 : s * 12 });
          }
          break;
        }
        case 'freekick': {
          const rt = r.routine ?? 0;
          if (!attacking || p.role === 'GK' || !rt) break;
          if (rt === 1 && p.id === layoffTaker(m, r)) T = layoffSpot(m, r);
          if (rt === 3 && p.id === secondTaker(m, r)) T = dummySpot(m, r);
          if (rt === 4) {
            const w = wallFor(m, r);
            const k = wallAttackers(m, r).indexOf(p.id);
            if (w && k >= 0) {
              const half = (w.ids.length / 2) * 0.75 + 0.4;
              const g = norm(w.centre.x - spot.x, w.centre.z - spot.z);
              T = { x: w.centre.x + w.perp.x * (k ? half : -half) - g.x * 0.5, z: w.centre.z + w.perp.z * (k ? half : -half) - g.z * 0.5 };
            }
          }
          if (rt === 2 && (isForward(p.role) || p.role === 'RCB' || p.role === 'LCB')) {
            const s = Math.sign(sf.z) || 1;
            T = fromFrame(dir, { x: 44 + (p.slot % 3) * 1.5, z: -s * (3 + (p.slot % 4) * 1.6) });
          }
          break;
        }
        case 'penalty': {
          if (p.role === 'GK' && !attacking) break;
          // Everyone else waits outside the area, behind the penalty mark (taking team's frame).
          const dirT = m.attackDir(r.team);
          const lane = (p.slot - 5) * 2.4 + (attacking ? 1.2 : 0);
          T = fromFrame(dirT, { x: 31 - (p.slot % 3), z: lane });
          if (p.role === 'GK') T = fromFrame(dirT, { x: -PITCH.halfLength + 8, z: 0 });
          break;
        }
        default:
          break;
      }
      out[p.id] = T;
    }
  }
  // Distances from the ball and the taker's position.
  const dirT = m.attackDir(r.team);
  const awayFallback = { x: -dirT, z: 0 };
  const goalAttacked = { x: dirT * PITCH.halfLength, z: 0 };
  for (const p of m.players) {
    if (p.off) { out[p.id] = { ...p.pos }; continue; }
    let T = out[p.id];
    if (p.id === r.taker) {
      if (r.type === 'throwin') T = { x: spot.x, z: spot.z + Math.sign(spot.z) * 0.3 };
      else if (r.type === 'kickoff') T = out[p.id];
      else {
        const g = r.type === 'goalkick' ? { x: dirT, z: 0 } : norm(goalAttacked.x - spot.x, goalAttacked.z - spot.z);
        T = { x: spot.x - g.x * 0.9, z: spot.z - g.z * 0.9 };
        if (r.type === 'corner') T = { x: spot.x + Math.sign(spot.x) * 0.5, z: spot.z + Math.sign(spot.z) * 0.5 };
      }
      out[p.id] = T;
      continue;
    }
    const opponent = p.team !== r.team;
    if (r.type === 'kickoff') { out[p.id] = T; continue; }
    if (opponent) {
      const rad = r.type === 'throwin' ? 2 : r.type === 'dropball' ? 4 : 9.15;
      if (!(r.type === 'penalty' && p.role === 'GK')) T = pushOut(T, spot, rad, awayFallback);
      if (r.type === 'goalkick' && m.inPenaltyArea(r.team, T, 0.5)) {
        const gx = m.ownGoalX(r.team);
        T = { x: gx + dirT * (PITCH.penaltyAreaDepth + 1.5), z: T.z };
      }
    } else if (r.type === 'dropball') T = pushOut(T, spot, 4, awayFallback);
    if (r.type === 'penalty' && !(p.role === 'GK' && p.team !== r.team)) {
      T = pushOut(T, spot, 9.5, awayFallback);
      const gx = dirT * PITCH.halfLength;
      if (Math.abs(T.x - gx) < PITCH.penaltyAreaDepth + 1 && Math.abs(T.z) < PITCH.penaltyAreaHalfWidth + 1) T = { x: gx - dirT * (PITCH.penaltyAreaDepth + 1.5), z: T.z };
    }
    out[p.id] = clampPitch(T);
  }
  // A corner or wide free kick against a human's side: man-markers goal-side of their men, zones held.
  const spd = setPieceDefence(m, r, out);
  if (spd) {
    const team = 1 - r.team;
    for (const [d, a] of spd.marks) {
      const o = m.players[a];
      const at = out[a] && dist(o.pos, out[a]) > 5 ? out[a] : o.pos; // still on his way: meet him at his spot
      out[d] = clampPitch(setPieceMarkSpot(m, team, at, spot));
    }
    for (const [d, Z] of spd.zones) out[d] = clampPitch(Z);
  }
  // Defensive wall for central free kicks within shooting range.
  const w = wallFor(m, r);
  if (w) w.ids.forEach((id, i) => { out[id] = w.spots[i]; });
  if (w && w.lier >= 0 && w.lieSpot) out[w.lier] = w.lieSpot;
  return out;
}

/** Default number of players in the wall for a free kick at distance d from goal (0: no wall). */
export function wallSize(d: number): number {
  return d < 30 ? (d < 22 ? 4 : 3) : 0;
}

/**
 * The defending side's wall at a free kick: who stands in it (the nearest outfield players)
 * and where, 9.4 m from the ball on the line to goal, moved sideways by the wall's shift.
 * Null when the kick is out of range.
 */
export function wallFor(m: Match, r: Restart): { team: number; ids: number[]; spots: V2[]; centre: V2; perp: V2; lier: number; lieSpot: V2 | null } | null {
  if (r.type !== 'freekick') return null;
  const spot = r.spot;
  const defTeam = 1 - r.team;
  const goal = { x: m.ownGoalX(defTeam), z: 0 };
  const d = dist(spot, goal);
  const n = r.wall ? r.wall.n : wallSize(d);
  if (!n || d >= 30) return null;
  const g = norm(goal.x - spot.x, goal.z - spot.z);
  const perp = { x: -g.z, z: g.x };
  const shift = r.wall?.shift ?? 0;
  const ids = m.teamPlayers(defTeam).filter((p) => p.role !== 'GK').sort((a, c) => dist(a.pos, spot) - dist(c.pos, spot) || a.id - c.id).slice(0, n)
    // Keep the wall in a fixed order along it, so moving it doesn't make players swap places.
    .sort((a, c) => ((a.pos.x - spot.x) * perp.x + (a.pos.z - spot.z) * perp.z) - ((c.pos.x - spot.x) * perp.x + (c.pos.z - spot.z) * perp.z) || a.id - c.id)
    .map((p) => p.id);
  // A wall creeping in before the kick stands closer (the referee pushes it back).
  const at = 9.4 - (r.wall?.creep ?? 0);
  const centre = { x: spot.x + g.x * at + perp.x * shift, z: spot.z + g.z * at + perp.z * shift };
  const spots = ids.map((_, i) => {
    const off = (i - (ids.length - 1) / 2) * 0.75;
    return clampPitch({ x: centre.x + perp.x * off, z: centre.z + perp.z * off });
  });
  // One more defender lies down behind it against a shot under a jumping wall (20 Nov 2026).
  let lier = -1, lieSpot: V2 | null = null;
  if (r.wall?.lie) {
    const used = new Set(ids);
    const l = m.teamPlayers(defTeam).filter((p) => p.role !== 'GK' && !used.has(p.id)).sort((a, c) => dist(a.pos, centre) - dist(c.pos, centre) || a.id - c.id)[0];
    if (l) { lier = l.id; lieSpot = clampPitch({ x: centre.x + g.x * 0.9, z: centre.z + g.z * 0.9 }); }
  }
  return { team: defTeam, ids, spots, centre, perp, lier, lieSpot };
}

/** AI decision for a restart (also used to auto-take a human restart after the timeout). */
export function chooseRestartKick(m: Match, r: Restart, auto = false): KickRequest {
  const taker = m.players[r.taker];
  const team = taker.team;
  const dir = m.attackDir(team);
  const mates = m.teamPlayers(team).filter((p) => p.id !== taker.id && p.role !== 'GK');
  const opp = m.teamPlayers(1 - team);
  const openness = (p: Player) => Math.min(...opp.map((o) => dist(o.pos, p.pos)));
  const nearest = (pool: Player[], maxD: number) =>
    pool.filter((p) => dist(p.pos, taker.pos) < maxD).sort((a, c) => openness(c) - dist(c.pos, taker.pos) / 10 - (openness(a) - dist(a.pos, taker.pos) / 10))[0];
  switch (r.type) {
    case 'kickoff': {
      const mid = mates.filter((p) => p.role === 'LCM' || p.role === 'RCM' || p.role === 'CDM').sort((a, c) => dist(a.pos, taker.pos) - dist(c.pos, taker.pos))[0];
      return { kind: 'pass', receiver: mid.id, target: { x: mid.pos.x, y: 0, z: mid.pos.z } };
    }
    case 'penalty': {
      // Technique, favourite side and a stutter now and then (20 Nov 2026).
      const fav = favouriteSide(taker.def);
      const pen = aiPenalty(m.rng, setPieceRatings(taker.def), takerSideZ(fav.side, dir), fav.lean);
      return { kind: 'shot', power: pen.power, placed: false, variant: techVariant(pen.tech), stutter: pen.stutter, target: { x: dir * PITCH.halfLength, y: 0, z: pen.aimZ } };
    }
    case 'corner': {
      const aim = routineAim(m, r);
      if (aim) {
        const t = mates.sort((a, c) => dist(a.pos, aim) - dist(c.pos, aim))[0];
        return { kind: r.routine === 3 ? 'pass' : r.routine === 4 ? 'lob' : 'cross', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
      }
      const inBox = mates.filter((p) => Math.abs(p.pos.x - dir * PITCH.halfLength) < 14 && Math.abs(p.pos.z) < 10);
      const t = inBox.length ? m.rng.pick(inBox) : mates[0];
      return { kind: 'cross', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
    }
    case 'freekick': {
      const goalD = dist(taker.pos, { x: dir * PITCH.halfLength, z: 0 });
      if ((!r.indirect && goalD < 28 && Math.abs(taker.pos.z) < 18) || m.skill) {
        const gk = m.keeper(1 - team);
        const aimZ = (gk.pos.z > 0 ? -1 : 1) * m.rng.range(2.2, 3.1);
        // A knuckleball from further out now and then (20 Nov 2026).
        if (SP_ON.knuckle && goalD > 22 && !m.skill && m.rng.chance(0.25)) return { kind: 'shot', power: m.rng.range(0.8, 0.92), placed: false, knuckle: true, target: { x: dir * PITCH.halfLength, y: 0, z: aimZ * 0.6 } };
        return { kind: 'shot', power: m.rng.range(0.65, 0.8), placed: true, target: { x: dir * PITCH.halfLength, y: 0, z: aimZ } };
      }
      break;
    }
    case 'goalkick': {
      const short = nearest(mates.filter((p) => p.role === 'RCB' || p.role === 'LCB' || p.role === 'RB' || p.role === 'LB'), 30);
      if (short && openness(short) > 8 && m.rng.chance(0.6)) return { kind: taker.role === 'GK' && m.ball.state === 'held' ? 'throw' : 'pass', receiver: short.id, target: { x: short.pos.x, y: 0, z: short.pos.z } };
      const fwd = mates.filter((p) => isForward(p.role) || p.role === 'RCM' || p.role === 'LCM');
      const t = fwd.sort((a, c) => openness(c) - openness(a))[0];
      return { kind: 'clear', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
    }
    case 'throwin': {
      const range = throwRange(taker);
      if (r.routine === 1) {
        // Long throw into the box: towards the best header of the ball near the penalty spot.
        const gx = dir * PITCH.halfLength;
        const inBox = mates.filter((p) => Math.abs(p.pos.x - gx) < 16 && Math.abs(p.pos.z) < 14);
        const t = inBox.sort((a, c) => (c.role === 'ST' || c.role === 'RCB' || c.role === 'LCB' ? 1 : 0) - (a.role === 'ST' || a.role === 'RCB' || a.role === 'LCB' ? 1 : 0))[0] ?? mates[0];
        return { kind: 'throw', variant: 'longthrow', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
      }
      // A human's side: the most open teammate going forward, when there is one.
      const fwdT = auto ? forwardRestartOption(m, taker, Math.min(24, range)) : null;
      if (fwdT) return { kind: 'throw', variant: dist(fwdT.pos, taker.pos) < 15 ? 'shortthrow' : 'longthrow', receiver: fwdT.id, target: { x: fwdT.pos.x, y: 0, z: fwdT.pos.z } };
      // Down the line to a runner now and then, otherwise short to the most open teammate in range.
      const line = mates.find((p) => (p.pos.x - taker.pos.x) * dir > 8 && Math.abs(p.pos.z - taker.pos.z) < 9 && openness(p) > 5);
      if (line && m.rng.chance(0.3)) return { kind: 'throw', variant: 'linethrow', receiver: line.id };
      const t = nearest(mates.filter((p) => openness(p) > 3), Math.min(22, range)) ?? nearest(mates, Math.min(22, range)) ?? mates.sort((a, c) => dist(a.pos, taker.pos) - dist(c.pos, taker.pos))[0];
      return { kind: 'throw', variant: dist(t.pos, taker.pos) < 15 ? 'shortthrow' : 'longthrow', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
    }
    default:
      break;
  }
  const t = (auto ? forwardRestartOption(m, taker, 35) : null) ?? nearest(mates, 35) ?? mates.sort((a, c) => dist(a.pos, taker.pos) - dist(c.pos, taker.pos))[0];
  const far = dist(t.pos, taker.pos) > 22;
  return { kind: far ? 'lob' : 'pass', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
}

/** How often a beaten computer defender pulls a counter-attacking carrier back (per second in the window). */
export const AI_TACTICAL = { rate: 0.55, window: 6, minSpeed: 4.5, zone: 28 } as const;

function aiTacticalFoul(m: Match, p: Player, carrier: Player, dt: number): boolean {
  if (m.time - m.wonBallAt[carrier.team] > AI_TACTICAL.window || p.role === 'GK') return false;
  const ownGoal = m.ownGoalX(p.team);
  const toGoal = norm(ownGoal - carrier.pos.x, -carrier.pos.z);
  const speedAtGoal = carrier.vel.x * toGoal.x + carrier.vel.z * toGoal.z;
  if (speedAtGoal < AI_TACTICAL.minSpeed || Math.abs(carrier.pos.x) > AI_TACTICAL.zone) return false;
  // Beaten: level with or behind the carrier on the way to goal.
  const ahead = (p.pos.x - carrier.pos.x) * toGoal.x + (p.pos.z - carrier.pos.z) * toGoal.z;
  if (ahead > 0.4) return false;
  if (!m.rng.chance(AI_TACTICAL.rate * levelOf(m, p.team).tackleEagerness * dt)) return false;
  return m.startTacticalFoul(p);
}
