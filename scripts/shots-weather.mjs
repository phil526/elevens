// Weather and broadcast-graphics screenshots. Usage: npm run build && node scripts/shots-weather.mjs [outdir]
// RUNS="ultra-night-rain,low-dusk-snow" picks runs; each is preset-time-weather.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/weather/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { fps: {}, errors: [] };
const runs = (process.env.RUNS ?? 'high-night-rain,high-day-snow,low-dusk-rain').split(',').map((r) => r.split('-'));
const extra = process.env.EXTRA ?? '';
try {
  for (const [preset, time, weather] of runs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t, players: 'classic' } })), [preset, time]);
    const page = await ctx.newPage();
    const tag = `${preset}-${time}-${weather}`;
    page.on('pageerror', (e) => report.errors.push(`${tag}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${tag}: ${m.text()}`); });
    await page.goto(`${BASE}/?test&weather=${weather}${extra}`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
    for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
    // Fast-forward the pitch cover (rain soaks, snow settles) so one still shows the full effect.
    await page.evaluate(() => { const fx = window.__elevens.renderer.weatherFx; fx.cover = 1; });
    await sleep(Number(process.env.WAIT ?? 4000));
    await page.screenshot({ path: `${OUT}${tag}-1.png` });
    report.fps[tag] = Number((await page.evaluate(() => window.__elevens.fps)).toFixed(1));
    if (!process.env.QUICK) {
      await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [-30, 1.6, 20], look: [-52, 0.5, -5] }; });
      await sleep(1500);
      await page.screenshot({ path: `${OUT}${tag}-2-low.png` });
    }
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
