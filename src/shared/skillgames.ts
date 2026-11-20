// Skill games (19 Nov 2026): practice challenges scored in points rather than goals. Ten free
// kicks from around the area with nobody else on the pitch:
//   Crossbar challenge: 3 points for hitting the bar, 1 for a post, nothing for a goal or a miss.
//   Target practice: five targets hang in the goal; hit one for its points (top corners 3,
//   bottom corners 2, the middle of the bar 1). A target that has been hit is gone until all are.
// The match keeps the points in score[0], so the score bug and the challenge result show them.

import { PITCH } from './config';
import type { Crossing } from './ball';
import type { Match } from './match';
import type { V2 } from './types';

export type SkillGame = 'crossbar' | 'targets';
/** The ball control drill (Practice) keeps its points in a SkillState too. */
export type PointsGame = SkillGame | 'control';
export const SKILL_GAMES: SkillGame[] = ['crossbar', 'targets'];
export const SKILL_NAMES: Record<SkillGame, string> = { crossbar: 'Crossbar challenge', targets: 'Target practice' };
export const SKILL_HELP: Record<SkillGame, string> = {
  crossbar: 'Ten free kicks with an empty goal. Hit the crossbar for 3 points, a post for 1. A goal scores nothing.',
  targets: 'Ten free kicks at five targets in the goal: top corners 3 points, bottom corners 2, the middle 1. Hit them all and they come back.',
};

export interface SkillTarget { z: number; y: number; r: number; pts: number; hit: boolean }

export interface SkillState {
  game: PointsGame;
  points: number;
  /** What the last attempt scored (shown on screen), and when. */
  last: { text: string; pts: number; at: number } | null;
  targets: SkillTarget[];
  /** The current attempt has been scored (a later post or goal in the same attempt doesn't count again). */
  done: boolean;
}

const GW = PITCH.goalHalfWidth, GH = PITCH.goalHeight;

export function freshTargets(): SkillTarget[] {
  return [
    { z: -(GW - 0.75), y: GH - 0.62, r: 0.62, pts: 3, hit: false },
    { z: GW - 0.75, y: GH - 0.62, r: 0.62, pts: 3, hit: false },
    { z: -(GW - 0.8), y: 0.62, r: 0.62, pts: 2, hit: false },
    { z: GW - 0.8, y: 0.62, r: 0.62, pts: 2, hit: false },
    { z: 0, y: GH - 0.65, r: 0.65, pts: 1, hit: false },
  ];
}

export function newSkillState(game: PointsGame): SkillState {
  return { game, points: 0, last: null, targets: game === 'targets' ? freshTargets() : [], done: false };
}

/** Where the next free kick is taken from (attacking +x or -x by `dir`). */
export function skillSpot(game: SkillGame, dir: number, r: () => number): V2 {
  const d = game === 'crossbar' ? 18 + r() * 9 : 18 + r() * 8;
  return { x: dir * (PITCH.halfLength - d), z: (r() - 0.5) * (game === 'crossbar' ? 18 : 22) };
}

function score(m: Match, s: SkillState, pts: number, text: string) {
  if (s.done) return;
  s.done = true;
  s.points += pts;
  s.last = { text, pts, at: m.time };
  m.score[0] = s.points;
  m.emit('call', { team: 0, text: `skill:${pts}:${text}` });
}

/** The ball hit the woodwork during a skill game. */
export function skillWoodwork(m: Match, s: SkillState, bar: boolean) {
  if (s.game === 'crossbar') score(m, s, bar ? 3 : 1, bar ? 'Crossbar!' : 'Post');
}

/**
 * The ball crossed a goal line or touchline in a skill game: score it, and end the attempt
 * (the ball goes dead; the next free kick follows). Returns true when the crossing was handled.
 */
export function skillCrossing(m: Match, s: SkillState, c: Crossing): boolean {
  if (c.kind === 'goal') {
    if (s.game === 'targets') {
      const t = s.targets.find((x) => !x.hit && Math.hypot(c.z - x.z, c.y - x.y) <= x.r + 0.11);
      if (t) { t.hit = true; score(m, s, t.pts, `Target! +${t.pts}`); if (s.targets.every((x) => x.hit)) s.targets.forEach((x) => (x.hit = false)); }
      else score(m, s, 0, 'In the net, no target');
    } else score(m, s, 0, 'Goal: no points');
  } else score(m, s, 0, s.game === 'crossbar' ? 'Missed' : 'Missed the goal');
  m.emit('whistle', { power: 1, text: 'out' });
  return true;
}
