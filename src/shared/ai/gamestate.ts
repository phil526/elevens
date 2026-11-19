// Score-aware play: a computer side chasing the game late on pushes up, presses and goes direct;
// one protecting a lead drops deeper, keeps the ball and takes its time over restarts and the
// keeper's ball. Human-controlled sides (and their computer teammates) are left as they are.

import type { MentalityParams } from '../config';
import { clamp } from '../math';
import type { Match } from '../match';

/**
 * How the score pushes a computer side: 0 = as set, up to +1 = chasing the game, down to -1 =
 * protecting a lead. Builds up through the second half (from about the hour) and extra time.
 */
export function gameState(m: Match, team: number): number {
  if (m.ctrl[team].human || m.cfg.practice || m.drill || m.shootout) return 0;
  const gd = m.score[team] - m.score[1 - team];
  if (gd === 0) return 0;
  const min = m.displayClock / 60;
  // Lateness: nothing in the first half, then rising from the 55th minute to full at 85; extra time is always late.
  const late = m.half >= 3 ? 0.8 + 0.2 * clamp((min - 105) / 15, 0, 1) : m.half === 2 ? clamp((min - 55) / 30, 0, 1) : 0;
  if (late <= 0) return 0;
  if (gd < 0) return late * (gd <= -2 ? 1 : 0.9);
  // A one-goal lead is protected hardest; a big lead is managed more calmly.
  return -late * (gd === 1 ? 1 : gd === 2 ? 0.7 : 0.4);
}

/** Mentality adjusted for the score: chasing pushes the line up and sends more to press and run; protecting does the opposite. */
export function scoreMentality(ment: MentalityParams, s: number): MentalityParams {
  if (s === 0) return ment;
  if (s > 0) {
    return {
      ...ment,
      lineOffset: ment.lineOffset + 8 * s,
      pressers: Math.min(4, ment.pressers + Math.round(1.6 * s)),
      pressRadius: ment.pressRadius + 5 * s,
      supportDistance: ment.supportDistance - 2 * s,
      runChance: Math.min(0.7, ment.runChance + 0.25 * s),
      fullbackOverlap: ment.fullbackOverlap || s > 0.5,
    };
  }
  const a = -s;
  return {
    ...ment,
    lineOffset: ment.lineOffset - 9 * a,
    pressers: Math.max(1, ment.pressers - Math.round(1.2 * a)),
    pressRadius: Math.max(6, ment.pressRadius - 4 * a),
    supportDistance: ment.supportDistance + 1.5 * a,
    runChance: ment.runChance * (1 - 0.65 * a),
    fullbackOverlap: ment.fullbackOverlap && a < 0.4,
  };
}

/** Extra seconds a computer taker waits before a restart: none when chasing, up to a few when protecting a lead. */
export function restartUrgency(s: number, type: string): number {
  if (s >= 0 || type === 'penalty' || type === 'kickoff') return 0;
  return -s * (type === 'goalkick' || type === 'throwin' ? 2.6 : 1.8);
}
