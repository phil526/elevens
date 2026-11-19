// Contact sheets of the movement detail added 19 Nov 2026 (render/motion.ts): cuts, braking and
// starting, turning on the spot, planted feet, tackle styles, falls, first touches, dribbling
// touches, shoulder checks, tired players and kick styles. Deterministic fixed-step frames.
// Usage: npm run build && node scripts/shots-motion.mjs [tag] [preset]   (MOTION_ONLY=a,b)
// Writes scripts/out/motion-<tag>-<name>.png.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const tag = process.argv[2] ?? 'now';
const preset = process.argv[3] ?? 'medium';
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
// [name, frames, dt]
const MOTIONS = [
  ['cut', 12, 1 / 20], ['brake', 14, 1 / 15], ['start', 14, 1 / 15], ['turnspot', 12, 1 / 20], ['slowwalk', 12, 1 / 12],
  ['tacklePoke', 10, 0.06], ['tackleBlock', 10, 0.06], ['tackleShoulder', 10, 0.06], ['block', 10, 0.065],
  ['fallForward', 16, 0.18], ['fallSide', 16, 0.18], ['stagger', 10, 0.06],
  ['chest', 10, 0.065], ['thigh', 10, 0.055], ['cushion', 10, 0.04], ['flick', 10, 0.04],
  ['touch', 12, 1 / 30], ['push', 12, 1 / 30],
  ['scan', 10, 0.06], ['restKnees', 8, 0.3], ['restBreathe', 8, 0.3], ['tiredJog', 12, 1 / 30],
  ['backheel', 12, 0.05], ['toePoke', 12, 0.05], ['outside', 12, 0.05],
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
      const id = name === 'restKnees' ? 10 : 9;
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
      const S = {
        cut: { warm: 6, step(t) { const ang = t < 0.15 ? 0 : Math.min(1.2, (t - 0.15) * 12); p.vel = { x: 6 * Math.cos(ang), z: 6 * Math.sin(ang) }; p.facing = ang; }, cam: 'side' },
        brake: { warm: 8, step(t) { const sp = Math.max(0, 8 - t * 11); p.vel = { x: sp, z: 0 }; } },
        start: { warm: 0, step(t) { const sp = Math.min(7, Math.max(0, t - 0.1) * 6); p.vel = { x: sp, z: 0 }; } },
        turnspot: { warm: 0, step(t) { p.vel = { x: 0, z: 0 }; p.facing = Math.min(Math.PI, Math.max(0, t - 0.05) * 6); }, cam: 'high' },
        slowwalk: { warm: 0.5, step() { p.vel = { x: 0.5, z: 0 }; } },
        tacklePoke: { warm: 3, step(t) { if (t === 0) { ball.set(p.pos.x + 1.5, 0.11, 20.1); m.foe = { x: p.pos.x + 1.9, z: 20.1, vx: -2, vz: 0 }; } p.action = { type: 'tackle', t, dur: 0.5 }; p.vel = { x: t < 0.22 ? 3 : 0.5, z: 0 }; } },
        tackleBlock: { warm: 2, step(t) { if (t === 0) { ball.set(p.pos.x + 0.7, 0.11, 20.05); m.foe = { x: p.pos.x + 1.1, z: 20, vx: -4, vz: 0 }; } p.action = { type: 'tackle', t, dur: 0.5 }; p.vel = { x: t < 0.22 ? 2 : 0.3, z: 0 }; } },
        tackleShoulder: { warm: 6, step(t) { if (t === 0) { ball.set(p.pos.x + 0.7, 0.11, 20.6); m.foe = { x: p.pos.x + 0.2, z: 20.8, vx: 6, vz: 0 }; } p.action = { type: 'tackle', t, dur: 0.5 }; p.vel = { x: 6, z: 0 }; }, cam: 'front' },
        block: { warm: 0, step(t, i) { if (i === 0) { ball.set(p.pos.x + 0.6, 0.3, 20.4); m.play({ kind: 'block', t: 0, dur: 0.6, side: 1, k: 1 }); } }, cam: 'front' },
        fallForward: { warm: 5, step(t, i) { if (i === 0) m.onFouled({ x: p.pos.x - 1, z: 20 }); p.action = t < 0.9 ? { type: 'stumble', t, dur: 0.9 } : none(); p.vel = { x: t < 0.3 ? 5 * (1 - t / 0.3) : 0, z: 0 }; }, cam: 'wide' },
        fallSide: { warm: 4, step(t, i) { if (i === 0) m.onFouled({ x: p.pos.x, z: 19 }); p.action = t < 0.9 ? { type: 'stumble', t, dur: 0.9 } : none(); p.vel = { x: t < 0.3 ? 4 * (1 - t / 0.3) : 0, z: 0 }; }, cam: 'wide' },
        stagger: { warm: 5, step(t, i) { if (i === 0) m.play({ kind: 'stagger', t: 0, dur: 0.55, side: 1, k: 1 }); p.vel = { x: 4, z: 0 }; }, cam: 'front' },
        chest: { warm: 0.6, step(t, i) { if (i === 0) m.play({ kind: 'chest', t: 0, dur: 0.6, side: 1, k: 1 }); ball.set(p.pos.x + 0.35, Math.max(0.11, 1.35 - t * 1.6), 20); p.vel = { x: 0.6, z: 0 }; } },
        thigh: { warm: 0.6, step(t, i) { if (i === 0) m.play({ kind: 'thigh', t: 0, dur: 0.48, side: 1, k: 1 }); ball.set(p.pos.x + 0.4, Math.max(0.11, 0.75 - t * 1.2), 20.12); p.vel = { x: 0.6, z: 0 }; } },
        cushion: { warm: 1, step(t, i) { if (i === 0) m.play({ kind: 'cushion', t: 0, dur: 0.36, side: 1, k: 1 }); ball.set(p.pos.x + 0.45, 0.11, 20.1); p.vel = { x: 1, z: 0 }; } },
        flick: { warm: 1, step(t, i) { if (i === 0) m.play({ kind: 'flick', t: 0, dur: 0.34, side: 1, k: 1 }); ball.set(p.pos.x + 0.45, 0.11, 20.1 + Math.max(0, t - 0.1) * 4); p.vel = { x: 1, z: 0 }; }, cam: 'front' },
        touch: { warm: 5.5, step(t, i) { m.dribbling = true; if (i === 3) m.play({ kind: 'touch', t: 0, dur: 0.22, side: m.swingSide, k: 1 }); p.vel = { x: 5.5, z: 0 }; ball.set(p.pos.x + 0.6, 0.11, 20); } },
        push: { warm: 8, step(t, i) { m.dribbling = true; p.sprinting = true; if (i === 3) m.play({ kind: 'push', t: 0, dur: 0.34, side: m.swingSide, k: 1 }); p.vel = { x: 8, z: 0 }; ball.set(p.pos.x + 0.6 + Math.max(0, t - 0.1) * 3, 0.11, 20); } },
        scan: { warm: 1, step(t, i) { m.scanCue = i === 1 ? 2 : 0; ball.set(p.pos.x + 12, 0.11, 26); p.vel = { x: 1, z: 0 }; }, cam: 'head' },
        restKnees: { warm: 0, step() { m.tired = 0.9; m.resting = true; p.vel = { x: 0, z: 0 }; ball.set(30, 0.11, 0); }, cam: 'front' },
        restBreathe: { warm: 0, step() { m.tired = 0.9; m.resting = true; p.vel = { x: 0, z: 0 }; ball.set(30, 0.11, 0); }, cam: 'front' },
        tiredJog: { warm: 5, step() { m.tired = 1; p.vel = { x: 5, z: 0 }; } },
        backheel: { warm: 1.5, kick: { kind: 'pass', dur: 0.38, power: 0.5 }, aim: { x: -15, z: 20 } },
        toePoke: { warm: 1.5, kick: { kind: 'shot', dur: 0.43, power: 0.7 }, aim: { x: 40, z: 20 }, ballOff: 1.95 },
        outside: { warm: 1.5, kick: { kind: 'pass', dur: 0.38, power: 0.5 }, aim: { x: 10, z: 32 } },
      }[name];
      warm = S.warm; camMode = S.cam ?? 'side';
      p.vel = { x: warm, z: 0 };
      if (name === 'restKnees' || name === 'restBreathe') { m.tired = 0.9; }
      for (let i = 0; i < 40; i++) { p.pos.x += p.vel.x / 30; p.pos.z += p.vel.z / 30; m.update(p, 1 / 30, i / 30, false, ball); }
      const out = [], log = [];
      for (let i = 0; i < n; i++) {
        const t = i * dt;
        if (S.kick) {
          if (i === 0) { ball.set(p.pos.x + (S.ballOff ?? 0.55), 0.11, 20 - 0.15); m.aimHint = S.aim; }
          p.action = { type: 'kick', ...S.kick, t }; p.vel = { x: Math.max(0, 1.5 - t * 5), z: 0 };
          const wind = S.kick.kind === 'shot' ? 0.25 : 0.2;
          if (t >= wind) { const dx = S.aim.x - p.pos.x, dz = S.aim.z - p.pos.z, d = Math.hypot(dx, dz); m.ballVel.set(dx / d * 14, 0.5, dz / d * 14); }
        } else S.step(t, i);
        p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
        m.update(p, dt, 1 + t, false, ball);
        if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.copy(ball); }
        log.push(m.motionState);
        const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
        if (camMode === 'front') { cam.position.set(p.pos.x + 4.2, 1.3, p.pos.z + 4.2); cam.lookAt(p.pos.x, 0.7, p.pos.z); }
        else if (camMode === 'high') { cam.position.set(p.pos.x + 3.5, 3.2, p.pos.z + 3.5); cam.lookAt(p.pos.x, 0.3, p.pos.z); }
        else if (camMode === 'chase') { cam.position.set(p.pos.x - fx * 5 + 3, 1.8, p.pos.z - fz * 5 + 3); cam.lookAt(p.pos.x, 0.7, p.pos.z); }
        else if (camMode === 'head') { cam.position.set(p.pos.x + 4.5, 1.7, p.pos.z + 1.5); cam.lookAt(p.pos.x, 1.4, p.pos.z); }
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
    writeFileSync(`${OUT}motion-${tag}-${name}.png`, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log('wrote', name, JSON.stringify(res.log[Math.floor(res.log.length / 2)]));
  }
  writeFileSync(`${OUT}motion-${tag}-states.json`, JSON.stringify(states));
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
