
## 17 Nov late: crowd reactions sound like a stadium
- Philip: reactions (shots etc.) sounded like one voice. Rebuilt ooh, ooh-2 (new), gasp, boo and goal with `scripts/crowdify.py`: 8-16 pitch/time/pan-shifted layers of several Pixabay takes, a swell of real stadium noise, and a 2.3 s stereo reverb. Sources listed in docs/ASSETS.md and public/third-party-licences.txt.
- audio.ts: `anticipate()` lifts the crowd bed (surge gain) when a shot is struck; ooh/groan alternate between two takes with slight rate variation.
- Playable v30, tracker v11, 208 tests, e2e:ideas 14/14.

## 19 Nov: ten new modes and features ("Add them all")
- More modes: Career (seasons, squad, transfers, academy, league + cup, history), Be a Pro (one player, XP into attributes, offers, retire), Daily scenario (+ every scenario), Skill games (crossbar challenge, target practice), Trophy cabinet + club history, My goals (saved goal clips, watch from the stands then the net, Share video). Code in src/client/modes/; saves per slot in `elevens.modes.v1.<slot>`; clips in IndexedDB `elevens-clips` (40 max).
- Full-match commentary: shared/commentary.ts (200+ lines, pacing, context) + client/commentator.ts (browser voice and/or captions). Settings > Audio > Commentary.
- Injuries in offline matches: shared/injury.ts (down, physios run on, treat, stretcher, sub or ten men, added time); render/medics.ts draws physios, stretcher, bearers and the fourth official's LED board (+N added time, sub numbers). Career keeps injured players out.
- Ranked online: protocol 11. shared/ranked.ts (divisions 10..1 then Elite, 100 points each, Elo-based pairing window that widens), server/ranked.ts (RankStore on RANKED_FILE, RankQueue), room.ts (leaver loses). No accounts: random id + secret key in localStorage, server keeps a sha256 of the key.
- Own web address: hosting configs (.github/workflows/pages.yml, netlify.toml, fly.toml, render.yaml) and docs/DEPLOY.md "The game's own web address". Waiting for Philip to choose hosting.
- Checks: tests/modes19, career, pro, commentary, ranked; `npm run e2e:modes [section]`.

## 19 Nov: ten more visual effects ("Do them all")
- Footprints, slide tracks and divots: render/marks.ts `PitchMarks` stamps into a render target over the pitch (R = pressed snow/mud, G = torn turf; MARKS_RES px/m by quality, Low none) that the grass shader samples (vfx.ts uMarks). Slides throw up divots (InstancedMesh, MAX_DIVOTS) or snow clumps. Follows Settings > Graphics Pitch wear; nothing is stamped while a cinematic replays recorded play.
- Wet pitch: render/wet.ts `WetReflection` (High 0.4, Ultra 0.5 of screen res): a mirror camera draws REFLECT_LAYER (ball, players, managers, lamps, halos, sky) into a HalfFloat target, blended in the grass shader by wetness and puddles, smeared toward the camera. Medium/Low keep the glints. Spray off a rolling ball and from footsteps in rain/snow (Medium+).
- Fixed a crash at the start of a rain match on Medium+ (weather.ts setWind read uSnow on the splash material, which has none).
- Haze: render/haze.ts `FloodHaze` additive light cones from each floodlight bank (night most, dusk a little, more in rain/snow; Medium every other beam, Low none). renderer.hazeK.
- Lights on in the intro: `introLights(t)` (haze.ts) drives renderer.lightsOn during the fly-in; banks come on one by one in bankOrder (lamps, halos, haze, glare, sun/hemi scaled) with a clunk (audio.floodlight, MenuSfx.clunk) panned to the bank.
- Fan display: render/tifo.ts `FanDisplay` cards across the home end (x < -63) over both tiers (Arena.tiers), stripes + crest + name + slogan drawn on a canvas; up row by row from the front before the first kick-off, down at kick-off. Medium+.
- Flare smoke: render/smoke.ts `FlareSmoke` instanced billboards from Arena.flarePos; pre-warmed so the walk-out starts smoky, a trickle all match, a surge from the scorers' end for 18 s after a goal; drifts with the match wind. SMOKE_PUFFS by quality, Low none.
- Depth of field: Medium now has it too (render/dof.ts `LiteDof`: scene into a HalfFloat target with depth, one spiral-blur pass that tone maps; only while dofW > 0). Close-ups focus on what the cinematic shot looks at (within 40 m), not the ball.
- Handheld celebration camera: render/handheld.ts `Handheld.shake()` wraps the celebration shots (cine.ts celebFrame via renderer.handheldShot); online, renderer.liveHandheld cuts to `pitchsideShot` after a goal. Settings > Camera > Celebration camera Handheld/Steady (graphics.handheld, default Handheld); Reduced camera motion keeps a third of the wobble.
- Faces: realplayer.ts faceDetail adds aFace2 (brows, mouth corners, cheeks); uExpr (brow, smile, squint, grit) blended per player from MOODS: joy when celebrating/cheering, effort on kicks/tackles/headers/sprints (more when tired), frustration on protests/head in hands/dejected. Test hook renderer.faceTest = { id, mood } and renderer.faceFollow = { id, dist }.
- Checks: tests/pitchfx.test.ts; `node scripts/shots-third.mjs <out> <preset> <time> marks,wet,haze,tifo,smoke,lights,handheld,faces [query]` (needs `npm run build`; ~25 s per screenshot in software rendering).
