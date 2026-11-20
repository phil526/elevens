import type { Tactics } from '../../shared/teams';
import type { Rated } from '../../shared/ratings';
import { benchFor } from '../../shared/teams';
// Online match view: snapshot interpolation (100 ms buffer) for everything,
// plus prediction of the locally controlled player's movement, reconciled by
// replaying unacknowledged input from each authoritative snapshot. The ball is
// never predicted (only drawn relative to a locally predicted dribbler).

import type { Mentality } from '../../shared/config';
import { GAME_PLANS, NET, SIM, type GamePlan } from '../../shared/config';
import { cleanWeather, weatherPlay, type MatchWeather, type WeatherPlay } from '../../shared/weather';
import { angleOf } from '../../shared/math';
import { carrierMove, stepMovement, type MoveMode, type MoverState } from '../../shared/movement';
import { ACTIONS, BALL_STATES, FLIGHTS, KICKS, PHASES, PLAYER_STRIDE, RESTARTS, SKILLS, type Snapshot } from '../../shared/snapshot';
import { teamById, type TeamDef } from '../../shared/teams';
import type { Attributes, InputFrame, MatchEvent, TeamStats } from '../../shared/types';
import { emptyStats } from '../../shared/types';
import type { ActionLayer } from '../input/actions';
import type { ConnInfo, Session } from '../game/session';
import type { ViewState } from '../view';
import { possessionTeam } from '../view';
import type { NetClient } from './netclient';

const TICK_MS = 1000 / SIM.tickRate;
const INTERP_TICKS = (NET.interpDelayMs / 1000) * SIM.tickRate;

export interface StartInfo {
  side: 0 | 1;
  teams: [string, string];
  kits: ['home' | 'away', 'home' | 'away'];
  minutes: number;
  mentality: [Mentality, Mentality];
  weather?: MatchWeather;
}

export class OnlineSession implements Session {
  kind = 'online' as const;
  localTeams: number[];
  private snaps: Snapshot[] = [];
  private tickOffset: number | null = null; // serverTick ≈ now / TICK_MS + offset
  private acc = 0;
  private pending: InputFrame[] = [];
  private outbox: InputFrame[] = [];
  private events: MatchEvent[] = [];
  private queuedEvents: MatchEvent[] = [];
  private seenEvent = 0;
  private v: ViewState;
  private attrs: Attributes[];
  private predicted: MoverState | null = null;
  private predFor = -1;
  private smooth = { x: 0, z: 0 };
  private lastStats: [TeamStats, TeamStats] = [emptyStats(), emptyStats()];
  private lastRatings: Rated[] | undefined;
  oppStatus = '';
  lastSnapAt = 0;
  private wp: WeatherPlay;
  private planEvent = -1;
  /** Player instructions waiting to go with the next input frames, and this side's current ones. */
  private instrEvents: number[] = [];
  private instr = new Array(11).fill(0);
  predictionEnabled = true;

  constructor(public start: StartInfo, private net: NetClient, private actions: ActionLayer) {
    this.localTeams = [start.side];
    const weather = cleanWeather(start.weather);
    this.wp = weatherPlay(weather);
    const teams: [TeamDef, TeamDef] = [teamById(start.teams[0]), teamById(start.teams[1])];
    this.attrs = teams.flatMap((t) => t.players.map((p) => {
      const a = p.attrs;
      return { pace: a.pace / 100, acceleration: a.acceleration / 100, stamina: a.stamina / 100, control: a.control / 100, passing: a.passing / 100, shooting: a.shooting / 100, tackling: a.tackling / 100, goalkeeping: a.goalkeeping / 100 };
    }));
    this.v = {
      teams, kits: start.kits,
      players: teams.flatMap((t, ti) => t.players.map((def, i) => ({
        id: ti * 11 + i, team: ti as 0 | 1, role: def.role, def, pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, facing: 0, stamina: 1, sprinting: false, jockeying: false, cards: 0, off: false,
        action: { type: 'none' as const, t: 0, dur: 0 },
      }))),
      ball: { pos: { x: 0, y: 0.11, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1, flight: 'none', lastTouchTeam: -1 },
      phase: 'kickoff', phaseT: 0, half: 1, clock: 0, addedTime: 0, shootout: null, subs: [], attempts: 0, score: [0, 0], restart: null, ctl: [-1, -1], next: [-1, -1], humans: [true, true], attackDir: [1, -1],
      goals: [], stats: this.lastStats, holdT: 0, realMinutes: start.minutes, plans: ['balanced', 'balanced'], weather,
    };
  }

  /** Feed a snapshot from the network. */
  push(s: Snapshot, recvAt: number) {
    this.lastSnapAt = recvAt;
    const est = s.t - recvAt / TICK_MS;
    // Track the server clock; ignore late packets when estimating, snap on big jumps (tab was hidden).
    if (this.tickOffset === null || Math.abs(est - this.tickOffset) > 30) this.tickOffset = est;
    else this.tickOffset = Math.max(this.tickOffset - 0.05, this.tickOffset + (est - this.tickOffset) * 0.05);
    if (this.snaps.length && s.t <= this.snaps[this.snaps.length - 1].t) return;
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
    for (const e of s.ev) if (e.id > this.seenEvent) { this.queuedEvents.push(e); this.seenEvent = e.id; }
    if (s.st) this.lastStats = s.st;
    if (s.ps) this.lastRatings = s.ps;
    // Reconciliation: drop acknowledged input, then re-predict from this authoritative state.
    this.pending = this.pending.filter((f) => f.seq > s.ack);
    this.repredict(s);
  }

  private repredict(s: Snapshot) {
    const side = this.start.side;
    const pid = s.ctl[side];
    const o = pid * PLAYER_STRIDE;
    const action = ACTIONS[s.p[o + 6]];
    const phase = PHASES[s.ph];
    const ownsBall = s.b[7] === pid;
    // A pass on its way to this player: the server steers him onto the ball (receive assist, or the
    // stick still held from the pass being ignored), so follow it rather than predict from the stick.
    const receiving = BALL_STATES[s.b[6]] === 'flight' && s.b[10] === pid;
    const canPredict = this.predictionEnabled && phase === 'play' && action === 'none' && !(BALL_STATES[s.b[6]] === 'held') && !receiving;
    if (!canPredict) { this.dropPrediction(); return; }
    const m: MoverState = {
      pos: { x: s.p[o], z: s.p[o + 1] }, vel: { x: s.p[o + 2], z: s.p[o + 3] }, facing: s.p[o + 4], stamina: s.p[o + 5] / 100,
      sprinting: false, jockeying: false, a: this.attrs[pid],
    };
    const ball = { x: s.b[0], z: s.b[2] };
    for (const f of this.pending) {
      const mode: MoveMode = f.jockey ? 'jockey' : f.sprint ? 'sprint' : 'jog'; // on the ball the jockey button shields (also at jockey pace)
      const face = mode === 'jockey' && !ownsBall ? angleOf(ball.x - m.pos.x, ball.z - m.pos.z) : null;
      const cm = ownsBall ? carrierMove(m.a, mode, !!f.close) : { mode, speed: 1, accel: 1, turn: 1 };
      stepMovement(m, f.mx, f.mz, cm.mode, SIM.dt, face, (ownsBall ? 0.92 : 1) * cm.speed * this.wp.speed, cm.accel * this.wp.accel, cm.turn * this.wp.turn);
    }
    if (this.predFor !== pid) {
      // Newly controlled player: start from where it is drawn now to avoid a pop.
      const cur = this.v.players[pid];
      this.smooth = { x: cur.pos.x - m.pos.x, z: cur.pos.z - m.pos.z };
      if (Math.hypot(this.smooth.x, this.smooth.z) > 3) this.smooth = { x: 0, z: 0 };
    } else if (this.predicted) {
      // Correction: keep the visual continuous and bleed the error away.
      this.smooth.x += this.predicted.pos.x - m.pos.x;
      this.smooth.z += this.predicted.pos.z - m.pos.z;
      if (Math.hypot(this.smooth.x, this.smooth.z) > 4) this.smooth = { x: 0, z: 0 };
    }
    this.predicted = m;
    this.predFor = pid;
  }

  private dropPrediction() {
    if (this.predicted) {
      this.predicted = null;
      this.predFor = -1;
    }
  }

  attacking(): boolean {
    const v = this.v;
    const side = this.start.side;
    if (v.restart && v.restart.team === side) return true;
    if (v.ball.state === 'held' && v.ball.owner >= 0 && v.players[v.ball.owner].team === side) return true;
    return possessionTeam(v) === side;
  }

  update(dt: number, now: number) {
    // Sample input at a fixed 60 Hz and batch 2 frames per message (30 messages/s).
    this.acc += Math.min(dt, 0.25);
    const live = this.v.phase === 'play' || this.v.phase === 'restart' || this.v.phase === 'kickoff';
    while (this.acc >= SIM.dt) {
      this.acc -= SIM.dt;
      const f = this.actions.sample(now, { attacking: this.attacking() }, live);
      this.pending.push(f);
      this.outbox.push(f);
      if (this.pending.length > 120) this.pending.shift();
      // Advance the prediction with this frame immediately (responsive local movement).
      if (this.predicted) {
        const m = this.predicted;
        const ball = this.v.ball.pos;
        const ownsBall = this.v.ball.owner === this.predFor;
        const mode: MoveMode = f.jockey ? 'jockey' : f.sprint ? 'sprint' : 'jog'; // on the ball the jockey button shields (also at jockey pace)
        const face = mode === 'jockey' && !ownsBall ? angleOf(ball.x - m.pos.x, ball.z - m.pos.z) : null;
        const cm = ownsBall ? carrierMove(m.a, mode, !!f.close) : { mode, speed: 1, accel: 1, turn: 1 };
        stepMovement(m, f.mx, f.mz, cm.mode, SIM.dt, face, (ownsBall ? 0.92 : 1) * cm.speed * this.wp.speed, cm.accel * this.wp.accel, cm.turn * this.wp.turn);
      }
      if (this.planEvent >= 0 && f.ev.length < 4) { f.ev.push({ k: 'plan', p: this.planEvent / 4 }); this.planEvent = -1; }
      while (this.instrEvents.length && f.ev.length < 4) f.ev.push({ k: 'instr', p: this.instrEvents.shift()! / 32 });
      if (this.outbox.length >= 2 || f.ev.length) {
        this.net.send({ t: 'in', f: this.outbox });
        this.outbox = [];
      }
    }
    const k = Math.exp(-dt * 10);
    this.smooth.x *= k;
    this.smooth.z *= k;
    this.buildView(now);
  }

  private buildView(now: number) {
    if (!this.snaps.length || this.tickOffset === null) return;
    const renderTick = now / TICK_MS + this.tickOffset - INTERP_TICKS;
    let a = this.snaps[0], b = this.snaps[0];
    for (let i = 0; i < this.snaps.length; i++) {
      if (this.snaps[i].t <= renderTick) a = this.snaps[i];
      if (this.snaps[i].t > renderTick) { b = this.snaps[i]; break; }
      b = this.snaps[i];
    }
    // Keep a few old snapshots only.
    while (this.snaps.length > 3 && this.snaps[1].t < renderTick - 30) this.snaps.shift();
    const span = b.t - a.t;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (renderTick - a.t) / span)) : 0;
    const extra = Math.max(0, Math.min(6, renderTick - b.t)) / SIM.tickRate; // brief extrapolation if late
    const v = this.v;
    const lerp = (x: number, y: number) => x + (y - x) * alpha;
    for (let i = 0; i < 22; i++) {
      const o = i * PLAYER_STRIDE;
      const p = v.players[i];
      const ax = a.p[o], az = a.p[o + 1], bx = b.p[o], bz = b.p[o + 1];
      const jump = Math.abs(ax - bx) + Math.abs(az - bz) > 3;
      p.pos.x = jump ? bx : lerp(ax, bx) + b.p[o + 2] * extra;
      p.pos.z = jump ? bz : lerp(az, bz) + b.p[o + 3] * extra;
      p.vel.x = lerp(a.p[o + 2], b.p[o + 2]);
      p.vel.z = lerp(a.p[o + 3], b.p[o + 3]);
      let fa = a.p[o + 4], fb = b.p[o + 4];
      if (fb - fa > Math.PI) fa += Math.PI * 2;
      if (fa - fb > Math.PI) fb += Math.PI * 2;
      p.facing = lerp(fa, fb);
      p.stamina = b.p[o + 5] / 100;
      const src = alpha < 0.5 ? a : b;
      const so = o;
      const at = ACTIONS[src.p[so + 6]];
      const ticksAhead = renderTick - src.t;
      const k9 = src.p[so + 9];
      p.action = at === 'skill'
        ? { type: at, t: src.p[so + 7] / 1000 + ticksAhead / SIM.tickRate, dur: src.p[so + 8] / 1000, skill: SKILLS[k9 & 31], side: k9 & 32 ? -1 : 1 }
        : { type: at, t: src.p[so + 7] / 1000 + ticksAhead / SIM.tickRate, dur: src.p[so + 8] / 1000, kind: KICKS[k9 & 15], variant: k9 & 16 ? 'roll' : undefined };
      if (at === 'dive') {
        const d = src.dv.find((x) => x[0] === i);
        if (d) p.action.target = { x: d[1], y: d[2], z: d[3] };
      }
      p.sprinting = (src.p[so + 10] & 1) === 1;
      p.jockeying = (src.p[so + 10] & 2) === 2;
      p.off = (src.p[so + 10] & 8) === 8;
      p.calling = (src.p[so + 10] & 16) === 16;
      p.cards = p.off ? 2 : (src.p[so + 10] & 4) === 4 ? 1 : 0;
    }
    const bj = Math.abs(a.b[0] - b.b[0]) + Math.abs(a.b[2] - b.b[2]) > 4;
    v.ball.pos = bj ? { x: b.b[0], y: b.b[1], z: b.b[2] } : { x: lerp(a.b[0], b.b[0]), y: lerp(a.b[1], b.b[1]), z: lerp(a.b[2], b.b[2]) };
    v.ball.vel = { x: b.b[3], y: b.b[4], z: b.b[5] };
    v.ball.state = BALL_STATES[b.b[6]];
    v.ball.owner = b.b[7];
    v.ball.flight = FLIGHTS[b.b[8]];
    v.ball.lastTouchTeam = b.b[9];
    v.phase = PHASES[b.ph];
    v.phaseT = b.pt;
    v.half = b.h;
    v.clock = lerp(a.c, b.c);
    v.addedTime = b.ex ?? 0;
    v.shootout = b.so ? { kicks: [b.so[0].map((k) => k === 1), b.so[1].map((k) => k === 1)], team: b.so[2] as 0 | 1, winner: b.so[3] as -1 | 0 | 1 } : null;
    v.score = b.sc;
    v.restart = b.r ? { type: RESTARTS[b.r[0]], team: b.r[1], taker: b.r[2], ready: b.r[3] === 1, spot: { x: b.r[4], z: b.r[5] }, readyT: b.r[6], aim: { x: b.r[7] ?? b.r[4], z: b.r[8] ?? b.r[5] }, quick: b.r[9] === 1, curve: b.r[10] ?? 0, dip: b.r[11] ?? 0, shake: b.r[12] ?? 0, stutter: b.r[13] === 1, gkCommit: b.r[14] ? b.r[14] - 2 : undefined } : null;
    v.momentum = undefined; // no home crowd online (room.ts)
    v.ctl = b.ctl;
    v.next = b.nx;
    v.humans = [b.hu[0] === 1, b.hu[1] === 1];
    v.attackDir = b.ad;
    v.goals = b.g;
    // Substitutions: swap in the bench player's name, number and attributes (prediction uses them too).
    for (const [team, slot, bi] of (b.sb ?? []).slice(this.subsSeen)) {
      const id = team * 11 + slot;
      const bd = benchFor(v.teams[team])[bi];
      if (!bd || !v.players[id]) continue;
      const def = { ...bd, role: v.players[id].role };
      v.players[id].def = def;
      const a = def.attrs;
      this.attrs[id] = { pace: a.pace / 100, acceleration: a.acceleration / 100, stamina: a.stamina / 100, control: a.control / 100, passing: a.passing / 100, shooting: a.shooting / 100, tackling: a.tackling / 100, goalkeeping: a.goalkeeping / 100 };
    }
    this.subsSeen = Math.max(this.subsSeen, b.sb?.length ?? 0);
    v.subs = b.sb ?? v.subs;
    v.stats = this.lastStats;
    v.ratings = b.ph === PHASES.indexOf('fulltime') || b.ph === PHASES.indexOf('halftime') ? this.lastRatings : undefined;
    v.holdT = b.hold;
    v.plans = b.gp ? [GAME_PLANS[b.gp[0]] ?? 'balanced', GAME_PLANS[b.gp[1]] ?? 'balanced'] : ['balanced', 'balanced'];

    // Local prediction overrides the interpolated position of our controlled player.
    const latest = this.snaps[this.snaps.length - 1];
    const pid = latest.ctl[this.start.side];
    if (this.predicted && this.predFor === pid) {
      const p = v.players[pid];
      const before = { x: p.pos.x, z: p.pos.z };
      p.pos.x = this.predicted.pos.x + this.smooth.x;
      p.pos.z = this.predicted.pos.z + this.smooth.z;
      p.vel.x = this.predicted.vel.x;
      p.vel.z = this.predicted.vel.z;
      p.facing = this.predicted.facing;
      if (v.ball.owner === pid && v.ball.state === 'dribble') {
        // Draw our dribbled ball relative to the predicted player to avoid visible lag.
        v.ball.pos.x += p.pos.x - before.x;
        v.ball.pos.z += p.pos.z - before.z;
      }
    }
    // Release events once the rendered timeline reaches them.
    const due: MatchEvent[] = [];
    this.queuedEvents = this.queuedEvents.filter((e) => (e.tick <= renderTick + 1 ? (due.push(e), false) : true));
    this.events.push(...due);
  }

  view() {
    return this.snaps.length ? this.v : null;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  private tac: Tactics | undefined;
  private subsSeen = 0;
  setMentality(m: Mentality) {
    this.start.mentality[this.start.side] = m;
    this.net.send(this.tac ? { t: 'tactic', mentality: m, tac: this.tac } : { t: 'tactic', mentality: m });
  }

  requestSub(id: number, bench: number) {
    this.net.send({ t: 'sub', id, bench });
    return true;
  }

  /** Live game plan: sent with the next input frame. */
  setPlan(p: GamePlan) {
    this.planEvent = GAME_PLANS.indexOf(p);
  }

  /** Player instruction (-1 stay back, 0 normal, 1 get forward), sent with the next input frame. */
  setInstruction(slot: number, v: number) {
    this.instr[slot] = v;
    this.instrEvents.push(slot * 3 + v + 1);
  }
  instructions(): number[] {
    return this.instr.slice();
  }

  setTactics(t: Tactics) {
    this.tac = t;
    this.net.send({ t: 'tactic', mentality: this.start.mentality[this.start.side], tac: t });
  }

  conn(): ConnInfo {
    const st = this.net.status;
    const stale = performance.now() - this.lastSnapAt > 1500;
    if (st === 'reconnecting') return { show: true, state: 'Reconnecting…', latency: -1, colour: '#ffb020' };
    if (st !== 'connected') return { show: true, state: 'Disconnected', latency: -1, colour: '#ff5a5f' };
    if (this.oppStatus) return { show: true, state: this.oppStatus, latency: this.net.latency, colour: '#ffb020' };
    if (stale) return { show: true, state: 'Waiting for server…', latency: this.net.latency, colour: '#ffb020' };
    const lat = this.net.latency;
    return { show: true, state: 'Online', latency: lat, colour: lat > 180 ? '#ffb020' : '#3ee08f' };
  }

  /** After the tab was hidden: discard stale snapshots and resynchronise. */
  resync() {
    this.snaps = this.snaps.slice(-1);
    this.tickOffset = null;
    this.actions.clear();
  }

  debugText() {
    const last = this.snaps[this.snaps.length - 1];
    return `online  latency ${this.net.latency.toFixed(0)} ms  status ${this.net.status}\nserver tick ${last?.t ?? '-'}  buffered ${this.snaps.length}  pending inputs ${this.pending.length}\nack ${last?.ack ?? '-'}  predicted ${this.predicted ? 'yes' : 'no'}  smooth ${Math.hypot(this.smooth.x, this.smooth.z).toFixed(2)} m\nphase ${this.v.phase}  ball ${this.v.ball.state}/${this.v.ball.flight} owner ${this.v.ball.owner}\ncontrolled ${this.v.ctl[this.start.side]}`;
  }

  dispose() {}
}
