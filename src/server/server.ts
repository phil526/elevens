// HTTP + WebSocket game server. Serves the built client (optional), a health
// endpoint, and private rooms at /ws. All match logic runs here at 60 Hz.

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { NET, SIM } from '../shared/config';
import { parseClientMsg, PROTOCOL_VERSION, ROOM_CODE_RE, type ServerMsg } from '../shared/protocol';
import { newCode, newToken, Room, type Conn } from './room';
import { RankQueue, RankStore } from './ranked';

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir?: string | null;
  allowedOrigins?: string[];
  latencyMs?: number;
  jitterMs?: number;
  /** Ranked records file (null: kept in memory only). */
  rankedFile?: string | null;
  /** Secret that signs the ranked records players keep, so a restarted server can take them back. */
  rankedSecret?: string | null;
  /** The game's own address: when the client isn't served here, `/` sends visitors there. */
  playUrl?: string | null;
  /** Compress WebSocket messages (permessage-deflate). Default on. */
  compress?: boolean;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

interface Client {
  ws: WebSocket;
  token: string | null;
  room: Room | null;
  tokens: number; // rate-limit bucket
  lastRefill: number;
  violations: number;
  conn: Conn;
  name: string;
  /** Ranked id once the player has identified (19 Nov 2026). */
  rankedId: string | null;
}

export class GameServer {
  http: Server;
  wss: WebSocketServer;
  rooms = new Map<string, Room>();
  private byToken = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private acc = 0;
  private log: (m: string) => void;
  tickMs = 0;
  ranks: RankStore;
  queue = new RankQueue<Client>();
  private lastPair = 0;

  constructor(private opts: ServerOptions) {
    this.log = opts.log ?? ((m) => console.log(`[elevens] ${m}`));
    this.ranks = new RankStore(opts.rankedFile ?? null, this.log, opts.rankedSecret ?? null);
    this.http = createServer((req, res) => this.serveHttp(req, res));
    // Snapshots are similar from one to the next, so compression with a shared window cuts them
    // to about a tenth (bandwidth matters on free hosting plans).
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: NET.maxMessageBytes,
      perMessageDeflate: opts.compress === false ? false : { zlibDeflateOptions: { level: 4, memLevel: 7 }, threshold: 128, concurrencyLimit: 8 },
    });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const origin = req.headers.origin;
      const allowed = this.opts.allowedOrigins ?? [];
      // The server's own pages are always allowed (when it serves the client too).
      const own = !!origin && !!req.headers.host && origin.replace(/^https?:\/\//, '') === req.headers.host;
      if (url.pathname !== '/ws' || (allowed.length > 0 && !own && (!origin || !allowed.includes(origin)))) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  listen(): Promise<number> {
    return new Promise((res) => {
      this.http.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        const addr = this.http.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        this.startLoop();
        res(port);
      });
    });
  }

  close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.ranks.flush();
    for (const c of this.wss.clients) c.terminate();
    return new Promise((res) => { this.wss.close(); this.http.close(() => res()); });
  }

  /** Fixed 60 Hz loop with an accumulator, so timer jitter does not change game speed. */
  private startLoop() {
    this.lastTick = performance.now();
    const step = 1000 / SIM.tickRate;
    const loop = () => {
      const now = performance.now();
      this.acc += Math.min(250, now - this.lastTick);
      this.lastTick = now;
      let n = 0;
      while (this.acc >= step && n < 10) {
        const t0 = performance.now();
        for (const r of this.rooms.values()) r.tick();
        this.tickMs = this.tickMs * 0.98 + (performance.now() - t0) * 0.02;
        this.acc -= step;
        n++;
      }
      if (n >= 10) this.acc = 0;
      if (Math.random() < 0.02) this.sweep();
      if (now - this.lastPair > 1000) { this.lastPair = now; this.pairRanked(); }
      this.timer = setTimeout(loop, Math.max(1, step - this.acc - 1));
    };
    this.timer = setTimeout(loop, step);
  }

  /** Ranked queue: pair waiting players into new rooms. */
  pairRanked() {
    const pairs = this.queue.pairs(Date.now());
    for (const [a, b] of pairs) {
      const code = newCode(new Set(this.rooms.keys()));
      const room = new Room(code, { now: () => Date.now(), log: this.log });
      this.rooms.set(code, room);
      for (const e of [a, b]) {
        const c = e.who;
        if (c.room) c.room.leave(c.token!);
        c.room = room;
        this.byToken.set(c.token!, room);
        room.join(c.token!, c.name, c.conn);
      }
      room.onRankedEnd = (r, result) => {
        const ids = r.ranked!.ids;
        const out = this.ranks.record(ids[0], ids[1], result);
        if (!out) return;
        for (const i of [0, 1] as const) r.seats[i]?.conn?.send({ t: 'rankres', before: out.before[i], after: out.after[i], delta: out.delta[i], opp: out.after[1 - i].name, sig: this.ranks.sign(ids[i]) });
        this.log(`room ${r.code}: ranked result ${result} (${out.after[0].name} ${out.delta[0] >= 0 ? '+' : ''}${out.delta[0]}, ${out.after[1].name} ${out.delta[1] >= 0 ? '+' : ''}${out.delta[1]})`);
      };
      room.startRanked([a.id, b.id], [a.club, b.club]);
      this.log(`room ${code}: ranked match ${a.id.slice(0, 6)} v ${b.id.slice(0, 6)}`);
    }
    // Tell everyone still waiting how many are in the queue.
    if (pairs.length || Math.random() < 0.2) for (const e of this.queue.list) { const rec = this.ranks.get(e.id); if (rec) e.who.conn.send({ t: 'rank', rec, queued: true, waiting: this.queue.list.length, sig: this.ranks.sign(e.id) }); }
  }

  /** Remove idle/finished rooms. */
  sweep() {
    for (const [code, r] of this.rooms) {
      if (r.expired()) {
        r.close('Room closed');
        this.rooms.delete(code);
        for (const [t, rr] of this.byToken) if (rr === r) this.byToken.delete(t);
        this.log(`room ${code} removed`);
      }
    }
  }

  private serveHttp(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') {
      // Any page may ask (the game wakes a sleeping server with this before going online).
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, rooms: this.rooms.size, tickMs: Number(this.tickMs.toFixed(3)), protocol: PROTOCOL_VERSION }));
      return;
    }
    const dir = this.opts.staticDir;
    if (!dir || !existsSync(dir)) {
      if (this.opts.playUrl && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(302, { location: this.opts.playUrl + url.search, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('ELEVENS server: WebSocket endpoint at /ws. Static client not served (set SERVE_CLIENT=1 after npm run build).');
      return;
    }
    const root = resolve(dir);
    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
    if (p.endsWith('index.html')) {
      // Tell the client this server served it, so it plays online here and not on the public server.
      const html = readFileSync(p, 'utf8').replace('<head>', '<head><meta name="elevens-server" content="self">');
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(html);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(p)] ?? 'application/octet-stream',
      'cache-control': p.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(p).pipe(res);
  }

  private onConnection(ws: WebSocket) {
    const lat = this.opts.latencyMs ?? 0, jit = this.opts.jitterMs ?? 0;
    let sendAt = 0, recvAt = 0;
    // Optional artificial latency/jitter for testing; order is preserved (like TCP).
    const delayed = (fn: () => void, which: 'send' | 'recv') => {
      if (!lat && !jit) return fn();
      const now = Date.now();
      let at = now + lat + Math.random() * jit;
      if (which === 'send') { at = Math.max(at, sendAt); sendAt = at; } else { at = Math.max(at, recvAt); recvAt = at; }
      setTimeout(fn, at - now);
    };
    const client: Client = {
      ws, token: null, room: null, tokens: NET.rateBurst, lastRefill: Date.now(), violations: 0, name: 'Player', rankedId: null,
      conn: {
        send: (msg: ServerMsg | object) => delayed(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }, 'send'),
        close: (code, reason) => ws.close(code, reason),
      },
    };
    ws.on('message', (data, isBinary) => delayed(() => this.onMessage(client, data.toString(), isBinary), 'recv'));
    ws.on('close', () => delayed(() => { this.queue.remove(client); if (client.room) client.room.disconnected(client.conn); }, 'recv'));
    ws.on('error', () => {});
  }

  private violation(c: Client, code: 'bad_msg' | 'rate_limited', msg: string) {
    c.violations++;
    c.conn.send({ t: 'err', code, msg });
    if (c.violations > NET.maxViolations) c.ws.close(1008, 'too many invalid messages');
  }

  private onMessage(c: Client, raw: string, isBinary: boolean) {
    // Token bucket rate limit.
    const now = Date.now();
    c.tokens = Math.min(NET.rateBurst, c.tokens + ((now - c.lastRefill) / 1000) * NET.ratePerSecond);
    c.lastRefill = now;
    if (c.tokens < 1) return this.violation(c, 'rate_limited', 'Too many messages');
    c.tokens -= 1;
    if (isBinary || raw.length > NET.maxMessageBytes) return this.violation(c, 'bad_msg', 'Malformed message');
    const msg = parseClientMsg(raw);
    if (!msg) return this.violation(c, 'bad_msg', 'Malformed message');

    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) { c.conn.send({ t: 'err', code: 'version', msg: 'Client and server versions differ. Reload the page.' }); return; }
      c.name = msg.name ?? 'Player';
      const room = msg.token ? this.byToken.get(msg.token) : undefined;
      if (msg.token && room && !room.closed) {
        c.token = msg.token;
        c.room = room;
        c.conn.send({ t: 'welcome', token: msg.token, resumed: true });
        room.join(msg.token, msg.name ?? 'Player', c.conn);
      } else {
        c.token = newToken();
        c.conn.send({ t: 'welcome', token: c.token, resumed: false });
      }
      return;
    }
    if (!c.token) return this.violation(c, 'bad_msg', 'Say hello first');
    switch (msg.t) {
      case 'ping':
        c.conn.send({ t: 'pong', c: msg.c, s: now });
        return;
      case 'create': {
        if (c.room) c.room.leave(c.token);
        const code = newCode(new Set(this.rooms.keys()));
        const room = new Room(code, { now: () => Date.now(), log: this.log });
        this.rooms.set(code, room);
        this.byToken.set(c.token, room);
        c.room = room;
        room.join(c.token, msg.name, c.conn);
        this.log(`room ${code} created`);
        return;
      }
      case 'join': {
        if (!ROOM_CODE_RE.test(msg.code)) { c.conn.send({ t: 'err', code: 'bad_code', msg: 'That is not a valid room code.' }); return; }
        const room = this.rooms.get(msg.code);
        if (!room || room.closed) { c.conn.send({ t: 'err', code: 'not_found', msg: 'No room with that code. It may have expired.' }); return; }
        if (c.room && c.room !== room) c.room.leave(c.token);
        const seat = room.join(c.token, msg.name, c.conn);
        if (seat < 0) { c.conn.send({ t: 'err', code: 'room_full', msg: 'That room already has two players.' }); return; }
        c.room = room;
        this.byToken.set(c.token, room);
        return;
      }
      case 'leave':
        this.queue.remove(c);
        if (c.room) { c.room.leave(c.token); this.byToken.delete(c.token); c.room = null; }
        return;
      case 'ranked': {
        const rec = this.ranks.identify(msg.id, msg.key, msg.name, msg.saved);
        if (!rec) { c.conn.send({ t: 'err', code: 'bad_msg', msg: 'That ranked profile belongs to another device.' }); return; }
        if (c.room && c.room.state === 'match') return;
        if (c.room) { c.room.leave(c.token); this.byToken.delete(c.token); c.room = null; }
        // One queue place per ranked id (a second tab replaces the first).
        for (const e of this.queue.list) if (e.id === msg.id && e.who !== c) this.queue.remove(e.who);
        c.rankedId = msg.id;
        c.name = msg.name;
        this.queue.add({ who: c, id: msg.id, elo: rec.elo, club: msg.club, since: Date.now() });
        c.conn.send({ t: 'rank', rec, queued: true, waiting: this.queue.list.length, sig: this.ranks.sign(msg.id) });
        return;
      }
      case 'unranked': {
        this.queue.remove(c);
        const rec = c.rankedId ? this.ranks.get(c.rankedId) : null;
        if (rec) c.conn.send({ t: 'rank', rec, queued: false, waiting: this.queue.list.length, sig: this.ranks.sign(c.rankedId!) });
        return;
      }
      case 'board':
        c.conn.send({ t: 'board', top: this.ranks.top(20) });
        return;
      default:
        if (!c.room) { c.conn.send({ t: 'err', code: 'not_in_room', msg: 'Not in a room' }); return; }
        c.room.handle(c.token, msg);
    }
  }
}
