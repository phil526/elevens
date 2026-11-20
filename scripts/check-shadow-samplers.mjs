// Check: at High, every material that reads the sun's shadow map uses a shadow sampler (sampler2DShadow).
// A plain sampler2D on the compare-mode depth texture is refused by Chrome on Windows (Direct3D), which
// drew the whole match black (20 Nov 2026). Usage: npm run build && CHROMIUM_PATH=... node scripts/check-shadow-samplers.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const PORT = 8812, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
try {
  for (const preset of ['high', 'ultra', 'medium']) {
    const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
    await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 0.5, shadows: true } })), preset);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.evaluate(() => document.querySelector('[data-a=quick]').click());
    await page.waitForFunction(() => window.__elevens?.screenName === 'match', null, { timeout: 120000 });
    await sleep(4000);
    const r = await page.evaluate(() => {
      const R = window.__elevens.renderer.renderer; const gl = R.getContext(); let plain = 0, shadow = 0;
      for (const p of R.info.programs) {
        const prog = p.program; const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(prog, i); if (!u.name.startsWith('directionalShadowMap')) continue; if (u.type === gl.SAMPLER_2D_SHADOW) shadow++; else plain++; }
      }
      return { plain, shadow, type: R.shadowMap.type };
    });
    const ok = r.plain === 0 && r.shadow > 0;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${preset}: ${r.shadow} shadow samplers, ${r.plain} plain (shadowMap.type ${r.type})`);
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); }
process.exit(fails ? 1 : 0);
