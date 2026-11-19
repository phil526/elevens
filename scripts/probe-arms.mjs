// Probe: arm bone directions of a walking realistic player, in the player's frame.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
await ctx.addInitScript(() => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'medium', renderScale: 1, shadows: false, players: 'realistic' } })));
const page = await ctx.newPage();
await page.goto(`${BASE}/?test`);
await page.waitForSelector('[data-a=quick]');
await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
for (let i = 0; i < 100; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
for (let i = 0; i < 60; i++) { if (await page.evaluate(() => window.__elevens.renderer.players.some((p) => p.solver))) break; await sleep(500); }
await page.evaluate(() => { const a = window.__elevens; a.session.paused = true; a.renderer.render = () => {}; });
const configs = JSON.parse(process.env.CONFIGS ?? '[null]');
let k = 0;
for (const cfg of configs) {
  window_cfg: {
    const res = await page.evaluate(([cfg, shots]) => {
      if (cfg) globalThis.__walkArms = cfg; else delete globalThis.__walkArms;
      const r = window.__elevens.renderer; const v = window.__elevens.session.view();
      const id = 9, m = r.players[id];
      r.players.forEach((q, i) => q.setVisible(i === id));
      const p = JSON.parse(JSON.stringify(v.players[id]));
      p.pos = { x: 0, z: 20 }; p.facing = 0; p.vel = { x: 1.6, z: 0 }; p.sprinting = false; p.jockeying = false; p.action = { type: 'none', t: 0, dur: 0 };
      const V = r.scene.position.constructor;
      const ball = new V(0, 0.11, 60);
      for (let i = 0; i < 40; i++) { p.pos.x += 1.6 / 30; m.update(p, 1 / 30, i / 30, false, ball); }
      const names = []; m.root.traverse((o) => { if (o.isBone && /Left(Arm|ForeArm|Hand)/.test(o.name)) names.push(o.name); });
      const wp = (n) => { const o = m.root.getObjectByName(n); return o.getWorldPosition(new V()); };
      const fmt = (a) => a.map((x) => x.toFixed(2)).join(',');
      const out = [];
      const cam = r.camera.cam; cam.fov = 30; cam.updateProjectionMatrix();
      const imgs = [];
      for (let i = 0; i < 8; i++) {
        p.pos.x += 1.6 / 15; m.update(p, 1 / 15, 2 + i / 15, false, ball);
        m.root.updateMatrixWorld(true);
        const row = {};
        for (const s of ['Left', 'Right']) {
          const sh = wp(s + 'Arm'), el = wp(s + 'ForeArm'), wr = wp(s + 'Hand');
          const ua = el.clone().sub(sh).normalize(), fa = wr.clone().sub(el).normalize();
          // player frame: forward +x, up +y, right +z
          const mid = m.root.getObjectByName(s + 'HandMiddle1') ?? m.root.getObjectByName(s + 'HandIndex1');
          const th = m.root.getObjectByName(s + 'HandThumb1');
          let thumb = null; if (th) thumb = th.getWorldPosition(new V()).sub(wr).normalize();
          row[s] = { ua: fmt([ua.x, ua.y, ua.z]), fa: fmt([fa.x, fa.y, fa.z]), thumb: thumb ? fmt([thumb.x, thumb.y, thumb.z]) : null, phase: m.phase?.toFixed(2) };
        }
        out.push(row);
        if (shots) for (const [cx, cz] of [[-2.2, 20.15], [2.2, 20.15], [0.1, 22.2]]) { cam.position.set(p.pos.x + cx, 1.1, cz); cam.lookAt(p.pos.x + cx * 0.02, 0.95, 20); r.renderer.render(r.scene, cam); imgs.push(r.renderer.domElement.toDataURL('image/jpeg', 0.8)); }
      }
      return { names, out, imgs };
    }, [cfg, !!process.env.SHOTS]);
    console.log('CONFIG', JSON.stringify(cfg), 'bones', res.names.join(' '));
    for (const row of res.out) console.log(JSON.stringify(row));
    if (res.imgs.length) {
      const sheet = await page.evaluate(async (frames) => {
        const ims = await Promise.all(frames.map((src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; })));
        const w = 200, h = 300, c = document.createElement('canvas'); c.width = w * 8; c.height = h * 3; const g = c.getContext('2d');
        ims.forEach((im, i) => g.drawImage(im, 220, 60, 200, 300, Math.floor(i / 3) * w, (i % 3) * h, w, h));
        return c.toDataURL('image/jpeg', 0.85);
      }, res.imgs);
      writeFileSync(`scripts/out/probe-${k}.jpg`, Buffer.from(sheet.split(',')[1], 'base64'));
    }
    k++;
  }
}
await browser.close(); server.kill();
