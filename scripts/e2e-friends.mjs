// Friends league (20 Nov 2026) in two browser pages: make a league, a friend joins with the invite
// link, a league match is played to full time, both tables show the result, and the league comes
// back from the devices after the match server restarts.
// Usage: npm run build && node scripts/e2e-friends.mjs   (CHROMIUM_PATH overrides the browser)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8845;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const startServer = async () => {
  const sv = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1', RANKED_FILE: '', RANKED_SECRET: 'e2e-secret-e2e-secret-e2e-secret' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => sv.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
  return sv;
};
let server = await startServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function newPage(label, name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } });
  await ctx.addInitScript((n) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low' }, players: 'classic', name: n })); localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, opts: false })); }, name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.stack ?? e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon|WebSocket|ERR_CONNECTION/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  return page;
}
const seen = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const live = (pg) => seen(pg, () => { const v = window.__elevens.session?.view?.(); return !!v && ['kickoff', 'play'].includes(v.phase); }, null, 60000);

try {
  const a = await newPage('A', 'Ada'), b = await newPage('B', 'Bo');
  await a.goto(`${BASE}/?test`);
  await a.waitForSelector('[data-a=quick]');
  if (!(await a.evaluate(() => !!document.querySelector('[data-a=online]')))) await a.click('[data-a=more]');
  await a.click('[data-a=online]');
  await a.click('[data-a=friends]');
  await a.fill('#lgname', 'Sunday Club');
  await a.click('[data-a=lgmake]');
  await a.waitForSelector('.friends .bigcode');
  const code = (await a.textContent('.friends .bigcode')).trim();
  check('a league is made with a 6-letter code', /^[A-Z2-9]{6}$/.test(code), code);
  check('the server knows the league and its maker', await seen(a, () => window.__elevens.leagues[0]?.synced > 0 && window.__elevens.leagues[0].members.length === 1));
  const link = await a.inputValue('#lglink');
  await b.goto(link.replace(/^https?:\/\/[^/]+/, BASE) + '&test');
  check('the invite link opens the league for the friend', await seen(b, () => document.querySelector('.friends h2')?.textContent === 'Sunday Club'));
  check('both are in the table', await seen(b, () => document.querySelectorAll('.friends .ltable tr').length === 3));
  await b.screenshot({ path: OUT + 'friends-league-b.png' });
  // A league match: Ada opens a room, Bo joins it from the league screen.
  await a.click('[data-a=lglist]');
  await a.click(`[data-lg=${code}]`);
  await a.click('[data-a=lgplay]');
  await a.waitForSelector('.bigcode:not(.friends .bigcode)', { timeout: 15000 });
  await a.waitForSelector('.lobby-league', { state: 'attached', timeout: 1000 }).catch(() => {});
  const room = await a.evaluate(() => window.__elevens.room.code);
  await b.fill('#lgroom', room);
  await b.click('[data-a=lgroomjoin]');
  check('the room says it counts in the league', await seen(a, () => /Sunday Club/.test(document.querySelector('.lobby-league')?.textContent ?? ''), null, 15000));
  await a.screenshot({ path: OUT + 'friends-lobby.png' });
  await a.evaluate(() => window.__elevens.net.send({ t: 'lobby', minutes: 2 }));
  await sleep(500);
  for (const pg of [a, b]) { await pg.waitForSelector('[data-a=ready]:not([disabled])'); await sleep(250); await pg.click('[data-a=ready]'); }
  check('the league match starts', (await live(a)) && (await live(b)));
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000) {
    const ph = await a.evaluate(() => window.__elevens.session?.view?.()?.phase ?? 'none');
    if (ph === 'fulltime' || ph === 'none') break;
    await sleep(3000);
  }
  check('both see the league result line', await seen(a, () => /result saved/.test(document.querySelector('.lg-note')?.textContent ?? ''), null, 30000) && await seen(b, () => /result saved/.test(document.querySelector('.lg-note')?.textContent ?? ''), null, 30000));
  const ra = await a.evaluate((c) => window.__elevens.leagues.find((l) => l.code === c).results.length, code);
  const rb = await b.evaluate((c) => window.__elevens.leagues.find((l) => l.code === c).results.length, code);
  check('each device keeps the signed result', ra === 1 && rb === 1, `${ra} / ${rb}`);
  await a.screenshot({ path: OUT + 'friends-fulltime.png' });
  // The server restarts (free hosting sleeps): Bo opens the league and it comes back from his device.
  for (const pg of [a, b]) await pg.evaluate(() => { window.__elevens.net?.close(); window.__elevens.net = null; window.__elevens.session?.dispose?.(); });
  server.kill();
  await sleep(500);
  server = await startServer();
  await b.goto(`${BASE}/?test&league=${code}`);
  check('after a restart the league comes back from a member\'s device', await seen(b, () => { const l = window.__elevens.leagues[0]; return l && l.synced > Date.now() - 20000 && l.results.length === 1 && l.members.length === 2; }, null, 30000));
  check('the table shows the match', await seen(b, () => [...document.querySelectorAll('.friends .ltable tr td:nth-child(3)')].map((x) => x.textContent).join() === '1,1'));
  await b.screenshot({ path: OUT + 'friends-after-restart.png' });
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
} catch (err) {
  console.error(err);
  check('script ran to the end', false, err.message);
  console.log(errors.slice(0, 6).join('\n'));
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
