// Screenshots of the stadium and crowd from six fixed views (broadcast, aerial, close-ups,
// each end before and after a goal) and the crowd's head-count and triangle cost.
// Usage: npm run build && node scripts/shots-crowd.mjs [preset]
// Headless Chromium renders WebGL in software (SwiftShader): look, not speed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const preset = process.argv[2] ?? 'high';
const PORT = 8796, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true }, camera: { height: 'high', zoom: 'far', reducedMotion: false } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  await sleep(3000);
  const people = await page.evaluate(() => { let n = 0, tris = 0; window.__elevens.renderer.scene.traverse((o) => { if (o.isInstancedMesh && o.geometry.attributes.aInfo) { n += o.count; tris += o.count * (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } }); return { people: n, crowdTriangles: tris }; });
  console.log(preset, people);
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = p ? { pos: p, look: l } : null; }, [pos, look]);
  const shot = async (name, ms = 1500) => { await sleep(ms); await page.screenshot({ path: `${OUT}crowd-${preset}-${name}.png` }); };
  await shot('1-broadcast');
  await view([0, 75, 120], [0, 0, -5]); await shot('2-aerial');
  await view([-15, 10, 8], [-15, 14, -60]); await shot('3-far-stand-close');
  await view([-25, 9, 0], [-64, 9, 0]); await shot('4-home-end-quiet');
  // Home goal: home supporters (the -x end) celebrate.
  await page.evaluate(() => { window.__elevens.session.match.score[0] += 1; });
  // Software rendering manages about one frame a second here, so give the crowd time to react.
  await shot('5-home-end-goal', 9000);
  await view([-15, 10, 8], [-15, 14, -60]); await shot('6-far-stand-goal');
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
