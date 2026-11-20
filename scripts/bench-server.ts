// Server cost of one online room: CPU per 60 Hz tick and snapshot bytes (raw and deflated).
// npx tsx scripts/bench-server.ts [seconds]
import { deflateRawSync } from 'node:zlib';
import { SIM } from '../src/shared/config';
import { Room, type Conn } from '../src/server/room';

const secs = Number(process.argv[2] ?? 120);
let now = 1_000_000;
const room = new Room('ABCDE', { now: () => now, log: () => {} });
let raw = 0, packed = 0, n = 0;
const window: Buffer[] = [];
class C implements Conn {
  constructor(private count: boolean) {}
  send(m: object) {
    if (!this.count) return;
    const s = Buffer.from(JSON.stringify(m));
    raw += s.length; n++;
    // Approximate permessage-deflate with context takeover: compress this message after the previous ones.
    const prev = Buffer.concat(window);
    packed += deflateRawSync(Buffer.concat([prev, s])).length - (prev.length ? deflateRawSync(prev).length : 0);
    window.push(s); if (window.length > 8) window.shift();
  }
  close() {}
}
room.join('a'.repeat(32), 'A', new C(true));
room.join('b'.repeat(32), 'B', new C(false));
room.handle('a'.repeat(32), { t: 'lobby', minutes: 4 } as never);
room.handle('a'.repeat(32), { t: 'lobby', ready: true } as never);
room.handle('b'.repeat(32), { t: 'lobby', ready: true } as never);
now += 3100; room.tick();
const ticks = secs * SIM.tickRate;
const t0 = performance.now();
let worst = 0;
for (let i = 0; i < ticks; i++) {
  now += 1000 / SIM.tickRate;
  const a = performance.now();
  room.tick();
  worst = Math.max(worst, performance.now() - a);
}
const ms = performance.now() - t0;
console.log(JSON.stringify({ secs, msPerTick: +(ms / ticks).toFixed(3), worstTickMs: +worst.toFixed(2), cpuShare: +(ms / (secs * 1000)).toFixed(4), snaps: n, avgRaw: Math.round(raw / n), avgDeflated: Math.round(packed / n), kbPerSecRaw: +(raw / secs / 1024).toFixed(1), kbPerSecDeflated: +(packed / secs / 1024).toFixed(1) }));
