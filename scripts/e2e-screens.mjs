// Layout audit (21 Nov 2026): every menu and match screen at phone, iPad and PC sizes, looking for
// text or buttons running off the screen, text cut off inside its box, buttons too small to tap on
// a touch screen, and buttons on top of each other. Screenshots go to scripts/out/screens-*.png.
// Usage: npm run build && node scripts/e2e-screens.mjs [phone|ipad|pc]   (CHROMIUM_PATH overrides the browser)

import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = 8831;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = {
  phone: { ...devices['Pixel 7'], viewport: { width: 412, height: 839 } },
  phoneLand: { ...devices['Pixel 7 landscape'] },
  ipad: { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
  pc: { viewport: { width: 1366, height: 768 } },
};
const only = process.argv[2];
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, matchIntro: false, tvGraphics: false, menuBackdrop: false });

const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = {};
let problems = 0;
const errors = [];

/** Runs in the page: what looks wrong on the screen now. */
function audit(touch) {
  const W = innerWidth, H = innerHeight;
  const out = { offscreen: [], clipped: [], small: [], overlap: [] };
  const desc = (el) => `${el.tagName.toLowerCase()}${el.dataset.a ? `[data-a=${el.dataset.a}]` : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.textContent || '').trim().slice(0, 40)}"`;
  const visible = (el) => { const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // Inside a box that scrolls sideways on purpose (wide tables), going past the edge is fine.
  const inHScroll = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth) return true; } return false; };
  const roots = [...document.querySelectorAll('#ui .screen, #hud, .touch-layer')].filter(visible);
  const els = roots.flatMap((r) => [...r.querySelectorAll('*')]).filter((el) => visible(el) && !el.closest('svg') && !el.closest('canvas') && !el.closest('.ui-ghosts'));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !inHScroll(el) && !el.closest('.radar') && el.closest('#ui, #hud, .touch-layer')) out.offscreen.push(`${desc(el)} x ${Math.round(r.left)}..${Math.round(r.right)} of ${W}`);
    const cs = getComputedStyle(el);
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && (el.textContent || '').trim()) out.clipped.push(`${desc(el)} ${el.scrollWidth}>${el.clientWidth}`);
  }
  const clickable = els.filter((el) => el.matches('button, input, select, a[href], [data-a], .bind, .seg button') && !el.disabled);
  if (touch) for (const el of clickable) { const r = el.getBoundingClientRect(); if (Math.min(r.width, r.height) < 30 && el.type !== 'range') out.small.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`); }
  // Only the part of a button actually on show counts (lists scroll inside their own boxes).
  const shown = (el) => {
    let r = el.getBoundingClientRect(); let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') { const q = p.getBoundingClientRect(); x0 = Math.max(x0, q.left); y0 = Math.max(y0, q.top); x1 = Math.min(x1, q.right); y1 = Math.min(y1, q.bottom); }
    }
    return { left: x0, top: y0, right: x1, bottom: y1 };
  };
  const rects = clickable.map((el) => [el, shown(el)]).filter(([, r]) => r.right - r.left > 2 && r.bottom - r.top > 2);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, ra] = rects[i], [b, rb] = rects[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 4 && h > 4) out.overlap.push(`${desc(a)} / ${desc(b)}`);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].slice(0, 12);
  return out;
}

for (const [sizeName, dev] of Object.entries(SIZES)) {
  if (only && !sizeName.startsWith(only)) continue;
  const touch = !!dev.hasTouch;
  const ctx = await browser.newContext(dev);
  await ctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${sizeName}: ${e.message}`));
  const M = (fn, a) => page.evaluate(fn, a);
  await page.goto(`${BASE}/?test`);
  await page.waitForFunction(() => !!document.querySelector('[data-a=quick]'), null, { timeout: 120000 });
  const look = async (name, go, wait = 350) => {
    try { await M(go); } catch (e) { report[`${sizeName}/${name}`] = { error: String(e.message).slice(0, 160) }; return; }
    await sleep(wait);
    const a = await M(audit, touch);
    const n = a.offscreen.length + a.clipped.length + a.small.length + a.overlap.length;
    problems += n;
    report[`${sizeName}/${name}`] = a;
    console.log(`${n ? 'WARN' : 'ok  '}  ${sizeName.padEnd(9)} ${name}${n ? `  ${JSON.stringify(a)}` : ''}`);
    await page.screenshot({ path: `${OUT}screens-${sizeName}-${name}.png` });
  };
  const A = 'window.__elevens';
  const screens = [
    ['home', () => window.__elevens.showMode()],
    ['more-modes', () => { window.__elevens.showMode(); document.querySelector('[data-a=more]')?.click(); }],
    ['clubs', () => window.__elevens.showTeams()],
    ['match-settings', () => window.__elevens.showMatchSettings()],
    ['practice', () => window.__elevens.showPractice()],
    ['competition', () => window.__elevens.showCompetition()],
    ['settings', () => window.__elevens.showSettings(() => window.__elevens.showMode())],
    ['controls', () => window.__elevens.showControls(() => window.__elevens.showMode())],
    ['controls-pad', () => { window.__elevens.bindTab = 'pad'; window.__elevens.showControls(() => window.__elevens.showMode()); }],
    ['controls-keys', () => { window.__elevens.bindTab = 'keys'; window.__elevens.showControls(() => window.__elevens.showMode()); }],
    ['profile', () => window.__elevens.showProfile()],
    ['creator', () => window.__elevens.openCreator(null)],
    ['online', () => window.__elevens.showOnline()],
    ['friends', () => window.__elevens.showFriends()],
    ['career', () => window.__elevens.modes.showCareer()],
    ['pro', () => window.__elevens.modes.showPro()],
    ['scenarios', () => window.__elevens.modes.showScenarios()],
    ['skill-games', () => window.__elevens.modes.showSkillGames()],
    ['cabinet', () => window.__elevens.modes.showCabinet()],
    ['street', () => window.__elevens.street.show()],
    ['levels', () => window.__elevens.openLevels()],
  ];
  for (const [n, fn] of screens) await look(n, fn);
  // A match: the HUD, pause menu and its pages, half time and full time.
  await M(() => { window.__elevens.showMode(); document.querySelector('[data-a=quick]').click(); });
  await page.waitForFunction(() => ['kickoff', 'play'].includes(window.__elevens.session?.match?.phase), null, { timeout: 90000 });
  await sleep(2500);
  await look('match-hud', () => {});
  await look('pause', () => window.__elevens.openPause());
  await look('pause-subs', () => window.__elevens.showSubs());
  await look('pause-stats', () => window.__elevens.showSquads());
  await look('pause-instructions', () => window.__elevens.showInstructions());
  await look('pause-settings', () => window.__elevens.showSettings(() => window.__elevens.openPause(), true));
  await look('pause-controls', () => window.__elevens.showControls(() => window.__elevens.openPause(), true));
  await M(() => window.__elevens.closeOverlay());
  await look('halftime', () => window.__elevens.openHalftime(window.__elevens.session.view()));
  await M(() => window.__elevens.closeOverlay());
  await look('fulltime', () => window.__elevens.openResults(window.__elevens.session.view()), 600);
  await M(() => { window.__elevens.endSession(); window.__elevens.showMode(); });
  await ctx.close();
}
writeFileSync(OUT + 'screens-report.json', JSON.stringify(report, null, 1));
console.log(`\n${problems} possible problems (details in ${OUT}screens-report.json)`, errors.length ? `\npage errors: ${errors.join(' | ')}` : '');
await browser.close();
server.kill();
