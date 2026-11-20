// The officials (20 Nov 2026): leading the walk-out, between the teams in the line-up, shaking hands,
// the pre-match huddle, then the referee and assistants in the match and showing a card.
// Usage: npm run build && node scripts/shots-officials7.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/officials7/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'medium';
const PORT = +(process.env.PORT ?? 8819), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], checks = [];
const check = (name, ok, extra = '') => { checks.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' }, tvGraphics: false })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(120); } return null; };
  await page.goto(`${BASE}/?test&cine`);
  await page.addStyleTag({ content: '.cine-fade{display:none!important}' });
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  check('intro starts', await waitFor(() => window.__elevens?.cine?.mode === 'intro', 90000));
  const at = (t) => waitFor((x) => window.__elevens.cine.time >= x || window.__elevens.cine.mode !== 'intro', 300000, t);
  const shots = [['walkout', 9.6], ['walkout2', 11.6], ['line', 15.6], ['shake', 21.8], ['huddle', 31.2], ['huddle-break', 33.5]];
  for (const [name, t] of shots) {
    await at(t);
    const st = await M(() => window.__elevens.renderer.officials?.state);
    if (name === 'walkout2') check('officials walk out', st && st.every((o) => o.visible), JSON.stringify(st?.map((o) => [o.x.toFixed(1), o.z.toFixed(1)])));
    if (name === 'line') check('officials stand between the teams', st && st.every((o) => Math.abs(o.x) < 1 && o.visible));
    await page.screenshot({ path: `${OUT}${name}.png`, timeout: 120000 });
  }
  check('ceremony ends in the match', await waitFor(() => window.__elevens.cine.mode === 'none', 300000));
  // In play: the referee 9-16 m from the ball, the assistants on the touchlines.
  check('match playing', await waitFor(() => window.__elevens.session.view()?.phase === 'play', 120000));
  await sleep(6000);
  const st = await M(() => { const r = window.__elevens.renderer, v = window.__elevens.session.view(); return { o: r.officials.state, b: v.ball.pos }; });
  const ref = st.o[0];
  const d = Math.hypot(ref.x - st.b.x, ref.z - st.b.z);
  check('referee near play', d > 4 && d < 22, `(${d.toFixed(1)} m)`);
  check('assistants on the touchlines', Math.abs(Math.abs(st.o[1].z) - 35.1) < 0.6 && Math.abs(Math.abs(st.o[2].z) - 35.1) < 0.6, JSON.stringify(st.o.map((o) => [o.x.toFixed(1), o.z.toFixed(1)])));
  await page.screenshot({ path: `${OUT}match.png`, timeout: 120000 });
  // A yellow card: the referee holds it up.
  await M(() => { const a = window.__elevens; a.session.paused = true; });
  await M(() => { const r = window.__elevens.renderer, v = window.__elevens.session.view(); r.officials.onEvents(v, [{ type: 'card', player: 5, team: 0, text: 'yellow' }]); });
  await sleep(900);
  const card = await M(() => window.__elevens.renderer.officials.cardShowing);
  await M(() => { const r = window.__elevens.renderer; const o = r.officials.state[0]; r.viewOverride = { pos: [o.x + 3.2 * Math.cos(o.facing), 1.7, o.z + 3.2 * Math.sin(o.facing)], look: [o.x, 1.5, o.z] }; });
  await sleep(700);
  check('referee shows the card', card);
  await page.screenshot({ path: `${OUT}card.png`, timeout: 120000 });
  // Offside flag.
  await M(() => { const r = window.__elevens.renderer, v = window.__elevens.session.view(); r.officials.onEvents(v, [{ type: 'offside', x: 20, team: 0 }]); const o = r.officials.state[1]; r.viewOverride = { pos: [o.x, 1.7, o.z - 4.5], look: [o.x, 1.6, o.z] }; });
  await sleep(1200);
  await page.screenshot({ path: `${OUT}flag.png`, timeout: 120000 });
  check('assistant flags', await M(() => window.__elevens.renderer.officials.state[1].signal === 'flagUp'));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
