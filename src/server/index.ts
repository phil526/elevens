// Entry point: `npm run dev:server` (tsx) or `npm start` (built bundle).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameServer } from './server';

// Minimal .env loader (no dependency); real environment variables win.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(process.cwd(), 'dist/client'), resolve(here, '../client'), resolve(here, '../../dist/client')];
const staticDir = process.env.SERVE_CLIENT === '0' ? null : candidates.find((d) => existsSync(resolve(d, 'index.html'))) ?? null;

const server = new GameServer({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  staticDir,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  latencyMs: Number(process.env.SIM_LATENCY_MS ?? 0),
  jitterMs: Number(process.env.SIM_JITTER_MS ?? 0),
  rankedFile: process.env.RANKED_FILE === '' ? null : resolve(process.cwd(), process.env.RANKED_FILE ?? 'data/ranked.json'),
  rankedSecret: process.env.RANKED_SECRET || null,
  playUrl: process.env.PLAY_URL || null,
});

server.listen().then((port) => {
  console.log(`[elevens] server listening on http://localhost:${port}  (WebSocket: ws://localhost:${port}/ws)`);
  console.log(`[elevens] static client: ${staticDir ?? 'not served'}`);
});

const shutdown = () => { void server.close().then(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
