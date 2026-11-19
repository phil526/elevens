# Verification report

Date: 19 October 2026, with the AI section and browser checks rerun on 10 November 2026 and the gameplay additions (set pieces, cards, skills, defending, switching) checked on 12 November 2026. Everything below was run in a Linux cloud container (4 vCPU Intel Xeon 2.1 GHz, 15 GB RAM, no GPU, Node 22.22.0). Nothing here was run on a physical phone, tablet, games controller or real GPU.

## Status labels

- **Verified automatically**: covered by a test or script that was run and passed in this environment.
- **Verified manually**: checked by a person (in this case Claude) looking at screenshots or output, not by an assertion.
- **Implemented, unverified**: code exists and runs in normal use but nothing specifically checked it.
- **Known limitation**: works in a reduced way, or has a known weakness.
- **Deferred**: not built.

## Commands run and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, no errors |
| `npm test` | 96 tests in 10 files, all passed (about 14 s), on 16 November 2026 (after the dribbling and animation changes) |
| `npm run build` | Passed. Client JS 876 kB (240 kB gzip), 16 November 2026 |
| `npm run e2e` | 21 browser checks, all passed once at the Low preset on 16 November 2026 after the dribbling and animation changes, no console errors. Earlier: all passed in four consecutive runs at the Low preset on 12 November 2026, no console errors. At Medium the same day, 3 of 4 runs had one timing failure (see Online and the bug list). Report: `scripts/out/e2e-report.json`, screenshots in `scripts/out/` |
| `npm run e2e:features` | 12 browser checks on 16 November 2026 (the 12 November additions plus the Broadcast view), all passed with no console errors. After the dribbling change the contain, slide, skill and click-to-switch checks failed in roughly 1 run in 3 (the previous build: 1 in 5). Cause: the test gave the ball to a player without moving it to his feet, so possession could be lost on the next tick. Fixed in the test; then 6 runs in a row passed. A second-yellow check failure was also seen twice before the fix and not after; its cause was not found. Earlier: 10 checks of the 12 November additions, all passed in four runs (Low preset, no console errors). Report: `scripts/out/e2e-features-report.json`, screenshots `scripts/out/features-*.png` |
| `npx tsx scripts/bench-dribble.ts` | Dribbling benchmark on an empty pitch; figures in the Dribbling and animation section |
| `node scripts/shots-anim.mjs [tag] [preset]` | Frame sheets of the realistic player jogging, sprinting, dribbling and sliding, side on; used for the animation review |
| `npx tsx scripts/bench-features.ts` | AI-v-AI benchmark of finishing, fouls, cards and difficulty; figures in the Gameplay additions section |
| `node scripts/shots-quality.mjs` | Same kick-off rendered at Low, Medium, High and Ultra with no console errors. Screenshots `scripts/out/quality-*.png`, figures in `quality-report.json` |
| `npm run sim -- 10 6 11` | 10 AI-v-AI 6-minute matches completed; figures below. `scripts/diag-pass2.ts` classifies how passes are lost |
| Production install | `npm ci --omit=dev` on `package.json` + lockfile + `dist/` only, then `node dist/server/index.mjs`: `/health`, `/` and the licence file served with HTTP 200 |
| Clean checkout | The delivered `elevens-source.zip` unzipped into an empty folder: `npm ci` (0 vulnerabilities reported), typecheck, 62 tests and build all passed |
| Dev mode | `npm run dev` + `npm run dev:server`: page served by Vite, WebSocket `hello` answered through Vite's `/ws` proxy |

## Results by area

### Simulation and rules

| Item | Status | Evidence |
| --- | --- | --- |
| Two clubs of 11 with one keeper, unique numbers, full 4-3-3 | Verified automatically | `tests/teams.test.ts` |
| Full match flow: kick-off, two halves, half-time, ends swapped, second-half kick-off by the other team, full time at 90:00 | Verified automatically | `tests/match.test.ts` |
| Goal counts once; conceding side kicks off | Verified automatically | `tests/match.test.ts` |
| Fast shots cannot tunnel through posts; over the bar is not a goal; touchline crossings located | Verified automatically | `tests/ball.test.ts` (sub-stepped ball, max 5 cm per step) |
| Whole ball must cross the line | Verified automatically (one slow-roll case) | `tests/ball.test.ts` |
| Throw-in, goal kick and corner awarded to the right team | Verified automatically | `tests/match.test.ts` |
| Offside: flagged beyond second-last defender, not in own half, not from throw-ins; indirect free kick when involved | Verified automatically | `tests/match.test.ts` |
| Fouls: free kick at the spot, penalty inside the area | Verified automatically | `tests/match.test.ts` |
| Single ball owner at all times; no stuck ball beyond the 10 s recovery | Verified automatically (every tick of a full match) | `tests/match.test.ts` |
| Deterministic for a given seed | Verified automatically | `tests/match.test.ts` |
| Both teams can score | Verified automatically | `tests/match.test.ts` (seeded AI matches) |
| Advantage, yellow and red cards, sending off | Verified automatically | `tests/features.test.ts` (see Gameplay additions) |
| Injuries, substitutions, added time | Deferred | See LIMITATIONS.md |

### AI (headless, AI v AI, 6 real minutes per match, Pro v Pro)

Three tuning rounds on 10 November 2026 targeted low scoring and poor passing:

1. **Interceptions, dribbling, passing and crosses.** Players other than the intended receiver have less reach for a firmly struck pass in flight. Carriers in the final third are drawn towards goal, passes into central attacking areas score higher, and crosses are considered from wider and deeper positions.
2. **Pass lead and attacking runs.** Ordinary passes lead a moving receiver by at most 0.7 s of their movement. Before, a 20 m pass to a sprinting player was aimed up to 15 m ahead of them. This also applies to human passes. Receivers run to where they can still reach the ball. Attackers make forward runs more often, and the AI shoots more willingly from 18–26 m. Box runs for a cross take priority over offering a short option, and runners stay onside.
3. **Attacking shape.** Once the ball is 10 m into the opponents' half, the team moves up as a unit. The striker and the far-side winger hold the box on the offside line, the far-side central midfielder arrives at its edge, ball-side players support close behind, and the defence steps up. In the middle third, a carrier with fewer than three teammates ahead keeps the ball with safe passes instead of running alone.

These three ideas were tried and dropped because they made no measurable difference: the winger waiting when the box is empty, earlier box runs alone, and firmer through balls.

Measured with `npm run sim` on the same 80 seeds (11–20, 31–40, …, 151–160):

| Measure (80 matches) | October build | After round 1 | After round 2 |
| --- | --- | --- | --- |
| Goals | 54 | 79 | 105 |
| Shots / on target | 397 / 190 | 469 / 253 | 632 / 352 |
| Keeper saves | 102 | 122 | 185 |
| Pass completion | 60.0% | 60.6% | 70.6% |

Round 3 was judged on 320 matches: the 80 seeds above plus the same pattern offset by 200, 400 and 600, which were not used for tuning.

| Measure (320 matches) | After round 2 | Round 3, shape only | Round 3, shape and patience |
| --- | --- | --- | --- |
| Goals | 416 | 478 | 514 (1.6 per match) |
| Shots / on target | 2,577 / 1,353 | 3,041 / 1,674 | 3,408 / 1,916 |
| Keeper saves | 677 | 839 | 987 |
| Pass completion | 70.6% | 70.3% | 72.3% |

Box presence (`scripts/diag-box.ts 11 80`): the share of wide final-third moments with a teammate in the box rose from 13% to 25%. Shots from inside 12 m rose from 23 to 42, and the share of shots from 24 m or more fell from 63% to 54%.

Scores across 80 matches after round 3 (`npm run sim -- 20 6 N` for N = 11, 211, 411, 611): 18 matches had no goals, 29 had one, 16 had two, 13 had three and 4 had four or more.

The reference run (`npm run sim -- 10 6 11`, log in `scripts/out/sim-10x6-seed11.txt`) happens to be a low-scoring sample after round 3. Ten-match totals vary by about ±5 goals.

| Measure (reference run) | Result |
| --- | --- |
| Goals | 8 (Redmoor 3, Kestrel 5) |
| Goalless matches | 5 of 10 |
| Shots / on target | 85 / 50 |
| Keeper saves | 30 |
| Passes completed | 879 of 1,237 (71%) |
| Tackles / fouls | 156 / 57 |
| Corners / offsides | 6 / 1 |
| Restarts where a player had to be placed after the setup limit | 10 logged |
| Simulation cost | 0.02–0.04 ms per 60 Hz tick |

Status: **Known limitation.** Passing is believable, and scoring has roughly tripled since October to about 1.6 goals per match. More than half of all shots still come from 24 m or more, and about one match in five ends 0-0. Small parameter changes move 80-match goal totals by up to ±25, so compare changes on 320 matches. Nobody has play-tested the new behaviour. The higher defensive line in attack may leave the AI more open to counter-attacks by a human player.

### Gameplay additions (12 November 2026)

| Item | Status | Evidence |
| --- | --- | --- |
| Aimed free kicks: the target moves with the stick, a pass lands within 4 m of it, a direct shot clears the wall | Verified automatically | `tests/features.test.ts`; browser check moves the target with W (z −2.5 to −12.1) and takes it with K |
| Aimed corners (lob crosses to the target, pass plays it short) | Implemented, unverified | Shares the free-kick code path; no corner-specific test |
| Penalties aimed along the goal line | Verified automatically | Unit test: the shot goes to the aimed side |
| Set-piece target drawn on the pitch, with a hint | Verified automatically and manually | Browser check and screenshot `features-01-freekick-target.png` |
| Second yellow sends off; the team plays on with ten; kick-off still works with the striker sent off | Verified automatically | Unit tests, browser check, screenshot `features-03-sent-off.png` |
| Denying an obvious goal-scoring chance outside the box is a straight red | Verified automatically | Unit test |
| Advantage: free kick given back if the ball is lost, play on when it expires | Verified automatically | Two unit tests |
| Slide tackle: clean from the front, a foul from behind | Verified automatically | Unit tests; browser check with L; screenshot `features-04-slide.png` |
| Skill moves (knock-on, drag-back, step-over beating a defender), cooldown, sprint burst | Verified automatically | Unit tests; browser check with U |
| Contain: holding through sends a teammate to press | Verified automatically | Unit test and browser check |
| Switch by right-stick flick or by clicking a player | Verified automatically (flick in unit tests only) | Unit tests; browser check clicks a teammate. No physical controller was connected |
| Touch SKILL, SLIDE and CONTAIN buttons, tap to switch | Implemented, unverified | Button mapping unit-tested; not pressed in an emulated or physical touch browser |
| Online carries cards, sent-off players and the set-piece target | Verified automatically (snapshot and protocol tests) | Not exercised in a two-browser match |
| How any of this feels to a person | Not verified | Nobody has played it |

**Finishing and fouls.** `scripts/bench-features.ts`, Pro v Pro, AI v AI, 6-minute matches, the same seeds for both builds (seeds 1000 onwards):

| Measure (160 matches) | Before | After |
| --- | --- | --- |
| Goals | 300 | 276 |
| Shots | 1,660 | 1,621 |
| Shots from 24 m or more | 845 (51%) | 696 (43%) |
| Shots from inside 12 m | 97 | 122 |
| Goals from inside 12 m / 12–18 m / 18–24 m / 24 m+ | 55 / 37 / 66 / 118 | 70 / 37 / 79 / 71 |
| Pass completion | 72.6% (320 matches) | 73.6% |
| Fouls / advantages played | not counted | 643 / 70 (11%) |
| Yellow / second yellow / straight red | none | 212 / 16 / 4 |
| Slide tackles / skill moves | none | 191 / 538 |

On a further 80 matches goals were 138 against 141 before. Status: **Known limitation.** Long shots fell and close-range chances rose, but 43% of shots still come from 24 m or more. A stronger long-shot penalty cut long shots to 35% but goals fell to 496 in 320 matches (against 563 with the milder penalty and 600 before the change), so it was not kept. Penalties stay rare, about one in 160 matches.

**Difficulty (simulation only).** 160 matches per pairing with each level playing both sides:

| Pairing | Wins | Draws | Goals |
| --- | --- | --- | --- |
| Pro v Casual | 98 – 35 | 27 | 221 – 95 |
| Elite v Pro | 81 – 30 | 49 | 182 – 91 |
| Elite v Casual | 123 – 5 | 32 | 302 – 49 |

Status: **Verified automatically for AI v AI only.** The levels rank in the intended order, so no values were changed. How hard each level feels against a human is **not verified**: no person has played the game.

### Broadcast camera view (16 November 2026)

| Item | Status | Evidence |
| --- | --- | --- |
| Settings → Camera → View switches between Tracking and Broadcast, from the pause menu mid-match | Verified automatically | `npm run e2e:features`: the setting is saved and the camera moves to the gantry (x 0, 34 m up, 70 m from the centre line) with a TV lens |
| Broadcast camera stays above halfway, turns towards play, narrows its lens at the far end; switching back restores the Tracking lens | Verified automatically | `tests/camera.test.ts` |
| Movement and right-stick flicks are rotated by the camera heading; Tracking input unchanged | Verified automatically | `tests/camera.test.ts`; browser check that the input heading matches the camera heading |
| Framing at centre, both boxes, a far corner and the near touchline | Verified manually | `node scripts/shots-camera.mjs medium`: screenshots `camera-tracking-*.png` and `camera-broadcast-*.png`. The first gantry position (30 m up, 74 m back) let the near stand cover the near touchline; it was raised and brought in |
| How the pan and zoom feel in live play, and whether turning controls are comfortable | Not verified | Software rendering runs at 1–3 fps here, so motion could not be judged; nobody has played it |

### Dribbling and player animation (16 November 2026)

Dribbling benchmark (`npx tsx scripts/bench-dribble.ts`): a human-controlled striker with the ball on an empty pitch, before and after the change.

| Measure | Before | After |
| --- | --- | --- |
| 25 m jog with the ball (without: 4.40 s) | 4.70 s | 4.58 s |
| 30 m sprint with the ball (without: 3.72 s) | 3.98 s | 3.88 s |
| Furthest the ball runs from the player while sprinting | 1.93 m | 1.46 m |
| Ball kept through a 45°, 90° or 180° turn, jogging or sprinting | 0 of 6 (the ball ran on 25–50 m) | 6 of 6 |
| Time for the ball to follow the new direction | never | 0.05–0.33 s (body: 0.07–0.38 s) |

| Item | Status | Evidence |
| --- | --- | --- |
| Turning with the ball keeps it: a cut redirects the next touch, a sharp turn cushions it at the feet | Verified automatically | `tests/dribble.test.ts` (6 tests; all 6 fail on the previous code) and the benchmark above |
| Effect on AI-v-AI matches | Verified automatically (known balance shift) | `bench-features.ts` 160 Pro-v-Pro matches, seeds 1000+, before → after: goals 274 → 362, shots 1621 → 2223, fouls 685 → 442, yellow cards 226 → 141, corners 106 → 149, pass completion 73.9% → 72.7%, shots from 24 m+ 43% → 40%. Holding the ball more easily means fewer fouls and more shots. Difficulty ordering was not re-run |
| Realistic players run more upright and pump their arms (a layer over the motion clips) | Verified manually from still frames | `node scripts/shots-anim.mjs after2 medium`, sheets `scripts/out/anim-*.png`, compared with the `before` sheets |
| Slide tackle has a take-off, a low glide and a stop, then a get-up instead of a stumble | Verified manually from still frames | Same script, `anim-*-slide.png` |
| Realistic players' slide uses a motion-captured clip (Higgsfield slide_right, bought 16 Nov with Philip's approval), warped onto the 0.7 s slide and the 0.9 s on the ground, with the body shifted so the toes sit at the captured height | Verified manually from still frames | `ANIM_VIEW=front ANIM_ONLY=slide node scripts/shots-anim.mjs <tag>` and the side view. Before the height fix the get-up floated a few centimetres; afterwards the toe heights match the capture to about 1 cm (measured in the browser). Classic players keep the code-driven slide |
| How the new running and sliding look in motion, and how dribbling feels with a controller | Not verified | Software rendering runs at 1–4 fps here; nobody has played it |

### Online

| Item | Status | Evidence |
| --- | --- | --- |
| Rooms with private codes; third player refused; invalid and unknown codes rejected | Verified automatically | `tests/server.test.ts`, `tests/room.test.ts` |
| Both players receive identical authoritative snapshots | Verified automatically | Room test (in-memory) and live WebSocket test |
| Inputs are intentions only; stale, replayed or out-of-range inputs ignored; action spam capped | Verified automatically | `tests/protocol.test.ts`, `tests/room.test.ts` |
| Snapshot order and acks preserved under 60 ms ± 40 ms simulated latency and jitter | Verified automatically | `tests/server.test.ts` |
| Disconnect: AI takes over, seat resumed with token, abandoned after grace, total grace capped | Verified automatically | `tests/room.test.ts`, `tests/server.test.ts` |
| Rematch resets to 0-0 | Verified automatically | `tests/room.test.ts` |
| Rate limit, malformed-message disconnect, origin allow-list | Verified automatically | `tests/server.test.ts` |
| Two browsers: create, share link, join, ready, play, same score, opponent-dropped notice | Verified automatically | `npm run e2e` (two Chromium contexts, same machine, no added latency) |
| Clock agreement between the two browsers | Verified automatically, with a caveat | On 12 November at Low: median difference 2.8–3.0 football seconds (about 0.2 s real, limit 7.5) in four runs, with both pages sharing one CPU rendering in software at 2.6–2.9 fps. At Medium (1.3–1.4 fps once the 3D crowd was added) one rendered frame is worth about 10 football seconds, and the check failed in 2 of 4 runs (median 8.3 and 9.9). The check now defaults to Low; it measures the network loop, not rendering |
| Client-side prediction and reconciliation feel under real latency | Implemented, unverified | Exercised at near-zero latency only; not judged by a person under lag |
| Real internet play, NAT, mobile networks, TLS deployment | Not verified | No hosted deployment was made |

The networking is **not production-ready**. It has no load testing, no horizontal scaling, no per-IP limits and no abuse handling.

### Browser client

| Item | Status | Evidence |
| --- | --- | --- |
| Menus: title, mode, clubs and kits, match settings, loading, pause, controls, settings | Verified automatically and manually | e2e clicks through them; screenshots `offline-01` to `offline-09` reviewed |
| Keyboard play: kick-off, run, sprint, shoot, pause, controls overlay | Verified automatically | e2e |
| Half-time, full-time results with stats, rematch, quit to menu | Verified automatically | e2e (the clock is fast-forwarded through the `?test` hook) |
| Rendering: pitch markings, stadium, players, ball, HUD, radar | Verified manually | Screenshots reviewed; fixed during review: missing line markings, near stand blocking the view, ball too small to see, radar covering the clock on phones, results heading wrapping |
| Stadium and 3D crowd (stepped terraces, corner stands, supporters in club colours by end, crowd standing and celebrating with play and goals, banners) | Verified manually | Screenshots `crowd-<preset>-1` to `-6` from `node scripts/shots-crowd.mjs high` and `medium` reviewed: broadcast, aerial, close-ups, and each end before and after a goal is added through the `?test` hook. Excitement driven by the ball's position was only seen in those stills, not watched in live play |
| Frame rate | Known limitation of the test setup | Headless Chromium with **software** WebGL (SwiftShader) on a 4-core cloud VM, 1280 × 720. With the 3D crowd: Low 3.9, Medium 2.1, High 1.1, Ultra 1.1 fps (before the crowd: Low 3.8–4.1, Medium 2.9–3.2, High 1.5, Ultra 1.4). Per frame, all passes included: Low 365 draw calls and 78k triangles (unchanged), Medium 792 and 450k (was 774 and 182k), High and Ultra 813 and 848k. Medium and High exceed the 600-draw-call budget in DESIGN.md; before this change the High count could not be read because the post-processing passes reset the counter, so it is not known whether High already exceeded it. This says nothing about real hardware; no GPU measurement was possible. **Correction:** earlier versions of this report gave 10–12 fps; the in-game readout clamped frame time at 100 ms, so it could never show less than 10 fps. The readout now uses the real frame time |
| Graphics presets (bloom, image-based lighting, ball-following shadows, 4096 shadows and grass on Ultra, finer player meshes) | Verified manually | Four preset screenshots compared; bloom was toned down after the first Ultra screenshot showed the halfway line glowing and the grass looking streaky |
| High and Ultra frame rate on real graphics cards | Not verified | No GPU available. High is now the desktop default on the assumption that a mid-range desktop GPU holds 60 fps with about 850k triangles a frame; that assumption is untested |
| Audio | Implemented, unverified | Web Audio synthesis runs without errors; nobody listened to it |
| Controller | Partly verified | Dead zone, family detection and labels unit-tested; no physical controller was connected |
| Phone layout (iPhone 13 landscape, emulated) | Verified automatically, **emulated only** | Touch controls shown, tapping PASS takes the kick-off, portrait shows the rotate prompt. Screenshots `mobile-01`, `mobile-02` |
| Tablet layout (iPad landscape, emulated) | Verified automatically, **emulated only** | Screenshot `tablet-01` |
| Physical phones and tablets | Not verified | Touch feel, performance, safe areas and thermal behaviour on real devices are unknown |
| Firefox and Safari | Not verified | Only Chromium was available |
| Settings persistence | Implemented, unverified | Stored in localStorage with try/catch; not asserted by a test |

### Deployment

| Item | Status |
| --- | --- |
| Production build and production-only install | Verified automatically (see table at the top) |
| Dockerfile | Implemented, unverified (no Docker daemon in this environment) |
| Caddy, nginx and systemd examples | Implemented, unverified |
| Hosted deployment | Not done |
| Offline preview published as a claude.ai Artifact (built client only, no server) | Implemented, unverified: published, but not loaded in the Artifact viewer by an automated check. Online play cannot work there |

## Bugs found and fixed during verification

- Quick key taps between two input samples were lost (most visible at low frame rates); taps are now latched for one sample on keyboard and touch.
- Pressing Enter on the title screen also activated the first button of the next screen.
- Pitch markings were invisible (mixed triangle winding) and the near stand's roof blocked the bottom of the broadcast view.
- Intended receivers let passes run past them; receivers now step towards the ball and stretch for it.
- Keepers dived as soon as they read a shot and were lying on the ground when it arrived; dives are now timed to the ball.
- A keeper with a back-pass at their feet could dribble into their own goal.
- Most restarts teleported stragglers into position; only the taker and opponents inside the required distance are now placed.
- The renderer's draw-call and triangle counts showed 1 and 1 at High and Ultra, because the post-processing passes reset them each pass; they now cover the whole frame.
- The offline browser check failed its timed steps at High once the crowd was added (0.7 fps in software); it now runs at Medium by default (`E2E_OFFLINE_PRESET` overrides), like the online check.
- 12 November: with the 3D crowd, the older browser checks became intermittent at Medium (1.3–1.8 fps in software): the online clock check failed twice and the half-time check once in four runs. They now default to Low (`E2E_OFFLINE_PRESET` and `E2E_ONLINE_PRESET` override); the preset screenshots still cover Medium and above.
- 12 November: the second-yellow banner ("SECOND YELLOW · RED") wrapped onto three lines over the pitch; it now reads "RED CARD" with the club, player and "second yellow" on one smaller line.
- 12 November, during the feature work: a head-on slide poked the ball straight back to the carrier; it is now knocked sideways.
- The frame-rate readout could not show less than 10 fps (it used the clamped simulation step). Found while checking the graphics update; the earlier 10–12 fps figure was wrong.

- 17 November, charged passes and new kicks: the in-match input copy dropped the shot style, so holding lob with shoot played an ordinary shot. Found by the new browser chip check; the style now survives `Match.applyInput` and a unit test covers it.

## Charged passing, first touch, chips, low drives and weak foot (17 November 2026)

- Typecheck clean; 114 unit tests pass (18 new in `tests/kicks.test.ts`: charged buttons and modifiers, protocol, near/far receiver choice, driven pass pace, chip height and over-hit, low drive never skied, weak-foot profile and accuracy, first touch killed / steered / pushed, chip through match input).
- `npm run e2e`: 21/21, no console errors. `npm run e2e:features`: 14/14 (two new: the power bar reads PASS while J is held and the pass goes on release; L held with K reads CHIP and plays a chip, not a lob). The red-card banner check failed once in three runs (timing at software frame rates) and passed on the other two. Both runs used `CHROMIUM_PATH=/opt/pw-browsers/chromium` because this container's Chromium is a newer build.
- AI balance, 160 Pro v Pro matches (seeds 1000–1159), before → after: goals 362 → 342, on target 1312 → 1216 (the weaker foot), passes completed 72.7% → 72.9%, fouls 442 → 436, yellows 141 → 141. The computer chose 16 chips and 136 low drives out of 2,250 shots. Slide counts from the benchmark's per-tick counter differed (507 → 244), but a direct count of slide starts over 40 matches gave 67 → 54, and the change to the AI shot choice alone (no weak foot) gave 47, so it is within the noise of the random stream.
- Not verified: how the charge timing and first touch feel in human hands, a real controller holding two face buttons for a chip, and touch screens.

## Called runs, timed set pieces, keeper rushes and quick restarts (17 November 2026)

- Typecheck clean; 125 unit tests pass (11 new in `tests/setpieces2.test.ts`: ring timing and its effect on spread, penalty accuracy taken from the ring, called run goes in behind and the stick picks the runner, computer keeper comes out to a striker clean through but not when covered, the rush button sends the keeper out, smother wins or leaves the keeper down, quick throw-in taken before setup, off means wait, early presses ignored).
- `npm run e2e`: 21/21, no console errors. `npm run e2e:features`: 17/17 (new: timing ring shown at a free kick, Q with the ball calls a run with a toast, U without the ball sends the keeper out).
- AI balance, the same 160 matches against the previous version: goals 342 → 352, on target 1216 → 1237, passes completed 72.9% → 73.1%, fouls 436 → 434. Within the usual noise.
- Not verified: how the ring timing, quick restarts and keeper rush feel in human hands; the controller right-stick click for the rush.

## How to reproduce

```bash
npm ci
npm run typecheck && npm test
npm run build && npm run e2e && npm run e2e:features   # needs Chromium; set CHROMIUM_PATH if not at /opt/pw-browsers/...
npx tsx scripts/bench-features.ts 1000 40 pro pro
npm run sim -- 10 6 11
```
