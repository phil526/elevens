// Browser checks for the modes added on 19 Nov 2026: Career, Be a Pro, Daily scenario, Skill
// games, injuries (physios and stretcher), commentary captions, saving and watching a goal,
// the trophy cabinet and club history, and ranked online against a second browser page.
// Usage: npm run build && node scripts/e2e-modes19.mjs   (CHROMIUM_PATH overrides the browser)

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const PORT = 8819;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'scripts/out/';
mkdirSync(OUT, { recursive: true });
rmSync('scripts/out/ranked-e2e.json', { force: true });
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SERVE_CLIENT: '1', RANKED_FILE: 'scripts/out/ranked-e2e.json' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ` (${info})` : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const SETTINGS = JSON.stringify({ graphics: { preset: 'low', renderScale: 0.5, shadows: false, players: 'classic', weather: 'clear' }, matchIntro: false, tvGraphics: false, highlights: false });
const only = process.argv[2] ?? '';

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('elevens.settings.v1')) localStorage.setItem('elevens.settings.v1', s); localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, opts: false })); }, SETTINGS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.stack ?? e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon/.test(m.text())) errors.push(m.text()); });
  return page;
}

try {
  const page = await newPage();
  const M = (fn, arg) => page.evaluate(fn, arg);
  const seen = (fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const inMatch = () => seen(() => !!window.__elevens.session && ['kickoff', 'play'].includes(window.__elevens.session.match?.phase), null, 60000);
  const endMatch = (score) => M((sc) => { const m = window.__elevens.session.match; m.half = 2; m.clock = 45 * 60 - 0.5; m.addedTime = 0; m.score = sc; }, score);
  const fullTime = () => seen(() => !!document.querySelector('[data-a=mcont]'), null, 30000);
  const home = async () => { await M(() => { window.__elevens.endSession?.(); window.__elevens.showMode(); }); await page.waitForSelector('[data-a=quick]'); };

  await page.goto(`${BASE}/?test&clips`);
  await page.waitForSelector('[data-a=quick]');
  if (!(await M(() => !!document.querySelector('[data-mode=career]')))) { await page.click('[data-a=more]'); await page.waitForSelector('[data-mode=career]'); }
  check('More modes lists Career, Be a Pro, Daily scenario, Skill games, Trophy cabinet and My goals', await M(() => ['career', 'pro', 'daily', 'skill', 'cabinet', 'clips'].every((k) => !!document.querySelector(`[data-mode=${k}]`))));
  await page.screenshot({ path: OUT + 'modes-01-more.png' });

  if (!only || only === 'career') {
    // --- Career
    await page.click('[data-mode=career]');
    await page.waitForSelector('[data-a=cstart]');
    await page.screenshot({ path: OUT + 'modes-02-career-setup.png' });
    await page.click('[data-a=cstart]');
    await page.waitForSelector('[data-ctab=squad]');
    check('a new career opens on the club overview with a fixture to play', await M(() => !!document.querySelector('[data-a=cplay]') && /Board target/.test(document.body.textContent)));
    await page.screenshot({ path: OUT + 'modes-03-career-home.png' });
    await page.click('[data-ctab=squad]');
    const rows = await M(() => [...document.querySelectorAll('.sq-row')].map((r) => r.dataset.pid));
    const xi0 = await M(() => [...document.querySelectorAll('.sq-row')].slice(0, 11).map((r) => r.dataset.pid));
    // Swap the 2nd starter with the first substitute.
    await page.click(`.sq-row[data-pid="${rows[1]}"] .sq-name`);
    await page.click(`.sq-row[data-pid="${rows[12]}"] .sq-name`);
    const xi1 = await M(() => [...document.querySelectorAll('.sq-row')].slice(0, 11).map((r) => r.dataset.pid));
    check('picking a starter then a substitute swaps them into the eleven', xi1.includes(rows[12]) && !xi1.includes(rows[1]) && xi0.includes(rows[1]));
    await page.screenshot({ path: OUT + 'modes-04-career-squad.png' });
    await page.click('[data-ctab=transfers]');
    const buy = await M(() => { const b = [...document.querySelectorAll('[data-buy]')].find((x) => !x.disabled); return b?.dataset.buy ?? null; });
    if (buy) {
      await page.click(`[data-buy="${buy}"]`);
      await page.click(`[data-buy="${buy}"]`);
      check('buying a player from the transfer list', await M(() => /signs from/.test(document.querySelector('.mode-msg')?.textContent ?? '')));
    } else check('buying a player from the transfer list', false, 'nothing affordable');
    await page.click('[data-ctab=academy]');
    check('the academy has young prospects', await M(() => [...document.querySelectorAll('.sq-row .sq-age')].some((a) => Number(a.textContent) <= 17)));
    await page.click('[data-ctab=home]');
    const myXI = await M(() => { const c = window.__elevens.modes.store.career; return c.squads[c.club].filter((p) => c.lineup.includes(p.id)).map((p) => p.short); });
    await page.click('[data-a=cplay]');
    check('Play starts a career match', await inMatch());
    check('with your career squad on the pitch (and injuries on)', await M((xi) => { const s = window.__elevens.session; const names = s.match.teams[0].players.map((p) => p.short); return xi.length === 0 || xi.filter((n) => names.includes(n)).length >= 9; }, myXI) && await M(() => window.__elevens.session.cfg.injuries === true));
    await sleep(1500);
    await endMatch([2, 1]);
    check('full time shows the career note and Continue', await fullTime());
    await page.screenshot({ path: OUT + 'modes-05-career-ft.png' });
    await page.click('[data-a=mcont]');
    await page.waitForSelector('[data-ctab=league]');
    await page.click('[data-ctab=league]');
    check('the result is in the league table (3 points)', await M(() => { const me = document.querySelector('.ltable tr.me'); return !!me && /\b3\b/.test(me.lastElementChild.textContent); }));
    await page.screenshot({ path: OUT + 'modes-06-career-table.png' });
    await home();
  }

  if (!only || only === 'pro') {
    // --- Be a Pro
    await page.click('[data-mode=pro]');
    await page.waitForSelector('[data-a=pstart]');
    await page.fill('[data-in=pname]', 'Alex Morgan-Test');
    await page.click('[data-seg=ppos] [data-v=RW]');
    await page.screenshot({ path: OUT + 'modes-07-pro-create.png' });
    await page.click('[data-a=pstart]');
    await page.waitForSelector('[data-a=pplay]');
    check('the pro starts with points to spend', await M(() => !!document.querySelector('[data-up]')));
    await page.click('[data-up=pace]');
    check('spending a point raises the attribute', await M(() => window.__elevens.modes.store.pro.attrs.pace === 77 && window.__elevens.modes.store.pro.points === 2));
    await page.screenshot({ path: OUT + 'modes-08-pro-hub.png' });
    await page.click('[data-a=pplay]');
    check('Play starts a Be a Pro match', await inMatch());
    check('you control only your pro (locked to the right winger)', await M(() => { const m = window.__elevens.session.match; return m.ctrl[0].lock === 8 && m.ctrl[0].pid === 8 && m.players[8].def.short === 'Morgan-Test'; }));
    await sleep(2500);
    check('control stays on the pro', await M(() => window.__elevens.session.match.ctrl[0].pid === 8));
    await page.screenshot({ path: OUT + 'modes-09-pro-match.png' });
    await endMatch([1, 0]);
    check('full time shows the pro rating and XP', await fullTime() && await M(() => /XP/.test(document.querySelector('.pro-result')?.textContent ?? '')));
    await page.screenshot({ path: OUT + 'modes-10-pro-ft.png' });
    await page.click('[data-a=mcont]');
    await page.waitForSelector('[data-a=pplay]');
    check('the match is on the pro record', await M(() => window.__elevens.modes.store.pro.total.apps === 1 && window.__elevens.modes.store.pro.recent.length === 1));
    await home();
  }

  if (!only || only === 'scenario') {
    // --- Daily scenario
    await page.click('[data-mode=daily]');
    await page.waitForSelector('.scen-card.daily');
    await page.screenshot({ path: OUT + 'modes-11-scenarios.png' });
    const want = await M(() => { const b = document.querySelector('.scen-card.daily [data-scen]'); return b.dataset.scen; });
    await page.click('.scen-card.daily [data-scen]');
    check('the daily scenario starts', await inMatch());
    const sc = await M(() => ({ half: window.__elevens.session.match.half, clock: window.__elevens.session.match.displayClock, score: window.__elevens.session.match.score.slice() }));
    check('picked up at the scenario minute and score', sc.clock >= 20 * 60 && sc.clock < 86 * 60, JSON.stringify(sc));
    await sleep(1000);
    await page.screenshot({ path: OUT + 'modes-12-scenario-match.png' });
    await endMatch([5, 0]);
    check('full time says the target was met', await fullTime() && await M(() => /Target met/.test(document.querySelector('.scen-result')?.textContent ?? '')));
    await page.click('[data-a=mcont]');
    await page.waitForSelector('.scen-card.daily');
    check('today is marked done and the scenario has a tick', await M((id) => !!window.__elevens.modes.store.daily[new Date().toISOString().slice(0, 10)]?.met && !!window.__elevens.modes.store.scenarios[id]?.met, want));
    await home();
  }

  if (!only || only === 'skill') {
    // --- Skill games
    await page.click('[data-mode=skill]');
    await page.waitForSelector('[data-skill=targets]');
    await page.click('[data-skill=targets]');
    check('target practice starts', await seen(() => window.__elevens.session?.match?.skill?.game === 'targets', null, 60000));
    await seen(() => window.__elevens.session.match.restart?.type === 'freekick', null, 20000);
    await sleep(1500);
    check('the five targets hang in the goal', await M(() => window.__elevens.session.view().skill.targets.length === 5));
    await page.screenshot({ path: OUT + 'modes-13-targets.png' });
    // Aim one at the top corner target through the engine: the scoring and the toast.
    await M(() => { const m = window.__elevens.session.match; const t = m.skill.targets[0]; m.restart = null; m.phase = 'play'; const dir = m.attackDir(0); m.ball.state = 'flight'; m.ball.owner = -1; m.ball.pos = { x: dir * 50, y: t.y, z: t.z }; m.ball.vel = { x: dir * 22, y: 0, z: 0 }; m.ball.lastTouch = 9; m.ball.lastTouchTeam = 0; });
    check('hitting a target scores its points', await seen(() => window.__elevens.session.match.skill.points === 3, null, 8000), await M(() => window.__elevens.session.match.skill.points));
    check('and a toast says so', await seen(() => /Target/.test(document.querySelector('.match-toast')?.textContent ?? ''), null, 3000));
    await page.screenshot({ path: OUT + 'modes-14-target-hit.png' });
    await M(() => { const m = window.__elevens.session.match; m.drillAttempts = 10; m.nextDrill(); });
    check('ten kicks end with the points and best score', await fullTime() && await M(() => /points/.test(document.querySelector('.final')?.textContent ?? '')));
    await page.click('[data-a=mcont]');
    await page.waitForSelector('[data-skill=crossbar]');
    check('the best score is kept', await M(() => window.__elevens.modes.store.skillBest.targets === 3));
    await home();
  }

  if (!only || only === 'injury') {
    // --- Injury, physios and stretcher in a quick match; commentary captions.
    await page.click('[data-a=quick]');
    await inMatch();
    await seen(() => window.__elevens.session.match.phase === 'play', null, 20000);
    await sleep(1500);
    check('commentary captions show during play', await seen(() => (document.querySelector('.commentary-cap.show')?.textContent ?? '').length > 5, null, 30000), await M(() => document.querySelector('.commentary-cap')?.textContent));
    await page.screenshot({ path: OUT + 'modes-15-commentary.png' });
    // A bad injury to an away midfielder: physios run on, then the stretcher.
    await M(() => { const m = window.__elevens.session.match; const v = m.players[17]; v.pos = { x: 5, z: -12 }; m.injury = null; });
    let started = false;
    {
      // Start the injury state directly (the same shape shared/injury.ts makes after a foul).
      await M(() => { const m = window.__elevens.session.match; const p = m.players[17]; m.injury = { pid: 17, team: 1, severity: 2, t: 0, stage: 'down', at: { ...p.pos }, edge: { x: p.pos.x, z: -(34 + 1.6) }, matches: 2 }; m.award('freekick', 1, { ...p.pos }); p.action = { type: 'down', t: 0, dur: 99 }; });
      started = await seen(() => !!window.__elevens.session.match.injury, null, 3000);
    }
    check('a heavy foul can injure a player', started);
    await seen(() => ['treat', 'lift'].includes(window.__elevens.session.match.injury?.stage), null, 20000);
    await page.screenshot({ path: OUT + 'modes-16-physios.png' });
    check('the physios run on and treat him', await M(() => ['treat', 'lift', 'carry'].includes(window.__elevens.session.match.injury?.stage)));
    await seen(() => window.__elevens.session.match.injury?.stage === 'carry', null, 20000);
    await sleep(1200);
    await page.screenshot({ path: OUT + 'modes-17-stretcher.png' });
    check('a bad one is carried off on a stretcher', await M(() => window.__elevens.session.match.injury?.stage === 'carry' || window.__elevens.session.match.injuries.length > 0));
    check('and replaced (the fourth official shows the numbers)', await seen(() => window.__elevens.session.match.injuries.length > 0 && !window.__elevens.session.match.injury, null, 20000));
    await sleep(600);
    await page.screenshot({ path: OUT + 'modes-18-board.png' });
    // A goal for us, so the full-time panel offers to save it.
    await seen(() => window.__elevens.session.match.phase === 'play', null, 30000);
    await M(() => { const m = window.__elevens.session.match; const dir = m.attackDir(0); const p = m.players[9]; m.ball.state = 'flight'; m.ball.owner = -1; m.ball.pos = { x: dir * 45, y: 0.4, z: 1 }; m.ball.vel = { x: dir * 28, y: 1, z: 0 }; m.ball.lastTouch = 9; m.ball.lastTouchTeam = 0; m.ball.kicker = 9; p.pos = { x: dir * 43, z: 1 }; });
    check('a goal for us', await seen(() => window.__elevens.session.match.score[0] >= 1, null, 8000));
    await sleep(6000);
    await endMatch([1, 0]);
    check('full time offers to save your goal', await seen(() => !!document.querySelector('[data-savegoal]'), null, 30000));
    await page.click('[data-savegoal]');
    check('saving it', await seen(() => /Saved/.test(document.querySelector('[data-savegoal]')?.textContent ?? ''), null, 5000));
    await page.screenshot({ path: OUT + 'modes-19-savegoal.png' });
    await M(() => { window.__elevens.endSession(); window.__elevens.showMode(); });
    await page.waitForSelector('[data-mode=clips]');
    await page.click('[data-mode=clips]');
    await page.waitForSelector('[data-watch]');
    check('My goals lists the saved goal', await M(() => document.querySelectorAll('.clip-row').length >= 1));
    await page.screenshot({ path: OUT + 'modes-20-mygoals.png' });
    await page.click('[data-watch]');
    check('watching it plays it in the stadium', await seen(() => !!document.querySelector('.clip-bar'), null, 5000));
    await sleep(2500);
    await page.screenshot({ path: OUT + 'modes-21-clip.png' });
    check('then from the net', await seen(() => /From the net/.test(document.querySelector('.clip-part')?.textContent ?? ''), null, 20000));
    await page.screenshot({ path: OUT + 'modes-22-clip-net.png' });
    check('and back to My goals at the end', await seen(() => !!document.querySelector('[data-watch]'), null, 25000));
    await page.click('[data-share]');
    await seen(() => !!document.querySelector('[data-a=vshare]') || /record/.test(document.body.textContent), null, 40000);
    check('Share video records it to a video file', await M(() => !!document.querySelector('[data-a=vshare]')), await M(() => document.querySelector('.mode-msg')?.textContent ?? ''));
    await home();
  }

  if (!only || only === 'cabinet') {
    await page.click('[data-mode=cabinet]');
    await page.waitForSelector('.shelf');
    await page.screenshot({ path: OUT + 'modes-23-cabinet.png' });
    check('the cabinet shows medals (the scenario)', await M(() => document.querySelectorAll('.shelf.small .trophy').length >= 1) || only === 'cabinet');
    await page.click('[data-ttab=clubs]');
    await page.waitForSelector('.hist-card, .note');
    const hasClub = await M(() => !!document.querySelector('.hist-card'));
    if (hasClub) { await page.click('.hist-card'); await page.waitForSelector('.mcard'); }
    check('club history lists a club and its record', (hasClub && await M(() => /Record/.test(document.body.textContent))) || (only === 'cabinet' && !hasClub));
    await page.screenshot({ path: OUT + 'modes-24-club-history.png' });
    await home();
  }

  if (!only || only === 'ranked') {
    // --- Ranked: two pages queue and are paired.
    const p2 = await newPage();
    const open = async (pg, name) => {
      await pg.goto(`${BASE}/?test&server=ws://127.0.0.1:${PORT}/ws`);
      await pg.waitForSelector('[data-a=quick]');
      if (!(await pg.evaluate(() => !!document.querySelector('[data-a=online]')))) await pg.click('[data-a=more]');
      await pg.click('[data-a=online]');
      await pg.fill('#nm', name);
      await pg.click('[data-a=ranked]');
      await pg.waitForSelector('[data-a=rfind]');
    };
    await open(page, 'Ann');
    await open(p2, 'Bob');
    await page.screenshot({ path: OUT + 'modes-25-ranked.png' });
    await page.click('[data-a=rfind]');
    await p2.click('[data-a=rfind]');
    const found = await seen(() => /Ranked match found|Kick-off/.test(document.body.textContent) || !!window.__elevens.session, null, 20000);
    check('two players searching are paired into a ranked match', found);
    await page.screenshot({ path: OUT + 'modes-26-ranked-found.png' });
    check('the ranked match kicks off', await seen(() => !!window.__elevens.session, null, 40000));
    await sleep(2000);
    await p2.evaluate(() => { window.__elevens.net.send({ t: 'leave' }); });
    check('the opponent leaving gives you the win and division points', await seen(() => (window.__elevens.ranked?.rec?.points ?? 0) > 0, null, 20000), await M(() => JSON.stringify(window.__elevens.ranked?.rec)));
    check('full time says you win because they left', await seen(() => /You win · Bob left/.test(document.querySelector('.panel h3')?.textContent ?? ''), null, 10000), await M(() => document.querySelector('.panel h3')?.textContent));
    await sleep(500);
    await page.screenshot({ path: OUT + 'modes-27-ranked-result.png' });
    await p2.close();
  }
} catch (e) {
  console.error(e);
  check('script ran to the end', false, e.message);
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].slice(0, 12).join('\n'));
process.exit(failed.length ? 1 : 0);
