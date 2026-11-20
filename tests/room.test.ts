// Room lifecycle with a fake clock and in-memory connections (no sockets).
import { describe, expect, it } from 'vitest';
import { NET, SIM } from '../src/shared/config';
import type { ServerMsg } from '../src/shared/protocol';
import { PHASES, type Snapshot } from '../src/shared/snapshot';
import { Room, type Conn } from '../src/server/room';

class FakeConn implements Conn {
  msgs: (ServerMsg | Snapshot)[] = [];
  closed = false;
  send(m: object) { this.msgs.push(JSON.parse(JSON.stringify(m))); }
  close() { this.closed = true; }
  last<T extends string>(t: T) { return [...this.msgs].reverse().find((m) => (m as { t?: string }).t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  snaps() { return this.msgs.filter((m) => (m as Snapshot).k === 's') as Snapshot[]; }
}

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const room = new Room('ABCDE', { now: clock.now, log: () => {} });
  const a = new FakeConn(), b = new FakeConn();
  expect(room.join('a'.repeat(32), 'Alex', a)).toBe(0);
  expect(room.join('b'.repeat(32), 'Bea', b)).toBe(1);
  return { room, a, b, clock };
}

function startMatch(s: ReturnType<typeof setup>, minutes = 2) {
  const { room, clock } = s;
  room.handle('a'.repeat(32), { t: 'lobby', minutes });
  room.handle('a'.repeat(32), { t: 'lobby', ready: true });
  room.handle('b'.repeat(32), { t: 'lobby', ready: true });
  expect(room.state).toBe('countdown');
  clock.advance(3100);
  room.tick();
  expect(room.state).toBe('match');
}

function ticks(s: ReturnType<typeof setup>, n: number) {
  for (let i = 0; i < n; i++) { s.clock.advance(1000 / SIM.tickRate); s.room.tick(); }
}

describe('room', () => {
  it('seats two players, rejects a third, and picks different clubs', () => {
    const s = setup();
    expect(s.room.join('c'.repeat(32), 'Cal', new FakeConn())).toBe(-1);
    const st = s.room.stateFor(0);
    expect(st.seats[0]!.club).not.toBe(st.seats[1]!.club);
  });

  it('starts only when both are ready, and a settings change un-readies the other player', () => {
    const s = setup();
    s.room.handle('a'.repeat(32), { t: 'lobby', ready: true });
    s.room.handle('b'.repeat(32), { t: 'lobby', kit: 'away' });
    expect(s.room.stateFor(0).seats[0]!.ready).toBe(false);
    expect(s.room.state).toBe('lobby');
  });

  it('sends both players identical world snapshots at 20 Hz with their own acks', () => {
    const s = setup();
    startMatch(s);
    ticks(s, 120);
    const sa = s.a.snaps(), sb = s.b.snaps();
    expect(sa.length).toBeGreaterThanOrEqual(39);
    expect(sa.length).toBe(sb.length);
    const strip = (x: Snapshot) => ({ ...x, ack: 0 });
    expect(sa.map(strip)).toEqual(sb.map(strip));
    expect(s.a.last('start')!.side).toBe(0);
    expect(s.b.last('start')!.side).toBe(1);
  });

  it('applies inputs in sequence order, acks them and ignores stale or replayed frames', () => {
    const s = setup();
    startMatch(s);
    const f = (seq: number) => ({ seq, mx: 1, mz: 0, sprint: false, jockey: false, ev: [] });
    s.room.handle('a'.repeat(32), { t: 'in', f: [f(1), f(2)] });
    ticks(s, 3);
    expect(s.room.seats[0]!.ack).toBe(2);
    s.room.handle('a'.repeat(32), { t: 'in', f: [f(1), f(2)] }); // replay
    expect(s.room.seats[0]!.queue).toHaveLength(0);
    ticks(s, 3);
    expect(s.a.snaps().at(-1)!.ack).toBe(2);
  });

  it('caps action events per second so spamming cannot buy extra actions', () => {
    const s = setup();
    startMatch(s);
    const frames = Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, mx: 0, mz: 0, sprint: false, jockey: false, ev: [{ k: 'pass' as const }, { k: 'pass' as const }, { k: 'pass' as const }, { k: 'pass' as const }] }));
    s.room.handle('a'.repeat(32), { t: 'in', f: frames });
    const evs = s.room.seats[0]!.queue.reduce((n, q) => n + q.ev.length, 0);
    expect(evs).toBeLessThanOrEqual(20);
  });

  it('hands a disconnected team to the AI, resumes on reconnect, and abandons after the grace period', () => {
    const s = setup();
    startMatch(s);
    ticks(s, 60);
    s.room.disconnected(s.b);
    expect(s.room.match!.ctrl[1].human).toBe(false);
    expect(s.a.last('opp')).toMatchObject({ status: 'disconnected', graceMs: NET.reconnectGraceMs });
    ticks(s, 60);
    const b2 = new FakeConn();
    expect(s.room.join('b'.repeat(32), 'Bea', b2)).toBe(1); // same token resumes the same seat
    expect(s.room.match!.ctrl[1].human).toBe(true);
    expect(b2.last('start')!.side).toBe(1);
    expect(s.a.last('opp')!.status).toBe('reconnected');
    // Drop again and stay away past the grace period.
    s.room.disconnected(b2);
    s.clock.advance(NET.reconnectGraceMs + 100);
    s.room.tick();
    expect(s.room.state).toBe('results');
    expect(s.a.last('end')!.reason).toBe('abandoned');
  });

  it('limits total reconnect grace per player per match', () => {
    const s = setup();
    startMatch(s);
    s.room.disconnected(s.b);
    s.clock.advance(25_000);
    const b2 = new FakeConn();
    s.room.join('b'.repeat(32), 'Bea', b2);
    s.room.disconnected(b2);
    s.clock.advance(25_000);
    const b3 = new FakeConn();
    s.room.join('b'.repeat(32), 'Bea', b3);
    s.room.disconnected(b3);
    expect(s.a.last('opp')!.graceMs).toBe(NET.totalGraceMsPerMatch - 50_000);
  });

  it('plays to full time, then a mutual rematch restarts from 0-0', () => {
    const s = setup();
    startMatch(s);
    let n = 0;
    while (s.room.state === 'match' && n < 60 * 60 * 4) { ticks(s, 60); n += 60; }
    expect(s.room.state).toBe('results');
    expect(s.a.last('end')!.reason).toBe('fulltime');
    s.room.handle('a'.repeat(32), { t: 'rematch', want: true });
    expect(s.room.state).toBe('results');
    s.room.handle('b'.repeat(32), { t: 'rematch', want: true });
    expect(s.room.state).toBe('countdown');
    s.clock.advance(3100);
    s.room.tick();
    expect(s.room.state).toBe('match');
    expect(s.room.match!.score).toEqual([0, 0]);
    expect(s.room.match!.tick).toBe(0);
  }, 60_000);

  it('both players always get a full-time snapshot before the match ends (20 Nov 2026 frozen-at-full-time bug)', () => {
    // The final whistle can fall on any tick; try the three snapshot phases.
    for (let offset = 0; offset < 3; offset++) {
      const s = setup();
      startMatch(s);
      ticks(s, offset);
      while (s.room.state === 'match') ticks(s, 1);
      for (const c of [s.a, s.b]) {
        const snaps = c.snaps();
        expect(snaps[snaps.length - 1].ph).toBe(PHASES.indexOf('fulltime'));
        // The snapshot comes before the end message.
        const iSnap = c.msgs.lastIndexOf(snaps[snaps.length - 1]);
        const iEnd = c.msgs.findIndex((m) => (m as { t?: string }).t === 'end');
        expect(iSnap).toBeLessThan(iEnd);
      }
    }
  }, 120_000);

  it('a player leaving mid-match ends it for the other', () => {
    const s = setup();
    startMatch(s);
    s.room.leave('b'.repeat(32));
    expect(s.room.state).toBe('results');
    expect(s.a.last('end')!.reason).toBe('opponent_left');
  });

  it('expires idle lobbies', () => {
    const s = setup();
    expect(s.room.expired()).toBe(false);
    s.clock.advance(NET.lobbyIdleMs + 1);
    expect(s.room.expired()).toBe(true);
  });
});
