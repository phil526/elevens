// Friends league (20 Nov 2026): the table, signed results, a server that forgets and is rebuilt
// from members' devices, and league rooms reporting at full time.
import { describe, expect, it } from 'vitest';
import { SIM } from '../src/shared/config';
import { cleanResult, leagueTable, mergeResults, newLeagueCode, LEAGUE_CODE_RE, type LeagueResult } from '../src/shared/friends';
import { parseClientMsg } from '../src/shared/protocol';
import { FriendsStore } from '../src/server/friends';
import { Room, type Conn } from '../src/server/room';
import { TEAMS } from '../src/shared/teams';

const id = (c: string) => c.repeat(32);
const key = (c: string) => c.repeat(32);
const SECRET = 'x'.repeat(64);

describe('friends league', () => {
  it('makes 6-letter codes', () => {
    for (let i = 0; i < 20; i++) expect(LEAGUE_CODE_RE.test(newLeagueCode())).toBe(true);
  });

  it('signs results and takes back only genuine ones', () => {
    const st = new FriendsStore(SECRET);
    expect(typeof st.open('ABCDEF', 'Sunday Club', id('a'), key('1'), 'Ann', [])).toBe('object');
    st.open('ABCDEF', undefined, id('b'), key('2'), 'Bob', []);
    const r = st.record('ABCDEF', id('a'), id('b'), TEAMS[0].id, TEAMS[1].id, [3, 1])!;
    expect(r.sig).toMatch(/^[a-f0-9]{64}$/);
    expect(st.verify('ABCDEF', r)).toBe(true);
    expect(st.verify('ABCDEF', { ...r, s: [9, 0] })).toBe(false);
    expect(st.verify('ZZZZZZ', r)).toBe(false);
    // Non-members can't be recorded.
    expect(st.record('ABCDEF', id('a'), id('c'), TEAMS[0].id, TEAMS[1].id, [1, 0])).toBeNull();
  });

  it('a restarted server rebuilds the league from the results a member brings back', () => {
    const a = new FriendsStore(SECRET);
    a.open('ABCDEF', 'Sunday Club', id('a'), key('1'), 'Ann', []);
    a.open('ABCDEF', undefined, id('b'), key('2'), 'Bob', []);
    const r1 = a.record('ABCDEF', id('a'), id('b'), TEAMS[0].id, TEAMS[1].id, [2, 2], 1000)!;
    const r2 = a.record('ABCDEF', id('b'), id('a'), TEAMS[1].id, TEAMS[0].id, [1, 0], 2000)!;
    const forged: LeagueResult = { ...r2, id: 'f'.repeat(16), s: [0, 7] };
    const b = new FriendsStore(SECRET);
    const info = b.open('ABCDEF', 'Sunday Club', id('a'), key('1'), 'Ann', [r1, r2, forged]);
    if (typeof info === 'string') throw new Error(info);
    expect(info.name).toBe('Sunday Club');
    expect(info.results.map((r) => r.id)).toEqual([r1.id, r2.id]);
    expect(info.members.map((m) => m.name).sort()).toEqual(['Ann', 'Bob']);
    const t = leagueTable(info);
    expect(t[0]).toMatchObject({ name: 'Bob', pts: 4, w: 1, d: 1, l: 0 });
    expect(t[1]).toMatchObject({ name: 'Ann', pts: 1, w: 0, d: 1, l: 1 });
    // Bob's place came back from the results: he claims it with his key the first time.
    expect(typeof b.open('ABCDEF', undefined, id('b'), key('2'), 'Bob', [])).toBe('object');
    expect(b.open('ABCDEF', undefined, id('b'), key('9'), 'Bob', [])).toMatch(/another device/);
    // A different secret (another server) accepts none of them.
    const c = new FriendsStore('y'.repeat(64));
    const i2 = c.open('ABCDEF', 'X', id('a'), key('1'), 'Ann', [r1, r2]);
    expect(typeof i2 !== 'string' && i2.results.length).toBe(0);
  });

  it('checks league messages and results for shape', () => {
    const r = { id: 'a'.repeat(16), at: 5, a: id('a'), b: id('b'), an: 'Ann<', bn: 'Bob', ca: TEAMS[0].id, cb: TEAMS[1].id, s: [1, 2], sig: 'c'.repeat(64) };
    expect(cleanResult(r)?.an).toBe('Ann');
    expect(cleanResult({ ...r, s: [1.5, 2] })).toBeNull();
    expect(cleanResult({ ...r, b: id('a') })).toBeNull();
    const msg = parseClientMsg(JSON.stringify({ t: 'lg', code: 'ABCDEF', id: id('a'), key: key('1'), me: 'Ann', results: [r] }));
    expect(msg && msg.t === 'lg' && msg.results.length).toBe(1);
    expect(parseClientMsg(JSON.stringify({ t: 'lg', code: 'ABCDE', id: id('a'), key: key('1'), me: 'Ann', results: [] }))).toBeNull();
    const join = parseClientMsg(JSON.stringify({ t: 'join', code: 'ABCDE', name: 'Ann', lg: { code: 'ABCDEF', id: id('a') } }));
    expect(join && join.t === 'join' && join.lg?.code).toBe('ABCDEF');
    expect(mergeResults([{ ...r, s: [1, 2] } as LeagueResult], [{ ...r, s: [1, 2] } as LeagueResult]).length).toBe(1);
  });

  it('a room opened from the league by two members reports the result at full time', () => {
    class FC implements Conn { send() {} close() {} }
    let now = 1_000_000;
    const room = new Room('ABCDE', { now: () => now, log: () => {} });
    const got: unknown[] = [];
    room.onLeagueEnd = (_r, code, ids, clubs, score) => got.push({ code, ids, clubs, score });
    room.join('a'.repeat(32), 'Ann', new FC(), { code: 'ABCDEF', id: id('a') });
    room.join('b'.repeat(32), 'Bob', new FC(), { code: 'ABCDEF', id: id('b') });
    expect(room.stateFor(0).league).toBe('ABCDEF');
    room.handle('a'.repeat(32), { t: 'lobby', minutes: 2 });
    for (const t of ['a', 'b']) room.handle(t.repeat(32), { t: 'lobby', ready: true });
    now += 3100; room.tick();
    const m = (room as unknown as { match: { phase: string; endMatchNow?: () => void } }).match;
    for (let i = 0; i < 60 * 60 * 6 && room.state === 'match'; i++) { now += 1000 / SIM.tickRate; room.tick(); }
    expect(room.state).toBe('results');
    expect(m.phase).toBe('fulltime');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ code: 'ABCDEF', ids: [id('a'), id('b')] });
    // A 2 v 2 room is not a league match.
    room.handle('a'.repeat(32), { t: 'lobby', format: '2v2' });
  }, 60000);

  it('a room where only one player came from the league does not count', () => {
    class FC implements Conn { send() {} close() {} }
    const room = new Room('ABCDE', { now: () => 1, log: () => {} });
    room.join('a'.repeat(32), 'Ann', new FC(), { code: 'ABCDEF', id: id('a') });
    room.join('b'.repeat(32), 'Bob', new FC());
    expect(room.stateFor(0).league).toBeUndefined();
  });
});
