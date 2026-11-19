// Screenshots comparing the Tracking and Broadcast camera views with play at several spots.
// Usage: npm run build && node scripts/shots-camera.mjs [preset] [width] [height]
// Headless Chromium renders WebGL in software (SwiftShader): look, not speed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const preset = process.argv[2] ?? 'medium';
const W = Number(process.argv[3] ?? 1280), H = Number(process.argv[4] ?? 720);
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const report = { preset, size: [W, H], shots: [] };
// Ball spots: centre, edge of each box, a far corner, the near touchline.
const SPOTS = process.env.SPOTS === 'quick' ? [['centre', 0, 0], ['right-box', 38, 5]] : [['centre', 0, 0], ['right-box', 38, 5], ['left-box', -38, -4], ['far-corner', 50, -30], ['near-touchline', -15, 31]];
try {
  for (const mode of (process.env.MODES ?? 'tracking,broadcast').split(',')) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    await ctx.addInitScript(([p, m]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true }, camera: { mode: m, height: 'standard', zoom: 'standard', reducedMotion: false } })), [preset, mode]);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${mode}: ${m.text()}`); });
    await page.goto(`${BASE}/?test`);
    await page.waitForSelector('[data-a=quick]');
    await page.click('[data-a=offline]');
    await page.click('[data-a=next]');
    await page.click('[data-a=go]');
    for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
    await sleep(3000);
    for (const [name, bx, bz] of SPOTS) {
      // Freeze the match and stage play around the spot: ball loose, a few players nearby.
      await page.evaluate(([x, z]) => {
        const s = window.__elevens.session; s.paused = true;
        const m = s.match; m.phase = 'play'; m.restart = null; m.ball.pos.x = x; m.ball.pos.z = z; m.ball.pos.y = 0.11; m.ball.vel.x = 0; m.ball.vel.z = 0; m.ball.vel.y = 0; m.ball.owner = -1;
        const ps = m.players.filter((p) => p.role !== 'GK').slice(0);
        ps.sort((a, b) => Math.hypot(a.pos.x - x, a.pos.z - z) - Math.hypot(b.pos.x - x, b.pos.z - z));
        ps.slice(0, 6).forEach((p, i) => { p.pos.x = x + Math.cos(i * 1.05) * (3 + i); p.pos.z = z + Math.sin(i * 1.05) * (3 + i); p.vel.x = 0; p.vel.z = 0; });
      }, [bx, bz]);
      // Point the camera at the new spot (as after a restart), then let a few frames render.
      await page.evaluate(() => window.__elevens.renderer.camera.snap(window.__elevens.session.view()));
      await sleep(2500);
      const cam = await page.evaluate(() => { const c = window.__elevens.renderer.camera; return { pos: c.cam.position.toArray().map((v) => +v.toFixed(1)), fov: +c.cam.fov.toFixed(1), yawDeg: +(c.inputYaw * 180 / Math.PI).toFixed(1) }; });
      const file = `camera-${mode}-${name}.png`;
      await page.screenshot({ path: OUT + file });
      report.shots.push({ mode, spot: name, ball: [bx, bz], ...cam, file });
      console.log(mode, name, JSON.stringify(cam));
    }
    // Input check: in broadcast at the right box, holding D should move the player towards screen-right.
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
  report.errors = errors;
  writeFileSync(OUT + 'camera-report.json', JSON.stringify(report, null, 2));
  console.log('errors', errors);
}
