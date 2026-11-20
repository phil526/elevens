// Private two-player rooms with an authoritative match simulation.

import { randomBytes } from 'node:crypto';
import type { Mentality } from '../shared/config';
import { MATCH, NET, SIM } from '../shared/config';
import { Match, defaultConfig } from '../shared/match';
import { rollWeatherKind, rollWind } from '../shared/weather';
import { ROOM_CODE_ALPHABET, type ClientMsg, type LobbySeat, type RoomState, type ServerMsg } from '../shared/protocol';
import { encodeSnapshot } from '../shared/snapshot';
import { TEAMS, defaultTactics, teamById, type Tactics } from '../shared/teams';
import type { InputFrame, MatchEvent, TeamIndex } from '../shared/types';

export interface Conn {
  send(msg: ServerMsg | object): void;
  close(code: number, reason: string): void;
}

export interface Seat {
  token: string;
  name: string;
  conn: Conn | null;
  connected: boolean;
  ready: boolean;
  club: string;
  kit: 'home' | 'away';
  mentality: Mentality;
  tactics?: Tactics;
  queue: InputFrame[];
  held: InputFrame;
  lastInputAt: number;
  ack: number;
  graceUsedMs: number;
  disconnectedAt: number;
  rematch: boolean;
  eventsThisSecond: number;
  eventWindowStart: number;
}

const neutral = (seq = 0): InputFrame => ({ seq, mx: 0, mz: 0, sprint: false, jockey: false, ev: [] });

export const newToken = () => randomBytes(16).toString('hex');

export function newCode(taken: Set<string>): string {
  for (;;) {
    let c = '';
    const bytes = randomBytes(5);
    for (let i = 0; i < 5; i++) c += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    if (!taken.has(c)) return c;
  }
}

function colourDistance(a: number, b: number) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

export interface RoomOptions {
  now: () => number;
  log: (msg: string) => void;
}

export class Room {
  seats: [Seat | null, Seat | null] = [null, null];
  host: 0 | 1 = 0;
  minutes: number = MATCH.defaultRealMinutes;
  state: RoomState['state'] = 'lobby';
  countdownEnd = 0;
  match: Match | null = null;
  lastActivity: number;
  private pendingEvents: MatchEvent[] = [];
  private snapCounter = 0;
  private halftimeAt = -1;
  private resultsAt = -1;
  closed = false;
  /** Ranked match: the two players' ranked ids, and who to tell about the result (once). */
  ranked: { ids: [string, string]; reported: boolean } | null = null;
  onRankedEnd: ((room: Room, result: 'A' | 'B' | 'D') => void) | null = null;

  constructor(public code: string, private opts: RoomOptions) {
    this.lastActivity = opts.now();
  }

  private seatOf(token: string): 0 | 1 | -1 {
    if (this.seats[0]?.token === token) return 0;
    if (this.seats[1]?.token === token) return 1;
    return -1;
  }

  get occupied() {
    return (this.seats[0] ? 1 : 0) + (this.seats[1] ? 1 : 0);
  }

  /** Add a participant. Returns the seat index, or -1 if the room is full. */
  join(token: string, name: string, conn: Conn): 0 | 1 | -1 {
    const existing = this.seatOf(token);
    if (existing >= 0) return this.resume(existing as 0 | 1, conn) ? existing : -1;
    if (this.state !== 'lobby') return -1;
    const free = !this.seats[0] ? 0 : !this.seats[1] ? 1 : -1;
    if (free < 0) return -1;
    const idx = free as 0 | 1;
    const other = this.seats[1 - idx];
    const club = other ? TEAMS.find((t) => t.id !== other.club)!.id : TEAMS[idx].id;
    this.seats[idx] = {
      token, name, conn, connected: true, ready: false, club, kit: 'home', mentality: 'balanced', queue: [], held: neutral(), lastInputAt: 0, ack: 0,
      graceUsedMs: 0, disconnectedAt: 0, rematch: false, eventsThisSecond: 0, eventWindowStart: 0,
    };
    if (!other) this.host = idx as 0 | 1;
    this.fixKits();
    this.touch();
    this.broadcastState();
    return idx as 0 | 1;
  }

  private resume(idx: 0 | 1, conn: Conn): boolean {
    const s = this.seats[idx]!;
    if (s.conn && s.conn !== conn) s.conn.close(4000, 'replaced');
    s.conn = conn;
    const was = s.connected;
    s.connected = true;
    s.queue = [];
    s.held = neutral(s.ack);
    if (!was && s.disconnectedAt) s.graceUsedMs += this.opts.now() - s.disconnectedAt;
    s.disconnectedAt = 0;
    if (this.match && this.state === 'match') {
      this.match.setHuman(idx, true);
      this.sendStart(idx);
      this.sendTo(1 - idx, { t: 'opp', status: 'reconnected' });
      this.opts.log(`room ${this.code}: seat ${idx} reconnected`);
    } else if (this.state === 'results' && this.match) {
      this.sendStart(idx);
    }
    this.touch();
    this.broadcastState();
    return true;
  }

  /** Connection dropped (not an explicit leave). */
  disconnected(conn: Conn) {
    for (const idx of [0, 1] as const) {
      const s = this.seats[idx];
      if (!s || s.conn !== conn) continue;
      s.conn = null;
      s.connected = false;
      s.ready = this.state === 'lobby' ? false : s.ready;
      s.disconnectedAt = this.opts.now();
      s.queue = [];
      s.held = neutral(s.ack);
      if (this.state === 'match' && this.match) {
        // AI takes the team immediately; the player cannot gain anything by dropping.
        this.match.setHuman(idx, false);
        const grace = Math.min(NET.reconnectGraceMs, NET.totalGraceMsPerMatch - s.graceUsedMs);
        this.sendTo(1 - idx, { t: 'opp', status: 'disconnected', graceMs: Math.max(0, grace) });
        this.opts.log(`room ${this.code}: seat ${idx} disconnected, grace ${grace} ms`);
      } else if (this.state === 'lobby' || this.state === 'countdown') {
        this.state = 'lobby';
      }
      this.broadcastState();
    }
  }

  leave(token: string) {
    const found = this.seatOf(token);
    if (found < 0) return;
    const idx = found as 0 | 1;
    const s = this.seats[idx]!;
    s.conn = null;
    if (this.state === 'match' || this.state === 'countdown' || this.state === 'results') {
      this.seats[idx] = null;
      if (this.state === 'match') this.endMatch('opponent_left', idx);
      else if (this.state === 'countdown') this.state = 'lobby';
      this.sendTo(1 - idx, { t: 'opp', status: 'left' });
    } else {
      this.seats[idx] = null;
      this.sendTo(1 - idx, { t: 'opp', status: 'left' });
    }
    if (this.seats[1 - idx]) this.host = (1 - idx) as 0 | 1;
    for (const st of this.seats) if (st) { st.ready = false; st.rematch = false; }
    if (this.state === 'results' && !this.seats[0] && !this.seats[1]) this.closed = true;
    if (!this.seats[0] && !this.seats[1]) this.closed = true;
    this.broadcastState();
  }

  handle(token: string, msg: ClientMsg) {
    const found = this.seatOf(token);
    if (found < 0) return;
    const idx = found as 0 | 1;
    const s = this.seats[idx]!;
    const now = this.opts.now();
    switch (msg.t) {
      case 'lobby': {
        if (this.state !== 'lobby' || this.ranked) return;
        if (msg.club && idx === this.host && msg.club !== s.club) {
          s.club = msg.club;
          const o = this.seats[1 - idx];
          if (o) o.club = TEAMS.find((t) => t.id !== msg.club)!.id;
        }
        if (msg.swap && idx === this.host) {
          const o = this.seats[1 - idx];
          if (o) [s.club, o.club] = [o.club, s.club];
          else s.club = TEAMS.find((t) => t.id !== s.club)!.id;
        }
        if (msg.kit) s.kit = msg.kit;
        if (msg.mentality) s.mentality = msg.mentality;
        if (msg.minutes && idx === this.host) this.minutes = msg.minutes;
        if (msg.ready !== undefined) s.ready = msg.ready;
        // Any settings change un-readies the other player so nobody starts on terms they didn't see.
        if ((msg.club || msg.swap || msg.minutes || msg.kit) && this.seats[1 - idx]) this.seats[1 - idx]!.ready = false;
        this.fixKits();
        this.touch();
        if (this.seats[0]?.ready && this.seats[1]?.ready && this.seats[0].connected && this.seats[1].connected) {
          this.state = 'countdown';
          this.countdownEnd = now + 3000;
        }
        this.broadcastState();
        break;
      }
      case 'in': {
        if (this.state !== 'match' || !this.match) return;
        // Limit action events to 20 per second per player (inputs are intentions, not commands to spam).
        if (now - s.eventWindowStart > 1000) { s.eventWindowStart = now; s.eventsThisSecond = 0; }
        for (const f of msg.f) {
          if (f.seq <= s.ack || s.queue.some((q) => q.seq === f.seq)) continue; // stale or duplicate
          s.eventsThisSecond += f.ev.length;
          if (s.eventsThisSecond > 20) f.ev = [];
          s.queue.push(f);
        }
        if (s.queue.length > 12) {
          // Too far behind: collapse old frames but keep their action events in order.
          const drop = s.queue.splice(0, s.queue.length - 6);
          const ev = drop.flatMap((d) => d.ev);
          s.queue[0].ev = [...ev, ...s.queue[0].ev].slice(-4);
        }
        s.lastInputAt = now;
        break;
      }
      case 'tactic':
        s.mentality = msg.mentality;
        if (this.match) this.match.cfg.mentality[idx] = msg.mentality;
        if (msg.tac) {
          s.tactics = msg.tac;
          if (this.match) { this.match.cfg.tactics ??= [defaultTactics(), defaultTactics()]; this.match.cfg.tactics[idx] = msg.tac; }
        }
        break;
      case 'sub':
        if (this.match) this.match.requestSub(idx as TeamIndex, msg.id, msg.bench);
        break;
      case 'rematch': {
        if (this.state !== 'results' || this.ranked) return;
        s.rematch = msg.want;
        this.touch();
        if (this.seats[0]?.rematch && this.seats[1]?.rematch && this.seats[0].connected && this.seats[1].connected) {
          this.state = 'countdown';
          this.countdownEnd = now + 3000;
          for (const st of this.seats) if (st) st.rematch = false;
        }
        this.broadcastState();
        break;
      }
      default:
        break;
    }
  }

  private fixKits() {
    const a = this.seats[0], b = this.seats[1];
    if (!a || !b) return;
    const ka = teamById(a.club)[a.kit], kb = teamById(b.club)[b.kit];
    if (colourDistance(ka.shirt, kb.shirt) < 120) b.kit = b.kit === 'home' ? 'away' : 'home';
  }

  private startMatch() {
    const a = this.seats[0]!, b = this.seats[1]!;
    const cfg = defaultConfig({
      teams: [a.club, b.club], kits: [a.kit, b.kit], realMinutes: this.minutes, humans: [true, true],
      difficulty: ['pro', 'pro'], mentality: [a.mentality, b.mentality], autoSwitch: [true, true], seed: randomBytes(4).readUInt32LE(0),
      tactics: [a.tactics ?? defaultTactics(), b.tactics ?? defaultTactics()],
      // No home side online: the crowd stays neutral.
      momentum: false,
    });
    // Weather: rolled here so both players see (and play in) the same conditions.
    const r = randomBytes(6);
    const kind = rollWeatherKind(r[0] / 256);
    cfg.weather = { kind, ...rollWind(kind, r[1] / 256, r.readUInt16LE(2) / 65536) };
    this.match = new Match(cfg);
    for (const s of this.seats) if (s) { s.ack = 0; s.queue = []; s.held = neutral(); s.graceUsedMs = 0; s.ready = false; s.rematch = false; }
    this.state = 'match';
    this.halftimeAt = -1;
    this.resultsAt = -1;
    this.pendingEvents = [];
    this.sendStart(0);
    this.sendStart(1);
    this.opts.log(`room ${this.code}: match started (${a.club} v ${b.club}, ${this.minutes} min)`);
    this.broadcastState();
  }

  private sendStart(idx: number) {
    const m = this.match;
    if (!m) return;
    this.sendTo(idx, { t: 'start', side: idx as 0 | 1, teams: m.cfg.teams, kits: m.cfg.kits, minutes: m.cfg.realMinutes, mentality: m.cfg.mentality, weather: m.weather });
  }

  /**
   * A ranked room: both players are already seated with their clubs; kick-off counts down at once.
   * There is no rematch (they queue again).
   */
  startRanked(ids: [string, string], clubs: [string, string]) {
    this.ranked = { ids, reported: false };
    for (const i of [0, 1] as const) { const s = this.seats[i]; if (s) { s.club = clubs[i]; s.kit = 'home'; s.ready = true; } }
    this.fixKits();
    this.state = 'countdown';
    this.countdownEnd = this.opts.now() + 4000;
    this.broadcastState();
  }

  /** Ranked: the result, once. A player who left or did not come back loses. */
  private reportRanked(reason: 'fulltime' | 'abandoned' | 'opponent_left', gone: 0 | 1 | -1) {
    const r = this.ranked;
    if (!r || r.reported || !this.match) return;
    r.reported = true;
    const [a, b] = this.match.score;
    let result: 'A' | 'B' | 'D' = a > b ? 'A' : b > a ? 'B' : 'D';
    const so = this.match.shootout;
    if (result === 'D' && so && so.winner >= 0) result = so.winner === 0 ? 'A' : 'B';
    if (reason !== 'fulltime' && gone >= 0) result = gone === 0 ? 'B' : 'A';
    this.onRankedEnd?.(this, result);
  }

  private endMatch(reason: 'fulltime' | 'abandoned' | 'opponent_left', gone: 0 | 1 | -1 = -1) {
    if (this.ranked) this.reportRanked(reason, gone);
    this.state = 'results';
    this.resultsAt = this.opts.now();
    for (const s of this.seats) if (s) { s.rematch = false; s.ready = false; }
    this.broadcast({ t: 'end', reason });
    this.opts.log(`room ${this.code}: match ended (${reason}) ${this.match ? this.match.score.join('-') : ''}`);
    this.broadcastState();
  }

  /** Advance one simulation tick (60 Hz). */
  tick() {
    const now = this.opts.now();
    if (this.state === 'countdown') {
      const both = this.seats[0]?.connected && this.seats[1]?.connected;
      if (!both && this.ranked) { this.closed = true; this.broadcast({ t: 'opp', status: 'left' }); return; }
      if (!both) { this.state = 'lobby'; this.broadcastState(); return; }
      if (now >= this.countdownEnd) this.startMatch();
      return;
    }
    if (this.state !== 'match' || !this.match) return;
    const m = this.match;
    for (const idx of [0, 1] as TeamIndex[]) {
      const s = this.seats[idx];
      if (!s) continue;
      if (!s.connected) {
        const grace = Math.min(NET.reconnectGraceMs, NET.totalGraceMsPerMatch - s.graceUsedMs);
        if (now - s.disconnectedAt > grace) {
          this.endMatch('abandoned', idx);
          return;
        }
        continue;
      }
      let f = s.queue.shift();
      if (f) {
        s.held = { ...f, ev: [] };
        s.ack = f.seq;
      } else if (now - s.lastInputAt > NET.idleInputNeutralMs) {
        // Input stopped arriving (tab hidden, stalled connection): stop the player.
        f = neutral(s.ack);
        s.held = f;
      } else f = s.held; // late input: keep the last held state until it arrives
      m.applyInput(idx, f);
    }
    m.step();
    for (const e of m.drainEvents()) this.pendingEvents.push(e);
    if (m.phase === 'halftime') {
      if (this.halftimeAt < 0) this.halftimeAt = now;
      else if (now - this.halftimeAt > MATCH.halftimePauseOnline * 1000) { m.continueAfterHalftime(); this.halftimeAt = -1; }
    }
    this.snapCounter++;
    // The full-time tick always sends a snapshot: the match ends on this tick, so without it the
    // players could miss the final whistle (2 ticks in 3 send none) and sit on a frozen match.
    const final = m.phase === 'fulltime';
    if (this.snapCounter >= SIM.tickRate / SIM.snapshotRate || final) {
      this.snapCounter = 0;
      const ev = this.pendingEvents;
      this.pendingEvents = [];
      const withStats = m.tick % 60 < 3 || m.phase === 'halftime' || m.phase === 'fulltime' || ev.some((e) => e.type === 'goal');
      for (const idx of [0, 1]) {
        const s = this.seats[idx];
        if (s?.conn) s.conn.send(encodeSnapshot(m, s.ack, ev, withStats));
      }
    }
    if (m.phase === 'fulltime') this.endMatch('fulltime');
  }

  /** True when the room should be removed. */
  expired(): boolean {
    const now = this.opts.now();
    if (this.closed) return true;
    if (!this.seats[0] && !this.seats[1]) return true;
    if ((this.state === 'lobby' || this.state === 'countdown') && now - this.lastActivity > NET.lobbyIdleMs) return true;
    if (this.state === 'results' && now - Math.max(this.lastActivity, this.resultsAt) > NET.resultsIdleMs) return true;
    const anyConnected = this.seats.some((s) => s?.connected);
    if (!anyConnected && now - this.lastActivity > NET.reconnectGraceMs + 5000) return true;
    return false;
  }

  close(reason: string) {
    this.closed = true;
    for (const s of this.seats) s?.conn?.send({ t: 'err', code: 'not_found', msg: reason });
  }

  private touch() {
    this.lastActivity = this.opts.now();
  }

  private sendTo(idx: number, msg: ServerMsg) {
    this.seats[idx]?.conn?.send(msg);
  }

  private broadcast(msg: ServerMsg) {
    for (const s of this.seats) s?.conn?.send(msg);
  }

  stateFor(idx: 0 | 1): RoomState {
    const seat = (s: Seat | null): LobbySeat | null => (s ? { name: s.name, connected: s.connected, ready: s.ready, club: s.club, kit: s.kit, mentality: s.mentality } : null);
    return {
      t: 'room', code: this.code, you: idx, seats: [seat(this.seats[0]), seat(this.seats[1])], minutes: this.minutes, state: this.state,
      countdown: this.state === 'countdown' ? Math.max(0, this.countdownEnd - this.opts.now()) : 0,
      rematch: [!!this.seats[0]?.rematch, !!this.seats[1]?.rematch], host: this.host,
      ...(this.ranked ? { ranked: true } : {}),
    };
  }

  broadcastState() {
    for (const idx of [0, 1] as const) this.seats[idx]?.conn?.send(this.stateFor(idx));
  }
}
