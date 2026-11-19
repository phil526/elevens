// Ranked online (19 Nov 2026): climb from Division 10 to Division 1 and then Elite. Every ranked
// match moves your division points (100 a division): a win earns about 25 (more against a
// stronger player), a draw 8, a defeat costs 12, and leaving a match counts as a defeat.
// Matchmaking pairs players by a hidden Elo rating, widening the search the longer you wait.

export interface RankedRecord {
  id: string;
  name: string;
  elo: number;
  points: number;
  w: number; d: number; l: number;
  /** Highest division points ever reached. */
  best: number;
}

export const RANK = { perDivision: 100, divisions: 10, startElo: 1000, k: 32, win: 25, draw: 8, loss: 12, upsetMax: 10 } as const;

export const newRecord = (id: string, name: string): RankedRecord => ({ id, name, elo: RANK.startElo, points: 0, w: 0, d: 0, l: 0, best: 0 });

/** 10 (bottom) .. 1, then 0 for Elite. */
export function divisionOf(points: number): number {
  const climbed = Math.floor(Math.max(0, points) / RANK.perDivision);
  return climbed >= RANK.divisions ? 0 : RANK.divisions - climbed;
}

export const divisionName = (points: number) => { const d = divisionOf(points); return d === 0 ? 'Elite' : `Division ${d}`; };

/** Points into the current division (0-99), Elite shows its points above the line. */
export const divisionProgress = (points: number) => (divisionOf(points) === 0 ? Math.max(0, points) - RANK.divisions * RANK.perDivision : Math.max(0, points) % RANK.perDivision);

export const expected = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));

/** The result of one match for one player: new Elo, division points and record. */
export function applyResult(me: RankedRecord, oppElo: number, result: 'W' | 'D' | 'L'): { rec: RankedRecord; delta: number } {
  const score = result === 'W' ? 1 : result === 'D' ? 0.5 : 0;
  const elo = Math.round(me.elo + RANK.k * (score - expected(me.elo, oppElo)));
  let delta = result === 'W' ? RANK.win + Math.min(RANK.upsetMax, Math.max(0, Math.round((oppElo - me.elo) / 40))) : result === 'D' ? RANK.draw : -RANK.loss;
  // Division 10 has no floor below it.
  if (me.points + delta < 0) delta = -me.points;
  const points = me.points + delta;
  const rec: RankedRecord = { ...me, elo, points, w: me.w + (result === 'W' ? 1 : 0), d: me.d + (result === 'D' ? 1 : 0), l: me.l + (result === 'L' ? 1 : 0), best: Math.max(me.best, points) };
  return { rec, delta };
}

/** How far apart two players' ratings may be to be paired, after `waitS` seconds in the queue. */
export const pairingWindow = (waitS: number) => 100 + waitS * 25;
