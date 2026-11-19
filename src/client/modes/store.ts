// Saved data for the modes added on 19 Nov 2026 (career, Be a Pro, daily scenarios, skill games,
// club history and the trophy cabinet), kept per save slot in localStorage next to the profile
// (which stays as it was, so older saves load unchanged).

import { isCareer, type Career } from '../../shared/career';
import { isPro, type ProPlayer } from '../../shared/pro';

/** One club's record in your hands (every offline match against the computer counts). */
export interface ClubHistory {
  played: number; w: number; d: number; l: number; gf: number; ga: number;
  first: string;
  /** Biggest win and heaviest defeat: text such as "4–0 v Rivertown", and the margin. */
  best: { text: string; gd: number; date: string } | null;
  worst: { text: string; gd: number; date: string } | null;
  /** Results against each opponent: [won, drawn, lost]. */
  vs: Record<string, [number, number, number]>;
  /** Goals by player (short name). */
  scorers: Record<string, number>;
  /** Last few results, newest first. */
  recent: { text: string; res: 'W' | 'D' | 'L'; date: string; mode: string }[];
}

/** A trophy or medal that is not a cup or league from the Cup and league menu (those stay in the profile). */
export interface CabinetItem {
  kind: 'career-league' | 'career-cup' | 'pro-league' | 'pro-award' | 'ranked' | 'scenario' | 'skill';
  title: string;
  sub: string;
  club: string;
  date: string;
}

export interface ScenarioRecord { id: string; met: boolean; score: [number, number]; date: string }

export interface ModeStore {
  v: 1;
  career: Career | null;
  pro: ProPlayer | null;
  /** Daily scenario results by date (YYYY-MM-DD), and the best result for each scenario. */
  daily: Record<string, ScenarioRecord>;
  scenarios: Record<string, ScenarioRecord>;
  /** Skill games: best points out of ten kicks. */
  skillBest: Record<string, number>;
  clubs: Record<string, ClubHistory>;
  cabinet: CabinetItem[];
}

export const newModeStore = (): ModeStore => ({ v: 1, career: null, pro: null, daily: {}, scenarios: {}, skillBest: {}, clubs: {}, cabinet: [] });

const key = (slot: number) => `elevens.modes.v1.${slot}`;

export function loadModes(slot: number): ModeStore {
  let raw: Partial<ModeStore> | null = null;
  try { raw = JSON.parse(localStorage.getItem(key(slot)) ?? 'null'); } catch { raw = null; }
  const d = newModeStore();
  if (!raw || typeof raw !== 'object') return d;
  const obj = <T>(x: unknown, def: T): T => (x && typeof x === 'object' && !Array.isArray(x) ? (x as T) : def);
  return {
    v: 1,
    career: isCareer(raw.career) ? raw.career : null,
    pro: isPro(raw.pro) ? raw.pro : null,
    daily: obj(raw.daily, {}),
    scenarios: obj(raw.scenarios, {}),
    skillBest: obj(raw.skillBest, {}),
    clubs: obj(raw.clubs, {}),
    cabinet: Array.isArray(raw.cabinet) ? raw.cabinet.filter((c) => c && typeof c.title === 'string') : [],
  };
}

/** Saves; false when the browser refused (storage full or blocked). */
export function saveModes(slot: number, s: ModeStore): boolean {
  try { localStorage.setItem(key(slot), JSON.stringify(s)); return true; } catch { return false; }
}

export function clearModes(slot: number) {
  try { localStorage.removeItem(key(slot)); } catch { /* blocked */ }
}

const emptyHistory = (date: string): ClubHistory => ({ played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, first: date, best: null, worst: null, vs: {}, scorers: {}, recent: [] });

/** A finished match for the club's history. */
export function recordClubMatch(s: ModeStore, r: { club: string; opp: string; oppName: string; gf: number; ga: number; pens?: [number, number]; scorers: string[]; mode: string; date: string }) {
  const h = (s.clubs[r.club] ??= emptyHistory(r.date));
  const res: 'W' | 'D' | 'L' = r.gf > r.ga ? 'W' : r.gf < r.ga ? 'L' : r.pens ? (r.pens[0] > r.pens[1] ? 'W' : 'L') : 'D';
  h.played++;
  h.gf += r.gf; h.ga += r.ga;
  if (r.gf > r.ga) h.w++; else if (r.gf < r.ga) h.l++; else h.d++;
  const v = (h.vs[r.opp] ??= [0, 0, 0]);
  v[r.gf > r.ga ? 0 : r.gf === r.ga ? 1 : 2]++;
  const text = `${r.gf}–${r.ga} v ${r.oppName}${r.pens ? ` (${r.pens[0]}–${r.pens[1]} pens)` : ''}`;
  const gd = r.gf - r.ga;
  if (gd > 0 && (!h.best || gd > h.best.gd || (gd === h.best.gd && r.gf > Number(h.best.text.split('–')[0])))) h.best = { text, gd, date: r.date };
  if (gd < 0 && (!h.worst || gd < h.worst.gd)) h.worst = { text, gd, date: r.date };
  for (const n of r.scorers) h.scorers[n] = (h.scorers[n] ?? 0) + 1;
  h.recent.unshift({ text, res, date: r.date, mode: r.mode });
  h.recent = h.recent.slice(0, 10);
}

export function addToCabinet(s: ModeStore, item: CabinetItem) {
  // The same honour is not added twice (a full-time panel can be shown again).
  if (s.cabinet.some((c) => c.kind === item.kind && c.title === item.title && c.sub === item.sub && c.date === item.date)) return;
  s.cabinet.push(item);
}

/** Days in a row with the daily scenario completed, up to and including `today` (or yesterday). */
export function dailyStreak(s: ModeStore, today: string): number {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const d = new Date(`${today}T12:00:00Z`);
  if (!s.daily[today]?.met) d.setUTCDate(d.getUTCDate() - 1);
  let n = 0;
  while (s.daily[day(d)]?.met) { n++; d.setUTCDate(d.getUTCDate() - 1); }
  return n;
}
