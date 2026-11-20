// TV cutaways at stoppages (render/cutaway.ts, cine.ts mode 'cutaway').
// Plays a match to a stoppage, then forces each kind of cutaway and screenshots both shots;
// also checks that one starts by itself after a near miss once play stops, that the match is
// paused while it shows, that any key skips it, and that the setting turns it off.
// Usage: npm run build && node scripts/shots-cutaways.mjs <outdir> [preset] [query]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const OUT = (process.argv[2] ?? new URL('./out/cutaways/', import.meta.url).pathname).replace(/\/?$/, '/'); mkdirSync(OUT, { recursive: true });
const preset = process.argv[3] ?? 'medium';
const query = process.argv[4] ?? '';
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const report = { errors: [], info: {}, checks: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`); };
const open = async (settings) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(([p, s]) => localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: true, matchTime: 'dusk', players: 'realistic', autoRes: false }, matchIntro: false, tvGraphics: false, ...s })), [preset, settings]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); });
  // &cine lets cinematics play on a ?test page.
  await page.goto(`${BASE}/?test&cine${query}`);
  await page.waitForSelector('[data-a=quick]');
  await page.click('[data-a=offline]'); await page.click('[data-a=next]'); await page.click('[data-a=go]');
  for (let i = 0; i < 150; i++) { if ((await page.evaluate(() => window.__elevens?.session?.view()?.phase)) === 'kickoff') break; await sleep(200); }
  for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__elevens.renderer.playersReal)) break; await sleep(500); }
  // Line-ups card (TV graphics off, so none) and kick-off.
  for (let i = 0; i < 40; i++) { if ((await page.evaluate(() => window.__elevens.session.view().phase)) === 'play') break; await page.keyboard.down('KeyJ'); await sleep(200); await page.keyboard.up('KeyJ'); await sleep(500); }
  return { ctx, page };
};
const mode = (page) => page.evaluate(() => window.__elevens.cine.mode);
try {
  const { ctx, page } = await open({});
  // 1. Forced cutaways of each kind, two shots each.
  for (const [trigger, pick] of [['miss', 'striker'], ['card', 'mid'], ['save', 'keeper']]) {
    const subject = await page.evaluate((pk) => {
      const v = window.__elevens.session.view();
      const ps = v.players.filter((p) => !p.off);
      const p = pk === 'keeper' ? ps.find((q) => q.role === 'GK') : pk === 'striker' ? ps.find((q) => q.role === 'ST') ?? ps[9] : ps.find((q) => q.role === 'CM' || q.role === 'CDM') ?? ps[5];
      return p.id;
    }, pick);
    const ok = await page.evaluate(([t, id]) => { const a = window.__elevens; return a.cine.forceCutaway(a.session.view(), t, id, a.renderer); }, [trigger, subject]);
    check(`${trigger}: cutaway starts`, ok);
    const paused = await page.evaluate(() => window.__elevens.session.paused);
    check(`${trigger}: match paused during it`, paused);
    const plan = await page.evaluate(() => window.__elevens.cine.cutaway?.shots.map((s) => `${s.kind}:${s.name}`));
    report.info[trigger] = plan;
    for (let i = 0; i < 2; i++) {
      for (let w = 0; w < 120; w++) { const c = await page.evaluate(() => window.__elevens.cine.cutaway); if (!c || (c.i === i && c.t - (i * 1.75) > 0.8)) break; await sleep(50); }
      if ((await mode(page)) !== 'cutaway') break;
      await page.screenshot({ path: `${OUT}${preset}-${trigger}-${i}.png`, timeout: 120000 });
    }
    for (let w = 0; w < 120; w++) { if ((await mode(page)) === 'none') break; await sleep(100); }
    check(`${trigger}: ends by itself`, (await mode(page)) === 'none');
    check(`${trigger}: match resumes`, !(await page.evaluate(() => window.__elevens.session.paused)));
    await sleep(500);
  }
  // 2. Any key skips.
  await page.evaluate(() => { const a = window.__elevens; const v = a.session.view(); a.cine.forceCutaway(v, 'foul', v.players.find((p) => !p.off && p.role !== 'GK').id, a.renderer); });
  await sleep(300);
  await page.keyboard.press('KeyK');
  await sleep(400);
  check('any key skips', (await mode(page)) === 'none');
  // 3. Starts by itself: a near miss noted, then play stops (a goal kick is set up).
  await page.evaluate(() => { const a = window.__elevens; a.cine.cuts.reset(); a.cine.cuts.rand = () => 0; });
  await sleep(200);
  const natural = await page.evaluate(async () => {
    const a = window.__elevens, m = a.session.match;
    // Live time past the opening minute, then the moment.
    a.cine.clock = Math.max(a.cine.clock, 60);
    const shooter = m.players.find((p) => p.role === 'ST' && p.team === 0) ?? m.players[9];
    a.cine.cutawayMoment('miss', shooter.id);
    return shooter.id;
  });
  // Put the ball out behind the goal line so the referee gives a goal kick.
  await sleep(1200);
  check('nothing while play goes on', (await mode(page)) === 'none');
  await page.evaluate(() => { const m = window.__elevens.session.match; m.award('goalkick', 1, m.goalKickSpot(1, 1)); });
  let started = false;
  for (let i = 0; i < 80; i++) { if ((await mode(page)) === 'cutaway') { started = true; break; } await sleep(100); }
  check('starts by itself at the next stoppage after a near miss', started, { phase: await page.evaluate(() => window.__elevens.session.view().phase), subject: natural });
  if (started) { await sleep(900); await page.screenshot({ path: `${OUT}${preset}-natural.png`, timeout: 120000 }); }
  for (let w = 0; w < 80; w++) { if ((await mode(page)) === 'none') break; await sleep(100); }
  await ctx.close();
  // 4. Setting off: nothing starts.
  const off = await open({ cutaways: false });
  await off.page.evaluate(() => { const a = window.__elevens; a.cine.cuts.rand = () => 0; a.cine.clock = Math.max(a.cine.clock, 60); a.cine.cutawayMoment('woodwork', 9); });
  await off.page.evaluate(() => { const m = window.__elevens.session.match; m.award('goalkick', 1, m.goalKickSpot(1, 1)); });
  let any = false;
  for (let i = 0; i < 40; i++) { if ((await mode(off.page)) === 'cutaway') { any = true; break; } await sleep(100); }
  check('setting Off: no cutaway', !any);
  await off.ctx.close();
} catch (e) { report.errors.push(String(e?.stack ?? e)); }
await browser.close(); server.kill();
writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
const fails = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify(report.info), report.errors);
console.log(`${report.checks.length - fails.length}/${report.checks.length} checks passed, ${report.errors.length} errors`);
process.exit(fails.length || report.errors.length ? 1 : 0);
