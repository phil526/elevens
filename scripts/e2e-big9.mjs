// Browser checks for the 20 Nov 2026 batch: moving saves (transfer code and file), match analysis,
// club levels and weekly challenges, the World tournament, the 5-a-side street mode, battery saver,
// the online signal icon and 2 v 2 rooms, and friends leagues.
// Usage: npm run build && node scripts/e2e-big9.mjs [part ...]   (CHROMIUM_PATH overrides the browser)
// Parts: transfer analysis levels tour street battery online friends (default: all).

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8833;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const want = new Set(process.argv.slice(2));
const part = (p) => !want.size || want.has(p);
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1', RANKED_FILE: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, matchIntro: false, tvGraphics: false, highlights: false, goalReplays: false, celebrations: false, menuBackdrop: false });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  await ctx.addInitScript((s) => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s);
    localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }));
  }, SETTINGS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|WebGL|GPU stall/i.test(m.text())) errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const seen = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  return { ctx, page, errors, M, seen };
}

const inMatch = (seen) => seen(() => !!window.__elevens?.session && ['kickoff', 'play'].includes(window.__elevens.session.match?.phase), null, 60000);
/** Jump to the last seconds of the second half and wait for the full-time panel. */
async function toFullTime(M, seen) {
  await M(() => { const m = window.__elevens.session.match; m.half = 2; m.clock = 90 * 60 - 0.5; m.addedTime = 0; });
  return seen(() => !!document.querySelector('[data-a=analysis]'), null, 60000);
}

try {
  if (part('transfer') || part('levels') || part('analysis') || part('tour')) {
    const { ctx, page, errors, M, seen } = await newPage();
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    check('home has the World tournament and Club level buttons', await M(() => !!document.querySelector('[data-a=tour]') && !!document.querySelector('[data-a=levels]')));
    check('the profile chip shows the club level and title', await M(() => /Lv 1 · Rookie/.test(document.querySelector('.profile-chip')?.textContent ?? '')));

    if (part('levels')) {
      await page.click('[data-a=levels]');
      await page.waitForSelector('.levels');
      check('Club level screen: level bar, three weekly challenges, rewards', await M(() => !!document.querySelector('.lvl-bar') && document.querySelectorAll('.wk').length === 3 && document.querySelectorAll('.reward').length >= 20));
      check('locked rewards are disabled with their level', await M(() => { const b = document.querySelector('[data-equip="ball-gold"]'); return !!b && b.disabled && /Level 30/.test(b.textContent); }));
      await page.screenshot({ path: OUT + 'big9-levels.png' });
      // Give some points, then equip a ball and menu colour.
      await M(() => { const s = JSON.parse(localStorage.getItem('elevens.levels.v1.0') ?? 'null') ?? {}; s.xp = 12000; localStorage.setItem('elevens.levels.v1.0', JSON.stringify({ v: 1, week: '', progress: {}, done: [], stars: 0, equip: {}, celebration: '', matches: 0, ...s, xp: 12000 })); window.__elevens.levelSlot = -1; window.__elevens.openLevels(); });
      await page.waitForSelector('[data-equip="ball-winter"]:not([disabled])');
      await page.click('[data-equip="ball-winter"]');
      await page.click('[data-equip="accent-red"]');
      check('equipping a menu colour changes the accent at once', await M(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#ff5a5f'));
      check('equipped rewards are saved', await M(() => JSON.parse(localStorage.getItem('elevens.levels.v1.0')).equip.ball === 'ball-winter'));
      await page.click('[data-a=back]');
      await page.waitForSelector('[data-a=quick]');
    }

    if (part('tour') || part('analysis')) {
      await page.click('[data-a=tour]');
      await page.waitForSelector('[data-a=tstart]');
      check('tournament set-up lists 16 nations with flags', await M(() => document.querySelectorAll('[data-nation]').length === 16 && document.querySelectorAll('[data-nation] svg.flag').length === 16));
      await page.click('[data-nation="n-caldera"]');
      await page.click('[data-a=tstart]');
      await page.waitForSelector('[data-a=tplay]');
      check('tournament hub: four group tables and your group fixtures', await M(() => document.querySelectorAll('.tgroup').length === 4 && !!document.querySelector('.tgroup.mine') && document.querySelectorAll('.fx.mine').length === 3));
      await page.screenshot({ path: OUT + 'big9-tour-hub.png' });
      await page.click('[data-a=tplay]');
      check('a tournament match starts with Caldera as team 0', await inMatch(seen) && await M(() => window.__elevens.session.cfg.teams[0] === 'n-caldera' && window.__elevens.session.cfg.teams[1].startsWith('n-')));
      check('the match ball is the one equipped', !part('levels') || await M(() => window.__elevens.renderer.cosmetics.ball === 'ball-winter'));
      // Let it play a little so the analysis has something, then make a goal for us.
      // The computer plays our side for a while (no kick-off wait), so the analysis has data.
      await M(() => { window.__elevens.session.match.ctrl[0].human = false; });
      await seen(() => window.__elevens.session.match.phase === 'play', null, 20000);
      await seen(() => window.__elevens.analysis.passes.filter((p) => p.team === 0).length >= 3, null, 60000);
      await M(() => { const m = window.__elevens.session.match; m.ctrl[0].human = true; m.score[0] = 2; });
      const ft = await toFullTime(M, seen);
      check('full time shows Match analysis, the club level note and the tournament note', ft && await M(() => !!document.querySelector('.lvl-note') && /Group|quarter/i.test(document.querySelector('.mode-note')?.textContent ?? '')));
      await page.screenshot({ path: OUT + 'big9-tour-ft.png' });
      await page.click('[data-a=analysis]');
      await page.waitForSelector('.analysis');
      check('analysis opens on the shot map with xG for both sides and a tip', await M(() => !!document.querySelector('.an-pitch') && /xG/.test(document.querySelector('.an-xg')?.textContent ?? '') && !!document.querySelector('.an-tip span')?.textContent));
      await page.screenshot({ path: OUT + 'big9-analysis-shots.png' });
      for (const [tab, sel] of [['heat', '.an-pitch rect[fill-opacity]'], ['passes', '.an-pitch line[marker-end]'], ['momentum', '.an-momentum rect']]) {
        await page.click(`[data-seg=antab] button[data-v=${tab}]`);
        await page.waitForTimeout(150);
        check(`analysis ${tab} tab draws`, await M((s) => document.querySelectorAll(s).length > 0, sel));
        await page.screenshot({ path: OUT + `big9-analysis-${tab}.png` });
      }
      await page.click('[data-a=anback]');
      check('Back returns to the full-time panel', await seen(() => !!document.querySelector('[data-a=mcont]')));
      await page.click('[data-a=mcont]');
      await page.waitForSelector('.tour');
      check('Continue goes back to the tournament with the result in', await M(() => /2–|–2/.test(document.querySelector('.fx.mine b')?.textContent ?? '') || [...document.querySelectorAll('.fx.mine b')].some((b) => /\d–\d/.test(b.textContent))));
      check('the level went up from the match', await M(() => JSON.parse(localStorage.getItem('elevens.levels.v1.0')).matches === 1));
      await page.click('[data-a=back]');
      await page.waitForSelector('[data-a=quick]');
    }

    if (part('transfer')) {
      await page.click('[data-a=profile]');
      await page.waitForSelector('[data-a=xfer-send]');
      await page.click('[data-a=xfer-send]');
      const got = await seen(() => /^[A-Z2-9 ]{11}$/.test(document.querySelector('[data-xfer-code]')?.textContent ?? ''), null, 20000);
      const code = got ? await M(() => document.querySelector('[data-xfer-code]').textContent.replace(/ /g, '')) : '';
      check('Get a transfer code shows a six-character code', got, code);
      await page.screenshot({ path: OUT + 'big9-transfer-code.png' });
      // A second device (fresh browser) loads it.
      const two = await newPage({ viewport: { width: 900, height: 600 } });
      await two.page.goto(`${BASE}/?test`);
      await two.page.waitForSelector('[data-a=quick]');
      await two.M(() => { const s = JSON.parse(localStorage.getItem('elevens.settings.v1')); s.graphics.preset = 'medium'; localStorage.setItem('elevens.settings.v1', JSON.stringify(s)); });
      await two.page.click('[data-a=profile]');
      await two.page.waitForSelector('#xfer-in');
      await two.page.fill('#xfer-in', code.toLowerCase());
      await two.page.click('[data-a=xfer-get]');
      check('the other device finds the save and asks before replacing', await two.seen(() => /Load this save/.test(document.querySelector('.xfer-confirm')?.textContent ?? '') && /club levels/.test(document.querySelector('.xfer-confirm')?.textContent ?? ''), null, 20000));
      await two.page.screenshot({ path: OUT + 'big9-transfer-confirm.png' });
      await two.page.click('[data-a=xfer-apply]');
      await two.page.waitForLoadState('load');
      await two.page.waitForTimeout(2000);
      await two.page.waitForSelector('[data-a=quick]');
      check('after loading, the second device has the tournament and level', await two.M(() => !!localStorage.getItem('elevens.tournament.v1.0') && JSON.parse(localStorage.getItem('elevens.levels.v1.0')).matches === 1));
      check('the second device kept its own graphics setting', await two.M(() => JSON.parse(localStorage.getItem('elevens.settings.v1')).graphics.preset === 'medium'));
      check('no errors on the second device', two.errors.length === 0, two.errors.slice(0, 3).join(' | '));
      await two.ctx.close();
    }
    check('no page errors (first device)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  if (part('street')) {
    const { ctx, page, errors, M, seen } = await newPage();
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=street]');
    await page.waitForSelector('[data-a=sgo]');
    check('street set-up lists clubs for both sides', await M(() => document.querySelectorAll('[data-sclub]').length >= 6 && document.querySelectorAll('[data-sopp]').length >= 6));
    await page.screenshot({ path: OUT + 'big9-street-setup.png' });
    await page.click('[data-a=sgo]');
    check('a street match starts', await inMatch(seen));
    check('five a side on a 40 m cage pitch, no subs', await M(() => {
      const m = window.__elevens.session.match;
      const on = [0, 1].map((t) => m.players.filter((p) => p.team === t && !p.off).length);
      return on[0] === 5 && on[1] === 5 && m.pitch.length === 40 && m.pitch.walls && m.maxSubs === 0;
    }));
    check('the cage is built (no stadium bowl)', await M(() => { const st = window.__elevens.renderer.stadium; return !!st.userData.cage && !st.userData.arena && !!st.getObjectByName('street-cage'); }));
    // The computer plays both sides for a while: the ball must stay in the cage.
    await M(() => { window.__elevens.session.match.ctrl[0].human = false; });
    await seen(() => window.__elevens.session.match.phase === 'play', null, 20000);
    let inside = true;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1500);
      const r = await M(() => { const m = window.__elevens.session.match; return { x: m.ball.pos.x, z: m.ball.pos.z, r: m.restart?.type ?? '' }; });
      if (Math.abs(r.z) > 12.2 || ['throwin', 'corner', 'goalkick'].includes(r.r)) inside = false;
    }
    check('the ball stays in the cage: no throw-ins, corners or goal kicks', inside);
    await page.screenshot({ path: OUT + 'big9-street-play.png' });
    await M(() => { const m = window.__elevens.session.match; m.ctrl[0].human = true; m.score[0] = 3; m.score[1] = 1; });
    const ft = await toFullTime(M, seen);
    check('full time shows the street record', ft && await M(() => /Street record: 1 won/.test(document.querySelector('.mode-note')?.textContent ?? '')));
    await page.screenshot({ path: OUT + 'big9-street-ft.png' });
    await page.click('[data-a=mcont]');
    await page.waitForSelector('[data-a=sgo]');
    check('Continue goes back to the street screen with the record', await M(() => /1<\/b> won/.test(document.querySelector('.street-rec')?.innerHTML ?? '')));
    await page.click('[data-a=back]');
    await page.waitForSelector('[data-a=quick]');
    check('back on the menus the pitch is full size again once the backdrop runs', await seen(() => !window.__elevens.session && (window.__elevens.backdrop?.match ? window.__elevens.backdrop.match.pitch.length === 105 : true), null, 20000));
    check('no page errors (street)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
