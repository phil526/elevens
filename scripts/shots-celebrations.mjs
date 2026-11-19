// Goal celebrations: each kind staged after a goal (raised through a match event), three stills each.
// Usage: npm run build && node scripts/shots-celebrations.mjs [outdir] [preset]   (KINDS="kneeSlide,badgeKiss,...", default all ten)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/celebrations/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'medium';
const PORT = +(process.env.PORT ?? 8816), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], checks = [];
const check = (name, ok, extra = '') => { checks.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: +(globalThis.RS ?? 1), shadows: true, matchTime: 'day', weather: 'clear' }, matchIntro: false, tvGraphics: false })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(120); } return null; };
  await page.goto(`${BASE}/?test&cine`);
  await page.addStyleTag({ content: '.cine-fade{display:none!important}' });
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  await sleep(600);
  await page.keyboard.down('KeyJ'); await sleep(250); await page.keyboard.up('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await sleep(4000);
  for (const kind of (process.env.KINDS ?? 'kneeSlide,badgeKiss,huddle,cheer,aeroplane,kneelSky,cupEar,pointCrowd,dance,bow').split(',')) {
    await M((k) => { const a = window.__elevens; a.cine.nextCeleb = k; const m = a.session.match; const p = m.players[9]; m.ball.pos.x = 52.6; m.ball.pos.z = 1; p.pos.x = 40; p.pos.z = 8; m.emit('goal', { team: 0, player: 9 }); }, kind);
    const on = await waitFor(() => window.__elevens.cine.mode === 'celebration', 90000);
    check(`${kind}: the celebration starts after the goal`, !!on);
    const plan = await M(() => { const c = window.__elevens.cine.celebration; return c ? `${c.kind} scorer ${c.scorer} mates ${c.mates.length}` : 'none'; });
    check(`${kind}: planned`, plan.startsWith(kind), plan);
    for (const [i, at] of [[1, 1.1], [2, 3.0], [3, 5.0]]) {
      await waitFor((t) => (window.__elevens.cine.celebT ?? 0) >= t || window.__elevens.cine.mode !== 'celebration', 150000, at);
      await page.screenshot({ path: `${OUT}${kind}-${i}.png`, timeout: 120000 });
    }
    const replay = await waitFor(() => window.__elevens.cine.mode === 'replay', 150000);
    check(`${kind}: the net-cam replay follows`, !!replay);
    await page.keyboard.down('Space'); await sleep(250); await page.keyboard.up('Space');
    await waitFor(() => window.__elevens.cine.mode === 'none', 10000);
    await sleep(2500);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
