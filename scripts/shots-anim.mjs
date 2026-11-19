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
  ['jog', 5.8, null, 12, 1 / 30],
  ['walk', 1.7, null, 12, 1 / 15],
  ['walkout', 1.6, null, 12, 1 / 15], // tunnel walk-out pace (cinematic.ts INTRO.walkSpeed)
  ['ramp', -1, null, 16, 1 / 10], // standing start up to a full sprint
  ['sprint', 8.6, null, 12, 1 / 30],
  ['dribble', 6.2, null, 12, 1 / 30],
  ['slide', 0, { type: 'slide', dur: 0.7 }, 16, 0.1], // then the stumble (getting up) after 0.7 s
  // Captured one-shots (17 Nov 2026): keeper leap to his right and to his left, jumping catch, header, celebration.
  ['saveR', 0, { type: 'dive', dur: 0.75, target: { x: 0, y: 1.4, z: 22.2 } }, 12, 0.11], // then 'down' for 0.55 s
  ['saveL', 0, { type: 'dive', dur: 0.75, target: { x: 0, y: 1.4, z: 17.8 } }, 12, 0.11],
  ['saveLow', 0, { type: 'dive', dur: 0.75, target: { x: 0, y: 0.3, z: 22.6 } }, 12, 0.11],
  ['saveFar', 0, { type: 'dive', dur: 0.75, target: { x: 0, y: 2.1, z: 16.6 } }, 12, 0.11],
  ['catch', 0, { type: 'dive', dur: 0.75, target: { x: 0, y: 2.2, z: 20 } }, 12, 0.11],
  ['header', 0, { type: 'header', dur: 0.45 }, 8, 0.06],
  ['celebrate', 0, { type: 'celebrate', dur: 3.2 }, 12, 0.25],
  // 18 Nov 2026: header heights and styles, kick styles, throw-in, dribbling arms.
  ['headStoop', 0, { type: 'header', dur: 0.45, ballY: 1.0 }, 8, 0.06],
  ['headStand', 0, { type: 'header', dur: 0.45, ballY: 1.6 }, 8, 0.06],
  ['headFlick', 0, { type: 'header', dur: 0.45, ballY: 2.3, bvx: -6 }, 8, 0.06],
  ['headGlance', 0, { type: 'header', dur: 0.45, ballY: 2.3, bvx: 4, bvz: 6 }, 8, 0.06],
  ['shotNormal', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.6 }, 12, 0.05],
  ['shotPower', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.95 }, 12, 0.05],
  ['shotFinesse', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.6, placed: true }, 12, 0.05],
  ['shotChip', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.5, variant: 'chip' }, 12, 0.05],
  ['volley', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.7, ballY: 0.8 }, 12, 0.05],
  ['pass', 0, { type: 'kick', kind: 'pass', dur: 0.38, power: 0.5 }, 12, 0.05],
  ['leftFoot', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.7, ballSide: 0.3 }, 12, 0.05],
  ['runup', 0, { type: 'kick', kind: 'shot', dur: 0.43, power: 0.9, runup: true }, 16, 0.06],
  ['throwin', 0, { type: 'throwin', dur: 0.38 }, 12, 0.06],
  ['dribbleArms', 4.2, null, 12, 1 / 20],
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
  for (const [name, speed, action, n, dt] of MOTIONS.filter((m) => !process.env.ANIM_ONLY || process.env.ANIM_ONLY.split(',').includes(m[0]))) {
    const frames = await page.evaluate(([name, speed, action, n, dt, view]) => {
      const process_view = view;
      const THREE_V = (x, y, z) => ({ x, y, z, clone() { return this; } });
      const r = window.__elevens.renderer;
      const v = window.__elevens.session.view();
      const id = 9;
      const m = r.players[id];
      const base = v.players[id];
      // Stand the model in an empty spot, facing +x, and hide everyone else.
      r.players.forEach((q, i) => q.setVisible(i === id));
      const p = JSON.parse(JSON.stringify(base));
      p.pos = { x: 0, z: 20 }; p.facing = 0; p.vel = { x: speed, z: 0 }; p.sprinting = speed > 7.5; p.jockeying = false;
      p.action = action && action.type !== 'kick' && action.type !== 'throwin' ? { ...action, t: 0 } : { type: 'none', t: 0, dur: 0 };
      const ball = new (r.scene.position.constructor)(0, 0.11, 20);
      const out = [];
      const cam = r.camera.cam;
      cam.fov = 30; cam.updateProjectionMatrix();
      // Warm up so blends settle (runs at the motion's speed for a second).
      const run = action?.type === 'slide' ? 6 : action?.type === 'kick' && !action.runup ? 3 : action || speed < 0 ? 0 : speed;
      p.vel = { x: run, z: 0 };
      m.dribbling = name.startsWith('dribble');
      m.holdThrow = action?.type === 'throwin';
      if (action?.ballY) ball.y = action.ballY;
      if (action?.type === 'header') m.ballVel.set(action.bvx ?? 8, 2, action.bvz ?? 0);
      { const a0 = p.action; p.action = { type: 'none', t: 0, dur: 0 }; m.update(p, 1 / 30, 0, false, ball); p.action = a0; } // a fresh start for each motion
      for (let i = 0; i < 30; i++) { p.pos.x += run * (1 / 30); m.update(p, 1 / 30, i / 30, false, ball); }
      // Kicks: the run-up motion jogs in from 3 m before striking; the others are struck from a slow approach.
      const kickAt = action?.runup ? 0.42 : 0;
      for (let i = 0; i < n; i++) {
        if (action && action.type === 'kick') {
          const t = i * dt - kickAt;
          if (t < 0) { const v = Math.min(5, 1.2 + 7 * (i * dt)); p.vel = { x: v, z: 0 }; p.pos.x += v * dt; p.action = { type: 'none', t: 0, dur: 0 }; }
          else {
            if (!p.action || p.action.type !== 'kick') { ball.set(p.pos.x + 0.55, action.ballY ?? 0.11, 20 + (action.ballSide ?? -0.15)); p.action = { ...action, t: 0, target: { x: p.pos.x + 20, y: 0, z: 20 + (action.ballSide ? -2 : 0) } }; }
            p.action.t = t; p.vel = { x: Math.max(0, 2 - t * 6), z: 0 }; p.pos.x += p.vel.x * dt;
          }
          if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.copy(ball); }
        } else if (action && action.type === 'throwin') {
          const t = i * dt - 0.24;
          m.holdThrow = t < 0;
          p.action = t < 0 ? { type: 'none', t: 0, dur: 0 } : { type: 'throw', kind: 'throw', t, dur: 0.38 };
          p.vel = { x: 0, z: 0 };
          const bp = ball.clone ? ball : ball; bp.set(p.pos.x + 0.3, 2.0, 20);
          if (m.throwBallPos) m.throwBallPos(bp, dt);
        } else if (action) {
          const t = i * dt;
          // Slide for 0.7 s (fast along facing, slowing), then 0.9 s getting up, as in the simulation.
          if (action.type === 'slide') p.action = t < 0.7 ? { type: 'slide', t, dur: 0.7 } : { type: 'stumble', t: t - 0.7, dur: 0.9 };
          else if (action.type === 'dive') {
            p.action = t < 0.75 ? { ...action, t, start: { x: 0, z: 20 } } : { type: 'down', t: t - 0.75, dur: 0.55 };
            // Body travel as in keeper.ts (most of the way to the save, leaving an arm's length).
            const len = Math.abs(action.target.z - 20), slide = Math.min(len, Math.max(1.1, len - 1.05), 2.8);
            p.pos = { x: 0, z: 20 + Math.sign(action.target.z - 20) * slide * Math.min(1, t / 0.35) };
            if (i === 0) { ball.set(action.target.x, action.target.y, action.target.z); if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.set(action.target.x, action.target.y, action.target.z); } }
          }
          else if (action.type === 'header') p.action = t < 0.45 ? { ...action, t } : { type: 'none', t: 0, dur: 0 };
          else p.action = { ...action, t: 0 }; // celebrations keep t at 0 in the simulation
          if (action.type === 'header' && i === 0) ball.y = action.ballY ?? 2.3;
          const v = action.type === 'slide' && t < 0.7 ? 7.5 * Math.max(0, 1 - t / 0.5) : 0;
          p.vel = { x: v, z: 0 }; p.pos.x += v * dt;
        } else if (speed < 0) { const v = Math.min(8.6, i * 0.6); p.vel = { x: v, z: 0 }; p.sprinting = v > 7; p.pos.x += v * dt; }
        else p.pos.x += speed * dt;
        m.update(p, dt, 1 + i * dt, false, ball);
        // ANIM_VIEW=front: three-quarter view from ahead of the player instead of side on.
        if (action && action.type === 'dive') { const zc = (20 + action.target.z) / 2; cam.position.set(12, 1.1, zc); cam.lookAt(0, 0.9, zc); }
        else if (action && action.type === 'celebrate') { cam.position.set(p.pos.x + 8, 1.2, 20); cam.lookAt(p.pos.x, 1.0, 20); }
        else if (action && action.type === 'throwin') { if (r.ballRoot) { r.ballRoot.visible = true; r.ballRoot.position.copy(ball); } cam.position.set(p.pos.x + 1.5, 1.3, 20 + 6); cam.lookAt(p.pos.x, 1.2, 20); }
        else if (action && action.type === 'kick') { cam.position.set(p.pos.x + (process_view === 'front' ? 4 : 0), 1.1, 20 + (process_view === 'front' ? 3 : 7)); cam.lookAt(p.pos.x, 0.8, 20); }
        else if (action && action.type !== 'slide') { cam.position.set(p.pos.x, 1.2, 20 + 8); cam.lookAt(p.pos.x, 1.05, 20); }
        else if (view === 'back') { cam.position.set(p.pos.x - 5.5, 1.55, 20.4); cam.lookAt(p.pos.x, 0.95, 20); }
        else if (view === 'ahead') { cam.position.set(p.pos.x + 5.5, 1.45, 20.4); cam.lookAt(p.pos.x, 0.95, 20); }
        else if (view === 'front') { cam.position.set(p.pos.x + 4.6, 1.3, 20 + 4.6); cam.lookAt(p.pos.x, 0.55, 20); }
        else { cam.position.set(p.pos.x + (action ? 0.3 : 0), action ? 0.9 : 1.0, 20 + 6.5); cam.lookAt(p.pos.x + (action ? 0.3 : 0), action ? 0.6 : 0.85, 20); }
        r.renderer.render(r.scene, cam);
        out.push(r.renderer.domElement.toDataURL('image/png'));
      }
      void THREE_V;
      return out;
    }, [name, speed, action, n, dt, view]);
    // Stitch into one sheet in the browser: crop the middle of each frame.
    const sheet = await page.evaluate(async ([frames, wide]) => {
      const imgs = await Promise.all(frames.map((src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; })));
      const w = wide ? 400 : 240, h = 300, c = document.createElement('canvas'); c.width = w * imgs.length; c.height = h;
      const g = c.getContext('2d');
      imgs.forEach((im, i) => g.drawImage(im, (im.width - w * (im.width / 640)) / 2, (im.height - h * (im.height / 480)) / 2, w * (im.width / 640), h * (im.height / 480), i * w, 0, w, h));
      return c.toDataURL('image/png');
    }, [frames, action?.type === 'dive']);
    writeFileSync(`${OUT}anim-${tag}-${name}.png`, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log('wrote', `anim-${tag}-${name}.png`);
  }
} finally {
  await browser.close();
  server.kill();
  console.log('errors', errors);
}
