// Face and body close-ups of the realistic players at kick-off (skin, hair, faces, kit wear).
// Usage: npm run build && node scripts/shots-faces.mjs [outdir] [tag] [extra query]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const tag = process.argv[3] ?? 'faces';
const extra = process.argv[4] ?? '';
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'high', renderScale: 1, shadows: true, players: 'realistic', matchTime: 'day' } })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test${extra}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await sleep(1500);
  // Six players of different bodies in a row, facing the camera.
  const ids = [1, 3, 4, 9, 8, 10, 13, 15, 19, 20];
  await page.evaluate((ids) => {
    const s = window.__elevens.session; s.paused = true;
    const m = s.match;
    ids.forEach((id, k) => { const p = m.players[id]; p.pos = { x: -6 + k * 1.1, z: 10 }; p.vel = { x: 0, z: 0 }; p.facing = Math.PI / 2; p.action = { type: 'none', t: 0, dur: 0 }; });
    m.ball.pos = { x: -1, y: 0.11, z: 14 };
  }, ids);
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = { pos: p, look: l }; }, [pos, look]);
  const shot = async (name) => { await sleep(1800); await page.screenshot({ path: `${OUT}${tag}-${name}.png` }); };
  for (let k = 0; k < 4; k++) { const x = -6 + k * 1.1; await view([x, 1.62, 11.3], [x, 1.58, 10]); await shot(`face${k}`); }
  await view([-3.5, 1.3, 15], [-3.5, 1.0, 10]); await shot('row');
  await view([-5.0, 1.7, 8.8], [-5.0, 1.6, 10]); await shot('back');
  // Late in the match: sweat, mud from slides and dives, and open mouths (celebrating).
  await page.evaluate((ids) => {
    const s = window.__elevens.session, m = s.match, r = window.__elevens.renderer;
    m.clock = 80 * 60;
    ids.forEach((id, k) => { m.players[id].stamina = 0.3; r.kitWear.get(id).mud = [0.9, 0.5, 0.25, 0.7][k % 4]; r.kitWear.get(id).front = k % 2 ? 0.9 : 0.1; });
    [1, 4].forEach((id) => { m.players[id].action = { type: 'celebrate', t: 0, dur: 30 }; });
  }, ids);
  await view([-3.5, 1.3, 15], [-3.5, 1.0, 10]); await shot('late-row');
  await view([-5.0, 1.5, 7.5], [-5.0, 1.0, 10]); await shot('late-back');
  for (const k of [0, 2]) { const x = -6 + k * 1.1; await view([x, 1.62, 11.3], [x, 1.58, 10]); await shot(`late-face${k}`); }
} finally { await browser.close(); server.kill(); console.log('errors', JSON.stringify(errors)); }
