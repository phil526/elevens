// Frame rate with Sharper picture On and Off (render/sharp.ts), phone-sized, during play.
// Software rendering: only useful to compare the two on the same machine (it draws pixels on the
// CPU, so it exaggerates the cost of a full-screen pass compared with a phone's GPU).
// Usage: npm run build && node scripts/perf-sharp.mjs [preset] [weather]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const preset = process.argv[2] ?? 'low', weather = process.argv[3] ?? 'clear';
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const out = {};
try {
  for (const round of [0, 1]) for (const on of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 915, height: 412 }, deviceScaleFactor: 2.6, hasTouch: true });
    await ctx.addInitScript(([p, s, w]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: p !== 'low', players: 'realistic', matchTime: 'night', weather: w, autoRes: false, sharpen: s }, matchIntro: false, tvGraphics: false })), [preset, on, weather]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?test${weather !== 'clear' ? `&weather=${weather}` : ''}`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
    for (let i = 0; i < 150; i++) { const ph = await page.evaluate(() => window.__elevens?.session?.view()?.phase); if (ph === 'kickoff' || ph === 'play') break; await sleep(200); }
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
    await page.evaluate(() => { window.__elevens.session.match.cfg.humans = [false, false]; });
    await sleep(5000);
    const fps = [];
    for (let i = 0; i < 5; i++) { await sleep(2000); fps.push(await page.evaluate(() => window.__elevens.fps)); }
    const k = `${on ? 'on' : 'off'}`;
    (out[k] ??= []).push(...fps);
    console.log(round, k, fps.map((f) => f.toFixed(2)).join(' '), await page.evaluate(() => `${window.__elevens.renderer.renderer.domElement.width}x${window.__elevens.renderer.renderer.domElement.height}`));
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); }
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`${preset} ${weather}: sharpen off ${avg(out.off).toFixed(2)} fps, on ${avg(out.on).toFixed(2)} fps (${((avg(out.on) / avg(out.off) - 1) * 100).toFixed(1)}%)`);
