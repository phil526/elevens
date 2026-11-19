// Late-match look: plays most of a match headless inside the page (feeding the pitch and kit wear),
// then screenshots the pitch, the goalmouth, floodlight shadows and glare at night.
// Usage: npm run build && node scripts/shots-wear.mjs [outdir] [tag] [time day|dusk|night] [weather clear|rain|snow] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const tag = process.argv[3] ?? 'wear', time = process.argv[4] ?? 'night', weather = process.argv[5] ?? 'rain', preset = process.argv[6] ?? 'high';
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([p, t]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: 'realistic', matchTime: t } })), [preset, time]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test&weather=${weather}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  // Most of a match, headless: the AI plays both sides while the wear builds.
  const info = await page.evaluate(() => {
    const app = window.__elevens, s = app.session, r = app.renderer, m = s.match;
    s.paused = true;
    m.cfg.humans = [false, false];
    r.weatherFx.cover = r.weather === 'clear' ? 0 : 0.9;
    const wet = r.weather === 'rain' ? 0.9 : 0;
    let n = 0;
    while (n < 60 * 60 * 5 && m.phase !== 'fulltime') {
      if (m.phase === 'halftime') m.continueAfterHalftime();
      m.step();
      s.builder.capture();
      const v = s.builder.build(1);
      r.pitchWear.update(v, 1 / 60, wet);
      r.kitWear.update(v, 1 / 60, wet, r.pitchWear);
      n++;
    }
    m.drainEvents();
    return { n, clock: m.displayClock, phase: m.phase, weather: r.weather };
  });
  console.log(JSON.stringify(info));
  await page.evaluate(() => { const s = window.__elevens.session; s.paused = false; });
  await sleep(4000);
  await page.screenshot({ path: `${OUT}${tag}-1-broadcast.png` });
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = { pos: p, look: l }; }, [pos, look]);
  await page.evaluate(() => { window.__elevens.session.paused = true; });
  if (process.env.HIDE) await page.evaluate((names) => { const r = window.__elevens.renderer; for (const n of names.split(',')) { const o = n === 'glare' ? r.glare.group : n === 'weather' ? r.weatherFx.group : n === 'particles' ? r.particles.points : null; if (o) { o.visible = false; o.onBeforeRender = () => {}; } if (n === 'halos') r.halos.forEach((h) => (h.visible = false)); } }, process.env.HIDE);
  await view([-40, 9, 14], [-52, 0, 0]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-2-goalmouth.png` });
  await view([0, 30, 50], [0, 0, 0]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-3-high.png` });
  // Players close up with their four shadows, then a low shot towards a floodlight mast.
  const p0 = await page.evaluate(() => window.__elevens.session.view().players[5].pos);
  await view([p0.x + 6, 5, p0.z + 8], [p0.x, 0.5, p0.z]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-4-shadows.png` });
  await view([10, 6, 10], [74.5, 40, 60]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-5-glare.png` });
  await view([-10, 12, 40], [-30, 25, -60]); await sleep(1500); await page.screenshot({ path: `${OUT}${tag}-6-glare2.png` });
} finally { await browser.close(); server.kill(); console.log('errors', JSON.stringify(errors)); }
