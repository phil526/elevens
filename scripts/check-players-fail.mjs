// Check: with the realistic player files blocked (BLOCK=models/ Q=?test), Kick off must still reach the match.
// Usage: npm run build && BLOCK=models/ Q=?test CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/check-players-fail.mjs
import { chromium } from 'playwright-core';
const PORT = 8811, BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
if (process.env.BLOCK) await page.route(new RegExp(process.env.BLOCK), (r) => r.abort());
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
page.on('pageerror', (e) => console.log(ts(), 'PAGEERROR', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) || process.env.ALL) console.log(ts(), m.type(), m.text().slice(0, 300)); });
page.on('requestfailed', (r) => console.log(ts(), 'REQFAIL', r.url(), r.failure()?.errorText));
await page.goto(BASE + '/' + (process.env.Q ?? ''));
await page.waitForSelector('[data-a=quick]', { timeout: 60000 });
console.log(ts(), 'menu ready');
await sleep(Number(process.env.MENUWAIT ?? 1000));
await page.evaluate(() => document.querySelector('[data-a=quick]').click()); console.log(ts(), 'clicked');
for (let i = 0; i < Number(process.env.SECS ?? 60); i++) {
  await sleep(1000);
  const s = await page.evaluate(() => { const a = window.__elevens; const v = a?.session?.view?.(); return { screen: a?.screenName, phase: v?.phase, clock: v?.clock && Math.round(v.clock), ui: (document.querySelector('#ui')?.innerText ?? document.body.innerText).replace(/\s+/g, ' ').slice(0, 140) }; });
  console.log(ts(), JSON.stringify(s));
  if (s.phase === 'play' && i > 5) break; if (i % 15 === 14) await page.screenshot({ path: `scripts/out/pc-${i}.png` });
}
await page.screenshot({ path: process.env.SHOT ?? 'scripts/out/pc.png' });
await browser.close(); server.kill();
