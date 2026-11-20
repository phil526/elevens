// Night rain High, broadcast camera: screenshot with each wet/haze effect turned off in turn.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const preset = process.env.PRESET ?? 'high', time = process.env.MT ?? 'night', weather = process.env.W ?? 'rain';
const PORT = 8000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t, players: 'classic' } })), [preset, time]);
const page = await ctx.newPage();
await page.goto(`${BASE}/?test&weather=${weather}`);
await page.waitForSelector('[data-a=quick]');
await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
await page.evaluate(() => { const fx = window.__elevens.renderer.weatherFx; fx.cover = 1; });
await sleep(4000);
if (process.env.DUMP) {
  const data = await page.evaluate(() => {
    const r = window.__elevens.renderer; const t = r.wet.target; const w = t.width, h = t.height;
    const buf = new Uint16Array(w * h * 4); r.renderer.readRenderTargetPixels(t, 0, 0, w, h, buf);
    const f = (x) => { const s = (x & 0x8000) ? -1 : 1, e = (x >> 10) & 31, m = x & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? 65504 : s * (1 + m / 1024) * 2 ** (e - 15); };
    const out = []; for (let i = 0; i < w * h * 4; i++) out.push(Math.max(0, Math.min(255, Math.round(Math.pow(Math.max(0, f(buf[i])), 1 / 2.2) * 255))));
    return { w, h, px: out };
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT + '/refl.json', JSON.stringify(data));
  console.log('dumped', data.w, data.h);
}
const steps = (process.env.STEPS ?? 'base,nohaze,noglint,norefl,noweather').split(',');
for (const s of steps) {
  await page.evaluate((s) => {
    const r = window.__elevens.renderer;
    window.__iso = window.__iso || setInterval(() => {}, 1000);
    const k = window.__isoState = window.__isoState || {};
    k.s = s;
    if (!window.__isoHooked) {
      window.__isoHooked = true;
      const orig = r.renderer.render.bind(r.renderer);
      r.renderer.render = (sc, c) => {
        const st = window.__isoState.s;
        if (st.includes('nohaze')) r.haze.mesh.visible = false;
        if (st.includes('noglint') && r.grassU.uGlint) r.grassU.uGlint.value = 0;
        if (st.includes('norefl') && r.grassU.uReflOn) r.grassU.uReflOn.value = 0;
        if (st.includes('noweather')) r.weatherFx.group.visible = false;
        return orig(sc, c);
      };
    }
  }, s);
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/${s}.png` });
  console.log('shot', s);
}
await browser.close(); server.kill();
