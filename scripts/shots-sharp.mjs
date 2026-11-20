// Sharper picture (render/sharp.ts): the same kick-off view with Settings "Sharper picture" On and Off.
// Usage: npm run build && node scripts/shots-sharp.mjs <outdir> [presets] [query]
//   presets: comma list (default low,medium,high). PHONE=1 emulates a phone-sized window (915x412 at 2.6x).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = (process.argv[2] ?? new URL('./out/sharp/', import.meta.url).pathname).replace(/\/?$/, '/'); mkdirSync(OUT, { recursive: true });
const presets = (process.argv[3] ?? 'low,medium,high').split(',');
const query = process.argv[4] ?? '';
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { errors: [], info: {}, checks: [] };
const phone = !!process.env.PHONE;
try {
  for (const preset of presets) {
    for (const on of [false, true]) {
      const tag = `${preset}-${on ? 'on' : 'off'}${phone ? '-phone' : ''}`;
      const ctx = await browser.newContext(phone ? { viewport: { width: 915, height: 412 }, deviceScaleFactor: 2.6, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
      await ctx.addInitScript(([p, s]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'dusk', players: 'realistic', autoRes: false, sharpen: s }, matchIntro: false, tvGraphics: false })), [preset, on]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => report.errors.push(`${tag}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${tag}: ${m.text()}`); });
      await page.goto(`${BASE}/?test&sharp${query}`);
      await page.waitForSelector('[data-a=quick]');
      await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
      for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
      for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
      await sleep(1500);
      // A fixed view: the centre circle and the players lined up, from the broadcast side.
      await page.evaluate(() => { window.__elevens.renderer.viewOverride = { pos: [0, 9, 26], look: [0, 0.8, 0] }; });
      await sleep(2500);
      const frames0 = await page.evaluate(() => window.__elevens.renderer.sharp.frames);
      await page.screenshot({ path: `${OUT}${tag}.png`, timeout: 120000 });
      const st = await page.evaluate(() => ({ frames: window.__elevens.renderer.sharp.frames, strength: window.__elevens.renderer.sharp.strength, dpr: window.__elevens.renderer.renderer.getPixelRatio(), grade: window.__elevens.renderer.grade?.uniforms.uSharp.value ?? null }));
      report.info[tag] = st;
      if (preset !== 'high' && preset !== 'ultra') report.checks.push({ name: `${tag}: pass ${on ? 'used' : 'not used'}`, ok: on ? st.frames > frames0 : st.frames === 0 });
      else report.checks.push({ name: `${tag}: grade sharpen ${on ? '> 0' : '= 0'}`, ok: on ? st.grade > 0 : st.grade === 0 });
      await ctx.close();
    }
  }
} catch (e) { report.errors.push(String(e?.stack ?? e)); }
await browser.close(); server.kill();
writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
const fails = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify(report, null, 2));
console.log(`${report.checks.length - fails.length}/${report.checks.length} checks passed, ${report.errors.length} errors`);
process.exit(fails.length || report.errors.length ? 1 : 0);
