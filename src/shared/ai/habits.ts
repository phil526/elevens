// The computer learns your habits (20 Nov 2026 evening).
//
// Over a match the computer side watches how a human team attacks: which side its attacks come
// down, whether its wingers cut inside or go down the line, which corner its shots go for, and
// whether it plays through balls. A habit it has seen enough of changes how it defends: the
// block slides over to your favourite side, the man on the ball shows you the other way, the
// keeper cheats towards your favourite corner and reads it better, and the back line drops off
// for through balls. Mixing it up wins it back: the record keeps only the last half-dozen or so
// examples of each habit, so a change of style shows within a few attacks. How much it learns
// rises with the difficulty. Only a computer side defending against a human side does this, so
// computer-v-computer matches are unchanged; the match's `habits` setting (default on) turns it off.

import { PITCH } from '../config';
import { clamp, dist } from '../math';
import { P20 } from '../switches';
import type { Match } from '../match';
import { levelOf } from './team';
import type { Player, V2 } from '../types';

export const HABIT = {
  /** Each new example keeps this much of the old ones (so the last six or so matter most). */
  keep: 0.85,
  /** Examples a habit needs before it shows, and the evidence a 100% habit is shaded by. */
  minEvents: 3,
  prior: 1.5,
  /** The ball this far (m) into the opponents' half: an attack has reached the final third. */
  finalThird: 17.5,
  /** Carriers wider than this (m) are on a wing; inside/outside is judged with a defender this close. */
  wing: 11,
  cutNear: 7,
  cutEvery: 1.8,
  /** A habit this strong (after the difficulty's learning) is spotted and announced. */
  notice: 0.3,
  /** Adaptations at full strength. */
  laneShift: 4.5, // m the defending block slides towards your favourite side
  showSide: 0.9, // m the man on the ball stands over to the side you like to go
  keeperShade: 0.45, // m the keeper cheats towards your favourite corner
  keeperRead: 0.55, // his read error shrinks by this share for that corner (and grows by half as much for the other)
  dropDeep: 5, // m the back line drops off when you keep playing through balls
} as const;

export type HabitKey = 'lane' | 'cut' | 'corner' | 'side' | 'through';

/** What one human side's attacks look like so far: decayed counts, [a, b] for each habit. */
export interface HabitBook {
  lane: [number, number]; // attacks into the final third down the left / right (the attacking side's own left and right)
  cut: [number, number]; // wingers cutting inside / going down the line
  corner: [number, number]; // shots from wide: near post / far post
  side: [number, number]; // shots from central areas: to the shooter's left / right
  through: [number, number]; // final-third passes: through balls / anything else
  n: Record<HabitKey, number>; // examples seen of each
  told: Record<HabitKey, number>; // which way each habit was last announced (0 never)
  inAttack: boolean;
  cutAt: number;
}

export function newHabitBook(): HabitBook {
  return {
    lane: [0, 0], cut: [0, 0], corner: [0, 0], side: [0, 0], through: [0, 0],
    n: { lane: 0, cut: 0, corner: 0, side: 0, through: 0 },
    told: { lane: 0, cut: 0, corner: 0, side: 0, through: 0 },
    inAttack: false, cutAt: -99,
  };
}

function record(book: HabitBook, key: HabitKey, first: boolean) {
  const c = book[key];
  c[0] *= HABIT.keep; c[1] *= HABIT.keep;
  c[first ? 0 : 1] += 1;
  book.n[key]++;
}

/** -1..1: how strongly the first of the pair is preferred (positive) or the second (negative). */
export function habitBias(book: HabitBook, key: HabitKey): number {
  if (book.n[key] < HABIT.minEvents) return 0;
  const [a, b] = book[key];
  return (a - b) / (a + b + HABIT.prior);
}

const frame = (dir: number, p: V2): V2 => ({ x: p.x * dir, z: p.z * dir });

/** Is the computer watching `team` (a human side, against a computer side, habits on)? */
function watched(m: Match, team: number): boolean {
  return P20.habits && m.cfg.habits !== false && !m.cfg.practice && !!m.ctrl[team]?.human && !m.ctrl[1 - team]?.human;
}

/**
 * The book the computer side `defending` has on its human opponents, and how much it has
 * learned from it (0..1, by difficulty), or null when it isn't learning.
 */
export function bookAgainst(m: Match, defending: number): { book: HabitBook; learn: number; dir: number } | null {
  const att = 1 - defending;
  const book = m.habits[att];
  if (!book || !watched(m, att)) return null;
  const lvl = levelOf(m, defending);
  return { book, learn: clamp(lvl.interceptAwareness, 0.4, 1), dir: m.attackDir(att) };
}

/** Every play tick: note attacks reaching the final third and wingers' take-ons, and announce new habits. */
export function stepHabits(m: Match) {
  for (const team of [0, 1]) {
    if (!watched(m, team)) continue;
    const book = (m.habits[team] ??= newHabitBook());
    const dir = m.attackDir(team);
    const b = m.ball;
    const pt = m.possessionTeam();
    const bf = frame(dir, b.pos);
    // An attack reaching the final third: which side it came down.
    if (pt !== team || bf.x < 0) book.inAttack = false;
    else if (!book.inAttack && bf.x > HABIT.finalThird && b.state !== 'flight') {
      book.inAttack = true;
      if (Math.abs(bf.z) > 6) record(book, 'lane', bf.z < 0);
    }
    // A winger with a defender in front: cut inside, or down the line?
    if (pt === team && b.state === 'dribble' && b.owner >= 0 && m.time - book.cutAt > HABIT.cutEvery) {
      const c = m.players[b.owner];
      const f = frame(dir, c.pos);
      if (m.isHumanControlled(c) && f.x > 0 && Math.abs(f.z) > HABIT.wing && nearestOpp(m, c) < HABIT.cutNear) {
        const v = frame(dir, c.vel);
        const inward = -Math.sign(f.z) * v.z;
        if (inward > 2.2 && inward > 0.8 * v.x) { record(book, 'cut', true); book.cutAt = m.time; }
        else if (v.x > 4 && Math.abs(inward) < 1.2) { record(book, 'cut', false); book.cutAt = m.time; }
      }
    }
    announce(m, team, book);
  }
}

function nearestOpp(m: Match, p: Player): number {
  let best = 99;
  for (const o of m.players) if (o.team !== p.team && !o.off && o.role !== 'GK') best = Math.min(best, dist(o.pos, p.pos));
  return best;
}

/** A kick by a human side's controlled player in the final third: shot corners and through balls. */
export function habitKick(m: Match, p: Player, kind: string, goalZ: number | null) {
  if (!watched(m, p.team) || !m.isHumanControlled(p)) return;
  const book = (m.habits[p.team] ??= newHabitBook());
  const dir = m.attackDir(p.team);
  const f = frame(dir, p.pos);
  if (kind === 'shot') {
    if (goalZ === null || Math.abs(goalZ) > PITCH.goalHalfWidth + 0.5) return;
    if (Math.abs(f.z) > 4) record(book, 'corner', Math.sign(goalZ) === Math.sign(p.pos.z)); // near post = same side as the shooter
    else if (Math.abs(goalZ) > 0.8) record(book, 'side', goalZ * dir > 0); // frame left/right of the goal
    return;
  }
  if (f.x < HABIT.finalThird - 12) return;
  if (kind === 'through') record(book, 'through', true);
  else if (kind === 'pass' || kind === 'lob' || kind === 'cross') record(book, 'through', false);
}

/** The first time a habit is clear (or it flips), tell the human side. */
function announce(m: Match, team: number, book: HabitBook) {
  const learn = clamp(levelOf(m, 1 - team).interceptAwareness, 0.4, 1);
  for (const key of ['lane', 'cut', 'corner', 'side', 'through'] as HabitKey[]) {
    const s = habitBias(book, key) * learn;
    if (Math.abs(s) < HABIT.notice) continue;
    if (key === 'through' && s < 0) continue; // passing short is nothing to adapt to
    const sign = Math.sign(s);
    if (book.told[key] === sign) continue;
    book.told[key] = sign;
    m.emit('call', { team, text: `habit-${key}-${sign > 0 ? 'a' : 'b'}` });
  }
}

// ------------------------------------------------------------- adaptations (computer side)

/** World z the defending block slides by towards the side the human attacks down. */
export function laneShift(m: Match, defending: number): number {
  const k = bookAgainst(m, defending);
  if (!k) return 0;
  // Bias > 0: attacks come down the attacking side's left (frame z < 0).
  const s = habitBias(k.book, 'lane') * k.learn;
  return -s * HABIT.laneShift * k.dir;
}

/** Metres the back line drops off for a side that keeps playing through balls. */
export function dropDeep(m: Match, defending: number): number {
  const k = bookAgainst(m, defending);
  if (!k) return 0;
  return Math.max(0, habitBias(k.book, 'through')) * k.learn * HABIT.dropDeep;
}

/**
 * Where the man on the ball stands against a winger: shifted (world z) to the side the human
 * likes to go, so he is shown the other way. 0 when not on a wing or nothing learned.
 */
export function showSide(m: Match, defending: number, carrier: Player): number {
  const k = bookAgainst(m, defending);
  if (!k || !m.isHumanControlled(carrier)) return 0;
  const fz = carrier.pos.z * k.dir;
  if (Math.abs(fz) < HABIT.wing || carrier.pos.x * k.dir < 0) return 0;
  // Bias > 0: cuts inside, so stand on the inside (towards z = 0).
  const s = habitBias(k.book, 'cut') * k.learn;
  return -Math.sign(carrier.pos.z) * s * HABIT.showSide;
}

/**
 * The corner the keeper expects (world z sign of the goal side, 0 none) and how sure he is
 * (0..1), for a shot from `from` by the human side attacking his goal.
 */
export function expectedCorner(m: Match, keeperTeam: number, from: V2): { side: number; k: number } {
  const book = bookAgainst(m, keeperTeam);
  if (!book) return { side: 0, k: 0 };
  const f = frame(book.dir, from);
  if (Math.abs(f.z) > 4) {
    const s = habitBias(book.book, 'corner') * book.learn;
    return { side: s === 0 ? 0 : (s > 0 ? 1 : -1) * Math.sign(from.z), k: Math.abs(s) };
  }
  const s = habitBias(book.book, 'side') * book.learn;
  return { side: s === 0 ? 0 : (s > 0 ? 1 : -1) * book.dir, k: Math.abs(s) };
}
