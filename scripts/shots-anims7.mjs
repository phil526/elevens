// Contact sheets of the 20 Nov 2026 animation pack (render/moves7.ts, officials, huddle): overhead
// and scissor kicks, diving header, body feint, Berba and McGeady spins, backpedal, side-step,
// hurdle, injured and limping, shirt grab, keeper organising, pre-match huddle, keeper punch,
// fingertip, star and foot saves. Deterministic fixed-step frames.
// Usage: npm run build && node scripts/shots-anims7.mjs [tag] [preset]   (MOTION_ONLY=a,b)
// Writes scripts/out/anims7-<tag>-<name>.png.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const tag = process.argv[2] ?? 'now';
const preset = process.argv[3] ?? 'medium';
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
// [name, frames, dt]
const MOTIONS = [
  ['overhead', 12, 0.06], ['scissor', 12, 0.06], ['divingHeader', 12, 0.07],
  ['bodyfeint', 10, 0.04], ['berba', 12, 0.055], ['mcgeady', 12, 0.05],
  ['backpedal', 10, 1 / 15], ['sidestep', 10, 1 / 15], ['hurdle', 10, 0.05],
  ['injured', 10, 0.5], ['limp', 12, 1 / 12], ['limpSlow', 12, 1 / 10], ['backwalk', 12, 1 / 12],
  ['grab', 8, 0.1], ['organise', 10, 0.2], ['huddle', 8, 0.5],
  ['punch', 10, 0.05], ['fingertip', 12, 0.06], ['starSave', 10, 0.05], ['footSave', 10, 0.05],
];
try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
  await ctx.addInitScript((p) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, players: 'realistic' } })), preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]');
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await page.evaluate(() => { const a = window.__elevens; a.session.paused = true; a.renderer.render = () => {}; });
  const states = {};
  for (const [name, n, dt] of MOTIONS.filter((m) => !process.env.MOTION_ONLY || process.env.MOTION_ONLY.split(',').includes(m[0]))) {
    const res = await page.evaluate(([name, n, dt]) => {
      const r = window.__elevens.renderer;
      const v = window.__elevens.session.view();
      const keeperMove = ['punch', 'fingertip', 'starSave', 'footSave', 'organise'].includes(name);
      const id = keeperMove ? 0 : 9;
      const m = r.players[id];
      r.players.forEach((q, i) => q.setVisible(i === id));
      const V3 = r.scene.position.constructor;
      const p = JSON.parse(JSON.stringify(v.players[id]));
      p.pos = { x: 0, z: 20 }; p.facing = 0; p.vel = { x: 0, z: 0 }; p.sprinting = false; p.jockeying = false; p.stamina = 1;
      p.action = { type: 'none', t: 0, dur: 0 };
      const ball = new V3(0.6, 0.11, 20);
      const cam = r.camera.cam; cam.fov = 30; cam.updateProjectionMatrix();
      m.dribbling = false; m.holdThrow = false; m.tired = 0; m.resting = false; m.foe = null; m.aimHint = null; m.scanCue = 0; m.ballVel.set(0, 0, 0); m.lookAtBall = true;
      const none = () => ({ type: 'none', t: 0, dur: 0 });
      // Warm-up speed and per-frame behaviour.
      let warm = 0, camMode = 'side';
      const D = (kind, t, dur) => { r.reactions.update(t); r.reactions.hold(id, kind, dur); m.reaction = r.reactions.frame(id); };
      const S = {
        overhead: { warm: 0.5, kick: { kind: 'shot', dur: 0.62, power: 0.8 }, aim: { x: -40, z: 20 }, ballY: 1.85, ballOff: 0.35, cam: 'far' },
        scissor: { warm: 1, kick: { kind: 'shot', dur: 0.55, power: 0.8 }, aim: { x: 2, z: 45 }, ballY: 1.1, ballOff: 0.55, cam: 'far' },
        divingHeader: { warm: 6, step(t) { p.action = { type: 'header', t, dur: 0.7 }; p.vel = { x: Math.max(0, 6 - t * 6), z: 0 }; ball.set(p.pos.x + 0.9 - t * 2, 0.7, 20); }, cam: 'far' },
        bodyfeint: { warm: 6, step(t) { p.action = { type: 'skill', t, dur: 0.36, skill: 'bodyfeint', side: 1, dir: { x: 1, z: 0 } }; p.vel = { x: 5.5, z: t > 0.15 ? 2.5 : -0.8 }; ball.set(p.pos.x + 0.5, 0.11, p.pos.z + 0.05); }, cam: 'front' },
        berba: { warm: 3, step(t) { p.action = { type: 'skill', t, dur: 0.62, skill: 'berba', side: 1, dir: { x: 1, z: 0 } }; p.facing = -Math.PI * 2 * Math.min(1, t / 0.5); p.vel = { x: 2, z: 1.2 }; ball.set(p.pos.x + 0.4, 0.11, p.pos.z + 0.1); }, cam: 'front' },
        mcgeady: { warm: 3, step(t) { p.action = { type: 'skill', t, dur: 0.56, skill: 'mcgeady', side: 1, dir: { x: 1, z: 0 } }; p.facing = Math.PI / 2 * Math.min(1, t / 0.4); p.vel = { x: -0.5, z: t > 0.35 ? 5 : 0.5 }; ball.set(p.pos.x + 0.3, 0.11, p.pos.z + 0.3); }, cam: 'front' },
        backpedal: { warm: -3, step() { p.vel = { x: -3, z: 0 }; p.facing = 0; ball.set(p.pos.x + 6, 0.11, 20); } },
        backwalk: { warm: -1.6, step() { p.vel = { x: -1.6, z: 0 }; p.facing = 0; ball.set(p.pos.x + 6, 0.11, 20); } },
        limpSlow: { warm: 1.3, step() { m.limp = 1; p.vel = { x: 1.3, z: 0 }; ball.set(30, 0.11, 0); } },
        sidestep: { warm: 0, step() { p.vel = { x: 0, z: 2.6 }; p.facing = 0; ball.set(p.pos.x + 5, 0.11, p.pos.z); }, cam: 'chase' },
        hurdle: { warm: 6, step(t, i) { if (i === 1) m.play({ kind: 'hurdle', t: 0, dur: 0.5, side: 1, k: 1 }); p.vel = { x: 6, z: 0 }; }, cam: 'far' },
        injured: { warm: 0, step(t) { m.injury = { stage: t < 2.4 ? 'down' : 'treat', t: t < 2.4 ? t : t - 2.4 }; p.vel = { x: 0, z: 0 }; ball.set(30, 0.11, 0); }, cam: 'far' },
        limp: { warm: 2.5, step() { m.limp = 1; p.vel = { x: 2.5, z: 0 }; ball.set(30, 0.11, 0); }, cam: 'front' },
        grab: { warm: 6, step(t) { D('grabR', 1 / 10, 0.4); p.vel = { x: 6, z: 0 }; }, cam: 'front' },
        organise: { warm: 0, step(t) { D('organise', 0.2, 0.5); p.vel = { x: 0, z: 0 }; p.facing = 0; ball.set(p.pos.x + 22, 0.11, 22); }, cam: 'front' },
        huddle: { warm: 0, step(t) { D('teamHuddle', 0.5, 0.6); p.vel = { x: 0, z: 0 }; ball.set(30, 0.11, 0); }, cam: 'front' },
        punch: { warm: 0, step(t, i) { if (i === 0) m.onParry(2.25); p.action = { type: 'none', t: 0, dur: 0 }; p.vel = { x: 0, z: 0 }; ball.set(p.pos.x + 0.6, 2.25, 20); }, cam: 'face' },
        fingertip: { warm: 0, step(t) { p.action = { type: 'dive', t, dur: 0.75, target: { x: p.pos.x + 0.3, y: 2.35, z: 23.2 } }; p.vel = { x: 0, z: t < 0.35 ? 5 : 1 }; ball.set(p.pos.x + 9 - t * 25, 2.2, 22.5); }, cam: 'face' },
        starSave: { warm: 0, step(t) { p.action = { type: 'dive', t, dur: 0.6, target: { x: p.pos.x + 0.2, y: 0.9, z: 21 } }; p.vel = { x: 0, z: 0 }; ball.set(p.pos.x + 5 - t * 16, 0.9, 20.6); }, cam: 'face' },
        footSave: { warm: 0, step(t) { p.action = { type: 'dive', t, dur: 0.6, target: { x: p.pos.x + 0.2, y: 0.15, z: 20.9 } }; p.vel = { x: 0, z: 0 }; ball.set(p.pos.x + 11 - t * 20, 0.15, 20.8); }, cam: 'face' },
      }[name];
      warm = S.warm; camMode = S.cam ?? 'side';
      p.vel = { x: warm, z: 0 };
      m.injury = null; m.limp = name.startsWith('limp') ? 1 : 0; m.reaction = null;
      if (keeperMove) ball.set(p.pos.x + 25, 0.11, 20);
      for (let i = 0; i < 40; i++) { p.pos.x += p.vel.x / 30; p.pos.z += p.vel.z / 30; m.update(p, 1 / 30, i / 30, false, ball); }
      const out = [], log = [];
      for (let i = 0; i < n; i++) {
        const t = i * dt;
        if (S.kick) {
          if (i === 0) { ball.set(p.pos.x + (S.ballOff ?? 0.55), S.ballY ?? 0.11, 20 - 0.15); m.aimHint = S.aim; }
          p.action = { type: 'kick', ...S.kick, t }; p.vel = { x: Math.max(0, 1.5 - t * 5), z: 0 };
          const wind = S.kick.kind === 'shot' ? 0.25 : 0.2;
          if (t >= wind) { const dx = S.aim.x - p.pos.x, dz = S.aim.z - p.pos.z, d = Math.hypot(dx, dz); m.ballVel.set(dx / d * 14, 0.5, dz / d * 14); }
        } else S.step(t, i);
        p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
        m.update(p, dt, 1 + t, false, ball);
        if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.copy(ball); }
        log.push({ ...(m.motionState ?? {}), gait: m.gaitWeights });
        const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
        if (camMode === 'front') { cam.position.set(p.pos.x + 4.2, 1.3, p.pos.z + 4.2); cam.lookAt(p.pos.x, 0.7, p.pos.z); }
        else if (camMode === 'high') { cam.position.set(p.pos.x + 3.5, 3.2, p.pos.z + 3.5); cam.lookAt(p.pos.x, 0.3, p.pos.z); }
        else if (camMode === 'chase') { cam.position.set(p.pos.x - fx * 5 + 3, 1.8, p.pos.z - fz * 5 + 3); cam.lookAt(p.pos.x, 0.7, p.pos.z); }
        else if (camMode === 'head') { cam.position.set(p.pos.x + 4.5, 1.7, p.pos.z + 1.5); cam.lookAt(p.pos.x, 1.4, p.pos.z); }
        else if (camMode === 'far') { cam.position.set(p.pos.x - 0.6, 1.0, p.pos.z + 8); cam.lookAt(p.pos.x - 0.6, 0.85, p.pos.z); }
        else if (camMode === 'face') { cam.position.set(p.pos.x + 9, 1.0, p.pos.z + 0.3); cam.lookAt(p.pos.x, 0.8, p.pos.z + 0.3); }
        else if (camMode === 'wide') { cam.position.set(p.pos.x + 0.9, 1.3, p.pos.z + 8.5); cam.lookAt(p.pos.x + 0.9, 0.45, p.pos.z); }
        else { cam.position.set(p.pos.x, 1.0, p.pos.z + 6.5); cam.lookAt(p.pos.x, 0.75, p.pos.z); }
        r.renderer.render(r.scene, cam);
        out.push(r.renderer.domElement.toDataURL('image/png'));
      }
      return { out, log };
    }, [name, n, dt]);
    states[name] = res.log;
    const sheet = await page.evaluate(async (frames) => {
      const imgs = await Promise.all(frames.map((src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; })));
      const w = 240, h = 300, cols = Math.min(imgs.length, 8), rows = Math.ceil(imgs.length / cols);
      const c = document.createElement('canvas'); c.width = w * cols; c.height = h * rows;
      const g = c.getContext('2d');
      imgs.forEach((im, i) => g.drawImage(im, (im.width - w * (im.width / 640)) / 2, (im.height - h * (im.height / 480)) / 2, w * (im.width / 640), h * (im.height / 480), (i % cols) * w, Math.floor(i / cols) * h, w, h));
      return c.toDataURL('image/png');
    }, res.out);
    writeFileSync(`${OUT}anims7-${tag}-${name}.png`, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log('wrote', name, JSON.stringify(res.log[Math.floor(res.log.length / 2)]));
  }
  writeFileSync(`${OUT}anims7-${tag}-states.json`, JSON.stringify(states));
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
