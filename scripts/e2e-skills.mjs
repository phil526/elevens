// Browser checks for jockey/contain, the roulette and fake shot, and right-stick flick switching,
// in headless Chromium with real key presses and a fake Xbox controller.
// Usage: npm run build && node scripts/e2e-skills.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } }));
    const pad = { connected: false, id: 'Xbox Wireless Controller (fake)', index: 0, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad.connected ? pad : null, null, null, null];
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(800);
  await hold('KeyJ', 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await sleep(1500);

  // Opponent carrier frozen in the middle; our controlled defender 8 m away. Jockey (E) with no direction.
  const setDefending = () => M(() => {
    const m = window.__elevens.session.match;
    const c = m.teamPlayers(1).find((p) => p.role === 'RCM');
    const me = m.teamPlayers(0).find((p) => p.role === 'LCB');
    for (const p of m.players) if (p !== c && p !== me && Math.hypot(p.pos.x, p.pos.z) < 16) p.pos = { x: p.pos.x, z: p.pos.z > 0 ? 25 : -25 };
    c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; c.action = { type: 'none', t: 0, dur: 0 };
    c.facing = m.ownGoalX(0) > 0 ? 0 : Math.PI;
    m.takePossession(c, true); m.ball.pos = { x: c.pos.x + Math.cos(c.facing) * 0.4, y: 0.11, z: c.pos.z + Math.sin(c.facing) * 0.4 };
    m.ctrl[0].pid = me.id; m.ctrl[0].autoSwitch = false;
    me.pos = { x: Math.sign(m.ownGoalX(0)) * 8, z: 6 }; me.action = { type: 'none', t: 0, dur: 0 };
    window.__freeze = setInterval(() => { c.aiNextDecision = m.time + 30; c.aiTarget = { ...c.pos }; c.wish = { x: 0, z: 0, mode: 'walk', face: null }; }, 5);
    return { c: c.id, me: me.id };
  });
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  const ids = await setDefending();
  const t0 = await M(() => window.__elevens.session.match.time);
  await page.keyboard.down('KeyE');
  await waitFor((t) => window.__elevens.session.match.time > t + 4, 30000, t0); // 4 s of match time, however slow the renderer
  const jk = await M(({ c, me }) => {
    const m = window.__elevens.session.match, C = m.players[c], P = m.players[me];
    return { d: Math.hypot(P.pos.x - C.pos.x, P.pos.z - C.pos.z), goalSide: (P.pos.x - C.pos.x) * Math.sign(m.ownGoalX(0)), jockeying: P.jockeying, owner: m.ball.owner === c };
  }, ids);
  await page.screenshot({ path: OUT + 'skills-01-jockey-contain.png' });
  await page.keyboard.up('KeyE');
  check('jockey with no direction holds a goal-side spot ~2 m from the carrier', jk.owner && jk.jockeying && jk.d > 1.3 && jk.d < 3.2 && jk.goalSide > 1, JSON.stringify(jk));

  // Right-stick flick switches to a teammate (fake controller).
  await M(() => { window.__pad.connected = true; });
  await sleep(300);
  const before = await M(() => window.__elevens.session.match.ctrl[0].pid);
  for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    await M(([x, y]) => { window.__pad.axes[2] = x; window.__pad.axes[3] = y; }, dir);
    await sleep(250);
    await M(() => { window.__pad.axes[2] = 0; window.__pad.axes[3] = 0; });
    await sleep(250);
    if ((await M(() => window.__elevens.session.match.ctrl[0].pid)) !== before) break;
  }
  const after = await M(() => window.__elevens.session.match.ctrl[0].pid);
  check('right-stick flick while defending switches player', after !== before, `${before} -> ${after}`);
  await M(() => { clearInterval(window.__freeze); }); // the pad stays connected (unplugging pauses the match)
  await sleep(300);

  // Fake shot: hold K, tap J. Our striker on the ball in space.
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  const st = await M(() => {
    const m = window.__elevens.session.match;
    const p = m.teamPlayers(0).find((q) => q.role === 'ST');
    for (const q of m.players) if (q !== p && Math.hypot(q.pos.x, q.pos.z) < 12) q.pos = { x: q.pos.x, z: q.pos.z > 0 ? 22 : -22 };
    p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.action = { type: 'none', t: 0, dur: 0 }; p.skillCd = 0;
    p.facing = 0; m.takePossession(p, true); m.ball.pos = { x: 0.4, y: 0.11, z: 0 }; m.ctrl[0].pid = p.id;
    window.__seen = [];
    window.__watch = setInterval(() => { const a = p.action; if (a.type === 'skill' && !window.__seen.includes(a.skill)) window.__seen.push(a.skill); if (a.type === 'kick' && a.kind === 'shot') window.__seen.push('shot'); }, 5);
    return p.id;
  });
  await page.keyboard.down('KeyL');
  await sleep(250);
  await hold('KeyJ', 150);
  await sleep(150);
  await page.keyboard.up('KeyL');
  await sleep(600);
  const seen1 = await M(() => window.__seen.slice());
  check('hold shoot + tap pass plays a fake shot, not a shot', seen1.includes('fakeshot') && !seen1.includes('shot'), JSON.stringify(seen1));

  // Roulette: shown mid-spin for the screenshot (direction picked relative to facing).
  await sleep(800);
  const spin = await M((id) => {
    const m = window.__elevens.session.match, p = m.players[id];
    if (m.ball.owner !== id) { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.4, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.4 }; }
    p.action = { type: 'none', t: 0, dur: 0 }; p.skillCd = 0;
    const a = p.facing + 2.1;
    return m.startSkill(p, Math.cos(a), Math.sin(a));
  }, st);
  await sleep(200);
  await page.screenshot({ path: OUT + 'skills-02-roulette.png' });
  await sleep(700);
  const kept = await M((id) => window.__elevens.session.match.ball.owner === id, st);
  check('roulette runs in the game and keeps the ball', spin === 'roulette' && kept, `${spin} kept=${kept}`);

  // Settings: the right-stick switch reference is offered and saved.
  await page.keyboard.down('Escape'); await sleep(250); await page.keyboard.up('Escape');
  await waitFor(() => !!document.querySelector('[data-a=settings]'), 4000);
  await page.click('[data-a=settings]');
  const seg = await waitFor(() => !!document.querySelector('[data-seg=sswitch] [data-v=ball]'), 4000);
  if (seg) await page.click('[data-seg=sswitch] [data-v=ball]');
  await sleep(200);
  const saved = await M(() => JSON.parse(localStorage.getItem('elevens.settings.v1')).stickSwitch);
  await page.screenshot({ path: OUT + 'skills-03-settings.png' });
  check('Settings offers "Right-stick switch from" and saves it', seg && saved === 'ball', String(saved));
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  writeFileSync(OUT + 'e2e-skills-report.json', JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`${report.checks.length - failed}/${report.checks.length} passed`);
process.exit(failed ? 1 : 0);
