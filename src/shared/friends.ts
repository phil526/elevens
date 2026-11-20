// Friends league (20 Nov 2026): a small league among friends, joined with a 6-letter code. Its
// matches are ordinary 1 v 1 private rooms that both players open from the league screen; at full
// time the match server signs the result. The free host has no lasting disk, so every member's
// device keeps the league and its signed results and hands them back when it next opens the
// league: the server checks each signature and passes on what the others have not seen yet.

import { ALL_CLUBS } from './teams';

/** The room code letters (no 0, O, 1, I or L); kept here too so protocol.ts can import this file. */
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LEAGUE_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{6}$`);
/** chunk: results a device hands over per message (messages are small; it sends what the server lacks in turns). */
export const LEAGUE = { maxMembers: 24, maxResults: 600, chunk: 10, win: 3, draw: 1 } as const;

export interface LeagueMember { id: string; name: string }

/** One match: player a (home, the room's first seat) against b, with clubs and score. */
export interface LeagueResult {
  id: string;
  at: number;
  a: string; b: string;
  an: string; bn: string;
  ca: string; cb: string;
  s: [number, number];
  /** The match server's signature (HMAC) over everything above and the league code. */
  sig: string;
}

export interface LeagueInfo { code: string; name: string; members: LeagueMember[]; results: LeagueResult[] }

export interface TableRow { id: string; name: string; p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number; form: ('W' | 'D' | 'L')[] }

/** What the signature covers. */
export const resultPayload = (code: string, r: Omit<LeagueResult, 'sig'>) => JSON.stringify([code, r.id, r.at, r.a, r.b, r.an, r.bn, r.ca, r.cb, r.s[0], r.s[1]]);

const hexId = (x: unknown, n: number) => (typeof x === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(x) ? x : null);
export const cleanLeagueName = (x: unknown) => (typeof x === 'string' ? x.replace(/[^\p{L}\p{N} ._'&-]/gu, '').trim().slice(0, 24) : '');
const cleanPerson = (x: unknown) => (typeof x === 'string' ? x.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 16) : '') || 'Player';

/** A result from the network or storage, checked for shape (not signature), or null. */
export function cleanResult(x: unknown): LeagueResult | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const id = hexId(r.id, 16), a = hexId(r.a, 32), b = hexId(r.b, 32), sig = hexId(r.sig, 64);
  const s = Array.isArray(r.s) ? r.s : [];
  const g = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 99 ? v : null);
  const s0 = g(s[0]), s1 = g(s[1]);
  const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? Math.floor(r.at) : null;
  if (!id || !a || !b || a === b || !sig || s0 === null || s1 === null || at === null) return null;
  if (typeof r.ca !== 'string' || typeof r.cb !== 'string' || !ALL_CLUBS.some((t) => t.id === r.ca) || !ALL_CLUBS.some((t) => t.id === r.cb)) return null;
  return { id, at, a, b, an: cleanPerson(r.an), bn: cleanPerson(r.bn), ca: r.ca, cb: r.cb, s: [s0, s1], sig };
}

/** Merge two lists of results (by match id), oldest first, keeping at most the newest maxResults. */
export function mergeResults(a: LeagueResult[], b: LeagueResult[]): LeagueResult[] {
  const by = new Map<string, LeagueResult>();
  for (const r of [...a, ...b]) if (!by.has(r.id)) by.set(r.id, r);
  return [...by.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).slice(-LEAGUE.maxResults);
}

/** The league table: 3 points a win, 1 a draw; then goal difference, goals, fewest games, name. */
export function leagueTable(info: Pick<LeagueInfo, 'members' | 'results'>): TableRow[] {
  const rows = new Map<string, TableRow>();
  const row = (id: string, name: string) => {
    let r = rows.get(id);
    if (!r) { r = { id, name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [] }; rows.set(id, r); }
    return r;
  };
  for (const m of info.members) row(m.id, m.name);
  for (const res of [...info.results].sort((x, y) => x.at - y.at)) {
    const ra = row(res.a, res.an), rb = row(res.b, res.bn);
    const [ga, gb] = res.s;
    for (const [r, f, ag] of [[ra, ga, gb], [rb, gb, ga]] as [TableRow, number, number][]) {
      r.p++; r.gf += f; r.ga += ag;
      const o = f > ag ? 'W' : f === ag ? 'D' : 'L';
      if (o === 'W') { r.w++; r.pts += LEAGUE.win; } else if (o === 'D') { r.d++; r.pts += LEAGUE.draw; } else r.l++;
      r.form.push(o);
      if (r.form.length > 5) r.form.shift();
    }
  }
  // Names follow the member list (people can rename themselves).
  for (const m of info.members) { const r = rows.get(m.id); if (r) r.name = m.name; }
  return [...rows.values()].sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.p - y.p || x.name.localeCompare(y.name));
}

export function newLeagueCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_CODE_ALPHABET[Math.floor(rand() * ROOM_CODE_ALPHABET.length)];
  return s;
}
