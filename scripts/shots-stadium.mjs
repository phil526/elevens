// Stadium screenshots: broadcast view plus fixed views of the bowl, tunnel, boards and a goal takeover.
// Usage: npm run build && node scripts/shots-stadium.mjs [outdir]   (RUNS="ultra-night,medium-dusk")
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/stadium/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { fps: {}, errors: [] };
const runs = (process.env.RUNS ?? 'ultra-dusk,ultra-night,ultra-day,high-dusk,medium-dusk,low-dusk').split(',').map((r) => r.split('-'));
const VIEWS = {
  wide: [[0, 30, 72], [0, 4, -10]],
  tunnel: [[0, 5, -14], [0, 3, -44]],
  corner: [[40, 9, 26], [62, 14, -30]],
  end: [[-20, 6, 10], [-70, 12, -4]],
};
try {
  for (const [preset, time] of runs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t } })), [preset, time]);
    const page = await ctx.newPage();
    const tag = `${preset}-${time}`;
    page.on('pageerror', (e) => report.errors.push(`${tag}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${tag}: ${m.text()}`); });
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
    for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
    await sleep(5000);
    await page.screenshot({ path: `${OUT}${tag}-0-broadcast.png`, timeout: 180000 });
    report.fps[tag] = Number((await page.evaluate(() => window.__elevens.fps)).toFixed(1));
    const view = (v) => page.evaluate((v) => { window.__elevens.renderer.viewOverride = v ? { pos: v[0], look: v[1] } : null; }, v);
    const names = process.env.QUICK ? ['wide'] : Object.keys(VIEWS);
    for (const n of names) { await view(VIEWS[n]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-${n}.png`, timeout: 180000 }); }
    if (!process.env.QUICK) {
      // Goal takeover: bump the score so the boards and big screens switch to GOAL!.
      await page.evaluate(() => { window.__elevens.session.match.score[0] += 1; });
      await view(VIEWS.corner); await sleep(1500);
      await page.screenshot({ path: `${OUT}${tag}-goal.png`, timeout: 180000 });
    }
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); writeFileSync(OUT + 'stadium-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
