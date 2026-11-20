// Frame-by-frame contact sheets of the player animations, rendered deterministically
// (the model is stepped with a fixed time step, independent of the slow software frame rate).
// Usage: npm run build && node scripts/shots-anim.mjs [tag] [preset]
// Writes scripts/out/anim-<tag>-<motion>.png: 12 frames per motion, side-on, left to right.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const tag = process.argv[2] ?? 'now';
const preset = process.argv[3] ?? 'medium';
const view = process.env.ANIM_VIEW ?? 'side';
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
// Motions: [name, speed m/s, action, frames, dt]
const MOTIONS = [
  // [name, ballY at contact, ball speed, frames, dt]: the ball flies straight at the keeper, is caught, then held.
  ['catchScoop', 0.11, 9, 12, 0.08],
  ['catchKneel', 0.11, 16, 12, 0.09],
  ['catchWaist', 0.8, 14, 12, 0.07],
  ['catchChest', 1.3, 14, 12, 0.07],
  ['catchHead', 1.8, 14, 12, 0.07],
  ['catchHigh', 2.35, 10, 12, 0.08],
  ['catchSmother', 0.11, 3, 14, 0.1],
  ['throwOver', 0, 0, 12, 0.06],
  ['throwRoll', 0, 0, 12, 0.06],
  ['diveCollapse', 0.5, 0, 12, 0.11],
  ['diveLow', 0.25, 0, 12, 0.11],
  ['diveFull', 1.2, 0, 12, 0.11],
  ['diveHigh', 2.2, 0, 12, 0.11],
  ['diveParry', 1.5, 0, 12, 0.11],
  ['diveCatch', 1.0, 0, 12, 0.11],
  ['parryStand', 1.4, 18, 10, 0.06],
];
try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: 'realistic' } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  // Wait for the realistic models to replace the classic ones.
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }

  // Live check: shots at the computer's keeper in a running match; log which animations play.
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') break; await page.keyboard.down('KeyL'); await sleep(300); await page.keyboard.up('KeyL'); await sleep(300); }
  const SHOTS = [[4.4, 1.0, 22], [3.9, 2.4, 22], [2.8, 1.2, 22]];
  for (const [z, y, sp] of SHOTS) {
    const ok = await page.evaluate(([z, y, sp]) => {
      const m = window.__elevens.session.match;
      if (m.phase !== 'play') return m.phase;
      const gk = m.keeper(1); const gx = m.ownGoalX(1); const side = Math.sign(gx);
      gk.pos = { x: gx - side * 1.2, z: 0 }; gk.vel = { x: 0, z: 0 }; gk.action = { type: 'none', t: 0, dur: 0 }; gk.facing = side > 0 ? Math.PI : 0;
      for (const p of m.players) if (p.id !== gk.id && Math.abs(p.pos.x - gx) < 25) p.pos = { x: p.pos.x - side * 25, z: p.pos.z };
      const b = m.ball; const from = { x: gx - side * 16, y: 0.3, z: 0 };
      const T = { x: gx, y, z }; const d = Math.hypot(T.x - from.x, T.z - from.z); const t = d / sp;
      b.pos = { ...from }; b.vel = { x: (T.x - from.x) / t, y: (T.y - from.y) / t + 4.9 * t, z: (T.z - from.z) / t }; b.spin = 0;
      b.state = 'flight'; b.flight = 'shot'; b.owner = -1; b.lastTouch = m.players.find((p) => p.team === 0 && p.role !== 'GK').id; b.lastTouchTeam = 0; b.kicker = b.lastTouch; b.kickLock = 0.3;
      m.lastKickTime = m.time; window.__gkLog = []; window.__gkId = gk.id; return 'ok';
    }, [z, y, sp]);
    const seen = [];
    for (let i = 0; i < 60; i++) {
      const r = await page.evaluate(() => {
        const a = window.__elevens; const m = a.renderer.players[window.__gkId]; const p = a.session.view().players[window.__gkId];
        const o = [];
        if (m.catchStyle) o.push('catch:' + m.catchStyle); if (m.diveKind) o.push('dive:' + m.diveKind);
        if (m.solver?.gkLayer && m.solver.anticipation) o.push('hands:' + m.solver.anticipation.style);
        o.push('act:' + p.action.type + (m.dive ? '/' + m.dive.stage : '') + '@' + a.session.match.phase);
        return o;
      });
      r.forEach((k) => { if (!seen.includes(k)) seen.push(k); });
      await sleep(100);
    }
    const ev = await page.evaluate(() => window.__elevens.session.match.ball.state);
    console.log(`shot z ${z} y ${y} v ${sp}: ${ok} -> ${seen.join(' ')} (ball ${ev})`);
    await page.screenshot({ path: `${OUT}gk-live-${z}-${y}.png` });
    // Restore play if a restart started.
    await page.evaluate(() => { const m = window.__elevens.session.match; if (m.ball.state === 'held') {} });
    for (let i = 0; i < 40; i++) { if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') break; await page.keyboard.down('KeyL'); await sleep(300); await page.keyboard.up('KeyL'); await sleep(300); }
  }
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
