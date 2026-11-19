// Big moments in the real client: a goal is forced in an offline match, then this checks that
// play slows down and the camera shakes, and screenshots the celebration (depth of field on High)
// and the net-cam replay. Usage: npm run build && node scripts/shots-bigmoments.mjs [outdir] [preset]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = process.argv[2] ?? new URL('./out/', import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'high';
const PORT = 8802, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [], results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: 'realistic', matchTime: 'night', weather: 'clear' }, matchIntro: false })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?test&cine`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { const ph = await page.evaluate(() => window.__elevens?.session?.view()?.phase); if (ph === 'kickoff' || ph === 'play') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  // Let the kick-off go (pass) and play reach open play.
  for (let i = 0; i < 60; i++) { if ((await page.evaluate(() => window.__elevens.session.view().phase)) === 'play') break; await page.keyboard.down('KeyJ'); await sleep(300); await page.keyboard.up('KeyJ'); await sleep(400); }
  // A shot into the top corner from 14 m, with the keeper out of the way.
  await page.evaluate(() => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir ? m.attackDir[0] : 1;
    const gx = 52.5 * (window.__elevens.session.view().attackDir[0]);
    for (const p of m.players) if (Math.abs(p.pos.x - gx) < 20) p.pos = { x: gx * 0.4, z: p.pos.z };
    const sh = m.players.find((p) => p.team === 0 && p.role === 'ST');
    const b = m.ball;
    b.pos = { x: gx - Math.sign(gx) * 14, y: 0.3, z: 2 };
    b.vel = { x: Math.sign(gx) * 24, y: 2.2, z: 0.8 };
    b.state = 'flight'; b.flight = 'shot'; b.owner = -1; b.receiver = -1; b.lastTouch = sh.id; b.lastTouchTeam = 0; b.kicker = sh.id; b.kickLock = 0; b.spin = 0;
    void dir;
  });
  await page.evaluate(() => { const s = window.__elevens.session; const d = s.drainEvents.bind(s); window.__evlog = []; s.drainEvents = () => { const e = d(); for (const x of e) window.__evlog.push(x.type); return e; }; });
  // Watch the goal: slow motion and shake.
  let slow = false, shake = 0, phase = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const s = await page.evaluate(() => ({ slow: window.__elevens.slowMo.active, shake: window.__elevens.renderer.shakeLevel, phase: window.__elevens.session.view().phase }));
    slow ||= s.slow; shake = Math.max(shake, s.shake); phase = s.phase;
    if (slow && shake > 0) break;
    await sleep(60);
  }
  console.log('events', await page.evaluate(() => window.__evlog.join(',')));
  check('goal slows play down', slow);
  check('goal shakes the camera', shake > 0.3, `max ${shake.toFixed(2)}`);
  await page.screenshot({ path: `${OUT}big-1-goal.png` });
  // Celebration: depth of field on (High and Ultra).
  await sleep(2500);
  const dof = await page.evaluate(() => { const r = window.__elevens.renderer; return { on: !!r.bokeh?.enabled, phase: window.__elevens.session.view().phase }; });
  if (preset === 'high' || preset === 'ultra') check('celebration has depth of field', dof.on, JSON.stringify(dof));
  await page.screenshot({ path: `${OUT}big-2-celebration.png` });
  // Net-cam replay (also depth of field).
  let rep = false;
  for (let i = 0; i < 200 && !rep; i++) { rep = await page.evaluate(() => window.__elevens.cine.mode === 'replay'); if (!rep) await sleep(250); }
  console.log(`info: goal replay ${rep ? 'started' : 'not seen'} (forced goals in ?test pages often have no replay)`);
  await sleep(2600);
  await page.screenshot({ path: `${OUT}big-3-replay.png` });
} finally { await browser.close(); server.kill(); console.log('errors', JSON.stringify(errors)); console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`); }
