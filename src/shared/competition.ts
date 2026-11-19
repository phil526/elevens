// Cup and league mode: 8 to 20 clubs. The cup is a knockout of 8 or 16 (round of 16,
// quarter-finals, semi-finals, final; a level tie goes to extra time and penalties). The league
// has 8, 12, 16 or 20 clubs, everyone playing everyone once, three points for a win. You play your own matches; the others are worked out
// instantly from the two squads' strength.

import { Rng } from './rng';
import { ALL_CLUBS, teamById, type TeamDef } from './teams';

export const LEAGUE_SIZES = [8, 12, 16, 20];
export const CUP_SIZES = [8, 16];

export type CompKind = 'cup' | 'league';

export interface Fixture {
  home: string;
  away: string;
  /** Goals, once played. */
  hg?: number;
  ag?: number;
  /** Cup: penalties after a level tie, and who went through. */
  pens?: [number, number];
  et?: boolean;
  winner?: string;
}

export interface Competition {
  kind: CompKind;
  club: string; // your club
  seed: number;
  round: number; // index into rounds (rounds.length when finished)
  rounds: Fixture[][];
  /** Cup: the club that won the final. League: the champions once all rounds are played. */
  champion?: string;
  /** Your club is out of the cup. */
  out?: boolean;
  /** Clubs taking part (8 for saves made before 19 Nov 2026). */
  size?: number;
}

export const CUP_ROUNDS = ['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'];

/** The cup's round names for its size: 8 clubs start at the quarter-finals, 16 at the round of 16. */
export function cupRounds(c: Competition): string[] {
  const n = c.size ?? c.rounds[0].length * 2;
  const k = Math.max(1, Math.round(Math.log2(n)));
  return CUP_ROUNDS.slice(-k);
}

export function roundName(c: Competition, i = c.round) {
  return c.kind === 'cup' ? cupRounds(c)[i] ?? 'Final' : `Round ${i + 1} of ${c.rounds.length}`;
}

/** How good a squad is overall (about 55..80): outfield quality plus the keeper. */
export function clubStrength(t: TeamDef): number {
  let s = 0;
  for (const p of t.players) {
    const a = p.attrs;
    s += p.role === 'GK' ? a.goalkeeping : (a.pace + a.acceleration + a.control + a.passing + a.shooting + a.tackling + a.stamina) / 7;
  }
  return s / t.players.length;
}

/** Goals for each side of a match nobody is playing: Poisson draws, weighted by strength. */
export function simulateScore(home: TeamDef, away: TeamDef, rng: Rng): [number, number] {
  const d = clubStrength(home) - clubStrength(away);
  const lh = 1.35 * Math.exp(d / 9) * 1.08, la = 1.35 * Math.exp(-d / 9);
  const poisson = (l: number) => { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rng.next(); } while (p > L && k < 10); return k - 1; };
  return [poisson(lh), poisson(la)];
}

/** Penalty shoot-out result (best of five then sudden death), slightly favouring the stronger side. */
export function simulatePens(home: TeamDef, away: TeamDef, rng: Rng): [number, number] {
  const ph = 0.75 + (clubStrength(home) - clubStrength(away)) / 400, pa = 1.5 - ph;
  let h = 0, a = 0;
  for (let i = 0; i < 5; i++) { if (rng.chance(ph)) h++; if (rng.chance(pa)) a++; }
  for (let i = 0; h === a && i < 30; i++) { if (rng.chance(ph)) h++; if (rng.chance(pa)) a++; }
  if (h === a) h++;
  return [h, a];
}

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Round-robin rounds by the circle method: each club plays every other once, home and away alternating. */
function roundRobin(ids: string[]): Fixture[][] {
  const n = ids.length;
  const list = ids.slice();
  const rounds: Fixture[][] = [];
  for (let r = 0; r < n - 1; r++) {
    const fx: Fixture[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      fx.push((r + i) % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    rounds.push(fx);
    list.splice(1, 0, list.pop()!);
  }
  return rounds;
}

/**
 * A new cup or league for `club` with `size` clubs (default 8): your club plus others drawn at
 * random from the built-in clubs (your club may be one you made in the club creator).
 */
export function newCompetition(kind: CompKind, club: string, seed: number, size = 8): Competition {
  const rng = new Rng(seed);
  const allowed = kind === 'cup' ? CUP_SIZES : LEAGUE_SIZES;
  const n = allowed.includes(size) ? size : 8;
  const others = shuffle(ALL_CLUBS.map((t) => t.id).filter((id) => id !== club), rng).slice(0, n - 1);
  const ids = shuffle([club, ...others], rng);
  if (kind === 'cup') {
    const first: Fixture[] = [];
    for (let i = 0; i < n; i += 2) first.push({ home: ids[i], away: ids[i + 1] });
    return { kind, club, seed, round: 0, rounds: [first], size: n };
  }
  return { kind, club, seed, round: 0, rounds: roundRobin(ids), size: n };
}

/** Your fixture in the current round, or null when the competition is over for you. */
export function myFixture(c: Competition): Fixture | null {
  if (c.champion || c.out) return null;
  return c.rounds[c.round]?.find((f) => f.home === c.club || f.away === c.club) ?? null;
}

/** Your opponent this round. */
export function opponentOf(c: Competition): string | null {
  const f = myFixture(c);
  return f ? (f.home === c.club ? f.away : f.home) : null;
}

/**
 * Record your result (goals for and against from your side, and penalties if the cup tie went
 * to them), work out the round's other matches and move on to the next round.
 */
export function recordResult(c: Competition, mine: number, theirs: number, pens?: [number, number], et = false): Competition {
  const next: Competition = JSON.parse(JSON.stringify(c));
  const f = myFixture(next);
  if (!f) return next;
  const rng = new Rng((next.seed ^ (next.round * 7919 + 17)) >>> 0);
  const home = f.home === next.club;
  f.hg = home ? mine : theirs; f.ag = home ? theirs : mine; f.et = et;
  if (pens) f.pens = home ? pens : [pens[1], pens[0]];
  for (const o of next.rounds[next.round]) {
    if (o === f) continue;
    [o.hg, o.ag] = simulateScore(teamById(o.home), teamById(o.away), rng);
    if (next.kind === 'cup' && o.hg === o.ag) {
      // Extra time: perhaps a goal, otherwise penalties.
      o.et = true;
      const [eh, ea] = simulateScore(teamById(o.home), teamById(o.away), rng).map((g) => (rng.chance(0.35) ? Math.min(g, 1) : 0));
      o.hg += eh; o.ag += ea;
      if (o.hg === o.ag) o.pens = simulatePens(teamById(o.home), teamById(o.away), rng);
    }
  }
  for (const o of next.rounds[next.round]) o.winner = winnerOf(o);
  next.round++;
  if (next.kind === 'cup') {
    if (f.winner !== next.club) next.out = true;
    const winners = next.rounds[next.round - 1].map((o) => o.winner!);
    if (winners.length === 1) next.champion = winners[0];
    else {
      const fx: Fixture[] = [];
      for (let i = 0; i < winners.length; i += 2) fx.push({ home: winners[i], away: winners[i + 1] });
      next.rounds.push(fx);
      // Knocked out: the rest of the cup is played out at once.
      if (next.out) return finishCup(next);
    }
  } else if (next.round >= next.rounds.length) {
    next.champion = leagueTable(next)[0].id;
  }
  return next;
}

/** After you go out, the remaining cup rounds are simulated so you can see who won. */
function finishCup(c: Competition): Competition {
  const rng = new Rng((c.seed ^ 0x9e3779b9) >>> 0);
  while (!c.champion) {
    const fx = c.rounds[c.round];
    for (const o of fx) {
      [o.hg, o.ag] = simulateScore(teamById(o.home), teamById(o.away), rng);
      if (o.hg === o.ag) { o.et = true; o.pens = simulatePens(teamById(o.home), teamById(o.away), rng); }
      o.winner = winnerOf(o);
    }
    c.round++;
    const winners = fx.map((o) => o.winner!);
    if (winners.length === 1) c.champion = winners[0];
    else {
      const next: Fixture[] = [];
      for (let i = 0; i < winners.length; i += 2) next.push({ home: winners[i], away: winners[i + 1] });
      c.rounds.push(next);
    }
  }
  return c;
}

function winnerOf(f: Fixture): string | undefined {
  if (f.hg === undefined || f.ag === undefined) return undefined;
  if (f.hg !== f.ag) return f.hg > f.ag ? f.home : f.away;
  if (f.pens) return f.pens[0] > f.pens[1] ? f.home : f.away;
  return undefined; // a league draw
}

export interface TableRow { id: string; p: number; w: number; d: number; l: number; gf: number; ga: number; gd: number; pts: number }

/** League table: points, then goal difference, then goals scored, then name. */
export function leagueTable(c: Competition): TableRow[] {
  const rows = new Map<string, TableRow>();
  for (const t of new Set(c.rounds[0].flatMap((f) => [f.home, f.away]))) rows.set(t, { id: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 });
  for (const r of c.rounds) for (const f of r) {
    if (f.hg === undefined || f.ag === undefined) continue;
    const h = rows.get(f.home)!, a = rows.get(f.away)!;
    h.p++; a.p++; h.gf += f.hg; h.ga += f.ag; a.gf += f.ag; a.ga += f.hg;
    if (f.hg > f.ag) { h.w++; a.l++; h.pts += 3; } else if (f.hg < f.ag) { a.w++; h.l++; a.pts += 3; } else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  for (const r of rows.values()) r.gd = r.gf - r.ga;
  return [...rows.values()].sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || teamById(x.id).name.localeCompare(teamById(y.id).name));
}

/** A fixture's score as text, e.g. "2–1", "1–1 (4–3 pens)" or "–" when unplayed. */
export function scoreText(f: Fixture): string {
  if (f.hg === undefined) return 'v';
  return `${f.hg}–${f.ag}${f.pens ? ` (${f.pens[0]}–${f.pens[1]} pens)` : f.et ? ' aet' : ''}`;
}

/** Is this a saved competition we can resume? */
export function isCompetition(x: unknown): x is Competition {
  const c = x as Competition;
  return !!c && (c.kind === 'cup' || c.kind === 'league') && typeof c.club === 'string' && Array.isArray(c.rounds) && typeof c.round === 'number';
}
