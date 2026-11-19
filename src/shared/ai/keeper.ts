// Goalkeeper behaviour (DESIGN §8): positioning, shot reading with the shared
// ball model, reaction-limited dives with finite reach, catching or parrying,
// claiming crosses, collecting loose balls and timed distribution.

import { BALL, MATCH, PITCH } from '../config';
import { predictGoalLine } from '../ball';
import { clamp, dist, norm } from '../math';
import { sprintTop } from '../movement';
import type { Match } from '../match';
import type { Player, V2, V3 } from '../types';
import { TEAMMATE_ON, levelOf } from './team';
import { chooseDistribution, counterOn } from './distribution';
import { gameState } from './gamestate';
import { G6 } from '../switches';

const R = BALL.radius;

/** Where the ball path crosses the plane x = planeX (heading towards side), using the shared physics. */
function crossPlane(m: Match, planeX: number, side: number, maxT = 2.5): { t: number; y: number; z: number } | null {
  const b = m.ball;
  // predictGoalLine works for |x| = GL; shift the problem by temporarily offsetting x.
  const shift = side * PITCH.halfLength - planeX;
  const shifted = { pos: { x: b.pos.x + shift, y: b.pos.y, z: b.pos.z }, vel: { ...b.vel }, spin: b.spin };
  return predictGoalLine(shifted, side as 1 | -1, maxT);
}

/**
 * A keeper the human has taken control of. With the stick at rest the keeper positions himself as
 * usual (and comes for the ball on a rush); once the stick moves he is all theirs. Either way, a
 * shot the human doesn't dive for themselves gets the keeper's own dive, a touch late.
 */
export function updateHumanKeeper(m: Match, gk: Player, dt: number, steering: boolean) {
  const at = gk.action.type;
  if (at === 'dive') { updateKeeper(m, gk, dt); return; }
  if (at !== 'none') return;
  const wish = { ...gk.wish };
  updateKeeper(m, gk, dt, true);
  if (steering && gk.action.type === 'none') gk.wish = wish;
}

/** A dive the human asks for: towards the side the stick points, or (stick at rest) straight at the ball's path. */
export function manualDive(m: Match, gk: Player, sx: number, sz: number) {
  if (gk.action.type !== 'none' && gk.action.type !== 'catch') return;
  const b = m.ball;
  const side = Math.sign(m.ownGoalX(gk.team)) as 1 | -1;
  const reach = 1.5 + 1.3 * gk.a.goalkeeping;
  const planeX = gk.pos.x;
  const towardGoal = b.vel.x * side > 2 && (b.state === 'flight' || b.state === 'free');
  const cr = towardGoal ? crossPlane(m, planeX, side) : null;
  let tz: number, ty: number;
  const lateral = Math.abs(sz) > 0.3 ? Math.sign(sz) : 0;
  if (cr) {
    ty = clamp(cr.y, 0.15, 2.5);
    const toBall = cr.z - gk.pos.z;
    // Stick at rest, or pointing the way the ball is going: dive to meet it. The other way: a full dive that way.
    tz = !lateral || Math.sign(toBall) === lateral || Math.abs(toBall) < 0.3 ? gk.pos.z + clamp(toBall, -(reach + 1.1), reach + 1.1) : gk.pos.z + lateral * reach;
  } else {
    ty = 0.5;
    const l = Math.hypot(sx, sz);
    tz = gk.pos.z + (l > 0.3 ? (sz / l) * reach : 0);
  }
  reads.set(gk, { tag: `read:${m.lastKickTime.toFixed(3)}`, live: false, tz, ty });
  gk.action = { type: 'dive', t: 0, dur: 0.75, start: { ...gk.pos }, target: { x: planeX - side * 0.1, y: ty, z: tz } };
  m.emit('call', { team: gk.team, player: gk.id, text: 'dive' });
}

export function updateKeeper(m: Match, gk: Player, _dt: number, humanGk = false) {
  const b = m.ball;
  const side = Math.sign(m.ownGoalX(gk.team)) as 1 | -1; // own goal at x = side * 52.5
  const lvl = levelOf(m, gk.team);
  const gkA = gk.a.goalkeeping;
  const faceOut = side > 0 ? Math.PI : 0;

  if (gk.action.type === 'dive') {
    // Scripted dive: the body slides towards the target for the first part of the dive.
    const a = gk.action;
    const prog = clamp(a.t / 0.35, 0, 1);
    const start = a.start!, T = a.target!;
    const v = { x: T.x - start.x, z: T.z - start.z };
    const len = Math.hypot(v.x, v.z);
    // The body travels most of the way to the save (a full-stretch dive covers 2-3 m), leaving
    // about an arm-and-torso length to the target; the hands' reach (keeperSaveCheck) is unchanged.
    const slide = Math.min(len, Math.max(1.1, len - 1.05), 2.8);
    if (len > 1e-3) {
      gk.pos.x = start.x + (v.x / len) * slide * prog;
      gk.pos.z = start.z + (v.z / len) * slide * prog;
      // How far past the original 1.1 m travel the body is, so the save check can discount it.
      const extra = (slide - Math.min(1.1, len)) * prog;
      a.extra = { x: (v.x / len) * extra, z: (v.z / len) * extra };
    }
    gk.vel = { x: 0, z: 0 };
    return;
  }
  if (gk.action.type === 'kick' || gk.action.type === 'throw' || gk.action.type === 'catch') {
    gk.wish = { x: 0, z: 0, mode: 'walk', face: null };
    return;
  }

  // Holding the ball: time-limited distribution.
  if (b.state === 'held' && b.owner === gk.id) {
    gk.wish = { x: 0, z: 0, mode: 'walk', face: faceOut };
    // (Be a Pro: you only control your own player, so the keeper distributes as the computer would.)
    const humanTeam = m.ctrl[gk.team].human && (m.ctrl[gk.team].lock ?? -1) < 0;
    // The human picks the distribution themselves; the AI waits a moment, or releases at once to start a counter.
    if (humanTeam && m.holdT < 5) return;
    if (m.holdT < 0.45) return; // the catch itself
    const urge = gameState(m, gk.team);
    // Chasing the game: release at once. Protecting a lead: hold it as long as the referee allows.
    const wait = humanTeam ? 5 : counterOn(m, gk) || urge > 0.4 ? 0.55 + lvl.reaction : 1.4 + lvl.decisionInterval * 2 + (urge < 0 ? -urge * 3.2 : 0);
    if (m.holdT > Math.min(wait, MATCH.keeperHoldMax - 0.5)) {
      const { req } = chooseDistribution(m, gk);
      m.startKick(gk, req, req.kind === 'throw');
    }
    return;
  }

  // Reading a shot (or any fast ball) heading for goal, after the reaction delay. The read
  // (with its error) is made once per kick; the dive is then timed to meet the ball, with
  // the keeper shuffling across until then.
  const towardGoal = b.vel.x * side > 2 && (b.state === 'flight' || b.state === 'free');
  const tag = `read:${m.lastKickTime.toFixed(3)}`;
  if (towardGoal && m.time - m.lastKickTime > lvl.keeperReaction + 0.04 * m.lastKickHelp + (humanGk ? 0.1 : 0) && b.lastTouchTeam !== gk.team) {
    const planeX = gk.pos.x;
    let read = reads.get(gk);
    if (!read || read.tag !== tag) {
      const cr = crossPlane(m, planeX, side) ?? predictGoalLine(b, side, 2.5);
      read = { tag, live: false, tz: 0, ty: 0 };
      if (cr && Math.abs(cr.z) < PITCH.goalHalfWidth + 1.2 && cr.y < PITCH.goalHeight + 0.6) {
        const sigma = 0.1 + 0.45 * (1 - gkA) + lvl.keeperReaction * 0.5 + 0.2 * m.lastKickHelp;
        read = { tag, live: true, tz: cr.z + m.rng.gauss() * sigma, ty: clamp(cr.y + m.rng.gauss() * sigma * 0.5, 0.15, 2.5) };
        if (m.time - m.penKickTime < 0.6) {
          // Penalty: too close to react, so the keeper has guessed a side (or stayed up) as it was struck.
          const s = Math.sign(cr.z) || 1;
          const g = m.rng.next();
          const right = 0.3 + 0.15 * gkA;
          if (Math.abs(cr.z) > 1.2 && g > right) read.tz = g < right + 0.12 ? 0 : -s * m.rng.range(1.8, 2.8);
        }
      }
      reads.set(gk, read);
    }
    if (read.live) {
      gk.aiIntent = tag;
      const tArr = Math.abs(b.vel.x) > 0.5 ? (planeX - b.pos.x) / b.vel.x : 9;
      const lateral = Math.abs(read.tz - gk.pos.z);
      const reach = 1.5 + 1.3 * gkA;
      if (lateral < 0.6 && read.ty < 1.9) {
        gk.wish = { x: 0, z: Math.sign(read.tz - gk.pos.z) * Math.min(1, lateral * 2), mode: 'sprint', face: faceOut };
        return;
      }
      // Dive when the ball is about a dive's travel time away (or now, if it is already close).
      if (tArr > 0 && tArr > 0.42 && lateral > 0.6) {
        gk.wish = { x: 0, z: Math.sign(read.tz - gk.pos.z), mode: 'sprint', face: faceOut };
        return;
      }
      if (tArr > -0.05) {
        const v = read.tz - gk.pos.z;
        const l = Math.abs(v);
        const k = l > reach + 1.1 ? (reach + 1.1) / l : 1;
        read.live = false;
        gk.action = { type: 'dive', t: 0, dur: 0.75, start: { ...gk.pos }, target: { x: planeX - side * 0.1, y: read.ty, z: gk.pos.z + v * k } };
        return;
      }
    }
  }

  // Sweeper: a human's keeper comes off his line for a ball played in behind the defence.
  const sw = !humanGk && m.ctrl[gk.team].human && TEAMMATE_ON.sweep ? sweepPoint(m, gk, side, lvl.keeperReaction) : null;
  if (sw) {
    gk.aiIntent = 'sweep';
    m.arrive(gk, sw, 'sprint', Math.atan2(b.pos.z - gk.pos.z, b.pos.x - gk.pos.x));
    return;
  }
  if (gk.aiIntent === 'sweep') gk.aiIntent = '';

  // Claim crosses and loose balls the keeper can reach first inside the area.
  const inArea = (p: V2) => Math.abs(p.x - side * PITCH.halfLength) < PITCH.penaltyAreaDepth && Math.abs(p.z) < PITCH.penaltyAreaHalfWidth;

  // Rushing out: on the human's call, or (computer keepers) when an attacker is clean through.
  const carrier = b.owner >= 0 && b.state === 'dribble' ? m.players[b.owner] : null;
  const manual = m.keeperRush[gk.team] > m.time;
  if (manual && (b.owner === gk.id || (b.state !== 'free' && b.state !== 'flight' && b.state !== 'dribble'))) m.keeperRush[gk.team] = 0;
  const oneOnOne = carrier && carrier.team !== gk.team && clearThrough(m, gk, carrier, side, gkA);
  if ((manual && m.keeperRush[gk.team] > m.time) || oneOnOne) {
    if (carrier && carrier.team !== gk.team) {
      // Close the angle: towards a point just in front of the carrier on the line to goal.
      const G = { x: side * PITCH.halfLength, z: 0 };
      const u = norm(G.x - carrier.pos.x, G.z - carrier.pos.z);
      const T = { x: carrier.pos.x + u.x * 0.9, z: carrier.pos.z + u.z * 0.9 };
      m.arrive(gk, T, 'sprint', Math.atan2(carrier.pos.z - gk.pos.z, carrier.pos.x - gk.pos.x));
      if (dist(gk.pos, b.pos) < 1.5 && gk.tackleCooldown <= 0 && m.inPenaltyArea(gk.team, gk.pos)) smother(m, gk, carrier);
      return;
    }
    if (manual && b.lastTouchTeam !== gk.team) {
      const meet = m.meetPoint(gk, 3) ?? { x: b.pos.x, z: b.pos.z };
      m.arrive(gk, meet, 'sprint', Math.atan2(b.pos.z - gk.pos.z, b.pos.x - gk.pos.x));
      return;
    }
  }
  if ((b.state === 'free' || b.state === 'flight') && b.lastTouchTeam !== gk.team) {
    const meet = m.meetPoint(gk, 2.5);
    if (meet && inArea(meet) && Math.abs(meet.x - side * PITCH.halfLength) < 13) {
      const tk = dist(gk.pos, meet) / (sprintTop(gk.a) * 0.9) + lvl.keeperReaction;
      let to = Infinity;
      for (const o of m.teamPlayers(1 - gk.team)) to = Math.min(to, dist(o.pos, meet) / sprintTop(o.a));
      if (tk < to + 0.2) {
        m.arrive(gk, meet, 'sprint', Math.atan2(b.pos.z - gk.pos.z, b.pos.x - gk.pos.x));
        return;
      }
    }
  }
  if (b.state === 'free' && b.lastTouchTeam === gk.team && inArea(b.pos) && Math.hypot(b.vel.x, b.vel.z) < 6) {
    // A loose ball from a teammate: collect with feet if nobody else is closer.
    let to = Infinity;
    for (const o of m.teamPlayers(1 - gk.team)) to = Math.min(to, dist(o.pos, b.pos));
    if (dist(gk.pos, b.pos) < to - 2) { m.arrive(gk, b.pos, 'sprint'); return; }
  }

  // Positioning: on the line between ball and goal centre, deeper as danger rises.
  const G = { x: side * PITCH.halfLength, z: 0 };
  const dB = dist(b.pos, G);
  const u = norm(b.pos.x - G.x, b.pos.z - G.z);
  let depth = clamp(0.6 + dB * 0.09, 0.6, 3.5);
  if (dB > 40) depth = Math.min(13, 3.5 + (dB - 40) * 0.35);
  // Behind a human's high line the keeper stands higher, ready to sweep.
  if (dB > 35 && !humanGk && m.ctrl[gk.team].human && TEAMMATE_ON.sweep) {
    let deepest = Infinity;
    for (const p of m.teamPlayers(gk.team)) if (p.id !== gk.id && !p.off) deepest = Math.min(deepest, Math.abs(p.pos.x - G.x));
    if (deepest > SWEEP.highLine) depth = Math.max(depth, Math.min(SWEEP.maxDepth, deepest * 0.4));
  }
  let T = { x: G.x + u.x * depth, z: G.z + u.z * depth };
  if (dB <= 40 && G6.keeper) T = keeperSpot(m, gk, side, depth);
  T.z = clamp(T.z, -(PITCH.goalHalfWidth + (depth > 4 ? 8 : 1.2)), PITCH.goalHalfWidth + (depth > 4 ? 8 : 1.2));
  if (gk.aiTarget && towardGoal && gk.aiIntent === tag) T = { x: T.x, z: gk.aiTarget.z };
  const face = Math.atan2(b.pos.z - gk.pos.z, b.pos.x - gk.pos.x);
  m.arrive(gk, T, dist(gk.pos, T) > 5 ? 'sprint' : 'jog', face);
}

/**
 * Keeper positioning (19 Nov 2026). Where to stand: on the line that splits the angle between
 * the ball and the two posts (so both sides of the goal are covered equally, not the line to the
 * middle of the goal), further off the line to narrow the angle when a carrier comes at goal
 * through the middle, and tight to the near post when the ball is wide near the byline.
 */
export const KEEPER_POS = { narrowFrom: 24, narrowMax: 3.4, narrowBase: 1.4, narrowRate: 0.12, nearPostIn: 0.7, nearPostDepth: 0.9, wideFrom: 9, wideFull: 17, bylineWithin: 16 } as const;

export function keeperSpot(m: Match, gk: Player, side: number, depth0: number): V2 {
  const b = m.ball;
  const gx = side * PITCH.halfLength, hw = PITCH.goalHalfWidth;
  const fromLine = Math.max(0.5, Math.abs(gx - b.pos.x));
  // Narrow the angle: an opponent running at goal with the ball through the middle.
  const carrier = b.state === 'dribble' && b.owner >= 0 ? m.players[b.owner] : null;
  const dB = Math.hypot(gx - b.pos.x, b.pos.z);
  const central = Math.abs(Math.atan2(Math.abs(b.pos.z), fromLine)) < 0.85;
  let depth = depth0;
  if (carrier && carrier.team !== gk.team && dB < KEEPER_POS.narrowFrom && central) {
    depth = Math.max(depth, clamp(KEEPER_POS.narrowBase + (KEEPER_POS.narrowFrom - dB) * KEEPER_POS.narrowRate, KEEPER_POS.narrowBase, KEEPER_POS.narrowMax));
  }
  depth = Math.min(depth, fromLine - 0.6);
  // The angle bisector from the ball between the posts.
  const uL = norm(gx - b.pos.x, -hw - b.pos.z), uR = norm(gx - b.pos.x, hw - b.pos.z);
  const bis = norm(uL.x + uR.x, uL.z + uR.z);
  const t = Math.abs(bis.x) > 0.05 ? (fromLine - depth) / Math.abs(bis.x) : 0;
  let T = { x: b.pos.x + bis.x * t, z: b.pos.z + bis.z * t };
  // Wide near the byline: guard the near post (a cross or cut-back is still covered from there).
  const wide = clamp((Math.abs(b.pos.z) - KEEPER_POS.wideFrom) / (KEEPER_POS.wideFull - KEEPER_POS.wideFrom), 0, 1);
  if (fromLine < KEEPER_POS.bylineWithin && wide > 0) {
    const near = { x: gx - side * KEEPER_POS.nearPostDepth, z: Math.sign(b.pos.z) * (hw - KEEPER_POS.nearPostIn) };
    T = { x: T.x + (near.x - T.x) * wide, z: T.z + (near.z - T.z) * wide };
  }
  return T;
}

/** Sweeper keeper (human sides): how far from goal he will go, and the margin he wants over the nearest opponent. */
export const SWEEP = { reach: 30, margin: 0.35, maxDepth: 12, highLine: 26 } as const;

/**
 * A ball played in behind a human's defence (towards our goal, from the opponents) that the keeper
 * can get to first, with time to spare, and that no outfield teammate will reach before an
 * opponent: where to meet it, or null. Inside the area the usual claim takes over.
 */
function sweepPoint(m: Match, gk: Player, side: number, reaction: number): V2 | null {
  const b = m.ball;
  if (!(b.state === 'flight' || b.state === 'free') || b.lastTouchTeam === gk.team || b.lastTouchTeam < 0) return null;
  if (b.flight === 'shot' || b.vel.x * side < 2) return null;
  const meet = m.meetPoint(gk, 3);
  if (!meet) return null;
  const depth = Math.abs(meet.x - side * PITCH.halfLength);
  if (depth > SWEEP.reach || Math.abs(meet.z) > 26) return null;
  if (depth < PITCH.penaltyAreaDepth - 1 && Math.abs(meet.z) < PITCH.penaltyAreaHalfWidth) return null; // a claim in the area
  const tk = dist(gk.pos, meet) / (sprintTop(gk.a) * 0.92) + reaction;
  let to = Infinity, tm = Infinity;
  for (const o of m.teamPlayers(1 - gk.team)) if (!o.off) to = Math.min(to, dist(o.pos, meet) / sprintTop(o.a));
  for (const p of m.teamPlayers(gk.team)) if (p.id !== gk.id && !p.off) tm = Math.min(tm, dist(p.pos, meet) / sprintTop(p.a));
  const going = gk.aiIntent === 'sweep'; // once he has set off, he keeps going unless clearly beaten to it
  if (tk > to - (going ? 0 : SWEEP.margin)) return null; // he wouldn't get there first
  if (!going && tm < to - 0.15) return null; // a defender has it covered
  return meet;
}

/**
 * Computer keepers come out when an attacker is through on goal: inside about 14-18 m
 * (better keepers read it earlier), heading for goal, and no defender between them and goal.
 */
function clearThrough(m: Match, gk: Player, carrier: Player, side: number, gkA: number): boolean {
  const G = { x: side * PITCH.halfLength, z: 0 };
  const dG = dist(carrier.pos, G);
  if (dG > 14 + 4 * gkA || Math.abs(carrier.pos.z) > 16) return false;
  const toward = (G.x - carrier.pos.x) * carrier.vel.x + (G.z - carrier.pos.z) * carrier.vel.z;
  if (toward <= 0) return false;
  for (const d of m.teamPlayers(gk.team)) {
    if (d.id === gk.id || d.off) continue;
    // A defender goal-side and roughly in the carrier's path still covers.
    if (dist(d.pos, G) < dG - 0.5 && Math.abs(d.pos.z - carrier.pos.z) < 6) return false;
  }
  return true;
}

/** Diving at the feet of a carrier close by: win it in the hands, or end up on the ground beaten. */
export function smother(m: Match, gk: Player, carrier: Player) {
  gk.tackleCooldown = 0.8;
  const pWin = clamp(0.35 + 0.45 * gk.a.goalkeeping - 0.25 * carrier.a.control, 0.15, 0.8);
  if (m.rng.chance(pWin)) {
    const b = m.ball;
    b.lastTouchTeam = carrier.team; // so the keeper may use hands
    b.flight = 'none';
    m.keeperRush[gk.team] = 0;
    m.takePossession(gk, true);
    m.emit('save', { player: gk.id, team: gk.team });
  } else {
    gk.action = { type: 'down', t: 0, dur: 0.7 };
    m.keeperRush[gk.team] = 0;
  }
}

// ---------------------------------------------------------------- hands

function segSegDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y, z: q1.z - p1.z };
  const d2 = { x: q2.x - p2.x, y: q2.y - p2.y, z: q2.z - p2.z };
  const r = { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z };
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z;
  const e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z;
  const f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return Math.hypot(r.x, r.y, r.z);
  if (a <= 1e-9) t = clamp(f / e, 0, 1);
  else {
    const c = d1.x * r.x + d1.y * r.y + d1.z * r.z;
    if (e <= 1e-9) s = clamp(-c / a, 0, 1);
    else {
      const bb = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
      const den = a * e - bb * bb;
      s = den !== 0 ? clamp((bb * f - c * e) / den, 0, 1) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((bb - c) / a, 0, 1); }
    }
  }
  const c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s, z: p1.z + d1.z * s };
  const c2 = { x: p2.x + d2.x * t, y: p2.y + d2.y * t, z: p2.z + d2.z * t };
  return Math.hypot(c1.x - c2.x, c1.y - c2.y, c1.z - c2.z);
}

/** Keeper hands/body against the ball's path this tick. Returns true if the keeper touched it. */
/** Share of hard shots, parried straight, that spill loose a few metres out rather than being pushed clear. */
const REBOUND_SPILL = 0.2;

const reads = new WeakMap<Player, { tag: string; live: boolean; tz: number; ty: number }>();

export function keeperSaveCheck(m: Match, gk: Player, prev: V3): boolean {
  const b = m.ball;
  if (b.state === 'held' || b.state === 'dead' || b.state === 'dribble') return false;
  if (b.kickLock > 0 && b.kicker === gk.id) return false;
  if (!m.inPenaltyArea(gk.team, gk.pos, 0.5)) return false; // outside the area: no hands
  if (b.lastTouchTeam === gk.team && b.flight !== 'deflect' && b.flight !== 'header') return false;
  const at = gk.action.type;
  let A: V3, B: V3, rad: number;
  let stretch = 0;
  if (at === 'dive') {
    const a = gk.action;
    const prog = clamp(a.t / 0.32, 0, 1);
    const reach = 1.5 + 1.3 * gk.a.goalkeeping;
    const T = a.target!;
    // Hands' reach is measured from where the body would be with the original 1.1 m travel,
    // so the longer visual travel above doesn't change which shots are saved.
    A = { x: gk.pos.x - (a.extra?.x ?? 0), y: 0.55, z: gk.pos.z - (a.extra?.z ?? 0) };
    const v = { x: T.x - A.x, y: T.y - A.y, z: T.z - A.z };
    const l = Math.hypot(v.x, v.y, v.z);
    const k = Math.min(1, reach / Math.max(l, 1e-3)) * prog;
    B = { x: A.x + v.x * k, y: A.y + v.y * k, z: A.z + v.z * k };
    rad = 0.3;
    stretch = Math.min(1, (l * prog) / reach);
  } else if (at === 'none' || at === 'catch') {
    A = { x: gk.pos.x, y: 0.12, z: gk.pos.z };
    B = { x: gk.pos.x, y: 2.45, z: gk.pos.z };
    rad = 0.46;
  } else return false;
  const d = segSegDist(prev, b.pos, A, B);
  if (d > rad + R) return false;

  const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
  const side = Math.sign(m.ownGoalX(gk.team));
  const cr = predictGoalLine(b, side as 1 | -1, 1.5);
  const onTarget = !!cr && Math.abs(cr.z) < PITCH.goalHalfWidth + 0.1 && cr.y < PITCH.goalHeight + 0.1;
  let pCatch = clamp(1.25 - speed / (14 + 10 * gk.a.goalkeeping), 0.08, 0.97);
  if (stretch > 0.8) pCatch *= 0.45;
  pCatch *= m.wplay.catch; // a wet ball is harder to hold
  const shot = b.flight === 'shot';
  if (shot && onTarget) { m.stats[gk.team].saves++; m.pstats[gk.id].saves++; }
  if (m.rng.chance(pCatch)) {
    if (shot && onTarget) m.emit('save', { player: gk.id, team: gk.team });
    b.lastTouchTeam = 1 - gk.team; // so takePossession grants hands
    m.takePossession(gk, true);
    return true;
  }
  // Parry: away from goal, sometimes tipped wide or over.
  const lat = Math.sign(b.pos.z - gk.pos.z) || (m.rng.chance(0.5) ? 1 : -1);
  const edge = Math.abs(b.pos.z) > PITCH.goalHalfWidth - 0.9 || b.pos.y > 2.0;
  if (edge && m.rng.chance(0.55)) {
    b.vel = { x: b.vel.x * 0.35, y: Math.abs(b.vel.y) * 0.4 + 2.5, z: b.vel.z * 0.35 + lat * 5 };
  } else if (speed > 17 && m.rng.chance(REBOUND_SPILL)) {
    // Spilled: a hard shot squirms loose a few metres in front of goal, live for whoever reacts first.
    b.vel = { x: -side * m.rng.range(3, 6), y: m.rng.range(0.3, 1.4), z: lat * m.rng.range(1, 4) };
  } else {
    b.vel = { x: -side * speed * (0.22 + 0.15 * m.rng.next()), y: 1.2 + m.rng.next() * 2.5, z: lat * speed * 0.22 + m.rng.gauss() * 2 };
  }
  b.state = 'free';
  b.flight = 'deflect';
  b.owner = -1;
  b.receiver = -1;
  b.lastTouch = gk.id;
  b.lastTouchTeam = gk.team;
  b.kicker = gk.id;
  b.kickLock = 0.3;
  b.stillTime = 0;
  b.dip = 0;
  m.offside.flagged.clear();
  m.emit('parry', { player: gk.id, team: gk.team });
  if (G6.deflect) m.startScramble(); // a parry in front of goal: whoever reacts first
  if (shot && onTarget) m.emit('save', { player: gk.id, team: gk.team });
  m.emit('chance', { team: 1 - gk.team });
  return true;
}
