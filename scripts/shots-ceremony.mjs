// The pre-match ceremony (mascots on the walk-out, line-up, handshakes, team photos) and the
// half-time blimp and drone shots, with checks. Usage: npm run build && node scripts/shots-ceremony.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/ceremony/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'medium';
const PORT = +(process.env.PORT ?? 8817), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], checks = [];
const check = (name, ok, extra = '') => { checks.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' }, tvGraphics: false })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(120); } return null; };
  await page.goto(`${BASE}/?test&cine`);
  await page.addStyleTag({ content: '.cine-fade{display:none!important}' });
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  check('intro starts', await waitFor(() => window.__elevens?.cine?.mode === 'intro', 90000));
  const at = (t) => waitFor((x) => window.__elevens.cine.time >= x || window.__elevens.cine.mode !== 'intro', 300000, t);
  const shots = [['walkout', 10.5], ['walkout2', 12.8], ['line', 15.6], ['shake', 20.6], ['photo-home', 25.4], ['photo-away', 28.0]];
  for (const [name, t] of shots) {
    await at(t);
    if (name === 'walkout') {
      const n = await M(() => window.__elevens.renderer.mascots?.count ?? 0);
      check('mascots walk out with the players', n >= 14, `(${n})`);
    }
    await page.screenshot({ path: `${OUT}${name}.png`, timeout: 120000 });
  }
  check('ceremony ends in the match', await waitFor(() => window.__elevens.cine.mode === 'none', 300000));
  check('mascots gone after the line-up', await M(() => !window.__elevens.renderer.mascots));
  // Half-time: the aerial shots.
  await sleep(1500);
  await M(() => { const m = window.__elevens.session.match; m.half = 1; m.clock = 45 * 60 - 0.5; m.addedTime = 0; });
  check('half-time aerials start', await waitFor(() => window.__elevens.cine.mode === 'aerial', 300000)); // the added minute takes a while at SwiftShader speed
  await waitFor(() => window.__elevens.cine.time >= 2.4, 200000);
  await page.screenshot({ path: `${OUT}aerial-blimp.png`, timeout: 120000 });
  await waitFor(() => window.__elevens.cine.time >= 7.4 || window.__elevens.cine.mode !== 'aerial', 200000);
  await page.screenshot({ path: `${OUT}aerial-drone.png`, timeout: 120000 });
  // Blimp from the ground.
  await waitFor(() => window.__elevens.cine.mode !== 'aerial', 200000);
  await M(() => { const r = window.__elevens.renderer; const b = r.blimp.position; r.viewOverride = { pos: [b.x * 0.4, 30, b.z * 0.4 + 20], look: [b.x, b.y, b.z] }; });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}blimp.png`, timeout: 120000 });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
