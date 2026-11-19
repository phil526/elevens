// Goalkeeper distribution from the hands: roll it out, throw it overarm, a flat drop-kick into a
// forward's stride, or a long punt. Shared by the human keeper (buttons + stick + charge), the AI
// keeper (scored options, quick counter-attacks) and the client's receiver preview.

import { PITCH } from '../config';
import { clampToPitch, laneBlock, leadTarget } from '../kick';
import { angleOf, clamp, dist, norm, wrapAngle } from '../math';
import { isDefender, isForward } from '../teams';
import type { KickRequest, Match } from '../match';
import type { Player, V2 } from '../types';
import { levelOf } from './team';

export type Distribution = 'roll' | 'throw' | 'dropkick' | 'punt';

/** Range (m) of each distribution: a tap looks for the near end, a full charge the far end. */
export const DIST_RANGE: Record<Distribution, { min: number; max: number }> = {
  roll: { min: 6, max: 30 },
  throw: { min: 12, max: 40 },
  dropkick: { min: 28, max: 60 },
  punt: { min: 38, max: 72 },
};

/** Label on the power meter while a keeper's distribution is charged. */
export const DIST_LABEL: Record<Distribution, string> = { roll: 'ROLL OUT', throw: 'THROW', dropkick: 'DROP-KICK', punt: 'PUNT' };

/** Which distribution a kick button plays when your keeper has the ball. */
export function distributionFor(k: 'pass' | 'through' | 'lob' | 'shoot'): Distribution {
  return k === 'pass' ? 'roll' : k === 'lob' ? 'throw' : k === 'through' ? 'dropkick' : 'punt';
}

/** The request a distribution turns into (kind, variant and whether it leaves from the hands as a throw). */
export function distributionRequest(d: Distribution): { kind: KickRequest['kind']; variant?: KickRequest['variant']; hands: boolean } {
  if (d === 'roll') return { kind: 'throw', variant: 'roll', hands: true };
  if (d === 'throw') return { kind: 'throw', hands: true };
  if (d === 'dropkick') return { kind: 'lob', variant: 'dropkick', hands: false };
  return { kind: 'lob', variant: 'punt', hands: false };
}

const openness = (players: Player[], team: number, at: V2) => {
  let near = 99;
  for (const o of players) if (o.team !== team && !o.off) near = Math.min(near, dist(o.pos, at));
  return near;
};

/**
 * Human distribution: the teammate nearest the stick direction whose distance best matches the
 * charge (power undefined: the middle of the range). Rolled balls avoid blocked lanes. With nobody
 * in the cone, the ball goes into space along the stick, as far as the charge says.
 */
export function pickDistribution(players: Player[], gk: Player, dx: number, dz: number, kind: Distribution, attackDir: number, power?: number): { receiver: number; target: V2 } {
  let u = norm(dx, dz);
  if (u.x === 0 && u.z === 0) u = { x: attackDir, z: 0 };
  const R = DIST_RANGE[kind];
  const want = R.min + clamp(power ?? 0.5, 0, 1) * (R.max - R.min);
  const opps = players.filter((o) => o.team !== gk.team && !o.off);
  let best = -1, bs = -Infinity;
  for (const t of players) {
    if (t.team !== gk.team || t.id === gk.id || t.off || t.role === 'GK') continue;
    const d = dist(gk.pos, t.pos);
    if (d < R.min - 4 || d > R.max + 8) continue;
    const ang = Math.abs(wrapAngle(angleOf(t.pos.x - gk.pos.x, t.pos.z - gk.pos.z) - angleOf(u.x, u.z)));
    if (ang > (60 * Math.PI) / 180) continue;
    let s = Math.cos(ang) * 2.2 - Math.min(Math.abs(d - want), 15) / 10;
    if (kind === 'roll') s -= laneBlock(gk.pos, t.pos, opps) * 0.9;
    s -= clamp((4 - openness(players, gk.team, t.pos)) / 4, 0, 1) * 0.6;
    if (s > bs) { bs = s; best = t.id; }
  }
  if (best >= 0) return { receiver: best, target: distributionTarget(gk, players[best], kind, attackDir) };
  return { receiver: -1, target: clampToPitch({ x: gk.pos.x + u.x * want, z: gk.pos.z + u.z * want }, 2) };
}

/** Aim point for a distribution to receiver r: into the stride for kicks, to feet for rolls and throws. */
export function distributionTarget(gk: Player, r: Player, kind: Distribution, attackDir: number): V2 {
  if (kind === 'roll' || kind === 'throw') return leadTarget(gk, r, 'pass', attackDir);
  const T = leadTarget(gk, r, 'lob', attackDir);
  // Drop-kicks are played a step in front of a forward, so they run onto it.
  if (kind === 'dropkick') return clampToPitch({ x: T.x + attackDir * 2.5, z: T.z }, 2);
  return T;
}

/**
 * AI keeper: score each way of releasing the ball. Rolls and throws to a free defender or
 * midfielder keep it; with the opponents committed upfield, a quick throw or drop-kick to a free
 * forward starts a counter-attack; a punt is the safe fallback.
 */
/** Opponents caught upfield: at least five outfield players still in our half, and a teammate free ahead to find. */
export function counterOn(m: Match, gk: Player): boolean {
  const dir = m.attackDir(gk.team);
  let upfield = 0;
  for (const o of m.teamPlayers(1 - gk.team)) if (!o.off && o.role !== 'GK' && o.pos.x * dir < 0) upfield++;
  if (upfield < 5) return false;
  return m.teamPlayers(gk.team).some((t) => !t.off && t.role !== 'GK' && t.pos.x * dir > -25 && dist(gk.pos, t.pos) < 60 && openness(m.players, gk.team, t.pos) > 7);
}

export function chooseDistribution(m: Match, gk: Player): { req: KickRequest; quick: boolean } {
  const dir = m.attackDir(gk.team);
  const lvl = levelOf(m, gk.team);
  const mates = m.teamPlayers(gk.team).filter((p) => p.id !== gk.id && p.role !== 'GK' && !p.off);
  const opps = m.teamPlayers(1 - gk.team).filter((o) => !o.off);
  // Opponents still in our half (caught upfield after their attack broke down).
  const upfield = opps.filter((o) => o.role !== 'GK' && o.pos.x * dir < 0).length;
  const noise = () => m.rng.gauss() * lvl.noise * 0.8;
  let best: { s: number; kind: Distribution; r: Player } | null = null;
  for (const t of mates) {
    const d = dist(gk.pos, t.pos);
    const open = openness(m.players, gk.team, t.pos);
    const fx = t.pos.x * dir;
    const progress = (fx + PITCH.halfLength) / PITCH.length; // 0 at our goal line, 1 at theirs
    const consider = (kind: Distribution, s: number) => { if (!best || s > best.s) best = { s, kind, r: t }; };
    if (d >= 6 && d <= 30 && open > 7 && laneBlock(gk.pos, t.pos, opps) < 0.3 && (isDefender(t.role) || t.role === 'CDM'))
      consider('roll', 1.0 + 0.4 * progress + 0.03 * Math.min(open, 15) + noise());
    if (d >= 12 && d <= 40 && open > 8)
      consider('throw', 0.9 + 0.9 * progress + 0.03 * Math.min(open, 15) + (upfield >= 5 ? 0.35 : 0) + noise());
    if (d >= 28 && d <= 60 && open > 5 && (isForward(t.role) || t.role === 'LCM' || t.role === 'RCM'))
      consider('dropkick', 0.55 + 0.9 * progress + 0.04 * Math.min(open, 12) + (upfield >= 5 ? 0.5 : 0) + noise());
  }
  // Fallback: punt long towards the most open forward.
  const fwd = mates.filter((p) => isForward(p.role) || p.role === 'LCM' || p.role === 'RCM').sort((a, c) => openness(m.players, gk.team, c.pos) - openness(m.players, gk.team, a.pos))[0] ?? mates[0];
  const b = best as { s: number; kind: Distribution; r: Player } | null;
  const choice = b && b.s > 0.95 ? b : { s: 0, kind: 'punt' as Distribution, r: fwd };
  const T = distributionTarget(gk, choice.r, choice.kind, dir);
  const rq = distributionRequest(choice.kind);
  const quick = upfield >= 5 && choice.kind !== 'punt' && choice.kind !== 'roll';
  return { req: { kind: rq.kind, variant: rq.variant, receiver: choice.r.id, target: { x: T.x, y: 0, z: T.z } }, quick };
}
