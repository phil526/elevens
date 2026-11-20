// Browser check of the built game: goal kicks and a keeper holding the ball, with opponents
// placed in the box. Usage: npm run build && node scripts/check-goalkick.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8811, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 1, shadows: false, players: 'classic' } })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await page.waitForFunction(() => window.__elevens?.session?.match?.phase === 'kickoff' || window.__elevens?.session?.match?.phase === 'play', null, { timeout: 30000 });
  await sleep(1500);
  await page.keyboard.down('KeyJ'); await sleep(300); await page.keyboard.up('KeyJ');
  await page.waitForFunction(() => window.__elevens.session.match.phase === 'play', null, { timeout: 30000 });
  const inBox = () => page.evaluate(() => {
    const m = window.__elevens.session.match; const team = m.__gkTeam;
    return m.teamPlayers(1 - team).filter((p) => !p.off && m.inPenaltyArea(team, p.pos)).map((p) => p.role);
  });
  for (const scene of ['goalkick', 'held']) {
    await page.evaluate((scene) => {
      const m = window.__elevens.session.match; const team = window.__elevens.session.localTeams[0];
      m.__gkTeam = team;
      const gx = m.ownGoalX(team), dir = m.attackDir(team), gk = m.keeper(team);
      for (const p of m.teamPlayers(1 - team).filter((p) => p.role !== 'GK').slice(0, 4).map((p, i) => [p, i])) { p[0].pos = { x: gx + dir * (3 + p[1] * 3), z: -6 + p[1] * 4 }; p[0].vel = { x: 0, z: 0 }; }
      if (scene === 'goalkick') m.award('goalkick', team, m.goalKickSpot(team, 1));
      else { gk.pos = { x: gx + dir * 4, z: 0 }; const b = m.ball; b.state = 'held'; b.owner = gk.id; b.lastTouch = gk.id; b.lastTouchTeam = team; b.flight = 'none'; m.holdT = 0; }
    }, scene);
    const before = await inBox();
    await page.screenshot({ path: OUT + `goalkick-${scene}-start.png` });
    // Wait 2.5 s of match time (software rendering runs slowly).
    const t0 = await page.evaluate(() => window.__elevens.session.match.time);
    await page.waitForFunction((t0) => window.__elevens.session.match.time > t0 + 2.6, t0, { timeout: 90000 });
    const st = await page.evaluate(() => { const m = window.__elevens.session.match; return { phase: m.phase, ready: m.restart?.ready, ball: m.ball.state }; });
    const after = await inBox();
    await page.screenshot({ path: OUT + `goalkick-${scene}-after.png` });
    const ok = after.length === 0 && (scene === 'held' ? st.ball === 'held' : st.ready);
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scene}: in the box at start ${JSON.stringify(before)}, after 2.6 s ${JSON.stringify(after)} ${JSON.stringify(st)}`);
    if (scene === 'goalkick') { await page.keyboard.down('KeyK'); await sleep(400); await page.keyboard.up('KeyK'); await page.waitForFunction(() => window.__elevens.session.match.phase === 'play', null, { timeout: 60000 }).catch(() => {}); }
  }
} finally { await browser.close(); server.kill(); }
process.exit(fails ? 1 : 0);
