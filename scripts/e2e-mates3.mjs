// Browser checks for the third set of teammate behaviours (19 Nov): the set-piece marking choice in
// Match settings and the pause menu, zonal and man-marking at a corner against, a block slide in
// front of a shot, the partnership message and the Partnerships list in Player stats, and the
// keeper sweeping a ball played in behind.
// Usage: npm run build && node scripts/e2e-mates3.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8807), BASE = `http://127.0.0.1:${PORT}`;
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
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript((p) => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } }));
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const hold = async (key, ms = 220) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  // Match settings: the set-piece marking choice.
  const segs = await M(() => [...document.querySelectorAll('[data-seg=mark] button')].map((b) => b.textContent));
  check('Match settings offers Mixed / Man-marking / Zonal for corners and wide free kicks', JSON.stringify(segs) === JSON.stringify(['Mixed', 'Man-marking', 'Zonal']), JSON.stringify(segs));
  await page.click('[data-seg=mark] [data-v=zonal]');
  await page.screenshot({ path: OUT + 'mates3-01-settings.png' });
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  const mk = await M(() => window.__elevens.session.match.cfg.tactics?.[0]?.marking);
  check('the choice reaches the match', mk === 'zonal', String(mk));
  await sleep(800);
  await hold('KeyJ', 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  // A corner against: zonal means nobody stands with a man; switch to man-marking in the pause menu and they pick men up.
  const corner = () => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(1);
    m.award('corner', 1, { x: dir * 52.5, z: 34 });
  };
  const marking = () => {
    const m = window.__elevens.session.match;
    if (!m.restart || m.restart.type !== 'corner') return null;
    const atk = m.teamPlayers(1).filter((p) => p.role !== 'GK' && p.id !== m.restart.taker);
    const def = m.teamPlayers(0).filter((p) => p.role !== 'GK');
    const near = atk.filter((a) => Math.abs(a.pos.x) > 34 && def.some((d) => Math.hypot(d.pos.x - a.pos.x, d.pos.z - a.pos.z) < 1.6)).length;
    const inBox = atk.filter((a) => Math.abs(a.pos.x) > 34 && Math.abs(a.pos.z) < 20).length;
    return { near, inBox };
  };
  // Wait until everyone is set, then hold the kick while we look.
  // (Keep the set-up clock low for a while so everyone walks all the way to their places.)
  const setUp = async () => {
    for (let i = 0; i < 60; i++) {
      const done = await M(() => { const m = window.__elevens.session.match, r = m.restart; if (!r) return true; r.t = Math.min(r.t, 1); r.ready = false; return m.players.every((p) => p.vel.x * p.vel.x + p.vel.z * p.vel.z < 0.3); });
      if (done && i > 10) break;
      await sleep(250);
    }
    return waitFor(() => { const r = window.__elevens.session.match.restart; if (r?.ready) { r.readyT = -60; return true; } r.t = Math.max(r.t, 3.1); return false; }, 30000);
  };
  await M(corner);
  await setUp();
  await sleep(300);
  const z = await M(marking);
  check('zonal: attackers in the box are not each shadowed by a defender', z && z.inBox >= 4 && z.near <= 2, JSON.stringify(z));
  await M(() => { const r = window.__elevens.renderer, m = window.__elevens.session.match; const gx = m.ownGoalX(0); r.viewOverride = { pos: [gx * 0.62, 26, 0], look: [gx * 0.93, 0, 0] }; });
  await sleep(500);
  await page.screenshot({ path: OUT + 'mates3-02-corner-zonal.png' });
  await page.keyboard.press('Escape');
  await waitFor(() => !!document.querySelector('[data-seg=mark]'), 5000);
  await page.click('[data-seg=mark] [data-v=man]');
  const mk2 = await waitFor(() => window.__elevens.session.match.cfg.tactics?.[0]?.marking === 'man' && document.querySelector('[data-seg=mark] [data-v=man].on') ? 'man' : null, 4000);
  check('pause menu: switching to man-marking reaches the match', mk2 === 'man');
  await page.click('[data-a=resume]');
  await M(() => { const r = window.__elevens.session.match.restart; r.ready = false; r.t = 0.7; });
  await setUp();
  await sleep(300);
  const mm = await M(marking);
  check('man-marking: most attackers in the box have a defender goal-side of them', mm && mm.near >= Math.min(4, mm.inBox - 1), JSON.stringify(mm));
  await page.screenshot({ path: OUT + 'mates3-03-corner-man.png' });
  await M(() => { window.__elevens.renderer.viewOverride = null; });

  // Get back to open play: drop the ball to the keeper.
  await M(() => { const m = window.__elevens.session.match; m.restart = null; m.phase = 'play'; const gk = m.keeper(0); const b = m.ball; b.owner = gk.id; b.state = 'held'; b.flight = 'none'; b.lastTouch = gk.id; b.lastTouchTeam = 0; b.pos = { x: gk.pos.x, y: 1.2, z: gk.pos.z }; m.holdT = 0; });
  await sleep(300);

  // A shot at goal with a defender just off its path: he throws himself in front of it.
  const blocked = await M(async () => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(0);
    const st = m.teamPlayers(1).find((p) => p.role === 'ST');
    const d = m.teamPlayers(0).find((p) => p.role === 'RCB');
    for (const p of m.teamPlayers(0)) if (p.role !== 'GK' && p.id !== d.id) { p.pos = { x: dir * -10, z: (p.slot - 5) * 5 }; p.vel = { x: 0, z: 0 }; }
    for (const p of m.teamPlayers(1)) if (p.role !== 'GK' && p.id !== st.id) { p.pos = { x: dir * 5, z: (p.slot - 5) * 5 }; p.vel = { x: 0, z: 0 }; }
    m.ctrl[0].pid = m.teamPlayers(0).find((p) => p.role === 'ST').id;
    m.ctrl[0].autoSwitch = false; // the human stays on the striker, so the defender is the computer's
    st.pos = { x: dir * -31, z: 0 }; st.vel = { x: 0, z: 0 }; st.action = { type: 'none', t: 0, dur: 0 };
    d.pos = { x: dir * -37, z: 1.3 }; d.vel = { x: 0, z: 0 }; d.action = { type: 'none', t: 0, dur: 0 }; d.a.tackling = 1; d.tackleCooldown = 0;
    st.facing = dir > 0 ? Math.PI : 0;
    const b = m.ball;
    b.owner = st.id; b.state = 'dribble'; b.flight = 'none'; b.lastTouch = st.id; b.lastTouchTeam = 1; b.pos = { x: st.pos.x - dir * 0.4, y: 0.11, z: 0 }; b.vel = { x: 0, y: 0, z: 0 };
    m.possessionStart = m.time - 1;
    const chance = m.rng.chance; m.rng.chance = () => true;
    m.startKick(st, { kind: 'shot', power: 0.7, placed: false, target: { x: -dir * 52.5, y: 0.4, z: 0 } });
    window.__blockSeen = false;
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 30));
      if (d.action.type === 'slide' && d.action.block) { window.__blockSeen = true; m.rng.chance = chance; }
      if (window.__blockSeen && d.action.t > 0.2) break;
    }
    m.rng.chance = chance;
    m.ctrl[0].autoSwitch = true;
    return { seen: window.__blockSeen, action: d.action.type };
  });
  check('a defender near the shot\'s path throws himself in front of it', blocked.seen, JSON.stringify(blocked));
  await M(() => { const r = window.__elevens.renderer, m = window.__elevens.session.match; const d = m.teamPlayers(0).find((p) => p.role === 'RCB'); r.viewOverride = { pos: [d.pos.x + 5, 2.4, d.pos.z + 7], look: [d.pos.x, 0.4, d.pos.z] }; });
  await sleep(200);
  await page.screenshot({ path: OUT + 'mates3-04-block.png' });
  await M(() => { window.__elevens.renderer.viewOverride = null; });

  // Partnership message and the Partnerships list.
  await M(() => { const m = window.__elevens.session.match; const a = m.teamPlayers(0).find((p) => p.role === 'RCM'), b = m.teamPlayers(0).find((p) => p.role === 'ST'); for (let i = 0; i < 4; i++) m.addLink(0, a.id, b.id, 1); });
  const toast = await waitFor(() => [...document.querySelectorAll('#hud *')].map((e) => e.textContent).find((t) => t && t.startsWith('Partnership:')) ?? null, 4000);
  check('a partnership message shows when a pair starts linking up', !!toast, toast ?? '');
  await page.screenshot({ path: OUT + 'mates3-05-partnership.png' });
  await page.keyboard.press('Escape');
  await waitFor(() => !!document.querySelector('[data-a=squads]'), 5000);
  await page.click('[data-a=squads]');
  const list = await waitFor(() => document.querySelector('ul.partners')?.textContent ?? null, 4000);
  check('Player stats lists the partnership', !!list && list.includes('linking up'), list ?? '');
  await page.screenshot({ path: OUT + 'mates3-06-partners-list.png' });
  await page.click('[data-a=back]');
  await page.click('[data-a=resume]');
  await sleep(300);

  // Keeper sweeper: a ball played in behind a high line.
  const swept = await M(async () => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(0);
    const gk = m.keeper(0);
    m.restart = null; m.phase = 'play';
    const spots = { RB: [-6, 20], LB: [-6, -20], RCB: [-8, 6], LCB: [-8, -6], CDM: [0, 0], RCM: [6, 10], LCM: [6, -10], RW: [15, 24], LW: [15, -24], ST: [18, 0] };
    for (const p of m.teamPlayers(0)) if (p.role !== 'GK') { const s = spots[p.role]; p.pos = { x: s[0] * dir, z: s[1] * dir }; p.vel = { x: 0, z: 0 }; p.action = { type: 'none', t: 0, dur: 0 }; }
    for (const o of m.teamPlayers(1)) if (o.role !== 'GK') { o.pos = { x: (12 + (o.slot % 3) * 4) * dir, z: ((o.slot % 5) * 9 - 18) * dir }; o.vel = { x: 0, z: 0 }; }
    const st = m.teamPlayers(1).find((p) => p.role === 'ST');
    st.pos = { x: -6 * dir, z: 2 * dir }; st.vel = { x: -4 * dir, z: 0 };
    gk.pos = { x: -48 * dir, z: 0 }; gk.vel = { x: 0, z: 0 }; gk.action = { type: 'none', t: 0, dur: 0 };
    m.ctrl[0].pid = m.teamPlayers(0).find((p) => p.role === 'ST').id;
    const k = m.teamPlayers(1).find((p) => p.role === 'RCB');
    const b = m.ball;
    b.owner = -1; b.state = 'flight'; b.flight = 'through'; b.receiver = st.id; b.lastTouch = k.id; b.lastTouchTeam = 1; b.kicker = k.id; b.kickLock = 0;
    b.pos = { x: -12 * dir, y: 0.2, z: 2 * dir }; b.vel = { x: -14 * dir, y: 0, z: 0 }; b.spin = 0; m.lastKickTime = m.time - 0.5;
    let seen = false, maxOut = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => setTimeout(r, 40));
      if (gk.aiIntent === 'sweep') seen = true;
      maxOut = Math.max(maxOut, 52.5 - Math.abs(gk.pos.x));
      if (b.owner >= 0) break;
    }
    return { seen, maxOut: +maxOut.toFixed(1), owner: b.owner >= 0 ? m.players[b.owner].role + '/' + m.players[b.owner].team : 'none' };
  });
  check('the keeper comes off his line to sweep a ball in behind', swept.seen && swept.maxOut > 8, JSON.stringify(swept));
  await page.screenshot({ path: OUT + 'mates3-07-sweep.png' });
} finally {
  report.finished = new Date().toISOString();
  writeFileSync(OUT + 'e2e-mates3-report.json', JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`${report.checks.length - failed}/${report.checks.length} checks passed; console errors: ${report.consoleErrors.length}`);
process.exit(failed ? 1 : 0);
