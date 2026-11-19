// Offside checks: a pass with the striker past the last defender, then the offside, raised
// through match events. Checks the big-screen page and the full-screen VAR replay, with stills.
// Usage: npm run build && node scripts/shots-var.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/var/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PRESET = process.argv[3] ?? 'medium';
const PORT = +(process.env.PORT ?? 8818), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], checks = [];
const check = (name, ok, extra = '') => { checks.push(!!ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', weather: 'clear' }, matchIntro: false, tvGraphics: false })), PRESET);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(120); } return null; };
  const playFor = async (sec) => { const c0 = await M(() => window.__elevens.cine.clock); await waitFor((c) => window.__elevens.cine.clock > c, 120000, c0 + sec); };
  await page.goto(`${BASE}/?test&cine`);
  await page.addStyleTag({ content: '.cine-fade{display:none!important}' });
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 90000);
  await sleep(600);
  await page.keyboard.down('KeyJ'); await sleep(250); await page.keyboard.up('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await playFor(2.5);
  // The pass: our striker a metre past the second-last defender.
  await M(() => {
    const a = window.__elevens; const m = a.session.match; const dir = m.attackDir(0);
    const opp = m.players.filter((p) => p.team === 1 && !p.off).map((p) => p.pos.x * dir).sort((x, y) => y - x);
    const st = m.players[9]; st.pos.x = (opp[1] + 0.9) * dir; st.pos.z = 6; st.vel.x = st.vel.z = 0;
    m.emit('kick', { player: 6, team: 0, text: 'pass', x: m.players[6].pos.x, z: m.players[6].pos.z, power: 14 });
  });
  await playFor(1.2);
  await M(() => window.__elevens.session.match.emit('offside', { player: 9, team: 0, x: 0, z: 0 }));
  check('offside check goes up on the big screens', await waitFor(() => !!window.__elevens.renderer.varScreen, 20000));
  const on = await waitFor(() => window.__elevens.cine.mode === 'var', 90000);
  check('VAR replay starts', !!on);
  const info = await M(() => { const v = window.__elevens.cine.varCheck; return v ? { margin: v.margin, xa: v.xa, xd: v.xd } : null; });
  check('the lines are worked out from the moment of the pass', !!info && info.margin > 0.5 && info.margin < 1.5, JSON.stringify(info));
  await waitFor(() => window.__elevens.cine.time >= 3.4 || window.__elevens.cine.mode !== 'var', 200000);
  check('lines drawn on the pitch', await M(() => window.__elevens.renderer.varLines.group.visible));
  await page.screenshot({ path: `${OUT}var-full.png`, timeout: 120000 });

  await waitFor(() => window.__elevens.cine.mode === 'none', 200000);
  // The big screens (still showing the check).
  await M(() => { const r = window.__elevens.renderer; const a = r.stadium.userData.arena; const s = a.screenMeshes[0]; const p = s.getWorldPosition(s.position.clone()); const d = s.getWorldDirection(s.position.clone()); r.viewOverride = { pos: [p.x + d.x * 30, p.y + 1, p.z + d.z * 30], look: [p.x, p.y, p.z] }; });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}var-screen.png`, timeout: 120000 });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
