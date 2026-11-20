// Browser checks: a controller that works in the menus keeps working once the match starts (PC report,
// 19 Nov 2026). Each fake pad presses A on Kick off in the real main menu, then the left stick and the
// pass button must reach the match. Profiles: a clean Xbox pad (with and without the match intro), a
// right stick resting just past its dead zone, a pad without the standard mapping whose triggers rest
// at -1 on axes 2 and 5, and a silent extra device listed before the real pad.
// Usage: npm run build && node scripts/e2e-padmatch.mjs   (CHROMIUM_PATH overrides the browser)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = 8834;
const BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, tvGraphics: false });

const XBOX = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const PROFILES = [
  { name: 'clean Xbox pad', pads: [{ id: XBOX, mapping: 'standard', axes: [0, 0, 0, 0] }] },
  { name: 'clean Xbox pad with the match intro', query: '&cine', pads: [{ id: XBOX, mapping: 'standard', axes: [0, 0, 0, 0] }] },
  { name: 'right stick resting just past its dead zone', pads: [{ id: XBOX, mapping: 'standard', axes: [0.05, -0.03, 0.27, 0] }] },
  { name: 'no standard mapping, triggers resting at -1', pads: [{ id: 'USB Gamepad (Vendor: 0079 Product: 0006)', mapping: '', axes: [0, 0, -1, 0, 0, -1] }] },
  { name: 'silent extra device listed first', pads: [{ id: 'Virtual HID device', mapping: '', axes: [0, 0, 0, 0] }, { id: XBOX, mapping: 'standard', axes: [0, 0, 0, 0] }], real: 1 },
];

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };

try {
  for (const prof of PROFILES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([s, pads]) => {
      localStorage.setItem('elevens.settings.v1', s);
      const list = pads.map((p, i) => ({ connected: true, id: p.id, index: i, mapping: p.mapping, timestamp: 0, axes: p.axes.slice(), buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }));
      window.__pads = list;
      navigator.getGamepads = () => [...list, null, null, null].slice(0, 4);
    }, [SETTINGS, prof.pads]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const real = prof.real ?? 0;
    const btn = (i, on) => page.evaluate(([r, i, on]) => { const b = window.__pads[r].buttons[i]; b.pressed = on; b.value = on ? 1 : 0; }, [real, i, on]);
    const seen = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
    await page.goto(`${BASE}/?test${prof.query ?? ''}`);
    await page.waitForSelector('[data-a=quick]');
    await page.waitForTimeout(400);
    // A on Kick off (held a moment, as a person would).
    await btn(0, true);
    const started = await seen(() => !!window.__elevens.session);
    await page.waitForTimeout(300);
    await btn(0, false);
    // The intro (when on) is skipped with a button, as the game says.
    if (prof.query === '&cine') {
      await seen(() => window.__elevens.cine?.mode && window.__elevens.cine.mode !== 'none', null, 20000);
      await btn(0, true); await page.waitForTimeout(300); await btn(0, false);
    }
    const playing = started && await seen(() => ['kickoff', 'play'].includes(window.__elevens.session?.match?.phase) && window.__elevens.overlay === 'none' && (!window.__elevens.cine || window.__elevens.cine.mode === 'none'), null, 60000);
    await page.waitForTimeout(1500);
    await page.evaluate((r) => { window.__pads[r].axes[0] = 1; }, real);
    const moved = await seen(() => window.__elevens.actions.held().sx > 0.9, null, 5000);
    await page.evaluate((r) => { window.__pads[r].axes[0] = 0; }, real);
    await btn(0, true);
    const passed = await seen(() => window.__elevens.actions.held().pass === true, null, 5000);
    await btn(0, false);
    check(`${prof.name}: the left stick moves your player in the match`, playing && moved, playing ? '' : 'match never started');
    check(`${prof.name}: A (pass) reaches the match`, playing && passed);
    if (errors.length) check(`${prof.name}: no page errors`, false, errors[0]);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
