// Browser checks for the smarter teammates (19 Nov): calls for the ball (arm up + bubble over the
// head), the Player instructions panel in the pause menu, and that instructions reach the match.
// Usage: npm run build && node scripts/e2e-teammates.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8806), BASE = `http://127.0.0.1:${PORT}`;
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

  // Give the human's centre midfielder the ball in space with the opponents far away: teammates call.
  const setup = () => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(0);
    const c = m.teamPlayers(0).find((p) => p.role === 'RCM');
    c.pos = { x: -5 * dir, z: 6 }; c.vel = { x: 0, z: 0 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') { o.pos = { x: dir * (32 + (o.slot % 3) * 3), z: (o.slot % 5) * 8 - 16 }; o.vel = { x: 0, z: 0 }; }
    m.ctrl[0].pid = c.id;
    const b = m.ball;
    b.owner = c.id; b.state = 'dribble'; b.flight = 'none'; b.lastTouch = c.id; b.lastTouchTeam = 0;
    b.pos = { x: c.pos.x, y: 0.11, z: c.pos.z }; b.vel = { x: 0, y: 0, z: 0 };
    m.possessionStart = m.time;
    m.plans = [null, null];
  };
  await M(setup);
  const calling = await waitFor(() => {
    const r = window.__elevens.renderer, m = window.__elevens.session.match;
    const ids = m.players.filter((p) => p.team === 0 && p.callUntil > m.time).map((p) => p.id);
    const bubbles = r.callBubbles.filter((s) => s.visible).length;
    const arms = ids.filter((id) => r.reactions.kindOf(id) === 'call').length;
    return ids.length && bubbles && arms ? { ids, bubbles, arms } : null;
  }, 6000);
  check('free teammates call for the ball: bubble over the head and an arm up', !!calling, JSON.stringify(calling));
  if (calling) {
    await M((id) => { const r = window.__elevens.renderer, p = window.__elevens.session.match.players[id]; r.viewOverride = { pos: [p.pos.x - 6, 3.2, p.pos.z + 9], look: [p.pos.x, 1.4, p.pos.z] }; }, calling.ids[0]);
    await sleep(500);
    await page.screenshot({ path: OUT + 'mates-01-call.png' });
    await M(() => { window.__elevens.renderer.viewOverride = null; });
  }
  await page.screenshot({ path: OUT + 'mates-02-calls-wide.png' });

  // Pause menu: Player instructions.
  await page.keyboard.press('Escape');
  await waitFor(() => !!document.querySelector('[data-a=instr]'), 5000);
  await page.click('[data-a=instr]');
  const rows = await waitFor(() => document.querySelectorAll('.field.instr').length, 5000);
  check('Player instructions lists the ten outfield players', rows === 10, String(rows));
  const lbSlot = await M(() => window.__elevens.session.match.teamPlayers(0).find((p) => p.role === 'LB').slot);
  const stSlot = await M(() => window.__elevens.session.match.teamPlayers(0).find((p) => p.role === 'ST').slot);
  await page.click(`[data-seg=in${lbSlot}] [data-v="-1"]`);
  await page.click(`[data-seg=in${stSlot}] [data-v="1"]`);
  await sleep(200);
  const ins = await M(([a, b]) => { const m = window.__elevens.session.match; return [m.instr[0][a], m.instr[0][b]]; }, [lbSlot, stSlot]);
  const on = await M((a) => document.querySelector(`[data-seg=in${a}] .on`)?.textContent, lbSlot);
  check('instructions reach the match and the panel shows them', ins[0] === -1 && ins[1] === 1 && on === 'Stay back', `${ins} / ${on}`);
  await page.screenshot({ path: OUT + 'mates-03-instructions.png' });
  await page.click('[data-a=reset]');
  await sleep(150);
  const reset = await M(() => window.__elevens.session.match.instr[0].every((v) => v === 0));
  check('All normal resets every instruction', reset);
  await page.click('[data-a=back]');
  check('Back returns to the pause menu', !!(await waitFor(() => !!document.querySelector('[data-a=resume]'), 3000)));
  await page.click('[data-a=resume]');
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-teammates.json', JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
