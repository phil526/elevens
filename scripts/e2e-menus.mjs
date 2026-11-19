// Browser checks for the simpler menus: one-press Kick off with the last setup, Continue for the
// next cup or league match, More modes / More options that stay as left, Kick off straight from
// Choose the clubs, controller and keyboard starts, and the slide transitions.
// Usage: npm run build && node scripts/e2e-menus.mjs   (CHROMIUM_PATH overrides the browser)

import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8817;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));

const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, matchIntro: false, tvGraphics: false });

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const seen = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const inMatch = () => seen(() => !!window.__elevens.session && ['kickoff', 'play'].includes(window.__elevens.session.match?.phase), null, 45000);
  const quit = async () => { await M(() => { window.__elevens.endSession(); window.__elevens.showMode(); }); await page.waitForSelector('[data-a=quick]'); };

  // --- First visit: the game opens on the main menu, Kick off ready; one click starts a match.
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  check('opens straight on the main menu (no title screen to press through)', await M(() => !!document.querySelector('#ui .screen.home') && !document.querySelector('[data-go]')));
  check('Kick off has the focus', await M(() => document.activeElement?.getAttribute('data-a') === 'quick'));
  check('the quick match card shows both clubs and the setup', await M(() => document.querySelectorAll('.quick-card .qm-team').length === 2 && /Pro · 6 min · Draw stands/.test(document.querySelector('.qm-meta')?.textContent ?? '')));
  check('other modes are tucked away under More modes', await M(() => !document.querySelector('[data-a=practice]') && !document.querySelector('[data-a=local]') && !!document.querySelector('[data-a=more]')));
  await page.screenshot({ path: OUT + 'menus-01-home.png' });
  await page.click('[data-a=quick]');
  check('one click on Kick off starts a match against the computer', await inMatch());
  check('with the default clubs', await M(() => window.__elevens.session.cfg.teams.join() === `${window.__elevens.choice.club},${window.__elevens.choice.opp}` && window.__elevens.session.cfg.humans.join() === 'true,false'));
  await quit();

  // --- Change clubs or settings: pick an opponent, then Kick off straight from Choose the clubs.
  await page.click('[data-a=offline]');
  await page.waitForSelector('[data-a=kick]');
  const opp = await M(() => document.querySelectorAll('[data-opp]')[3].dataset.opp);
  await page.click(`[data-opp="${opp}"]`);
  check('Kick off stays in view on Choose the clubs', await M(() => { const r = document.querySelector('[data-a=kick]').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
  await page.click('[data-a=kick]');
  check('Kick off on Choose the clubs starts the match (no match settings screen needed)', await inMatch());
  check('against the club picked', await M((o) => window.__elevens.session.cfg.teams[1] === o, opp));
  await quit();

  // --- Match settings: basics up front, the rest under More options.
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.waitForSelector('[data-a=moreopts]');
  check('match settings show difficulty, length and the draw rule', await M(() => !!document.querySelector('[data-seg=diff]') && !!document.querySelector('[data-seg=min]') && !!document.querySelector('[data-seg=draw]')));
  check('tactics, formation, sliders, marking, auto-switch and quick restarts wait under More options', await M(() => !document.querySelector('[data-seg=form]') && !document.querySelector('[data-seg=ment]') && !document.querySelector('[data-seg=quick]') && /4-3-3|4-4-2|4-2-3-1/.test(document.querySelector('.more-sum')?.textContent ?? '')));
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-seg=min] [data-v="4"]');
  await page.click('[data-seg=draw] [data-v=pens]');
  await page.click('[data-a=moreopts]');
  check('More options opens them', await M(() => ['form', 'ment', 'mark', 'auto', 'quick'].every((n) => !!document.querySelector(`[data-seg=${n}]`)) && document.querySelectorAll('input[data-t]').length === 3));
  await page.click('[data-seg=ment] [data-v=attacking]');
  await page.screenshot({ path: OUT + 'menus-02-options.png' });
  await page.click('[data-a=back]');
  await page.click('[data-a=back]');
  await page.waitForSelector('[data-a=quick]');

  // --- The setup is kept: after a reload the card shows it and Kick off plays it.
  await page.reload();
  await page.waitForSelector('[data-a=quick]');
  const card = await M(() => document.querySelector('.quick-card').textContent.replace(/\s+/g, ' '));
  const oppName = await M((o) => document.querySelector(`.qm-team.away b`)?.textContent, opp);
  check('after a reload the card shows the last setup', /Casual · 4 min · Penalties if level/.test(card), card.slice(0, 120));
  await page.keyboard.press('Enter');
  check('Enter on the main menu kicks off (keyboard: one press)', await inMatch());
  check('with the remembered clubs, difficulty, length, draw rule and tactics', await M((o) => {
    const c = window.__elevens.session.cfg;
    return c.teams[1] === o && c.difficulty[1] === 'casual' && c.realMinutes === 4 && c.draw === 'pens' && c.mentality[0] === 'attacking';
  }, opp), oppName);
  await quit();
  check('More options stays open once opened', await M(() => JSON.parse(localStorage.getItem('elevens.menuopen.v1')).options === true));

  // --- More modes: opens in place (no new screen) and stays open.
  await page.click('[data-a=more]');
  check('More modes shows local multiplayer, cup and league, practice, online and profile', await M(() => ['local', 'comp', 'practice', 'online', 'clubs'].every((a) => !!document.querySelector(`#ui [data-a=${a}]`))));
  await page.screenshot({ path: OUT + 'menus-03-more.png' });
  await page.reload();
  await page.waitForSelector('[data-a=quick]');
  check('More modes is still open after a reload', await M(() => !!document.querySelector('#ui [data-a=practice]')));

  // --- Cup: once started, Continue on the main menu plays the next match in one press.
  await page.click('[data-a=comp]');
  await page.waitForSelector('[data-a=start]');
  await page.click('[data-a=start]');
  await page.waitForSelector('[data-a=play]');
  check('cup hub focuses Play match', await M(() => document.activeElement?.getAttribute('data-a') === 'play'));
  await page.click('[data-a=back]');
  await page.waitForSelector('[data-a=compnext]');
  const label = await M(() => document.querySelector('[data-a=compnext]').textContent.replace(/\s+/g, ' ').trim());
  check('main menu offers Continue cup with the round and opponent', /Continue cup/i.test(label) && / v /.test(label), label);
  await page.click('[data-a=compnext]');
  check('Continue cup starts the next cup match in one press', await inMatch());
  check('as a cup match against the drawn opponent', await M(() => window.__elevens.compMatch === true && window.__elevens.session.cfg.draw === 'extra'));
  await quit();
  await ctx.close();

  // --- Controller (iPad): a single A press on the first screen kicks off.
  const tab = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await tab.addInitScript((s) => {
    localStorage.setItem('elevens.settings.v1', s);
    const pad = { connected: true, id: 'Xbox Wireless Controller', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  }, SETTINGS);
  const tp = await tab.newPage();
  tp.on('pageerror', (e) => errors.push(e.message));
  const tseen = (fn, arg, timeout = 15000) => tp.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  await tp.goto(`${BASE}/?test&anim`);
  await tp.waitForSelector('[data-a=quick]');
  await tp.waitForTimeout(400);
  // D-pad down then up: the highlight starts on Kick off and moves with the pad.
  const nav = async (i) => {
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, i);
    await tseen((d) => window.__elevens.padNav.dir === d, i === 13 ? 'down' : 'up');
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, i);
    await tseen(() => window.__elevens.padNav.dir === '');
  };
  const sel = () => tp.evaluate(() => document.querySelector('.pad-focus')?.getAttribute('data-a') ?? '');
  await nav(13); const s1 = await sel();
  await nav(13); const s2 = await sel();
  await nav(12); const s3 = await sel();
  check('controller highlight starts on Kick off and moves with the D-pad', s1 === 'quick' && s2 !== 'quick' && s3 === 'quick', `${s1} > ${s2} > ${s3}`);
  // More modes with A: same screen, highlight stays on the toggle.
  for (let g = 0; g < 6 && (await sel()) !== 'more'; g++) await nav(13);
  await tp.evaluate(() => { window.__pad.buttons[0].pressed = true; });
  await tseen(() => window.__elevens.padNav.prevA);
  await tp.evaluate(() => { window.__pad.buttons[0].pressed = false; });
  await tseen(() => !window.__elevens.padNav.prevA);
  const opened = await tseen(() => !!document.querySelector('#ui [data-a=local]'));
  await tseen(() => document.querySelector('.pad-focus')?.getAttribute('data-a') === 'more', null, 3000);
  check('A on More modes opens them in place, highlight kept', opened && (await sel()) === 'more', await sel());
  // Close again so the next press test starts from a fresh highlight.
  await tp.evaluate(() => window.__elevens.showMode());
  await tp.evaluate(() => { window.__elevens.padSel = null; });
  await tp.evaluate(() => { window.__pad.buttons[0].pressed = true; });
  check('one A press with no highlight kicks off', await tseen(() => window.__elevens.screenName === 'loading' || !!window.__elevens.session, null, 10000));
  await tp.evaluate(() => { window.__pad.buttons[0].pressed = false; });
  await tseen(() => !!window.__elevens.session && ['kickoff', 'play'].includes(window.__elevens.session.match?.phase), null, 45000);
  await tab.close();

  // --- Phone: Kick off is on screen without scrolling.
  const mob = await browser.newContext({ ...devices['iPhone 13 landscape'] });
  await mob.addInitScript((s) => localStorage.setItem('elevens.settings.v1', s), SETTINGS);
  const mp = await mob.newPage();
  await mp.goto(`${BASE}/?test`);
  await mp.waitForSelector('[data-a=quick]');
  check('phone (landscape): Kick off is visible without scrolling', await mp.evaluate(() => { const r = document.querySelector('[data-a=quick]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
  await mp.screenshot({ path: OUT + 'menus-04-phone.png' });
  await mp.tap('[data-a=quick]');
  check('phone: one tap kicks off', await mp.waitForFunction(() => !!window.__elevens.session, null, { timeout: 45000 }).then(() => true, () => false));
  await mob.close();
} catch (e) {
  console.error(e);
  results.push({ name: 'script', ok: false });
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed; console errors: ${errors.length}${errors.length ? '\n' + errors.slice(0, 5).join('\n') : ''}`);
process.exit(failed ? 1 : 0);
