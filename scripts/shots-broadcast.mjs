// Broadcast graphics, crowd moments and player reactions: screenshots for review.
// Usage: npm run build && node scripts/shots-broadcast.mjs [outdir]   (PRESET=medium PLAYERS=realistic)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/broadcast/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const preset = process.env.PRESET ?? 'medium', players = process.env.PLAYERS ?? 'classic';
const report = { errors: [], checks: {} };
const only = (process.env.ONLY ?? 'lineups,reactions,crowd,l3,stats').split(',');
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([p, pl]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'dusk', players: pl } })), [preset, players]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); });
  await page.goto(`${BASE}/?test&lineups&weather=clear`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  if (players === 'realistic') for (let i = 0; i < 120; i++) { if (await page.evaluate(() => window.__elevens.renderer.playersReal)) break; await sleep(500); }
  const tag = `${preset}-${players}`;
  report.checks.lineupsHolding = await page.evaluate(() => window.__elevens.tv.holding);
  if (only.includes('lineups')) { await sleep(2500); await page.screenshot({ path: `${OUT}${tag}-lineups.png` }); }
  const before = await page.evaluate(() => window.__elevens.session.match.tick);
  await sleep(1000);
  report.checks.pausedDuringLineups = (await page.evaluate(() => window.__elevens.session.match.tick)) === before;
  await page.keyboard.down('Space'); await sleep(400); await page.keyboard.up('Space');
  await sleep(500);
  report.checks.lineupsSkipped = !(await page.evaluate(() => window.__elevens.tv.holding));
  if (only.includes('reactions')) {
    // Line up a row of players near the camera and give each a different reaction.
    const kinds = ['protest', 'appeal', 'headInHands', 'handsOnHips', 'dejected', 'crouch', 'armsUp', 'fistPump', 'highFive', 'clap'];
    await page.evaluate((kinds) => {
      const a = window.__elevens; const m = a.session.match;
      a.session.pause(true);
      kinds.forEach((k, i) => { const p = m.players[1 + i]; p.pos = { x: -9 + i * 2, z: 20 }; p.vel = { x: 0, z: 0 }; p.facing = Math.PI / 2; a.renderer.reactions.add(p.id, k, 60); });
      a.renderer.viewOverride = { pos: [6, 1.8, 31], look: [0, 1.0, 20] };
    }, kinds);
    await sleep(2500);
    await page.screenshot({ path: `${OUT}${tag}-reactions.png` });
    report.checks.reacting = await page.evaluate((kinds) => kinds.map((_, i) => { const r = window.__elevens.renderer; const p = window.__elevens.session.match.players[1 + i]; const s = r.project(p.pos.x, 1, p.pos.z); return `${r.reactions.kindOf(1 + i)}@${Math.round(s.x)}`; }), kinds);
    await page.evaluate(() => { const a = window.__elevens; a.renderer.reactions.reset(); a.renderer.viewOverride = null; a.session.pause(false); });
  }
  if (only.includes('crowd')) {
    await page.evaluate(() => { const r = window.__elevens.renderer; r.crowdMoment('chant', 0); r.crowdMoment('stomp'); r.crowd.trigger('wave'); r.viewOverride = { pos: [-30, 6, 10], look: [-70, 8, 0] }; });
    await sleep(2500);
    await page.screenshot({ path: `${OUT}${tag}-crowd-home.png` });
    await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [0, 12, 20], look: [0, 10, -60] }; });
    await sleep(2000);
    await page.screenshot({ path: `${OUT}${tag}-crowd-wave.png` });
    report.checks.crowd = await page.evaluate(() => window.__elevens.renderer.crowd.state);
    report.checks.flags = await page.evaluate(() => { let n = 0; window.__elevens.renderer.scene.traverse((o) => { if (o.name === 'flags') n = o.count; }); return n; });
    await page.evaluate(() => { window.__elevens.renderer.viewOverride = null; });
  }
  if (only.includes('l3')) {
    await page.evaluate(() => { const a = window.__elevens; const v = a.session.view(); a.tv.l3Queue.push(a.tv.statStrip(v, 15)); a.tv.addTicker(0xc8102e, "⚽ 23' REYES"); });
    await sleep(1500);
    await page.screenshot({ path: `${OUT}${tag}-lowerthird.png` });
  }
  if (only.includes('stats')) {
    await page.evaluate(() => { const a = window.__elevens; const v = a.session.view(); Object.assign(v.stats[0], { shots: 7, onTarget: 3, passes: 210, passesCompleted: 171, possessionTicks: 5800, corners: 4, fouls: 6, tackles: 12, yellows: 1 }); Object.assign(v.stats[1], { shots: 4, onTarget: 2, passes: 160, passesCompleted: 118, possessionTicks: 4200, corners: 2, fouls: 9, tackles: 15, saves: 2 }); a.openHalftime(v); });
    await sleep(800);
    await page.screenshot({ path: `${OUT}${tag}-halftime.png` });
  }
  await ctx.close();
} finally { await browser.close(); server.kill(); writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
