# Deployment

ELEVENS has two parts:

- **Client**: static files in `dist/client` after `npm run build`. Offline play needs nothing else.
- **Server**: `dist/server/index.mjs`, a single Node process that runs online matches (WebSocket at `/ws`), a health check at `/health`, and can also serve the client.

The server keeps rooms in memory. Run **one instance**: two instances behind a load balancer would split rooms and break joining. A restart ends any matches in progress; clients then show "The match server restarted". No secrets are needed anywhere: there are no accounts, keys or databases.

## The game's own web address (install on iPad)

The claude.ai Artifact link can't be added to the iPad home screen as an app, because the game runs there inside a frame on claude.ai. From its own address it can: the build already has the manifest, icons, full-screen display and an offline cache (`public/manifest.webmanifest`, `public/sw.js`, `src/client/install.ts`). On the iPad, open the address in Safari, tap Share, then **Add to Home Screen**. It then opens full screen with no browser bars, and starts without a connection once it has been opened online.

Ready-made configurations are in the repository. Each needs an account that only the owner can create; pricing and free allowances change, so check the provider's current pricing page first.

| Choice | File | What works | Notes |
| --- | --- | --- | --- |
| **GitHub Pages** | `.github/workflows/pages.yml` | Everything offline, install on iPad | Free for public repositories. Address like `https://<user>.github.io/elevens/`. One-time: Settings > Pages > Source: GitHub Actions |
| **Netlify** or **Cloudflare Pages** | `netlify.toml` (Cloudflare: build `npm ci && npm run build:client`, folder `dist/client`) | Everything offline, install on iPad | Free static plans. Address like `https://elevens.netlify.app` or a custom domain |
| **Fly.io** | `fly.toml` + `Dockerfile` | Everything, plus online matches and ranked | One always-on machine plus a 1 GB volume for the ranked table. Usage-based billing |
| **Render** | `render.yaml` + `Dockerfile` | Everything, plus online matches and ranked | Free web services sleep when idle (a sleeping server ends online matches); a persistent disk needs a paid plan |

A static host gives the full offline game. Online and ranked matches need the match server running somewhere (Fly.io, Render, a VPS); a static build points at it with `VITE_SERVER_URL` (see Option B). Fly.io or Render alone serve both from one address.

**Ranked table**: the server keeps ranked players (a random id, a hash of each device's secret key, the name, points and record) in the JSON file named by `RANKED_FILE` (default `data/ranked.json`; empty keeps it in memory only). Put it on a persistent volume, or every restart resets the table. Players have no accounts: their ranked identity lives in the browser's local storage, so clearing site data starts a new player.

## Option A: one server for everything (recommended)

```bash
npm ci
npm run build
NODE_ENV=production PORT=8787 ALLOWED_ORIGINS=https://elevens.example.com npm start
```

Players open `https://elevens.example.com`. Put a TLS-terminating reverse proxy in front (browsers on HTTPS pages can only open `wss://` sockets). The proxy must pass WebSocket upgrades on `/ws`.

Caddy (automatic HTTPS):

```
elevens.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name elevens.example.com;
    # ssl_certificate ... ; ssl_certificate_key ... ;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

Keep it running with systemd (or pm2, or your platform's process manager):

```ini
# /etc/systemd/system/elevens.service
[Unit]
Description=ELEVENS game server
After=network.target

[Service]
WorkingDirectory=/srv/elevens
ExecStart=/usr/bin/node dist/server/index.mjs
Environment=NODE_ENV=production PORT=8787 HOST=127.0.0.1 ALLOWED_ORIGINS=https://elevens.example.com
Restart=on-failure
User=elevens

[Install]
WantedBy=multi-user.target
```

The production install only needs runtime dependencies: copy `package.json`, `package-lock.json` and `dist/`, then `npm ci --omit=dev`.

### Container

A `Dockerfile` is included (Node 22 Alpine, non-root, health check):

```bash
docker build -t elevens .
docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://elevens.example.com elevens
```

Container platforms that support long-lived WebSocket connections (for example Fly.io, Render, Railway, a VPS) can run this image directly. Set the platform's health check to `GET /health`, keep a single instance, and avoid platforms that scale to zero mid-match or cap request duration (typical serverless functions cannot hold a 60 Hz WebSocket session).

## Option B: static client and separate server

1. Deploy the server as above, for example at `https://elevens-server.example.com`, with `SERVE_CLIENT=0` and `ALLOWED_ORIGINS=https://play.example.com`.
2. Build the client pointing at it:

   ```bash
   VITE_SERVER_URL=wss://elevens-server.example.com/ws npm run build:client
   ```

3. Upload `dist/client` to any static host (Netlify, Cloudflare Pages, GitHub Pages, S3 + CloudFront). Asset paths are relative (`base: './'`), so a sub-path such as `https://user.github.io/elevens/` works.

Without rebuilding, the client also accepts `?server=wss://elevens-server.example.com/ws` in the page URL, and room links keep it.

## Environment variables

| Variable | Where | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | server | 8787 | Listening port |
| `HOST` | server | 0.0.0.0 | Listening interface (use 127.0.0.1 behind a local reverse proxy) |
| `ALLOWED_ORIGINS` | server | empty (any) | Comma-separated origins allowed to open WebSockets. Set this in production |
| `SERVE_CLIENT` | server | 1 | Serve `dist/client` from the same port |
| `SIM_LATENCY_MS`, `SIM_JITTER_MS` | server | 0 | Artificial delay for testing only; leave at 0 in production |
| `VITE_SERVER_URL` | client build | empty | Absolute `wss://…/ws` URL when the server is on another host |
| `RANKED_FILE` | server | `data/ranked.json` | Where the ranked table is saved (written atomically about 2 seconds after a change, and on shutdown). Empty: memory only. The Docker image uses `/app/data/ranked.json` on the `/app/data` volume |

## Operating notes

- `GET /health` returns `{"ok":true,"rooms":N,"tickMs":…,"protocol":1}`.
- Server logs go to stdout: room created/started/ended, disconnects and reconnects.
- Built-in protections: 4 KB message limit, per-connection rate limit (burst 120, 60 messages/s), malformed-message counting with disconnect after 20, private five-character room codes from a 31-symbol alphabet (about 28.6 million combinations), random 128-bit reconnect tokens, idle lobbies removed after 10 minutes and finished rooms after 5.
- Not built in: per-IP connection limits, DDoS protection, abuse reporting, TLS (use the proxy), horizontal scaling. Add a per-IP limit at the proxy if the server is public.
- Bandwidth: 20 snapshots per second per player. Encoded snapshot size measured over two minutes of a headless AI match: median 1,136 bytes, 95th percentile 1,306, maximum 1,536 (JSON, before WebSocket framing; no compression). That is roughly 23–31 KB/s down per player. Upload is about 30 small input messages per second. Not measured on a real network.

## Verification status

Verified in this environment: `npm run build`, ranked online between two browser pages against the built server (`npm run e2e:modes ranked`), a production-only install (`npm ci --omit=dev`) serving the client and `/health`, and all server tests. **Not verified**: the Docker image build (no Docker daemon was available), the reverse-proxy configurations above, the GitHub Pages, Netlify, Fly.io and Render configurations (no accounts), and any real hosted deployment.
