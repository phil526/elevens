// Online team rooms (20 Nov 2026): a 2 v 2 private room in four browser pages and a "together
// against the computer" room in two. Checks the lobby, that everyone controls their own player,
// the signal bars, and that play goes on when one person leaves a 2 v 2.
// Usage: npm run build && node scripts/e2e-online-teams.mjs   (CHROMIUM_PATH overrides the browser)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 8843;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1', RANKED_FILE: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pages = [];
async function newPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await ctx.addInitScript(() => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: 'low' }, players: 'classic' })); localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, opts: false })); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.stack ?? e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  pages.push(page);
  return page;
}
const seen = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const live = (pg) => seen(pg, () => { const v = window.__elevens.session?.view?.(); return !!v && ['kickoff', 'play'].includes(v.phase); }, null, 60000);
const room = (pg) => pg.evaluate(() => window.__elevens.room);

async function host(pg, name) {
  await pg.goto(`${BASE}/?test`);
  await pg.waitForSelector('[data-a=quick]');
  if (!(await pg.evaluate(() => !!document.querySelector('[data-a=online]')))) await pg.click('[data-a=more]');
  await pg.click('[data-a=online]');
  await pg.fill('#nm', name);
  await pg.click('[data-a=create]');
  await pg.waitForSelector('.bigcode', { timeout: 15000 });
  return (await pg.textContent('.bigcode')).trim();
}
async function join(pg, code, name) {
  await pg.goto(`${BASE}/?test`);
  await pg.waitForSelector('[data-a=quick]');
  await pg.evaluate((n) => { const k = 'elevens.settings.v1'; const st = JSON.parse(localStorage.getItem(k) || '{}'); st.name = n; localStorage.setItem(k, JSON.stringify(st)); }, name);
  await pg.goto(`${BASE}/?test&room=${code}`);
  await pg.waitForSelector('.bigcode', { timeout: 15000 });
}
async function readyAll(list) {
  for (const pg of list) {
    await pg.waitForSelector('[data-a=ready]:not([disabled])', { timeout: 15000 });
    await sleep(250);
    await pg.click('[data-a=ready]');
    await sleep(250);
  }
}

try {
  // ---------------------------------------------------------------- 2 v 2
  const [a, b, c, d] = [await newPage('A'), await newPage('B'), await newPage('C'), await newPage('D')];
  const code = await host(a, 'Ada');
  check('the host sees a format choice', !!(await a.$('[data-seg=fmt]')) || !!(await a.$('[data-fmt]')) || /2 v 2/.test(await a.textContent('.panel')));
  await a.evaluate(() => window.__elevens.net.send({ t: 'lobby', format: '2v2', minutes: 2 }));
  await seen(a, () => window.__elevens.room?.format === '2v2');
  check('2 v 2 shows four places', (await a.$$('[data-seat]')).length === 4);
  check('Ready waits until all four have joined', !!(await a.$('[data-a=ready][disabled]')));
  await join(b, code, 'Bo');
  await join(c, code, 'Cy');
  await join(d, code, 'Di');
  const seats = await Promise.all([a, b, c, d].map(async (pg) => (await room(pg)).you));
  check('the four people get seats 0 to 3', [...seats].sort().join() === '0,1,2,3', seats.join());
  await a.waitForFunction(() => window.__elevens.room?.seats.filter(Boolean).length === 4, null, { timeout: 10000 });
  await a.screenshot({ path: OUT + 'online-2v2-lobby.png' });
  check('the lobby names the waiting players', /Waiting for|Press Ready/.test(await a.textContent('.lobby-status')));
  await readyAll([a, b, c, d]);
  const all = await Promise.all([a, b, c, d].map(live));
  check('all four are in the match', all.every(Boolean), all.join());
  await sleep(2500);
  const ctl = await Promise.all([a, b, c, d].map((pg) => pg.evaluate(() => { const v = window.__elevens.session.view(); const s = window.__elevens.session.start; return { side: s.side, slot: s.slot ?? 0, me: v.ctl[s.side], mate: v.mates?.[s.side] ?? -1 }; })));
  console.log('  controls', JSON.stringify(ctl));
  const bySeat = (i) => ctl[seats.indexOf(i)];
  check('teammates control different players', bySeat(0).me !== bySeat(2).me && bySeat(1).me !== bySeat(3).me);
  // Auto-switching can move either control between two reads, so look a few times.
  let agree = false;
  for (let i = 0; i < 8 && !agree; i++) {
    const [p0, p2] = await Promise.all([seats.indexOf(0), seats.indexOf(2)].map((k) => [a, b, c, d][k].evaluate(() => { const v = window.__elevens.session.view(); const s = window.__elevens.session.start.side; return { me: v.ctl[s], mate: v.mates?.[s] ?? -1 }; })));
    agree = p0.mate === p2.me && p2.mate === p0.me;
    if (!agree) await sleep(300);
  }
  check('each sees their teammate as the second human', agree);
  // Kick off (the side's first player passes), then move the second player of a side.
  for (let i = 0; i < 12; i++) {
    if (await a.evaluate(() => window.__elevens.session.view().phase === 'play')) break;
    for (const pg of [a, b]) { await pg.keyboard.down('KeyJ'); await sleep(150); await pg.keyboard.up('KeyJ'); }
    await sleep(700);
  }
  check('the kick-off is taken', await a.evaluate(() => window.__elevens.session.view().phase === 'play'));
  await sleep(1000);
  check('the signal bars show in the match', await a.evaluate(() => !!document.querySelector('.sig')));
  await c.screenshot({ path: OUT + 'online-2v2-c.png' });
  // One person leaves: the others play on.
  await d.evaluate(() => { window.__elevens.net.send({ t: 'leave' }); });
  await d.close();
  await sleep(3000);
  const still = await Promise.all([a, b, c].map((pg) => pg.evaluate(() => { const v = window.__elevens.session?.view?.(); return !!v && v.phase !== 'fulltime'; })));
  check('play goes on when one of the four leaves', still.every(Boolean), still.join());
  for (const pg of [a, b, c]) { await pg.evaluate(() => window.__elevens.net?.send({ t: 'leave' })); await pg.context().close(); }

  // ----------------------------------------------------- together v computer
  const [e, f] = [await newPage('E'), await newPage('F')];
  const code2 = await host(e, 'Eve');
  await e.evaluate(() => window.__elevens.net.send({ t: 'lobby', format: 'coop', aiDiff: 'casual', minutes: 2 }));
  await seen(e, () => window.__elevens.room?.format === 'coop');
  check('together v computer shows the computer side', !!(await e.$('.club.cpu')) && /Casual/.test(await e.textContent('.club.cpu')));
  await join(f, code2, 'Fin');
  const r2 = await room(f);
  check('the friend joins the host\'s side', r2.you % 2 === 0 && r2.you !== (await room(e)).you, `seat ${r2.you}`);
  await e.screenshot({ path: OUT + 'online-coop-lobby.png' });
  await readyAll([e, f]);
  check('both are in the match', (await live(e)) && (await live(f)));
  await sleep(2000);
  const v2 = await e.evaluate(() => { const v = window.__elevens.session.view(); return { humans: v.humans, ctl: v.ctl, mates: v.mates }; });
  const v3 = await f.evaluate(() => { const v = window.__elevens.session.view(); return { ctl: v.ctl, mates: v.mates }; });
  check('only one side is human', v2.humans[0] && !v2.humans[1], JSON.stringify(v2.humans));
  check('the two friends control different players', v2.ctl[0] !== v3.ctl[0] && v2.mates?.[0] === v3.ctl[0], `${v2.ctl[0]} / ${v3.ctl[0]}`);
  // Four software-rendered pages run at about 1 frame a second here, too slow to steer, so the
  // second player's movement is checked in this two-page room.
  for (let i = 0; i < 12; i++) {
    if (await e.evaluate(() => window.__elevens.session.view().phase === 'play')) break;
    await e.keyboard.down('KeyJ'); await sleep(150); await e.keyboard.up('KeyJ');
    await sleep(700);
  }
  // A held stick is ignored just after a switch until it is moved, so press again a few times.
  // The movement itself is checked at the server in tests/room-teams.test.ts (software rendering
  // here runs at a few frames a second, too slow to steer by keyboard): here, the server takes the
  // second player's input.
  const ack = () => f.evaluate(() => { const s = window.__elevens.session; return s.snaps.at(-1)?.ack ?? -1; });
  const k0 = await ack();
  await f.keyboard.down('KeyD'); await sleep(2000); await f.keyboard.up('KeyD');
  const k1 = await ack();
  check('the server takes the second player\'s input', k1 > k0 + 10, `${k0} -> ${k1}`);
  await f.screenshot({ path: OUT + 'online-coop-f.png' });
  check('no page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
} catch (err) {
  console.error(err);
  check('script ran to the end', false, err.message);
  console.log(errors.slice(0, 6).join('\n'));
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
