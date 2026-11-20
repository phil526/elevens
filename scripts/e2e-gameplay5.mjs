// Browser checks for the remaining gameplay ideas: weather and wind, live game plans (button and
// pause menu), player stats panel, taking the keeper, setting the wall, throw-in hints.
// Usage: npm run build && node scripts/e2e-gameplay5.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8805), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } }));
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const hold = async (key, ms = 220) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test&weather=rain&wind=7&winddir=1.2`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(800);
  await hold('KeyJ', 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  const w = await M(() => { const m = window.__elevens.session.match; return { w: m.weather, env: m.env }; });
  check('URL weather reaches the simulation (rain, 7 m/s wind)', w.w.kind === 'rain' && Math.abs(w.w.wind - 7) < 0.01 && Math.abs(w.env.wx) + Math.abs(w.env.wz) > 6, JSON.stringify(w));
  await sleep(600);
  await page.screenshot({ path: OUT + 'gp5-01-rain-wind-radar.png' });
  const radarTitle = await M(() => document.querySelector('.radar')?.title ?? '');
  check('radar shows the wind', /km\/h/.test(radarTitle), radarTitle);

  // Game plan button (Y) steps Balanced -> High press and shows it.
  await hold('KeyY');
  const plan = await waitFor(() => window.__elevens.session.match.plan[0] !== 'balanced' && window.__elevens.session.match.plan[0], 5000);
  await sleep(150);
  const banner = await M(() => document.querySelector('.banner .big')?.textContent ?? '');
  check('game plan button changes the plan and flashes it', plan === 'press' && /High press/i.test(banner), `${plan} / ${banner}`);
  await page.screenshot({ path: OUT + 'gp5-02-plan-banner.png' });

  // Pause menu: Game plan segment and Player stats.
  await page.keyboard.press('Escape');
  await waitFor(() => !!document.querySelector('[data-seg=plan]'), 5000);
  await page.click('[data-seg=plan] [data-v=bus]');
  await sleep(200);
  const bus = await M(() => window.__elevens.session.match.plan[0]);
  check('pause menu Game plan sets Park the bus', bus === 'bus', bus);
  await page.screenshot({ path: OUT + 'gp5-03-pause-plan.png' });
  await page.click('[data-a=squads]');
  const rows = await waitFor(() => document.querySelectorAll('table.squad tr').length, 5000);
  await page.screenshot({ path: OUT + 'gp5-04-player-stats.png' });
  check('Player stats lists both squads', rows >= 22, `${rows} rows`);
  await page.click('[data-a=back]');
  await sleep(200);
  await page.click('[data-a=resume]');
  await sleep(300);

  // Take the keeper (G) while the opponents have the ball.
  await M(() => {
    const m = window.__elevens.session.match;
    const c = m.teamPlayers(1).find((p) => p.role === 'ST');
    m.takePossession(c, true); m.ball.pos = { x: c.pos.x, y: 0.11, z: c.pos.z };
    m.ctrl[0].autoSwitch = false;
  });
  await hold('KeyG');
  const gk = await waitFor(() => { const m = window.__elevens.session.match; return m.players[m.ctrl[0].pid].role === 'GK'; }, 4000);
  await sleep(200);
  const toast = await M(() => document.querySelector('.toast')?.textContent ?? '');
  check('keeper button takes control of the keeper', !!gk, toast);
  await page.screenshot({ path: OUT + 'gp5-05-keeper.png' });
  await hold('KeyG');
  const back = await waitFor(() => { const m = window.__elevens.session.match; return m.players[m.ctrl[0].pid].role !== 'GK'; }, 4000);
  check('pressing it again hands him back', !!back);

  // Free kick against us 22 m out: hint, add a man to the wall (Q), shift it, jump (K).
  await M(() => {
    const m = window.__elevens.session.match;
    const g = m.ownGoalX(0);
    m.award('freekick', 1, { x: g - Math.sign(g) * 22, z: 5 });
  });
  await waitFor(() => window.__elevens.session.match.restart?.ready, 20000);
  await sleep(300);
  const hint = await M(() => document.querySelector('.hint')?.textContent ?? '');
  check('wall hint shown for a free kick against you', /wall/i.test(hint), hint);
  const n0 = await M(() => window.__elevens.session.match.restart?.wall?.n ?? 0);
  await hold('KeyI');
  const n1 = await waitFor((n) => { const r = window.__elevens.session.match.restart; return r?.wall && r.wall.n !== n && r.wall.n; }, 3000, n0);
  check('switch changes the number in the wall', !!n1, `${n0} -> ${n1}`);
  await page.keyboard.down('KeyD');
  await sleep(500);
  await page.keyboard.up('KeyD');
  const shift = await M(() => window.__elevens.session.match.restart?.wall?.shift ?? 0);
  check('the stick shifts the wall', Math.abs(shift) > 0.3, shift.toFixed(2));
  await page.keyboard.down('KeyL');
  const jumped = await waitFor(() => window.__elevens.session.match.players.some((p) => p.team === 0 && p.action.type === 'jump'), 3000);
  await sleep(120);
  await page.screenshot({ path: OUT + 'gp5-06-wall-jump.png' });
  await page.keyboard.up('KeyL');
  check('shoot makes the wall jump', !!jumped);

  // Our throw-in: the hint names the three throws.
  await waitFor(() => window.__elevens.session.match.phase === 'play', 20000);
  await M(() => { const m = window.__elevens.session.match; m.award('throwin', 0, { x: m.attackDir(0) * 25, z: 34 }); });
  await waitFor(() => { const m = window.__elevens.session.match; return m.restart?.ready && m.ctrl[0].pid === m.restart.taker; }, 20000);
  await sleep(200);
  const th = await M(() => document.querySelector('.hint')?.textContent ?? '');
  check('throw-in hint lists short, long and down the line', /short/i.test(th) && /long/i.test(th) && /down the line/i.test(th), th);
  await page.screenshot({ path: OUT + 'gp5-07-throwin.png' });
  await hold('KeyO', 150);
  const thrown = await waitFor(() => window.__elevens.session.match.phase === 'play', 8000);
  check('a down-the-line throw is taken', !!thrown);

  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-gameplay5.json', JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
