// Browser checks for mouse control (19 Nov 2026): Controls > Mouse turns it on and remaps with mouse
// buttons, then in a match the player runs towards the pointer, left click passes, right click shoots,
// A plays a long ball, S a through ball, Space switches, and the browser menu stays off the pitch.
// Usage: npm run build && node scripts/e2e-mouse.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8803), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 1, shadows: false, players: 'classic' } })); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(120); } return null; };
  await page.goto(`${BASE}/?test`);
  // Record whether anything stopped the browser menu.
  await M(() => { window.__menus = []; document.addEventListener('contextmenu', (e) => window.__menus.push({ t: e.target.id || e.target.tagName, prevented: e.defaultPrevented })); });
  await page.waitForSelector('[data-a=quick]');

  // --- Controls > Mouse: turn it on, remap with a mouse button, reset.
  await page.click('[data-a=controls]');
  await page.click('[data-seg=ctab] [data-v=mouse]');
  const offNote = await page.textContent('.panel');
  await page.click('[data-seg=mctl] [data-v=on]');
  const on = await M(() => ({ live: window.__elevens.settings.mouseControl, saved: JSON.parse(localStorage.getItem('elevens.settings.v1')).mouseControl, src: window.__elevens.actions.sources.map((s) => s.device) }));
  const tbl = await page.textContent('.bindtbl');
  await page.screenshot({ path: OUT + 'mouse-01-controls.png', fullPage: true });
  check('Controls has a Mouse tab with an On/Off switch; On is saved and the player reads the mouse', /Off: matches use the Keyboard layout/.test(offNote ?? '') && on.live && on.saved && on.src[0] === 'mouse', JSON.stringify(on));
  check('Mouse tab lists left click pass, right click shoot, A long ball, S through ball, Shift sprint, Space switch',
    /Pass \/ tackleLeft click/.test(tbl) && /Shoot \/ tackleRight click/.test(tbl) && /Lob, cross \/ slide tackleA/.test(tbl) && /Through ball \/ containS/.test(tbl) && /SprintL Shift/.test(tbl) && /Switch player \/ call runSpaceMiddle click/.test(tbl), tbl.replace(/✕/g, ' ').slice(0, 220));
  await page.click('[data-bind=skill][data-slot="1"]');
  const box = await page.locator('.panel h2').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await sleep(500);
  const rb = await M(() => ({ skill: window.__elevens.settings.controls.mouse.skill, shoot: window.__elevens.settings.controls.mouse.shoot, msg: document.querySelector('.bindmsg')?.textContent ?? '', menus: window.__menus.slice() }));
  check('remap: select a slot and right click: Right click becomes Skill move (taken from Shoot), no browser menu', rb.skill.join() === 'KeyF,Mouse2' && rb.shoot.length === 0 && /Right click is now Skill/.test(rb.msg) && rb.menus.every((m) => m.prevented), JSON.stringify(rb));
  await page.click('[data-a=bindreset]');
  const reset = await M(() => window.__elevens.settings.controls.mouse.shoot.join() === 'Mouse2' && window.__elevens.settings.controls.mouse.skill.join() === 'KeyF');
  check('remap: Reset mouse to defaults', reset);
  await page.click('[data-seg=ctab] [data-v=list]');
  const list = await page.textContent('table.ctl');
  check('All controls shows a Mouse column', /Mouse/.test(await page.textContent('table.ctl thead')) && /Point where to run/.test(list));
  await page.click('[data-a=back]');

  // --- A match with the mouse.
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 30000);
  await sleep(800);
  await page.mouse.move(640, 360);
  const cursor = await M(() => document.getElementById('game').style.cursor);
  check('in a match the pointer is a crosshair', cursor === 'crosshair', cursor);
  await page.mouse.down(); await sleep(150); await page.mouse.up();
  const kicked = await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  check('left click kicks off', kicked);
  const give = () => M(() => {
    const m = window.__elevens.session.match;
    const p = m.players[m.ctrl[0].pid];
    p.skillCd = 0; p.action = { type: 'none', t: 0, dur: 0 };
    m.takePossession(p, true);
    m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 };
    m.ball.vel = { x: 0, y: 0, z: 0 };
    // Room to play: opponents close by are moved away (software rendering is slow, so they'd nick it).
    for (const o of m.players) if (o.team !== p.team && Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) < 9) { const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z) || 1; o.pos = { x: p.pos.x + ((o.pos.x - p.pos.x) / d) * 12, z: Math.max(-33, Math.min(33, p.pos.z + ((o.pos.z - p.pos.z) / d) * 12)) }; }
    return p.id;
  });
  // A point on the pitch some metres from our player, on screen.
  const pointAt = (off) => M((off) => {
    const a = window.__elevens, m = a.session.match, p = m.players[m.ctrl[0].pid];
    const w = { x: p.pos.x + off.x, z: p.pos.z + off.z };
    const s = a.renderer.project(w.x, 0, w.z);
    return { ...s, w, from: { ...p.pos }, id: p.id };
  }, off);

  // Steering: the pointer 12 m to one side; the player runs that way.
  await give();
  const tgt = await pointAt({ x: 0, z: -12 });
  await page.mouse.move(tgt.x, tgt.y);
  await sleep(2500);
  const moved = await M((t) => { const m = window.__elevens.session.match; const p = m.players[t.id]; return { dx: p.pos.x - t.from.x, dz: p.pos.z - t.from.z, steer: window.__elevens.mouse.read() }; }, tgt);
  await page.screenshot({ path: OUT + 'mouse-02-steering.png' });
  check('the player runs towards the pointer', moved.dz < -2 && Math.abs(moved.dx) < Math.abs(moved.dz), `moved (${moved.dx.toFixed(1)}, ${moved.dz.toFixed(1)}) m`);
  // Resting the pointer on the player stops him.
  const here = await pointAt({ x: 0, z: 0 });
  const still = await M((h) => { const a = window.__elevens; a.mousePt = { x: h.x, y: h.y }; return true; }, here);
  await page.mouse.move(here.x, here.y);
  await sleep(1200);
  const st = await M(() => { const a = window.__elevens; const r = a.mouse.read(); return Math.hypot(r.sx, r.sy); });
  check('pointer on the player: no run', still && st < 0.35, `stick ${st.toFixed(2)}`);

  // Left click: pass towards a teammate under the pointer.
  const kickedBy = async (fn, ms = 6000) => waitFor((id) => { const m = window.__elevens.session.match; return m.ball.kicker === id && m.ball.owner !== id && Math.hypot(m.ball.vel.x, m.ball.vel.z) > 3 ? { state: m.ball.state, y: m.ball.pos.y, v: Math.hypot(m.ball.vel.x, m.ball.vel.z), vy: m.ball.vel.y, kicker: m.ball.kicker } : null; }, ms, fn);
  let id = await give();
  const mate = await M(() => { const a = window.__elevens, m = a.session.match, me = m.players[m.ctrl[0].pid]; const t = m.players.filter((p) => p.team === 0 && p.id !== me.id && p.role !== 'GK').sort((x, y) => Math.hypot(x.pos.x - me.pos.x, x.pos.z - me.pos.z) - Math.hypot(y.pos.x - me.pos.x, y.pos.z - me.pos.z))[0]; return { ...a.renderer.project(t.pos.x, 0, t.pos.z), id: t.id }; });
  await page.mouse.move(mate.x, mate.y);
  await sleep(300);
  await page.mouse.down(); await sleep(200); await page.mouse.up();
  const pass = await kickedBy(id);
  check('left click passes', pass && pass.kicker === id && pass.v > 5, JSON.stringify(pass));

  // Right click: shot (and no browser menu on the pitch).
  await sleep(500);
  id = await give();
  await M(() => { const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; const gx = m.attackDir(0) * 52.5; p.pos = { x: gx - m.attackDir(0) * 16, z: 0 }; p.facing = m.attackDir(0) > 0 ? 0 : Math.PI; m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z }; });
  await sleep(1500);
  const goalPt = await pointAt({ x: await M(() => window.__elevens.session.match.attackDir(0) * 10), z: 0 });
  await page.mouse.move(goalPt.x, goalPt.y);
  await M(() => { window.__menus = []; });
  await page.mouse.down({ button: 'right' }); await sleep(250); await page.mouse.up({ button: 'right' });
  const shot = await kickedBy(id);
  const menus = await M(() => window.__menus.slice());
  check('right click shoots', shot && shot.kicker === id && shot.v > 12, JSON.stringify(shot));
  check('right click on the pitch doesn\'t open the browser menu', menus.length > 0 && menus.every((m) => m.prevented), JSON.stringify(menus));
  await page.screenshot({ path: OUT + 'mouse-03-shot.png' });

  // A: long ball (in the air). S: through ball.
  for (const [key, name] of [['KeyA', 'A plays a long ball (lofted)'], ['KeyS', 'S plays a through ball']]) {
    await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
    await sleep(400);
    id = await give();
    const fwd = await pointAt({ x: await M(() => window.__elevens.session.match.attackDir(0) * 20), z: 0 });
    await page.mouse.move(fwd.x, fwd.y);
    await sleep(200);
    await page.keyboard.down(key); await sleep(300); await page.keyboard.up(key);
    const k = await kickedBy(id);
    const lofted = k && key === 'KeyA' ? await waitFor(() => window.__elevens.session.match.ball.pos.y > 1.2, 3000) : true;
    const diag = k ? '' : await M((id) => { const m = window.__elevens.session.match; return JSON.stringify({ id, phase: m.phase, ctl: m.ctrl[0].pid, st: m.ball.state, owner: m.ball.owner, kicker: m.ball.kicker, r: m.restart?.type, held: window.__elevens.actions.held().lob, ch: !!window.__elevens.actions.charging(performance.now()) }); }, id);
    check(name, k && k.kicker === id && (key === 'KeyS' || lofted), JSON.stringify(k) + diag);
  }

  // Space switches player when defending; the guide line names the mouse controls.
  await sleep(300);
  await M(() => { const m = window.__elevens.session.match; const opp = m.players.filter((p) => p.team === 1 && p.role !== 'GK' && !p.off).sort((x, y) => Math.hypot(x.pos.x - m.ball.pos.x, x.pos.z - m.ball.pos.z) - Math.hypot(y.pos.x - m.ball.pos.x, y.pos.z - m.ball.pos.z))[0]; m.takePossession(opp, true); m.ball.pos = { x: opp.pos.x + Math.cos(opp.facing) * 0.45, y: 0.11, z: opp.pos.z + Math.sin(opp.facing) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 }; });
  await sleep(500);
  const before = await M(() => window.__elevens.session.match.ctrl[0].pid);
  await page.keyboard.down('Space'); await sleep(250); await page.keyboard.up('Space');
  const switched = await waitFor((b) => window.__elevens.session.match.ctrl[0].pid !== b, 4000, before);
  check('Space switches player when defending', switched);
  const guide = await M(() => document.querySelector('.guide')?.textContent ?? document.body.textContent.match(/Point to run[^\n]{0,120}/)?.[0] ?? '');
  check('the on-screen guide shows the mouse controls', /Point to run/.test(guide), guide.slice(0, 120));

  // Pause menu: clicks don't act on the match; Settings keeps the switch.
  await page.keyboard.down('Escape'); await sleep(200); await page.keyboard.up('Escape');
  await waitFor(() => document.querySelector('[data-a=settings]'), 5000);
  await page.click('[data-a=settings]');
  const row = await M(() => document.querySelector('[data-seg=mctl] .on')?.getAttribute('data-v'));
  await page.screenshot({ path: OUT + 'mouse-04-settings.png', fullPage: true });
  check('Settings shows Mouse control On', row === 'on', row);
  await page.click('[data-seg=mctl] [data-v=off]');
  const off = await M(() => ({ on: window.__elevens.settings.mouseControl, src: window.__elevens.actions.sources.map((s) => s.device) }));
  check('turning it off hands the match back to the keyboard', !off.on && off.src[0] === 'keyboard', JSON.stringify(off));
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-mouse-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
