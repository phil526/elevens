// Frame-by-frame contact sheets of the player animations, rendered deterministically
// (the model is stepped with a fixed time step, independent of the slow software frame rate).
// Usage: npm run build && node scripts/shots-anim.mjs [tag] [preset]
// Writes scripts/out/anim-<tag>-<motion>.png: 12 frames per motion, side-on, left to right.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const tag = process.argv[2] ?? 'now';
const preset = process.argv[3] ?? 'medium';
const view = process.env.ANIM_VIEW ?? 'side';
const PORT = 8799, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
// Motions: [name, speed m/s, action, frames, dt]
const MOTIONS = [
  // [name, ballY at contact, ball speed, frames, dt]: the ball flies straight at the keeper, is caught, then held.
  ['catchScoop', 0.11, 9, 12, 0.08],
  ['catchKneel', 0.11, 16, 12, 0.09],
  ['catchWaist', 0.8, 14, 12, 0.07],
  ['catchChest', 1.3, 14, 12, 0.07],
  ['catchHead', 1.8, 14, 12, 0.07],
  ['catchHigh', 2.35, 10, 12, 0.08],
  ['catchSmother', 0.11, 3, 14, 0.1],
  ['throwOver', 0, 0, 12, 0.06],
  ['throwRoll', 0, 0, 12, 0.06],
  ['diveCollapse', 0.5, 0, 12, 0.11],
  ['diveLow', 0.25, 0, 12, 0.11],
  ['diveFull', 1.2, 0, 12, 0.11],
  ['diveHigh', 2.2, 0, 12, 0.11],
  ['diveParry', 1.5, 0, 12, 0.11],
  ['diveCatch', 1.0, 0, 12, 0.11],
  ['parryStand', 1.4, 18, 10, 0.06],
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
  // Wait for the realistic models to replace the classic ones.
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
  await page.evaluate(() => {
    const a = window.__elevens; a.session.paused = true;
    const r = a.renderer; r.render = () => {}; // stop the live loop drawing over our frames
  });
  for (const [name, by, bs, n, dt] of MOTIONS.filter((m) => !process.env.ANIM_ONLY || process.env.ANIM_ONLY.split(',').includes(m[0]))) {
    const frames = await page.evaluate(([name, by, bs, n, dt]) => {
      const r = window.__elevens.renderer;
      const v = window.__elevens.session.view();
      const id = v.players.findIndex((q) => q.role === 'GK');
      const m = r.players[id];
      r.players.forEach((q, i) => q.setVisible(i === id));
      const p = JSON.parse(JSON.stringify(v.players[id]));
      p.pos = { x: 0, z: 20 }; p.facing = 0; p.vel = { x: 0, z: 0 }; p.sprinting = false; p.jockeying = false;
      p.action = { type: 'none', t: 0, dur: 0 };
      const ball = new (r.scene.position.constructor)(0, 0.11, 20);
      const cam = r.camera.cam;
      cam.fov = 30; cam.updateProjectionMatrix();
      const showBall = (pos) => { if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.copy(pos); } };
      m.ballFoe = false; m.ballVel.set(0, 0, 0);
      for (let i = 0; i < 30; i++) m.update(p, 1 / 30, i / 30, false, ball);
      const out = [];
      const dive = name.startsWith('dive');
      const lat = name === 'diveCollapse' ? 1.0 : name === 'diveHigh' ? 2.7 : name === 'diveParry' ? 2.3 : 2.4;
      for (let i = 0; i < n; i++) {
        const t = i * dt;
        let held = false;
        if (name.startsWith('catch') || name === 'parryStand') {
          // Contact 0.3 s in (frames before show the hands coming up to meet it).
          const tc = name === 'catchSmother' ? 0.1 : 0.3;
          const smother = name === 'catchSmother';
          if (t < tc) {
            const d = bs * (tc - t);
            ball.set(0.35 + d, by, 20);
            m.ballFoe = true; m.ballVel.set(-bs, 0, 0);
            p.action = { type: 'none', t: 0, dur: 0 };
            if (smother) { p.vel = { x: 4, z: 0 }; p.pos.x += 4 * dt; }
          } else if (name === 'parryStand') {
            if (p.action.type === 'none' && !m._parried) { m.onParry(by); m._parried = true; }
            ball.set(0.4 + (t - tc) * 8, by + (t - tc) * 3, 20 + (t - tc) * 4);
            m.ballFoe = false; m.ballVel.set(8, 3, 4);
          } else {
            m.ballFoe = false;
            if (smother) p.vel = { x: t - tc < 0.15 ? 4 : 0, z: 0 };
            p.action = t - tc < 0.35 ? { type: 'catch', t: t - tc, dur: 0.35 } : { type: 'none', t: 0, dur: 0 };
            held = true;
          }
        } else if (name.startsWith('throw')) {
          const variant = name === 'throwRoll' ? 'roll' : undefined;
          const w = variant ? 0.3 : 0.34;
          const tt = t - 0.06;
          p.action = tt < 0 ? { type: 'none', t: 0, dur: 0 } : { type: 'throw', kind: 'throw', variant, windup: w, t: tt, dur: w + 0.4 };
          held = tt < w;
          if (!held) { const f = tt - w; ball.set(p.pos.x + 0.5 + f * 14, variant ? 0.11 : Math.max(0.11, 2.0 + f * 4 - 4.9 * f * f), 20); }
        } else if (dive) {
          const target = { x: 0, y: by, z: 20 - lat };
          p.action = t < 0.75 ? { type: 'dive', t, dur: 0.75, target, start: { x: 0, z: 20 } } : { type: 'down', t: t - 0.75, dur: 0.55 };
          const len = lat, slide = Math.min(len, Math.max(1.1, len - 1.05), 2.8);
          p.pos = { x: 0, z: 20 - slide * Math.min(1, t / 0.35) };
          if (name === 'diveParry' && t >= 0.3 && !m._parried) { m.onParry(by); m._parried = true; }
          held = name === 'diveCatch' && t >= 0.3;
          if (!held) ball.set(target.x + (t < 0.3 ? (0.3 - t) * 20 : 0), target.y, target.z);
          if (name === 'diveParry' && t > 0.3) ball.set(target.x + (t - 0.3) * 6, target.y + (t - 0.3) * 4, target.z - (t - 0.3) * 3);
        }
        m.update(p, dt, 1 + i * dt, held, ball);
        if (held && m.heldBallPos) m.heldBallPos(ball);
        if (!held && name.startsWith('throw') && m.throwBallPos) m.throwBallPos(ball, dt);
        showBall(ball);
        if (dive) { const zc = 20 - lat / 2; cam.position.set(12, 1.1, zc); cam.lookAt(0, 0.9, zc); }
        else if (name.startsWith('throw')) { cam.position.set(p.pos.x + 1.0, 1.2, 20 + 7); cam.lookAt(p.pos.x + 0.3, 1.0, 20); }
        else { cam.position.set(p.pos.x + 3.5, 1.2, 20 + 6.5); cam.lookAt(p.pos.x, 0.95, 20); }
        r.renderer.render(r.scene, cam);
        out.push(r.renderer.domElement.toDataURL('image/png'));
      }
      m._parried = false;
      return out;
    }, [name, by, bs, n, dt]);
    // Stitch into one sheet in the browser: crop the middle of each frame.
    const sheet = await page.evaluate(async ([frames, wide]) => {
      const imgs = await Promise.all(frames.map((src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; })));
      const w = wide ? 400 : 240, h = 300, c = document.createElement('canvas'); c.width = w * imgs.length; c.height = h;
      const g = c.getContext('2d');
      imgs.forEach((im, i) => g.drawImage(im, (im.width - w * (im.width / 640)) / 2, (im.height - h * (im.height / 480)) / 2, w * (im.width / 640), h * (im.height / 480), i * w, 0, w, h));
      return c.toDataURL('image/png');
    }, [frames, name.startsWith('dive')]);
    writeFileSync(`${OUT}gk-${tag}-${name}.png`, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log('wrote', `gk-${tag}-${name}.png`);
  }
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
