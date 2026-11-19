
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
