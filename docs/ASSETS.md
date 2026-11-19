# Assets and licence notes

## Game assets

Almost every asset in ELEVENS is generated at run time by code written for this project. The exception is the realistic player bodies and their motion clips in `public/models/`, which were generated with Higgsfield (Meshy image-to-3D and auto-rigging) from reference images of invented players (see below). The other exception is the recorded crowd and ball sounds in `public/sfx/`, from Pixabay (see below). The repository contains no other image, model, audio or font files.

| Asset | How it is made | Source |
| --- | --- | --- |
| Players (Realistic, Medium and above) | Three textured, rigged bodies (light, dark and olive skin, about 14k vertices each) generated with Higgsfield from AI-generated reference images of fictional players. The kit is a colour key (shirt #00FF00, sleeves #00FFFF, shorts #0000FF, socks #FF00FF) that `scripts/build-players.mjs` turns into grey shading plus a mask, so each club's colours are applied in the shader; numbers are a canvas decal | `public/models/body-*.glb`, `body-*-kit.png`, `src/client/render/realplayer.ts` |
| Animation (Realistic) | Motion clips from the Higgsfield/Meshy animation library: idle, casual walk, run (jog), sprint, a soccer kick and a feet-first slide, retargeted onto each body. Locomotion blends by speed on a shared gait phase; the kick is time-warped so contact matches the simulation; the slide is warped onto the simulation's slide and get-up and kept on the ground. Running has a light code layer (lean, arm swing, pelvis yaw damping, banking into turns). Keeper dives are posed on the skeleton in code (`applyDive`): the library has no keeper dive. Everything else (tackles, keeper catches, headers, throw-ins, skills, celebrations, jockeying) is the procedural pose solver mapped onto the skeleton | `public/models/anim-*.glb`, `src/client/render/realplayer.ts` |
| Players (Classic, and always on Low) | Rigged primitives (capsules, boxes, spheres) posed procedurally each frame; kits coloured per club | `src/client/render/player.ts` |
| Animation (Classic) | Procedural: gait phase driven by distance travelled, blended action poses (kick, tackle, header, throw, dive, celebrate) | `src/client/render/player.ts` |
| Stadium | Generated geometry: pitch, line markings, goals and nets (`stadium.ts`); the two-tier bowl, roof and light ring, LED boards and ribbon with invented sponsors only, tunnel, dugouts, cameras, staff, big screens and flares (`arena.ts`) | `src/client/render/stadium.ts`, `src/client/render/arena.ts` |
| Crowd | Instanced fans in the new bowl (`arena.ts`) and the older box figures (body, head, arms) on generated terraces; shirt and skin colours picked from palettes in code; movement (sway, standing, jumping, arms up) computed in a vertex shader. Supporters' banners show only the fictional club names and invented slogans | `src/client/render/crowd.ts`, `src/client/render/stadium.ts` |
| Textures | Drawn on `<canvas>` at start-up: mown grass, crowd, ball panels, net, shirt numbers, advertising boards | `src/client/render/textures.ts` |
| Advertising | Invented brand names (NORTHWIND, Brightwell Energy, KETTLE & CO., VOLTA MOBILE, Harlow Bank, FENWAY TYRES, Saltmarsh Cider). Any resemblance to real companies is unintended; rename them before commercial use if one turns out to exist | `src/client/render/textures.ts` |
| Clubs and players | Fictional clubs (Redmoor Rovers, Kestrel Bay), invented player names, no real likenesses | `src/shared/teams.ts` |
| Audio | Recorded crowd beds, chants, goal roar, ooh, gasp, boos, applause, two ball strikes and the net, from Pixabay (below). Synthesised with the Web Audio API: whistle, post, tackles, soft touches, menu clicks, and a fallback for any sound file that fails to load. No music, no commentary | `src/client/audio/audio.ts`, `public/sfx/` |
| Fonts | Fonts already installed on the player's device (a condensed system font if present, otherwise the system UI font); no web fonts are downloaded or bundled | `src/client/ui/styles.css` |
| Interface | Original layout and styling | `src/client/ui/` |

Nothing is copied from EA Sports FC/FIFA, GOALS or any other game: no code, logos, commentary, animations, music, likenesses or interface layouts. General football-game conventions (a sideline camera, a radar, a scoreboard in a corner, context-sensitive buttons) are genre conventions rather than anyone's protected assets.

### Generated player models

- Made 13 Nov 2026 with Higgsfield on the project owner's account: reference images with `gpt_image_2_6` (jobs fc36f76a, 90304bd7, 27250c4d), bodies with `image_to_3d` (jobs 1ad8705b, ce28411c, a7270a9a; textured, PBR, rigged, A-pose, 12k target triangles, 1.8 m), clips with `3d_rigging` on body A (walk 30 Casual_Walk, jog 14 Run_02, sprint 16 RunFast, kick 410 Kick_a_Soccer_Ball); idle (clip 0) came with each body. 146 credits in total. Slide added 16 Nov 2026: `3d_rigging` on body A with clip 517 slide_right (job 79748efc), 8 credits. Added 17 Nov 2026, 48 credits, `3d_rigging` on body A: 465 Leap_Right_and_Catch (keeper save), 419 Jump_to_Catch_and_Fall, 59 Victory_Cheer, 460 Jump_with_Arms_Open, 298 Cheer_with_Both_Hands_Up, 466 Regular_Jump (header). Replaced 18 Nov 2026, 16 credits, `3d_rigging` on body A: jog = 530 run_fast_3 (job 99478e24), sprint = 532 run_fast_4 (job b79afcb7); both carry root motion, which the game removes.
- The raw downloads (about 11 MB each) are not in the repository. To rebuild: put them in a folder as `body-a.glb`, `body-b.glb`, `body-c.glb`, `anim-walk.glb`, `anim-jog.glb`, `anim-sprint.glb`, `anim-kick.glb`, `anim-slide.glb` and run `node scripts/build-players.mjs <folder>`.
- **Licence: to be confirmed by the project owner.** Check Higgsfield's and Meshy's terms for commercial use of generated models and library animations on your plan before distributing the game commercially.

## Third-party software

Installed exact versions are pinned in `package.json` and locked in `package-lock.json`.

| Package | Version | Licence | Used for | Shipped to players? |
| --- | --- | --- | --- | --- |
| three | 0.186.1 | MIT | 3D rendering | Yes (client bundle) |
| ws | 8.22.0 | MIT | WebSocket server | Server only |
| vite | 8.3.4 | MIT | Client dev server and bundler | No |
| esbuild | 0.28.2 | MIT | Server bundle | No |
| typescript | 5.9.3 | Apache-2.0 | Type checking | No |
| tsx | 4.23.15 | MIT | Running TypeScript scripts | No |
| vitest | 5.0.5 | MIT | Tests | No |
| playwright-core | 1.56.1 | Apache-2.0 | Browser checks | No |
| @gltf-transform/core, @gltf-transform/functions | 4.5.1 | MIT | Building the player model files | No |
| jpeg-js, pngjs | 0.4.x, 7.x | BSD-3-Clause, MIT | Texture processing in the model build | No |
| @types/node, @types/three, @types/ws | 22.20.5, 0.186.0, 8.18.2 | MIT | Type definitions | No |

The client bundle includes three.js, whose MIT licence requires its copyright notice to be kept. The build copies `public/third-party-licences.txt` (the three.js licence text) to `dist/client/third-party-licences.txt`; keep it with any deployment of the client.

Transitive dependencies are listed in `package-lock.json`. To audit them: `npx license-checker --summary` (not a project dependency; run it ad hoc if you need the full list).

## Project licence

No licence has been chosen for the project itself (`"license": "UNLICENSED"`). Choose one before distributing the code.

## Sound effects (Pixabay)

Downloaded 17 Nov 2026 and used under the [Pixabay Content License](https://pixabay.com/service/license-summary/): free for commercial and non-commercial use, modification allowed, no attribution required; the files may not be sold or redistributed on their own. Content showing trademarks or brands may not be used commercially, so club-name chants were avoided. Each file was trimmed, mixed to mono and re-encoded at 80 kbps. The crowd reactions (ooh, gasp, boo, goal) were rebuilt on 17 Nov 2026 to sound like a full stadium rather than a few voices: many takes layered with pitch, timing and stereo offsets, a swell of real stadium noise under them and a stadium reverb (stereo, 96 kbps; `scripts/crowdify.py`).

| File | Pixabay sound | By | Edit |
| --- | --- | --- | --- |
| `crowd-a.mp3` | [football game in a big arena](https://pixabay.com/sound-effects/city-football-game-in-a-big-arena-31575/) | freesound_community (ckater) | looped with a 2 s crossfade, mono, loudness-normalised |
| `crowd-b.mp3` | [football crowd 3](https://pixabay.com/sound-effects/people-football-crowd-3-69245/) | freesound_community (OleSouWester) | looped with a 2 s crossfade, mono, loudness-normalised |
| `chant.mp3` | [Stadium chant](https://pixabay.com/sound-effects/people-stadium-chant-377306/) | PWLPL | fade-out, mono, normalised |
| `chant-2.mp3` | [Stadium chant](https://pixabay.com/sound-effects/people-stadium-chant-377307/) | PWLPL | fade-out, mono, normalised |
| `goal.mp3` | [Crowd Cheering](https://pixabay.com/sound-effects/people-crowd-cheering-379666/); [Crowd Cheers](https://pixabay.com/sound-effects/people-crowd-cheers-314919/); [Crowd Cheering in Stadium](https://pixabay.com/sound-effects/people-crowd-cheering-in-stadium-435357/) | u_xg7ssi08yr; storegraphic; vishiv | 8 layered takes over a swell of the stadium recording, stadium reverb |
| `ooh.mp3` | [Crowd Disappointment Reaction](https://pixabay.com/sound-effects/people-crowd-disappointment-reaction-352718/); [football game in a big arena](https://pixabay.com/sound-effects/city-football-game-in-a-big-arena-31575/) | Universfield; freesound_community (ckater) | 16 layered takes with pitch, timing and stereo offsets over a swell of the arena recording, stadium reverb |
| `gasp.mp3` | [Crowd Shocked Reaction](https://pixabay.com/sound-effects/people-crowd-shocked-reaction-352766/); [football game in a big arena](https://pixabay.com/sound-effects/city-football-game-in-a-big-arena-31575/) | Universfield; freesound_community (ckater) | 16 layered takes, arena swell, stadium reverb |
| `boo.mp3` | [Crowd Booing](https://pixabay.com/sound-effects/people-crowd-booing-494319/); [Crowd booing](https://pixabay.com/sound-effects/people-crowd-booing-377303/); [boo](https://pixabay.com/sound-effects/people-boo-6377/); [Crowd Noise](https://pixabay.com/sound-effects/people-crowd-noise-375725/) | DRAGON-STUDIO; PWLPL; freesound_community; SoundReality | 10 layered takes over a swell of the crowd-noise recording, stadium reverb |
| `applause.mp3` | [Large crowd applause](https://pixabay.com/sound-effects/people-large-crowd-applause-6250/) | freesound_community | 24 s excerpt from 0:05, mono, normalised |
| `kick-1.mp3` | [Soccer Ball Kick](https://pixabay.com/sound-effects/film-special-effects-soccer-ball-kick-37625/) | freesound_community (bittermelonheart) | silence trimmed, mono, peak-normalised |
| `kick-2.mp3` | [Soccer Kick](https://pixabay.com/sound-effects/film-special-effects-soccer-kick-6235/) | freesound_community | silence trimmed, mono, peak-normalised |
| `net.mp3` | [A football hits the net, goal](https://pixabay.com/sound-effects/film-special-effects-a-football-hits-the-net-goal-313216/) | forza1903 (labelled AI generated on Pixabay) | first 1.8 s, mono, peak-normalised |
| `ooh-2.mp3` | [Crowd Disappointment Reaction](https://pixabay.com/sound-effects/people-crowd-disappointment-reaction-352718/); [groan crescendo](https://pixabay.com/sound-effects/people-groan-crescendo-82041/); [football game in a big arena](https://pixabay.com/sound-effects/city-football-game-in-a-big-arena-31575/) | Universfield; freesound_community; freesound_community (ckater) | as ooh.mp3, a second take |
| `stomp.mp3` | [Powerful Stomps Claps Cheering (Sport Rhythmic Applause)](https://pixabay.com/sound-effects/people-powerful-stomps-claps-cheering-sport-rhythmic-applause-317290/) | DJARTMUSIC | tail trimmed, loudness-normalised; plays now and then instead of a chant, and after some goals |
| `call-shot.mp3` | [Football Commentator with FX What an amazing shot](https://pixabay.com/sound-effects/film-special-effects-football-commentator-with-fx-what-an-amazing-shot-534994/) | JonathanSlatterMusic | trimmed, mono, normalised; after a hard or long-range shot is saved or hits the woodwork |
| `call-strike.mp3` | [Football Commentator with FX Oh what a sweet strike](https://pixabay.com/sound-effects/film-special-effects-football-commentator-with-fx-oh-what-a-sweet-strike-546900/) | JonathanSlatterMusic | trimmed, mono, normalised; goals |
| `call-incredible.mp3` | [Football Commentator with FX That is nothing but incredible](https://pixabay.com/sound-effects/film-special-effects-football-commentator-with-fx-that-is-nothing-but-incredible-546898/) | JonathanSlatterMusic | trimmed, mono, normalised; goals |

## Music

- `public/music/menu.mp3`: "Stadium Drop", the title and menu music, made by Philip for the game (17 Nov 2026). Re-encoded from his upload to 128 kbps stereo with the cover art removed; the original is in `football-game/music/`. It loops on the menus and fades out when a match starts (Settings > Audio > Menu music / Music).
