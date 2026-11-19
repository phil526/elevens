// Ranked online on the server (19 Nov 2026): who is who (a random id and secret key made on the
// player's device; only a hash of the key is kept), the queue, and the records. Records are kept
// in a JSON file (RANKED_FILE, default ./data/ranked.json) so they survive a restart; if the file
// can't be written the server still runs with them in memory.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyResult, newRecord, pairingWindow, type RankedRecord } from '../shared/ranked';

interface Stored { hash: string; rec: RankedRecord }

const hashKey = (key: string) => createHash('sha256').update(`elevens-ranked:${key}`).digest('hex');

export class RankStore {
  private all = new Map<string, Stored>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string | null, private log: (m: string) => void = () => {}) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Stored>;
        for (const [id, s] of Object.entries(raw)) if (s && typeof s.hash === 'string' && s.rec) this.all.set(id, s);
        log(`ranked: ${this.all.size} players loaded`);
      } catch (e) { log(`ranked: could not read ${file}: ${(e as Error).message}`); }
    }
  }

  /** The player's record (new players start in Division 10). Null if the key doesn't match the id. */
  identify(id: string, key: string, name: string): RankedRecord | null {
    const h = hashKey(key);
    const s = this.all.get(id);
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
