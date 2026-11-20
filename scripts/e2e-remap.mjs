// Browser checks for remappable controls (18 Nov 2026): the Controls menu driven by an Xbox pad on an
// iPad (stick/D-pad highlight, A to pick a slot, the next button pressed becomes the binding, swaps,
// saved), and keyboard remapping on a desktop (click a slot, press a key, Esc cancels, reset).
// Usage: npm run build && node scripts/e2e-remap.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, devices } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // --- iPad + Xbox controller.
  const tab = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  await tab.addInitScript(() => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic' } }));
    const pad = { connected: true, id: 'Xbox Wireless Controller', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  const tp = await tab.newPage();
  tp.on('pageerror', (e) => report.consoleErrors.push(e.message));
  tp.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  await tp.goto(`${BASE}/?test`);
  await tp.waitForSelector('[data-a=quick]');
  const seen = (fn, arg) => tp.waitForFunction(fn, arg, { timeout: 15000 }).then(() => true, () => false);
  const nav = async (i) => {
    const dir = i === 12 ? 'up' : i === 13 ? 'down' : i === 14 ? 'left' : 'right';
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, i);
    await seen((d) => window.__elevens.padNav.dir === d, dir);
    await tp.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, i);
    await seen(() => window.__elevens.padNav.dir === '');
  };
  const pressA = async () => {
    await tp.evaluate(() => { window.__pad.buttons[0].pressed = true; });
    await seen(() => window.__elevens.padNav.prevA || !!window.__elevens.rebind);
    await tp.evaluate(() => { window.__pad.buttons[0].pressed = false; });
    await sleep(300);
  };
  const sel = () => tp.evaluate(() => { const e = document.querySelector('.pad-focus'); return e ? (e.dataset.bind ? `${e.dataset.bind}:${e.dataset.slot}` : e.getAttribute('data-a') || e.textContent.trim()) : ''; });
  await tp.waitForSelector('[data-a=offline]');
  let guard = 0;
  // Down to the Controls / Settings row, then left to Controls.
  while ((await sel()) !== 'controls' && guard++ < 10) await nav(['settings', 'profile'].includes(await sel()) ? 14 : 13);
  await pressA();
  const opened = await tp.waitForSelector('.bindrow', { timeout: 5000 }).then(() => true, () => false);
  const tabOn = await tp.evaluate(() => document.querySelector('[data-seg=ctab] .on')?.getAttribute('data-v'));
  check('controller: Controls opens on the Controller remap list when a pad is connected', opened && tabOn === 'pad', `tab ${tabOn}`);
  await seen(() => !!document.querySelector('.pad-focus'));
  const start = await sel();
  const path = [start];
  for (const i of [13, 15, 12, 14]) { await nav(i); path.push(await sel()); }
  check('controller: the highlight starts on the first slot and the stick/D-pad moves it around the grid', path.join(' > ') === 'pass:0 > shoot:0 > shoot:1 > pass:1 > pass:0', path.join(' > '));
  await tp.screenshot({ path: OUT + 'remap-01-ipad-controller.png' });
  // A on Pass, let go, then press RB: RB becomes Pass, and Close control (RB since 19 Nov) takes A in exchange.
  await pressA();
  const listening = await seen(() => !!document.querySelector('.bind.listening'));
  await tp.screenshot({ path: OUT + 'remap-02-ipad-listening.png' });
  await sleep(300);
  await tp.evaluate(() => { window.__pad.buttons[5].pressed = true; });
  const done = await seen(() => !window.__elevens.rebind);
  await tp.evaluate(() => { window.__pad.buttons[5].pressed = false; });
  await sleep(300);
  const after = await tp.evaluate(() => ({ pad: window.__elevens.settings.controls.pad, msg: document.querySelector('.bindmsg')?.textContent ?? '', saved: JSON.parse(localStorage.getItem('elevens.settings.v1')).controls?.pad }));
  await tp.screenshot({ path: OUT + 'remap-03-ipad-swapped.png' });
  check('controller: A starts listening and the next button pressed (RB) becomes Pass; Close control takes A in the swap', listening && done && after.pad.pass.join() === '5' && after.pad.close.join() === '0' && after.pad.sprint.join() === '7' && /RB is now Pass/.test(after.msg), `${JSON.stringify(after.pad.pass)} / close ${JSON.stringify(after.pad.close)} / sprint ${JSON.stringify(after.pad.sprint)} / "${after.msg}"`);
  check('controller: the new layout is saved', after.saved?.pass?.join() === '5');
  const play = await tp.evaluate(() => { const g = window.__elevens.gamepad; g.read(); window.__pad.buttons[5].pressed = true; const r = g.read(); window.__pad.buttons[5].pressed = false; window.__pad.buttons[0].pressed = true; const r2 = g.read(); const m = g.readMenu(); window.__pad.buttons[0].pressed = false; return { rbPass: r.pass, aClose: r2.close, aPass: r2.pass, menuA: m.a }; });
  check('controller: in play RB passes and A is close control, while menus still take A', play.rbPass && play.aClose && !play.aPass && play.menuA, JSON.stringify(play));
  // Waiting without a press cancels; reset puts the defaults back.
  await pressA();
  const cancelled = await tp.waitForFunction(() => !window.__elevens.rebind && /cancelled/.test(document.querySelector('.bindmsg')?.textContent ?? ''), null, { timeout: 15000 }).then(() => true, () => false);
  check('controller: no press for 6 seconds cancels', cancelled);
  guard = 0;
  while (!['bindreset', 'back'].includes(await sel()) && guard++ < 25) await nav(13);
  if ((await sel()) === 'back') await nav(14); // Reset sits left of Back
  const atReset = await sel();
  await pressA();
  const reset = await tp.evaluate(() => window.__elevens.settings.controls.pad.pass.join() === '0' && window.__elevens.settings.controls.pad.sprint.join() === '7' && window.__elevens.settings.controls.pad.close.join() === '5');
  check('controller: Reset controller to defaults', reset, `highlight ${atReset}`);
  // B still goes back.
  await tp.evaluate(() => { window.__pad.buttons[1].pressed = true; });
  const wentBack = await tp.waitForSelector('[data-a=offline]', { timeout: 5000 }).then(() => true, () => false);
  await tp.evaluate(() => { window.__pad.buttons[1].pressed = false; });
  check('controller: B goes back from Controls', wentBack);
  await tab.close();

  // --- Desktop keyboard.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 1, shadows: false, players: 'classic' } })); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=controls]');
  const kTab = await page.evaluate(() => document.querySelector('[data-seg=ctab] .on')?.getAttribute('data-v'));
  await page.click('[data-bind=shoot][data-slot="0"]');
  await page.keyboard.down('KeyJ'); await sleep(150); await page.keyboard.up('KeyJ');
  await sleep(200);
  const k1 = await page.evaluate(() => ({ keys: window.__elevens.settings.controls.keys, msg: document.querySelector('.bindmsg')?.textContent ?? '' }));
  check('keyboard: Controls opens on Keyboard without a pad; pressing J on Shoot swaps it with Pass', kTab === 'keys' && k1.keys.shoot.join() === 'KeyJ' && k1.keys.pass.join() === 'KeyL' && /Pass \/ tackle moved to L/.test(k1.msg), `${kTab} ${k1.keys.shoot} / ${k1.keys.pass} "${k1.msg}"`);
  await page.click('[data-bind=lob][data-slot="1"]');
  await page.keyboard.down('Escape'); await sleep(150); await page.keyboard.up('Escape');
  await sleep(200);
  const k2 = await page.evaluate(() => ({ lob: window.__elevens.settings.controls.keys.lob, rb: !!window.__elevens.rebind, scr: window.__elevens.screenName }));
  check('keyboard: Esc cancels without leaving the menu', k2.lob.join() === 'KeyK' && !k2.rb && k2.scr === 'controls', JSON.stringify(k2));
  await page.click('[data-bind=lob][data-slot="1"]');
  await page.keyboard.down('KeyZ'); await sleep(150); await page.keyboard.up('KeyZ');
  await sleep(200);
  await page.click('[data-seg=ctab] [data-v=list]');
  const listText = await page.textContent('table.ctl');
  await page.screenshot({ path: OUT + 'remap-04-keyboard-list.png', fullPage: true });
  check('keyboard: a second key can be added and the full list shows the new keys', /K or Z/.test(listText ?? ''), (listText ?? '').replace(/\s+/g, ' ').match(/Lofted[^A-Z]*cross.{0,60}/)?.[0]);
  await page.click('[data-seg=ctab] [data-v=keys]');
  await page.screenshot({ path: OUT + 'remap-05-keyboard.png' });
  // The new keys work in a match.
  await page.reload();
  const kept = await page.evaluate(() => window.__elevens.settings.controls.keys.pass.join());
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await page.waitForFunction(() => window.__elevens?.session?.match?.phase === 'kickoff', null, { timeout: 30000 });
  const inMatch = await page.evaluate(() => { const k = window.__elevens.keyboard; k.handle('KeyL', true); const a = k.read(); k.handle('KeyL', false); k.handle('KeyJ', true); const b = k.read(); k.handle('KeyJ', false); return { kPass: a.pass, jShoot: b.shoot }; });
  check('keyboard: remapped keys survive a reload and drive the match', kept === 'KeyL' && inMatch.kPass && inMatch.jShoot, JSON.stringify({ kept, ...inMatch }));
  await ctx.close();
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-remap-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
