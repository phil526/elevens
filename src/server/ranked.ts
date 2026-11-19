// Ranked online on the server (19 Nov 2026): who is who (a random id and secret key made on the
// player's device; only a hash of the key is kept), the queue, and the records. Records are kept
// in a JSON file (RANKED_FILE, default ./data/ranked.json) so they survive a restart; if the file
// can't be written the server still runs with them in memory.
// Hosts with no lasting disk (Render's free plan) lose the file whenever the server sleeps, so every
// record the server sends is also signed (HMAC with RANKED_SECRET) and the player's device keeps it:
// a server that doesn't know a player takes the signed record back when they next play ranked.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyResult, newRecord, pairingWindow, type RankedRecord } from '../shared/ranked';

interface Stored { hash: string; rec: RankedRecord }

const hashKey = (key: string) => createHash('sha256').update(`elevens-ranked:${key}`).digest('hex');

export class RankStore {
  private all = new Map<string, Stored>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  private secret: string;

  constructor(private file: string | null, private log: (m: string) => void = () => {}, secret: string | null = null) {
    // Without a fixed secret, signatures only last as long as this process.
    this.secret = secret || randomBytes(32).toString('hex');
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Stored>;
        for (const [id, s] of Object.entries(raw)) if (s && typeof s.hash === 'string' && s.rec) this.all.set(id, s);
        log(`ranked: ${this.all.size} players loaded`);
      } catch (e) { log(`ranked: could not read ${file}: ${(e as Error).message}`); }
    }
  }

  /** The player's record (new players start in Division 10). Null if the key doesn't match the id. */
  identify(id: string, key: string, name: string, saved?: { rec: RankedRecord; sig: string }): RankedRecord | null {
    const h = hashKey(key);
    let s = this.all.get(id);
    if (!s && saved && saved.rec.id === id && this.check(h, saved.rec, saved.sig)) {
      // A player this server doesn't know (it restarted) brought back their signed record.
      s = { hash: h, rec: { ...saved.rec } };
      this.all.set(id, s);
      this.touch();
      this.log(`ranked: record restored for ${id.slice(0, 6)} (${saved.rec.points} points)`);
    }
    if (s) {
      if (s.hash !== h) return null;
      if (name && s.rec.name !== name) { s.rec.name = name; this.touch(); }
      return s.rec;
    }
    const rec = newRecord(id, name);
    this.all.set(id, { hash: h, rec });
    this.touch();
    return rec;
  }

  get(id: string): RankedRecord | null { return this.all.get(id)?.rec ?? null; }

  /** The signature of a player's current record, for their device to keep. */
  sign(id: string): string | undefined {
    const s = this.all.get(id);
    return s ? this.mac(s.hash, s.rec) : undefined;
  }

  private mac(hash: string, r: RankedRecord): string {
    return createHmac('sha256', this.secret).update(JSON.stringify([hash, r.id, r.name, r.elo, r.points, r.w, r.d, r.l, r.best])).digest('hex');
  }

  private check(hash: string, rec: RankedRecord, sig: string): boolean {
    const want = Buffer.from(this.mac(hash, rec), 'hex'), got = Buffer.from(sig, 'hex');
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** A finished ranked match: both records move. Returns the before/after for each side. */
  record(a: string, b: string, result: 'A' | 'B' | 'D'): { before: [RankedRecord, RankedRecord]; after: [RankedRecord, RankedRecord]; delta: [number, number] } | null {
    const sa = this.all.get(a), sb = this.all.get(b);
    if (!sa || !sb) return null;
    const before: [RankedRecord, RankedRecord] = [{ ...sa.rec }, { ...sb.rec }];
    const ra = applyResult(sa.rec, sb.rec.elo, result === 'A' ? 'W' : result === 'B' ? 'L' : 'D');
    const rb = applyResult(sb.rec, sa.rec.elo, result === 'B' ? 'W' : result === 'A' ? 'L' : 'D');
    sa.rec = ra.rec;
    sb.rec = rb.rec;
    this.touch();
    return { before, after: [ra.rec, rb.rec], delta: [ra.delta, rb.delta] };
  }

  top(n = 20): RankedRecord[] {
    return [...this.all.values()].map((s) => s.rec).filter((r) => r.w + r.d + r.l > 0).sort((x, y) => y.points - x.points || y.elo - x.elo).slice(0, n);
  }

  get size() { return this.all.size; }

  private touch() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 2000);
  }

  flush() {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.all)));
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { this.log(`ranked: could not save ${this.file}: ${(e as Error).message}`); this.file = null; }
  }
}

export interface QueueEntry<T> { who: T; id: string; elo: number; club: string; since: number }

/** Players waiting for a ranked match. */
export class RankQueue<T> {
  list: QueueEntry<T>[] = [];

  add(e: QueueEntry<T>) { this.remove(e.who); this.list.push(e); }
  remove(who: T) { this.list = this.list.filter((x) => x.who !== who); }
  has(who: T) { return this.list.some((x) => x.who === who); }

  /** Pairs everyone who can be paired now (the longest-waiting first). */
  pairs(now: number): [QueueEntry<T>, QueueEntry<T>][] {
    const out: [QueueEntry<T>, QueueEntry<T>][] = [];
    const left = this.list.slice().sort((a, b) => a.since - b.since);
    while (left.length > 1) {
      const a = left.shift()!;
      const win = pairingWindow((now - a.since) / 1000);
      let best = -1, gap = Infinity;
      left.forEach((b, i) => {
        if (b.id === a.id) return;
        const g = Math.abs(a.elo - b.elo);
        const w = Math.max(win, pairingWindow((now - b.since) / 1000));
        if (g <= w && g < gap) { gap = g; best = i; }
      });
      if (best >= 0) out.push([a, left.splice(best, 1)[0]]);
    }
    for (const [a, b] of out) { this.remove(a.who); this.remove(b.who); }
    return out;
  }
}
