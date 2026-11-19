// Online hosting (19 Nov 2026): which match server the client picks, waking a sleeping free
// server, compression, the server's own pages, and ranked records that survive a restart.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { healthUrl, isLocalHost, mayBeAsleep, PLAY_URL, PUBLIC_SERVER, serverUrl } from '../src/client/net/hosting';
import { RankStore } from '../src/server/ranked';
import { GameServer } from '../src/server/server';
import { parseClientMsg } from '../src/shared/protocol';
import { ALL_CLUBS } from '../src/shared/teams';

const loc = (href: string) => {
  const u = new URL(href);
  return { search: u.search, protocol: u.protocol, host: u.host, hostname: u.hostname, origin: u.origin };
};

describe('choosing the match server', () => {
  it('uses the public server from the game\'s own address and other web hosts', () => {
    expect(serverUrl(loc(PLAY_URL), '', false)).toBe(PUBLIC_SERVER);
    expect(serverUrl(loc('https://abc.claudeusercontent.com/x'), '', false)).toBe(PUBLIC_SERVER);
    expect(PUBLIC_SERVER).toMatch(/^wss:\/\/.+\/ws$/);
  });
  it('uses the page\'s own server on this machine or network, or when the server served the page', () => {
    expect(serverUrl(loc('http://localhost:8787/?test'), '', false)).toBe('ws://localhost:8787/ws');
    expect(serverUrl(loc('http://192.168.1.20:8787/'), '', false)).toBe('ws://192.168.1.20:8787/ws');
    expect(serverUrl(loc('https://elevens.example.com/'), '', true)).toBe('wss://elevens.example.com/ws');
  });
  it('a ?server= in the address or a build setting wins', () => {
    expect(serverUrl(loc('https://x.github.io/elevens/?server=wss://other.example/ws'), 'wss://env.example/ws', false)).toBe('wss://other.example/ws');
    expect(serverUrl(loc('https://x.github.io/elevens/'), 'wss://env.example/ws', false)).toBe('wss://env.example/ws');
  });
  it('knows the health address and which servers may be asleep', () => {
    expect(healthUrl('wss://a.onrender.com/ws')).toBe('https://a.onrender.com/health');
    expect(healthUrl('ws://localhost:8787/ws')).toBe('http://localhost:8787/health');
    expect(mayBeAsleep('wss://a.onrender.com/ws')).toBe(true);
    expect(mayBeAsleep('ws://127.0.0.1:8787/ws')).toBe(false);
    expect(isLocalHost('172.20.0.3')).toBe(true);
    expect(isLocalHost('172.40.0.3')).toBe(false);
  });
});

const servers: GameServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });
async function boot(opts: Partial<ConstructorParameters<typeof GameServer>[0]> = {}) {
  const s = new GameServer({ port: 0, host: '127.0.0.1', staticDir: null, log: () => {}, ...opts });
  servers.push(s);
  return { s, port: await s.listen() };
}
const open = (ws: WebSocket) => new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });

describe('hosted server', () => {
  it('lets any page check its health (the game wakes a sleeping server this way)', async () => {
    const { port } = await boot();
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: 'https://phil526.github.io' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('sends visitors to the game\'s own address when it doesn\'t serve the client', async () => {
    const { port } = await boot({ playUrl: 'https://phil526.github.io/elevens/' });
    const r = await fetch(`http://127.0.0.1:${port}/?room=ABCDE`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://phil526.github.io/elevens/?room=ABCDE');
  });

  it('marks the pages it serves, and always accepts sockets from its own pages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elevens-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
    const { port } = await boot({ staticDir: dir, allowedOrigins: ['https://phil526.github.io'] });
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('<meta name="elevens-server" content="self">');
    const own = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    await open(own);
    own.close();
    const pages = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'https://phil526.github.io' } });
    await open(pages);
    pages.close();
    const other = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'https://evil.example.com' } });
    await expect(open(other)).rejects.toThrow();
  });

  it('compresses messages when the browser offers it', async () => {
    const { port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await open(ws);
    expect(ws.extensions).toContain('permessage-deflate');
    ws.close();
  });
});

describe('ranked records on a server with no lasting disk', () => {
  const id = 'a'.repeat(32), key = 'b'.repeat(32), other = 'c'.repeat(32);

  it('a restarted server takes back a signed record, and refuses a changed one or another device\'s', () => {
    const before = new RankStore(null, () => {}, 'secret-1');
    before.identify(id, key, 'Ann');
    before.identify(other, 'd'.repeat(32), 'Bob');
    const out = before.record(id, other, 'A')!;
    const rec = out.after[0];
    const sig = before.sign(id)!;
    expect(sig).toMatch(/^[a-f0-9]{64}$/);

    const after = new RankStore(null, () => {}, 'secret-1'); // same secret, empty memory
    expect(after.identify(id, key, 'Ann', { rec: { ...rec, points: rec.points + 500 }, sig })?.points).toBe(0); // tampered: fresh record
    const again = new RankStore(null, () => {}, 'secret-1');
    expect(again.identify(id, 'e'.repeat(32), 'Ann', { rec, sig })?.points).toBe(0); // wrong key
    const ok = new RankStore(null, () => {}, 'secret-1');
    expect(ok.identify(id, key, 'Ann', { rec, sig })).toMatchObject({ points: rec.points, w: 1 });
    const otherSecret = new RankStore(null, () => {}, 'secret-2');
    expect(otherSecret.identify(id, key, 'Ann', { rec, sig })?.points).toBe(0);
  });

  it('a known player keeps the server\'s record (an old saved copy can\'t replace it)', () => {
    const st = new RankStore(null, () => {}, 's');
    st.identify(id, key, 'Ann');
    st.identify(other, 'd'.repeat(32), 'Bob');
    const old = { rec: st.get(id)!, sig: st.sign(id)! };
    st.record(id, other, 'B');
    expect(st.identify(id, key, 'Ann', { rec: { ...old.rec }, sig: old.sig })?.l).toBe(1);
  });

  it('checks saved records in ranked messages', () => {
    const club = ALL_CLUBS[0].id;
    const rec = { id, name: 'Ann', elo: 1016, points: 25, w: 1, d: 0, l: 0, best: 25 };
    const m = parseClientMsg(JSON.stringify({ t: 'ranked', id, key, name: 'Ann', club, saved: { rec, sig: 'f'.repeat(64) } }));
    expect(m).toMatchObject({ t: 'ranked', saved: { rec } });
    const bad = parseClientMsg(JSON.stringify({ t: 'ranked', id, key, name: 'Ann', club, saved: { rec: { ...rec, id: other }, sig: 'f'.repeat(64) } }));
    expect(bad).toMatchObject({ t: 'ranked' });
    expect((bad as { saved?: unknown }).saved).toBeUndefined();
  });
});

