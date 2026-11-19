// Screenshots of set pieces in a real match (realistic players): an AI throw-in, free kick and
// goal kick, each followed by a close camera as the taker holds/runs up and plays the ball.
// Usage: npm run build && node scripts/shots-setpieces.mjs   (writes scripts/out/setpiece-*.png)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8812, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'medium', renderScale: 1, shadows: true, players: 'realistic' } })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await page.waitForFunction(() => window.__elevens?.session?.match?.phase === 'play' || window.__elevens?.session?.match?.phase === 'kickoff', null, { timeout: 60000 });
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await page.keyboard.down('KeyJ'); await sleep(300); await page.keyboard.up('KeyJ');
  await page.waitForFunction(() => window.__elevens.session.match.phase === 'play', null, { timeout: 60000 });
  const scenes = [
    ['throwin', (m, t) => ({ x: 10, z: 34 })],
    ['freekick', (m, t) => ({ x: m.attackDir(t) * 30, z: 8 })],
    ['goalkick', (m, t) => m.goalKickSpot(t, 1)],
  ];
  for (const [type] of scenes) {
    await page.evaluate((type) => {
      const m = window.__elevens.session.match; const t = 1 - window.__elevens.session.localTeams[0];
      const spot = type === 'throwin' ? { x: 10, z: 34 } : type === 'freekick' ? { x: m.attackDir(t) * 30, z: 8 } : m.goalKickSpot(t, 1);
      m.award(type, t, spot);
    }, type);
    // Follow the taker with a close camera until the ball is played.
    let shot = 0, played = false;
    for (let i = 0; i < 200 && shot < 8; i++) {
      const st = await page.evaluate(() => {
        const s = window.__elevens.session, m = s.match, r = m.restart, R = window.__elevens.renderer;
        if (!r) return { done: true };
        const p = m.players[r.taker];
        const f = Math.cos(p.facing), g = Math.sin(p.facing);
        R.viewOverride = { pos: [r.spot.x - f * 3 + g * 6.5, 2.0, r.spot.z - g * 3 - f * 6.5], look: [r.spot.x - f * 1.2, 1.1, r.spot.z - g * 1.2] };
        return { ready: r.ready, a: p.action.type, runup: !!r.runup, t: m.time, readyT: r.readyT };
      });
      if (st.done) { played = true; break; }
      if (st.ready) { await page.screenshot({ path: `${OUT}setpiece-${type}-${shot}.png` }); shot++; }
      await sleep(st.ready ? 500 : 300);
    }
    console.log(type, 'shots', shot, 'played', played);
    await page.evaluate(() => { window.__elevens.renderer.viewOverride = null; });
    await page.waitForFunction(() => !window.__elevens.session.match.restart, null, { timeout: 60000 }).catch(() => {});
  }
} finally {
  await browser.close();
  server.kill();
}
