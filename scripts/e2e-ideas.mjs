// Browser checks for the twelve gameplay ideas of 17 Nov (second batch): tactics and draw settings,
// substitutions, set-piece routines, the added-time board, extra time and shootouts on the score bug,
// the crossing challenge and the extra touch buttons. Usage: npm run build && node scripts/e2e-ideas.mjs
// Situations are set up through the ?test hook (window.__elevens); clicks and key presses are real.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8798), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript(() => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 1, shadows: false, players: 'classic' } })); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const resume = async () => { await sleep(300); if (await page.$('[data-a=resume]')) await page.click('[data-a=resume]'); await waitFor(() => !document.querySelector('[data-a=resume]'), 5000); };
  const pause = async () => { await page.keyboard.down('Escape'); await waitFor(() => !!document.querySelector('[data-a=settings]'), 5000); await page.keyboard.up('Escape'); };

  // --- Match settings: formation, sliders, draw rule and Adaptive difficulty.
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=adaptive]');
  const adaptiveNote = await page.textContent('.panel').then((t) => /World class/.test(t));
  await page.click('[data-seg=form] [data-v="442"]');
  await page.fill('input[data-t=width]', '2');
  await page.dispatchEvent('input[data-t=width]', 'input');
  await page.click('[data-seg=draw] [data-v=extra]');
  await page.screenshot({ path: OUT + 'ideas-01-match-settings.png' });
  const menuCrowd = await M(() => window.__elevens.audio.crowdTarget);
  // Menu music: playing on the menus after the first key press, fading out once the match starts.
  const menuMusic = await waitFor(() => window.__elevens.audio.musicPlaying && !window.__elevens.audio.musicEl.error && window.__elevens.audio.musicEl.currentTime > 0.2, 10000);
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  // Recorded sounds: every file loads and decodes in the browser, and the crowd only starts with the match.
  const loaded = await waitFor(() => { const a = window.__elevens.audio; const k = ['crowdA', 'crowdB', 'chant', 'chant2', 'goal', 'ooh', 'ooh2', 'gasp', 'boo', 'applause', 'kick1', 'kick2', 'net', 'stomp', 'callShot', 'callStrike', 'callIncredible']; return k.every((x) => a.has(x)) ? k.length : 0; }, 20000);
  const matchCrowd = await waitFor(() => window.__elevens.audio.crowdTarget > 0.1, 8000);
  const musicGone = await waitFor(() => window.__elevens.audio.musicEl.paused, 8000);
  check('music: Stadium Drop plays on the menus and stops when the match starts', !!menuMusic && !!musicGone, `menu ${!!menuMusic}, stopped in match ${!!musicGone}`);
  check('sound: all 17 recorded sounds load; the crowd is silent on the menus and comes up with the match', loaded === 17 && menuCrowd === 0 && !!matchCrowd, `${loaded} loaded, menu crowd ${menuCrowd}`);
  const calls = await M(() => { const a = window.__elevens.audio; const first = a.call('goal', 0); const second = a.call('goal', 0); a.lastCall = -99; const st = a.settings; a.settings = { ...st, commentary: false }; const off = a.call('goal', 0); a.settings = st; a.lastCall = -99; return { first, second, off, stomp: a.stomp(0.01) }; });
  check('commentary: a goal gets a line, the next is held back, the setting turns it off; the stands can stomp', /^call(Strike|Incredible)$/.test(calls.first ?? '') && calls.second === null && calls.off === null && calls.stomp === true, JSON.stringify(calls));
  const cfg = await M(() => { const c = window.__elevens.session.match.cfg; return { f: c.tactics[0].formation, w: c.tactics[0].width, d: c.draw, diff: c.difficulty[1] }; });
  check('match settings: 4-4-2, a wide team, extra time and Adaptive reach the match', cfg.f === '442' && cfg.w === 2 && cfg.d === 'extra' && cfg.diff === 'adaptive' && adaptiveNote, JSON.stringify(cfg));
  await sleep(800);
  await page.keyboard.down('KeyJ'); await sleep(200); await page.keyboard.up('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play');

  // --- Pause menu: tactics change live, then a substitution made at the next stoppage.
  await pause();
  const pauseText = await page.textContent('.panel');
  await page.click('[data-seg=form] [data-v="4231"]');
  const live = await M(() => window.__elevens.session.match.cfg.tactics[0].formation);
  check('pause menu: formation can be changed during the match and Adaptive shows its level', live === '4231' && /Computer level \(Adaptive\)/.test(pauseText), `formation ${live}`);
  await page.click('[data-a=subs]');
  await page.screenshot({ path: OUT + 'ideas-02-subs.png' });
  const stId = await M(() => window.__elevens.session.match.players.find((p) => p.team === 0 && p.role === 'ST').id);
  await page.click(`[data-out="${stId}"]`);
  const gkDisabled = await page.$eval('[data-on="0"]', (b) => b.disabled);
  await page.click('[data-on="4"]');
  await page.click('[data-a=make]');
  const subNote = await page.textContent('.panel');
  await page.click('[data-a=back]');
  await resume();
  await M(() => { const m = window.__elevens.session.match; m.award('throwin', 1, { x: 0, z: 34.15 }); });
  const subbed = await waitFor((id) => window.__elevens.session.match.players[id].def.number === 16, 15000, stId);
  const toast = await waitFor(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => /Substitution/.test(t)), 6000);
  check('substitutions: the bench keeper cannot replace a striker, and the change is made at the next stoppage', gkDisabled && /off,.*on/.test(subNote) && subbed && !!toast, toast ?? '');

  // --- Corner routine: Q cycles it and a toast names it.
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await M(() => { const m = window.__elevens.session.match; m.ctrl[0].quickRestarts = false; m.award('corner', 0, { x: m.attackDir(0) * 52, z: 33.5 }); });
  await waitFor(() => { const r = window.__elevens.session.match.restart; return r && r.ready && r.type === 'corner'; }, 20000);
  await page.keyboard.down('KeyI'); await sleep(250); await page.keyboard.up('KeyI');
  const routineToast = await waitFor(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => /Corner routine/.test(t)), 5000);
  await sleep(1500);
  await page.screenshot({ path: OUT + 'ideas-03-corner-routine.png' });
  check('set pieces: Q at a corner switches the routine and says which', /Near post/.test(routineToast ?? ''), routineToast ?? '');
  await page.keyboard.down('KeyK'); await sleep(300); await page.keyboard.up('KeyK');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  // --- Added time: the fourth official's board, and the clock running past 45:00.
  await M(() => { const m = window.__elevens.session.match; m.clock = 2700 - 61; });
  const board = await waitFor(() => document.querySelector('.board4')?.textContent, 8000);
  await page.screenshot({ path: OUT + 'ideas-04-added-time.png' });
  await M(() => { const m = window.__elevens.session.match; m.clock = 2700 + 20; });
  await sleep(500);
  const clk = await page.textContent('.clk');
  check('added time: the board shows the minutes and the clock reads 45:00 +0:xx', /\+\d/.test(board ?? '') && /45:00 \+0:\d\d/.test(clk ?? ''), `${board} / ${clk}`);

  // --- Extra time and penalties on the score bug (forced to the end of the second half at a draw).
  await M(() => { const m = window.__elevens.session.match; m.score = [1, 1]; m.half = 2; m.clock = 2700 + m.addedTime * 60 + 5; m.halfEndGrace = 99; });
  await waitFor(() => window.__elevens.session.match.phase === 'halftime', 10000);
  const htTitle = await waitFor(() => document.querySelector('.panel h3')?.textContent, 5000);
  await page.click('[data-a=second]');
  await waitFor(() => window.__elevens.session.match.half === 3, 5000);
  const et = await waitFor(() => /ET1/.test(document.querySelector('.clk')?.textContent ?? ''), 8000);
  await sleep(800);
  await page.keyboard.down('KeyJ'); await sleep(200); await page.keyboard.up('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await M(() => { const m = window.__elevens.session.match; m.score = [1, 1]; m.half = 4; m.clock = 900 + m.addedTime * 60 + 5; m.halfEndGrace = 99; });
  const pens = await waitFor(() => !!window.__elevens.session.match.shootout && document.querySelectorAll('.scorebug .pk').length >= 10, 10000);
  await sleep(1500);
  await page.screenshot({ path: OUT + 'ideas-05-shootout.png' });
  check('extra time: a draw after 90 minutes goes to ET1, then a shootout with the tally on the score bug', /extra time next/.test(htTitle ?? '') && et && pens, htTitle ?? '');

  // --- Practice: the finishing challenge counts attempts.
  await pause();
  await page.click('[data-a=quit]');
  await page.click('[data-a=practice]');
  await page.click('[data-ch=crosses]');
  const cross = await waitFor(() => { const m = window.__elevens.session?.match; return m && m.ball.flight === 'cross' && m.players.filter((p) => !p.off).length === 6; }, 20000);
  await sleep(400);
  const label = await page.textContent('.clk');
  await page.screenshot({ path: OUT + 'ideas-06-crossing-challenge.png' });
  check('practice: the finishing challenge sends a cross in and counts attempts', cross && /CROSSES 1\/10/.test(label ?? ''), label ?? '');

  // --- Touch: the small row of buttons, relabelled when defending.
  const mob = await browser.newContext({ ...devices['iPhone 13 landscape'] });
  await mob.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic' } })));
  const mp = await mob.newPage();
  mp.on('pageerror', (e) => report.consoleErrors.push(e.message));
  await mp.goto(`${BASE}/?test`);
  await mp.waitForSelector('[data-a=quick]');
  await mp.tap('[data-a=offline]');
  await mp.tap('[data-a=next]');
  await mp.tap('[data-a=go]');
  await mp.waitForFunction(() => window.__elevens?.session?.match?.phase === 'kickoff', null, { timeout: 30000 });
  // The match intro may still be running: wait until the touch row shows the attacking labels.
  await mp.waitForFunction(() => [...document.querySelectorAll('.tb-s')].map((x) => x.textContent).join(',') === 'RUN,SHIELD,CLOSE', null, { timeout: 20000 }).catch(() => {});
  const atk = await mp.$$eval('.tb-s', (b) => b.map((x) => x.textContent));
  // Read the defending labels in the same step: the game puts the attacking ones back on its next
  // frame, because the player's side still has the ball.
  const def = await mp.evaluate(() => { window.__elevens.touch.setContext(false); return [...document.querySelectorAll('.tb-s')].map((x) => x.textContent); });
  await mp.screenshot({ path: OUT + 'ideas-07-touch-row.png' });
  check('touch: RUN, SHIELD and CLOSE with the ball; KEEPER, PRESS and TRAP without it', atk.join(',') === 'RUN,SHIELD,CLOSE' && def.join(',') === 'KEEPER,PRESS,TRAP', `${atk} / ${def}`);
  // A controller hides the touch controls; unplugging it brings them back.
  const layerShown = () => mp.$eval('.touch-layer', (e) => getComputedStyle(e).display !== 'none');
  const before = await layerShown();
  await mp.evaluate(() => {
    const pad = { connected: true, id: 'Xbox Wireless Controller', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__fakePads = [pad];
    navigator.getGamepads = () => window.__fakePads;
  });
  const hid = await mp.waitForFunction(() => getComputedStyle(document.querySelector('.touch-layer')).display === 'none' && !document.body.classList.contains('touch'), null, { timeout: 8000 }).then(() => true, () => false);
  await mp.evaluate(() => { window.__fakePads = []; });
  // Unplugging mid-match pauses the game; the touch controls stay hidden behind the pause menu
  // (so its buttons can be tapped) and return when play resumes.
  const paused = await mp.waitForFunction(() => document.body.classList.contains('touch') && !!document.querySelector('[data-a=resume]'), null, { timeout: 8000 }).then(() => true, () => false);
  const hiddenUnderMenu = await layerShown().then((v) => !v);
  if (paused) await mp.tap('[data-a=resume]');
  const back = await mp.waitForFunction(() => getComputedStyle(document.querySelector('.touch-layer')).display !== 'none' && document.body.classList.contains('touch'), null, { timeout: 8000 }).then(() => true, () => false);
  check('touch: a connected controller hides the touch controls, and they return when it disconnects (after the pause menu)', before && hid && paused && hiddenUnderMenu && back, `${before}/${hid}/${paused}/${hiddenUnderMenu}/${back}`);
  await mob.close();
  // --- Controller on a tablet: the stick and D-pad move a visible highlight through the menus.
  const tab = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await tab.addInitScript(() => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic' } }));
    const pad = { connected: true, id: 'Xbox Wireless Controller', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  const tp = await tab.newPage();
  tp.on('pageerror', (e) => report.consoleErrors.push(e.message));
  await tp.goto(`${BASE}/?test`);
  await tp.waitForSelector('[data-a=quick]');
  // Hold each input until the menu code has seen it on a frame, then release and wait until it has
  // seen the release: at software-rendering frame rates a fixed 400 ms press can fall between frames.
  const seen = (fn, arg) => tp.waitForFunction(fn, arg, { timeout: 15000 }).catch(() => {});
  const press = async (i) => {
    const dir = i === 12 ? 'up' : i === 13 ? 'down' : '';
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, i);
    await seen((d) => { const n = window.__elevens.padNav; return d ? n.dir === d : n.prevA; }, dir);
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, i);
    await seen(() => { const n = window.__elevens.padNav; return n.dir === '' && !n.prevA; });
  };
  const stick = async (y) => {
    await tp.evaluate((y) => { window.__pad.axes[1] = y; }, y);
    await seen((d) => window.__elevens.padNav.dir === d, y < 0 ? 'up' : 'down');
    await tp.evaluate(() => { window.__pad.axes[1] = 0; });
    await seen(() => window.__elevens.padNav.dir === '');
  };
  const sel = () => tp.evaluate(() => { const e = document.querySelector('.pad-focus'); return e ? (e.getAttribute('data-a') || e.textContent.trim()) : ''; });
  await tp.waitForSelector('[data-a=offline]');
  await press(13); const s1 = await sel(); // D-pad down
  await press(13); const s2 = await sel();
  await stick(-1); const s3 = await sel(); // left stick up
  const ring = await tp.evaluate(() => { const e = document.querySelector('.pad-focus'); return e ? getComputedStyle(e).outlineStyle : ''; });
  check('controller: D-pad and left stick move a visible highlight through the menu', !!s1 && s1 !== s2 && s3 === s1 && ring === 'solid', `${s1} > ${s2} > ${s3}, outline ${ring}`);
  // A presses the highlighted button: walk to Settings and open it.
  let guard = 0;
  while ((await sel()) !== 'settings' && guard++ < 8) await press(13);
  await press(0);
  const capOff = await tp.waitForSelector('[data-seg=rcap] [data-v=off].on', { timeout: 5000 }).then(() => true, () => false);
  check('controller: A opens the highlighted Settings; restart captions are off by default', capOff);
  await tab.close();
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-ideas-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
