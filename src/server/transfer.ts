// Save transfer codes (20 Nov 2026): a device posts its packed save and gets a six-letter code;
// another device fetches it with the code within 30 minutes. Memory only: nothing touches disk,
// and a server restart simply forgets pending transfers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TRANSFER_MINUTES = 30;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_ITEMS = 400;

interface Held { body: string; expires: number; reads: number }

export class TransferStore {
  private held = new Map<string, Held>();
  private total = 0;

  constructor(private now: () => number = () => Date.now()) {}

  private sweep() {
    const t = this.now();
    for (const [k, h] of this.held) if (h.expires < t || h.reads >= 20) { this.total -= h.body.length; this.held.delete(k); }
  }

  put(body: string): string | null {
    this.sweep();
    if (this.held.size >= MAX_ITEMS || this.total + body.length > MAX_TOTAL) return null;
    let code = '';
    do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (this.held.has(code));
    this.held.set(code, { body, expires: this.now() + TRANSFER_MINUTES * 60_000, reads: 0 });
    this.total += body.length;
    return code;
  }

  get(code: string): string | null {
    this.sweep();
    const h = this.held.get(code);
    if (!h) return null;
    h.reads++;
    return h.body;
  }

  get size() { return this.held.size; }

  handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };
    const json = (status: number, obj: unknown) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.method === 'POST' && url.pathname === '/transfer') {
      let size = 0;
      const chunks: Buffer[] = [];
      let dead = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { dead = true; json(413, { error: 'That save is too big to send as a code: use Save to a file.' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (dead) return;
        const body = Buffer.concat(chunks).toString('utf8');
        if (!/^EV1[ZJ]\.[A-Za-z0-9_-]+$/.test(body)) { json(400, { error: 'That is not an ELEVENS save.' }); return; }
        const code = this.put(body);
        if (!code) { json(503, { error: 'The server is busy: try again in a few minutes, or use Save to a file.' }); return; }
        json(200, { code, minutes: TRANSFER_MINUTES });
      });
      return;
    }
    const m = url.pathname.match(/^\/transfer\/([A-Z0-9]{6})$/);
    if (req.method === 'GET' && m) {
      const body = this.get(m[1]);
      if (body == null) { json(404, { error: 'No save with that code.' }); return; }
      res.writeHead(200, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }
    json(404, { error: 'Not found' });
  }
}
