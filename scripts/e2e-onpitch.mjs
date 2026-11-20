// Browser check for the 20 Nov 2026 evening on-pitch work: solid bodies, timed tackles and the
// computer learning your habits (Settings row, messages in the match, no errors).
// Usage: npm run build && node scripts/e2e-onpitch.mjs. Screenshots in scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
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
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.6, shadows: false, players: 'classic' } }));
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const M = (fn, arg) => p.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const poll = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); } return null; };
  const toast = () => M(() => { const t = document.querySelector('.toast'); return t && t.classList.contains('show') ? t.textContent : ''; });

  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  await p.click('[data-a=quick]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'play', 60000);
  check('the match starts with habits learning on', await M(() => window.__elevens.session.match.cfg.habits === true));

  // Timed tackle by your own man: the ball knocked off the dribbler's boot, nearer you.
  const tackled = await M(() => {
    const m = window.__elevens.session.match;
    const me = m.players[m.ctrl[0].pid];
    const c = m.teamPlayers(1).find((q) => q.role !== 'GK');
    const set = (q, x, z) => { q.pos = { x, z }; q.vel = { x: 0, z: 0 }; q.action = { type: 'none', t: 0, dur: 0 }; };
    set(c, 0, 5); c.vel = { x: 5, z: 0 }; c.facing = 0; c.touchCooldown = 0.2;
    m.takePossession(c, true); m.ball.state = 'dribble'; m.ball.owner = c.id;
    m.ball.pos = { x: 1.4, y: 0.11, z: 5 }; m.ball.vel = { x: 5, y: 0, z: 0 };
    set(me, 2.2, 5); me.facing = Math.PI;
    me.action = { type: 'tackle', t: 0, dur: 0.42 };
    for (let s = 0; s < 30 && m.ball.owner !== me.id; s++) {
      // A clean win is likely, not certain: try again if the dice say no.
      if (m.ball.owner !== c.id && m.ball.owner !== me.id) return 'loose';
      m.resolveTackle(me);
      if (m.ball.owner === me.id) break;
      set(c, 0, 5); c.vel = { x: 5, z: 0 }; c.touchCooldown = 0.2; m.takePossession(c, true); m.ball.state = 'dribble'; m.ball.owner = c.id;
      m.ball.pos = { x: 1.4, y: 0.11, z: 5 }; set(me, 2.2, 5); me.facing = Math.PI; me.action = { type: 'tackle', t: 0, dur: 0.42 };
    }
    return m.ball.owner === me.id ? 'won' : 'no';
  });
  check('a well-timed tackle wins the ball at your feet', tackled === 'won', tackled);
  const t1text = await poll(toast, 3000);
  check('"Perfectly timed tackle" shows', /Perfectly timed tackle/.test(t1text ?? ''), t1text ?? '');
  await p.screenshot({ path: `${OUT}onpitch-01-tackle.png` });

  // Habits: the computer has seen every shot go to the near post: a message, and the keeper expects it.
  await sleep(1200);
  await M(() => {
    const m = window.__elevens.session.match;
    m.habits[0] = { lane: [0, 0], cut: [0, 0], corner: [6, 0], side: [0, 0], through: [0, 0], n: { lane: 0, cut: 0, corner: 6, side: 0, through: 0 }, told: { lane: 0, cut: 0, corner: 0, side: 0, through: 0 }, inAttack: false, cutAt: -99 };
  });
  const hab = await poll(async () => { const t = await toast(); return /near post/.test(t ?? '') ? t : ''; }, 5000);
  check('the habit message shows', !!hab, hab ?? await toast());
  await p.screenshot({ path: `${OUT}onpitch-02-habit.png` });
  check('it is announced once', await M(() => window.__elevens.session.match.habits[0].told.corner === 1));

  // Solid bodies: run your man into a planted opponent; he doesn't go through.
  const solid = await M(() => {
    const m = window.__elevens.session.match;
    const me = m.players[m.ctrl[0].pid];
    const o = m.teamPlayers(1).find((q) => q.role === 'LCB' || q.role === 'RCB');
    me.pos = { x: -20, z: -20 }; me.vel = { x: 7, z: 0 }; me.action = { type: 'none', t: 0, dur: 0 };
    o.pos = { x: -19.3, z: -20 }; o.vel = { x: 0, z: 0 };
    m.moveAll(1 / 60);
    return { gap: Math.hypot(o.pos.x - me.pos.x, o.pos.z - me.pos.z), oMoved: o.pos.x + 19.3, meV: me.vel.x };
  });
  check('your man can\'t run through a planted opponent', solid.gap > 0.7 && solid.oMoved < 0.1 && solid.meV < 4, JSON.stringify(solid));

  // Settings row.
  await p.keyboard.down('Escape'); await sleep(400); await p.keyboard.up('Escape');
  await p.waitForSelector('[data-a=settings]', { timeout: 10000 });
  await p.click('[data-a=settings]');
  await p.waitForSelector('[data-seg=habits]');
  check('Settings has "Opponent learns your habits", On', await M(() => document.querySelector('[data-seg=habits] button.on')?.dataset.v === 'on'));
  await p.click('[data-seg=habits] button[data-v=off]');
  await p.locator('[data-seg=habits]').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}onpitch-03-settings.png` });
  check('turning it off is saved', await M(() => JSON.parse(localStorage.getItem('elevens.settings.v1')).habits === false));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
