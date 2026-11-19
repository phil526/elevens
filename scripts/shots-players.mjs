// Close-up screenshots of the realistic player models in a running offline match.
// Usage: npm run build && node scripts/shots-players.mjs [preset] [players=realistic|classic]
// Headless Chromium renders WebGL in software (SwiftShader): look, not speed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const preset = process.argv[2] ?? 'high';
const players = process.argv[3] ?? 'realistic';
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([p, pl]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: pl }, camera: { height: 'standard', zoom: 'near', reducedMotion: false } })), [preset, players]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  await sleep(5000);
  const real = await page.evaluate(() => window.__elevens.renderer.players.filter((p) => p.constructor.name.includes('Real') || p.solver).length);
  console.log(preset, players, 'realistic models in scene:', real);
  console.log(await page.evaluate(() => { const a = window.__elevens.renderer.playerAssets; return a && { bodies: a.bodies.length, clips: Object.fromEntries(Object.entries(a.clips).map(([k, c]) => [k, { dur: +c.clip.duration.toFixed(2), speed: +c.speed.toFixed(2), contact: +c.contact.toFixed(2), backswing: +c.backswing.toFixed(2) }])) }; }));
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = p ? { pos: p, look: l } : null; }, [pos, look]);
  const shot = async (name, ms = 1500) => { await sleep(ms); await page.screenshot({ path: `${OUT}players-${players}-${name}.png` }); };
  const near = async (id, dx, dy, dz) => {
    const p = await page.evaluate((i) => window.__elevens.session.view().players[i].pos, id);
    await view([p.x + dx, 1.2 + dy, p.z + dz], [p.x, 1.0, p.z]);
  };
  const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 6000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(2)); }; requestAnimationFrame(f); }));
  console.log('software fps', fps);
  await shot('1-broadcast');
  await near(9, 2.5, 0.3, 3.5); await shot('2-kickoff-close');
  await near(14, -3, 0.5, -3); await shot('3-away-close');
  await near(0, 4, 0.3, 2); await shot('4-keeper');
  await view(null); await page.keyboard.down('KeyW'); await shot('5-play', 6000); await page.keyboard.up('KeyW');
  const ball = await page.evaluate(() => window.__elevens.session.view().ball.pos);
  await view([ball.x + 6, 3, ball.z + 6], [ball.x, 0.8, ball.z]); await shot('6-action-close', 500);
  await shot('7-action-close-later', 2500);
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
