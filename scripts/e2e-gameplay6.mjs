// Browser checks for the 19 Nov 2026 gameplay additions: club playing styles on the club cards,
// Settings rows (shot assistance, home crowd momentum), the momentum meter, power shot label,
// modifier skill moves, free-kick bend and dip with its dotted line, and the tactical foul.
// (The set-piece camera is off here: these key presses assume the broadcast view.)
// Usage: npm run build && node scripts/e2e-gameplay6.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8806), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true }, matchIntro: false, camera: { setPiece: false } }));
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const hold = async (key, ms = 220) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
  const holdWith = async (mods, key, ms = 260) => { for (const k of mods) await page.keyboard.down(k); await sleep(120); await hold(key, ms); await sleep(60); for (const k of mods) await page.keyboard.up(k); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');

  // Settings: the two new rows.
  await page.click('[data-a=settings]');
  await page.waitForSelector('[data-seg=sassist]');
  const rows = await M(() => ({ shot: !!document.querySelector('[data-seg=sassist] [data-v=manual]'), mom: !!document.querySelector('[data-seg=mom] [data-v=off]') }));
  check('Settings has Shot assistance and Home crowd momentum', rows.shot && rows.mom, JSON.stringify(rows));
  await page.locator('[data-seg=sassist]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: OUT + 'g6-01-settings.png' });
  await page.click('[data-a=back]');

  // Club cards show how each club plays.
  await page.waitForSelector('[data-a=offline]');
  await page.click('[data-a=offline]');
  await page.waitForSelector('.club');
  const tags = await M(() => [...document.querySelectorAll('.club .pstyle')].map((e) => e.textContent));
  check('club cards show the playing style', tags.length >= 10 && tags.some((t) => /press/i.test(t)) && tags.some((t) => /counter/i.test(t)), `${tags.length} tags, e.g. ${tags.slice(0, 3).join(' | ')}`);
  await page.screenshot({ path: OUT + 'g6-02-club-styles.png' });
  const sum = await M(() => document.querySelector('.club-sum .pstyle')?.textContent ?? '');
  check('the computer side\'s summary says how it plays', /^Plays /.test(sum), sum);
  await page.click('[data-a=next]');
  await page.waitForSelector('[data-a=go]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 40000);
  await sleep(800);
  await hold('KeyJ', 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  // Momentum meter: push the home side on top.
  await M(() => { window.__elevens.session.match.momentum.value = 0.85; });
  await sleep(500);
  const mom = await M(() => { const el = document.querySelector('.mom'); return { shown: getComputedStyle(el).display !== 'none', lift: el.classList.contains('lift'), w: el.querySelector('.h').style.width }; });
  check('momentum meter shows the home side on top, glowing', mom.shown && mom.lift && parseInt(mom.w) > 30, JSON.stringify(mom));
  await page.screenshot({ path: OUT + 'g6-03-momentum.png' });
  await M(() => { window.__elevens.session.match.momentum.value = 0; });

  // Power shot: modifier + sprint while charging shows POWER SHOT.
  await M(() => {
    const m = window.__elevens.session.match;
    const st = m.players.find((p) => p.id === m.ctrl[0].pid) ?? m.teamPlayers(0).find((p) => p.role === 'ST');
    const dir = m.attackDir(0);
    m.ctrl[0].autoSwitch = false;
    st.pos = { x: dir * 30, z: 0 }; st.vel = { x: 0, z: 0 }; st.facing = dir > 0 ? 0 : Math.PI;
    m.ctrl[0].pid = st.id;
    m.takePossession(st, true); m.ball.pos = { x: st.pos.x + dir * 0.4, y: 0.11, z: 0 };
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK' && Math.abs(o.pos.x - st.pos.x) < 8) o.pos = { x: o.pos.x, z: o.pos.z + (o.pos.z >= 0 ? 12 : -12) };
  });
  await sleep(150);
  await page.keyboard.down('KeyE'); await page.keyboard.down('ShiftLeft'); await sleep(100);
  await page.keyboard.down('KeyK'); await sleep(250);
  const label = await M(() => document.querySelector('.power b')?.textContent ?? '');
  await page.screenshot({ path: OUT + 'g6-04-power-shot.png' });
  await page.keyboard.up('KeyK'); await sleep(80); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyE');
  const shot = await waitFor(() => { const b = window.__elevens.session.match.ball; return b.state === 'flight' && b.flight === 'shot' && Math.hypot(b.vel.x, b.vel.z); }, 3000);
  check('modifier + sprint + shoot is a power shot', label === 'POWER SHOT' && shot > 20, `${label}, ${shot && shot.toFixed(1)} m/s`);
  await sleep(1500);

  // Elastico: modifier + skill + forward.
  await waitFor(() => window.__elevens.session.match.phase === 'play' || window.__elevens.session.match.restart?.ready, 15000);
  {
    await M(() => {
      const m = window.__elevens.session.match;
      if (m.phase !== 'play') { m.restart = null; m.phase = 'play'; }
      const p = m.players.find((q) => q.id === m.ctrl[0].pid);
      const dir = m.attackDir(0);
      p.pos = { x: 0, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI; p.skillCd = 0; p.action = { type: 'none', t: 0, dur: 0 };
      m.takePossession(p, true); m.ball.pos = { x: dir * 0.4, y: 0.11, z: 0 };
    });
  }
  await sleep(100);
  const fwd = await M(() => window.__elevens.session.match.attackDir(0) > 0 ? 'KeyD' : 'KeyA');
  await page.keyboard.down('KeyE'); await page.keyboard.down(fwd); await sleep(80);
  await hold('KeyU', 120);
  const skill = await waitFor(() => { const m = window.__elevens.session.match; const p = m.players.find((q) => q.id === m.ctrl[0].pid); return p.action.type === 'skill' && p.action.skill; }, 1500);
  await page.screenshot({ path: OUT + 'g6-05-elastico.png' });
  await page.keyboard.up(fwd); await page.keyboard.up('KeyE');
  check('modifier + skill + forward is an elastico', skill === 'elastico', String(skill));
  await sleep(800);

  // Free kick: hold the modifier and move to bend and dip; the dotted line appears.
  await M(() => { const m = window.__elevens.session.match; m.award('freekick', 0, { x: m.attackDir(0) * (52.5 - 24), z: 4 }); });
  await waitFor(() => window.__elevens.session.match.restart?.ready, 15000);
  await sleep(200);
  // (Software rendering runs the match slower than real time, so hold the keys a little longer.)
  // Held until the value moves (20 Nov 2026: fixed holds missed it when the frame rate dipped).
  await page.keyboard.down('KeyE'); await page.keyboard.down('KeyW');
  await waitFor(() => Math.abs(window.__elevens.session.match.restart?.curve ?? 0) > 0.4, 5000); await page.keyboard.up('KeyW');
  await page.keyboard.down(fwd);
  await waitFor(() => (window.__elevens.session.match.restart?.dip ?? 0) > 0.3, 5000); await page.keyboard.up(fwd); await page.keyboard.up('KeyE');
  await sleep(150);
  const fk = await M(() => { const a = window.__elevens; const r = a.session.match.restart; return { curve: r?.curve ?? 0, dip: r?.dip ?? 0, line: !!a.renderer?.fkLine?.visible, hint: document.querySelector('.hint')?.textContent ?? '' }; });
  check('free kick: the modifier and stick set bend and dip, with the dotted line and hint', Math.abs(fk.curve) > 0.3 && fk.dip > 0.2 && fk.line && /bend/.test(fk.hint), JSON.stringify(fk));
  await page.screenshot({ path: OUT + 'g6-06-freekick-bend.png' });
  await hold('KeyK', 450);
  const fkBall = await waitFor(() => { const b = window.__elevens.session.match.ball; return b.state === 'flight' && { spin: b.spin, dip: b.dip ?? 0 }; }, 5000);
  check('the free kick is struck with that curl and topspin', fkBall && Math.abs(fkBall.spin) > 2.5 && fkBall.dip > 1, JSON.stringify(fkBall));
  await sleep(2500);

  // Tactical foul: an opponent breaking past our controlled defender; modifier + lob.
  await waitFor(() => window.__elevens.session.match.phase === 'play' || window.__elevens.session.match.restart?.ready, 15000);
  await M(() => {
    const m = window.__elevens.session.match;
    if (m.phase !== 'play') { m.restart = null; m.phase = 'play'; }
    const c = m.teamPlayers(1).find((p) => p.role === 'RCM');
    const me = m.teamPlayers(0).find((p) => p.role === 'LCB');
    const g = m.ownGoalX(0);
    c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; c.facing = g > 0 ? 0 : Math.PI; c.aiNextDecision = m.time + 30;
    m.takePossession(c, true); m.ball.pos = { x: Math.sign(g) * 0.4, y: 0.11, z: 0 };
    m.wonBallAt[1] = m.time;
    me.pos = { x: -Math.sign(g) * 0.8, z: 0.9 }; me.vel = { x: 0, z: 0 }; me.action = { type: 'none', t: 0, dur: 0 }; me.tackleCooldown = 0;
    m.ctrl[0].pid = me.id; m.ctrl[0].autoSwitch = false;
    window.__g6fouls = 0;
    const orig = m.emit.bind(m);
    m.emit = (t, d) => { if (t === 'call' && d?.text === 'tactical') window.__g6fouls++; return orig(t, d); };
  });
  await holdWith(['KeyE'], 'KeyL', 120);
  const tac = await waitFor(() => window.__g6fouls > 0 && { restart: window.__elevens.session.match.restart?.type, toast: document.querySelector('.toast')?.textContent ?? '' }, 3000);
  await sleep(150);
  await page.screenshot({ path: OUT + 'g6-07-tactical-foul.png' });
  check('modifier + lob pulls the runner back: a tactical foul and a free kick', tac && tac.restart === 'freekick' && /Tactical foul/.test(tac.toast), JSON.stringify(tac));

  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-gameplay6.json', JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`${report.checks.length - failed}/${report.checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
