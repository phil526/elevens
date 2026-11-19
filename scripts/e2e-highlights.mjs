// Browser check for the half-time and full-time highlights, in headless Chromium with real
// key presses and clicks. Moments are triggered through match events (the woodwork, a save,
// a goal) so the check does not depend on the AI scoring.
// Usage: npm run build && node scripts/e2e-highlights.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true }, matchIntro: false, tvGraphics: false, celebrations: false, aerials: false, varChecks: false }));
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const mode = () => M(() => window.__elevens.cine.mode);
  const endHalf = (half) => M((h) => { const m = window.__elevens.session.match; m.half = h; m.clock = (h === 1 ? 45 : 90) * 60 - 0.5; m.addedTime = 0; }, half);
  // Recorder seconds (real play time; at software-render frame rates this runs slower than the wall clock).
  const playFor = async (sec) => { const c0 = await M(() => window.__elevens.cine.clock); await waitFor((c) => window.__elevens.cine.clock > c, 90000, c0 + sec); };
  const emit = (type, extra) => M(([t, x]) => window.__elevens.session.match.emit(t, x), [type, extra]);

  // &cine: cinematics on (the intro is off in the saved settings, TV line-ups too).
  await page.goto(`${BASE}/?test&cine`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(600);
  await page.keyboard.press('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await sleep(5000);
  // A shot off the post, then (after the merge window) a save by the away keeper.
  await M(() => { const m = window.__elevens.session.match; m.emit('kick', { player: 9, team: 0, text: 'shot', x: 40, z: 0, power: 20 }); m.emit('post', { x: 52, z: 3, power: 20 }); });
  await playFor(6.5);
  await M(() => { const m = window.__elevens.session.match; const gk = m.players.find((p) => p.team === 1 && p.role === 'GK'); m.emit('save', { player: gk.id, team: 1 }); });
  await playFor(3);
  const book1 = await M(() => window.__elevens.cine.book.list.map((h) => `${h.kind}:${h.who}:${(h.clip.last - h.clip.first).toFixed(1)}s`));
  check('moments are kept as clips while the half is played', book1.length === 2, book1.join(', '));

  await endHalf(1);
  const started = await waitFor(() => window.__elevens.cine.mode === 'highlights', 30000);
  check('half-time whistle starts the highlights', !!started);
  await waitFor(() => document.querySelector('.cine-cap.show'), 4000);
  const cap1 = await M(() => document.querySelector('.cine-cap')?.textContent);
  check('caption names the minute, the moment and the player', /Off the woodwork/i.test(cap1 ?? '') && /1 of 2/.test(cap1 ?? ''), cap1);
  await page.screenshot({ path: `${OUT}highlights-half-1.png` });
  const ui1 = await M(() => document.getElementById('ui').innerHTML.length);
  check('the half-time panel waits for the highlights', ui1 === 0);
  // Let the first clip finish: the second follows.
  const second = await waitFor(() => /2 of 2/.test(document.querySelector('.cine-cap.show')?.textContent ?? ''), 20000);
  check('second clip follows the first', !!second, await M(() => document.querySelector('.cine-cap')?.textContent));
  await page.screenshot({ path: `${OUT}highlights-half-2.png` });
  // Any key skips to the panel.
  await page.keyboard.down('Space'); await sleep(250); await page.keyboard.up('Space');
  const panel = await waitFor(() => document.querySelector('[data-a=second]'), 5000);
  check('a key press skips to the half-time panel', !!panel && (await mode()) === 'none');
  check('half-time panel has a Highlights button', await M(() => !!document.querySelector('[data-a=highlights]')));
  await page.click('[data-a=highlights]');
  check('Highlights button plays them again', !!(await waitFor(() => window.__elevens.cine.mode === 'highlights', 3000)));
  await sleep(1500);
  await page.mouse.click(640, 360);
  check('and comes back to the half-time panel', !!(await waitFor(() => document.querySelector('[data-a=second]'), 5000)));
  await page.click('[data-a=second]');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 20000);
  await sleep(4000);
  await M(() => { const m = window.__elevens.session.match; m.emit('goal', { team: 0, player: 9 }); });
  await playFor(3);
  await endHalf(2);
  check('full-time whistle starts the highlights', !!(await waitFor(() => window.__elevens.cine.mode === 'highlights', 30000)));
  await waitFor(() => document.querySelector('.cine-cap.show'), 4000);
  const cap3 = await M(() => document.querySelector('.cine-cap')?.textContent);
  check('full-time reel covers the whole match', /1 of 3/.test(cap3 ?? ''), cap3);
  // Play it through: the goal is shown again from the net, then the results panel.
  const net = await waitFor(() => window.__elevens.cine.reel?.net === true, 60000);
  check('the goal is shown again from inside the net', !!net);
  await page.screenshot({ path: `${OUT}highlights-goal-net.png` });
  const t0 = Date.now();
  const results = await waitFor(() => document.querySelector('[data-a=rematch]'), 40000);
  check('results panel opens when the reel ends', !!results, `${((Date.now() - t0) / 1000).toFixed(1)} s after net cam`);
  check('results panel has a Highlights button', await M(() => !!document.querySelector('[data-a=highlights]')));
  await page.screenshot({ path: `${OUT}highlights-results.png` });

  // Setting off: no reel, straight to the panel.
  await M(() => { window.__elevens.settings.highlights = false; });
  await page.click('[data-a=rematch]');
  await waitFor(() => window.__elevens.session.match.phase === 'kickoff', 15000);
  await sleep(600);
  await page.keyboard.press('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await sleep(3000);
  await emit('post', { x: 52, z: 3, power: 20 });
  await playFor(2.5);
  await endHalf(1);
  const direct = await waitFor(() => document.querySelector('[data-a=second]'), 30000);
  check('no reel played', (await mode()) === 'none');
  check('with highlights off the half-time panel opens straight away (button still there)', !!direct && (await M(() => !!document.querySelector('[data-a=highlights]'))));
} finally {
  report.finished = new Date().toISOString();
  writeFileSync(`${OUT}e2e-highlights.json`, JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`${report.checks.length - failed}/${report.checks.length} passed, ${report.consoleErrors.length} console errors`);
if (report.consoleErrors.length) console.log(report.consoleErrors.slice(0, 5).join('\n'));
process.exit(failed ? 1 : 0);
