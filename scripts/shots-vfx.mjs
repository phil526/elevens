// VFX screenshots: each match time at Ultra and Low, a goal-net close-up during a shot, and fps per look.
// Usage: npm run build && node scripts/shots-vfx.mjs [outdir]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/vfx/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const L = 52.5;
const only = process.env.ONLY;
const report = { fps: {}, errors: [] };
const runs = [['ultra', 'day'], ['ultra', 'dusk'], ['ultra', 'night'], ['low', 'dusk'], ['low', 'night'], ['medium', 'night']].filter(([p, t]) => !only || only.split(',').includes(`${p}-${t}`));
try {
  for (const [preset, time] of runs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t } })), [preset, time]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => report.errors.push(`${preset}-${time}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') report.errors.push(`${preset}-${time}: ${m.text()}`); });
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
    for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
    await sleep(5000);
    const tag = `${preset}-${time}`;
    await page.screenshot({ path: `${OUT}${tag}-1-broadcast.png` });
    report.fps[tag] = Number((await page.evaluate(() => window.__elevens.fps)).toFixed(1));
    const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = p ? { pos: p, look: l } : null; }, [pos, look]);
    if (preset !== "medium" && !process.env.QUICK) {
      await view([-L + 9, 1.3, 9], [-L - 1, 1.0, -1]); await sleep(1200);
      await page.screenshot({ path: `${OUT}${tag}-2-goal.png` });
      // Net cloth: side-on view of the back net, then a simulated shot hitting it.
      await view([-L - 4.5, 3.2, 5.5], [-L - 2, 0.9, -0.8]); await sleep(800);
      await page.evaluate(() => { const r = window.__elevens.renderer; const V = (x, y, z) => r.prevBallV.clone().set(x, y, z); for (const n of r.nets) n.touch(V(-54.39, 1.1, -0.8), V(7, 0, 0), V(-28, 0, 0), 0.11); });
      for (let k = 0; k < 3; k++) { await sleep(250); await page.screenshot({ path: `${OUT}${tag}-2b-net-${k}.png` }); }
      // Fire a shot into the top corner and capture the net and trail.
      for (let i = 0; i < 60; i++) { if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') break; await sleep(250); }
      await page.evaluate(() => { const m = window.__elevens.session.match; m.players.forEach((p) => { if (Math.abs(p.pos.x) > 40) p.pos.x = Math.sign(p.pos.x) * 30; }); const b = m.ball; b.owner = -1; b.state = 'flight'; b.flight = 'shot'; b.lastTouch = -1; b.spin = 0; b.pos = { x: -34, y: 0.4, z: 4 }; b.vel = { x: -30, y: 3.2, z: -1.3 }; });
      for (let k = 0; k < 6; k++) { await sleep(110); await page.screenshot({ path: `${OUT}${tag}-3-shot-${k}.png` }); }
    }
    await ctx.close();
  }
} finally { await browser.close(); server.kill(); writeFileSync(OUT + 'vfx-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
