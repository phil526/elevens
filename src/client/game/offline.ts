import { cleanTactics, defaultTactics, type Tactics } from '../../shared/teams';
// Offline exhibition: the shared Match runs in the browser at a fixed 60 Hz,
// independent of the rendering frame rate. Needs no server.

import type { GamePlan, Mentality } from '../../shared/config';
import { SIM } from '../../shared/config';
import { Match } from '../../shared/match';
import type { MatchConfig, MatchEvent, TeamIndex } from '../../shared/types';
import type { ActionLayer } from '../input/actions';
import { MatchViewBuilder, possessionTeam, type ViewState } from '../view';
import type { Session } from './session';

export class OfflineSession implements Session {
  kind = 'offline' as const;
  match: Match;
  private builder: MatchViewBuilder;
  private acc = 0;
  private events: MatchEvent[] = [];
  paused = false;
  private stepMs = 0;
  localTeams: number[];

  /**
   * Local multiplayer: `actions` drives `local` (its first human) and each extra seat drives its own
   * side and slot (slot 1 = the co-op second human).
   */
  constructor(public cfg: MatchConfig, private actions: ActionLayer, private local: TeamIndex, public extra: { team: TeamIndex; slot: 0 | 1; layer: ActionLayer }[] = []) {
    this.localTeams = [local, ...extra.map((e) => e.team).filter((t, i, a) => t !== local && a.indexOf(t) === i)];
    this.match = new Match(cfg);
    this.builder = new MatchViewBuilder(this.match);
  }

  attacking(team: number = this.local) {
    const m = this.match;
    if (m.restart && m.restart.team === team) return true;
    return m.possessionTeam() === team || (m.ball.state === 'held' && m.players[m.ball.owner]?.team === team);
  }

  update(dt: number, now: number) {
    if (this.paused) return;
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= SIM.dt && steps < 6) {
      this.builder.capture();
      const live = this.match.phase === 'play' || this.match.phase === 'restart' || this.match.phase === 'kickoff';
      const frame = this.actions.sample(now, { attacking: this.attacking() }, live);
      this.match.applyInput(this.local, frame);
      for (const e of this.extra) this.match.applyInput(e.team, e.layer.sample(now, { attacking: this.attacking(e.team) }, live), e.slot);
      const t0 = performance.now();
      this.match.step();
      this.stepMs = this.stepMs * 0.95 + (performance.now() - t0) * 0.05;
      for (const e of this.match.drainEvents()) this.events.push(e);
      this.acc -= SIM.dt;
      steps++;
    }
    if (steps >= 6) this.acc = 0; // fell behind (e.g. tab throttled): drop time rather than spiral
  }

  view(): ViewState {
    return this.builder.build(Math.min(1, this.acc / SIM.dt));
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  setMentality(m: Mentality) {
    this.match.cfg.mentality[this.local] = m;
  }

  requestSub(id: number, bench: number) {
    return this.match.requestSub(this.local as 0 | 1, id, bench);
  }

  setPlan(p: GamePlan) {
    this.match.setPlan(this.local, p);
  }

  setInstruction(slot: number, v: number) {
    this.match.setInstruction(this.local as 0 | 1, slot, v);
  }
  instructions(): number[] {
    return this.match.instr[this.local].slice();
  }

  setTactics(t: Tactics) {
    const c = this.match.cfg;
    c.tactics ??= [defaultTactics(), defaultTactics()];
    c.tactics[this.local] = cleanTactics(t);
  }

  continueHalftime() {
    this.match.continueAfterHalftime();
  }

  pause(p: boolean) {
    this.paused = p;
    this.actions.clear();
    for (const e of this.extra) e.layer.clear();
  }

  conn() {
    return null;
  }

  debugText() {
    const m = this.match;
    const b = m.ball;
    const c = m.ctrl[this.local];
    return `sim step ${this.stepMs.toFixed(2)} ms  tick ${m.tick}\nphase ${m.phase}  restart ${m.restart?.type ?? '-'}\nball ${b.state}/${b.flight} owner ${b.owner} last ${b.lastTouch}\npos (${b.pos.x.toFixed(1)}, ${b.pos.y.toFixed(2)}, ${b.pos.z.toFixed(1)}) v ${Math.hypot(b.vel.x, b.vel.z).toFixed(1)}\ncontrolled ${c.pid} next ${c.next}  possession ${possessionTeam(this.view())}\nlog: ${m.log.slice(-2).join('\n     ')}`;
  }

  /** AI targets and formation positions for the optional debug visualisation. */
  debugDraw() {
    return {
      targets: this.match.players.filter((p) => !this.match.isHumanControlled(p)).map((p) => ({ x: p.pos.x + p.wish.x * 3, z: p.pos.z + p.wish.z * 3, team: p.team })),
    };
  }

  dispose() {}
}
