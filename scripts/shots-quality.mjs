// Screenshots the same match moment at each graphics preset and records fps.
// Usage: npm run build && node scripts/shots-quality.mjs
// Headless Chromium renders WebGL in software (SwiftShader): the fps figures
// are only useful for comparing presets with each other on this machine.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const result = { renderer: 'headless Chromium, SwiftShader software WebGL, 1280x720, DPR 1', presets: {}, errors: [] };
try {
  for (const preset of ['low', 'medium', 'high', 'ultra']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), preset);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => result.errors.push(`${preset}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') result.errors.push(`${preset}: ${m.text()}`); });
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]');
    await page.click('[data-a=next]');
    await page.click('[data-a=go]');
    for (let i = 0; i < 100; i++) { const ph = await page.evaluate(() => window.__elevens?.session?.view()?.phase); if (ph === 'kickoff') break; await sleep(200); }
    await sleep(2500);
    await page.screenshot({ path: `${OUT}quality-${preset}.png` });
    await sleep(3000);
    const info = await page.evaluate(() => window.__elevens.renderer.info());
    result.presets[preset] = { fps: Number((await page.evaluate(() => window.__elevens.fps)).toFixed(1)), drawCalls: info.calls, triangles: info.tris };
    console.log(preset, result.presets[preset]);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'quality-report.json', JSON.stringify(result, null, 2));
  console.log('errors', result.errors);
}
