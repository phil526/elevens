// Where the game is played online (19 Nov 2026). The game itself is a static site (GitHub Pages);
// online and ranked matches run on one small Node server (Render's free plan, see render.yaml and
// docs/DEPLOY.md). Free servers sleep when nobody has used them for 15 minutes and take about a
// minute to wake, so the game wakes the server as soon as it opens and the Online screen waits
// for it.

/** The public match server. Change this (or set VITE_SERVER_URL at build time) if it moves. */
export const PUBLIC_SERVER = 'wss://elevens-match-server.onrender.com/ws';
/** The game's own web address, where online play works. */
export const PLAY_URL = 'https://phil526.github.io/elevens/';

/** Hosts that mean "a server on this machine or network": use the page's own address. */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '' || host.endsWith('.local') || host === '[::1]'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * The WebSocket address of the match server, in order: a `?server=` in the page address, the
 * build's VITE_SERVER_URL, the page's own address when the match server itself served the page
 * (it adds a meta tag) or the page is on this machine or network, otherwise the public server.
 */
export function serverUrl(loc: Pick<Location, 'search' | 'protocol' | 'host' | 'hostname' | 'origin'> = location, env = (import.meta.env?.VITE_SERVER_URL as string | undefined) ?? '', servedBySelf = selfServed()): string {
  const q = new URLSearchParams(loc.search).get('server');
  if (q) return q;
  if (env) return env;
  if (loc.protocol === 'file:' || loc.origin === 'null') return 'ws://localhost:8787/ws';
  const own = `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
  if (servedBySelf || isLocalHost(loc.hostname)) return own;
  return PUBLIC_SERVER || own;
}

function selfServed(): boolean {
  try { return document.querySelector('meta[name="elevens-server"]')?.getAttribute('content') === 'self'; } catch { return false; }
}

/** The server's http(s) address for a ws(s) address (…/ws → …/health). */
export function healthUrl(ws: string): string {
  return ws.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '/health');
}

/** True when the server is on another host that may be asleep (not this machine or network). */
export function mayBeAsleep(ws: string): boolean {
  try { return !isLocalHost(new URL(ws).hostname); } catch { return false; }
}

export type ServerState = 'unknown' | 'waking' | 'ready' | 'unreachable' | 'blocked';
let state: ServerState = 'unknown';
let pending: Promise<ServerState> | null = null;
const listeners = new Set<(s: ServerState) => void>();

export const serverState = () => state;
export function onServerState(fn: (s: ServerState) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function setState(s: ServerState) { if (state === 'blocked') return; state = s; for (const fn of listeners) fn(s); }

/** The page's host refuses connections to the server (a preview frame with a strict security policy). */
export const serverBlocked = () => state === 'blocked';
try {
  document.addEventListener('securitypolicyviolation', (e) => {
    const target = (() => { try { return new URL(serverUrl()).host; } catch { return ''; } })();
    if (target && e.blockedURI && e.blockedURI.includes(target)) setState('blocked');
  });
} catch { /* not in a browser */ }

/**
 * Asks the match server's health check until it answers (up to `maxMs`), which also wakes a
 * sleeping free server. Safe to call often: one check runs at a time.
 */
export function wakeServer(url = serverUrl(), maxMs = 100_000): Promise<ServerState> {
  if (pending) return pending;
  if (typeof fetch !== 'function') return Promise.resolve(state);
  const started = performance.now();
  const h = healthUrl(url);
  pending = (async () => {
    let tries = 0;
    while (performance.now() - started < maxMs) {
      tries++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const r = await fetch(h, { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) { setState('ready'); return state; }
      } catch { clearTimeout(timer); }
      // Give a security-policy report a moment to arrive before deciding the server is asleep.
      await new Promise((res) => setTimeout(res, 50));
      if (state === 'blocked') return state;
      if (tries === 1) setState('waking');
      if (!mayBeAsleep(url)) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (state !== 'blocked') setState('unreachable');
    return state;
  })().finally(() => { pending = null; });
  return pending;
}
