// Checks the 20 Nov 2026 keyboard default move in the built game: old default keys move to the new
// layout once (on a normal page, not ?test), a changed table is kept.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.E2E_PORT ?? 8797), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.on('data', (d) => /listen|ready|http/i.test(String(d)) && r()));
const OLD = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'], pass: ['KeyJ'], shoot: ['KeyK', 'Space'], lob: ['KeyL'], through: ['KeyI'],
  jockey: ['KeyE'], switch: ['KeyQ'], skill: ['KeyU'], close: ['KeyC'], teamPress: ['KeyR'], trap: ['KeyT'], keeper: ['KeyG'], plan: ['KeyY'], pause: ['KeyP'], help: ['KeyH'],
};
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + info}`); if (!ok) fails++; };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const run = async (saved) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); if (s) localStorage.setItem('elevens.settings.v1', JSON.stringify(s)); } }, saved);
    const page = await ctx.newPage();
    // A normal page (one-time moves are skipped on ?test pages): read the Keyboard tab of Controls.
    const read = async () => {
      await page.waitForSelector('[data-a=controls]', { timeout: 90000 });
      await page.click('[data-a=controls]');
      await page.waitForSelector('[data-seg=ctab]');
      await page.click('[data-seg=ctab] [data-v=keys]');
      await page.waitForSelector('[data-bind=shoot][data-slot="0"]');
      return page.evaluate(() => Object.fromEntries(['shoot', 'lob', 'through', 'switch', 'up'].map((a) => [a, [0, 1].map((i) => document.querySelector(`[data-bind=${a}][data-slot="${i}"]`)?.textContent?.trim() ?? '').filter((t) => t && t !== '+' && t !== 'none' && t !== '·').join()])));
    };
    await page.goto(`${BASE}/`);
    const keys = await read();
    await page.reload();
    const after = await read();
    await ctx.close();
    return { keys, after };
  };
  const gfx = { graphics: { preset: 'low', players: 'classic' } };
  const a = await run({ ...gfx, controls: { keys: OLD } });
  check('old default keys move to the new layout (L shoot, K lob, O through, I switch) and stay after a reload', a.keys.shoot === 'L' && a.keys.lob === 'K' && a.keys.through === 'O' && a.keys.switch === 'I' && JSON.stringify(a.after) === JSON.stringify(a.keys), JSON.stringify(a));
  const mine = { ...OLD, shoot: ['KeyM'], up: ['KeyW'] };
  const b = await run({ ...gfx, controls: { keys: mine } });
  check('a changed keyboard table is kept', b.keys.shoot === 'M' && b.keys.lob === 'L' && b.keys.switch === 'Q' && b.after.shoot === 'M', JSON.stringify(b));
  const c = await run(null);
  check('a new player starts on the new layout', c.keys.shoot === 'L' && c.keys.switch === 'I', JSON.stringify(c.keys));
  // Moved once only: a player who later puts Q back on switch keeps it.
  const d = await run({ ...gfx, keysNov20: true, controls: { keys: OLD } });
  check('the move happens once (flag set: old layout kept)', d.keys.shoot === 'K,Space', JSON.stringify(d.keys));
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
