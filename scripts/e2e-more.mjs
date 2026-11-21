// Browser checks for instant replay, controller rumble, player ratings / Man of the Match and
// the cup and league, in headless Chromium with real clicks and key presses. A fake controller
// (with a rumble motor that records its effects) stands in for an Xbox pad.
// Usage: npm run build && node scripts/e2e-more.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8798), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } }));
    // A fake Xbox controller, idle, whose rumble motor records what it is asked to play.
    window.__rumbles = [];
    const pad = {
      connected: true, id: 'Xbox Wireless Controller (fake)', index: 0, mapping: 'standard', axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      vibrationActuator: { type: 'dual-rumble', playEffect: (type, params) => { window.__rumbles.push({ type, ...params }); return Promise.resolve('complete'); } },
    };
    navigator.getGamepads = () => [pad, null, null, null];
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const visible = (sel) => M((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent; }, sel);
  const endMatch = (score) => M((sc) => {
    const m = window.__elevens.session.match;
    m.half = 2; m.addedTime = 1; m.clock = 46 * 60 - 0.5; m.score = sc; // added time is set a minute before the 45th
  }, score);

  // --- a match, then instant replay from the pause menu
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(800);
  await page.keyboard.press('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await sleep(7000); // some play to replay
  await waitFor(() => window.__elevens.cine.canInstant, 60000); // software rendering runs the match slowly
  // Rumble: the woodwork and a goal against reach the fake controller.
  const r0 = await M(() => window.__rumbles.length);
  await M(() => { const m = window.__elevens.session.match; m.emit('post', { x: 50 }); });
  const rumbled = await waitFor((n) => window.__rumbles.length > n ? window.__rumbles[window.__rumbles.length - 1] : null, 3000, r0);
  check('rumble: the post shakes the controller (dual-rumble)', rumbled && rumbled.type === 'dual-rumble' && rumbled.strongMagnitude > 0.5, JSON.stringify(rumbled));

  await page.keyboard.down('Escape'); await sleep(250); await page.keyboard.up('Escape');
  const paused = await waitFor(() => !!document.querySelector('[data-a=instant]'), 4000);
  check('pause menu offers Instant replay', paused);
  const tBefore = await M(() => window.__elevens.session.match.time);
  await page.click('[data-a=instant]');
  const bar = await waitFor(() => { const b = document.querySelector('.replay-bar'); return b && document.querySelector('.cine.instant') ? true : null; }, 4000);
  const t1 = await M(() => document.querySelector('.replay-time')?.textContent);
  await sleep(1200);
  const t2 = await M(() => document.querySelector('.replay-time')?.textContent);
  check('instant replay opens and plays back the last seconds', bar && t1 !== t2 && /^-\d/.test(t1 ?? ''), `${t1} -> ${t2}`);
  await page.screenshot({ path: OUT + 'more-01-instant-replay.png' });
  await page.click('[data-a=rplay]');
  await sleep(300);
  const playTxt = await M(() => document.querySelector('[data-a=rplay]').textContent);
  const ta = await M(() => document.querySelector('.replay-time').textContent);
  await sleep(600);
  const tb = await M(() => document.querySelector('.replay-time').textContent);
  check('pause in the replay holds the picture', playTxt === 'Play' && ta === tb, `${playTxt} ${ta}/${tb}`);
  await page.click('[data-a=rback]');
  await sleep(200);
  const tc = await M(() => document.querySelector('.replay-time').textContent);
  check('rewind 5 s (or to the start of the recording)', parseFloat(tc.slice(1)) > parseFloat(ta.slice(1)) + 2, `${ta} -> ${tc}`);
  const cams = [];
  for (let i = 0; i < 4; i++) { cams.push(await M(() => document.querySelector('.replay-cam').textContent)); await page.click('[data-a=rcam]'); await sleep(250); if (i === 1) { await page.click('[data-a=rplay]'); await sleep(500); await page.screenshot({ path: OUT + 'more-02-replay-netcam.png' }); await page.click('[data-a=rplay]'); } }
  check('camera cycles through four views', new Set(cams).size === 4, cams.join(', '));
  await page.click('[data-a=rslow]');
  await sleep(200);
  check('slow motion', (await M(() => document.querySelector('[data-a=rslow]').textContent)) === 'Speed ½x');
  await page.click('[data-a=back]');
  const backToPause = await waitFor(() => !!document.querySelector('[data-a=resume]') && !document.querySelector('.cine.on'), 3000);
  const tAfter = await M(() => window.__elevens.session.match.time);
  check('Back returns to the pause menu; the match did not move', backToPause && tAfter === tBefore, `match time ${tBefore} -> ${tAfter}`);
  // Settings shows rumble support for the controller.
  await page.click('[data-a=settings]');
  const note = await waitFor(() => [...document.querySelectorAll('.note')].map((n) => n.textContent).find((t) => /rumble/.test(t)), 3000);
  check('Settings: rumble on, and supported for this controller', /support rumble/.test(note ?? '') && await visible('[data-seg=rumble] [data-v=on].on'), note);
  await page.click('[data-a=back]');
  await page.click('[data-a=resume]');

  // --- full time: Man of the Match and player ratings
  await endMatch([1, 0]);
  const res = await waitFor(() => document.querySelector('.motm')?.textContent, 15000);
  check('full time shows a Man of the Match', !!res, res?.slice(0, 80));
  await page.screenshot({ path: OUT + 'more-03-motm.png' });
  await page.click('[data-a=ratings]');
  await sleep(200);
  const rows = await M(() => { const r = document.querySelector('.tab-ratings'); return r && r.offsetParent ? r.querySelectorAll('.pr').length : 0; });
  const ratings = await M(() => [...document.querySelectorAll('.tab-ratings .rating')].map((e) => parseFloat(e.textContent)));
  check('Player ratings list both teams, 3.0 to 10.0', rows >= 22 && ratings.every((x) => x >= 3 && x <= 10), `${rows} players, ${Math.min(...ratings)}..${Math.max(...ratings)}`);
  await page.screenshot({ path: OUT + 'more-04-ratings.png' });
  await page.click('[data-a=menu]');

  // --- league: pick a cup club, play round 1, see the table
  await page.click('[data-a=comp]');
  await page.click('[data-seg=ckind] [data-v=league]');
  await page.click('[data-club=saltmarsh]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.screenshot({ path: OUT + 'more-05-comp-setup.png' });
  await page.click('[data-a=start]');
  const table = await waitFor(() => document.querySelectorAll('.ltable tr').length - 1, 3000);
  check('league hub: table of eight clubs', table === 8, `${table} rows`);
  const opp = await M(() => document.querySelector('.comp-next')?.textContent?.trim());
  await page.screenshot({ path: OUT + 'more-06-league-hub.png' });
  await page.click('[data-a=play]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 30000);
  const teams = await M(() => window.__elevens.session.match.teams.map((t) => t.id));
  check('league match: your club against this round’s opponent', teams[0] === 'saltmarsh' && !!opp && opp.includes(await M((id) => window.__elevens.session.match.teams[1].name, null)), `${teams.join(' v ')} | ${opp}`);
  await sleep(600);
  await page.keyboard.press('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await endMatch([2, 0]);
  const cont = await waitFor(() => document.querySelector('[data-a=comp]') && document.querySelector('.comp-note')?.textContent, 15000);
  check('full time records the result in the league', /1st|2nd|3rd|th in the league/.test(cont ?? ''), cont);
  await page.click('[data-a=comp]');
  const mine = await waitFor(() => { const r = document.querySelector('.ltable tr.me'); return r ? [...r.cells].map((c) => c.textContent) : null; }, 4000);
  check('table: Saltmarsh played 1, won 1, 3 points', mine && mine[2] === '1' && mine[3] === '1' && mine[7] === '3', mine?.join(' '));
  const saved = await M(() => { const st = JSON.parse(localStorage.getItem('elevens.profiles.v1')); return st?.slots?.[st.active]?.comp?.round; });
  check('the league is saved on this device', saved === 1, `round ${saved}`);
  await page.screenshot({ path: OUT + 'more-07-league-table.png' });
  // Abandon (asks twice), then a cup.
  await page.click('[data-a=new]');
  await page.click('[data-a=new]');
  await page.click('[data-seg=ckind] [data-v=cup]');
  await page.click('[data-a=start]');
  const qf = await waitFor(() => document.querySelectorAll('.bround')[0]?.querySelectorAll('.fx').length, 3000);
  check('cup hub: four quarter-finals', qf === 4, `${qf}`);
  await page.screenshot({ path: OUT + 'more-08-cup-hub.png' });
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-more-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
