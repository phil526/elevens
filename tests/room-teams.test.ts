// Team rooms (20 Nov 2026): two against two, and two people together against the computer.
import { describe, expect, it } from 'vitest';
import { NET, SIM } from '../src/shared/config';
import type { ServerMsg } from '../src/shared/protocol';
import type { Snapshot } from '../src/shared/snapshot';
import { Room, type Conn } from '../src/server/room';

class FakeConn implements Conn {
  msgs: (ServerMsg | Snapshot)[] = [];
  send(m: object) { this.msgs.push(JSON.parse(JSON.stringify(m))); }
  close() {}
  last<T extends string>(t: T) { return [...this.msgs].reverse().find((m) => (m as { t?: string }).t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  snaps() { return this.msgs.filter((m) => (m as Snapshot).k === 's') as Snapshot[]; }
}
const tok = (c: string) => c.repeat(32);

function room() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  return { room: new Room('ABCDE', { now: clock.now, log: () => {} }), clock };
}
const ticks = (r: ReturnType<typeof room>, n: number) => { for (let i = 0; i < n; i++) { r.clock.advance(1000 / SIM.tickRate); r.room.tick(); } };
const go = (r: ReturnType<typeof room>, toks: string[]) => {
  for (const t of toks) r.room.handle(t, { t: 'lobby', ready: true });
  expect(r.room.state).toBe('countdown');
  r.clock.advance(3100);
  r.room.tick();
  expect(r.room.state).toBe('match');
};

describe('two against two', () => {
  it('seats four, two a side, starts with a co-op mate on each side, and sends each seat its slot', () => {
    const r = room();
    const c = [new FakeConn(), new FakeConn(), new FakeConn(), new FakeConn()];
    expect(r.room.join(tok('a'), 'Ann', c[0])).toBe(0);
    r.room.handle(tok('a'), { t: 'lobby', format: '2v2' });
    expect(r.room.join(tok('b'), 'Ben', c[1])).toBe(1);
    expect(r.room.join(tok('c'), 'Cat', c[2])).toBe(2);
    expect(r.room.join(tok('d'), 'Dev', c[3])).toBe(3);
    expect(r.room.join(tok('e'), 'Eve', new FakeConn())).toBe(-1);
    const st = r.room.stateFor(2);
    expect(st.format).toBe('2v2');
    expect(st.seats.filter(Boolean)).toHaveLength(4);
    expect(st.seats[0]!.club).toBe(st.seats[2]!.club);
    // Three ready is not enough.
    for (const t of ['a', 'b', 'c']) r.room.handle(tok(t), { t: 'lobby', ready: true });
    expect(r.room.state).toBe('lobby');
    go(r, [tok('d')]);
    const m = r.room.match!;
    expect(m.ctrl[0].human && m.ctrl[1].human).toBe(true);
    expect(m.mates[0]?.human && m.mates[1]?.human).toBe(true);
    expect(c[2].last('start')).toMatchObject({ side: 0, slot: 1, format: '2v2' });
    expect(c[3].last('start')).toMatchObject({ side: 1, slot: 1 });
    ticks(r, 30);
    const s2 = c[2].snaps().at(-1)!;
    expect(s2.sl).toBe(1);
    expect(s2.mt![0]).toBeGreaterThanOrEqual(0);
    expect(s2.mt![0]).not.toBe(s2.ctl[0]);
    // Kick off (the side kicking off's main player passes), then the mate seat's input moves the mate's player.
    const k = m.restart!.team;
    r.room.handle(tok(k === 0 ? 'a' : 'b'), { t: 'in', f: [{ seq: 1, mx: 0, mz: 0, sprint: false, jockey: false, ev: [{ k: 'pass', p: 0.3 }] }] });
    for (let i = 0; i < 600 && m.phase !== 'play'; i++) ticks(r, 1);
    expect(m.phase).toBe('play');
    // One frame a tick, as a client sends them: a second of running covers several metres. (The
    // mate's control can auto-switch while defending, so add up whoever it is on each tick.)
    let moved = 0;
    for (let i = 1; i <= 60; i++) {
      const pid = m.mates[0]!.pid, z0 = m.players[pid].pos.z;
      r.room.handle(tok('c'), { t: 'in', f: [{ seq: i, mx: 0, mz: 1, sprint: false, jockey: false, ev: [] }] });
      ticks(r, 1);
      if (m.mates[0]!.pid === pid) moved += m.players[pid].pos.z - z0;
    }
    expect(moved).toBeGreaterThan(2.5);
  });

  it('when a side\'s main player drops, the partner becomes the main control and the match goes on', () => {
    const r = room();
    const c = [new FakeConn(), new FakeConn(), new FakeConn(), new FakeConn()];
    r.room.join(tok('a'), 'Ann', c[0]);
    r.room.handle(tok('a'), { t: 'lobby', format: '2v2' });
    for (const [i, t] of ['b', 'c', 'd'].entries()) r.room.join(tok(t), t, c[i + 1]);
    go(r, ['a', 'b', 'c', 'd'].map(tok));
    const m = r.room.match!;
    r.room.disconnected(c[0]);
    expect(m.ctrl[0].human).toBe(true);
    expect(m.mates[0]!.human).toBe(false);
    expect(r.room.seats[2]!.slot).toBe(0);
    expect(c[2].last('opp')).toMatchObject({ status: 'disconnected', who: 'Ann', mate: true });
    // Past the grace period the match carries on with the computer in Ann's place.
    r.clock.advance(NET.reconnectGraceMs + 100);
    ticks(r, 5);
    expect(r.room.state).toBe('match');
  });
});

describe('together against the computer', () => {
  it('seats two on one side against a computer side at the chosen level', () => {
    const r = room();
    const c = [new FakeConn(), new FakeConn()];
    r.room.join(tok('a'), 'Ann', c[0]);
    r.room.handle(tok('a'), { t: 'lobby', format: 'coop', aiDiff: 'elite' });
    expect(r.room.join(tok('b'), 'Ben', c[1])).toBe(2);
    expect(r.room.join(tok('x'), 'Xi', new FakeConn())).toBe(-1);
    go(r, [tok('a'), tok('b')]);
    const m = r.room.match!;
    expect(m.ctrl[0].human).toBe(true);
    expect(m.mates[0]?.human).toBe(true);
    expect(m.ctrl[1].human).toBe(false);
    expect(m.cfg.difficulty[1]).toBe('elite');
    expect(c[1].last('start')).toMatchObject({ side: 0, slot: 1, format: 'coop' });
  });

  it('refuses to switch to one against one with three in the room, and re-seats on a format change', () => {
    const r = room();
    r.room.join(tok('a'), 'Ann', new FakeConn());
    r.room.handle(tok('a'), { t: 'lobby', format: '2v2' });
    r.room.join(tok('b'), 'Ben', new FakeConn());
    r.room.join(tok('c'), 'Cat', new FakeConn());
    r.room.handle(tok('a'), { t: 'lobby', format: '1v1' });
    expect(r.room.format).toBe('2v2');
    r.room.leave(tok('c'));
    r.room.handle(tok('a'), { t: 'lobby', format: 'coop' });
    expect(r.room.format).toBe('coop');
    expect(r.room.seats[0]?.name).toBe('Ann');
    expect(r.room.seats[2]?.name).toBe('Ben');
  });
});
