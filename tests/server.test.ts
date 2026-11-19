// End-to-end over real WebSockets against an in-process GameServer.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GameServer } from '../src/server/server';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/shared/protocol';
import type { Snapshot } from '../src/shared/snapshot';

const servers: GameServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

async function boot(opts: Partial<ConstructorParameters<typeof GameServer>[0]> = {}) {
  const s = new GameServer({ port: 0, host: '127.0.0.1', staticDir: null, log: () => {}, ...opts });
  servers.push(s);
  return { s, port: await s.listen() };
}

class Client {
  ws: WebSocket;
  msgs: (ServerMsg | Snapshot)[] = [];
  private waiters: { pred: (m: ServerMsg | Snapshot) => boolean; res: (m: ServerMsg | Snapshot) => void }[] = [];
  constructor(port: number, headers?: Record<string, string>) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    });
  }
  open() { return new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); }); }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  wait<T = ServerMsg>(pred: (m: ServerMsg | Snapshot) => boolean, ms = 4000): Promise<T> {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found as T);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m as T); } });
    });
  }
  waitT<T extends ServerMsg['t']>(t: T, ms?: number) { return this.wait<Extract<ServerMsg, { t: T }>>((m) => (m as { t?: string }).t === t, ms); }
  async hello(token?: string) {
    this.send({ t: 'hello', v: PROTOCOL_VERSION, token, name: 'Test' });
    return this.waitT('welcome');
  }
  close() { this.ws.close(); }
}

async function pair(port: number) {
  const a = new Client(port), b = new Client(port);
  await Promise.all([a.open(), b.open()]);
  const wa = await a.hello();
  await b.hello();
  a.send({ t: 'create', name: 'A' });
  const room = await a.waitT('room');
  b.send({ t: 'join', code: room.code, name: 'B' });
  await b.wait((m) => (m as { t?: string }).t === 'room' && (m as { seats: unknown[] }).seats[1] !== null);
  return { a, b, code: room.code, tokenA: wa.token };
}

async function startPair(port: number) {
  const p = await pair(port);
  p.a.send({ t: 'lobby', ready: true });
  p.b.send({ t: 'lobby', ready: true });
  await Promise.all([p.a.waitT('start', 6000), p.b.waitT('start', 6000)]);
  return p;
}

describe('game server', () => {
  it('serves a health endpoint', async () => {
    const { port } = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await r.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it('pairs two clients by room code and turns away a third', async () => {
    const { port } = await boot();
    const { a, b, code } = await pair(port);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    const c = new Client(port);
    await c.open();
    await c.hello();
    c.send({ t: 'join', code, name: 'C' });
    expect((await c.waitT('err')).code).toBe('room_full');
    a.close(); b.close(); c.close();
  });

  it('rejects invalid and unknown room codes', async () => {
    const { port } = await boot();
    const c = new Client(port);
    await c.open();
    await c.hello();
    c.send({ t: 'join', code: 'O0I1L', name: 'C' });
    expect((await c.waitT('err')).code).toBe('bad_code');
    c.msgs = [];
    c.send({ t: 'join', code: 'ZZZZZ', name: 'C' });
    expect((await c.waitT('err')).code).toBe('not_found');
    c.close();
  });

  it('streams the same authoritative match to both players', async () => {
    const { port } = await boot();
    const { a, b } = await startPair(port);
    await new Promise((r) => setTimeout(r, 1200));
    const sa = a.msgs.filter((m) => (m as Snapshot).k === 's') as Snapshot[];
    const sb = b.msgs.filter((m) => (m as Snapshot).k === 's') as Snapshot[];
    expect(sa.length).toBeGreaterThan(10);
    const byTick = new Map(sb.map((s) => [s.t, s]));
    let compared = 0;
    for (const s of sa) {
      const o = byTick.get(s.t);
      if (!o) continue;
      expect(o.b).toEqual(s.b);
      expect(o.sc).toEqual(s.sc);
      expect(o.p).toEqual(s.p);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
    a.close(); b.close();
  });

  it('keeps snapshot order and acks under simulated latency and jitter', async () => {
    const { port } = await boot({ latencyMs: 60, jitterMs: 40 });
    const { a, b } = await startPair(port);
    let seq = 0;
    const timer = setInterval(() => a.send({ t: 'in', f: [1, 2].map(() => ({ seq: ++seq, mx: 1, mz: 0, sprint: false, jockey: false, ev: [] })) }), 33);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(timer);
    const snaps = a.msgs.filter((m) => (m as Snapshot).k === 's') as Snapshot[];
    for (let i = 1; i < snaps.length; i++) {
      expect(snaps[i].t).toBeGreaterThan(snaps[i - 1].t);
      expect(snaps[i].ack).toBeGreaterThanOrEqual(snaps[i - 1].ack);
    }
    expect(snaps.at(-1)!.ack).toBeGreaterThan(0);
    a.close(); b.close();
  }, 15_000);

  it('a reconnecting player resumes their seat with their token', async () => {
    const { port } = await boot();
    const { a, b, tokenA } = await startPair(port);
    a.ws.terminate();
    await b.wait((m) => (m as { t?: string }).t === 'opp' && (m as { status: string }).status === 'disconnected');
    const a2 = new Client(port);
    await a2.open();
    const w = await a2.hello(tokenA);
    expect(w.resumed).toBe(true);
    expect((await a2.waitT('start')).side).toBe(0);
    await b.wait((m) => (m as { t?: string }).t === 'opp' && (m as { status: string }).status === 'reconnected');
    a2.close(); b.close();
  });

  it('rate-limits floods and closes connections that keep misbehaving', async () => {
    const { port } = await boot();
    const c = new Client(port);
    await c.open();
    await c.hello();
    for (let i = 0; i < 200; i++) c.send({ t: 'ping', c: i });
    expect((await c.waitT('err')).code).toBe('rate_limited');
    const closed = new Promise<number>((res) => c.ws.once('close', (code) => res(code)));
    for (let i = 0; i < 30; i++) c.ws.send('garbage');
    expect(await closed).toBe(1008);
  });

  it('refuses WebSocket upgrades from origins not on the allow-list', async () => {
    const { port } = await boot({ allowedOrigins: ['https://play.example.org'] });
    const bad = new Client(port, { origin: 'https://evil.example.com' });
    await expect(bad.open()).rejects.toThrow();
    const good = new Client(port, { origin: 'https://play.example.org' });
    await good.open();
    good.close();
  });
});
