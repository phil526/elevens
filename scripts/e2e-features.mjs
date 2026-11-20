// Browser checks for the gameplay features added in November: aimed set pieces, cards,
// skill moves, slide tackles, contain and click-to-switch, driven with real key presses
// and clicks in headless Chromium. Usage: npm run build && npm run e2e:features
// Situations are set up through the ?test hook (window.__elevens); the inputs are real.
// Writes screenshots and e2e-features-report.json to scripts/out/. Software WebGL: no timing claims.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8797), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), renderer: 'headless Chromium, SwiftShader software WebGL', preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff');
  await sleep(800);
  await page.keyboard.press('KeyJ');
  await waitFor(() => window.__elevens.session.match.phase === 'play');

  // --- Aimed free kick: the target appears, the stick moves it, the shot is taken.
  await M(() => { const m = window.__elevens.session.match; m.award('freekick', 0, { x: m.attackDir(0) * (52.5 - 24), z: 4 }); });
  const ready = await waitFor(() => { const r = window.__elevens.session.match.restart; return r && r.ready && r.type === 'freekick'; });
  await sleep(1200);
  const hint = await page.textContent('.hint');
  const aim0 = await M(() => ({ ...window.__elevens.session.match.restart.aim }));
  await page.screenshot({ path: OUT + 'features-01-freekick-target.png' });
  check('free kick: target shown and the hint explains it', ready && /Free kick: move the target/.test(hint ?? ''), hint ?? '');
  const ringShown = await M(() => { const el = document.querySelector('.tring'); return !!el && getComputedStyle(el).display !== 'none'; });
  check('free kick: the timing ring shows over the ball', ringShown);
  await hold('KeyW', 900); // screen up: away from the camera
  const aim1 = await M(() => ({ ...window.__elevens.session.match.restart.aim }));
  check('free kick: holding W moves the target away from the camera', aim1.z < aim0.z - 1, `z ${aim0.z.toFixed(1)} -> ${aim1.z.toFixed(1)}`);
  await hold('KeyL', 700);
  const taken = await waitFor(() => window.__elevens.session.match.phase === 'play' && window.__elevens.session.match.ball.state !== 'dead', 15000);
  check('free kick: K takes it and play resumes', taken);

  // --- Cards: banner, then a second yellow sends the player off.
  await M(() => { const m = window.__elevens.session.match; m.giveCard(m.teamPlayers(1).find((p) => p.role === 'RCB'), 1); });
  const yellow = await waitFor(() => /YELLOW CARD/.test(document.querySelector('.banner .big')?.textContent ?? ''), 10000);
  await page.screenshot({ path: OUT + 'features-02-yellow-card.png' });
  check('cards: a booking shows the yellow card banner', yellow);
  await sleep(2500);
  await M(() => { const m = window.__elevens.session.match; m.giveCard(m.players.find((p) => p.team === 1 && p.role === 'RCB'), 1); });
  const red = await waitFor(() => document.querySelectorAll('.scorebug .rc').length === 1 && /RED CARD/.test(document.querySelector('.banner .big')?.textContent ?? '') && /second yellow/i.test(document.querySelector('.banner')?.textContent ?? ''), 10000);
  await page.screenshot({ path: OUT + 'features-03-sent-off.png' });
  check('cards: a second yellow shows the red banner and a red card on the score bug', red);

  // --- Skill move with the U key.
  await M(() => { const m = window.__elevens.session.match; if (m.phase !== 'play') return; const p = m.players[m.ctrl[0].pid]; p.skillCd = 0; p.action = { type: 'none', t: 0, dur: 0 }; m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 }; });
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await M(() => { const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; p.skillCd = 0; p.action = { type: 'none', t: 0, dur: 0 }; m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 }; });
  await hold('KeyU', 250); // held, not tapped: a quick press can fall between frames at software-render fps
  const skilled = await waitFor(() => { const m = window.__elevens.session.match; return m.players.some((p) => p.team === 0 && p.skillCd > 0); }, 8000);
  check('skill move: U with the ball starts a skill move', skilled);

  // --- Charged kicks: the power bar names the kick; lob held with shoot plays a chip.
  const giveBallNearBox = () => M(() => {
    const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; const d = m.attackDir(0);
    for (const q of m.players) if (q.team === 1 && q.role !== 'GK') { q.pos = { x: -d * 30, z: q.pos.z }; q.vel = { x: 0, z: 0 }; }
    p.pos = { x: d * (52.5 - 20), z: 2 }; p.vel = { x: 0, z: 0 }; p.facing = d > 0 ? 0 : Math.PI; p.action = { type: 'none', t: 0, dur: 0 };
    m.takePossession(p, true); m.ball.pos = { x: p.pos.x + Math.cos(p.facing) * 0.45, y: 0.11, z: p.pos.z + Math.sin(p.facing) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    m.ctrl[0].autoSwitch = false;
  });
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await giveBallNearBox();
  await page.keyboard.down('KeyJ'); await sleep(350);
  const passLabel = await page.textContent('.power b').catch(() => '');
  await page.keyboard.up('KeyJ');
  const passed = await waitFor(() => { const m = window.__elevens.session.match; return m.ball.state === 'flight' && ['pass'].includes(m.ball.flight); }, 6000);
  check('charged pass: the bar reads PASS while J is held, and the pass goes on release', /PASS/.test(passLabel ?? '') && passed, `label "${passLabel}"`);
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await giveBallNearBox();
  await M(() => { window.__kicks = []; const m = window.__elevens.session.match; const orig = m.startKick.bind(m); m.startKick = (p, req, h) => { window.__kicks.push({ kind: req.kind, variant: req.variant }); return orig(p, req, h); }; });
  await page.keyboard.down('KeyK'); await sleep(60);
  await page.keyboard.down('KeyL'); await sleep(300);
  const chipLabel = await page.textContent('.power b').catch(() => '');
  await page.screenshot({ path: OUT + 'features-07-chip-charge.png' });
  await page.keyboard.up('KeyL'); await page.keyboard.up('KeyK');
  const chipped = await waitFor(() => window.__kicks.some((k) => k.kind === 'shot' && k.variant === 'chip'), 6000);
  const lobbed = await M(() => window.__kicks.some((k) => k.kind === 'lob'));
  const kicks = await M(() => JSON.stringify(window.__kicks));
  check('chip: holding L with K reads CHIP and plays a chip, not a lob pass', /CHIP/.test(chipLabel ?? '') && chipped && !lobbed, `label "${chipLabel}", kicks ${kicks}`);

  // --- Call a run: Q with the ball sends a teammate in behind and says so.
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await giveBallNearBox();
  await M(() => { const m = window.__elevens.session.match; m.calledRun[0] = { pid: -1, until: 0 }; });
  await page.keyboard.press('KeyI');
  const called = await waitFor(() => { const m = window.__elevens.session.match; return m.calledRun[0].pid >= 0 && m.calledRun[0].pid !== m.ctrl[0].pid; }, 6000);
  const callToast = await waitFor(() => /run in behind/.test(document.querySelector('.toast')?.textContent ?? ''), 4000);
  check('call a run: Q with the ball sends a teammate in behind, with a toast', called && callToast);

  // --- Defending: contain (hold I), slide (L), click to switch.
  const setupDefend = () => M(() => {
    const m = window.__elevens.session.match;
    const me = m.players[m.ctrl[0].pid];
    // A centre-back: unlikely to have a pass already lined up from earlier play.
    const opp = m.teamPlayers(1).find((p) => p.role === 'LCB');
    opp.action = { type: 'none', t: 0, dur: 0 }; opp.aiNextDecision = m.time + 6; opp.aiTarget = { ...opp.pos };
    // takePossession doesn't move the ball: put it at the feet, or the carrier loses it on the next tick.
    m.takePossession(opp, true); opp.vel = { x: 0, z: 0 }; m.ball.pos = { x: opp.pos.x + Math.cos(opp.facing) * 0.45, y: 0.11, z: opp.pos.z + Math.sin(opp.facing) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    me.pos = { x: opp.pos.x + Math.cos(opp.facing) * 2.4, z: opp.pos.z + Math.sin(opp.facing) * 2.4 };
    me.facing = opp.facing + Math.PI; me.action = { type: 'none', t: 0, dur: 0 }; me.tackleCooldown = 0;
    m.ctrl[0].autoSwitch = false;
  });
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await setupDefend();
  await page.keyboard.down('KeyO');
  const contain = await waitFor(() => window.__elevens.session.match.contain[0] >= 0, 8000);
  await page.keyboard.up('KeyO');
  check('contain: holding I without the ball sends a teammate to press', contain);
  await setupDefend();
  // U without the ball takes the keeper; J then brings him off his line; U again hands him back.
  await hold('KeyU', 250); // held, not tapped: a quick press can fall between frames at software-render fps
  const tookGk = await waitFor(() => { const m = window.__elevens.session.match; return m.players[m.ctrl[0].pid].role === 'GK'; }, 4000);
  await hold('KeyJ', 250);
  const rushed = await waitFor(() => window.__elevens.session.match.keeperRush[0] > window.__elevens.session.match.time - 0.1, 6000);
  check('keeper rush: U takes the keeper, J sends him out', tookGk && rushed);
  await hold('KeyU', 250);
  await waitFor(() => { const m = window.__elevens.session.match; return m.players[m.ctrl[0].pid].role !== 'GK'; }, 4000);
  await setupDefend();
  await page.keyboard.press('KeyK');
  const slid = await waitFor(() => { const m = window.__elevens.session.match; return m.players[m.ctrl[0].pid].action.type === 'slide' || m.players[m.ctrl[0].pid].tackleCooldown > 1; }, 8000);
  await M(() => { const r = window.__elevens.renderer; const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; r.viewOverride = { pos: [p.pos.x + 5, 3, p.pos.z + 7], look: [p.pos.x, 0.6, p.pos.z] }; });
  await sleep(1500);
  await page.screenshot({ path: OUT + 'features-04-slide.png' });
  await M(() => { window.__elevens.renderer.viewOverride = null; });
  check('slide tackle: L without the ball starts a slide', slid);

  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await setupDefend();
  await sleep(1500);
  const target = await M(() => {
    const m = window.__elevens.session.match, r = window.__elevens.renderer;
    const cur = m.ctrl[0].pid;
    const t = m.teamPlayers(0).filter((p) => p.role !== 'GK' && p.id !== cur).map((p) => ({ p, s: r.project(p.pos.x, 0.9, p.pos.z) }))
      .filter((x) => x.s.visible && x.s.x > 80 && x.s.x < 1200 && x.s.y > 120 && x.s.y < 560)[0];
    return t ? { id: t.p.id, x: t.s.x, y: t.s.y } : null;
  });
  if (target) {
    const before = await M(() => window.__elevens.session.match.ctrl[0].pid);
    await page.mouse.click(target.x, target.y);
    const ground = await M((t) => window.__elevens.renderer.groundPoint(t.x, t.y), target);
    // Players keep moving between the click and the next simulation step, so accept the teammate
    // nearest the clicked point at that moment (usually the one aimed at).
    const switched = await waitFor((a) => { const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; return m.ctrl[0].pid !== a.before && Math.hypot(p.pos.x - a.g.x, p.pos.z - a.g.z) < 9 ? p.id : null; }, 8000, { before, g: ground });
    check('click to switch: clicking a teammate takes control of them', switched !== null, `aimed at ${target.id}, now ${switched}`);
  } else check('click to switch: clicking a teammate takes control of them', false, 'no teammate on screen');
  await page.screenshot({ path: OUT + 'features-05-after-click-switch.png' });

  // --- Camera: switch to the Broadcast view from the pause menu's Settings.
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-a=settings]', { timeout: 5000 });
  await page.click('[data-a=settings]');
  await page.click('[data-seg=cmode] [data-v=broadcast]');
  const picked = await page.evaluate(() => document.querySelector('[data-seg=cmode] [data-v=broadcast]')?.classList.contains('on') && JSON.parse(localStorage.getItem('elevens.settings.v1')).camera.mode);
  await page.click('[data-a=back]');
  await page.keyboard.press('Escape');
  await sleep(2500);
  const cam = await M(() => { const r = window.__elevens.renderer; const c = r.camera.cam; return { x: +c.position.x.toFixed(2), y: +c.position.y.toFixed(1), z: +c.position.z.toFixed(1), fov: +c.fov.toFixed(1), yaw: r.camera.inputYaw, inputYaw: window.__elevens.actions.yaw }; });
  check('camera: Settings switches to the Broadcast view (fixed gantry above halfway, TV lens)', picked === 'broadcast' && cam.x === 0 && cam.z === 70 && cam.fov !== 30, JSON.stringify(cam));
  check('camera: movement input follows the Broadcast camera heading', Math.abs(cam.yaw - cam.inputYaw) < 0.05, `camera ${cam.yaw.toFixed(3)}, input ${cam.inputYaw.toFixed(3)}`);
  await page.screenshot({ path: OUT + 'features-06-broadcast-view.png' });
  // --- Shoulder barge: J from alongside a running carrier is a shoulder challenge.
  // A quick Escape can fall between two software-rendered frames: close any menu with its button.
  const resume = async () => { await sleep(300); if (await page.$('[data-a=resume]')) await page.click('[data-a=resume]'); await waitFor(() => !document.querySelector('[data-a=resume]'), 5000); };
  const pause = async () => { await page.keyboard.down('Escape'); await waitFor(() => !!document.querySelector('[data-a=settings]'), 5000); await page.keyboard.up('Escape'); };
  await resume();
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await M(() => {
    const m = window.__elevens.session.match; window.__barges = 0;
    const orig = m.startBarge.bind(m); m.startBarge = (p) => { const ok = orig(p); if (ok && p.team === 0) window.__barges++; return ok; };
    const me = m.players[m.ctrl[0].pid];
    const opp = m.teamPlayers(1).find((p) => p.role === 'LCB');
    opp.action = { type: 'none', t: 0, dur: 0 }; opp.aiNextDecision = m.time + 6;
    const f = opp.facing, n = { x: -Math.sin(f), z: Math.cos(f) };
    m.takePossession(opp, true); opp.vel = { x: 0, z: 0 }; opp.aiTarget = { ...opp.pos };
    m.ball.pos = { x: opp.pos.x + Math.cos(f) * 0.45, y: 0.11, z: opp.pos.z + Math.sin(f) * 0.45 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    // Standing side by side, facing the same way (a running carrier is covered by tests/barge.test.ts).
    me.pos = { x: opp.pos.x + n.x * 1.2, z: opp.pos.z + n.z * 1.2 }; me.facing = f; me.vel = { x: 0, z: 0 }; me.action = { type: 'none', t: 0, dur: 0 }; me.tackleCooldown = 0;
    m.ctrl[0].autoSwitch = false;
  });
  await page.keyboard.down('KeyJ'); await sleep(600); await page.keyboard.up('KeyJ');
  const barged = await waitFor(() => window.__barges > 0, 4000);
  check('shoulder barge: J alongside the carrier is a barge, not a lunge', barged);

  // --- Early receiver: the teammate is locked when J goes down, and shown on the overhead meter.
  await pause();
  await page.click('[data-a=settings]');
  await page.click('[data-seg=recv] [data-v=early]');
  await page.click('[data-seg=cmode] [data-v=panoramic]');
  const saved = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('elevens.settings.v1')); return `${s.receiver}/${s.camera.mode}`; });
  await page.click('[data-a=back]');
  await resume();
  await waitFor(() => window.__elevens.session.match.phase === 'play', 15000);
  await giveBallNearBox();
  // A teammate ahead to lock on to (near the box there is usually nobody in front).
  await M(() => { const m = window.__elevens.session.match; const p = m.players[m.ctrl[0].pid]; const d = m.attackDir(0); const t = m.teamPlayers(0).find((q) => q.role === 'LW' && q.id !== p.id) ?? m.teamPlayers(0).find((q) => q.role === 'RW'); t.pos = { x: p.pos.x + d * 9, z: 8 }; t.vel = { x: 0, z: 0 }; t.aiNextDecision = m.time + 6; t.aiTarget = { ...t.pos }; });
  await sleep(300);
  await page.keyboard.down('KeyJ');
  // Software rendering runs at a few frames a second: wait until the held key has been sampled.
  const locked = (await waitFor(() => { const c = window.__elevens.actions.charging(performance.now()); return c ? c.locked + 1 : 0; }, 6000)) - 1;
  await sleep(1200);
  const lockLabel = await page.textContent('.power b').catch(() => '');
  await page.keyboard.up('KeyJ');
  const toLocked = await waitFor((r) => { const m = window.__elevens.session.match; return m.ball.state === 'flight' && m.ball.receiver === r; }, 6000, locked);
  check('early receiver: setting saved, J locks a teammate (lock on the meter) and the pass goes to them', saved === 'early/panoramic' && locked >= 0 && /\u{1F512}/u.test(lockLabel ?? '') && toLocked, `${saved}, locked ${locked}, label "${lockLabel}"`);
  await sleep(2500);
  const pano = await M(() => +window.__elevens.renderer.camera.cam.position.y.toFixed(1));
  check('camera: Panoramic sits high above the near side', pano > 55, `camera height ${pano}`);
  await page.screenshot({ path: OUT + 'features-08-panoramic.png' });

  // --- Practice: penalties on repeat, no clock.
  await pause();
  await page.click('[data-a=quit]');
  await page.click('[data-a=practice]');
  await page.click('[data-a=p-penalty]');
  const pen = await waitFor(() => { const m = window.__elevens.session?.match; return m && m.restart && m.restart.type === 'penalty' && m.restart.ready ? m.restart.spot.x : null; }, 20000);
  const clk = await page.textContent('.clk').catch(() => '');
  await M(() => { window.__first = window.__elevens.session.match.restart; });
  await sleep(600);
  await hold('KeyL', 250); // held: a quick press can fall between frames at software-render fps
  const again = await waitFor(() => { const m = window.__elevens.session.match; return m.restart && m.restart !== window.__first && m.restart.type === 'penalty'; }, 20000);
  await page.screenshot({ path: OUT + 'features-09-practice-penalties.png' });
  check('practice: penalties start at once, the bug reads PENALTIES, and another follows the kick', pen !== null && /PENALTIES/.test(clk ?? '') && again, `clock "${clk}"`);
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  writeFileSync(OUT + 'e2e-features-report.json', JSON.stringify(report, null, 2));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`\n${report.checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
