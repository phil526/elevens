// Browser check for the ball control update (19 Nov 2026): the Practice "Ball control drill" (gate on the
// pitch, task hint, points, result panel), close control on C, flick-up and keepy-ups on C + skill (U),
// and the Controls guide rows.
// Usage: npm run build && CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/e2e-ballcontrol.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8798), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic' } }));
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const M = (fn, arg) => p.evaluate(fn, arg);
  const waitFor = (fn, ms = 15000, arg) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const hold = async (keys, ms) => { for (const k of keys) await p.keyboard.down(k); await sleep(ms); for (const k of [...keys].reverse()) await p.keyboard.up(k); };

  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  if (!(await M(() => !!document.querySelector('[data-a=practice]')))) await p.click('[data-a=more]');
  await p.click('[data-a=practice]');
  await p.waitForSelector('[data-a=p-control]');
  const btn = await p.textContent('[data-a=p-control]');
  check('Practice menu has a Ball control drill button', /Ball control drill/.test(btn ?? ''), btn ?? '');
  await p.click('[data-a=p-control]');
  const ready = await waitFor(() => { const m = window.__elevens?.session?.match; return !!m?.ctlDrill && m.phase === 'play'; }, 40000);
  await sleep(800);
  const st = await M(() => {
    const m = window.__elevens.session.match, d = m.ctlDrill;
    return { on: m.players.filter((q) => !q.off).length, stage: d.stage, gate: !!d.gate, owner: m.ball.owner === d.player, clk: document.querySelector('.clk')?.textContent ?? '', hint: document.querySelector('.hint, .guide-hint, .practice-hint')?.textContent ?? document.body.innerText.match(/Dribble through the gate/)?.[0] ?? '' };
  });
  await p.screenshot({ path: `${OUT}ballcontrol-01-drill-gate.png` });
  check('the drill starts: two players, ball at your feet, a gate up', ready && st.on === 2 && st.gate && st.owner && st.stage === 'gate', JSON.stringify(st));
  check('score bug says BALL CONTROL with the time left, and the task shows', /BALL CONTROL/.test(st.clk) && /Dribble through the gate/.test(await M(() => document.body.innerText)), st.clk);

  // Close control: holding C with the stick slows the carrier to the close-control pace.
  await p.keyboard.down('KeyC'); await p.keyboard.down('KeyD'); await sleep(900);
  const cc = await M(() => { const m = window.__elevens.session.match, pl = m.players[m.ctlDrill.player]; return { held: m.closeHeld(pl), sp: Math.hypot(pl.vel.x, pl.vel.z), near: Math.hypot(m.ball.pos.x - pl.pos.x, m.ball.pos.z - pl.pos.z), own: m.ball.owner === pl.id }; });
  await p.keyboard.up('KeyD'); await p.keyboard.up('KeyC');
  check('holding C is close control: slow, the ball within half a metre', cc.held && cc.own && cc.sp < 3.6 && cc.near < 0.6, JSON.stringify(cc));

  // Through the gate: walk the carrier across the line (ball follows in the dribble) and the points go up.
  const before = await M(() => window.__elevens.session.match.score[0]);
  await M(() => {
    const m = window.__elevens.session.match, d = m.ctlDrill, g = d.gate, pl = m.players[d.player];
    const nx = g.az, nz = -g.ax;
    pl.pos = { x: g.x + nx * 1.2, z: g.z + nz * 1.2 }; pl.vel = { x: 0, z: 0 };
    pl.facing = Math.atan2(-nz, -nx);
    m.ball.pos = { x: pl.pos.x - nx * 0.4, y: 0.11, z: pl.pos.z - nz * 0.4 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    d.prev = { x: m.ball.pos.x, z: m.ball.pos.z };
    window.__gateCross = { x: g.x - nx * 1.2, z: g.z - nz * 1.2 };
  });
  await sleep(150);
  await M(() => {
    const m = window.__elevens.session.match, d = m.ctlDrill, pl = m.players[d.player], to = window.__gateCross;
    const fx = Math.cos(pl.facing), fz = Math.sin(pl.facing);
    pl.pos = { ...to }; m.ball.pos = { x: to.x + fx * 0.4, y: 0.11, z: to.z + fz * 0.4 };
  });
  const scored = await waitFor((b) => window.__elevens.session.match.score[0] > b, 3000, before);
  await sleep(300);
  const after = await M(() => ({ pts: window.__elevens.session.match.score[0], stage: window.__elevens.session.match.ctlDrill.stage }));
  await p.screenshot({ path: `${OUT}ballcontrol-02-gate-scored.png` });
  check('dribbling through the gate scores at least 100 and asks for a pass to the coach', scored && after.pts - before >= 100 && after.stage === 'pass' && /Pass to the coach/.test(await M(() => document.body.innerText)), JSON.stringify(after));

  // Flick up and keepy-ups: C + U flicks it up, U again keeps it up (+10 each in the drill).
  await M(() => { const m = window.__elevens.session.match, pl = m.players[m.ctlDrill.player]; pl.skillCd = 0; pl.action = { type: 'none', t: 0, dur: 0 }; });
  await p.keyboard.down('KeyC'); await sleep(80); await p.keyboard.down('KeyU'); await sleep(120); await p.keyboard.up('KeyU'); await p.keyboard.up('KeyC');
  const flick = await waitFor(() => { const m = window.__elevens.session.match, pl = m.players[m.ctlDrill.player]; return pl.action.type === 'skill' && (pl.action.skill === 'flickup' || pl.action.skill === 'juggle'); }, 2000);
  const pts0 = await M(() => window.__elevens.session.match.score[0]);
  let kept = 0;
  for (let i = 0; i < 3; i++) {
    await waitFor(() => { const m = window.__elevens.session.match, pl = m.players[m.ctlDrill.player]; return pl.action.type === 'skill' && pl.action.t >= 0.25; }, 1500);
    await hold(['KeyU'], 80);
    if (await waitFor((n) => window.__elevens.session.match.score[0] > n, 1200, pts0 + kept * 10)) kept++;
    if (kept === 1 && i === 0) await p.screenshot({ path: `${OUT}ballcontrol-03-keepy-up.png` });
  }
  check('C + U flicks the ball up and U keeps it up (keepy-ups score)', flick && kept >= 1, `flick ${flick}, keepy-ups ${kept}`);

  // The drill ends on the clock with a result panel showing the points.
  await M(() => { window.__elevens.session.match.ctlDrill.timeLeft = 0.3; });
  const ended = await waitFor(() => /points/.test(document.querySelector('.final')?.textContent ?? ''), 15000);
  const final = await M(() => document.querySelector('.final')?.textContent ?? '');
  await p.screenshot({ path: `${OUT}ballcontrol-04-result.png` });
  check('the drill ends after 60 seconds with "N points"', ended, final);

  // Controls guide lists the new moves.
  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  await p.click('[data-a=controls]');
  await p.waitForSelector('[data-seg=ctab] button[data-v=list]');
  await p.click('[data-seg=ctab] button[data-v=list]');
  await sleep(600);
  const txt = await M(() => document.body.innerText);
  check('Controls lists close control, sole stop, chop and flick-up', /Close control/i.test(txt) && /sole/i.test(txt) && /chop/i.test(txt) && /flick/i.test(txt));
  await p.screenshot({ path: `${OUT}ballcontrol-05-controls.png` });
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
