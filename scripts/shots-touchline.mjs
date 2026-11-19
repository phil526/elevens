// The fourth official's board and the substitutes warming up (a substitution is staged on the renderer).
// Usage: npm run build && node scripts/shots-touchline.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/touchline/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'medium';
const PORT = +(process.env.PORT ?? 8815), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const checks = [];
const check = (name, ok, extra = '') => { checks.push([name, ok]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' } })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  await sleep(1500);
  const warm = await page.evaluate(() => window.__elevens.renderer.touchline?.warmingUp ?? -1);
  check('substitutes warming up', warm >= 4, `(${warm})`);
  await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [-37, 3.2, -27], look: [-37, 1, -38] }; });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}warmup-home.png`, timeout: 180000 });
  await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [37, 3.2, -27], look: [37, 1, -38] }; });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}warmup-away.png`, timeout: 180000 });
  // A substitution: the board goes up.
  await page.evaluate(() => { const r = window.__elevens.renderer; const v = window.__elevens.session.view(); r.touchline.onEvents(v, [{ type: 'sub', team: 0, player: 7, text: 'A>B' }]); r.viewOverride = { pos: [0.8, 2.4, -29.5], look: [0.8, 1.9, -35.5] }; });
  for (let i = 0; i < 40; i++) { if (await page.evaluate(() => window.__elevens.renderer.touchline.boardShowing)) break; await sleep(250); }
  check('board up for a substitution', await page.evaluate(() => window.__elevens.renderer.touchline.boardShowing));
  await sleep(800);
  await page.screenshot({ path: `${OUT}board-sub.png`, timeout: 180000 });
  await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [8, 6, -18], look: [0, 1.5, -36] }; });
  await sleep(300);
  await page.screenshot({ path: `${OUT}board-wide.png`, timeout: 180000 });
  for (let i = 0; i < 60; i++) { if (!(await page.evaluate(() => window.__elevens.renderer.touchline.boardShowing))) break; await sleep(250); }
  check('board down again', !(await page.evaluate(() => window.__elevens.renderer.touchline.boardShowing)));
  await page.evaluate(() => { const r = window.__elevens.renderer; r.touchline.onEvents(window.__elevens.session.view(), [{ type: 'addedtime', power: 3 }]); r.viewOverride = { pos: [0.8, 2.4, -29.5], look: [0.8, 1.9, -35.5] }; });
  for (let i = 0; i < 40; i++) { if (await page.evaluate(() => window.__elevens.renderer.touchline.boardShowing)) break; await sleep(250); }
  await sleep(800);
  await page.screenshot({ path: `${OUT}board-added.png`, timeout: 180000 });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); server.kill(); }
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
