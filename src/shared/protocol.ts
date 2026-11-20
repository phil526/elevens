// Wire protocol (JSON over WebSocket). Clients send intentions only; every
// field is validated and clamped on the server before use.

import { MATCH } from './config';
import type { Mentality } from './config';
import { cleanTactics, type Tactics } from './teams';
import type { InputEvent, InputFrame } from './types';
import { ALL_CLUBS, TEAMS } from './teams';
import type { RankedRecord } from './ranked';

export const PROTOCOL_VERSION = 14;

export type ClientMsg =
  | { t: 'hello'; v: number; token?: string; name?: string }
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'lobby'; club?: string; kit?: 'home' | 'away'; mentality?: Mentality; minutes?: number; ready?: boolean; swap?: boolean }
  | { t: 'in'; f: InputFrame[] }
  | { t: 'ping'; c: number }
  | { t: 'tactic'; mentality: Mentality; tac?: Tactics }
  | { t: 'rematch'; want: boolean }
  | { t: 'sub'; id: number; bench: number }
  | { t: 'leave' }
  /** Ranked (19 Nov 2026): join the queue with your device's id and key and your club; leave it; the top of the table. */
  | { t: 'ranked'; id: string; key: string; name: string; club: string; saved?: { rec: RankedRecord; sig: string } }
  | { t: 'unranked' }
  | { t: 'board' };

export interface LobbySeat {
  name: string;
  connected: boolean;
  ready: boolean;
  club: string;
  kit: 'home' | 'away';
  mentality: Mentality;
}

export interface RoomState {
  t: 'room';
  code: string;
  you: 0 | 1;
  seats: (LobbySeat | null)[];
  minutes: number;
  state: 'lobby' | 'countdown' | 'match' | 'results';
  countdown: number;
  rematch: [boolean, boolean];
  host: 0 | 1;
  /** A ranked match (no lobby settings; the result moves both players' division points). */
  ranked?: boolean;
}

export type ServerMsg =
  | { t: 'welcome'; token: string; resumed: boolean }
  | RoomState
  | { t: 'err'; code: ErrCode; msg: string }
  | { t: 'start'; side: 0 | 1; teams: [string, string]; kits: ['home' | 'away', 'home' | 'away']; minutes: number; mentality: [Mentality, Mentality]; weather?: import('./weather').MatchWeather }
  | { t: 'pong'; c: number; s: number }
  | { t: 'opp'; status: 'disconnected' | 'reconnected' | 'left'; graceMs?: number }
  | { t: 'end'; reason: 'fulltime' | 'abandoned' | 'opponent_left' }
  /** Ranked: your record (and whether you are queued, and how many are waiting). */
  | { t: 'rank'; rec: RankedRecord; queued: boolean; waiting: number; sig?: string }
  /** Ranked: a match result, your record before and after. */
  | { t: 'rankres'; before: RankedRecord; after: RankedRecord; delta: number; opp: string; sig?: string }
  | { t: 'board'; top: RankedRecord[] };

export type ErrCode = 'bad_code' | 'not_found' | 'room_full' | 'bad_msg' | 'rate_limited' | 'version' | 'not_in_room' | 'server';

const MENTALITIES: Mentality[] = ['defensive', 'balanced', 'attacking'];
const EVENT_KINDS: InputEvent['k'][] = ['pass', 'through', 'lob', 'shoot', 'switch', 'skill', 'press', 'trap', 'plan', 'keeper', 'instr'];
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
/** A ranked record the player kept with the server's signature (checked on the server). */
function cleanSaved(x: unknown, id: string): { rec: RankedRecord; sig: string } | undefined {
  if (!isObj(x) || !isObj(x.rec) || typeof x.sig !== 'string' || !/^[a-f0-9]{64}$/.test(x.sig)) return undefined;
  const r = x.rec;
  const n = (v: unknown, hi: number) => { const k = num(v, 0, hi); return k !== null && k === Math.floor(k) ? k : null; };
  const elo = n(r.elo, 5000), points = n(r.points, 100000), w = n(r.w, 1e6), d = n(r.d, 1e6), l = n(r.l, 1e6), best = n(r.best, 100000);
  if (r.id !== id || typeof r.name !== 'string' || elo === null || points === null || w === null || d === null || l === null || best === null) return undefined;
  return { rec: { id, name: cleanName(r.name), elo, points, w, d, l, best }, sig: x.sig };
}

export const cleanName = (x: unknown) => (typeof x === 'string' ? x.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 16) : '') || 'Player';

function validFrame(x: unknown): InputFrame | null {
  if (!isObj(x)) return null;
  const seq = num(x.seq, 0, 2 ** 31);
  const mx = num(x.mx, -1.01, 1.01), mz = num(x.mz, -1.01, 1.01);
  if (seq === null || mx === null || mz === null) return null;
  if (!Array.isArray(x.ev) || x.ev.length > 4) return null;
  const ev: InputEvent[] = [];
  for (const e of x.ev) {
    if (!isObj(e) || !EVENT_KINDS.includes(e.k as InputEvent['k'])) return null;
    const p = e.p === undefined ? 0 : num(e.p, 0, 1);
    if (p === null) return null;
    const out: InputEvent = { k: e.k as InputEvent['k'], p, m: e.m === true };
    if (e.v !== undefined) {
      if (e.v !== 'chip' && e.v !== 'low' && e.v !== 'fake' && e.v !== 'placed' && e.v !== 'power' && e.v !== 'flick') return null;
      out.v = e.v;
    }
    if (e.x !== undefined || e.z !== undefined) {
      const ex = num(e.x, -80, 80), ez = num(e.z, -80, 80);
      if (ex === null || ez === null) return null;
      out.x = ex; out.z = ez; out.at = e.at === true;
    }
    if (e.r !== undefined) {
      const r = num(e.r, 0, 21);
      if (r === null || r !== Math.floor(r)) return null;
      out.r = r;
    }
    if (e.a !== undefined) {
      if (e.a !== 1 && e.a !== 2) return null;
      out.a = e.a;
    }
    ev.push(out);
  }
  return { seq: Math.floor(seq), mx, mz, sprint: x.sprint === true, jockey: x.jockey === true, contain: x.contain === true, close: x.close === true, ev };
}

/** Parse and validate one client message. Returns null for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x) || typeof x.t !== 'string') return null;
  switch (x.t) {
    case 'hello': {
      const v = num(x.v, 0, 1000);
      if (v === null) return null;
      const token = typeof x.token === 'string' && /^[a-f0-9]{32}$/.test(x.token) ? x.token : undefined;
      return { t: 'hello', v, token, name: cleanName(x.name) };
    }
    case 'create':
      return { t: 'create', name: cleanName(x.name) };
    case 'join': {
      const code = typeof x.code === 'string' ? x.code.toUpperCase().trim() : '';
      return { t: 'join', code, name: cleanName(x.name) };
    }
    case 'lobby': {
      const out: Extract<ClientMsg, { t: 'lobby' }> = { t: 'lobby' };
      if (x.club !== undefined) { if (!TEAMS.some((tm) => tm.id === x.club)) return null; out.club = x.club as string; }
      if (x.kit !== undefined) { if (x.kit !== 'home' && x.kit !== 'away') return null; out.kit = x.kit; }
      if (x.mentality !== undefined) { if (!MENTALITIES.includes(x.mentality as Mentality)) return null; out.mentality = x.mentality as Mentality; }
      if (x.minutes !== undefined) { if (!MATCH.allowedRealMinutes.includes(x.minutes as number)) return null; out.minutes = x.minutes as number; }
      if (x.ready !== undefined) { if (typeof x.ready !== 'boolean') return null; out.ready = x.ready; }
      if (x.swap !== undefined) out.swap = x.swap === true;
      return out;
    }
    case 'in': {
      if (!Array.isArray(x.f) || x.f.length === 0 || x.f.length > 8) return null;
      const f: InputFrame[] = [];
      for (const fr of x.f) {
        const v = validFrame(fr);
        if (!v) return null;
        f.push(v);
      }
      return { t: 'in', f };
    }
    case 'ping': {
      const c = num(x.c, 0, Number.MAX_SAFE_INTEGER);
      return c === null ? null : { t: 'ping', c };
    }
    case 'tactic':
      if (!MENTALITIES.includes(x.mentality as Mentality)) return null;
      if (x.tac !== undefined && !isObj(x.tac)) return null;
      return x.tac === undefined ? { t: 'tactic', mentality: x.mentality as Mentality } : { t: 'tactic', mentality: x.mentality as Mentality, tac: cleanTactics(x.tac as Partial<Tactics>) };
    case 'sub': {
      const id = num(x.id, 0, 21), bench = num(x.bench, 0, 4);
      return id === null || bench === null || id !== Math.floor(id) || bench !== Math.floor(bench) ? null : { t: 'sub', id, bench };
    }
    case 'rematch':
      return typeof x.want === 'boolean' ? { t: 'rematch', want: x.want } : null;
    case 'leave':
      return { t: 'leave' };
    case 'ranked': {
      const id = typeof x.id === 'string' && /^[a-f0-9]{32}$/.test(x.id) ? x.id : null;
      const key = typeof x.key === 'string' && /^[a-f0-9]{32}$/.test(x.key) ? x.key : null;
      if (!id || !key || typeof x.club !== 'string' || !ALL_CLUBS.some((tm) => tm.id === x.club)) return null;
      const saved = cleanSaved(x.saved, id);
      return saved ? { t: 'ranked', id, key, name: cleanName(x.name), club: x.club, saved } : { t: 'ranked', id, key, name: cleanName(x.name), club: x.club };
    }
    case 'unranked':
      return { t: 'unranked' };
    case 'board':
      return { t: 'board' };
    default:
      return null;
  }
}
