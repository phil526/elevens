// Kits that react to the weather and the match (render/wear.ts + realplayer.ts kit shader):
// close-ups of the same players plain, soaked, with snow on the shoulders, in cold-weather gear
// (long sleeves, gloves, tights), and late in the match (shirt out, socks down).
// Usage: npm run build && node scripts/shots-kitweather.mjs <outdir> [preset] [looks] [query]
//   looks: comma list of base,rain,snow,cold,late,all (default all of them)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = (process.argv[2] ?? new URL('./out/kitweather/', import.meta.url).pathname).replace(/\/?$/, '/'); mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'medium';
const LOOKS = {
  base: { wear: { soak: 0, snow: 0, untucked: 0, socks: 0 }, gear: { sleeves: 0, gloves: 0, tights: 0 } },
  rain: { wear: { soak: 1, snow: 0, untucked: 0, socks: 0 }, gear: { sleeves: 0, gloves: 0, tights: 0 } },
  snow: { wear: { soak: 0, snow: 0.8, untucked: 0, socks: 0 }, gear: { sleeves: 0, gloves: 0, tights: 0 } },
  cold: { wear: { soak: 0, snow: 0, untucked: 0, socks: 0 }, gear: { sleeves: 1, gloves: 1, tights: 1 } },
  late: { wear: { soak: 0, snow: 0, untucked: 1, socks: 1 }, gear: { sleeves: 0, gloves: 0, tights: 0 } },
  all: { wear: { soak: 0.6, snow: 0.5, untucked: 1, socks: 1 }, gear: { sleeves: 1, gloves: 1, tights: 1 } },
};
const want = (process.argv[4] ?? Object.keys(LOOKS).join(',')).split(',');
const query = process.argv[5] ?? '';
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { errors: [], info: {} };
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([p]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'day', players: 'realistic', autoRes: false }, matchIntro: false, tvGraphics: false, controlHints: false })), [preset]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); });
  await page.goto(`${BASE}/?test${query}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
  await sleep(1500);
  // Two players standing next to each other at kick-off, filmed full length from the front and the back.
  const pick = await page.evaluate((id) => {
    const v = window.__elevens.session.view();
    const ps = v.players.filter((p) => !p.off && p.role !== 'GK');
    ps.sort((a, b) => Math.hypot(a.pos.x, a.pos.z) - Math.hypot(b.pos.x, b.pos.z));
    const a = id !== null ? v.players[id] : ps[0];
    return { a: a.id, mid: [a.pos.x, a.pos.z], facing: a.facing, team: a.team, name: a.def.name };
  }, process.env.PLAYER ? Number(process.env.PLAYER) : null);
  report.info.pick = pick;
  // Hold the match still (kick-off would otherwise start and the players run off) and hide the HUD.
  await page.evaluate(() => { window.__elevens.session.pause(true); for (const el of document.querySelectorAll('#hud, .touch-layer')) el.style.display = 'none'; });
  for (const look of want) {
    await page.evaluate((k) => { window.__elevens.renderer.kitTest = k; }, LOOKS[look]);
    for (const side of ['front', 'back', 'top']) {
      const f = pick.facing + (side === 'back' ? Math.PI : 0);
      const dx = Math.cos(f), dz = Math.sin(f);
      const pos = side === 'top' ? [pick.mid[0] + dx * 1.6, 2.9, pick.mid[1] + dz * 1.6] : [pick.mid[0] + dx * 3.3, 1.15, pick.mid[1] + dz * 3.3];
      await page.evaluate(([p, l]) => { window.__elevens.renderer.viewOverride = { pos: p, look: l }; }, [pos, [pick.mid[0], side === 'top' ? 1.35 : 0.92, pick.mid[1]]]);
      await sleep(1600);
      await page.screenshot({ path: `${OUT}${preset}-${look}-${side}.png`, timeout: 120000 });
    }
  }
} catch (e) { report.errors.push(String(e?.stack ?? e)); }
await browser.close(); server.kill();
writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.errors.length ? 1 : 0);
