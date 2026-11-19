// Browser checks with Playwright + Chromium: offline match flow, a two-client
// online match through the real server, and emulated phone layouts.
// Usage: npm run build && npm run e2e   (CHROMIUM_PATH overrides the browser)
// Writes screenshots and e2e-report.json to scripts/out/. Headless Chromium
// renders WebGL in software (SwiftShader), so frame rates here are NOT
// representative of real hardware.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }); server.once('exit', () => rej(new Error('server exited'))); });

const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const watch = (page, label) => {
  page.on('pageerror', (e) => report.consoleErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(`${label}: ${m.text()}`); });
};
const state = (page) => page.evaluate(() => {
  const a = window.__elevens; const v = a?.session?.view();
  return v ? { phase: v.phase, clock: v.clock, half: v.half, score: v.score, ball: v.ball.pos, fps: a.fps, screen: a.screenName, overlay: a.overlay } : { screen: a?.screenName, overlay: a?.overlay };
});
const waitFor = async (page, fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const s = await state(page); if (fn(s)) return s; await sleep(150); }
  return null;
};

try {
  // ---------------------------------------------------------------- offline
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // Software rendering manages under 1 fps at High and about 1.5 fps at Medium with the 3D
    // crowd, which makes the timed waits below intermittent. These checks are about match flow,
    // not looks (scripts/shots-quality.mjs covers the presets), so E2E_OFFLINE_PRESET defaults to Low.
    const offlinePreset = process.env.E2E_OFFLINE_PRESET ?? 'low';
    report.offlinePreset = offlinePreset;
    await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), offlinePreset);
    const page = await ctx.newPage();
    watch(page, 'offline');
    await page.goto(`${BASE}/?test`);
    await page.screenshot({ path: OUT + 'offline-01-title.png' });
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]');
    await page.click('[data-club=kestrel]');
    await page.screenshot({ path: OUT + 'offline-02-teams.png' });
    await page.click('[data-a=next]');
    await page.click('[data-seg=diff] [data-v=casual]');
    await page.click('[data-seg=min] [data-v="2"]');
    await page.screenshot({ path: OUT + 'offline-03-settings.png' });
    await page.click('[data-a=go]');
    const ko = await waitFor(page, (s) => s.phase === 'kickoff' || s.phase === 'play');
    check('offline: loading leads to kick-off', ko, ko && `phase ${ko.phase}`);
    await sleep(1500);
    await page.keyboard.press('KeyJ');
    // Software rendering can drop to a few frames per second, which slows the simulation
    // (time per frame is capped), so allow longer than real hardware would need.
    const play = await waitFor(page, (s) => s.phase === 'play', 15000);
    check('offline: J takes the kick-off and open play starts', play);
    // Run with the ball and pass/shoot a bit.
    await page.keyboard.down('KeyD'); await page.keyboard.down('ShiftLeft'); await sleep(1500);
    await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyK'); await sleep(400); await page.keyboard.up('KeyK');
    await sleep(800);
    await page.screenshot({ path: OUT + 'offline-04-play.png' });
    const s1 = await state(page); await sleep(3000); const s2 = await state(page);
    check('offline: match clock advances during play', s2.clock > s1.clock, `${s1.clock.toFixed(0)}s -> ${s2.clock.toFixed(0)}s football time`);
    report.offlineFps = Number(s2.fps.toFixed(1));
    check('offline: frame rate measured (software renderer, not representative)', s2.fps > 0, `${s2.fps.toFixed(1)} fps`);
    // Pause.
    await page.keyboard.press('Escape');
    await waitFor(page, (s) => s.overlay === 'pause', 5000);
    const p1 = await state(page); await sleep(1000); const p2 = await state(page);
    await page.screenshot({ path: OUT + 'offline-05-pause.png' });
    check('offline: Esc pauses and the clock stops', p1.overlay === 'pause' && p1.clock === p2.clock, `overlay ${p1.overlay}`);
    await page.click('[data-a=resume]');
    await page.keyboard.press('KeyH');
    await sleep(300);
    await page.screenshot({ path: OUT + 'offline-06-controls-overlay.png' });
    await page.keyboard.press('KeyH');
    // Jump to the end of the first half (test hook) and check half-time.
    await page.evaluate(() => { window.__elevens.session.match.clock = 2695; });
    const ht = await waitFor(page, (s) => s.phase === 'halftime', 20000);
    await sleep(500);
    await page.screenshot({ path: OUT + 'offline-07-halftime.png' });
    check('offline: half-time screen appears', ht && (await state(page)).overlay === 'halftime');
    await page.click('[data-a=second]');
    const h2 = await waitFor(page, (s) => s.half === 2 && (s.phase === 'kickoff' || s.phase === 'play'));
    check('offline: Second half button starts the second half', h2);
    await sleep(1500);
    await page.evaluate(() => { const m = window.__elevens.session.match; if (m.phase === 'kickoff') m.restart.readyT = 99; m.clock = 2697; });
    const ft = await waitFor(page, (s) => s.phase === 'fulltime', 25000);
    await sleep(600);
    await page.screenshot({ path: OUT + 'offline-08-results.png' });
    check('offline: full-time results screen', ft && (await state(page)).overlay === 'fulltime');
    await page.click('[data-a=rematch]');
    const re = await waitFor(page, (s) => s.half === 1 && s.clock === 0 && s.score?.[0] === 0 && s.score?.[1] === 0 && s.overlay === 'none', 10000);
    check('offline: rematch restarts at 0-0', re);
    await page.keyboard.press('Escape');
    await page.click('[data-a=quit]');
    await sleep(300);
    const menu = await state(page);
    check('offline: quit returns to the menu', menu.screen === 'mode', `screen ${menu.screen}`);
    // Settings persist.
    await page.click('[data-a=settings]');
    await page.screenshot({ path: OUT + 'offline-09-settings.png' });
    await ctx.close();
  }

  // ----------------------------------------------------------------- online
  {
    const ca = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await ca.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
    const cb = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await cb.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
    // Both pages share one CPU and render in software here, so heavy presets starve the
    // network loop and distort the clock comparison. E2E_ONLINE_PRESET picks the preset
    // for these two pages (default: low; Medium gave about 1.4 fps and failed the clock check
    // in 2 of 4 runs on 12 Nov, because one rendered frame is then ~10 football seconds).
    const onlinePreset = process.env.E2E_ONLINE_PRESET ?? 'low';
    report.onlinePreset = onlinePreset;
    for (const c of [ca, cb]) await c.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), onlinePreset);
    const a = await ca.newPage(), b = await cb.newPage();
    watch(a, 'online-A'); watch(b, 'online-B');
    await a.goto(`${BASE}/?test`);
    await a.waitForSelector('[data-a=quick]');
    await a.click('[data-a=online]');
    await a.fill('#nm', 'Ada');
    await a.click('[data-a=create]');
    await a.waitForSelector('.bigcode', { timeout: 8000 });
    const code = (await a.textContent('.bigcode')).trim();
    const link = await a.inputValue('#link');
    check('online: host creates a room and gets a code and link', /^[A-Z2-9]{5}$/.test(code), `${code} ${link}`);
    await b.goto(`${BASE}/?test&room=${code}`);
    await b.waitForSelector('.bigcode', { timeout: 8000 });
    await a.screenshot({ path: OUT + 'online-01-lobby-host.png' });
    check('online: guest joins via the shared link', (await b.textContent('.bigcode')).trim() === code);
    await a.click('[data-a=ready]');
    await b.waitForSelector('[data-a=ready]:not([disabled])');
    await sleep(200);
    await b.click('[data-a=ready]');
    const ka = await waitFor(a, (s) => s.phase === 'kickoff' || s.phase === 'play', 15000);
    const kb = await waitFor(b, (s) => s.phase === 'kickoff' || s.phase === 'play', 15000);
    check('online: both clients enter the match', ka && kb);
    await sleep(2000);
    await a.keyboard.press('KeyJ'); await b.keyboard.press('KeyJ');
    await a.keyboard.down('KeyD'); await sleep(1200); await a.keyboard.up('KeyD');
    await sleep(1500);
    await a.screenshot({ path: OUT + 'online-02-match-host.png' });
    await b.screenshot({ path: OUT + 'online-03-match-guest.png' });
    const sa = await state(a), sb = await state(b);
    check('online: both clients show the same score', JSON.stringify(sa.score) === JSON.stringify(sb.score), `${sa.score} vs ${sb.score}`);
    // Sample both pages at once several times; the clock is 15x real time, so 7.5 football seconds = 0.5 s real.
    const diffs = [];
    for (let i = 0; i < 6; i++) {
      const [x, y] = await Promise.all([state(a), state(b)]);
      diffs.push(Math.abs(x.clock - y.clock));
      report.onlineFps = [Number(x.fps.toFixed(1)), Number(y.fps.toFixed(1))];
      await sleep(250);
    }
    diffs.sort((p, q) => p - q);
    report.onlineClockDiffs = diffs;
    check('online: displayed clocks agree within 0.5 s of real time (median of 6 paired samples)', diffs[3] < 7.5, `median ${diffs[3].toFixed(1)} football s; samples ${diffs.map((d) => d.toFixed(1)).join(', ')}`);
    const conn = await a.evaluate(() => window.__elevens.session.conn());
    report.onlineConn = conn;
    check('online: connection status reported to the HUD', conn && typeof conn.latency === 'number', JSON.stringify(conn));
    // Guest drops: host is told and the AI takes over.
    await cb.close();
    const toast = await a.waitForFunction(() => /lost connection|left/i.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 8000 })
      .then(() => a.textContent('.toast')).catch(() => '');
    await a.screenshot({ path: OUT + 'online-04-opponent-dropped.png' });
    check('online: host is told when the guest disconnects', /lost connection|left/i.test(toast ?? ''), toast ?? '');
    await ca.close();
  }

  // ------------------------------------------------------------ mobile (emulated)
  {
    const phone = devices['iPhone 13 landscape'] ?? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
    const ctx = await browser.newContext({ ...phone });
    const page = await ctx.newPage();
    watch(page, 'mobile');
    await page.goto(`${BASE}/?test`);
    // One tap from the main menu: Kick off plays the last setup.
    await page.tap('[data-a=quick]');
    await waitFor(page, (s) => s.phase === 'kickoff' || s.phase === 'play');
    await sleep(1500);
    const visible = await page.isVisible('.touch-layer');
    check('mobile (emulated iPhone 13 landscape): touch controls shown', visible);
    const btn = await page.$('.tb-a');
    if (btn) await btn.tap();
    const pl = await waitFor(page, (s) => s.phase === 'play', 6000);
    check('mobile (emulated): tapping PASS takes the kick-off', pl);
    await sleep(1000);
    await page.screenshot({ path: OUT + 'mobile-01-landscape.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    await page.screenshot({ path: OUT + 'mobile-02-portrait-prompt.png' });
    check('mobile (emulated): portrait shows the rotate prompt', await page.isVisible('#rotate'));
    await ctx.close();
    const tablet = devices['iPad (gen 7) landscape'] ?? { viewport: { width: 1080, height: 810 }, isMobile: true, hasTouch: true };
    const tctx = await browser.newContext({ ...tablet });
    const tp = await tctx.newPage();
    watch(tp, 'tablet');
    await tp.goto(`${BASE}/?test`);
    // One tap from the main menu: Kick off plays the last setup.
    await tp.tap('[data-a=quick]');
    await waitFor(tp, (s) => s.phase === 'kickoff' || s.phase === 'play');
    await sleep(1500);
    await tp.screenshot({ path: OUT + 'tablet-01-landscape.png' });
    check('tablet (emulated iPad landscape): match renders with touch controls', await tp.isVisible('.touch-layer'));
    await tctx.close();
  }
} catch (e) {
  check('e2e script completed without exceptions', false, String(e?.stack ?? e));
} finally {
  report.finished = new Date().toISOString();
  report.passed = report.checks.filter((c) => c.ok).length;
  report.failed = report.checks.filter((c) => !c.ok).length;
  writeFileSync(OUT + 'e2e-report.json', JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${report.failed} failed; console errors: ${report.consoleErrors.length}`);
  await browser.close();
  server.kill();
  process.exitCode = report.failed ? 1 : 0;
}
