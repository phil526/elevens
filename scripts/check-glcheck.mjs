// Check the graphics self-check (render/glcheck.ts): with the browser pretending to refuse draws
// (getError returns INVALID_OPERATION), the game steps down to safe level 2, keeps playing, remembers it,
// and Settings > Graphics says so. A normal run must stay at level 0.
// Usage: npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check-glcheck.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 8814, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (name, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? ` (${d})` : ''}`); };
async function run(fake) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript((f) => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'high', renderScale: 0.5, shadows: true } }));
    if (!f) return;
    for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
      const real = C.prototype.getError;
      C.prototype.getError = function () { const e = real.call(this); return window.__elevens?.screenName === 'match' ? 0x0502 : e; };
    }
  }, fake);
  const page = await ctx.newPage();
  const warns = [];
  page.on('console', (m) => { if (m.text().includes('[graphics]')) warns.push(m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.evaluate(() => document.querySelector('[data-a=quick]').click());
  await page.waitForFunction(() => window.__elevens?.screenName === 'match', null, { timeout: 120000 });
  // Software rendering is slow: give the check time to see a few frames at each level.
  for (let i = 0; i < 45; i++) { await sleep(2000); const l = await page.evaluate(() => JSON.parse(localStorage.getItem('elevens.glsafe.v1') ?? '{}').level ?? 0); if (l >= (fake ? 2 : 9)) break; if (!fake && i >= 6) break; }
  const st = await page.evaluate(() => { const r = window.__elevens.renderer.renderer; return { shadows: r.shadowMap.enabled, saved: localStorage.getItem('elevens.glsafe.v1'), phase: window.__elevens.session.view().phase }; });
  // Settings text
  await page.evaluate(() => window.__elevens.showSettings(() => {}, true));
  const text = await page.evaluate(() => document.querySelector('.gl-status')?.textContent ?? '');
  await ctx.close();
  return { ...st, warns, text };
}
try {
  const ok = await run(false);
  check('normal run stays at level 0', !ok.saved && ok.shadows, JSON.stringify({ saved: ok.saved, shadows: ok.shadows, warns: ok.warns.length }));
  const bad = await run(true);
  const lvl = JSON.parse(bad.saved ?? '{}').level;
  check('refused draws step down to safe level 2', lvl === 2, bad.saved ?? 'nothing saved');
  check('shadows off after stepping down', bad.shadows === false);
  check('match still running', !!bad.phase, bad.phase);
  check('console explains it', bad.warns.some((w) => w.includes('safe level 2')), bad.warns.join(' | ').slice(0, 200));
  if (bad.text) check('Settings shows the check', /Graphics check/.test(bad.text), bad.text.slice(0, 160));
} finally { await browser.close(); server.kill(); }
process.exit(fails ? 1 : 0);
