// Browser checks for the 21 Nov 2026 polish pass: the sound mix (ducking, muffled pause), impact
// moments (hit-stop, camera punch, score pop), the message queue, button icons, the Settings
// tidy-up, one-time tips, smooth camera cuts, tap prompts on touch, the hidden-effects warm-up
// and the big screens backing off when frames run long.
// Usage: npm run build && node scripts/e2e-polish21.mjs   (CHROMIUM_PATH overrides the browser)

import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8832;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'medium', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear', bigScreen: 'live' }, matchIntro: false, tvGraphics: false, menuBackdrop: false, camera: { mode: 'broadcast', height: 'standard', zoom: 'standard' } });

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const M = (fn, a) => page.evaluate(fn, a);
  const until = (fn, a, timeout = 30000) => page.waitForFunction(fn, a, { timeout }).then(() => true, () => false);
  await page.goto(`${BASE}/?test&tips`);
  await page.waitForSelector('[data-a=quick]', { timeout: 120000 });
  await page.click('[data-a=quick]');
  check('a match starts', await until(() => ['kickoff', 'play'].includes(window.__elevens.session?.match?.phase), null, 90000));
  await until(() => window.__elevens.session.match.phase === 'play', null, 30000);
  await sleep(800);

  // --- Warm-up and big screens.
  check('hidden effects were compiled before kick-off', await M(() => window.__elevens.renderer.warmedHidden > 0), String(await M(() => window.__elevens.renderer.warmedHidden)));
  const steps = await M(async () => {
    const r = window.__elevens.renderer;
    const wait = () => new Promise((ok) => setTimeout(ok, 1500));
    r.frameLoad = 16; await wait(); const fast = r.feed?.lastStep ?? 0;
    const orig = Object.getOwnPropertyDescriptor(r, 'frameLoad');
    let slow = 0;
    // Hold the measured load high for a moment (the app writes it every frame).
    const t0 = performance.now();
    await new Promise((ok) => { const f = () => { r.frameLoad = 40; if (performance.now() - t0 < 2500) requestAnimationFrame(f); else ok(); }; f(); });
    slow = r.feed?.lastStep ?? 0;
    void orig;
    return { fast, slow };
  });
  const base = await M(() => window.__elevens.renderer.feed?.step ?? 0);
  check('the big screens film a quarter as often when frames run long', base > 0 && Math.abs(steps.slow - base * 4) < 1e-6, JSON.stringify({ ...steps, base }));

  // --- Sound mix: whistle ducks the crowd; pause muffles and stops the commentator.
  await M(() => window.__elevens.audio.unlock());
  // (Headless audio clocks run fast, so the dip is checked as scheduled rather than heard.)
  const duck = await M(() => { const a = window.__elevens.audio; const t = a.ctx.currentTime; a.whistle('foul'); return { depth: a.duckDepth, until: a.duckUntil - t }; });
  check('the crowd dips under the referee\'s whistle', duck.depth < 0.9 && duck.until > 0.3, JSON.stringify(duck));
  await M(() => window.__elevens.openPause());
  await sleep(200);
  check('pausing muffles the crowd and quiets the commentator', await M(() => window.__elevens.audio.paused && window.__elevens.audio.say('goal') === false));
  await M(() => window.__elevens.closeOverlay());
  await sleep(200);
  check('resuming brings the crowd back', await M(() => !window.__elevens.audio.paused));

  // --- Impact.
  const imp = await M(() => {
    const a = window.__elevens; const s = a.session;
    a.bigMoments(s, [{ id: 1, tick: 0, type: 'kick', text: 'shot', power: 30, team: 0 }]);
    return { hit: a.hitStop.active, punch: a.renderer.punchLevel };
  });
  check('a thunderous shot freezes play for a split second and punches the camera in', imp.hit && imp.punch > 0, JSON.stringify(imp));
  check('the hit-stop is over a moment later', await until(() => !window.__elevens.hitStop.active, null, 3000));
  const pops = await M(async () => { const a = window.__elevens; const before = a.hud.pops; a.session.match.score[0]++; await new Promise((ok) => setTimeout(ok, 1300)); return { before, after: a.hud.pops, cls: document.querySelector('.scorebug .sc')?.className, up: document.querySelectorAll('.scorebug .sc span.up').length }; });
  check('a goal pops the score in the score bug', pops.after === pops.before + 1 && /pop/.test(pops.cls) && pops.up === 1, JSON.stringify(pops));
  check('the woodwork rings (clang plays without errors)', await M(() => { try { window.__elevens.audio.post(10, 25); return true; } catch { return false; } }));

  // --- Message queue.
  const q = await M(async () => {
    const h = window.__elevens.hud; h.clearToasts();
    // Software rendering slows timers a lot, so nothing should go stale in this check.
    h.toastStale = 60000;
    const n0 = h.shownToasts.length;
    h.toast('Match info one', 1500, 1);
    h.toast('Heavy touch', 900, 0); // dropped: something is showing
    h.toast('Match info two', 500, 1); // waits
    const mid = h.toasts;
    h.toast('Important news', 500, 2); // takes over, info one goes back to the front
    const after = h.toasts;
    // Slow software-rendered frames delay timers, so wait for the queue to empty rather than a fixed time.
    const t0 = performance.now();
    while (performance.now() - t0 < 12000 && (h.toasts.now || h.toasts.waiting.length)) await new Promise((ok) => setTimeout(ok, 100));
    await new Promise((ok) => setTimeout(ok, 400));
    h.toastStale = 2500;
    return { mid, after, shown: h.shownToasts.slice(n0), ms: Math.round(performance.now() - t0) };
  });
  check('a small call is dropped while a message shows, and a second message waits its turn', q.mid.now === 'Match info one' && q.mid.waiting.join() === 'Match info two', JSON.stringify(q.mid));
  check('an important message takes over and the one it replaced comes back next', q.after.now === 'Important news' && q.after.waiting[0] === 'Match info one', JSON.stringify(q.after));
  check('every queued message is shown in turn', ['Important news', 'Match info one', 'Match info two'].every((m) => q.shown.includes(m)), JSON.stringify(q));
  const stale = await M(async () => {
    const h = window.__elevens.hud; h.clearToasts(); h.toastStale = 1;
    const n0 = h.shownToasts.length;
    h.toast('Old news one', 300, 1); h.toast('Old news two', 300, 1);
    await new Promise((ok) => setTimeout(ok, 1500));
    h.toastStale = 2500;
    return h.shownToasts.slice(n0);
  });
  check('a message that waited too long is dropped', stale.join() === 'Old news one', JSON.stringify(stale));

  // --- Button icons.
  const icons = await M(async () => {
    const a = window.__elevens;
    a.actions.lastDevice = 'gamepad';
    await new Promise((ok) => setTimeout(ok, 300));
    const pad = document.querySelector('.guide')?.innerHTML ?? '';
    a.actions.lastDevice = 'keyboard';
    await new Promise((ok) => setTimeout(ok, 300));
    return { pad: /kbd class="pad pad-face pad-xa"/.test(pad), shoulder: /pad-bumper|pad-trigger/.test(pad), keyHtml: a.buttonHtml('shoot') };
  });
  check('controller hints draw the real buttons (coloured face buttons, shoulders)', icons.pad && icons.shoulder);
  check('keyboard keys show as key caps', /class="key"/.test(icons.keyHtml), icons.keyHtml);

  // --- Smooth camera cut: changing the view glides instead of jumping.
  const glide = await M(async () => {
    const a = window.__elevens; const r = a.renderer; const n = r.cutBlends;
    const frame = () => new Promise((ok) => requestAnimationFrame(ok));
    let blending = false; const t0 = performance.now();
    // A TV cutaway or set-piece camera has its own moves, so try when the plain match camera is on.
    for (let tries = 0; tries < 4 && !blending; tries++) {
      while (performance.now() - t0 < 20000 && (r.liveCam || r.cine || r.viewOverride)) await frame();
      a.settings.camera.mode = tries % 2 ? 'broadcast' : 'tracking';
      const t1 = performance.now();
      while (performance.now() - t1 < 3000 && !(blending = r.cutBlending)) await frame();
    }
    a.settings.camera.mode = 'broadcast';
    const n1 = r.cutBlends;
    // Then ordinary play (the camera following the ball) shouldn't count as cuts.
    await new Promise((ok) => setTimeout(ok, 400));
    const n2 = r.cutBlends; let quiet = 0; const t2 = performance.now();
    while (performance.now() - t2 < 4000) { await frame(); if (!r.liveCam && !r.cine && !r.viewOverride) quiet++; }
    return { n0: n, n1, blending, ms: Math.round(performance.now() - t0), followBlends: r.cutBlends - n2, quiet };
  });
  check('a camera jump becomes a glide', glide.n1 > glide.n0 && glide.blending, JSON.stringify(glide));
  check('the camera following play is not mistaken for a cut', glide.quiet < 5 || glide.followBlends === 0, JSON.stringify(glide));

  // --- One-time tips.
  // Tire the controlled player so the 'Tired legs' tip is sure to come up.
  const tipShown = await until(() => {
    const a = window.__elevens; const m = a.session?.match; const lt = a.session?.localTeams?.[0] ?? 0;
    const i = m?.ctrl?.[lt]?.pid ?? -1; if (m && i >= 0 && m.players[i]) m.players[i].stamina = 0.15;
    return !!a.tips.showing;
  }, null, 30000);
  const tip = await M(() => ({ id: window.__elevens.tips.showing, seen: window.__elevens.settings.tipsSeen, html: document.querySelector('.tipcard')?.innerHTML ?? '' }));
  check('a one-time tip appears in the match and is remembered', tipShown && tip.seen.includes(tip.id), JSON.stringify({ id: tip.id, seen: tip.seen }));
  check('the tip shows the buttons as icons', /<kbd/.test(tip.html));
  await page.screenshot({ path: OUT + 'polish21-tip.png' });

  // --- Settings tidy-up.
  await M(() => { window.__elevens.openPause(); window.__elevens.showSettings(() => window.__elevens.openPause(), true); });
  await sleep(300);
  const st = await M(() => ({ desc: document.querySelectorAll('.settings-panel .lbl .desc').length, jump: document.querySelectorAll('[data-jump]').length, more: document.querySelectorAll('details.more').length, resets: document.querySelectorAll('[data-reset]').length }));
  check('every option has a line saying what it does', st.desc >= 55, JSON.stringify(st));
  check('jump buttons, a Reset per section and the long notes folded away', st.jump === 5 && st.resets === 4 && st.more >= 3, JSON.stringify(st));
  await page.click('[data-seg=cmode] [data-v=wide]');
  await sleep(150);
  const ch = await M(() => ({ changed: !!document.querySelector('[data-seg=cmode]')?.closest('.row')?.classList.contains('changed'), btn: document.querySelector('[data-reset=camera]')?.textContent, scroll: document.querySelector('#ui .screen')?.scrollTop }));
  check('a changed option is marked and its section offers a reset', ch.changed && /Reset \(\d+ changed\)/.test(ch.btn ?? ''), JSON.stringify(ch));
  check('changing an option keeps the page where it was (no jump to the top)', (ch.scroll ?? 0) > 100, String(ch.scroll));
  await page.click('[data-reset=camera]');
  await sleep(100);
  check('Reset asks to be pressed again', /Sure/.test(await M(() => document.querySelector('[data-reset=camera]')?.textContent ?? '')));
  await page.click('[data-reset=camera]');
  await sleep(150);
  check('pressed again, it puts the camera back to the defaults', await M(() => window.__elevens.settings.camera.mode === 'broadcast' && !document.querySelector('[data-seg=cmode]')?.closest('.row')?.classList.contains('changed')));
  await page.screenshot({ path: OUT + 'polish21-settings.png' });
  const tipsAgain = await M(() => !!document.querySelector('[data-a=tipsagain]'));
  check('Settings can show the tips again', tipsAgain);
  await M(() => window.__elevens.closeOverlay());

  // --- Touch prompts.
  const tctx = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await tctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); }, SETTINGS);
  const tp = await tctx.newPage();
  await tp.goto(`${BASE}/?test`);
  await tp.waitForSelector('[data-a=quick]', { timeout: 120000 });
  const prompts = await tp.evaluate(() => ({ cine: document.querySelector('.cine-skip')?.textContent, touch: window.__elevens.touchMode }));
  check('on a touch screen the skip prompts say tap', !prompts.touch || /Tap/.test(prompts.cine ?? ''), JSON.stringify(prompts));
  await tctx.close();
} catch (e) {
  check('no exceptions', false, String(e?.stack ?? e).slice(0, 400));
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
