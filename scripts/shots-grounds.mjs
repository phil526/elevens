// Club grounds: the same views of several clubs' grounds (?ground=<club id> builds that ground).
// Usage: npm run build && node scripts/shots-grounds.mjs [outdir] [preset] [time]   (GROUNDS="redmoor,kingsmere", VIEWS="wide,high")
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/grounds/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'high', TIME = process.argv[4] ?? 'dusk';
const PORT = 8811, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ALL = {
  broadcast: null,
  high: [[70, 70, 95], [0, 0, -5]],
  far: [[0, 9, 30], [0, 14, -60]],
  end: [[-25, 7, 8], [-75, 12, -6]],
  corner: [[38, 10, 24], [62, 16, -32]],
};
const grounds = (process.env.GROUNDS ?? 'redmoor,kingsmere,ironbridge,harrowfield,portcalder,highmarsh').split(',');
const views = (process.env.VIEWS ?? 'broadcast,high,far,end').split(',');
const errors = [];
try {
  for (const g of grounds) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t, ...(globalThis.GFX ?? {}) } })), [PRESET, TIME]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${g}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${g}: ${m.text()}`); });
    await page.goto(`${BASE}/?test&ground=${g}${process.env.QUERY ?? ''}`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
    for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
    await sleep(3000);
    for (const n of views) {
      await page.evaluate((v) => { window.__elevens.renderer.viewOverride = v ? { pos: v[0], look: v[1] } : null; }, ALL[n]);
      await sleep(1500);
      await page.screenshot({ path: `${OUT}${g}-${n}.png`, timeout: 180000 });
    }
    console.log(g, await page.evaluate(() => { const a = window.__elevens.renderer.stadium?.userData.arena; return a ? `${a.ground.name} size ${a.ground.size} fans ${a.crowdCount} flags ${a.flagpoles.length}` : 'no arena'; }));
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); if (errors.length) console.log('errors', errors); }
