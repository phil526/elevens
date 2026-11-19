// Physical duels (19 Nov 2026): how strong a player is in a shoulder-to-shoulder battle and how
// well they compete for a high ball. Built from things every machine already agrees on: the
// player's attributes, their build (the same height and breadth the renderer draws, see
// render/look.ts playerBuild) and how tired they are right now.

import { clamp } from './math';
import type { PlayerDef, Role } from './teams';
import type { Player } from './types';

/** Stable 0..1 value from a string (FNV-1a), identical to render/look.ts hash01. */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/**
 * Height and breadth multipliers (1 = a 1.8 m player), the same numbers render/look.ts draws:
 * keepers and centre-backs tall and broad, wingers slighter (tests/gameplay6.test.ts checks they match).
 */
export function buildOf(def: Pick<PlayerDef, 'name' | 'role'>): { h: number; w: number } {
  const u = hash01(def.name, 1), v = hash01(def.name, 2);
  const r: Role = def.role;
  const [h0, hs, w0, ws] =
    r === 'GK' ? [1.03, 0.04, 1.02, 0.04]
    : r === 'RCB' || r === 'LCB' ? [1.01, 0.05, 1.03, 0.05]
    : r === 'ST' ? [0.98, 0.06, 1.0, 0.06]
    : r === 'RW' || r === 'LW' ? [0.93, 0.05, 0.94, 0.04]
    : [0.95, 0.07, 0.96, 0.06];
  const h = h0 + hs * u;
  const w = w0 + ws * v + (h - 1) * 0.3;
  return { h: Math.round(h * 1000) / 1000, w: Math.round(w * 1000) / 1000 };
}

const builds = new WeakMap<PlayerDef, { h: number; w: number }>();
const build = (def: PlayerDef) => {
  let b = builds.get(def);
  if (!b) { b = buildOf(def); builds.set(def, b); }
  return b;
};

/**
 * Strength in a physical battle, about 0.2 (slight and spent) to 1 (big and fresh): the
 * player's tackling and stamina attributes, how broad they are, and how much running they
 * have left in their legs.
 */
export function strengthOf(p: Player): number {
  const b = build(p.def);
  const base = 0.45 * p.a.tackling + 0.2 * p.a.stamina + 1.6 * (b.w - 0.97) + 0.15;
  return clamp(base * (0.75 + 0.25 * p.stamina), 0.15, 1.05);
}

/** Heading ability in an aerial duel: height and spring, strength and timing (control). */
export function aerialOf(p: Player): number {
  const b = build(p.def);
  return clamp(0.5 + 2.2 * (b.h - 1) + 0.3 * (strengthOf(p) - 0.55) + 0.2 * (p.a.control - 0.6) + 0.1 * (p.a.acceleration - 0.7), 0.1, 1.1);
}

export const DUEL = {
  /** Shielding: how much a strength edge adds to (or takes off) the shield bonus. */
  shieldEdge: 0.35,
  /** Holding off: a challenger tight behind or alongside the carrier this close (m) is in a battle. */
  holdRange: 1.05,
  /** Seconds between strength checks in a running battle. */
  holdEvery: 0.3,
  /** Aerial duel: opponents within this distance (m) of the ball's path at head height compete for it. */
  aerialRange: 1.35,
  /** A human who pressed a kick button just before a high ball arrives times the jump better. */
  timedJump: 0.12,
} as const;

/** Probability that `a` wins an aerial duel against `b`, given how far each is from the ball's path (m). */
export function aerialWin(a: Player, b: Player, da: number, db: number, timedA = 0, timedB = 0): number {
  const edge = 1.6 * (aerialOf(a) - aerialOf(b)) + 0.7 * (db - da) + timedA - timedB;
  return clamp(0.5 + edge, 0.1, 0.9);
}

/** Probability that the carrier holds off the challenger in a running battle (stronger and shielding is better). */
export function holdOffChance(carrier: Player, challenger: Player): number {
  const edge = strengthOf(carrier) - strengthOf(challenger);
  return clamp(0.55 + 1.1 * edge + (carrier.shielding ? 0.15 : 0) - (challenger.jockeying ? 0.05 : 0), 0.15, 0.9);
}
