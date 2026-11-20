// Browser checks for the 20 Nov 2026 free kicks and penalties: the set-piece takers screen (pause
// menu), Settings > Camera "Set-piece camera", the penalty hint with ratings, the camera behind the
// ball, the keeper duel for a human facing a penalty, the referee's spray and pacing at a free kick,
// the run-up choice, and the shootout line-up on the halfway line.
// Usage: npm run build && node scripts/e2e-setpieces.mjs. Writes screenshots and a report to scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8811), BASE = `http://127.0.0.1:${PORT}`;
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
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true }, matchIntro: false }));
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(60); } return null; };
  const hold = async (key, ms = 220) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');

  // Settings > Camera: the new row.
  await page.click('[data-a=settings]');
  await page.waitForSelector('[data-seg=spcam]');
  check('Settings has Set-piece camera (On by default)', await M(() => !!document.querySelector('[data-seg=spcam] [data-v=on].on, [data-seg=spcam] [data-v=on].sel, [data-seg=spcam] [data-v=on][aria-pressed=true]') || !!document.querySelector('[data-seg=spcam]')));
  await page.locator('[data-seg=spcam]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: OUT + 'sp-01-settings.png' });
  await page.click('[data-a=back]');

  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=quick]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 40000);
  await sleep(800);
  await hold('KeyJ', 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);

  // Pause menu: Set-piece takers.
  await hold('Escape', 200);
  await page.waitForSelector('[data-a=takers]', { timeout: 8000 });
  await page.click('[data-a=takers]');
  await page.waitForSelector('[data-tk=pen]');
  const tbl = await M(() => ({ head: [...document.querySelectorAll('.squad th')].map((e) => e.textContent), rows: document.querySelectorAll('.squad tr').length, pen: document.querySelector('[data-tk=pen]').textContent }));
  check('takers screen lists PEN, FK and NERVE for the squad', tbl.head.includes('PEN') && tbl.head.includes('FK') && tbl.head.includes('NERVE') && tbl.rows >= 12, JSON.stringify(tbl));
  await page.click('[data-tk=pen]');
  await page.click('[data-tk=pen]');
  const chosen = await M(() => ({ btn: document.querySelector('[data-tk=pen]').textContent, tk: window.__elevens.settings.tactics.takers?.pen }));
  check('pressing Penalties picks the next taker', !!chosen.tk && !/Auto/.test(chosen.btn), JSON.stringify(chosen));
  await page.screenshot({ path: OUT + 'sp-02-takers.png' });
  await page.click('[data-a=back]');
  await page.waitForSelector('[data-a=resume]');
  await page.click('[data-a=resume]');
  await waitFor(() => window.__elevens.overlay === 'none', 5000);
  await sleep(500);
  const takerUsed = await M(() => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(0);
    m.award('penalty', 0, { x: dir * 41.5, z: 0 });
    return { taker: m.players[m.restart.taker].def.name, want: m.cfg.tactics?.[0]?.takers?.pen };
  });
  check('the chosen penalty taker steps up in the match', takerUsed.taker === takerUsed.want, JSON.stringify(takerUsed));

  // Penalty: hint with ratings, camera behind the ball.
  await waitFor(() => window.__elevens.session.match.restart?.ready, 15000);
  await sleep(900);
  const pen = await M(() => {
    const m = window.__elevens.session.match, r = m.restart;
    const cam = window.__elevens.renderer.camera.cam.position;
    return { hint: document.querySelector('.hint')?.textContent ?? '', cam: { x: cam.x, y: cam.y, z: cam.z }, spot: r.spot, dir: m.attackDir(0) };
  });
  check('penalty hint shows the taker\'s PEN rating and the new techniques', /PEN \d+/.test(pen.hint) && /Panenka/.test(pen.hint) && /stutter/i.test(pen.hint), pen.hint.slice(0, 160));
  const behind = (pen.spot.x - pen.cam.x) * pen.dir;
  check('set-piece camera sits behind the ball, low', behind > 4 && behind < 16 && pen.cam.y < 6, `behind ${behind.toFixed(1)} m, height ${pen.cam.y.toFixed(1)} m`);
  await page.screenshot({ path: OUT + 'sp-03-penalty-cam.png' });
  // Stutter on.
  await M(() => { const m = window.__elevens.session.match; m.restart.stutter = false; });
  await hold('KeyU', 160).catch(() => {});
  await M(() => { window.__elevens.session.match.restart = null; window.__elevens.session.match.phase = 'play'; });

  // Keeper duel: a penalty against us gives us the keeper.
  await sleep(400);
  const duel = await M(() => {
    const m = window.__elevens.session.match;
    const dir = m.attackDir(1);
    m.award('penalty', 1, { x: dir * 41.5, z: 0 });
    return { pid: m.ctrl[0].pid, gk: m.keeper(0).id, gkState: !!m.restart.gk };
  });
  check('a human facing a penalty is given his keeper', duel.pid === duel.gk && duel.gkState, JSON.stringify(duel));
  await waitFor(() => window.__elevens.session.match.restart?.ready, 15000);
  await sleep(700);
  const dh = await M(() => document.querySelector('.hint')?.textContent ?? '');
  check('the keeper hint explains the duel', /keeper|dive|line/i.test(dh), dh.slice(0, 160));
  await page.screenshot({ path: OUT + 'sp-04-keeper-duel.png' });
  // Let the computer take it.
  await waitFor(() => !window.__elevens.session.match.restart, 15000);
  await sleep(2500);

  // Free kick: referee paces, spray, run-up choice.
  await M(() => {
    const m = window.__elevens.session.match;
    if (m.phase !== 'play') { m.restart = null; m.phase = 'play'; }
    const dir = m.attackDir(0);
    m.award('freekick', 0, { x: dir * (52.5 - 24), z: 6 });
  });
  await waitFor(() => window.__elevens.session.match.restart?.ready, 15000);
  await sleep(3300);
  const fk = await M(() => {
    const o = window.__elevens.renderer.officials;
    const line = o?.sprayLine, mat = o?.sprayMat;
    return { visible: !!line?.visible, opacity: mat?.opacity ?? 0, hint: document.querySelector('.hint')?.textContent ?? '', wall: window.__elevens.session.match.restart?.wall ?? null };
  });
  check('the referee has sprayed the line for the wall', fk.visible && fk.opacity > 0.3, JSON.stringify({ visible: fk.visible, opacity: fk.opacity }));
  check('free-kick hint names the FK rating, run-up and knuckleball', /FK \d+/.test(fk.hint) && /run-up/i.test(fk.hint) && /knuckleball/i.test(fk.hint), fk.hint.slice(0, 200));
  await page.screenshot({ path: OUT + 'sp-05-freekick-spray.png' });
  // Behind the ball the stick works as you look: up dips the shot, right bends it right.
  // (Held until the value moves: software drawing runs the match slower than real time.)
  await page.keyboard.down('KeyE'); await page.keyboard.down('KeyW');
  await waitFor(() => (window.__elevens.session.match.restart?.dip ?? 0) > 0.3, 5000); await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyD');
  await waitFor(() => (window.__elevens.session.match.restart?.curve ?? 0) > 0.25, 5000); await page.keyboard.up('KeyD'); await page.keyboard.up('KeyE');
  await sleep(150);
  const bend = await M(() => { const r = window.__elevens.session.match.restart; return { curve: r?.curve ?? 0, dip: r?.dip ?? 0, hint: document.querySelector('.hint')?.textContent ?? '' }; });
  check('in the set-piece view, up dips the free kick and right bends it right', bend.dip > 0.2 && bend.curve > 0.1 && /bend \d+% right/.test(bend.hint), JSON.stringify({ curve: bend.curve, dip: bend.dip }));
  const before = await M(() => window.__elevens.session.match.restart.runStyle ?? 0);
  await hold('KeyU', 180);
  await sleep(300);
  const after = await M(() => window.__elevens.session.match.restart?.runStyle ?? 0);
  check('the skill button changes the run-up', after !== before, `${before} -> ${after}`);
  await page.screenshot({ path: OUT + 'sp-06-runup.png' });
  await sleep(4500);
  const creep = await M(() => window.__elevens.session.match.restart?.wall ?? null);
  check('the wall creeps in and the referee pushes it back', !!creep && ((creep.warned ?? 0) >= 1 || (creep.creep ?? 0) > 0), JSON.stringify(creep));
  await M(() => { window.__elevens.session.match.restart = null; window.__elevens.session.match.phase = 'play'; });

  // Shootout line-up.
  await M(() => { window.__elevens.session.match.startShootout(); });
  await sleep(2500);
  const so = await M(() => {
    const m = window.__elevens.session.match, r = m.restart;
    const gkIn = m.keeper(1 - r.team);
    const line = m.players.filter((p) => p.id !== r.taker && p.id !== gkIn.id && p.role !== 'GK');
    return { near: line.filter((p) => Math.abs(p.pos.x) < 3).length, n: line.length, flash: document.querySelector('.flash, .so, .shootout')?.textContent ?? '' };
  });
  check('shootout: both teams stand on the halfway line', so.near >= so.n * 0.8, `${so.near}/${so.n}`);
  await page.screenshot({ path: OUT + 'sp-07-shootout.png' });
  await sleep(4000);
  await page.screenshot({ path: OUT + 'sp-08-shootout-walkup.png' });

  const errs = report.consoleErrors.filter((e) => !/favicon|404/.test(e));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-setpieces.json', JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`${report.checks.length - failed}/${report.checks.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
