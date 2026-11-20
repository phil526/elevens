// Browser check for the 20 Nov 2026 auto-switching work: Settings (style, speed, flash and sound),
// the choice reaching the match, the switch flash, the edge arrow when your man is off screen, and
// starting on a box defender at their corner.
// Usage: npm run build && node scripts/e2e-switch.mjs. Screenshots in scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8798), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ autoSwitch: false, graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic' } }));
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const M = (fn, arg) => p.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };

  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  const migrated = await M(() => window.__elevens.settings.switchStyle);
  check('an old Auto-switch Off setting becomes style Off', migrated === 'off', String(migrated));
  await p.click('[data-a=quick]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'play' || window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  check('the match starts with auto-switch off', await M(() => window.__elevens.session.match.ctrl[0].style === 'off' && !window.__elevens.session.match.ctrl[0].autoSwitch));

  // Settings from the pause menu.
  await p.keyboard.down('Escape'); await sleep(400); await p.keyboard.up('Escape');
  await p.waitForSelector('[data-a=settings]', { timeout: 10000 });
  await p.click('[data-a=settings]');
  await p.waitForSelector('[data-seg=auto]');
  const opts = await M(() => [...document.querySelectorAll('[data-seg=auto] button')].map((b) => b.textContent));
  check('Auto-switch offers Off / High balls / Assisted / Full', JSON.stringify(opts) === JSON.stringify(['Off', 'High balls', 'Assisted', 'Full']), JSON.stringify(opts));
  const speed = await M(() => [...document.querySelectorAll('[data-seg=swsens] button')].map((b) => b.textContent));
  check('Auto-switch speed offers Calm / Normal / Eager', JSON.stringify(speed) === JSON.stringify(['Calm', 'Normal', 'Eager']), JSON.stringify(speed));
  check('Switch flash and sound row is there, On', await M(() => document.querySelector('[data-seg=swcue] button.on')?.dataset.v === 'on'));
  await p.click('[data-seg=auto] button[data-v=full]');
  await p.click('[data-seg=swsens] button[data-v=eager]');
  await p.locator('[data-seg=swsens]').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}switch-01-settings.png` });
  const saved = await M(() => { const s = JSON.parse(localStorage.getItem('elevens.settings.v1')); return [s.switchStyle, s.switchSens, s.autoSwitch]; });
  check('choices are saved', JSON.stringify(saved) === JSON.stringify(['full', 'eager', true]), JSON.stringify(saved));
  check('and reach the match in progress', await M(() => { const c = window.__elevens.session.match.ctrl[0]; return c.style === 'full' && c.sens === 'eager' && c.autoSwitch; }));
  await p.click('[data-a=back]');
  await p.waitForSelector('[data-a=resume]', { timeout: 10000 });
  await p.click('[data-a=resume]');
  await waitFor(() => !document.querySelector('[data-a=resume]'), 10000);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 30000);

  // A carrier through on our goal, our man left upfield: the auto-switch moves you and the marker flashes.
  const scene = () => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(0);
    const put = (pl, fx, fz) => { pl.pos = { x: fx * dir, z: fz * dir }; pl.vel = { x: 0, z: 0 }; pl.action = { type: 'none', t: 0, dur: 0 }; pl.beaten = 0; };
    const role = (t, r) => m.teamPlayers(t).find((x) => x.role === r);
    const car = role(1, 'ST');
    put(car, -24, 0);
    m.takePossession(car, true);
    const h = role(0, 'ST');
    put(h, -6, 6);
    m.ctrl[0].pid = h.id;
    m.ctrl[0].lastAutoSwitch = -10;
    return h.id;
  };
  const before = await M(scene);
  const switched = await waitFor((id) => { const m = window.__elevens.session.match; return m.ctrl[0].pid !== id ? m.ctrl[0].pid : null; }, 6000, before);
  const flash = await M(() => window.__elevens.renderer.flash);
  check('auto-switch moved you to another defender', switched !== null && switched !== before, `${before} -> ${switched}`);
  check('the switch flash fired on the new man', flash && flash.id === switched && flash.t < 1.5, JSON.stringify(flash));
  await p.screenshot({ path: `${OUT}switch-02-flash.png` });

  // Your man far off screen: an arrow at the edge points to him.
  await M(() => {
    const m = window.__elevens.session.match;
    const pl = m.players[m.ctrl[0].pid];
    const ballX = m.ball.pos.x;
    pl.pos = { x: ballX > 0 ? ballX - 60 : ballX + 60, z: 30 };
    m.ctrl[0].autoSwitch = false;
  });
  const arrow = await waitFor(() => { const e = document.querySelector('.edgearrow'); return e && getComputedStyle(e).display !== 'none' ? { x: parseFloat(e.style.left), y: parseFloat(e.style.top), n: e.textContent } : null; }, 4000);
  check('an edge arrow shows your off-screen man', !!arrow, JSON.stringify(arrow));
  await p.screenshot({ path: `${OUT}switch-03-edge-arrow.png` });
  await M(() => { window.__elevens.session.match.ctrl[0].autoSwitch = true; });

  // Their corner: you start on a defender in your box.
  await M(() => {
    const m = window.__elevens.session.match;
    const h = m.teamPlayers(0).find((x) => x.role === 'ST');
    m.ctrl[0].pid = h.id;
    m.award('corner', 1, { x: -52.5 * m.attackDir(0), z: 33.5 });
  });
  const sp = await waitFor(() => { const m = window.__elevens.session.match; if (!m.restart?.ready) return null; const pl = m.players[m.ctrl[0].pid]; return { role: pl.role, x: Math.abs(pl.pos.x) }; }, 30000);
  check('at their corner you start on a defender in the box', sp && sp.role !== 'ST' && sp.role !== 'GK' && sp.x > 36, JSON.stringify(sp));
  await sleep(300);
  await p.screenshot({ path: `${OUT}switch-04-corner.png` });
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
