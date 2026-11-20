// Friends leagues on the match server (20 Nov 2026), held in memory only: the free host has no
// lasting disk, so members' devices keep each league and its signed results and bring them back.
// The server signs every result it makes (HMAC, the same secret as ranked records) and only takes
// back results whose signature checks out, so nobody can add a match that was never played.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LEAGUE, mergeResults, resultPayload, type LeagueInfo, type LeagueResult } from '../shared/friends';

interface Member { name: string; hash: string }
interface League { name: string; named: boolean; members: Map<string, Member>; results: LeagueResult[]; touched: number }

const MAX_LEAGUES = 5000;
const hashKey = (key: string) => createHash('sha256').update(`elevens-friends:${key}`).digest('hex');

export class FriendsStore {
  private leagues = new Map<string, League>();

  constructor(private secret: string) {}

  sign(code: string, r: Omit<LeagueResult, 'sig'>): string {
    return createHmac('sha256', this.secret).update(resultPayload(code, r)).digest('hex');
  }

  verify(code: string, r: LeagueResult): boolean {
    const want = Buffer.from(this.sign(code, r), 'hex');
    const got = Buffer.from(r.sig, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * Open a league as one of its members: made if new (with the name given), the member added or
   * renamed, and any signed results they bring merged in. Null (with why) if it can't be opened.
   */
  open(code: string, name: string | undefined, id: string, key: string, me: string, results: LeagueResult[], now = Date.now()): LeagueInfo | string {
    let lg = this.leagues.get(code);
    // Results only count when signed for this league; a league the server forgot is rebuilt from them.
    const good = results.filter((r) => this.verify(code, r));
    if (!lg) {
      if (this.leagues.size >= MAX_LEAGUES) this.evict();
      lg = { name: name || `League ${code}`, named: !!name, members: new Map(), results: [], touched: now };
      this.leagues.set(code, lg);
    } else if (name && !lg.named) { lg.name = name; lg.named = true; }
    const h = hashKey(key);
    const m = lg.members.get(id);
    if (m) {
      // A member the server only knows from results takes their place the first time they open it.
      if (m.hash && m.hash !== h) return 'That league place belongs to another device.';
      m.hash = h;
      m.name = me;
    } else {
      if (lg.members.size >= LEAGUE.maxMembers) return `That league is full (${LEAGUE.maxMembers} players).`;
      lg.members.set(id, { name: me, hash: h });
    }
    if (good.length) lg.results = mergeResults(lg.results, good);
    // A league the server forgot gets its members back from the results (each claims their place
    // with their key the next time they open it).
    for (const r of good) for (const [pid, pn] of [[r.a, r.an], [r.b, r.bn]] as const) if (!lg.members.has(pid) && lg.members.size < LEAGUE.maxMembers) lg.members.set(pid, { name: pn, hash: '' });
    lg.touched = now;
    return this.info(code)!;
  }

  info(code: string): LeagueInfo | null {
    const lg = this.leagues.get(code);
    if (!lg) return null;
    return { code, name: lg.name, members: [...lg.members].map(([id, m]) => ({ id, name: m.name })), results: lg.results };
  }

  /** Is this player a member (the room only counts matches between members)? */
  isMember(code: string, id: string): boolean { return !!this.leagues.get(code)?.members.has(id); }

  /** A match between two members has finished: the signed result, kept here and sent to both. */
  record(code: string, a: string, b: string, ca: string, cb: string, s: [number, number], now = Date.now()): LeagueResult | null {
    const lg = this.leagues.get(code);
    if (!lg || a === b || !lg.members.has(a) || !lg.members.has(b)) return null;
    const base = { id: randomBytes(8).toString('hex'), at: now, a, b, an: lg.members.get(a)!.name, bn: lg.members.get(b)!.name, ca, cb, s: [s[0], s[1]] as [number, number] };
    const r: LeagueResult = { ...base, sig: this.sign(code, base) };
    lg.results = mergeResults(lg.results, [r]);
    lg.touched = now;
    return r;
  }

  /** Too many leagues in memory: forget the tenth least recently used (their members still have them). */
  private evict() {
    const old = [...this.leagues].sort((x, y) => x[1].touched - y[1].touched).slice(0, Math.ceil(MAX_LEAGUES / 10));
    for (const [code] of old) this.leagues.delete(code);
  }
}
