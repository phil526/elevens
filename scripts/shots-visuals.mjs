// Screenshots for the 19 Nov visual pass (sky, ball, grass, kits, grade, breath, pitchside, managers,
// big screen, trophy). Usage: npm run build && node scripts/shots-visuals.mjs <outdir> [preset] [time] [shots] [query]
// shots: comma list of broadcast,sky,ball,grass,kits,low,bench,screen,trophy,boards (default all)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = (process.argv[2] ?? new URL('./out/visuals/', import.meta.url).pathname).replace(/\/?$/, '/'); mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'high', time = process.argv[4] ?? 'dusk';
const want = new Set((process.argv[5] ?? 'broadcast,sky,ball,grass,kits,low,bench,screen,boards').split(','));
const query = process.argv[6] ?? '';
const PORT = 8800 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { errors: [], info: {} };
const tag = `${preset}-${time}`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const extra = JSON.parse(process.env.GFX ?? '{}');
  await ctx.addInitScript(([p, t, e]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t, players: 'realistic', ...e }, matchIntro: false, tvGraphics: false })), [preset, time, extra]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[vis]')) report.errors.push(m.text()); });
  await page.goto(`${BASE}/?test${query}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  // Realistic players arrive a little after kick-off on a cold cache.
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
  await sleep(2500);
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = p ? { pos: p, look: l } : null; }, [pos, look]);
  const shot = async (name, wait = 900) => { await sleep(wait); await page.screenshot({ path: `${OUT}${tag}-${name}.png` }); };
  if (want.has('broadcast')) await shot('broadcast', 200);
  if (want.has('sky')) { await view([0, 20, 30], [-60, 45, -120]); await shot('sky'); await view([0, 3, -20], [-40, 40, 160]); await shot('sky2'); }
  if (want.has('grass')) { await view([-6, 0.9, 3], [2, 0, -1]); await shot('grass-low'); await view([0, 30, 50], [0, 0, 0]); await shot('grass-high'); }
  if (want.has('kits')) {
    await page.evaluate(() => window.__elevens.session.pause?.(true));
    const p = await page.evaluate(() => { const v = window.__elevens.session.view(); const a = v.players[7], b = v.players[18]; return [a.pos, b.pos]; });
    await view([p[0].x + 2.2, 1.5, p[0].z + 2.5], [p[0].x, 1.2, p[0].z]); await shot('kit-home');
    await view([p[1].x + 2.2, 1.5, p[1].z + 2.5], [p[1].x, 1.2, p[1].z]); await shot('kit-away');
    await view([p[0].x - 2.2, 1.5, p[0].z - 2.5], [p[0].x, 1.2, p[0].z]); await shot('kit-back');
    await page.evaluate(() => window.__elevens.session.pause?.(false));
  }
  if (want.has('bench')) { await view([0, 5, -22], [-15, 1.2, -38]); await shot('bench', 1500); await view([10, 3, -26], [15.5, 1.2, -37]); await shot('bench2', 600); }
  if (want.has('low')) { await view([30, 3, 38], [52, 1, 30]); await shot('pitchside'); }
  if (want.has('screen')) { await view([-22, 24, 2], [-50, 33, -33]); await shot('screen', 2500); }
  if (want.has('boards')) { await view([10, 4, 10], [30, 1, -36]); await shot('boards'); }
  if (want.has('replay')) {
    report.info.feedFrames = await page.evaluate(() => window.__elevens.renderer.feed?.frameCount);
    await page.evaluate(() => window.__elevens.renderer.feed?.goal());
    await view([-22, 24, 2], [-50, 33, -33]);
    for (let i = 0; i < 60; i++) { if ((await page.evaluate(() => window.__elevens.renderer.stadium.userData.arena.screenPage)) === 'replay') break; await sleep(500); }
    report.info.screenPage = await page.evaluate(() => window.__elevens.renderer.stadium.userData.arena.screenPage);
    await shot('replay', 100);
  }
  if (want.has('flash')) {
    await page.evaluate(() => { const r = window.__elevens.renderer; r.onEvents(window.__elevens.session.view(), [{ type: 'save', team: 1 }]); });
    await view([10, 4, 10], [30, 1, -36]); await shot('flash', 1200);
  }
  if (want.has('ballstill')) {
    await page.evaluate(() => { const s = window.__elevens.session; s.pause(true); const b = s.match.ball; b.owner = -1; b.state = 'free'; b.pos = { x: 3, y: 0.11, z: 3 }; b.vel = { x: 0, y: 0, z: 0 }; });
    await view([3.9, 0.5, 3.9], [3, 0.15, 3]); await shot('ballstill', 1500);
    await page.evaluate(() => window.__elevens.session.pause(false));
  }
  if (want.has('ball')) {
    await view(null);
    for (let i = 0; i < 60; i++) { if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') break; await sleep(250); }
    await page.evaluate(() => { const m = window.__elevens.session.match; m.players.forEach((p) => { if (Math.abs(p.pos.x) > 20 || Math.abs(p.pos.z) > 20) p.pos.x = 0; }); const b = m.ball; b.owner = -1; b.state = 'flight'; b.flight = 'shot'; b.lastTouch = -1; b.spin = 9; b.pos = { x: -20, y: 0.5, z: 10 }; b.vel = { x: -22, y: 5, z: -6 }; });
    for (let k = 0; k < 4; k++) {
      const bp = await page.evaluate(() => window.__elevens.session.match.ball.pos);
      await view([bp.x + 1.2, bp.y + 0.35, bp.z + 1.2], [bp.x, bp.y, bp.z]);
      await shot(`ball-${k}`, 60);
    }
    report.info.side = await page.evaluate(() => window.__elevens.renderer.ballSpinner?.side);
  }
  if (want.has('trophy')) {
    await view(null);
    const ok = await page.evaluate(() => { const a = window.__elevens; return a.cine.startTrophy(a.session.view(), a.renderer, 0, '<b>Champions</b><span>🏆</span><b>Test</b><small>Cup winners</small>'); });
    report.info.trophyStarted = ok;
    for (const [t, name] of [[2.5, 'trophy-1'], [5.6, 'trophy-2'], [8.5, 'trophy-3'], [13.5, 'trophy-4']]) {
      await page.evaluate((tt) => { const c = window.__elevens.cine; if (c.trophy) c.trophy.t = Math.max(c.trophy.t, tt); }, t);
      await shot(name, 2500);
      (report.info.fade ??= []).push(await page.evaluate(() => document.elementsFromPoint(640, 60).map((e) => `${e.tagName}.${e.className} bg=${getComputedStyle(e).backgroundColor} op=${getComputedStyle(e).opacity} ${getComputedStyle(e).backdropFilter ?? ''}`)));
    }
    if (want.has('trophycmp')) {
      const shotNow = await page.evaluate(() => { const c = window.__elevens.renderer.camera.cam; return [c.position.toArray(), c.getWorldDirection(new c.position.constructor()).add(c.position).toArray()]; });
      await shot('trophy-cmp-a', 300);
      await page.evaluate(() => window.__elevens.cine.skip());
      await view(shotNow[0], shotNow[1]);
      await shot('trophy-cmp-b', 2500);
    }
    report.info.ceremony = await page.evaluate(() => { const c = window.__elevens.renderer.ceremony; return c && { confetti: c.confettiLive, bursts: c.launched, lifted: c.lifted }; });
  }
  report.info.managers = await page.evaluate(() => window.__elevens.renderer.managers?.list.map((g) => ({ side: g.side, x: g.p.pos.x, z: g.p.pos.z, root: g.model.root.position.toArray(), vis: g.model.root.visible, kind: g.model.constructor.name })));
  report.info.kids = await page.evaluate(() => window.__elevens.renderer.pitchside?.kidStates);
  report.info.renderInfo = await page.evaluate(() => window.__elevens.renderer.info());
  report.info.fps = await page.evaluate(() => window.__elevens.fps);
  await ctx.close();
} finally { await browser.close(); server.kill(); writeFileSync(`${OUT}${tag}-report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
