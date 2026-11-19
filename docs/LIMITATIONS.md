# Limitations, deferred features and roadmap

## Known limitations

**Gameplay and AI**
- AI-v-AI matches average about 1.7 goals (276 in 160 matches on 12 November; October's build managed about 0.7), with 74% pass completion. 43% of shots still come from 24 m or more (down from 51%), and penalties are very rare (about one in 160 matches). The new attacking shape pushes the defence up, which a human may exploit on the counter; this has not been play-tested (see VERIFICATION.md).
- Dribbling was made more responsive on 16 November (the ball now follows cuts and turns). In 160 AI-v-AI matches this raised goals from about 1.7 to 2.3 a match and cut fouls by a third; difficulty levels were not re-checked afterwards.
- The AI has not been play-tested by people. Difficulty levels change reaction time, decision noise, pressing, interception awareness, skill-move and slide-tackle rates. They rank correctly against each other in AI-v-AI simulation, but how hard they feel to a human is unjudged.
- With a player sent off, the team keeps its 4-3-3 positions minus that player instead of reshaping, which leaves a gap on that side.
- A card held back while advantage is played is shown when the advantage ends, not at the next stoppage as a referee would.
- Advantage is never played inside the penalty area or after a red-card foul. Walls are placed automatically and cannot be moved.
- Skill moves are three moves (knock-on, drag-back, step-over); there are no tricks in the air or chained moves.
- Humans never control the goalkeeper; the AI always keeps goal for both sides.
- Offside is judged at the moment of the pass from positions on the ground plane; there is no "active play" nuance beyond touching the ball.
- Headers, volleys and chest control are simplified: the ball is redirected or controlled by rules rather than by full body physics.
- Restart setup is limited to 3 seconds; occasionally the taker or an encroaching opponent is placed directly into position (logged in debug).
- After a goal, everyone is lined up instantly for the kick-off rather than walking back.

**Presentation**
- Realistic players come in three bodies (the nearest skin tone is picked per player), so hair and faces repeat across a team. Only idle, walk, jog, sprint and kick are motion clips. Running has a code layer on top that stands the body up and pumps the arms, judged from still frames only. The slide tackle and the get-up after it use a motion-captured clip (Classic players keep a code-driven slide). Tackles, dives, headers, throw-ins, skills and celebrations are procedural poses on the realistic skeleton and look stiffer. Goalkeepers' hands keep skin colour rather than gloves. There is no kit physics. Classic (and Low) players are rigged primitives with procedural animation.
- Realistic players cost about a third of the frame rate in software rendering (Medium: 1.3 vs 2.1 fps under SwiftShader); not yet measured on real GPUs. Switch Players to Classic in Settings if a device struggles.
- The crowd is 8,299 simple box figures on Medium and 20,663 on High and Ultra (counted in the built game), animated together in the vertex shader. It reacts to which side is attacking and to goals, but there are no individual animations, flags, scarves or tifos. They cost 266k triangles on Medium and 661k on High (32 per person). Low keeps the old painted crowd.
- Two camera views (Tracking and a fixed-gantry Broadcast view) with height and zoom options. The Broadcast view's feel in live play has not been judged by a person; its pan speed and framing were set from still screenshots. No replays, no cut-scenes, no commentary, no music.
- The ball is drawn 1.6× its real size for readability.
- The client bundle is 781 kB of JavaScript (212 kB gzip) because three.js is included whole; it is not code-split.

**Online**
- Not production-ready. One server process holds all rooms in memory; a restart ends every match. No horizontal scaling, per-IP limits, abuse reporting, matchmaking or spectators.
- Tested only on one machine (two browser contexts) and with simulated latency in automated tests. Real internet conditions, mobile networks and NAT traversal behind proxies are untested.
- Client prediction covers only the locally controlled player's movement; actions (kicks, tackles) wait for the server, so under high latency they feel delayed by the round trip.
- No unilateral pause; half-time online is a fixed 10-second break.
- Reconnect relies on a token in the tab's session storage, so closing the tab (not just losing the connection) gives up the seat.

**Devices**
- Phone and tablet layouts were checked only in emulated Chromium. The SKILL, SLIDE and CONTAIN touch buttons and tap-to-switch were not pressed in any touch browser; only their mapping is unit-tested. The right-stick flick was not tried on a physical controller.
- On physical phones and tablets, touch feel, frame rate, battery use and heat are unknown.
- Frame rate was only measured in software rendering (1.1–3.9 fps headless depending on preset, no GPU). The 60 fps target on mid-range hardware is unverified, and so is whether High (now the desktop default) and Ultra hold it.
- High and Ultra improve lighting, shadows, texture detail and edge quality, and from Medium up the players use the realistic generated models (Settings, Players).
- Only Chromium was tested. Firefox and Safari should work (standard WebGL 2, Web Audio, Gamepad and Pointer Events) but were not checked.
- Phones need landscape orientation.
- Charged kicks (17 Nov 2026): touch screens have no modifier button in attack, so driven passes, lofted through balls and placed shots are keyboard and controller only; chips and low drives on touch need two buttons held at once. Computer players do not steer their first touch (they keep the plain cushion). The weaker foot has no animation of its own: the kick clip is the same for both feet.
- Called runs, keeper rush (17 Nov 2026): touch screens have no button for either. On a controller the keeper rush is a right-stick click. The keeper's smother uses the existing "down" pose, not a dedicated dive-at-feet animation. Online, the timing ring is drawn from the last snapshot, so a laggy connection judges the timing about half a round trip late.

## Deferred features (out of scope for this version)

- Rules: injuries, substitutions, handball, added time, extra time and penalty shoot-outs.
- Set pieces: walls you can move, keeper movement on penalties, rehearsed routines.
- Player control of the goalkeeper.
- Tactics beyond the three mentalities (formations, pressing intensity sliders, player instructions).
- More clubs, stadiums, weather and time of day.
- Replays, highlights, commentary, music.
- Online: matchmaking, spectators, persistent server, reconnect after closing the tab, regional servers.
- Excluded by the brief: career mode, Ultimate Team-style modes, packs, accounts and progression.

## Roadmap

1. **Play-test and tune (next).** Put the build in front of a handful of players on real hardware; tune AI difficulty, pass assistance, shot accuracy and keeper reach from what they report. Measure real frame rates on a mid-range laptop and a mid-range phone and adjust quality presets.
2. **Feel under latency.** Run sessions with 50–150 ms real latency, add predicted kick and tackle start-up animations, and tune the interpolation buffer.
3. **Set pieces and rules.** Done on 12 November: aimed free kicks, corners and penalties; advantage and cards. Next: ten-man shape, movable walls, substitutions.
4. **Presentation.** Better animation blending, goal replays, behind-the-goal and player cameras, crowd chants synthesised to match play.
5. **Online hardening.** Per-IP limits at the server, metrics, structured logs, graceful drain on deploy, and a hosted reference deployment.
6. **Content.** Additional fictional clubs and a second stadium.
