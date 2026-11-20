// Check the slow-graphics guard (render/slowguard.ts) in the built game.
// 1) A software-drawing browser (this cloud Chromium) starts on the lightest graphics.
// 2) Pretending to have a graphics chip, a slow match (software rendering, ~1-3 fps) lowers the quality on its own.
// Usage: npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check-slowguard.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 8815, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
const check = (name, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? ` (${d})` : ''}`); };
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('elevens.settings.v1') ?? '{}'));
try {
  {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?test&slowguard&menubg`);
    await page.waitForSelector('[data-a=quick]');
    await sleep(3000);
    const s = await saved(page);
    check('software drawing starts on the lightest graphics', s.softwareLow === true && s.graphics?.preset === 'low' && s.graphics?.renderScale <= 0.5 && s.menuBackdrop === false && s.matchIntro === false, JSON.stringify({ preset: s.graphics?.preset, scale: s.graphics?.renderScale, bg: s.menuBackdrop, intro: s.matchIntro }));
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'high', renderScale: 1, shadows: true } }));
      for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
        const real = C.prototype.getParameter;
        C.prototype.getParameter = function (p) { return p === 0x9246 ? 'Pretend GPU Direct3D11' : real.call(this, p); };
      }
    });
    const page = await ctx.newPage();
    const warns = [];
    page.on('console', (m) => { if (m.text().includes('[graphics]')) warns.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/?test&slowguard`);
    await page.waitForSelector('[data-a=quick]');
    await page.evaluate(() => document.querySelector('[data-a=quick]').click());
    await page.waitForFunction(() => window.__elevens?.screenName === 'match', null, { timeout: 180000 });
    let s = {};
    for (let i = 0; i < 40; i++) { await sleep(3000); s = await saved(page); if (s.graphics?.preset === 'low') break; }
    check('a slow match lowers quality on its own', s.graphics?.preset === 'medium' || s.graphics?.preset === 'low', `${s.graphics?.preset}; ${warns.join(' | ').slice(0, 220)}`);
    check('not mistaken for software drawing', !s.softwareLow);
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); }
process.exit(fails ? 1 : 0);
