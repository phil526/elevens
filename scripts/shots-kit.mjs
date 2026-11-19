// Close-ups of kit detail and body variety at kick-off: names and numbers, shorts numbers,
// the captain's armband, keeper gloves, boots, and team-mates side by side.
// Usage: npm run build && node scripts/shots-kit.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'high';
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: 'realistic', matchTime: 'day' } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[players]')) errors.push(m.text()); });
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await sleep(1500);
  // Freeze play and line six home players up across the pitch for a side-by-side.
  await page.evaluate(() => {
    const s = window.__elevens.session; s.paused = true;
    const m = s.match;
    const ids = [0, 3, 4, 9, 8, 10];
    ids.forEach((id, k) => { const p = m.players[id]; p.pos = { x: -6 + k * 1.3, z: 10 }; p.vel = { x: 0, z: 0 }; p.facing = Math.PI / 2; p.action = { type: 'none', t: 0, dur: 0 }; });
  });
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = { pos: p, look: l }; }, [pos, look]);
  const shot = async (name) => { await sleep(1800); await page.screenshot({ path: `${OUT}kit-${name}.png` }); };
  await view([-2.75, 1.25, 17.5], [-2.75, 0.95, 10]); await shot('1-lineup-front');
  await view([-2.75, 1.45, 3.5], [-2.75, 1.05, 10]); await shot('2-lineup-back');
  await view([-6, 1.2, 12.2], [-6, 0.9, 10]); await shot('3-keeper-close');
  const cap = await page.evaluate(() => window.__elevens.renderer.players.findIndex((p) => p.model && p.model.getObjectByName('LeftArm')?.children.some((c) => c.geometry?.type === 'CylinderGeometry')));
  if (cap >= 0) {
    await page.evaluate((id) => { const p = window.__elevens.session.match.players[id]; p.pos = { x: 4, z: 10 }; p.facing = Math.PI / 2; }, cap);
    await view([5.2, 1.4, 11.6], [4, 1.25, 10]); await shot('4-captain');
  } else errors.push('no captain armband found');
  await view([-4, 0.5, 11.8], [-4, 0.15, 10]); await shot('5-boots');
  // In play: resume and follow the match with the normal camera, then a close tracking shot.
  await page.evaluate(() => { const s = window.__elevens.session; s.paused = false; window.__elevens.renderer.viewOverride = null; });
  await sleep(9000); await page.screenshot({ path: `${OUT}kit-7-in-play.png` });
  const b = await page.evaluate(() => window.__elevens.session.view().ball.pos);
  await view([b.x + 4, 2.2, b.z + 7], [b.x, 0.9, b.z]); await shot('8-in-play-close');
  await view([-2.75, 1.0, 11.6], [-2.75, 0.8, 10]); await shot('6-shorts');
} finally { await browser.close(); server.kill(); console.log('errors', JSON.stringify(errors)); }
