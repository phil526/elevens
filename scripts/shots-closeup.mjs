// Close-ups that follow players (hair, shirts, crests): the camera rides beside each one.
// Usage: npm run build && node scripts/shots-closeup.mjs [outdir] [preset]   (IDS="18,20", WAIT=8000, SIDE=1.6, QUERY="&ground=kestrel")
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/closeup/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'high';
const PORT = +(process.env.PORT ?? 8812), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' } })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test${process.env.QUERY ?? ''}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  if (!process.env.NOKICK) { await page.keyboard.down('j'); await sleep(300); await page.keyboard.up('j'); }
  await sleep(+(process.env.WAIT ?? 8000));
  await page.evaluate(([a, b]) => { window.__camY = a; window.__lookY = b; }, [process.env.CAMY ?? 1.55, process.env.LOOKY ?? 1.35]);
  for (const id of (process.env.IDS ?? '18,3').split(',').map(Number)) {
    for (const [k, ang] of [['side', 1.3], ['back', 3.1], ['front', 0]]) {
      await page.evaluate(([id, ang, side]) => {
        const app = window.__elevens;
        clearInterval(window.__follow);
        window.__follow = setInterval(() => {
          const p = app.session.view().players[id];
          const f = p.facing + ang;
          app.renderer.viewOverride = { pos: [p.pos.x + Math.cos(f) * side, +(window.__camY ?? 1.55), p.pos.z + Math.sin(f) * side], look: [p.pos.x, +(window.__lookY ?? 1.35), p.pos.z] };
        }, 16);
      }, [id, ang, +(process.env.SIDE ?? 1.8)]);
      await sleep(900);
      await page.screenshot({ path: `${OUT}p${id}-${k}.png`, timeout: 180000 });
    }
  }
} finally { await browser.close(); server.kill(); if (errors.length) console.log('errors', errors.slice(0, 10)); }
