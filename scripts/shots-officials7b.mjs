// Close-ups of the referee showing a card and an assistant flagging (20 Nov 2026), no intro.
// Usage: npm run build && node scripts/shots-officials7b.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = new URL('./out/officials7/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8821, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'medium', renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' }, tvGraphics: false })));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const M = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 300; i++) { if ((await M(() => window.__elevens?.session?.view()?.phase)) === 'play') break; await sleep(300); }
  await sleep(4000);
  await M(() => { window.__elevens.session.paused = true; });
  const shoot = async (name, i, kind, ev) => {
    await M(([ev]) => { const r = window.__elevens.renderer, v = window.__elevens.session.view(); r.officials.onEvents(v, [ev]); }, [ev]);
    for (let k = 0; k < 8; k++) {
      await M(([i, kind]) => {
        const r = window.__elevens.renderer; const o = r.officials.state[i];
        const fx = Math.cos(o.facing), fz = Math.sin(o.facing);
        r.viewOverride = { pos: [o.x + fx * 5.5 + fz * 1.2, 1.5, o.z + fz * 5.5 - fx * 1.2], look: [o.x, 1.35, o.z] };
      }, [i, kind]);
      await sleep(250);
    }
    console.log(name, JSON.stringify(await M((i) => window.__elevens.renderer.officials.state[i], i)), 'card', await M(() => window.__elevens.renderer.officials.cardShowing));
    await page.screenshot({ path: `${OUT}${name}.png`, timeout: 120000 });
  };
  await shoot('ref-card', 0, 'card', { type: 'card', player: 14, team: 1, text: 'yellow' });
  await shoot('ref-advantage', 0, 'adv', { type: 'advantage', team: 0, text: 'play' });
  await shoot('ar-flag', 1, 'off', { type: 'offside', x: 20, team: 0 });
} finally { await browser.close(); server.kill(); console.log('errors', errors); }
