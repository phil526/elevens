// Frame rate at Medium (the iPad default) with realistic players, during play at night.
// Software rendering: only useful to compare two builds on the same machine.
// Usage: npm run build && node scripts/perf-medium.mjs [preset]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const preset = process.argv[2] ?? 'medium';
const PORT = 8803, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: false, players: 'realistic', matchTime: 'night', weather: 'clear' }, matchIntro: false })), preset);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { const ph = await page.evaluate(() => window.__elevens?.session?.view()?.phase); if (ph === 'kickoff' || ph === 'play') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await page.evaluate(() => { window.__elevens.session.match.cfg.humans = [false, false]; });
  await sleep(6000);
  const fps = [];
  for (let i = 0; i < 6; i++) { await sleep(2000); fps.push(await page.evaluate(() => window.__elevens.fps)); }
  const info = await page.evaluate(() => window.__elevens.renderer.info());
  console.log(JSON.stringify({ preset, fps: fps.map((f) => +f.toFixed(2)), mean: +(fps.reduce((a, b) => a + b) / fps.length).toFixed(2), ...info }));
} finally { await browser.close(); server.kill(); }
