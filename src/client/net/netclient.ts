// WebSocket client: connection lifecycle, reconnect with the server-issued
// token, latency measurement, and message dispatch.

import { PROTOCOL_VERSION, type ClientMsg, type RoomState, type ServerMsg } from '../../shared/protocol';
import { isSnapshot, type Snapshot } from '../../shared/snapshot';
import { mayBeAsleep, serverBlocked, serverUrl, wakeServer } from './hosting';

export type NetStatus = 'idle' | 'connecting' | 'waking' | 'connected' | 'reconnecting' | 'disconnected' | 'unavailable' | 'blocked';

const TOKEN_KEY = 'elevens.token';

function storedToken(): string | undefined {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
}
function storeToken(t: string | null) {
  try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export { serverUrl };

export class NetClient {
  ws: WebSocket | null = null;
  status: NetStatus = 'idle';
  latency = -1;
  token: string | undefined = storedToken();
  inRoom = false;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private wantOpen = false;
  private everConnected = false;
  /** Waited for a sleeping server already (only once per connect). */
  private woke = false;
  private name = 'Player';
  onStatus: (s: NetStatus) => void = () => {};
  onRoom: (r: RoomState) => void = () => {};
  onSnapshot: (s: Snapshot, recvAt: number) => void = () => {};
  onMessage: (m: ServerMsg) => void = () => {};
  onWelcome: (resumed: boolean) => void = () => {};

  constructor(public url = serverUrl()) {}

  connect(name: string) {
    this.name = name;
    this.wantOpen = true;
    this.woke = false;
    this.open();
  }

  private setStatus(s: NetStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private open() {
    clearTimeout(this.retryTimer);
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.setStatus('unavailable');
      return;
    }
    this.ws = ws;
    const openTimeout = window.setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 6000);
    ws.onopen = () => {
      clearTimeout(openTimeout);
      this.retry = 0;
      this.everConnected = true;
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token: this.token, name: this.name });
      this.setStatus('connected');
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 1000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg | Snapshot;
      try { m = JSON.parse(e.data as string); } catch { return; }
      const now = performance.now();
      if ((m as Snapshot).k === 's') { if (isSnapshot(m)) this.onSnapshot(m, now); return; }
      const sm = m as ServerMsg;
      if (sm.t === 'welcome') {
        this.token = sm.token;
        storeToken(sm.token);
        this.onWelcome(sm.resumed);
      } else if (sm.t === 'pong') {
        const rtt = now - sm.c;
        this.latency = this.latency < 0 ? rtt : this.latency * 0.8 + rtt * 0.2;
      } else if (sm.t === 'room') {
        this.inRoom = true;
        this.onRoom(sm);
      }
      this.onMessage(sm);
    };
    ws.onclose = () => {
      clearTimeout(openTimeout);
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.wantOpen) { this.setStatus('idle'); return; }
      if (!this.everConnected) {
        if (serverBlocked()) { this.setStatus('blocked'); this.wantOpen = false; return; }
        if (!this.woke && mayBeAsleep(this.url)) {
          // A free server sleeps when unused: wake it (up to about a minute and a half), then try again.
          this.woke = true;
          this.setStatus('waking');
          void wakeServer(this.url).then((st) => {
            if (!this.wantOpen || this.ws) return;
            if (st === 'ready') this.open();
            else { this.setStatus(st === 'blocked' ? 'blocked' : 'unavailable'); this.wantOpen = false; }
          });
          return;
        }
        this.setStatus('unavailable');
        this.wantOpen = false;
        return;
      }
      // Reconnect with backoff; the server keeps our seat for the grace period.
      this.retry++;
      if (this.retry > 7) { this.setStatus('disconnected'); this.wantOpen = false; return; }
      this.setStatus('reconnecting');
      this.retryTimer = window.setTimeout(() => this.open(), Math.min(8000, 400 * 2 ** (this.retry - 1)));
    };
  }

  send(m: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  leaveRoom() {
    this.send({ t: 'leave' });
    this.inRoom = false;
  }

  close() {
    this.wantOpen = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    if (this.ws) { this.leaveRoom(); this.ws.close(); this.ws = null; }
    this.inRoom = false;
    this.everConnected = false;
    this.setStatus('idle');
  }

  /** Forget the identity (e.g. after the server restarted and our room vanished). */
  resetIdentity() {
    this.token = undefined;
    storeToken(null);
  }
}
