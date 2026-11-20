// Online play the way it is hosted (19 Nov 2026): the game as a static site on another address
// (like GitHub Pages at /elevens/), the match server on its own address (like Render) that starts
// asleep, two browser pages playing a private match through it, and a ranked record surviving a
// server restart with no disk.
// Usage: npm run build && node scripts/e2e-hosted.mjs   (CHROMIUM_PATH overrides the browser)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const PAGES = 8830, MATCH = 8831;
const SITE = `http://pages.test:${PAGES}/elevens/`;
const WS = `ws://match.test:${MATCH}/ws`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };

// "GitHub Pages": dist/client under /elevens/.
const root = resolve('dist/client');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const pages = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/elevens/')) { res.writeHead(404); res.end(); return; }
  let p = join(root, decodeURIComponent(u.pathname.slice('/elevens/'.length)) || 'index.html');
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(PAGES, '127.0.0.1');

// "Render": the match server alone, started later (it is asleep at first).
let server = null;
const startServer = () => new Promise((ok) => {
  server = spawn(process.execPath, ['dist/server/index.mjs'], {
    env: { ...process.env, PORT: String(MATCH), HOST: '127.0.0.1', SERVE_CLIENT: '0', PLAY_URL: SITE, ALLOWED_ORIGINS: `http://pages.test:${PAGES}`, RANKED_FILE: '', RANKED_SECRET: 'e2e-secret' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); });
});
const stopServer = () => new Promise((ok) => { if (!server) return ok(); server.once('exit', () => ok()); server.kill(); server = null; });

const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, matchIntro: false, tvGraphics: false, highlights: false });
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, opts: false })); }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon|ERR_CONNECTION_REFUSED|WebSocket connection|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return page;
}
const seen = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const openOnline = async (pg, name, query = '') => {
  await pg.goto(`${SITE}?test&server=${encodeURIComponent(WS)}${query}`);
  await pg.waitForSelector('[data-a=quick]');
  if (!(await pg.evaluate(() => !!document.querySelector('[data-a=online]')))) await pg.click('[data-a=more]');
  await pg.click('[data-a=online]');
  await pg.fill('#nm', name);
};

try {
  const a = await newPage();
  await openOnline(a, 'Ann');
  check('the game loads from a static site under /elevens/', await a.evaluate(() => !!window.__elevens));
  check('the Online screen says the match server is asleep or waking', await seen(a, () => /Waking up the match server|Match server not answering/.test(document.querySelector('.server-state')?.textContent ?? ''), null, 15000), await a.evaluate(() => document.querySelector('.server-state')?.textContent));
  await a.click('[data-a=create]');
  check('creating a room waits for the sleeping server', await seen(a, () => /Waking up the match server/.test(document.querySelector('.net-status')?.textContent ?? ''), null, 20000), await a.evaluate(() => document.querySelector('.net-status')?.textContent));
  await a.screenshot({ path: OUT + 'hosted-01-waking.png' });
  await sleep(8000);
  const t0 = Date.now();
  await startServer();
  const lobby = await seen(a, () => !!document.querySelector('.bigcode'), null, 30000);
  check('once the server wakes the room opens by itself', lobby, `${((Date.now() - t0) / 1000).toFixed(1)} s after the server started`);
  const code = (await a.textContent('.bigcode')).trim();
  const link = await a.inputValue('#link');
  check('the room link points at the static site and keeps the server', link.startsWith(SITE) && link.includes(`room=${code}`), link);
  await a.screenshot({ path: OUT + 'hosted-02-lobby.png' });

  const b = await newPage();
  await b.goto(link.replace('?', '?test&'));
  check('a second player joins from the link', await seen(b, (c) => document.querySelector('.bigcode')?.textContent?.trim() === c, code, 20000));
  await a.click('[data-a=ready]');
  await b.waitForSelector('[data-a=ready]:not([disabled])');
  await sleep(300);
  await b.click('[data-a=ready]');
  const live = (pg) => seen(pg, () => { const s = window.__elevens.session; const v = s?.view?.(); return !!v && ['kickoff', 'play'].includes(v.phase); }, null, 30000);
  check('both players are in the online match', (await live(a)) && (await live(b)));
  await sleep(3000);
  const [va, vb] = await Promise.all([a, b].map((pg) => pg.evaluate(() => { const v = window.__elevens.session.view(); return { score: v.score.join('-'), clock: v.clock }; })));
  check('both see the same match', va.score === vb.score && Math.abs(va.clock - vb.clock) < 15, `${JSON.stringify(va)} ${JSON.stringify(vb)}`);
  await a.screenshot({ path: OUT + 'hosted-03-match.png' });
  const health = await (await fetch(`http://127.0.0.1:${MATCH}/health`)).json();
  check('the server reports the room and its tick cost', health.rooms >= 1, JSON.stringify(health));
  const redirect = await fetch(`http://127.0.0.1:${MATCH}/`, { redirect: 'manual' });
  check('the server address sends visitors to the game', redirect.status === 302 && redirect.headers.get('location') === SITE, redirect.headers.get('location'));
  await b.evaluate(() => window.__elevens.net.send({ t: 'leave' }));
  await sleep(1000);

  // Ranked across a restart with no disk.
  for (const [pg, n] of [[a, 'Ann'], [b, 'Bob']]) {
    await pg.evaluate(() => { window.__elevens.endSession?.(); window.__elevens.net?.close(); window.__elevens.net = null; window.__elevens.room = null; });
    await openOnline(pg, n);
    await pg.click('[data-a=ranked]');
    await pg.waitForSelector('[data-a=rfind]');
  }
  await a.click('[data-a=rfind]');
  await b.click('[data-a=rfind]');
  check('ranked: the two are paired and kick off', await seen(a, () => !!window.__elevens.session, null, 40000));
  await sleep(1500);
  await b.evaluate(() => window.__elevens.net.send({ t: 'leave' }));
  check('ranked: the win earns points and a signed record', await seen(a, () => (window.__elevens.ranked?.rec?.points ?? 0) > 0 && /^[a-f0-9]{64}$/.test(window.__elevens.ranked?.sig ?? ''), null, 20000));
  const pts = await a.evaluate(() => window.__elevens.ranked.rec.points);
  await stopServer();
  await startServer();
  await a.evaluate(() => { window.__elevens.endSession?.(); window.__elevens.net?.close(); window.__elevens.net = null; window.__elevens.room = null; window.__elevens.rankQueued = false; });
  await openOnline(a, 'Ann');
  await a.click('[data-a=ranked]');
  await a.waitForSelector('[data-a=rfind]');
  await a.click('[data-a=rfind]');
  check('ranked: after a restart the server takes the record back', await seen(a, (p) => window.__elevens.rankQueued && window.__elevens.ranked?.rec?.points === p, pts, 20000), await a.evaluate(() => JSON.stringify(window.__elevens.ranked?.rec)));
  await a.screenshot({ path: OUT + 'hosted-04-ranked-restored.png' });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error(e);
  check('script ran to the end', false, e.message);
} finally {
  await browser.close();
  await stopServer();
  pages.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
