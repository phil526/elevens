# ELEVENS

An original browser-based 3D eleven-a-side football game. Play an exhibition against the computer in one tab, or play one other person online through a small authoritative match server.

- Two fictional clubs (Redmoor Rovers and Kestrel Bay), one stadium (the Harbourside Ground).
- Full match flow: title, mode, club and kit, match settings, loading, kick-off, two halves, half-time, full time, results, rematch or menu.
- Aimed free kicks, corners and penalties; fouls, yellow and red cards and the advantage rule; skill moves, sprint bursts, slide tackles and a teammate-press (contain) button; switching by stick flick or by clicking a player.
- Two camera views: Tracking (slides along the touchline) and Broadcast (a fixed TV gantry that pans and zooms).
- Keyboard, controller and touch controls; basic tactics; scoreboard, clock, radar and control guide; audio and graphics settings (Low, Medium, High and Ultra presets; see docs/CONTROLS.md).
- Realistic generated player models with motion-captured running and kicking from Medium quality up (Settings, Players: Realistic or Classic; see docs/ASSETS.md).
- Apart from the generated player models, every model, texture and sound is generated in code. There are no third-party art, audio, logos or real likenesses (see [docs/ASSETS.md](docs/ASSETS.md)).

Online play is an exhibition-grade prototype. It has been tested locally and with simulated latency, not across real networks, and it is **not production-ready** (see [Limitations](docs/LIMITATIONS.md)).

| Document | What it covers |
| --- | --- |
| [docs/DESIGN.md](docs/DESIGN.md) | Game design document, technology choice, rules and online architecture |
| [docs/CONTROLS.md](docs/CONTROLS.md) | Keyboard, controller and touch control tables |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploying the client and the server |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What was tested, how, and the results |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | Known limitations, deferred features and roadmap |
| [docs/ASSETS.md](docs/ASSETS.md) | Asset and dependency licence notes |

## Requirements

- Node.js 20.19 or newer (developed and tested on Node 22.22.0 with npm 10.9.4).
- A browser with WebGL 2 (current Chrome, Edge, Firefox or Safari).

## Setup

```bash
cd elevens
npm ci                 # installs the exact versions in package-lock.json
cp .env.example .env   # optional; every value has a safe default and no secrets are needed
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Client dev server with hot reload at http://localhost:5173 (proxies `/ws` to the game server on 8787) |
| `npm run dev:server` | Game server in watch mode on http://localhost:8787 (WebSocket at `/ws`) |
| `npm run build` | Production build: client to `dist/client`, server bundle to `dist/server/index.mjs` |
| `npm start` | Run the built server; it also serves `dist/client`, so the whole game is on one port |
| `npm run preview` | Serve `dist/client` alone (offline play only) |
| `npm run typecheck` | TypeScript check of client, server, shared code, tests and scripts |
| `npm test` | Unit and integration tests (Vitest), including real WebSocket tests |
| `npm run e2e` | Browser checks with Playwright and Chromium (run `npm run build` first; set `CHROMIUM_PATH` if Chromium is not at the default path) |
| `npm run e2e:features` | Browser checks for aimed set pieces, cards, skill moves, contain, slide tackles and click-to-switch (Low preset; run `npm run build` first) |
| `node scripts/shots-crowd.mjs [preset]` | Screenshots the stadium and crowd from six fixed views, including both ends before and after a goal (default preset `high`; run `npm run build` first) |
| `node scripts/shots-camera.mjs [preset]` | Screenshots the Tracking and Broadcast camera views with play at the centre, both boxes, a far corner and the near touchline (default preset `medium`; run `npm run build` first) |
| `node scripts/shots-quality.mjs` | Screenshots the same kick-off at each graphics preset and records software-rendering frame rates (run `npm run build` first) |
| `npm run sim -- 10 6 1` | Headless AI-v-AI matches: count, real minutes, first seed |
| `npx tsx scripts/bench-dribble.ts` | Dribbling benchmark: straight-line times with and without the ball, and whether 45°, 90° and 180° turns keep it |
| `node scripts/shots-anim.mjs [tag] [preset]` | Side-on frame sheets of the realistic player jogging, sprinting, dribbling and sliding, written to `scripts/out/anim-<tag>-*.png` (run `npm run build` first). `ANIM_VIEW=front` gives a three-quarter front view; `ANIM_ONLY=slide` captures one motion |
| `npx tsx scripts/bench-features.ts 1000 40 pro pro` | AI-v-AI benchmark: first seed, match count, home and away difficulty; prints goals and shots by distance, fouls, cards, advantages, slides and skill moves as JSON |

### Playing offline

`npm run dev`, open http://localhost:5173, press **Kick off** on the main menu (it plays your last setup; **Change clubs or settings** picks the clubs, difficulty and length first). No server is needed. You can also open a built `dist/client` from any static host.

### Installing on an iPad or phone home screen

The game includes a web app manifest, icons and an offline service worker (`public/manifest.webmanifest`, `public/icons/`, `public/sw.js`). They only work when the game is served from its own HTTPS address (for example `npm run build && npm start` behind HTTPS, or `dist/client` on any static host). Open it in Safari, tap Share, then **Add to Home Screen**: it opens full screen and, after one visit, plays offline against the computer (online matches still need the server). The worker is not registered inside a frame (such as the claude.ai playable link), on `?test` pages, or on plain `http://` addresses other than localhost. Settings, App has a Full screen button for browsers that allow it.

### Playing online on one machine (two windows)

```bash
npm run dev:server     # terminal 1
npm run dev            # terminal 2
```

1. Open http://localhost:5173 and choose **Online match**, then **Create private room**. You get a five-character code and a link.
2. Open the link in a second window (or a private window, or another browser), or choose **Online match**, type the code and press **Join room**.
3. Both players press **Ready**. The match starts after a three-second countdown.

Or run the production build on one port: `npm run build && npm start`, then use http://localhost:8787 in both windows.

## How a second player connects

The host creates a room and shares the code or the link. Rooms are private: nobody can join without the code, and a room holds exactly two players.

**On the same local network.** Run `npm run build && npm start` on one computer. The server listens on all interfaces (`HOST=0.0.0.0`). Find that computer's LAN address (for example `192.168.1.20`) and both players open `http://192.168.1.20:8787`. The host creates a room and the guest joins with the code or link. Allow port 8787 through the host computer's firewall if needed. Browsers treat plain `http://` LAN addresses as insecure, which is fine for this game (it uses no secure-only APIs), but some phones block it; use the deployed setup below for phones.

**Over the internet (deployed).** Deploy the server somewhere reachable over HTTPS (see [docs/DEPLOY.md](docs/DEPLOY.md)). Either:

- Single origin (simplest): the server serves the client too. Both players open `https://your-server.example.com`, one creates a room and sends the link to the other.
- Separate hosts: put `dist/client` on a static host and the server elsewhere. Build the client with `VITE_SERVER_URL=wss://your-server.example.com/ws`, or open the static site with `?server=wss://your-server.example.com/ws`. The room link keeps that `?server=` value, so the guest connects to the same server. Set `ALLOWED_ORIGINS` on the server to the static site's origin.

If a player drops, the computer takes over their team immediately. They can reload or reconnect within 30 seconds (60 seconds in total per match) and get their seat back; after that the match is abandoned. The reconnect token lives in the browser tab's session storage.

## Project layout

```
src/shared/      simulation shared by browser, server and tests: rules, ball physics, movement, kicks, AI, protocol, snapshots
src/client/      Three.js renderer, procedural models and textures, camera, input, audio, HUD, menus, offline and online sessions
src/server/      Node HTTP + WebSocket server: rooms, 60 Hz authoritative simulation, reconnect, rate limits
tests/           Vitest suites (rules, physics, input, protocol, rooms, live WebSocket server)
scripts/         headless simulator, AI diagnostics, Playwright browser checks (screenshots in scripts/out/)
docs/            design document and supporting documents
```

## Debugging aids

- `?debug` in the URL enables F3 (frame time, draw calls and simulation state) and F4 (AI targets and plans drawn on the pitch, offline only).
- `?test` exposes the app object as `window.__elevens` for automated browser checks. It is not needed to play.
- `?server=wss://host/ws` points the client at a specific game server.
- `SIM_LATENCY_MS` and `SIM_JITTER_MS` on the server add artificial delay for testing.

## Licence

The project code and generated assets are original work for this project. No licence for redistribution has been chosen yet (`"license": "UNLICENSED"` in `package.json`); pick one before publishing. Third-party dependencies and their licences are listed in [docs/ASSETS.md](docs/ASSETS.md).
