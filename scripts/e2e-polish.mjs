// Browser checks for the menu polish: live stadium behind the menus, screen transitions,
// loading card with tips, menu sounds, and the stadium announcer reading the line-ups.
// Usage: npm run build && node scripts/e2e-polish.mjs   (CHROMIUM_PATH overrides the browser)
// Runs ?test&menubg&anim&lineups so the features that test pages normally turn off are on.

import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening') || String(d).includes(String(PORT))) ok(); }));
await new Promise((ok) => setTimeout(ok, 300));

const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

try {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await ctx.addInitScript(() => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic', weather: 'clear' }, audio: { announcer: true }, matchIntro: false }));
    const pad = { connected: true, id: 'Xbox Wireless Controller', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
    // Speech: record what the announcer says, and finish each line quickly.
    window.__said = [];
    class U { constructor(t) { this.text = t; } }
    window.SpeechSynthesisUtterance = U;
    const q = [];
    let busy = false;
    const next = () => { const u = q.shift(); if (!u) { busy = false; return; } busy = true; window.__said.push(u.text); u.onstart?.(); setTimeout(() => { u.onend?.(); next(); }, 40); };
    Object.defineProperty(window, 'speechSynthesis', { value: { speak: (u) => { q.push(u); if (!busy) next(); }, cancel: () => { q.length = 0; }, getVoices: () => [{ name: 'Daniel', lang: 'en-GB', localService: true }], get speaking() { return busy; }, get pending() { return q.length > 0; }, resume() {}, addEventListener() {} } });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/?test&menubg&anim&lineups`);
  await p.waitForSelector('[data-a=quick]');
  const seen = (fn, arg, timeout = 20000) => p.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const press = async (i, ms = 350) => { await p.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, i); await p.waitForTimeout(ms); await p.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, i); await p.waitForTimeout(ms); };
  // Record menu sounds.
  await p.evaluate(() => { const a = window.__elevens.audio; window.__sfx = []; const ui = a.ui.bind(a); a.ui = (k) => { window.__sfx.push(k); ui(k); }; const ch = a.cheer.bind(a); window.__cheers = 0; a.cheer = (g) => { window.__cheers++; ch(g); }; });

  check('live stadium starts behind the main menu', await seen(() => document.body.classList.contains('menu-live') && window.__elevens.backdrop.active));
  check('tablet draws the menus at 30 fps', await p.evaluate(() => window.__elevens.backdrop.halfRate === true));
  const shot = await p.screenshot();
  check('stadium is visible (screenshot not a flat background)', shot.length > 60000, `${shot.length} bytes`);

  check('the game opens on the main menu with Kick off ready', await p.evaluate(() => !!document.querySelector('#ui [data-a=quick][autofocus]') && !!document.querySelector('#ui [data-a=offline]')));

  await press(13); // D-pad down
  await press(13);
  check('D-pad moves the highlight with a tick', await p.evaluate(() => window.__sfx.includes('move') && !!document.querySelector('#ui .pad-focus')));
  await p.evaluate(() => { window.__sfx.length = 0; });
  // More modes, Practice, then B back.
  await p.evaluate(() => document.querySelector('#ui [data-a=more]').click());
  await seen(() => !!document.querySelector('#ui [data-a=practice]'));
  await p.evaluate(() => document.querySelector('#ui [data-a=practice]').click());
  check('choosing plays the confirm sound', await seen(() => window.__sfx.includes('select')));
  check('old screen fades out in its own layer, out of reach', await p.evaluate(() => {
    const g = document.querySelectorAll('.ui-ghosts .screen');
    return document.querySelectorAll('#ui .screen').length === 1 && g.length > 0 && Array.from(g).every((e) => e.hasAttribute('inert'));
  }));
  await p.waitForTimeout(500);
  check('ghost removed after the transition', await p.evaluate(() => document.querySelectorAll('.ui-ghosts .screen').length === 0));
  await seen(() => !!document.querySelector('#ui [data-a=p-free]'));
  await press(1);
  check('B goes back with the back sound and slides the other way', await seen(() => window.__sfx.includes('back') && !!document.querySelector('#ui [data-a=offline]')));

  // Settings: plain background and back to live.
  await p.evaluate(() => document.querySelector('#ui [data-a=settings]').click());
  await seen(() => !!document.querySelector('[data-seg=menubg]'));
  await p.evaluate(() => document.querySelector('[data-seg=menubg] [data-v=off]').click());
  check('Menu background Plain stops the stadium', await seen(() => !document.body.classList.contains('menu-live') && !window.__elevens.backdrop.active));
  await p.evaluate(() => document.querySelector('[data-seg=menubg] [data-v=on]').click());
  check('Menu background Live starts it again', await seen(() => window.__elevens.backdrop.active));
  check('settings show the announcer and menu sound options', await p.evaluate(() => !!document.querySelector('[data-seg=announcer]') && !!document.querySelector('[data-seg=menusfx]')));
  await p.evaluate(() => document.querySelector('#ui [data-a=voicetest]').click());
  check('Test voice speaks and reports it working', await seen(() => window.__said.some((t) => /Testing, testing/.test(t)) && /Working/.test(document.querySelector('.voice-status')?.textContent ?? '')));
  await p.evaluate(() => document.querySelector('#ui [data-a=back]').click());
  await seen(() => !!document.querySelector('#ui [data-a=offline]'));

  // Into a match: loading card with controller tips.
  await p.evaluate(() => document.querySelector('#ui [data-a=offline]').click());
  await seen(() => !!document.querySelector('#ui [data-a=next]'));
  await p.evaluate(() => document.querySelector('#ui [data-a=next]').click());
  await seen(() => !!document.querySelector('#ui [data-a=go]'));
  await p.evaluate(() => document.querySelector('#ui [data-a=go]').click());
  check('loading card shows both clubs', await seen(() => document.querySelectorAll('#ui .loading-card .ld-team').length === 2, null, 10000));
  const tip = await p.evaluate(() => document.querySelector('#ui .ld-tip p')?.innerHTML ?? '');
  check('loading tip is shown', tip.length > 20, tip.replace(/<[^>]+>/g, '').slice(0, 70));
  check('stadium stops behind the loading card', await seen(() => !window.__elevens.backdrop.active, null, 5000));
  check('match starts after the card', await seen(() => !document.querySelector('#ui .loading-card') && !!window.__elevens.session, null, 40000));

  // Announcer: welcome, visitors, then the eleven home players with cheers.
  check('announcer reads the line-ups', await seen(() => window.__said.some((t) => /The visitors/.test(t)) && window.__said.filter((t) => /^Number /.test(t)).length === 11, null, 30000), await p.evaluate(() => window.__said.length + ' lines'));
  check('announcer welcomes everyone first', await p.evaluate(() => (() => { const w = window.__said.findIndex((t) => /and welcome to /.test(t)); return w >= 0 && w < window.__said.findIndex((t) => /The visitors/.test(t)); })()));
  check('crowd cheers the home names', await p.evaluate(() => window.__cheers >= 11), await p.evaluate(() => `${window.__cheers} cheers`));
  check('line-ups end after the last name and play starts', await seen(() => !window.__elevens.tv.holding, null, 20000));
  check('menu background is off during the match', await p.evaluate(() => !document.body.classList.contains('menu-live') && !document.body.classList.contains('menu-still')));

  // Quit: the stadium carries on behind the menus with the same clubs.
  const teams = await p.evaluate(() => window.__elevens.session.view().teams.map((t) => t.id));
  await p.keyboard.down('Escape'); await p.waitForTimeout(400); await p.keyboard.up('Escape');
  await seen(() => !!document.querySelector('#ui [data-a=quit]'));
  await p.evaluate(() => document.querySelector('#ui [data-a=quit]').click());
  await p.evaluate(() => document.querySelector('#ui [data-a=quit]')?.click());
  check('quitting brings the live stadium back', await seen(() => window.__elevens.backdrop.active && !!document.querySelector('#ui [data-a=offline]')));
  check('with the same two clubs (no rebuild)', await p.evaluate((t) => JSON.stringify(window.__elevens.backdrop.teams) === JSON.stringify(t), teams), teams.join(' v '));
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
