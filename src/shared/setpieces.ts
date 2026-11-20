// Penalties and free kicks (20 Nov 2026): set-piece ratings, chosen takers, pressure, penalty
// techniques (stutter run-up, Panenka, side-foot, blast) and the penalty keeper duel.
// Pure helpers here; the match calls them (match.ts stepRestart / releaseKick, ai/keeper.ts).

import { MATCH, PITCH } from './config';
import { clamp, dist } from './math';
import type { Rng } from './rng';
import type { PlayerDef, Tactics } from './teams';
import type { Player, TeamIndex } from './types';

/** Feature switches for benches and tests (all on in the game). */
export const SP_ON = { ratings: true, takers: true, pressure: true, techniques: true, duel: true, habits: true };

/** Tuning. */
export const SETPIECE = {
  /** How far a human keeper can shuffle along his line before a penalty (m either side of the centre). */
  gkShiftMax: 0.9,
  gkShiftSpeed: 2.4,
  /** A keeper who commits this long before the ball is struck can be read by the taker (s). */
  earlyFrom: 0.28,
  /** ...and is read by every composed taker at this lead (s past earlyFrom). */
  earlySpan: 0.55,
  /** Stutter: where in the run-up the taker checks (m from the ball), and for how long (s). */
  stutterAt: 1.7,
  stutterTime: 0.5,
  stutterError: 1.15,
  /** Panenka: a keeper stays up for it this often (plus more for a good keeper). */
  panenkaStay: 0.14,
  panenkaStayGk: 0.16,
  /** Shot-power charge a Panenka is struck with. */
  panenkaPower: 0.3,
  /** Biggest ring wobble under pressure. */
  shakeMax: 0.8,
} as const;

export type PenTech = 'normal' | 'placed' | 'blast' | 'panenka';
export const PEN_TECH_NAMES: Record<PenTech, string> = { normal: 'Normal', placed: 'Side-foot', blast: 'Blast', panenka: 'Panenka' };

export interface SetPieceRatings {
  pen: number; // penalties 0-99
  fk: number; // direct free kicks 0-99
  comp: number; // composure (nerve under pressure) 0-99
}

function nameHash(s: string): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/**
 * Penalty, free-kick and composure ratings, the same on every machine: mostly from shooting,
 * passing and ball control, with a personal touch from the player's name so a club has its own
 * specialists (a squad can set them itself).
 */
export function setPieceRatings(def: PlayerDef): SetPieceRatings {
  const a = def.attrs;
  const h = nameHash(def.name + '#sp');
  const n = (shift: number) => ((h >>> shift) % 41) - 20; // -20..20
  const r = (v: number) => clamp(Math.round(v), 25, 96);
  const out: SetPieceRatings = {
    pen: r(0.68 * a.shooting + 0.3 * a.control + 0.5 * n(0) + 1),
    fk: r(0.48 * a.shooting + 0.36 * a.passing + 0.16 * a.control + 0.65 * n(8) - 2),
    comp: r(28 + 0.22 * a.control + 0.2 * a.shooting + 0.12 * a.passing + 1.0 * n(16)),
  };
  if (def.role === 'GK') { out.pen = r(out.pen - 6); out.fk = r(out.fk - 10); }
  const x = def as PlayerDef & { setPieces?: Partial<SetPieceRatings> };
  if (x.setPieces) for (const k of ['pen', 'fk', 'comp'] as const) if (typeof x.setPieces[k] === 'number') out[k] = r(x.setPieces[k]!);
  return out;
}

/** Error multiplier from a set-piece rating: 1 at 50, about 0.8 for a 90, 1.1 for a 30. */
export const ratingError = (rating: number) => (SP_ON.ratings ? 1.25 - 0.5 * clamp(rating / 99, 0, 1) : 1);

/** Extra error for nerves: pressure (0..1) against composure. */
export const nerveError = (pressure: number, comp: number) => (SP_ON.pressure ? 1 + 0.7 * clamp(pressure, 0, 1) * (1 - clamp(comp / 99, 0, 1)) : 1);

/** How much the human's timing ring wobbles and speeds up (0 calm .. SETPIECE.shakeMax): only in big moments (late in a close game, extra time, shootouts). */
export const ringShake = (pressure: number, comp: number) => (SP_ON.pressure && pressure >= 0.45 ? clamp(1.4 * pressure * (1 - comp / 99), 0, SETPIECE.shakeMax) : 0);

/** Shootout result so far: a winner once one side can't catch up in five kicks each, or after equal sudden-death kicks. */
export function shootoutWinnerOf(kicks: [boolean[], boolean[]]): -1 | TeamIndex {
  const [a, b] = kicks;
  const ga = a.filter(Boolean).length, gb = b.filter(Boolean).length;
  if (a.length <= 5 && b.length <= 5) {
    if (ga > gb + (5 - b.length)) return 0;
    if (gb > ga + (5 - a.length)) return 1;
    return -1;
  }
  if (a.length === b.length && ga !== gb) return ga > gb ? 0 : 1;
  return -1;
}

/** Shootout pressure on `team`'s next kick: higher as it goes on, highest when the kick can win or lose it. */
export function shootoutPressure(kicks: [boolean[], boolean[]], team: TeamIndex): number {
  const n = kicks[team].length;
  let p = n >= 5 ? 0.8 : 0.45 + 0.07 * n;
  const after = (scored: boolean) => {
    const k: [boolean[], boolean[]] = [kicks[0].slice(), kicks[1].slice()];
    k[team].push(scored);
    return shootoutWinnerOf(k);
  };
  if (after(true) === team || after(false) === 1 - team) p += 0.2;
  return clamp(p, 0, 1);
}

/** Match pressure on a set piece: late in a close game, extra time, shootouts. Practice is calm. */
export function matchPressure(m: { cfg: { practice?: string; challenge?: number }; half: number; clock: number; score: [number, number]; shootout: { kicks: [boolean[], boolean[]] } | null }, team: TeamIndex): number {
  if (!SP_ON.pressure) return 0;
  if (m.cfg.practice) return m.cfg.challenge ? 0.3 : 0;
  if (m.shootout) return shootoutPressure(m.shootout.kicks, team);
  const diff = Math.abs(m.score[0] - m.score[1]);
  const late = m.half >= 3 || (m.half === 2 && m.clock > 35 * 60);
  if (diff <= 1 && late) return m.half >= 3 ? 0.75 : 0.6;
  if (diff <= 1) return 0.3;
  return 0.12;
}

/** Chosen takers, by player name, from a side's tactics. */
export type Takers = NonNullable<Tactics['takers']>;

/** The chosen taker for a kind of set piece, if he is on the pitch. */
export function chosenTaker(squad: Player[], takers: Takers | undefined, kind: 'pen' | 'fk' | 'corner'): Player | null {
  if (!SP_ON.takers) return null;
  const name = takers?.[kind];
  if (!name) return null;
  return squad.find((p) => !p.off && p.def.name === name) ?? null;
}

/** Best outfield player on the pitch for a rating. */
export function bestBy(squad: Player[], key: keyof SetPieceRatings): Player | null {
  let best: Player | null = null, bs = -1;
  for (const p of squad) {
    if (p.off || p.role === 'GK') continue;
    const s = setPieceRatings(p.def)[key];
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}

/** A direct free kick: close enough to shoot (the wall goes up for these). */
export const directFreeKick = (spot: { x: number; z: number }, attackDir: number) => dist(spot, { x: attackDir * PITCH.halfLength, z: 0 }) < 32;

/**
 * A computer taker's penalty: technique, where (z on the goal line), how hard, and whether he
 * stutters. Composed specialists try the riskier ones.
 */
export function aiPenalty(rng: Rng, r: SetPieceRatings, favZ = 0, lean = 0.5): { tech: PenTech; aimZ: number; power: number; stutter: boolean } {
  const side = favZ !== 0 && SP_ON.habits ? (rng.chance(lean) ? Math.sign(favZ) : -Math.sign(favZ)) : rng.chance(0.5) ? 1 : -1;
  const comp = r.comp / 99;
  if (!SP_ON.techniques) {
    const aimZ = rng.chance(0.08) ? 0 : side * rng.range(1.4, 2.5);
    return { tech: 'normal', aimZ, power: rng.range(0.7, 0.86), stutter: false };
  }
  const g = rng.next();
  const stutter = rng.chance(0.08 + 0.12 * comp);
  if (comp > 0.68 && g < 0.04) return { tech: 'panenka', aimZ: rng.range(-0.3, 0.3), power: SETPIECE.panenkaPower + rng.range(-0.04, 0.04), stutter: false };
  if (g < 0.24) return { tech: 'blast', aimZ: rng.chance(0.25) ? rng.range(-0.4, 0.4) : side * rng.range(0.9, 2.2), power: rng.range(0.78, 0.92), stutter };
  if (g < 0.6) return { tech: 'placed', aimZ: side * rng.range(2.0, 2.8), power: rng.range(0.75, 0.95), stutter };
  return { tech: 'normal', aimZ: rng.chance(0.08) ? 0 : side * rng.range(1.4, 2.5), power: rng.range(0.7, 0.86), stutter };
}

/** Shot variant for a penalty technique. */
export const techVariant = (t: PenTech): 'placed' | 'power' | 'chip' | undefined => (t === 'placed' ? 'placed' : t === 'blast' ? 'power' : t === 'panenka' ? 'chip' : undefined);
/** Penalty technique from the shot variant the human chose. */
export const variantTech = (v: string | undefined): PenTech => (v === 'placed' ? 'placed' : v === 'power' ? 'blast' : v === 'chip' ? 'panenka' : 'normal');

/**
 * How likely a taker is to see a keeper who went early and put it the other way: nothing for a
 * keeper who goes as the ball is struck, rising with how early he went and the taker's composure.
 */
export function readEarlyKeeper(lead: number, comp: number): number {
  if (!SP_ON.duel) return 0;
  return clamp((lead - SETPIECE.earlyFrom) / SETPIECE.earlySpan, 0, 1) * (0.45 + 0.5 * clamp(comp / 99, 0, 1));
}

/** The keeper's dancing on his line puts the taker off: an error multiplier. */
export const danceError = (dance: number, comp: number) => (SP_ON.duel ? 1 + 0.4 * clamp(dance, 0, 1) * (1 - clamp(comp / 99, 0, 1)) : 1);

/** The timing ring with a pressure wobble: same formula on the server and in the HUD. */
export function shakyRing(readyT: number, shake = 0): number {
  const base = Math.abs(Math.cos((Math.PI * readyT * (1 + 0.35 * shake)) / MATCH.timingPeriod));
  return clamp(base + shake * 0.22 * Math.abs(Math.sin(readyT * 11.3)), 0, 1);
}

/**
 * Keepers learn a side's penalties (20 Nov 2026): every penalty's side (z sign at the goal line,
 * 0 for down the middle) is remembered per kicking team. A keeper facing that side again guesses
 * better towards where they usually go: up to about +0.2 on his chance of going the right way.
 */
export function habitEdge(m: { penHistory: [number[], number[]] }, gk: { team: number; a: { goalkeeping: number } }, ballSide: number): number {
  if (!SP_ON.habits) return 0;
  const h = m.penHistory[1 - gk.team];
  const sides = h.filter((x) => x !== 0);
  if (sides.length < 2) return 0;
  const frac = (sides.filter((x) => x === ballSide).length + 1) / (sides.length + 2);
  const learn = 0.45 + 0.4 * gk.a.goalkeeping;
  const conf = Math.min(1, sides.length / 4);
  return clamp((frac - 0.5) * 0.9 * learn * conf, -0.2, 0.2);
}

/** How many of a side's last penalties went the same way (for the "he's seen you go there" hint). */
export function habitStreak(h: number[]): { side: number; n: number } {
  let n = 0, side = 0;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] === 0) break;
    if (side === 0) side = h[i];
    if (h[i] !== side) break;
    n++;
  }
  return { side, n };
}

/**
 * A taker's favourite side, from his name (the same everywhere): 'L' or 'R' as he looks at the
 * goal, and how much he leans to it (0.55..0.8 of his penalties).
 */
export function favouriteSide(def: PlayerDef): { side: 'L' | 'R'; lean: number } {
  const h = nameHash(def.name + '#pen');
  return { side: h & 1 ? 'L' : 'R', lean: 0.55 + ((h >>> 1) % 26) / 100 };
}

/** World z sign of a taker's left/right when attacking towards `dir` (+1 = +x): right is +z when attacking +x. */
export const takerSideZ = (side: 'L' | 'R', dir: number) => (side === 'R' ? dir : -dir);

/** The same pressure from what a client sees (the displayed clock runs on from 45:00). */
export function matchPressureView(v: { half: number; clock: number; score: [number, number]; shootout: { kicks: [boolean[], boolean[]] } | null; practice?: unknown }, team: number): number {
  if (!SP_ON.pressure || v.practice) return 0;
  if (v.shootout) return shootoutPressure(v.shootout.kicks, team as TeamIndex);
  const diff = Math.abs(v.score[0] - v.score[1]);
  const late = v.half >= 3 || (v.half === 2 && v.clock > 80 * 60);
  if (diff <= 1 && late) return v.half >= 3 ? 0.75 : 0.6;
  return diff <= 1 ? 0.3 : 0.12;
}
