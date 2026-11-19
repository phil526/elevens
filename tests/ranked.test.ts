// Ranked online (19 Nov 2026): divisions, points, the queue and a ranked match over real WebSockets.
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GameServer } from '../src/server/server';
import { RankQueue, RankStore } from '../src/server/ranked';
import { PROTOCOL_VERSION, parseClientMsg, type ServerMsg } from '../src/shared/protocol';
import { ALL_CLUBS } from '../src/shared/teams';
import { applyResult, divisionName, divisionOf, newRecord } from '../src/shared/ranked';

describe('ranked rules', () => {
  it('climbs from Division 10 to Elite in 100-point steps', () => {
    expect(divisionOf(0)).toBe(10);
    expect(divisionOf(99)).toBe(10);
    expect(divisionOf(100)).toBe(9);
    expect(divisionOf(950)).toBe(1);
    expect(divisionOf(1000)).toBe(0);
    expect(divisionName(1200)).toBe('Elite');
  });

  it('a win earns more against a stronger player; a defeat costs points but never below zero', () => {
    const me = { ...newRecord('a', 'A'), points: 150 };
    const even = applyResult(me, 1000, 'W'), upset = applyResult(me, 1300, 'W');
    expect(even.delta).toBe(25);
    expect(upset.delta).toBeGreaterThan(even.delta);
    expect(applyResult(me, 1000, 'D').delta).toBe(8);
    expect(applyResult(me, 1000, 'L').rec.points).toBe(138);
    expect(applyResult(newRecord('b', 'B'), 1000, 'L').rec.points).toBe(0);
    expect(even.rec.elo).toBeGreaterThan(1000);
  });

  it('the queue pairs close ratings at once and wider ones after a wait', () => {
    const q = new RankQueue<string>();
    q.add({ who: 'a', id: 'a', elo: 1000, club: 'x', since: 0 });
    q.add({ who: 'b', id: 'b', elo: 1400, club: 'x', since: 0 });
    expect(q.pairs(1000)).toHaveLength(0);
    expect(q.pairs(20000)).toHaveLength(1);
    expect(q.list).toHaveLength(0);
  });

  it('keeps only a hash of the key: the wrong key is refused', () => {
    const st = new RankStore(null);
    const id = 'a'.repeat(32);
    expect(st.identify(id, 'b'.repeat(32), 'Ann')).not.toBeNull();
    expect(st.identify(id, 'c'.repeat(32), 'Ann')).toBeNull();
    expect(JSON.stringify(st.top())).not.toContain('b'.repeat(32));
  });

  it('validates ranked messages', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'ranked', id: 'a'.repeat(32), key: 'b'.repeat(32), name: 'X', club: 'nope' }))).toBeNull();
    const ok = parseClientMsg(JSON.stringify({ t: 'ranked', id: 'a'.repeat(32), key: 'b'.repeat(32), name: 'X', club: ALL_CLUBS[3].id }));
    expect(ok?.t).toBe('ranked');
  });
});

const servers: GameServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

class C {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString())));
  }
  open() { return new Promise<void>((res) => this.ws.once('open', () => res())); }
  send(m: object) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true, ms = 8000) {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.msgs.find((x) => x.t === t && pred(x as Extract<ServerMsg, { t: T }>));
      if (m) return m as Extract<ServerMsg, { t: T }>;
      if (Date.now() > end) throw new Error(`timeout waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe('ranked over the network', () => {
  it('pairs two queued players into a ranked match; the one who leaves loses points', async () => {
    const s = new GameServer({ port: 0, host: '127.0.0.1', staticDir: null, log: () => {} });
    servers.push(s);
    const port = await s.listen();
    const clubs = (await import('../src/shared/teams')).ALL_CLUBS;
    const a = new C(port), b = new C(port);
    await Promise.all([a.open(), b.open()]);
    for (const c of [a, b]) c.send({ t: 'hello', v: PROTOCOL_VERSION, name: c === a ? 'Ann' : 'Bob' });
    await a.wait('welcome'); await b.wait('welcome');
    a.send({ t: 'ranked', id: '1'.repeat(32), key: '2'.repeat(32), name: 'Ann', club: clubs[5].id });
    b.send({ t: 'ranked', id: '3'.repeat(32), key: '4'.repeat(32), name: 'Bob', club: clubs[7].id });
    const ra = await a.wait('rank');
    expect(ra.rec.points).toBe(0);
    const room = await a.wait('room', (m) => !!m.ranked && m.seats.every(Boolean));
    expect(room.seats.map((x) => x!.club).sort()).toEqual([clubs[5].id, clubs[7].id].sort());
    await a.wait('start', () => true, 9000);
    b.send({ t: 'leave' });
    const res = await a.wait('rankres');
    expect(res.delta).toBeGreaterThan(0);
    expect(res.after.w).toBe(1);
    expect(s.ranks.get('3'.repeat(32))!.l).toBe(1);
    a.send({ t: 'board' });
    const board = await a.wait('board');
    expect(board.top[0].name).toBe('Ann');
    a.ws.close(); b.ws.close();
  }, 20000);
});
