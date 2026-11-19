// Stills of the match intro (stadium fly-in, tunnel walk-out) and the net-cam goal replay.
// Usage: npm run build && node scripts/shots-cine.mjs [preset] [outdir]
// Headless Chromium renders WebGL in software, so the cinematic clock is set directly for each still.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const preset = process.argv[2] ?? 'medium';
const OUT = (process.argv[3] ?? new URL('./out/', import.meta.url).pathname).replace(/\/?$/, '/');
mkdirSync(OUT, { recursive: true });
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const report = { preset, intro: [], replay: [] };
const nextFrames = (page, n = 2) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test&cine`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if (await page.evaluate(() => window.__elevens?.cine?.mode === 'intro')) break; await sleep(200); }
  const only = process.env.ONLY ?? 'intro,replay';
  if (only.includes('intro')) {
    for (const t of (process.env.TIMES ?? '0.7,2,3.4,4.8,5.9,7.2,9,10.8,12.6,13.5').split(',').map(Number)) {
      await page.evaluate((t) => { window.__elevens.cine.t = t; }, t);
      await nextFrames(page, 2);
      await page.evaluate((t) => { window.__elevens.cine.t = t; }, t);
      await nextFrames(page, 1);
      const info = await page.evaluate(() => { const a = window.__elevens; const c = a.renderer.camera.cam; return { mode: a.cine.mode, cam: c.position.toArray().map((v) => +v.toFixed(1)), paused: a.session.paused, phase: a.session.view().phase }; });
      const file = `cine-intro-${String(t).replace('.', '_')}.png`;
      await page.screenshot({ path: OUT + file });
      report.intro.push({ t, file, ...info });
      console.log('intro', t, JSON.stringify(info));
      if (info.mode !== 'intro') break;
    }
    await page.evaluate(() => window.__elevens.cine.skip());
    await nextFrames(page, 3);
    const after = await page.evaluate(() => ({ mode: window.__elevens.cine.mode, paused: window.__elevens.session.paused }));
    report.afterIntro = after;
    console.log('after intro', JSON.stringify(after));
  }
  if (only.includes('replay')) {
    await page.evaluate(() => window.__elevens.cine.skip());
    // Let play run so the recorder has history, then stage a shot that cannot be saved.
    await sleep(4000);
    await page.evaluate(() => {
      const m = window.__elevens.session.match;
      m.phase = 'play'; m.restart = null;
      const gk = m.players.find((p) => p.role === 'GK' && p.team === (m.attackDir(0) > 0 ? 1 : 0));
      gk.pos.x = 30 * Math.sign(m.attackDir(0)); gk.pos.z = 28;
      const d = m.attackDir(0);
      Object.assign(m.ball.pos, { x: 32 * d, y: 0.4, z: -4 }); Object.assign(m.ball.vel, { x: 30 * d, y: 2.2, z: 3.2 });
      m.ball.owner = -1; m.ball.state = 'flight'; m.ball.flight = 'shot'; m.ball.lastTouchTeam = 0; m.ball.lastTouch = m.players.find((p) => p.team === 0 && p.role !== 'GK').id;
    });
    let ok = false;
    for (let i = 0; i < 200; i++) { if (await page.evaluate(() => window.__elevens.cine.mode === 'replay')) { ok = true; break; } await sleep(150); }
    report.replayStarted = ok;
    console.log('replay started', ok, await page.evaluate(() => window.__elevens.session.view().score));
    if (ok) {
      const rp = await page.evaluate(() => { const r = window.__elevens.cine.replay; return { t0: r.t0, t1: r.t1, tg: r.tg }; });
      const total = (rp.t1 - rp.t0) / 0.62;
      for (const k of [0.15, 0.4, 0.6, 0.72, 0.8, 0.9]) {
        const t = total * k;
        await page.evaluate((t) => { window.__elevens.cine.t = t; }, t);
        await nextFrames(page, 2);
        const file = `cine-replay-${Math.round(k * 100)}.png`;
        await page.screenshot({ path: OUT + file });
        const info = await page.evaluate(() => ({ mode: window.__elevens.cine.mode, ball: window.__elevens.renderer.camera.cam.position.toArray().map((v) => +v.toFixed(1)) }));
        report.replay.push({ k, file, ...info });
        console.log('replay', k, JSON.stringify(info));
      }
      await page.evaluate(() => { window.__elevens.cine.t = 999; });
      await nextFrames(page, 3);
      report.afterReplay = await page.evaluate(() => ({ mode: window.__elevens.cine.mode, paused: window.__elevens.session.paused }));
      console.log('after replay', JSON.stringify(report.afterReplay));
    }
  }
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
  report.errors = errors;
  writeFileSync(OUT + 'cine-report.json', JSON.stringify(report, null, 2));
  console.log('errors', errors.length ? errors : 'none');
}
