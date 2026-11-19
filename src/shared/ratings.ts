// Player match stats and ratings (3.0 to 10.0) with a Man of the Match, shown at full time.
// Stats are kept per player in the match; a substituted player's line is closed when they go off.

import type { Role } from './teams';
import type { GoalRecord } from './types';

export interface PlayerStats {
  pid: number; // player id (slot) on the pitch
  team: number;
  name: string;
  short: string;
  number: number;
  role: Role;
  from: number; // match minute they came on (0 for starters)
  to: number; // minute they went off (-1 while on)
  passes: number;
  completed: number;
  keyPasses: number;
  assists: number;
  shots: number;
  onTarget: number;
  goals: number;
  ownGoals: number;
  tackles: number; // won
  interceptions: number;
  saves: number;
  fouls: number;
  yellow: number;
  red: number;
}

export function newPlayerStats(pid: number, team: number, def: { name: string; short: string; number: number }, role: Role, from = 0): PlayerStats {
  return {
    pid, team, name: def.name, short: def.short, number: def.number, role, from, to: -1,
    passes: 0, completed: 0, keyPasses: 0, assists: 0, shots: 0, onTarget: 0, goals: 0, ownGoals: 0,
    tackles: 0, interceptions: 0, saves: 0, fouls: 0, yellow: 0, red: 0,
  };
}

export interface Rated extends PlayerStats { rating: number; motm: boolean }

const DEFENSIVE: Role[] = ['RB', 'RCB', 'LCB', 'LB', 'CDM'];

/**
 * Ratings from what each player did: everyone starts at 6.0. Goals, assists, chances made,
 * accurate passing, tackles, interceptions and saves add; misplaced passes, fouls, cards and
 * own goals take away. Keepers and defenders answer for goals conceded while they were on
 * (and earn a clean sheet), and the result nudges the whole side.
 */
export function rateMatch(stats: PlayerStats[], goals: GoalRecord[], score: [number, number], endMinute: number): Rated[] {
  const rated = stats.map((s): Rated => {
    const on = (m: number) => m >= s.from && (s.to < 0 || m <= s.to);
    const mins = (s.to < 0 ? endMinute : s.to) - s.from;
    const conceded = goals.filter((g) => g.team !== s.team && on(g.minute)).length;
    const gk = s.role === 'GK';
    let r = 6.0;
    r += 1.1 * s.goals + (s.goals >= 3 ? 0.5 : 0);
    r += 0.8 * s.assists + 0.25 * s.keyPasses;
    r += 0.15 * s.onTarget - 0.05 * (s.shots - s.onTarget);
    if (s.passes > 0) r += Math.max(-0.8, Math.min(0.8, 0.09 * (s.completed - 0.78 * s.passes))) + Math.min(0.4, 0.012 * s.completed);
    r += 0.2 * s.tackles + 0.15 * s.interceptions;
    r += (gk ? 0.4 : 0) * s.saves;
    r -= 0.12 * s.fouls + 0.35 * s.yellow + 1.6 * s.red + 0.9 * s.ownGoals;
    if (gk || DEFENSIVE.includes(s.role)) {
      const k = gk ? 0.4 : s.role === 'CDM' ? 0.1 : 0.2;
      r -= k * conceded;
      if (conceded === 0 && mins >= 60) r += gk ? 0.6 : s.role === 'CDM' ? 0.15 : 0.4;
    }
    const gd = score[s.team] - score[1 - s.team];
    r += gd > 0 ? 0.3 : gd < 0 ? -0.3 : 0;
    // A short cameo is pulled towards the middle.
    if (mins < 25) r = 6.0 + (r - 6.0) * Math.max(0.35, mins / 25);
    return { ...s, rating: Math.round(Math.max(3, Math.min(10, r)) * 10) / 10, motm: false };
  });
  const best = rated
    .filter((s) => s.to < 0 || s.to - s.from >= 20)
    .sort((a, b) => b.rating - a.rating || (score[b.team] - score[1 - b.team]) - (score[a.team] - score[1 - a.team]) || b.goals - a.goals)[0];
  if (best) best.motm = true;
  return rated;
}
