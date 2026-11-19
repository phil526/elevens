// Browser checks for local multiplayer (19 Nov 2026): Choose sides with two (simulated)
// controllers, versus and co-op matches driven by each pad, split keyboard, P2 pausing.
// Usage: npm run build && node scripts/e2e-local.mjs. Screenshots and report in scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8803), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript((p) => {
    localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: false } }));
    // Two fake Xbox controllers the test drives through window.__pads.
    const mk = (i) => ({ index: i, id: `Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e) #${i}`, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
    window.__pads = [mk(0), mk(1)];
    navigator.getGamepads = () => window.__pads;
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const shot = (n) => page.screenshot({ path: `${OUT}local-${n}.png` });
  const stick = (pad, x, y) => M(([i, x, y]) => { window.__pads[i].axes[0] = x; window.__pads[i].axes[1] = y; }, [pad, x, y]);
  const btn = async (pad, b, ms = 250) => { await M(([i, b]) => { window.__pads[i].buttons[b] = { pressed: true, value: 1 }; }, [pad, b]); await sleep(ms); await M(([i, b]) => { window.__pads[i].buttons[b] = { pressed: false, value: 0 }; }, [pad, b]); await sleep(200); };
  const flick = async (pad, x) => { await stick(pad, x, 0); await sleep(250); await stick(pad, 0, 0); await sleep(250); };
  const tokens = () => M(() => Array.from(document.querySelectorAll('.side-row')).map((r) => { const cells = r.querySelectorAll('.side-cell'); const at = [0, 1, 2].find((i) => cells[i].querySelector('.side-tok')); return `${r.dataset.dev}:${['home', 'mid', 'away'][at]}:${r.querySelector('.side-tok b').textContent}`; }).join(' '));

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.waitForSelector('[data-a=local]');
  check('main menu has Local multiplayer', true);
  await page.click('[data-a=local]');
  await page.waitForSelector('.side-row');
  let t = await tokens();
  check('both controllers appear, P1 home and P2 away', t === 'pad0:home:P1 pad1:away:P2 keys:mid:–', t);
  await shot('01-sides');
  await flick(1, -1);
  t = await tokens();
  check('P2 stick left moves the token to the middle', t.startsWith('pad0:home:P1 pad1:mid'), t);
  await flick(1, 1);
  t = await tokens();
  check('stick right moves it back to away', t.includes('pad1:away:P2'), t);
  check('summary says P1 v P2', (await M(() => document.querySelector('.side-sum').textContent)) === 'P1 v P2');

  // Split keyboard: two tokens, each half moves with its own keys.
  await page.click('[data-seg=ksplit] [data-v=split]');
  await page.keyboard.press('KeyA');
  await page.keyboard.press('ArrowRight');
  t = await tokens();
  check('split keyboard: WASD half and arrows half move separately', t.includes('keysL:home') && t.includes('keysR:away'), t);
  await shot('02-split');
  // A side holds two at most: the left half is already a second home player, so pad1 can't join home too... move halves back.
  await page.keyboard.press('KeyD');
  await page.keyboard.press('ArrowLeft');
  await page.click('[data-seg=ksplit] [data-v=one]');
  t = await tokens();
  check('back to one keyboard, waiting in the middle', t.includes('keys:mid'), t);

  // Versus: A on pad 0 carries on to the clubs.
  await btn(0, 0);
  check('A carries on to the clubs, labelled by player', await waitFor(() => /Home club · P1/.test(document.body.textContent) && /Away club · P2/.test(document.body.textContent), 5000));
  await page.click('[data-a=next]');
  check('versus match settings show the help level for both', await M(() => /both players/.test(document.body.textContent)));
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  const cfg = await M(() => { const s = window.__elevens.session; return { humans: s.match.cfg.humans, mates: s.match.cfg.mates, local: s.localTeams, extra: s.extra.length }; });
  check('versus: both sides human, one extra input layer', cfg.humans.join() === 'true,true' && cfg.extra === 1 && cfg.local.join() === '0,1', JSON.stringify(cfg));
  await sleep(500);
  // Kick off with P1 (A = pass), then each stick moves its own side's man.
  for (let i = 0; i < 6 && !(await M(() => window.__elevens.session.match.phase === 'play')); i++) { await btn(0, 0, 300); await sleep(1500); }
  check('P1 takes the kick-off', await waitFor(() => window.__elevens.session.match.phase === 'play', 15000), await M(() => window.__elevens.session.match.phase));
  await M(() => { const m = window.__elevens.session.match; m.ball.owner = -1; m.ball.state = 'free'; m.ball.pos = { x: 0, y: 0.11, z: 33 }; m.ball.vel = { x: 0, y: 0, z: 0 }; m.ctrl[0].autoSwitch = false; m.ctrl[1].autoSwitch = false; });
  const pos = () => M(() => { const m = window.__elevens.session.match; return [m.players[m.ctrl[0].pid].pos, m.players[m.ctrl[1].pid].pos].map((p) => ({ x: p.x, z: p.z })); });
  const p0 = await pos();
  await stick(1, 1, 0); await sleep(1500); await stick(1, 0, 0);
  const p1 = await pos();
  const moved = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  check('P2 controller moves the away side\'s player, not P1\'s', moved(p0[1], p1[1]) > 0.6 && moved(p0[0], p1[0]) < 0.3, `away ${moved(p0[1], p1[1]).toFixed(1)} m, home ${moved(p0[0], p1[0]).toFixed(1)} m`);
  await stick(0, -1, 0); await sleep(1500); await stick(0, 0, 0);
  const p2 = await pos();
  check('P1 controller moves the home side\'s player', moved(p1[0], p2[0]) > 0.6, `${moved(p1[0], p2[0]).toFixed(1)} m`);
  const markers = await M(() => window.__elevens.renderer.markers.map((m) => m.sprite.visible));
  check('P1 and P2 markers show', markers[0] && markers[1] && !markers[2], markers.join());
  await shot('03-versus');
  await btn(1, 9);
  check('P2 Start pauses the match', await waitFor(() => window.__elevens.overlay === 'pause', 4000));
  await page.click('[data-a=quit]');

  // Co-op: both pads home against the computer.
  await page.waitForSelector('[data-a=local]');
  await page.click('[data-a=local]');
  await page.waitForSelector('.side-row');
  await flick(1, -1); await flick(1, -1);
  t = await tokens();
  check('both controllers on home = co-op', t.startsWith('pad0:home:P1 pad1:home:P2'), t);
  check('summary says together v the computer', /together v the computer/.test(await M(() => document.querySelector('.side-sum').textContent)));
  await shot('04-coop-sides');
  await btn(1, 0);
  await page.waitForSelector('[data-club]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  const cc = await M(() => { const m = window.__elevens.session.match; return { humans: m.cfg.humans, mates: m.cfg.mates, a: m.ctrl[0].pid, b: m.mates[0]?.pid }; });
  check('co-op: home has two humans on different players', cc.humans.join() === 'true,false' && cc.mates[0] && cc.a !== cc.b && cc.b >= 0, JSON.stringify(cc));
  await sleep(400);
  await btn(0, 0, 200);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await M(() => { const m = window.__elevens.session.match; m.ball.owner = -1; m.ball.state = 'free'; m.ball.pos = { x: 0, y: 0.11, z: 33 }; m.ball.vel = { x: 0, y: 0, z: 0 }; m.ctrl[0].autoSwitch = false; m.mates[0].autoSwitch = false; });
  const cp = () => M(() => { const m = window.__elevens.session.match; return [m.ctrl[0].pid, m.mates[0].pid].map((id) => ({ x: m.players[id].pos.x, z: m.players[id].pos.z })); });
  const c0 = await cp();
  await stick(1, 0, 1); await sleep(1500); await stick(1, 0, 0);
  const c1 = await cp();
  check('co-op: P2 steers their own man', moved(c0[1], c1[1]) > 0.6 && moved(c0[0], c1[0]) < 0.3, `P2 ${moved(c0[1], c1[1]).toFixed(1)} m, P1 ${moved(c0[0], c1[0]).toFixed(1)} m`);
  for (let i = 0; i < 6; i++) await btn(1, 4, 120); // P2 presses switch (LB) a few times
  const dup = await M(() => { const m = window.__elevens.session.match; return m.ctrl[0].pid === m.mates[0].pid; });
  check('switching never lands on the other human\'s player', !dup);
  const mk2 = await M(() => window.__elevens.renderer.markers.map((m) => m.sprite.visible));
  check('co-op shows P1 and P2 markers', mk2[0] && mk2[1], mk2.join());
  await shot('05-coop');
} catch (e) {
  check('script ran without throwing', false, String(e?.stack ?? e));
} finally {
  report.finished = new Date().toISOString();
  writeFileSync(`${OUT}local-report.json`, JSON.stringify(report, null, 2));
  const fails = report.checks.filter((c) => !c.ok).length;
  console.log(`${report.checks.length - fails}/${report.checks.length} passed; console errors: ${report.consoleErrors.length}`);
  if (report.consoleErrors.length) console.log(report.consoleErrors.slice(0, 5).join('\n'));
  await browser.close();
  server.kill();
  process.exitCode = fails ? 1 : 0;
}
