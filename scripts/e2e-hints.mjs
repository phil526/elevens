// Browser check for Settings "Button hints" (19 Nov 2026): the bar of button hints along the bottom of
// the match screen shows by default and hides when the setting is turned Off from the pause menu.
// Usage: npm run build && node scripts/e2e-hints.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8797), BASE = `http://127.0.0.1:${PORT}`;
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
  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  await p.click('[data-a=quick]');
  const guide = () => p.evaluate(() => { const g = document.querySelector('.guide'); return g ? { shown: getComputedStyle(g).display !== 'none', text: g.textContent } : null; });
  await p.waitForFunction(() => { const g = document.querySelector('.guide'); return g && getComputedStyle(g).display !== 'none'; }, null, { timeout: 60000 }).catch(() => {});
  // Press a key so the guide follows the keyboard.
  await p.keyboard.down('d'); await sleep(400); await p.keyboard.up('d');
  const g1 = await guide();
  check('hints show by default in a match', g1?.shown && /Pass|Tackle/.test(g1.text), g1?.text?.slice(0, 60));
  await p.screenshot({ path: `${OUT}hints-on.png` });
  await p.keyboard.down('Escape'); await sleep(400); await p.keyboard.up('Escape');
  await p.waitForSelector('[data-a=settings]', { timeout: 10000 });
  await p.click('[data-a=settings]');
  await p.waitForSelector('[data-seg=chints]');
  const label = await p.evaluate(() => document.querySelector('[data-seg=chints]')?.closest('.row')?.querySelector('.lbl')?.textContent);
  check('Settings has a Button hints On/Off row', /^Button hints/.test(label ?? ''), label);
  await p.click('[data-seg=chints] button[data-v=off]');
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('elevens.settings.v1')).controlHints);
  check('turning it Off is saved', saved === false, String(saved));
  // Back out of settings (Done) and the pause menu (Resume).
  await p.click('[data-a=back]');
  await p.waitForSelector('[data-a=resume]', { timeout: 10000 });
  await p.click('[data-a=resume]');
  await p.waitForFunction(() => !document.querySelector('[data-a=resume]'), null, { timeout: 10000 }).catch(() => {});
  await p.keyboard.down('d'); await sleep(1200); await p.keyboard.up('d');
  const g2 = await guide();
  check('hints are hidden in the match after turning them Off', g2 && !g2.shown, JSON.stringify(g2?.shown));
  await p.screenshot({ path: `${OUT}hints-off.png` });
  // And stay hidden after a reload.
  await p.goto(`${BASE}/?test`);
  await p.waitForSelector('[data-a=quick]');
  await p.click('[data-a=quick]');
  await sleep(8000);
  await p.keyboard.down('d'); await sleep(800); await p.keyboard.up('d');
  const g3 = await guide();
  const bug = await p.evaluate(() => document.querySelector('.scorebug')?.textContent ?? '');
  check('still hidden in the next match', g3 && !g3.shown && bug.length > 0, `shown ${g3?.shown}, score bug "${bug.slice(0, 30)}"`);
  await p.screenshot({ path: `${OUT}hints-off-next.png` });
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
