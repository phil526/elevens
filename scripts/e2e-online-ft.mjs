// An online private match played to full time in two browser pages (20 Nov 2026: Philip's first
// online match crashed at full time). Checks the full-time panel, rematch and no page errors.
// Usage: npm run build && node scripts/e2e-online-ft.mjs   (CHROMIUM_PATH overrides the browser)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8841;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1', RANKED_FILE: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const PRESET = process.env.FT_PRESET ?? 'low';
async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p } })); localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, opts: false })); }, PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.stack ?? e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  return page;
}
const seen = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
try {
  const a = await newPage('A'), b = await newPage('B');
  await a.goto(`${BASE}/?test`);
  await a.waitForSelector('[data-a=quick]');
  if (!(await a.evaluate(() => !!document.querySelector('[data-a=online]')))) await a.click('[data-a=more]');
  await a.click('[data-a=online]');
  await a.fill('#nm', 'Ada');
  await a.click('[data-a=create]');
  await a.waitForSelector('.bigcode', { timeout: 15000 });
  const code = (await a.textContent('.bigcode')).trim();
  await b.goto(`${BASE}/?test&room=${code}`);
  await b.waitForSelector('.bigcode', { timeout: 15000 });
  await a.evaluate(() => window.__elevens.net.send({ t: 'lobby', minutes: 2 }));
  await sleep(500);
  await a.click('[data-a=ready]');
  await b.waitForSelector('[data-a=ready]:not([disabled])');
  await sleep(300);
  await b.click('[data-a=ready]');
  const live = (pg) => seen(pg, () => { const v = window.__elevens.session?.view?.(); return !!v && ['kickoff', 'play'].includes(v.phase); }, null, 40000);
  check('both players are in the match', (await live(a)) && (await live(b)));
  // Keep both players moving a little so the match isn't idle.
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < 6 * 60_000) {
    const ph = await a.evaluate(() => window.__elevens.session?.view?.()?.phase ?? 'none');
    if (Date.now() - lastLog > 20000) { lastLog = Date.now(); console.log(`  ${(Date.now() - t0) / 1000 | 0}s phase ${ph}; errors ${errors.length}`); }
    if (ph === 'fulltime' || ph === 'none') break;
    await a.keyboard.down('KeyD'); await sleep(700); await a.keyboard.up('KeyD');
    await b.keyboard.down('KeyA'); await sleep(700); await b.keyboard.up('KeyA');
  }
  const panel = (pg) => seen(pg, () => /Full-time/.test(document.querySelector('.panel h3')?.textContent ?? ''), null, 30000);
  const [pa, pb] = [await panel(a), await panel(b)];
  check('both see the full-time panel', pa && pb);
  await sleep(4000);
  await a.screenshot({ path: OUT + 'online-ft-a.png' });
  await b.screenshot({ path: OUT + 'online-ft-b.png' });
  check('the pages are still running after full time', (await a.evaluate(() => !!window.__elevens)) && (await b.evaluate(() => !!window.__elevens)));
  check('no page errors up to and after full time', errors.length === 0, errors.slice(0, 4).join(' || '));
  if (await a.$('[data-a=rematch]')) {
    await a.click('[data-a=rematch]');
    await b.click('[data-a=rematch]');
    check('a rematch starts when both choose it', (await live(a)) && (await live(b)));
  }
} catch (e) {
  console.error(e);
  check('script ran to the end', false, e.message);
  console.log(errors.slice(0, 6).join('\n'));
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
