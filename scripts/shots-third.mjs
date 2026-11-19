// Screenshots for the third visual pass (19 Nov): footprints and slide tracks, divots, wet pitch,
// floodlight haze, lights switching on, fan display, flare smoke, depth of field, handheld
// celebration camera and faces.
// Usage: npm run build && node scripts/shots-third.mjs <outdir> [preset] [time] [shots] [query]
// shots: comma list of marks,wet,haze,tifo,smoke,lights,dof,handheld,faces,broadcast
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = (process.argv[2] ?? new URL('./out/third/', import.meta.url).pathname).replace(/\/?$/, '/'); mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'high', time = process.argv[4] ?? 'night';
const want = new Set((process.argv[5] ?? 'broadcast').split(','));
const query = process.argv[6] ?? '';
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { errors: [], info: {} };
const tag = `${preset}-${time}`;
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const extra = JSON.parse(process.env.GFX ?? '{}');
  const intro = want.has('lights') || want.has('tifo-intro');
  await ctx.addInitScript(([p, t, e, i]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: t, players: 'realistic', ...e }, matchIntro: i, tvGraphics: false })), [preset, time, extra, intro]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[vis]')) report.errors.push(m.text()); });
  await page.goto(`${BASE}/?test${intro ? '&cine' : ''}${query}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  const view = (pos, look) => page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = p ? { pos: p, look: l } : null; }, [pos, look]);
  const shot = async (name, wait = 900) => { await sleep(wait); await page.screenshot({ path: `${OUT}${tag}-${name}.png`, timeout: 120000 }); };
  const kickoff = async () => {
    for (let i = 0; i < 30; i++) {
      if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') return;
      await page.keyboard.down('KeyJ'); await sleep(250); await page.keyboard.up('KeyJ'); await sleep(600);
    }
  };
  if (intro) {
    // Stills through the stadium fly-in.
    for (const at of [0.4, 1.6, 2.6, 3.6, 5.0]) {
      for (let i = 0; i < 200; i++) { const t = await page.evaluate(() => window.__elevens.cine?.t ?? 0); if (t >= at) break; await sleep(60); }
      await page.screenshot({ path: `${OUT}${tag}-intro-${at}.png` });
      report.info[`lights${at}`] = await page.evaluate(() => window.__elevens.renderer.lightsOn);
    }
  }
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
  await sleep(1500);
  if (want.has('tifo')) {
    for (let i = 0; i < 120; i++) { if ((await page.evaluate(() => window.__elevens.renderer.tifo.level)) >= 1) break; await sleep(500); }
    report.info.tifoLevel = await page.evaluate(() => window.__elevens.renderer.tifo.level);
    report.info.smokeKickoff = await page.evaluate(() => window.__elevens.renderer.smoke.count);
    await shot('tifo-broadcast', 100); await view([-20, 14, 30], [-75, 14, 0]); await shot('tifo', 600); await view(null); }
  if (want.has('broadcast')) await shot('broadcast', 200);
  if (process.env.COVER) await page.evaluate((c) => { window.__elevens.renderer.weatherFx.cover = c; }, Number(process.env.COVER));
  if (!(want.size === 1 && (want.has('tifo') || want.has('faces')))) await kickoff();
  if (want.has('marks')) {
    // Let play run, then force two slides near the camera, and look along the pitch from low down.
    await sleep(Number(process.env.RUN ?? 15000));
    await page.evaluate(() => {
      const m = window.__elevens.session.match;
      for (const [id, vx, vz] of [[3, 7, 1], [15, -6, -2]]) {
        const p = m.players[id]; p.vel.x = vx; p.vel.z = vz; p.facing = Math.atan2(vz, vx);
        p.action = { type: 'slide', t: 0, dur: 0.8 };
      }
    });
    // Headless frame rates are too low for much running, so lay some runs down directly too.
    await page.evaluate(() => {
      const mk = window.__elevens.renderer.marks;
      const runs = [[-14, 2, 0.3, 9], [-14, 6, -0.1, 7], [-12, -3, 0.6, 5], [-8, 9, -0.9, 3]];
      for (const [x0, z0, a, sp] of runs) {
        const ux = Math.cos(a), uz = Math.sin(a), st = 0.42 + sp * 0.095;
        for (let k = 0; k < 22; k++) {
          const side = k % 2 ? 1 : -1, x = x0 + ux * st * k, z = z0 + uz * st * k + Math.sin(k * 0.3) * 0.4;
          mk.add({ x: x - uz * side * 0.11, z: z + ux * side * 0.11, dx: ux, dz: uz, len: 0.16, wid: 0.065, kind: side > 0 ? 1 : 0, amt: sp > 6 ? 0.62 : 0.5 });
        }
      }
      for (let k = 0; k < 12; k++) mk.add({ x: -10 + k * 0.5, z: 0.5 + k * 0.08, dx: 1, dz: 0.16, len: 0.3, wid: 0.07, kind: 5, amt: 0.35 });
    });
    await sleep(2500);
    report.info.stamped = await page.evaluate(() => window.__elevens.renderer.marks.stamped);
    report.info.divots = await page.evaluate(() => window.__elevens.renderer.marks.divots.count);
    await page.evaluate(() => window.__elevens.session.pause(true));
    for (const id of [3, 15]) {
      const p = await page.evaluate((id) => window.__elevens.session.view().players[id].pos, id);
      await view([p.x - 3, 3.2, p.z + 5], [p.x, 0, p.z]); await shot(`marks-slide-${id}`, 800);
    }
    await view([-17, 3.5, 9], [-9, 0, 3]); await shot('marks-runs', 600);
    const b = await page.evaluate(() => window.__elevens.session.view().ball.pos);
    await view([b.x - 8, 6, b.z + 10], [b.x, 0, b.z]); await shot('marks-play', 600);
    await view([0, 60, 30], [0, 0, 0]); await shot('marks-high', 600);
    await view(null); await shot('marks-broadcast', 600);
    await page.evaluate(() => window.__elevens.session.pause(false));
  }
  if (want.has('wet')) {
    report.info.reflFrames = await page.evaluate(() => window.__elevens.renderer.wet.frames);
    await view([0, 3, 12], [-14, 0, -6]); await shot('wet-low', 900);
    await page.evaluate(() => { window.__elevens.renderer.reflGain = 0; });
    await shot('wet-low-off', 600);
    await page.evaluate(() => { window.__elevens.renderer.reflGain = 1.6; });
    await view(null); await shot('wet-broadcast', 600);
  }
  if (want.has('haze')) {
    report.info.haze = await page.evaluate(() => { const h = window.__elevens.renderer.haze; return { count: h.count, vis: h.mesh.visible, k: window.__elevens.renderer.hazeK, verts: h.mesh.geometry.getAttribute('position')?.count }; }); await view(null); await shot('haze-broadcast', 300); await view([-30, 6, 20], [10, 25, -30]); await shot('haze-up', 600); await view(null); }
  if (want.has('smoke')) { await sleep(4000); report.info.smoke = await page.evaluate(() => window.__elevens.renderer.smoke.count); await view(null); await shot('smoke-broadcast', 300); await view([-40, 8, 25], [-62, 6, 0]); await shot('smoke-end', 600); await view(null); }
  if (want.has('handheld') || want.has('dof')) {
    // A goal for the home side: the handheld camera follows the celebration.
    for (let i = 0; i < 60; i++) { if ((await page.evaluate(() => window.__elevens.session.match.phase)) === 'play') break; await sleep(250); }
    await page.evaluate(() => {
      const m = window.__elevens.session.match;
      const dir = m.attackDir(0);
      const b = m.ball; b.owner = -1; b.state = 'flight'; b.flight = 'shot'; b.lastTouch = 9; b.lastTouchTeam = 0;
      b.pos = { x: dir * 46, y: 0.6, z: 1 }; b.vel = { x: dir * 30, y: 0.5, z: 0.4 };
      const s = m.players[9]; s.pos.x = dir * 44; s.pos.z = 1.5;
      for (const k of m.players) if (k.team === 1 && k.role === 'GK') { k.pos.x = dir * 50; k.pos.z = -12; }
    });
    for (const k of [0, 1, 2, 3]) {
      await shot(`goal-${k}`, k ? 700 : 1400);
      report.info[`goal${k}`] = await page.evaluate(() => { const r = window.__elevens.renderer; return { handheld: r.handheldOn, cine: window.__elevens.cine?.mode ?? null, liteDof: r.liteDof.frames }; });
    }
  }
  if (want.has('faces')) {
    // Before kick-off the players stand still on their marks.
    const ids = [9, 19];
    for (const id of ids) {
      for (const mood of ['neutral', 'joy', 'effort', 'frustration']) {
        await page.evaluate(([id, mood]) => { window.__elevens.renderer.faceTest = { id, mood }; }, [id, mood]);
        const p = await page.evaluate((id) => window.__elevens.session.view().players[id], id);
        const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
        await view([p.pos.x + fx * 0.75, 1.7, p.pos.z + fz * 0.75], [p.pos.x, 1.62, p.pos.z]);
        await shot(`face-${id}-${mood}`, 500);
      }
    }
    await page.evaluate(() => { window.__elevens.renderer.faceTest = null; });
  }
  report.info.calls = await page.evaluate(() => window.__elevens.renderer.info());
} catch (e) {
  report.errors.push(String(e?.stack ?? e));
} finally {
  writeFileSync(`${OUT}${tag}-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
}
