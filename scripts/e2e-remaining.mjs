// Browser checks for the 19 Nov 2026 features: more clubs and league sizes, club creator,
// profiles and save slots, achievements, guided first match, photo mode, accessibility settings
// and the home-screen app files. Headless Chromium (SwiftShader), real clicks and key presses.
// Usage: npm run build && node scripts/e2e-remaining.mjs. Screenshots and report in scripts/out/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.E2E_PORT ?? 8799), BASE = `http://127.0.0.1:${PORT}`;
const exe = process.env.CHROMIUM_PATH ?? ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find(existsSync);
const preset = process.env.E2E_PRESET ?? 'low';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { started: new Date().toISOString(), preset, checks: [], consoleErrors: [] };
const check = (name, ok, detail = '') => { report.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); };

const server = spawn(process.execPath, ['dist/server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
const browser = await chromium.launch({ executablePath: exe, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx.addInitScript(() => localStorage.setItem('elevens.menuopen.v1', JSON.stringify({ modes: true, options: true }))); // More modes and More options open
  await ctx.addInitScript((p) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('elevens.settings.v1', JSON.stringify({ graphics: { preset: p, renderScale: 1, shadows: false } }));
      // An older save: a cup in progress and a challenge best, from before profiles.
      localStorage.setItem('elevens-challenge-best', JSON.stringify({ penalty: 6 }));
      sessionStorage.setItem('seeded', '1');
    }
  }, preset);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(m.text()); });
  const M = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, ms = 20000, arg) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await M(fn, arg); if (v) return v; await sleep(150); } return null; };
  const store = () => M(() => JSON.parse(localStorage.getItem('elevens.profiles.v1')));
  const shot = (n) => page.screenshot({ path: `${OUT}remaining-${n}.png` });

  // --- main menu: profile chip, first-run prompt, old saves moved into slot 1
  await page.goto(`${BASE}/?test`);
  await page.waitForSelector('[data-a=quick]');
  await page.waitForSelector('[data-a=offline]');
  check('main menu shows the profile chip', await M(() => !!document.querySelector('.profile-chip')));
  check('first visit offers the guided first match', await M(() => !!document.querySelector('.first-run [data-a=tutorial]')));
  const st0 = await store();
  check('old challenge best moved into slot 1', st0?.slots?.[0]?.challengeBest?.penalty === 6, JSON.stringify(st0?.slots?.[0]?.challengeBest));
  await shot('01-menu');

  // --- the home-screen app files are served with the build
  const files = await M(async () => Promise.all(['manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'].map((f) => fetch(f).then((r) => r.ok))));
  check('manifest, service worker and icons are in the build', files.every(Boolean), files.join(','));
  check('page links the manifest and iPad icon', await M(() => !!document.querySelector('link[rel=manifest]') && !!document.querySelector('link[rel=apple-touch-icon]')));

  // --- Play vs computer: any two of the 20 clubs
  await page.click('[data-a=offline]');
  const nClubs = await M(() => document.querySelectorAll('[data-club]').length);
  check('Play vs computer lists all 20 clubs', nClubs === 20, `${nClubs}`);
  await page.click('[data-club=kingsmere]');
  await page.click('[data-opp=larkspur]');
  await shot('02-teams');
  await page.click('[data-a=next]');
  await page.click('[data-seg=diff] [data-v=casual]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  const names = await M(() => window.__elevens.session.match.teams.map((t) => t.name));
  check('the chosen clubs play', names.join(' v ') === 'Kingsmere Dynamo v Larkspur Rovers', names.join(' v '));
  await sleep(500);

  // --- photo mode from the pause menu
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-a=photo]');
  await page.click('[data-a=photo]');
  check('photo mode opens with its panel and hides the HUD', await waitFor(() => document.body.classList.contains('photo-on') && !!document.querySelector('.photo-panel')));
  const before = await M(() => { const p = window.__elevens.photo.shot().pos; return [p.x, p.y, p.z]; });
  await page.keyboard.down('KeyL'); await sleep(2500); await page.keyboard.up('KeyL');
  await page.keyboard.down('KeyE'); await sleep(1200); await page.keyboard.up('KeyE');
  const after = await M(() => { const p = window.__elevens.photo.shot().pos; return [p.x, p.y, p.z]; });
  check('keys orbit the photo camera', Math.hypot(after[0] - before[0], after[2] - before[2]) > 1, `${before.map((v) => v.toFixed(1))} -> ${after.map((v) => v.toFixed(1))}`);
  await page.click('[data-seg=pfilter] [data-v=vivid]');
  check('a filter previews on the canvas', await M(() => document.getElementById('game').style.filter.includes('saturate')));
  await shot('03-photo-mode');
  await page.click('[data-a=snap]');
  const img = await waitFor(() => document.querySelector('.photo-shot img')?.getAttribute('src')?.slice(0, 30), 10000);
  check('taking a photo shows the picture (JPEG)', img?.startsWith('data:image/jpeg'), img);
  const imgSize = await M(() => { const i = document.querySelector('.photo-shot img'); return i ? [i.naturalWidth, i.naturalHeight] : null; });
  check('the picture is full size', imgSize && imgSize[0] >= 1000, JSON.stringify(imgSize));
  check('the photo unlocks Snapper', await waitFor(() => [...document.querySelectorAll('.achieve b')].some((b) => b.textContent === 'Snapper'), 4000));
  await shot('04-photo-taken');
  await page.click('[data-a=again]');
  await page.click('[data-a=back]');
  check('back from photo mode returns to the pause menu', await waitFor(() => !!document.querySelector('[data-a=resume]') && !document.body.classList.contains('photo-on')));
  await page.click('[data-a=resume]');

  // --- full time: the match goes on the profile
  await M(() => { const m = window.__elevens.session.match; m.score = [3, 0]; m.half = 2; m.clock = 45 * 60 - 0.5; m.addedTime = 0; });
  const ft = await waitFor(() => document.querySelector('[data-a=rematch]') ? true : null, 60000);
  check('full time reached', !!ft);
  const st1 = await store();
  const p1 = st1.slots[st1.active];
  check('the result is on the profile', p1.stats.played === 1 && p1.stats.won === 1 && p1.stats.gf === 3, JSON.stringify(p1.stats));
  check('first-match achievements unlocked', !!p1.achievements['first-match'] && !!p1.achievements['first-win'] && !!p1.achievements['clean-sheet'], Object.keys(p1.achievements).join(','));
  await page.click('[data-a=menu]');

  // --- club creator
  await page.waitForSelector('[data-a=clubs]');
  await page.click('[data-a=clubs]');
  await page.click('[data-seg=ptab] [data-v=clubs]');
  await page.click('[data-a=newclub]');
  await page.fill('#cname', 'Riverford Athletic');
  await page.dispatchEvent('#cname', 'change');
  check('short name made from the club name', (await M(() => document.querySelector('#cabbr').value)) === 'RIA', await M(() => document.querySelector('#cabbr').value));
  await page.click('[data-part="home.shirt"] [data-c="5974662"]'); // purple 0x5b2a86
  await page.click('[data-seg=flav] [data-v=pace]');
  await page.click('[data-seg=ctab] [data-v=badge]');
  await page.click('[data-em=bolt]');
  await page.click('[data-seg=bshape] [data-v=round]');
  await shot('05-creator');
  await page.click('[data-a=saveclub]');
  const st2 = await store();
  const club = st2.slots[st2.active].clubs[0];
  check('the new club is saved on the profile', club?.name === 'Riverford Athletic' && club.home.shirt === 0x5b2a86 && club.badge.emblem === 'bolt' && club.flavour === 'pace', JSON.stringify(club && { n: club.name, s: club.home.shirt, e: club.badge.emblem }));
  check('Founder unlocked', !!st2.slots[st2.active].achievements.founder);
  await shot('06-my-clubs');
  await page.click('[data-seg=ptab] [data-v=awards]');
  await shot('07-awards');
  await page.click('[data-a=back]');
  await page.click('[data-a=offline]');
  check('your club is in Play vs computer', await M((id) => !!document.querySelector(`[data-club="${id}"]`), club.id));
  check('and chosen for you', await M((id) => document.querySelector(`[data-club="${id}"]`)?.classList.contains('on'), club.id));
  await page.click('[data-a=next]');
  await page.click('[data-a=go]');
  await waitFor(() => window.__elevens?.session?.match?.phase === 'kickoff', 60000);
  check('a match with your own club', (await M(() => window.__elevens.session.match.teams[0].name)) === 'Riverford Athletic');
  await page.keyboard.press('Escape');
  await page.click('[data-a=quit]');

  // --- a 20-club league
  await page.waitForSelector('[data-a=comp]');
  await page.click('[data-a=comp]');
  await page.click('[data-seg=ckind] [data-v=league]');
  await page.click('[data-seg=lsize] [data-v="20"]');
  await page.click('[data-club=copperfield]');
  await page.click('[data-a=start]');
  const rows = await waitFor(() => document.querySelectorAll('.ltable tr').length - 1);
  check('a 20-club league table', rows === 20, `${rows} rows`);
  check('19 rounds', (await M(() => document.querySelector('.comp-next .lbl')?.textContent)) === 'Round 1 of 19', await M(() => document.querySelector('.comp-next .lbl')?.textContent));
  await shot('08-league-20');
  await page.click('[data-a=back]');

  // --- save slots: a second profile has its own (empty) cup and league
  await page.click('.profile-chip');
  await page.waitForSelector('[data-new="1"]');
  await page.click('[data-new="1"]');
  const st3 = await store();
  check('a new profile in slot 2 is now in use', st3.active === 1 && st3.slots[1].name === 'Player 2' && !st3.slots[1].comp && st3.slots[0].comp?.size === 20, `active ${st3.active}`);
  await page.click('[data-use="0"]');
  check('switching back keeps slot 1 (its club and league)', (await store()).active === 0 && (await M(() => document.querySelector('.slot.on b')?.textContent)) !== 'Player 2');
  await shot('09-slots');
  await page.click('[data-a=back]');

  // --- accessibility: colour-blind kits, text size, hold time
  await page.click('[data-a=settings]');
  await page.click('[data-seg=cvd] [data-v=deutan]');
  await page.click('[data-seg=tsize] [data-v=xl]');
  await page.click('[data-seg=charge] [data-v=slower]');
  await page.click('[data-seg=stoggle] [data-v=toggle]');
  check('text size scales the menus', await M(() => document.body.classList.contains('text-big') && getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim() === '1.36'));
  check('nothing spills off the side at the largest text size', await M(() => { const r = document.querySelector('.panel').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; }));
  check('hold time and toggle sprint reach the controls', await M(() => window.__elevens.actions.chargeScale === 2 && window.__elevens.actions.sprintToggle === true));
  check('Settings explains the home-screen app', await M(() => /Home-screen app|home-screen app/.test(document.querySelector('#ui').textContent)));
  await shot('10-settings-xl');
  await page.click('[data-seg=tsize] [data-v=normal]');
  await page.click('[data-a=back]');
  await page.click('[data-a=offline]');
  await page.click('[data-club=redmoor]');
  await page.click('[data-opp=harrowfield]');
  const kitNote = await M(() => document.querySelector('.kit-note')?.textContent ?? '');
  check('green-weak: Harrowfield change out of green against red', /away kit|change kit/.test(kitNote), kitNote.slice(0, 120));
  await page.click('[data-a=back]');
  await page.click('[data-a=settings]');
  await page.click('[data-seg=cvd] [data-v=off]');
  await page.click('[data-a=back]');

  // --- guided first match
  await page.click('[data-a=practice]');
  await page.click('[data-a=p-tutorial]');
  await waitFor(() => window.__elevens?.session?.match && document.querySelector('.coach'), 60000);
  check('the coach card shows the first step', await waitFor(() => /Move/.test(document.querySelector('.coach')?.textContent ?? '')), await M(() => document.querySelector('.coach')?.textContent?.slice(0, 80)));
  check('the computer side is on Casual', (await M(() => window.__elevens.session.cfg.difficulty[1])) === 'casual');
  await shot('11-coach');
  // Walk a little with the keyboard, then play the rest of the steps through match events.
  await page.keyboard.down('KeyD'); await sleep(3000); await page.keyboard.up('KeyD');
  for (const id of ['move', 'sprint', 'switch', 'jockey', 'tackle']) await M((i) => window.__elevens.coach.done.add(i), id);
  await M(() => {
    const m = window.__elevens.session.match, c = m.ctrl[0].pid;
    for (const t of ['pass', 'through', 'lob']) m.emit('kick', { team: 0, player: c, text: t });
    m.emit('skill', { team: 0, player: c, text: 'stepover' });
    m.emit('kick', { team: 0, player: c, text: 'shot' });
    m.emit('goal', { team: 0, player: c, text: '' });
  });
  check('finishing every step completes the guided match', await waitFor(() => /Guided match complete/.test(document.querySelector('#ui')?.textContent ?? ''), 20000));
  const st4 = await store();
  check('tutorial done is saved and Learner unlocked', st4.slots[st4.active].tutorialDone && !!st4.slots[st4.active].achievements.tutorial);
  await shot('12-tutorial-done');
  await page.click('[data-a=menu]');
  check('no first-run prompt once the tutorial is done', await waitFor(() => !!document.querySelector('[data-a=offline]') && !document.querySelector('.first-run')));

  check('no page errors', report.consoleErrors.filter((e) => !/favicon|WebGL|GPU stall|404/.test(e)).length === 0, report.consoleErrors.slice(0, 3).join(' | '));
} finally {
  writeFileSync(OUT + 'e2e-remaining-report.json', JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
  const failed = report.checks.filter((c) => !c.ok).length;
  console.log(`${report.checks.length - failed}/${report.checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
