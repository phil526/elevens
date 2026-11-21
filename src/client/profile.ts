// Save slots and profiles (19 Nov 2026). Three slots on this device, each with its own name,
// career stats, records, trophies, achievements, clubs made in the club creator, cup or league in
// progress and practice-challenge bests. Stored in localStorage (best effort: private browsing or
// blocked storage keeps everything for this visit only).

import { isCompetition, type Competition } from '../shared/competition';
import { buildCustomClub, setCustomClubs, type CustomClubSpec } from '../shared/teams';
import type { GoalRecord, TeamStats } from '../shared/types';

export const SLOT_COUNT = 3;
const KEY = 'elevens.profiles.v1';
const OLD_COMP_KEY = 'elevens.competition';
const OLD_BEST_KEY = 'elevens-challenge-best';

export interface CareerStats {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  cleanSheets: number;
  shots: number;
  /** Matches by mode: quick (vs computer), cup, league, online. */
  modes: Record<string, number>;
}

export interface RecordEntry { value: number; text: string; date: string }

export interface Records {
  biggestWin?: RecordEntry; // goal difference
  mostGoals?: RecordEntry; // goals in a match
  unbeaten: number; // current run
  bestUnbeaten?: RecordEntry;
  wins: number; // current winning run
  bestWins?: RecordEntry;
  topScorer?: RecordEntry; // most goals by one player in a match
}

export interface Trophy { kind: 'cup' | 'league' | 'world'; club: string; clubName: string; size: number; date: string }

export const trophyName = (k: Trophy['kind']) => (k === 'cup' ? 'Elevens Cup' : k === 'world' ? 'World Tournament' : 'Elevens League');

export interface Profile {
  name: string;
  created: string;
  stats: CareerStats;
  records: Records;
  trophies: Trophy[];
  /** Achievement id -> date unlocked (YYYY-MM-DD). */
  achievements: Record<string, string>;
  clubs: CustomClubSpec[];
  comp: Competition | null;
  challengeBest: Record<string, number>;
  tutorialDone: boolean;
  /** Clubs you have played against (for the Well travelled achievement). */
  faced: string[];
  /** The last few results, newest first. */
  recent: { text: string; res: 'W' | 'D' | 'L'; date: string }[];
  photos: number;
}

export interface ProfileStore { active: number; slots: (Profile | null)[] }

/**
 * Today's date (YYYY-MM-DD) on this device's own calendar. It used to be the UTC date, so the daily
 * scenario turned over at 1 am in a UK summer (and mid-afternoon or evening elsewhere).
 */
export const localDay = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localDay();

export function newProfile(name: string): Profile {
  return {
    name: name.trim().slice(0, 18) || 'Player', created: today(),
    stats: { played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, cleanSheets: 0, shots: 0, modes: {} },
    records: { unbeaten: 0, wins: 0 }, trophies: [], achievements: {}, clubs: [], comp: null, challengeBest: {}, tutorialDone: false, faced: [], recent: [], photos: 0,
  };
}

/** Fill in anything an older save is missing, and drop what doesn't parse. */
export function cleanProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Profile>;
  const d = newProfile(typeof r.name === 'string' ? r.name : 'Player');
  return {
    ...d, ...r,
    name: d.name,
    stats: { ...d.stats, ...(r.stats ?? {}), modes: { ...(r.stats?.modes ?? {}) } },
    records: { ...d.records, ...(r.records ?? {}) },
    trophies: Array.isArray(r.trophies) ? r.trophies : [],
    achievements: r.achievements && typeof r.achievements === 'object' ? r.achievements : {},
    clubs: Array.isArray(r.clubs) ? r.clubs.filter((c) => c && typeof c.id === 'string' && c.id.startsWith('custom-')) : [],
    comp: isCompetition(r.comp) ? r.comp : null,
    challengeBest: r.challengeBest && typeof r.challengeBest === 'object' ? r.challengeBest : {},
    faced: Array.isArray(r.faced) ? r.faced : [],
    recent: Array.isArray(r.recent) ? r.recent.slice(0, 8) : [],
    photos: typeof r.photos === 'number' ? r.photos : 0,
    tutorialDone: !!r.tutorialDone,
  };
}

function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
}

/** The store, creating slot 1 from older saves (the cup or league in progress and challenge bests) the first time. */
export function loadStore(defaultName = ''): ProfileStore {
  const raw = readJson(KEY) as ProfileStore | null;
  if (raw && Array.isArray(raw.slots)) {
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => cleanProfile(raw.slots[i]));
    let active = typeof raw.active === 'number' && slots[raw.active] ? raw.active : slots.findIndex(Boolean);
    if (active < 0) { slots[0] = newProfile(defaultName || 'Player 1'); active = 0; }
    return { active, slots };
  }
  const p = newProfile(defaultName || 'Player 1');
  const comp = readJson(OLD_COMP_KEY);
  if (isCompetition(comp)) p.comp = comp;
  const best = readJson(OLD_BEST_KEY);
  if (best && typeof best === 'object') p.challengeBest = { ...(best as Record<string, number>) };
  return { active: 0, slots: [p, ...Array.from({ length: SLOT_COUNT - 1 }, () => null)] };
}

export function saveStore(s: ProfileStore) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: this visit only */ }
}

/** Make the active profile's own clubs known to the game (teamById finds them). */
export function applyClubs(p: Profile) {
  setCustomClubs(p.clubs.map(buildCustomClub));
}

// ------------------------------------------------------------------ match summaries

export type MatchMode = 'quick' | 'cup' | 'league' | 'online';

/** What happened in one of your matches, from your side. */
export interface MatchSummary {
  mode: MatchMode;
  club: string;
  clubName: string;
  opp: string;
  oppName: string;
  custom: boolean; // your club is one you made
  difficulty: string; // the computer's level ('' online)
  adaptiveWorld: boolean; // Adaptive finished at World class
  gf: number;
  ga: number;
  pens?: [number, number]; // shoot-out, yours first
  stats: TeamStats; // yours
  possession: number; // 0..1
  goals: GoalDetail[]; // yours (not own goals for you, which still count in gf)
  /** Scoreline after each goal, in order: +1 yours, -1 theirs. */
  sequence: { side: 1 | -1; minute: number; added?: number }[];
  half: number; // last half played (3+ = extra time)
}

export interface GoalDetail { scorer: string; kind: 'shot' | 'header' | 'volley' | 'freekick' | 'penalty' | 'other'; distance: number; minute: number; added?: number }

/** The goals in the order scored, as +1 (yours) / -1 (theirs). */
export function goalSequence(goals: GoalRecord[], me: number): MatchSummary['sequence'] {
  return goals.map((g) => ({ side: (g.team === me ? 1 : -1) as 1 | -1, minute: g.minute, ...(g.added ? { added: g.added } : {}) }));
}

/** You were behind at some point (and how far at most). */
export function wasBehind(seq: MatchSummary['sequence']): number {
  let d = 0, worst = 0;
  for (const g of seq) { d += g.side; worst = Math.min(worst, d); }
  return -worst;
}

/** The winning goal (the one that put you ahead for good), or null if you didn't win in normal or extra time. */
export function winningGoal(seq: MatchSummary['sequence']): MatchSummary['sequence'][number] | null {
  let d = 0, win: MatchSummary['sequence'][number] | null = null;
  for (const g of seq) {
    const before = d;
    d += g.side;
    if (g.side === 1 && before === 0) win = g;
    if (d <= 0) win = null;
  }
  return d > 0 ? win : null;
}

export function resultOf(m: MatchSummary): 'W' | 'D' | 'L' {
  if (m.gf !== m.ga) return m.gf > m.ga ? 'W' : 'L';
  if (m.pens) return m.pens[0] > m.pens[1] ? 'W' : 'L';
  return 'D';
}

// ------------------------------------------------------------------ achievements

export interface Achievement { id: string; name: string; text: string; icon: string }

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-match', name: 'Kick-off', text: 'Play your first match.', icon: '⚽' },
  { id: 'first-win', name: 'Off the mark', text: 'Win a match.', icon: '✅' },
  { id: 'clean-sheet', name: 'Shut-out', text: 'Win without conceding.', icon: '🧤' },
  { id: 'thrashing', name: 'Statement win', text: 'Win by four goals or more.', icon: '💥' },
  { id: 'hat-trick', name: 'Hat-trick hero', text: 'One of your players scores three in a match.', icon: '🎩' },
  { id: 'comeback', name: 'Comeback kings', text: 'Win a match after being behind.', icon: '🔄' },
  { id: 'late-winner', name: 'Last gasp', text: 'Score the winner in the 85th minute or later.', icon: '⏱️' },
  { id: 'header', name: 'Head of the class', text: 'Score with a header.', icon: '🗣️' },
  { id: 'volley', name: 'Sweet volley', text: 'Score with a volley.', icon: '🦵' },
  { id: 'freekick', name: 'Dead-ball specialist', text: 'Score direct from a free kick.', icon: '🎯' },
  { id: 'penalty', name: 'Cool from the spot', text: 'Score a penalty during a match.', icon: '🥅' },
  { id: 'long-range', name: 'From distance', text: 'Score from 25 metres or more.', icon: '🚀' },
  { id: 'shootout', name: 'Nerves of steel', text: 'Win a penalty shoot-out.', icon: '🧊' },
  { id: 'possession', name: 'Keep-ball', text: 'Have 62% of the ball or more in a match.', icon: '🔁' },
  { id: 'elite-win', name: 'Giant killer', text: 'Beat the computer on Elite.', icon: '🗡️' },
  { id: 'world-class', name: 'World beater', text: 'Beat Adaptive while it is at World class.', icon: '🌍' },
  { id: 'cup-win', name: 'Silverware', text: 'Win the cup.', icon: '🏆' },
  { id: 'league-win', name: 'Champions', text: 'Win the league.', icon: '🥇' },
  { id: 'big-league', name: 'The long haul', text: 'Win a league of 16 or 20 clubs.', icon: '📅' },
  { id: 'founder', name: 'Founder', text: 'Make your own club in the club creator.', icon: '🛡️' },
  { id: 'home-grown', name: 'Home-grown', text: 'Win a match with a club you made.', icon: '🌱' },
  { id: 'regular', name: 'Regular', text: 'Play 10 matches.', icon: '🔟' },
  { id: 'veteran', name: 'Veteran', text: 'Play 50 matches.', icon: '🎖️' },
  { id: 'goal-machine', name: 'Goal machine', text: 'Score 50 goals in all.', icon: '⚙️' },
  { id: 'unbeaten', name: 'Unbeatable', text: 'Go five matches without losing.', icon: '🧱' },
  { id: 'travelled', name: 'Well travelled', text: 'Play against 10 different clubs.', icon: '🧭' },
  { id: 'tutorial', name: 'Learner', text: 'Finish the guided first match.', icon: '🎓' },
  { id: 'perfect-ten', name: 'Perfect ten', text: 'Score 10 out of 10 in a practice challenge.', icon: '💯' },
  { id: 'photographer', name: 'Snapper', text: 'Take a picture in photo mode.', icon: '📷' },
];

export const achievementById = (id: string) => ACHIEVEMENTS.find((a) => a.id === id);

/** Unlock achievements (once); returns the ones that are new. */
export function unlock(p: Profile, ids: string[]): Achievement[] {
  const out: Achievement[] = [];
  for (const id of ids) {
    if (p.achievements[id]) continue;
    const a = achievementById(id);
    if (!a) continue;
    p.achievements[id] = today();
    out.push(a);
  }
  return out;
}

/** Achievements earned by this match (some depend on the career totals already updated). */
export function matchAchievements(p: Profile, m: MatchSummary): string[] {
  const ids: string[] = ['first-match'];
  const res = resultOf(m);
  const won = res === 'W';
  if (won) ids.push('first-win');
  if (won && m.ga === 0) ids.push('clean-sheet');
  if (m.gf - m.ga >= 4) ids.push('thrashing');
  const by = new Map<string, number>();
  for (const g of m.goals) by.set(g.scorer, (by.get(g.scorer) ?? 0) + 1);
  if ([...by.values()].some((n) => n >= 3)) ids.push('hat-trick');
  if (won && wasBehind(m.sequence) > 0) ids.push('comeback');
  const w = winningGoal(m.sequence);
  if (won && m.gf > m.ga && w && w.minute >= 85) ids.push('late-winner'); // 90+2' is minute 90; 45+2' is 45
  for (const g of m.goals) {
    if (g.kind === 'header') ids.push('header');
    if (g.kind === 'volley') ids.push('volley');
    if (g.kind === 'freekick') ids.push('freekick');
    if (g.kind === 'penalty') ids.push('penalty');
    if (g.distance >= 25 && g.kind !== 'penalty') ids.push('long-range');
  }
  if (m.pens && m.pens[0] > m.pens[1]) ids.push('shootout');
  if (m.possession >= 0.62) ids.push('possession');
  if (won && m.difficulty === 'elite') ids.push('elite-win');
  if (won && m.adaptiveWorld) ids.push('world-class');
  if (won && m.custom) ids.push('home-grown');
  if (p.stats.played >= 10) ids.push('regular');
  if (p.stats.played >= 50) ids.push('veteran');
  if (p.stats.gf >= 50) ids.push('goal-machine');
  if (p.records.unbeaten >= 5) ids.push('unbeaten');
  if (new Set(p.faced).size >= 10) ids.push('travelled');
  return ids;
}

/** Add a match to the career: totals, records, recent form. Returns the achievements it unlocked. */
export function recordMatch(p: Profile, m: MatchSummary): Achievement[] {
  const s = p.stats;
  const res = resultOf(m);
  const d = today();
  s.played++;
  if (res === 'W') s.won++; else if (res === 'L') s.lost++; else s.drawn++;
  s.gf += m.gf; s.ga += m.ga; s.shots += m.stats.shots;
  if (m.ga === 0) s.cleanSheets++;
  s.modes[m.mode] = (s.modes[m.mode] ?? 0) + 1;
  const vs = `${m.clubName} ${m.gf}–${m.ga} ${m.oppName}${m.pens ? ` (${m.pens[0]}–${m.pens[1]} pens)` : ''}`;
  const r = p.records;
  const better = (e: RecordEntry | undefined, v: number) => !e || v > e.value;
  if (m.gf > m.ga && better(r.biggestWin, m.gf - m.ga)) r.biggestWin = { value: m.gf - m.ga, text: vs, date: d };
  if (better(r.mostGoals, m.gf) && m.gf > 0) r.mostGoals = { value: m.gf, text: vs, date: d };
  r.unbeaten = res === 'L' ? 0 : r.unbeaten + 1;
  if (better(r.bestUnbeaten, r.unbeaten) && r.unbeaten > 0) r.bestUnbeaten = { value: r.unbeaten, text: `up to ${vs}`, date: d };
  r.wins = res === 'W' ? r.wins + 1 : 0;
  if (better(r.bestWins, r.wins) && r.wins > 0) r.bestWins = { value: r.wins, text: `up to ${vs}`, date: d };
  const by = new Map<string, number>();
  for (const g of m.goals) by.set(g.scorer, (by.get(g.scorer) ?? 0) + 1);
  for (const [who, n] of by) if (better(r.topScorer, n)) r.topScorer = { value: n, text: `${who} v ${m.oppName}`, date: d };
  if (!p.faced.includes(m.opp)) p.faced.push(m.opp);
  p.recent = [{ text: vs, res, date: d }, ...p.recent].slice(0, 8);
  return unlock(p, matchAchievements(p, m));
}

/** A cup or league won (or finished): trophies and their achievements. */
export function recordTrophy(p: Profile, c: Competition, clubName: string): Achievement[] {
  if (!c.champion || c.champion !== c.club) return [];
  const size = c.size ?? 8;
  p.trophies.push({ kind: c.kind, club: c.club, clubName, size, date: today() });
  const ids = [c.kind === 'cup' ? 'cup-win' : 'league-win'];
  if (c.kind === 'league' && size >= 16) ids.push('big-league');
  return unlock(p, ids);
}
