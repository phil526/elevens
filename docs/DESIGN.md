# ELEVENS — Game Design Document

*Version 0.1 (prototype). UK English.*

## 1. Working title and pitch

**ELEVENS** — *Broadcast-style football, one browser tab away.*

ELEVENS is an original 11-a-side football game that runs in a web browser. It aims for the feel people expect from modern console football games: a camera that looks like television coverage, passing that goes where you meant it to, shots you charge and release, defending that rewards timing rather than button mashing, and teammates who move like a team. Two fictional clubs, one stadium, and two ways to play: against the computer, or against a friend over the internet with a room code.

It is a prototype. It targets clear, readable, credible football on a laptop or phone, not the production scale of a commercial AAA title: players are procedurally built and animated figures, the crowd is thousands of simple box figures animated together, and there is no commentary.

## 2. Technology comparison and choice

| | **A. Three.js + TypeScript + Node/`ws` (chosen)** | B. Babylon.js + Havok + Colyseus | C. Unity WebGL + Netcode/Mirror |
|---|---|---|---|
| 3D rendering, characters | Mature WebGL renderer, small bundle; characters built and animated in code (no rigged assets needed) | Very capable, built-in animation/IK, larger bundle | Best tooling for skinned characters, but needs licensed or authored rigs |
| Physics | Custom football-specific ball model (simple, testable, identical on server) | Havok WASM rigid bodies; overkill for one ball, harder to run identically on Node | PhysX; server build needs Unity runtime |
| Shared client/server sim | Same TypeScript module runs in browser and Node | Possible, but Havok on server adds friction | C# shared, but server is a separate Unity headless build |
| Authoritative networking | Plain WebSocket, own protocol: full control and easy to test | Colyseus gives rooms/state sync but its schema delta model fights a 60 Hz custom sim | WebGL clients cannot use UDP; WebSocket transports exist but add layers |
| Gamepad / touch | Browser Gamepad API and Pointer Events directly | Same, with helpers | Unity Input System WebGL support is patchy on mobile |
| Mobile performance | Good with care (instancing, DPR cap) | Good | Large WASM download, high memory; weakest on phones |
| Dev / deploy complexity | Lowest: Vite static build + one Node process | Medium | Highest: editor, large builds, separate server build |
| Assets and licensing | Everything generated in code: no third-party art or audio licences | Same option, plus marketplace | Asset Store licences per asset |

**Choice: A.** It is the smallest stack that can deliver the whole game, and it lets one simulation module be the single source of truth offline, on the server and in tests.

- **Client:** TypeScript, Three.js 0.186 (WebGL2 renderer), DOM/CSS for menus and HUD, 2D canvas for the radar.
- **Server:** Node.js ≥ 20.19 running the same simulation, `ws` 8 WebSocket transport (WSS behind any TLS-terminating proxy).
- **Physics:** custom ball model in metres (gravity, drag, Magnus-style curve, bounce, rolling friction, cylinder collisions with posts and bar, net volume) with sub-stepping so that no step moves the ball more than 5 cm. Players are kinematic circles with a capsule for blocks and saves.
- **Animation:** procedural skeletal animation of a jointed figure: gait phase driven by distance travelled (minimises foot sliding), blended idle/run/sprint/jockey layers, and short overlays for passes, lofted passes, shots, tackles, saves, stumbles and celebrations. Ball release is timed to the visible contact frame.
- **Build:** Vite 8 for the client, esbuild for the server bundle, `tsx` for development.
- **Testing:** Vitest for simulation, rules, input and networking (including a real server with simulated latency); Playwright (Chromium) scripts for browser smoke tests, mobile emulation and two-client online play.
- **Hosting:** any static host for the client; any host that can run a long-lived Node process with WebSockets (a small VM, Fly.io, Render, Railway). The server can also serve the client itself.

**Quality target (honest):** stylised-realistic broadcast presentation with correct pitch proportions and recognisable football, at 60 fps on a mid-range desktop GPU and 30 fps on a recent mid-range phone. Not AAA: no motion capture, no individual crowd simulation, no commentary.

## 3. Design pillars

1. **The match is sacred.** Full 11-a-side, rules that resolve every situation, nothing that can freeze a match.
2. **Intent in, football out.** Input direction and button choice decide what happens; assistance is predictable and never passes backwards by surprise.
3. **A team, not eleven chasers.** Shape, support and cover are visible on the radar at all times.
4. **Fair online.** The server decides everything; clients only send intentions.
5. **Readable anywhere.** Broadcast camera, clear markers, works with keys, pads and thumbs.

## 4. Target players

Players who know console football and want a quick, credible match in a browser with a friend; casual players on phones; keyboard players who have never owned a pad. Sessions of 5–15 minutes.

## 5. Match structure and core loop

Title → mode → team selection → match settings → loading → kick-off → first half → half-time → second half → full-time → results → rematch or menu.

**Clock mapping.** Default match length is 6 real minutes of active play (3 per half; options 2, 4, 6, 8, 10). The displayed clock runs 45 football minutes per half, so at the default each real second is 15 football seconds. The clock runs during open play and ordinary restarts, and stops during goal celebrations, kick-off setup and half-time. There is no added time; the half ends at 45:00/90:00 on the next dead ball or after a 3-second grace period if a shot or attack is live. Draws stand.

**Core loop (moment to moment):** win the ball → find a passing option → move it forward through lanes → create a shooting angle → shoot, save, rebound → transition.

## 6. Camera and presentation

- Two views, chosen in Settings → Camera → View:
  - **Tracking** (default): an elevated sideline camera, about 26 m high and 46 m back from the near touchline at default, with a 30° vertical field of view. It slides along the touchline with play, so screen-right is always towards the right-hand goal.
  - **Broadcast**: a fixed TV gantry 34 m up and 36 m behind the near touchline, above the halfway line. It only pans, tilts and zooms, like a match camera on television: it turns towards each end (up to about 30°) and narrows its lens as play moves away so players stay about the same size on screen (about 34 m of pitch in shot at the play). The pan lags slightly, like a camera operator.
- The ball is drawn 1.6× its physical size (physics uses the real 11 cm radius) so it stays readable at broadcast distance.
- Follows a focus point that leads the ball towards the attacking direction of the team in possession, critically damped so it never snaps.
- Widens modestly (max +15%) for long balls in the air; returns smoothly.
- Always on the same touchline; teams changing ends does not change the camera. Movement input is camera-relative (up = away from the camera). In Broadcast the stick is rotated by the camera's heading, smoothed so a pan does not jerk the controls mid-run; right-stick flicks and the pass-receiver preview use the same rotation.
- Settings: view (Tracking/Broadcast), camera height (low/standard/high), zoom (near/standard/far), reduced camera motion. Height and zoom apply to both views.
- Presentation: score bug, clock and half, kick-off and goal banners with scorer, half-time and full-time cards with simple statistics, fictional advertising boards.

## 7. Football mechanics

**Movement.** Desired velocity from input. Top sprint speed 7.3–9.1 m/s from Pace; jogging is 72% of that; dribbling is 95%; jockeying is capped at 3.2 m/s while facing the ball. Acceleration 4.5–8 m/s² from Acceleration; turning slows at high speed. Contact between players pushes them apart and can briefly stagger the lighter-balanced one.

**Stamina.** Sprinting drains stamina (faster for low Stamina attribute); jogging and walking recover it. Below 35% stamina, sprint speed fades towards jog speed. Jogging is never penalised. The same rules apply to AI.

**Player animation.** Realistic players play motion clips (idle, walk, jog, sprint, kick, slide) with a code layer for running that keeps the torso upright and drives a compact arm swing in time with the stride. The slide clip is time-warped onto the simulation's slide (drop in the first 0.25 s, then the glide) and the time on the ground (the clip's own get-up), and the body is lowered or raised so the toes sit at the captured height. Tackles, dives, headers, throw-ins, skills and celebrations are code-driven poses; Classic players' slide is a code-driven take-off, glide and get-up.

**Ball and possession.** One ball state with an explicit possession state: `free`, `dribble` (owner set), `flight` (pass/shot/cross with intended receiver), `held` (goalkeeper), `dead` (restart pending). Ownership is a single field, so two players can never own the ball. Dribbling is a series of real touches: the ball is pushed ahead and rolls freely, and the owner re-touches it when it is within reach; anyone can intercept between touches. When the stick turns, the next touch goes the new way: a cut of more than about 17° plays an early touch along the turn, and a sharp turn (over about 85°) holds the ball at the feet while the player comes round. Ball Control shortens touches, widens the reach for a turning touch and improves first touches on fast balls.

**Passing.** Short ground pass, through ball (led into the receiver's run) and lofted pass/cross. Receiver selection scores teammates by angle from the input direction (hard limit 70°, so no passes behind the intended direction), distance against the pass type's preferred range, lane clearance and, for through balls, forward runs. With no valid teammate, the ball is played into space in the input direction. Errors grow with low Passing, pressure, sprinting, distance and poor body orientation. A subtle ring marks the predicted receiver. Human passes charge while the button is held and play on release (17 Nov 2026): the charge sets the distance the selection looks for (`wantedDistance` in `kick.ts`: from just short of the type's minimum to past its maximum, penalty capped so direction still dominates), so a tap finds the near teammate in a lane and a long hold the far one; the ring follows the charge. The modifier (jockey button) gives a driven ground pass (arrival speed about 10 + 0.3·d m/s, cap 30 m/s, range 8–34 m, less affected by blocked lanes, 15% wider error) or a lofted through ball (through-ball selection and lead, played with the lob solver). Computer players and older clients send no charge and keep the original range scoring.

**First touch (17 Nov 2026).** A human receiving a ball from someone else steers the first touch with the stick (`Match.steerFirstTouch`): no direction kills it at the feet; a direction plays it a stride that way (the dribble leaves it alone for 0.32 s); sprint as well pushes it 4–6 m/s ahead and the ball is loose until they reach it. Direction error grows with poor Ball Control, the incoming pace and how far the touch turns back against the pass. Computer players keep the plain cushion. Re-collecting your own push is not a first touch, so sprinting does not chain pushes.

**Shot types and the weaker foot (17 Nov 2026).** Power, placed (curl), chip (hold lob + shoot: a slow, high ball whose height at the goal line rises with power, so an over-hit chip clears the bar) and low drive (hold through + shoot: aimed 0.2–0.3 m high with a tight vertical spread, never skied). Every player has a stronger foot (about one in five left-footed) and 2–5 weak-foot stars, fixed per player from the name unless set in the squad (`footProfile` in `teams.ts`). A strike is on the weaker foot when the ball sits on that side of the body or the shot is opened well across to that side (`weakFootUsed`); it loses up to 10% power and widens the spread by up to 2.2×. The computer chips when the keeper is more than 5.5 m off their line and sometimes drives low inside 16 m.

**Called runs, timed set pieces, keeper rushes and quick restarts (17 Nov 2026).** With the ball, the switch button calls a run (`Match.callRun`): the teammate scoring best on forwardness, role (striker, then wingers) and, if the stick is held, its direction sprints to 9 m past the defensive line for 2.6 s (`calledRun` in `offBall`), so the pass has to be quick to stay onside. At human free kicks and penalties a ring over the ball shrinks and grows every 1.4 s (`timingRing`); the ring size when the kick is pressed multiplies every error of that kick by 0.45 (closed) to 2.05 (widest) through `KickContext.accuracy`. Out of possession the skill button sends the team's keeper out for 2.5 s (`startKeeperRush`): at a carrier, to a point just in front of them on the line to goal; to a loose ball, to its meeting point. Computer keepers do the same unprompted when a carrier is within 14–18 m (by Goalkeeping), heading for goal, with no defender goal-side within 6 m of their line. A keeper within 1.5 m of the carrier inside the area dives at their feet: wins it in the hands with 35% + 45%·Goalkeeping − 25%·carrier Ball Control (15–80%), otherwise goes down for 0.7 s. Quick restarts (a per-player setting, on by default; `MatchConfig.quickRestarts`): a human kick press after the ball is back at the spot takes a throw-in, corner or free kick the moment the taker reaches it, before the setup (opponents are not pushed back), played like open play with no target and no ring.
