// Daily scenarios (19 Nov 2026): a match picked up part of the way through, with a target. One
// scenario a day (the same for everyone on that date: it comes from the date), and every
// scenario can be replayed from the list. The match starts at the scenario's minute and score
// (Match.startFrom), with any players already sent off.

import type { Difficulty } from './config';
import { MATCH } from './config';
import type { Match } from './match';
import { ALL_CLUBS } from './teams';
import type { TeamIndex } from './types';

export type ScenarioGoal = 'win' | 'draw' | 'winBy2' | 'score2' | 'clean' | 'comeback';

export interface Scenario {
  id: string;
  title: string;
  /** What has happened so far: {you} and {them} become club names. */
  story: string;
  minute: number;
  /** Your goals, theirs. */
  score: [number, number];
  /** Your players already sent off (slots), and theirs. */
  reds?: [number[], number[]];
  goal: ScenarioGoal;
  difficulty: Difficulty;
  /** Strong (higher-rated) or weak opponents when the clubs are drawn. */
  opp: 'strong' | 'even' | 'weak';
  weather?: 'rain' | 'snow';
}

export const GOAL_TEXT: Record<ScenarioGoal, string> = {
  win: 'Win the match', draw: 'Avoid defeat', winBy2: 'Win by two goals or more', score2: 'Score at least two more goals', clean: "Don't concede, and don't lose", comeback: 'Come back and win',
};

export const SCENARIOS: Scenario[] = [
  { id: 'two-down', title: 'Two down, twenty to go', story: '{you} are 2–0 down at home to {them} with twenty minutes left. The crowd want a fight.', minute: 70, score: [0, 2], goal: 'draw', difficulty: 'pro', opp: 'strong' },
  { id: 'great-escape', title: 'The great escape', story: '{you} trail {them} 1–3. Win and you stay up; anything else and you go down.', minute: 60, score: [1, 3], goal: 'comeback', difficulty: 'pro', opp: 'even' },
  { id: 'ten-men', title: 'Ten men', story: 'Your centre-back saw red on the half hour. It is 0–0 against {them}; hold on for a point.', minute: 35, score: [0, 0], reds: [[2], []], goal: 'draw', difficulty: 'pro', opp: 'strong' },
  { id: 'last-gasp', title: 'Last gasp', story: '1–1 against {them} in the 85th minute. One more goal wins it.', minute: 85, score: [1, 1], goal: 'win', difficulty: 'pro', opp: 'even' },
  { id: 'goal-difference', title: 'Goal difference', story: '{you} lead {them} 1–0, but you need to win by two to take the title on goal difference.', minute: 65, score: [1, 0], goal: 'winBy2', difficulty: 'pro', opp: 'weak' },
  { id: 'park-the-bus', title: 'Park the bus', story: '1–0 up away at {them}, the league leaders. Twenty-five minutes to keep them out.', minute: 65, score: [1, 0], goal: 'clean', difficulty: 'elite', opp: 'strong' },
  { id: 'down-to-nine', title: 'Down to nine', story: 'Two red cards and a 1–1 draw with {them}. Fifteen minutes to survive.', minute: 75, score: [1, 1], reds: [[5, 3], []], goal: 'draw', difficulty: 'pro', opp: 'even' },
  { id: 'goal-glut', title: 'Goals, goals, goals', story: '{you} are 3–2 up on {them} in a wild one. The fans want more: score two more.', minute: 60, score: [3, 2], goal: 'score2', difficulty: 'pro', opp: 'even' },
  { id: 'rainy-night', title: 'A wet Tuesday night', story: 'Driving rain, 0–1 down to {them} at the break. Turn it round.', minute: 45, score: [0, 1], goal: 'comeback', difficulty: 'pro', opp: 'even', weather: 'rain' },
  { id: 'snow-cup', title: 'Snow in the cup', story: 'Snow is falling and {them} are 1–0 up in the cup. Find a way back.', minute: 55, score: [0, 1], goal: 'draw', difficulty: 'pro', opp: 'strong', weather: 'snow' },
  { id: 'giant-killing', title: 'Giant killing', story: 'Little {you} are level 0–0 with mighty {them} after an hour. Can you nick it?', minute: 60, score: [0, 0], goal: 'win', difficulty: 'elite', opp: 'strong' },
  { id: 'their-ten', title: 'Extra man', story: '{them} have had a man sent off, but they lead 0–1. Make the extra man count.', minute: 50, score: [0, 1], reds: [[], [6]], goal: 'comeback', difficulty: 'elite', opp: 'even' },
  { id: 'three-down', title: 'Mission impossible', story: '0–3 down to {them} at half-time. Nobody comes back from that... do they?', minute: 45, score: [0, 3], goal: 'draw', difficulty: 'casual', opp: 'even' },
  { id: 'hold-the-lead', title: 'See it out', story: '2–1 up against {them} with ten minutes left, and they are throwing everyone forward.', minute: 80, score: [2, 1], goal: 'win', difficulty: 'elite', opp: 'strong' },
  { id: 'first-half', title: 'Flying start', story: 'A fresh start: 0–0 with {them} after twenty minutes. Win by two.', minute: 20, score: [0, 0], goal: 'winBy2', difficulty: 'pro', opp: 'weak' },
  { id: 'derby-day', title: 'Derby day', story: 'The derby against {them} is 2–2 with fifteen to play. Bragging rights for the winner.', minute: 75, score: [2, 2], goal: 'win', difficulty: 'pro', opp: 'even' },
  { id: 'ten-v-eleven', title: 'Ten against eleven', story: 'Your left-back was sent off on the hour. {you} lead {them} 1–0 with twenty minutes to go.', minute: 70, score: [1, 0], reds: [[4], []], goal: 'win', difficulty: 'pro', opp: 'even' },
  { id: 'late-show', title: 'The late show', story: '0–1 against {them}, five minutes to go plus added time.', minute: 85, score: [0, 1], goal: 'draw', difficulty: 'pro', opp: 'even' },
  { id: 'clean-sheet', title: 'Shut-out', story: 'Your keeper needs one more clean sheet for the record. 0–0 with {them}, half an hour left.', minute: 60, score: [0, 0], goal: 'clean', difficulty: 'elite', opp: 'strong' },
  { id: 'title-decider', title: 'Title decider', story: 'Last day of the season. {you} must beat {them}; it is 1–1 after seventy minutes.', minute: 70, score: [1, 1], goal: 'win', difficulty: 'elite', opp: 'strong' },
];

/** A whole number from a date string, the same on every device. */
export function dateSeed(date: string): number {
  let h = 2166136261;
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Today's scenario: which one, and which clubs (from the date). */
export function dailyScenario(date: string): { scenario: Scenario; club: string; opp: string } {
  const h = dateSeed(date);
  const scenario = SCENARIOS[h % SCENARIOS.length];
  return { scenario, ...clubsFor(scenario, h >>> 5) };
}

/** Clubs for a scenario: yours, and an opponent of the strength it calls for. */
export function clubsFor(s: Scenario, h: number): { club: string; opp: string } {
  const strength = (id: string) => ALL_CLUBS.find((t) => t.id === id)!.players.reduce((n, p) => n + p.attrs.pace + p.attrs.passing + p.attrs.shooting + p.attrs.tackling + p.attrs.control, 0);
  const ids = ALL_CLUBS.map((t) => t.id).sort((a, b) => strength(a) - strength(b));
  const n = ids.length;
  const mid = Math.floor(n / 2);
  const club = s.opp === 'strong' ? ids[(h % mid)] : s.opp === 'weak' ? ids[mid + (h % (n - mid))] : ids[h % n];
  const pool = s.opp === 'strong' ? ids.slice(-6) : s.opp === 'weak' ? ids.slice(0, 6) : ids;
  let opp = pool[(h >>> 7) % pool.length];
  if (opp === club) opp = pool[((h >>> 7) + 1) % pool.length];
  return { club, opp };
}

/** Real minutes for the whole match, so the part left to play takes about two to four minutes. */
export function scenarioMinutes(s: Scenario): number {
  const left = 90 - s.minute;
  const want = (3 * 90) / Math.max(5, left);
  const allowed = MATCH.allowedRealMinutes;
  return allowed.reduce((best, m) => (Math.abs(m - want) < Math.abs(best - want) ? m : best), allowed[allowed.length - 1]);
}

/** Where the match picks up (MatchConfig.startAt): the scenario's minute and score, with the sendings-off. */
export function scenarioStart(s: Scenario): { half: 1 | 2; clock: number; score: [number, number]; kickoff: TeamIndex; offs: number[] } {
  const half = s.minute >= 45 ? 2 : 1;
  const clock = (s.minute - (half === 2 ? 45 : 0)) * 60;
  const offs = [...(s.reds?.[0] ?? []).map((slot) => slot), ...(s.reds?.[1] ?? []).map((slot) => 11 + slot)];
  // Whoever is behind kicks off; level, the visitors do.
  const kickoff: TeamIndex = s.score[0] < s.score[1] ? 0 : 1;
  return { half, clock, score: [s.score[0], s.score[1]], kickoff, offs };
}

/** Pick the match up at the scenario's minute and score, with the sendings-off. */
export function applyScenario(m: Match, s: Scenario) {
  const a = scenarioStart(s);
  m.startFrom(a.half, a.clock, a.score, a.kickoff, a.offs);
}

/** Did the final score meet the target? */
export function scenarioMet(s: Scenario, score: [number, number]): boolean {
  const [a, b] = score;
  switch (s.goal) {
    case 'win': case 'comeback': return a > b;
    case 'draw': return a >= b;
    case 'winBy2': return a - b >= 2;
    case 'score2': return a - s.score[0] >= 2;
    case 'clean': return b === s.score[1] && a >= b;
  }
}

export const fillStory = (s: Scenario, you: string, them: string) => s.story.replace(/\{you\}/g, you).replace(/\{them\}/g, them);
