// Private rooms with an authoritative match simulation: one against one, two against two, or two
// people together against the computer (20 Nov 2026). Seat i plays for side i % 2; seats 2 and 3
// are each side's second player, who drives the side's co-op mate control.

import { randomBytes } from 'node:crypto';
import type { Mentality } from '../shared/config';
import { MATCH, NET, SIM } from '../shared/config';
import { Match, defaultConfig } from '../shared/match';
import { rollWeatherKind, rollWind } from '../shared/weather';
import { FORMAT_SEATS, ROOM_CODE_ALPHABET, type AiDiff, type ClientMsg, type LobbySeat, type RoomFormat, type RoomState, type ServerMsg } from '../shared/protocol';
import { encodeSnapshot } from '../shared/snapshot';
import { TEAMS, defaultTactics, teamById, type Tactics } from '../shared/teams';
import type { InputFrame, MatchEvent, SwitchSens, SwitchStyle, TeamIndex } from '../shared/types';

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
  /** Auto-switch style and sensitivity this player chose (default full / normal). */
  sw?: [SwitchStyle, SwitchSens];
  queue: InputFrame[];
  held: InputFrame;
  lastInputAt: number;
  ack: number;
  graceUsedMs: number;
  disconnectedAt: number;
  rematch: boolean;
  eventsThisSecond: number;
  eventWindowStart: number;
  /** In a match: which of the side's two controls this seat drives (0 main, 1 co-op mate). */
  slot: 0 | 1;
  /** Gave up waiting for this seat in a team match: the computer keeps the control. */
  gone?: boolean;
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

const SEATS = 4;
const sideOf = (i: number) => (i % 2) as TeamIndex;

export class Room {
  seats: (Seat | null)[] = [null, null, null, null];
  host = 0;
  format: RoomFormat = '1v1';
  /** Together against the computer: its level, and its kit (its club is the other room club). */
  aiDiff: AiDiff = 'pro';
  private aiKit: 'home' | 'away' = 'home';
  /** The two room clubs by side (seat 0's and seat 1's in 1 v 1, as before). */
  private clubs: [string, string] = [TEAMS[0].id, TEAMS[1].id];
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

  private get active(): number[] { return FORMAT_SEATS[this.format]; }

  private seatOf(token: string): number {
    return this.seats.findIndex((s) => s?.token === token);
  }

  get occupied() {
    return this.seats.filter(Boolean).length;
  }

  /** Every seat the format needs is taken. */
  private get full() { return this.active.every((i) => !!this.seats[i]); }

  /** Add a participant. Returns the seat index, or -1 if the room is full. */
  join(token: string, name: string, conn: Conn): number {
    const existing = this.seatOf(token);
    if (existing >= 0) return this.resume(existing, conn) ? existing : -1;
    if (this.state !== 'lobby') return -1;
    const idx = this.active.find((i) => !this.seats[i]) ?? -1;
    if (idx < 0) return -1;
    const lead = this.seats[sideOf(idx)];
    this.seats[idx] = {
      token, name, conn, connected: true, ready: false, club: this.clubs[sideOf(idx)], kit: lead?.kit ?? 'home', mentality: lead?.mentality ?? 'balanced', queue: [], held: neutral(), lastInputAt: 0, ack: 0,
      graceUsedMs: 0, disconnectedAt: 0, rematch: false, eventsThisSecond: 0, eventWindowStart: 0, slot: idx >= 2 ? 1 : 0,
    };
    if (this.occupied === 1) this.host = idx;
    this.fixKits();
    this.touch();
    this.broadcastState();
    return idx;
  }

  private resume(idx: number, conn: Conn): boolean {
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
      s.gone = false;
      this.giveControl(idx, true);
      this.sendStart(idx);
      this.sendOthers(idx, { t: 'opp', status: 'reconnected', who: s.name, mate: this.isMate() });
      this.opts.log(`room ${this.code}: seat ${idx} reconnected`);
    } else if (this.state === 'results' && this.match) {
      this.sendStart(idx);
    }
    this.touch();
    this.broadcastState();
    return true;
  }

  /** In a team room the others are told who dropped (a teammate or an opponent). */
  private isMate() { return this.format !== '1v1'; }

  /** A seat's human takes or hands back their control; the side's two controls may swap (Match.setSeatHuman). */
  private giveControl(idx: number, human: boolean) {
    const m = this.match;
    const s = this.seats[idx];
    if (!m || !s) return;
    const side = sideOf(idx);
    if (m.setSeatHuman(side, s.slot, human)) {
      // The two controls swapped: so do the two seats' slots.
      const other = this.seats[idx >= 2 ? idx - 2 : idx + 2];
      s.slot = s.slot === 0 ? 1 : 0;
      if (other) other.slot = s.slot === 0 ? 1 : 0;
    }
  }

  /** Connection dropped (not an explicit leave). */
  disconnected(conn: Conn) {
    for (let idx = 0; idx < SEATS; idx++) {
      const s = this.seats[idx];
      if (!s || s.conn !== conn) continue;
      s.conn = null;
      s.connected = false;
      s.ready = this.state === 'lobby' ? false : s.ready;
      s.disconnectedAt = this.opts.now();
      s.queue = [];
      s.held = neutral(s.ack);
      if (this.state === 'match' && this.match) {
        // The computer takes the control at once; the player cannot gain anything by dropping.
        this.giveControl(idx, false);
        const grace = Math.min(NET.reconnectGraceMs, NET.totalGraceMsPerMatch - s.graceUsedMs);
        this.sendOthers(idx, { t: 'opp', status: 'disconnected', graceMs: Math.max(0, grace), who: s.name, mate: this.isMate() });
        this.opts.log(`room ${this.code}: seat ${idx} disconnected, grace ${grace} ms`);
      } else if (this.state === 'lobby' || this.state === 'countdown') {
        this.state = 'lobby';
      }
      this.broadcastState();
    }
  }

  leave(token: string) {
    const idx = this.seatOf(token);
    if (idx < 0) return;
    const s = this.seats[idx]!;
    s.conn = null;
    const team = this.format !== '1v1';
    if (this.state === 'match' && team && this.match) {
      // A team match goes on: the computer keeps that control. It ends if nobody is left.
      this.giveControl(idx, false);
      this.seats[idx] = null;
      if (!this.seats.some((x) => x?.connected)) this.endMatch('opponent_left', -1);
      this.sendOthers(idx, { t: 'opp', status: 'left', who: s.name, mate: true });
    } else if (this.state === 'match' || this.state === 'countdown' || this.state === 'results') {
      this.seats[idx] = null;
      if (this.state === 'match') this.endMatch('opponent_left', idx === 0 || idx === 1 ? idx : -1);
      else if (this.state === 'countdown') this.state = 'lobby';
      this.sendOthers(idx, { t: 'opp', status: 'left', who: s.name, mate: team });
    } else {
      this.seats[idx] = null;
      this.sendOthers(idx, { t: 'opp', status: 'left', who: s.name, mate: team });
    }
    if (this.state === 'lobby') this.compact();
    if (this.host === idx || !this.seats[this.host]) this.host = this.seats.findIndex(Boolean);
    if (this.state !== 'match') for (const st of this.seats) if (st) { st.ready = false; st.rematch = false; }
    if (!this.seats.some(Boolean)) this.closed = true;
    this.broadcastState();
  }

  /** In the lobby: a side's second player moves up when the first leaves, so seats 0 and 1 lead. */
  private compact() {
    for (const lead of [0, 1]) {
      if (!this.seats[lead] && this.seats[lead + 2] && this.active.includes(lead)) {
        this.seats[lead] = this.seats[lead + 2];
        this.seats[lead + 2] = null;
        this.seats[lead]!.slot = 0;
        if (this.host === lead + 2) this.host = lead;
      }
    }
  }

  /** Change the format: everyone is re-seated in order, the host first (refused if they don't fit). */
  private setFormat(f: RoomFormat): boolean {
    if (f === this.format) return true;
    const want = FORMAT_SEATS[f];
    const people = [this.host, ...this.seats.map((_, i) => i).filter((i) => i !== this.host)].filter((i) => this.seats[i]).map((i) => this.seats[i]!);
    if (people.length > want.length) return false;
    const fresh: (Seat | null)[] = [null, null, null, null];
    people.forEach((p, k) => { fresh[want[k]] = p; p.slot = want[k] >= 2 ? 1 : 0; p.club = this.clubs[sideOf(want[k])]; });
    this.seats = fresh;
    this.format = f;
    this.host = want[0];
    return true;
  }

  handle(token: string, msg: ClientMsg) {
    const idx = this.seatOf(token);
    if (idx < 0) return;
    const s = this.seats[idx]!;
    const now = this.opts.now();
    const side = sideOf(idx);
    switch (msg.t) {
      case 'lobby': {
        if (this.state !== 'lobby' || this.ranked) return;
        const isHost = idx === this.host;
        let changed = false;
        if (msg.format && isHost && msg.format !== this.format) changed = this.setFormat(msg.format);
        if (msg.aiDiff && isHost && msg.aiDiff !== this.aiDiff) { this.aiDiff = msg.aiDiff; changed = true; }
        if (msg.club && isHost && msg.club !== this.clubs[side]) {
          this.clubs[side] = msg.club;
          this.clubs[1 - side] = TEAMS.find((t) => t.id !== msg.club)!.id;
          changed = true;
        }
        if (msg.swap && isHost) { this.clubs = [this.clubs[1], this.clubs[0]]; changed = true; }
        // Kit and tactics belong to the side: either of its players may change them.
        if (msg.kit) { for (const i of [side, side + 2]) if (this.seats[i]) this.seats[i]!.kit = msg.kit; }
        if (msg.mentality) { for (const i of [side, side + 2]) if (this.seats[i]) this.seats[i]!.mentality = msg.mentality; }
        if (msg.sw) s.sw = msg.sw;
        if (msg.minutes && isHost) { this.minutes = msg.minutes; changed = true; }
        if (msg.ready !== undefined) s.ready = msg.ready;
        for (const st of this.seats) if (st) st.club = this.clubs[sideOf(this.seats.indexOf(st))];
        // Any settings change un-readies everyone else so nobody starts on terms they didn't see.
        if (changed || msg.kit) for (const st of this.seats) if (st && st !== s) st.ready = false;
        this.fixKits();
        this.touch();
        if (this.full && this.active.every((i) => this.seats[i]!.ready && this.seats[i]!.connected)) {
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
        for (const i of [side, side + 2]) if (this.seats[i]) this.seats[i]!.mentality = msg.mentality;
        if (this.match) this.match.cfg.mentality[side] = msg.mentality;
        if (msg.tac) {
          s.tactics = msg.tac;
          if (this.match) { this.match.cfg.tactics ??= [defaultTactics(), defaultTactics()]; this.match.cfg.tactics[side] = msg.tac; }
        }
        break;
      case 'sub':
        if (this.match) this.match.requestSub(side, msg.id, msg.bench);
        break;
      case 'rematch': {
        if (this.state !== 'results' || this.ranked) return;
        s.rematch = msg.want;
        this.touch();
        if (this.full && this.active.every((i) => this.seats[i]!.rematch && this.seats[i]!.connected)) {
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

  /** The two sides' kits: the computer side changes if they clash (or the second side does). */
  private kitFor(side: 0 | 1): 'home' | 'away' {
    if (this.format === 'coop' && side === 1) return this.aiKit;
    return this.seats[side]?.kit ?? this.seats[side + 2]?.kit ?? 'home';
  }

  private fixKits() {
    if (this.format === 'coop') {
      const k0 = teamById(this.clubs[0])[this.kitFor(0)];
      this.aiKit = colourDistance(k0.shirt, teamById(this.clubs[1]).home.shirt) < 120 ? 'away' : 'home';
      return;
    }
    if (!this.seats[1] && !this.seats[3]) return;
    const ka = teamById(this.clubs[0])[this.kitFor(0)], kb = teamById(this.clubs[1])[this.kitFor(1)];
    if (colourDistance(ka.shirt, kb.shirt) < 120) {
      const k = this.kitFor(1) === 'home' ? 'away' : 'home';
      for (const i of [1, 3]) if (this.seats[i]) this.seats[i]!.kit = k;
    }
  }

  private startMatch() {
    const lead = (side: 0 | 1) => this.seats[side] ?? this.seats[side + 2];
    const a = lead(0)!, b = lead(1);
    const coop = this.format === 'coop';
    const has = (side: 0 | 1) => !!(this.seats[side] || this.seats[side + 2]);
    const both = (side: 0 | 1) => !!(this.seats[side] && this.seats[side + 2]);
    const cfg = defaultConfig({
      teams: [this.clubs[0], this.clubs[1]], kits: [this.kitFor(0), this.kitFor(1)], realMinutes: this.minutes, humans: [has(0), has(1)],
      mates: [both(0), both(1)],
      // The computer side in a co-op room plays at the room's level; human sides' teammates at Pro.
      difficulty: ['pro', coop ? this.aiDiff : 'pro'], mentality: [a.mentality, b?.mentality ?? 'balanced'], autoSwitch: [true, !coop],
      switchStyle: [a.sw?.[0] ?? 'full', b?.sw?.[0] ?? 'full'], switchSens: [a.sw?.[1] ?? 'normal', b?.sw?.[1] ?? 'normal'], seed: randomBytes(4).readUInt32LE(0),
      tactics: [a.tactics ?? defaultTactics(), b?.tactics ?? defaultTactics()],
      // No home side online: the crowd stays neutral.
      momentum: false,
    });
    // Weather: rolled here so everyone sees (and plays in) the same conditions.
    const r = randomBytes(6);
    const kind = rollWeatherKind(r[0] / 256);
    cfg.weather = { kind, ...rollWind(kind, r[1] / 256, r.readUInt16LE(2) / 65536) };
    this.match = new Match(cfg);
    for (let i = 0; i < SEATS; i++) {
      const s = this.seats[i];
      if (!s) continue;
      s.ack = 0; s.queue = []; s.held = neutral(); s.graceUsedMs = 0; s.ready = false; s.rematch = false; s.gone = false;
      // A side with one person: they drive its main control, whichever seat they sit in.
      s.slot = i >= 2 && this.seats[i - 2] ? 1 : 0;
    }
    this.state = 'match';
    this.halftimeAt = -1;
    this.resultsAt = -1;
    this.pendingEvents = [];
    for (let i = 0; i < SEATS; i++) this.sendStart(i);
    this.opts.log(`room ${this.code}: ${this.format} match started (${this.clubs[0]} v ${this.clubs[1]}, ${this.minutes} min)`);
    this.broadcastState();
  }

  private sendStart(idx: number) {
    const m = this.match;
    const s = this.seats[idx];
    if (!m || !s) return;
    this.sendTo(idx, { t: 'start', side: sideOf(idx), slot: s.slot, format: this.format, teams: m.cfg.teams, kits: m.cfg.kits, minutes: m.cfg.realMinutes, mentality: m.cfg.mentality, weather: m.weather });
  }

  /**
   * A ranked room: both players are already seated with their clubs; kick-off counts down at once.
   * There is no rematch (they queue again).
   */
  startRanked(ids: [string, string], clubs: [string, string]) {
    this.ranked = { ids, reported: false };
    this.format = '1v1';
    this.clubs = [clubs[0], clubs[1]];
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
      const all = this.full && this.active.every((i) => this.seats[i]!.connected);
      if (!all && this.ranked) { this.closed = true; this.broadcast({ t: 'opp', status: 'left' }); return; }
      if (!all) { this.state = 'lobby'; this.broadcastState(); return; }
      if (now >= this.countdownEnd) this.startMatch();
      return;
    }
    if (this.state !== 'match' || !this.match) return;
    const m = this.match;
    for (let idx = 0; idx < SEATS; idx++) {
      const s = this.seats[idx];
      if (!s || s.gone) continue;
      if (!s.connected) {
        const grace = Math.min(NET.reconnectGraceMs, NET.totalGraceMsPerMatch - s.graceUsedMs);
        if (now - s.disconnectedAt > grace) {
          // One against one: the match is abandoned. A team match goes on with the computer in their place.
          if (this.format === '1v1') { this.endMatch('abandoned', idx as 0 | 1); return; }
          s.gone = true;
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
      m.applyInput(sideOf(idx), f, s.slot);
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
      for (const s of this.seats) {
        if (!s?.conn) continue;
        const snap = encodeSnapshot(m, s.ack, ev, withStats);
        if (this.format !== '1v1') snap.sl = s.slot;
        s.conn.send(snap);
      }
    }
    if (m.phase === 'fulltime') this.endMatch('fulltime');
  }

  /** True when the room should be removed. */
  expired(): boolean {
    const now = this.opts.now();
    if (this.closed) return true;
    if (!this.seats.some(Boolean)) return true;
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

  private sendOthers(idx: number, msg: ServerMsg) {
    this.seats.forEach((s, i) => { if (i !== idx) s?.conn?.send(msg); });
  }

  private broadcast(msg: ServerMsg) {
    for (const s of this.seats) s?.conn?.send(msg);
  }

  stateFor(idx: number): RoomState {
    const seat = (s: Seat | null, i: number): LobbySeat | null => (s ? { name: s.name, connected: s.connected, ready: s.ready, club: this.clubs[sideOf(i)], kit: this.kitFor(sideOf(i)), mentality: s.mentality } : null);
    return {
      t: 'room', code: this.code, you: idx, seats: this.seats.map(seat), minutes: this.minutes, state: this.state,
      countdown: this.state === 'countdown' ? Math.max(0, this.countdownEnd - this.opts.now()) : 0,
      rematch: this.seats.map((s) => !!s?.rematch), host: this.host,
      format: this.format, aiDiff: this.aiDiff, clubs: [this.clubs[0], this.clubs[1]], kits: [this.kitFor(0), this.kitFor(1)],
      ...(this.ranked ? { ranked: true } : {}),
    };
  }

  broadcastState() {
    for (let idx = 0; idx < SEATS; idx++) this.seats[idx]?.conn?.send(this.stateFor(idx));
  }
}
