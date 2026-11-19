// Browser checks for the gameplay features added in November: aimed set pieces, cards,
// skill moves, slide tackles, contain and click-to-switch, driven with real key presses
// and clicks in headless Chromium. Usage: npm run build && npm run e2e:features
// Keeper distribution and cross types in the real client: hints, the bar label and the kick played.
// Situations are set up through the ?test hook (window.__elevens); the inputs are real.
// Writes screenshots and e2e-plays-report.json to scripts/out/. Software WebGL: no timing claims.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8797), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(800);
  await page.keyboard.press('KeyJ'); // kick-off
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  // --- keeper distribution
  const holdKeeper = () => M(() => {
    const m = window.__elevens.session.match; const dir = m.attackDir(0); const gk = m.keeper(0);
    gk.pos = { x: -dir * 48, z: 0 }; gk.vel = { x: 0, z: 0 }; gk.facing = dir > 0 ? 0 : Math.PI; gk.action = { type: 'none', t: 0, dur: 0 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: dir * (20 + (o.slot % 3) * 5), z: (o.slot % 5) * 10 - 20 };
    const b = m.ball; b.owner = gk.id; b.state = 'held'; b.flight = 'none'; b.lastTouch = gk.id; b.lastTouchTeam = 0; b.pos = { x: gk.pos.x, y: 1.15, z: 0 }; b.vel = { x: 0, y: 0, z: 0 }; m.holdT = 0.6;
    window.__rel = null;
    const orig = window.__origRelease ?? (window.__origRelease = m.startKick.bind(m));
    m.startKick = (p, req, h) => { if (p.id === gk.id) window.__rel = { kind: req.kind, variant: req.variant ?? null, x: gk.pos.x }; return orig(p, req, h); };
  });
  for (const [key, want, label] of [['KeyL', 'throw', 'THROW'], ['KeyK', 'punt', 'PUNT'], ['KeyJ', 'roll', 'ROLL OUT'], ['KeyI', 'dropkick', 'DROP-KICK']]) {
    await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
    await holdKeeper();
    const hint = await waitFor(() => { const h = document.querySelector('.hint'); return h && h.offsetParent && /Keeper's ball/.test(h.textContent) ? h.textContent : null; }, 5000);
    await page.keyboard.down(key);
    const seen = await waitFor((l) => { const b = document.querySelector('.power b'); return b && b.textContent.startsWith(l) ? b.textContent : null; }, 4000, label);
    if (want === 'throw') await page.screenshot({ path: OUT + 'plays-01-keeper-throw.png' });
    await sleep(want === 'punt' ? 700 : 300);
    await page.keyboard.up(key);
    const rel = await waitFor(() => window.__rel, 4000);
    const got = rel ? (rel.variant ?? (rel.kind === 'throw' ? 'throw' : rel.kind)) : null;
    check(`keeper: ${key.slice(3)} plays ${want} (hint shown, bar "${label}")`, !!hint && !!seen && got === want, `bar "${seen}", played ${got}`);
  }

  // --- crosses from the left wing
  const wing = () => M(() => {
    const m = window.__elevens.session.match; const dir = m.attackDir(0);
    const w = m.teamPlayers(0).find((q) => q.role === 'LW'); const st = m.teamPlayers(0).find((q) => q.role === 'ST');
    m.ctrl[0].pid = w.id; m.ctrl[0].autoSwitch = false;
    w.pos = { x: 38 * dir, z: 27 }; w.vel = { x: 0, z: 0 }; w.facing = -Math.PI / 2; w.action = { type: 'none', t: 0, dur: 0 };
    st.pos = { x: 44 * dir, z: 2 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') o.pos = { x: dir * (5 + o.slot), z: -25 + o.slot * 3 };
    m.takePossession(w, true); m.ball.pos = { x: w.pos.x, y: 0.11, z: w.pos.z - 0.5 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    window.__x = null;
    const orig = window.__origK ?? (window.__origK = m.startKick.bind(m));
    m.startKick = (p, req, h) => { if (p.id === w.id) window.__x = { kind: req.kind, variant: req.variant ?? null }; return orig(p, req, h); };
  });
  for (const [mod, key, label, flight] of [[false, 'KeyL', 'FLOATED CROSS', 'cross'], [true, 'KeyL', 'WHIPPED CROSS', 'cross'], [true, 'KeyJ', 'LOW CROSS', 'pass']]) {
    await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
    await wing();
    await sleep(200);
    if (mod) await page.keyboard.down('KeyE');
    await page.keyboard.down(key);
    const seen = await waitFor((l) => { const b = document.querySelector('.power b'); return b && b.textContent.startsWith(l) ? b.textContent : null; }, 4000, label);
    if (label === 'WHIPPED CROSS') await page.screenshot({ path: OUT + 'plays-02-whipped-cross.png' });
    await sleep(250);
    await page.keyboard.up(key);
    if (mod) await page.keyboard.up('KeyE');
    const fl = await waitFor(() => { const b = window.__elevens.session.match.ball; return window.__x && b.state === 'flight' ? { flight: b.flight, spin: b.spin } : null; }, 4000);
    const ok = !!seen && fl && fl.flight === flight && (label !== 'WHIPPED CROSS' || fl.spin !== 0);
    check(`cross: ${label}`, ok, `bar "${seen}", flight ${fl?.flight}, spin ${fl?.spin?.toFixed?.(1)}`);
    if (label === 'FLOATED CROSS') { await sleep(500); await page.screenshot({ path: OUT + 'plays-03-floated-cross.png' }); }
  }
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-plays-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
