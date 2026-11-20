// Directs the match cinematics on top of a running session: the pre-match intro (stadium
// fly-in, then the teams walking out of the tunnel) and a net-cam replay after each goal.
// Offline only: the match is paused while one plays. Any key, tap or controller button skips.

import * as THREE from 'three';
import { introLights } from './render/haze';
import type { GameRenderer } from './render/renderer';
import { INTRO, INTRO_LENGTH, REPLAY, ReplayRecorder, goalSideOf, snapOf, introFrame, netCamShot, stageIntro, stageReplay, type Snap, type TunnelInfo } from './render/cinematic';
import type { ViewState } from './view';
import { TROPHY, stageTrophy, trophyShot } from './render/ceremony';
import { AERIAL, AERIAL_LENGTH, aerialShot } from './render/blimp';
import { VAR, varInfo, varShot, type VarInfo } from './render/var';
import { PHOTO_FLASHES, PREMATCH, PREMATCH_CUTS, PREMATCH_LENGTH, prematchPoses, prematchShot, preStage, stagePrematch } from './render/prematch';
import { CELEB, celebKindFor, celebrationReactions, celebrationShot, planCelebration, stageCelebration, type CelebKind, type CelebPlan } from './render/celebration';
import { HIGHLIGHTS, HighlightBook, MOMENT_TITLE, type Highlight, type MomentInfo } from './highlights';

export type CineMode = 'none' | 'intro' | 'replay' | 'instant' | 'highlights' | 'trophy' | 'celebration' | 'aerial' | 'var';

/** Highlights reel playback: fades between clips, and how a goal is shown again from the net. */
export const REEL = { fade: 0.35, caption: 3.4, netBefore: 2.3, netAfter: 0.7, netSpeed: 0.62 } as const;

/** Instant replay (from the pause menu): how much play is kept, and the cameras it cycles through. */
export const INSTANT = { keep: 20, start: 10, step: 5, speeds: [1, 0.5, 0.25], cams: ['Match camera', 'Net cam', 'Ball cam', 'High cam'] } as const;
export type InstantCmd = 'play' | 'back' | 'forward' | 'slow' | 'camera';

export class CineDirector {
  mode: CineMode = 'none';
  private t = 0;
  private clock = 0; // live time, for the replay recorder
  private rec = new ReplayRecorder(Math.max(INSTANT.keep, REPLAY.before + REPLAY.after + 3, HIGHLIGHTS.maxClip + HIGHLIGHTS.merge + 2));
  /** Big moments of the match, kept as clips for the half-time and full-time highlights. */
  readonly book = new HighlightBook();
  private reel: { list: Highlight[]; i: number; net: boolean; t: number; look: THREE.Vector3; cued: boolean; snapped: boolean } | null = null;
  private lastKey = '';
  private instant: { t: number; playing: boolean; speed: number; cam: number; look: THREE.Vector3; pos: THREE.Vector3 } | null = null;
  /** Called while an instant replay runs, with its state for the controls bar. */
  onInstant: (s: { t: number; first: number; last: number; playing: boolean; speed: number; cam: string }) => void = () => {};
  private goalAt: number | null = null;
  private goalBy: { player: number; team: number; og: boolean } | null = null;
  /** Goal celebrations staged before the replay (set by the app each frame: offline, setting on). */
  celebrate = false;
  /** Force the next celebration (tests and screenshots). */
  nextCeleb: CelebKind | null = null;
  private celeb: { plan: CelebPlan; t: number; pos: THREE.Vector3; look: THREE.Vector3; r: GameRenderer; replay: boolean } | null = null;
  private celebDone = false;
  private introR: GameRenderer | null = null;
  /** The last kick by each side (recorder time), to find the moment of an offside pass. */
  private kicks: [{ at: number; snap: Snap } | null, { at: number; snap: Snap } | null] = [null, null];
  private varPending: { info: VarInfo; at: number } | null = null;
  private varPlay: { info: VarInfo; r: GameRenderer; name: string } | null = null;
  /** Offside checks shown full screen (set by the app each frame: offline, setting on). */
  varChecks = false;
  /** Offside checks on the big screens (any match, setting on). */
  varScreens = true;
  private replay: { t0: number; t1: number; tg: number; side: number; z: number; look: THREE.Vector3; shown: boolean } | null = null;
  private tunnel: TunnelInfo = { x: 0, z: -43, dir: 1 };
  private fadeIn = 0; // fade back to the match camera
  private cheered = false;
  private el: HTMLElement;
  private fadeEl: HTMLElement;
  private flashEl: HTMLElement;
  /** The pre-match ceremony after the walk-out (mascots, line-up, handshakes, team photos). */
  private ceremony = false;
  private flashes = 0;
  private capEl: HTMLElement;
  private tagEl: HTMLElement;
  private goalEl: HTMLElement;
  private skipEl: HTMLElement;
  /** Called when a cinematic starts and ends (pause / resume the match, hide the HUD). */
  onChange: (mode: CineMode) => void = () => {};
  onCue: (cue: 'walkout' | 'goal' | 'chance' | 'trophy' | 'firework' | 'flash') => void = () => {};
  private trophy: { team: 0 | 1; captain: number; t: number; lifted: boolean; bangs: number; r: GameRenderer } | null = null;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'cine';
    this.el.innerHTML = `<div class="cine-fade"></div><div class="cine-flash"></div><div class="cine-cap"></div><div class="cine-tag"><i></i><span>REPLAY</span></div><div class="cine-goal">GOAL!</div><div class="cine-skip">Press any button to skip</div>`;
    host.insertBefore(this.el, document.getElementById('ui')); // under menus, over the HUD
    this.fadeEl = this.el.querySelector('.cine-fade')!;
    this.flashEl = this.el.querySelector('.cine-flash')!;
    this.capEl = this.el.querySelector('.cine-cap')!;
    this.tagEl = this.el.querySelector('.cine-tag')!;
    this.goalEl = this.el.querySelector('.cine-goal')!;
    this.skipEl = this.el.querySelector('.cine-skip')!;
  }

  get active() { return this.mode !== 'none'; }

  /** A new session: forget recorded play. */
  reset() {
    this.end(false);
    this.rec.clear();
    this.book.clear();
    this.goalAt = null;
    this.fadeIn = 0;
    this.fadeEl.style.opacity = '0';
  }

  startIntro(tunnel: TunnelInfo, caption: string, ceremony = false) {
    this.tunnel = tunnel;
    this.ceremony = ceremony;
    this.flashes = 0;
    this.mode = 'intro';
    this.t = 0;
    this.cheered = false;
    this.capEl.innerHTML = caption;
    this.el.className = 'cine on intro';
    this.onChange('intro');
  }

  /** A goal was scored live: show it again shortly (if replays are on). */
  goal(e?: { player?: number; team?: number; text?: string }) {
    this.goalAt = this.clock;
    this.celebDone = false;
    this.goalBy = e && e.team !== undefined ? { player: e.player ?? -1, team: e.team, og: e.text === 'og' } : null;
  }

  /** The celebration playing now and how far in (tests). */
  get celebration(): CelebPlan | null { return this.celeb?.plan ?? null; }
  get celebT(): number { return this.celeb?.t ?? 0; }
  /** Seconds into the cinematic playing now (tests). */
  get time(): number { return this.t; }

  /** A kick in live play (for offside checks). */
  kick(team: number, live: ViewState) {
    // The moment itself is kept (one snapshot a kick): the recorder may not have caught this frame yet.
    if (team === 0 || team === 1) this.kicks[team] = { at: this.clock, snap: snapOf(live, this.clock) };
  }

  /**
   * Offside given: freeze the moment of the pass and work out the lines. They go up on the big
   * screens; offline, the check is also shown full screen a moment later.
   */
  offside(live: ViewState, player: number, team: number, r: GameRenderer) {
    const k = this.kicks[team as 0 | 1];
    if (!k || this.clock - k.at > VAR.recent) return;
    const snap = k.snap;
    const info = varInfo(snap, player, team, live.attackDir[team as 0 | 1], (id) => live.players[id]?.team ?? (id < 11 ? 0 : 1));
    if (!info) return;
    if (this.varScreens) r.showVarCheck(info);
    this.varPending = { info, at: this.clock };
  }

  /** The offside check playing now (tests). */
  get varCheck(): VarInfo | null { return this.varPlay?.info ?? null; }

  /** A big moment happened in live play: keep it for the highlights. */
  moment(m: MomentInfo) {
    this.book.add(m, this.clock);
  }

  /** A break in play (half-time or full time): cut every moment still waiting for its last seconds. */
  flushMoments() {
    this.book.capture(this.rec, this.clock, true);
  }

  /** Play a highlights reel (false if there is nothing to show). */
  startHighlights(list: Highlight[]): boolean {
    if (this.active || !list.length) return false;
    this.reel = { list, i: 0, net: false, t: 0, look: new THREE.Vector3(), cued: false, snapped: false };
    this.mode = 'highlights';
    this.t = 0;
    this.el.className = 'cine on replay highlights';
    this.tagEl.querySelector('span')!.textContent = 'HIGHLIGHTS';
    this.goalEl.classList.remove('show');
    this.onChange('highlights');
    return true;
  }

  /**
   * The trophy ceremony (a cup or league won): the winners gather behind the trophy, the captain
   * lifts it, confetti and fireworks. Caption: what was won.
   */
  startTrophy(live: ViewState, r: GameRenderer, team: 0 | 1, caption: string): boolean {
    if (this.active) return false;
    const captain = r.captainOf(live, team);
    this.trophy = { team, captain, t: 0, lifted: false, bangs: 0, r };
    this.mode = 'trophy';
    this.t = 0;
    this.capEl.innerHTML = caption;
    this.el.className = 'cine on trophy';
    this.goalEl.classList.remove('show');
    r.startCeremony(team, captain);
    // Applause while they gather, then arms up, fist pumps and the captain's lift.
    const rr = r.reactions;
    rr.reset();
    let k = 0;
    for (const p of live.players) {
      if (p.team !== team || p.off) continue;
      const j = (k++ * 0.37) % 1;
      if (p.id === captain) { rr.add(p.id, 'clap', TROPHY.lift - 0.3, 0.2); rr.add(p.id, 'lift', TROPHY.length - TROPHY.lift + 1, TROPHY.lift - 0.1); continue; }
      rr.add(p.id, 'clap', TROPHY.lift - 0.2, 0.1 + j * 0.5);
      rr.add(p.id, 'armsUp', 3.2, TROPHY.lift + 0.15 + j * 0.3);
      rr.add(p.id, j < 0.5 ? 'fistPump' : 'clap', 3, TROPHY.lift + 3.4 + j * 0.4);
      rr.add(p.id, 'armsUp', TROPHY.length, TROPHY.lift + 6.6 + j * 0.4);
    }
    this.onChange('trophy');
    return true;
  }

  private startVar(live: ViewState, info: VarInfo, r: GameRenderer): boolean {
    if (this.active) return false;
    const e = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const name = live.players[info.attacker]?.def.short ?? '';
    this.varPlay = { info, r, name };
    this.mode = 'var';
    this.t = 0;
    this.capEl.innerHTML = `<b>Offside</b><span>${info.margin < 0.05 ? 'level' : `+${info.margin.toFixed(2)} m`}</span><b>${e(name)}</b><small>VAR check · ${e(live.teams[info.team]?.name ?? '')}</small>`;
    this.tagEl.querySelector('span')!.textContent = 'VAR CHECK';
    this.el.className = 'cine on replay var';
    this.goalEl.classList.remove('show');
    this.onChange('var');
    return true;
  }

  private varFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const vp = this.varPlay!;
    const t = this.t;
    if (t >= VAR.length) { this.end(true); r.cine = null; return null; }
    const edge = Math.min(t / VAR.fade, (VAR.length - t) / VAR.fade, 1);
    this.fadeEl.style.opacity = String(1 - Math.max(0, edge));
    this.capEl.classList.toggle('show', t > VAR.verdict && t < VAR.length - 0.3);
    r.varLines.show(vp.info, (t - VAR.draw) / 0.6);
    r.setTunnelShot(false);
    r.cine = varShot(vp.info, t);
    // Frozen at the pass (a hair of time, not zero: some body solvers blow up on dt = 0).
    return { view: stageReplay(live, vp.info.snap), dt: 1e-4 };
  }

  /** Half-time: the blimp's view of the ground, then a drone into the bowl (render/blimp.ts). */
  startAerial(r: GameRenderer, caption: string): boolean {
    if (this.active) return false;
    this.mode = 'aerial';
    this.t = 0;
    void r;
    this.capEl.innerHTML = caption;
    this.el.className = 'cine on aerial';
    this.goalEl.classList.remove('show');
    this.onChange('aerial');
    return true;
  }

  private aerialFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const t = this.t;
    if (t >= AERIAL_LENGTH) { this.end(true); r.cine = null; return null; }
    let f = t < AERIAL.fade ? 1 - t / AERIAL.fade : 0;
    for (const c of [AERIAL.blimp, AERIAL_LENGTH]) { const d = Math.abs(t - c); if (d < AERIAL.fade) f = Math.max(f, 1 - d / AERIAL.fade); }
    this.fadeEl.style.opacity = String(Math.min(1, f));
    this.capEl.classList.toggle('show', t > 0.6 && t < AERIAL.blimp - 0.4);
    r.setTunnelShot(false);
    r.cine = aerialShot(t, r.blimp?.position ?? null, r.roofTop);
    return { view: live, dt };
  }

  skip() {
    if (this.active && this.mode !== 'instant') this.end(true);
  }

  /** Is there enough recorded play for an instant replay? */
  get canInstant() { return this.mode === 'none' && this.rec.last - this.rec.first > 2; }

  /** Instant replay: the last few seconds of play, with play/pause, rewind, slow motion and cameras. */
  startInstant(): boolean {
    if (!this.canInstant) return false;
    this.instant = { t: Math.max(this.rec.first, this.rec.last - INSTANT.start), playing: true, speed: 1, cam: 0, look: new THREE.Vector3(), pos: new THREE.Vector3() };
    this.mode = 'instant';
    this.t = 0;
    this.el.className = 'cine on instant';
    this.onChange('instant');
    return true;
  }

  instantControl(cmd: InstantCmd) {
    const ip = this.instant;
    if (!ip) return;
    if (cmd === 'play') {
      if (!ip.playing && ip.t >= this.rec.last - 0.05) ip.t = Math.max(this.rec.first, this.rec.last - INSTANT.start); // from the top again
      ip.playing = !ip.playing;
    } else if (cmd === 'back') ip.t = Math.max(this.rec.first, ip.t - INSTANT.step);
    else if (cmd === 'forward') ip.t = Math.min(this.rec.last, ip.t + INSTANT.step);
    else if (cmd === 'slow') ip.speed = INSTANT.speeds[(INSTANT.speeds.indexOf(ip.speed as 1) + 1) % INSTANT.speeds.length];
    else if (cmd === 'camera') { ip.cam = (ip.cam + 1) % INSTANT.cams.length; ip.look.set(0, 0, 0); ip.pos.set(0, 0, 0); }
  }

  /** Leave the instant replay (back to the pause menu). */
  stopInstant() {
    if (this.mode === 'instant') this.end(false);
  }

  private end(fade: boolean) {
    if (!this.active) return;
    this.mode = 'none';
    this.replay = null;
    this.instant = null;
    this.reel = null;
    if (this.trophy) { this.trophy.r.stopCeremony(); this.trophy.r.reactions.reset(); this.trophy = null; }
    if (this.celeb) { this.celeb.r.cineReactions = false; this.celeb = null; }
    if (this.varPlay) { this.varPlay.r.varLines.show(null); this.varPlay = null; this.tagEl.querySelector('span')!.textContent = 'REPLAY'; }
    if (this.introR) { this.introR.cineReactions = false; this.introR.mascotMode = null; this.introR.officialStage = null; this.introR.reactions.reset(); this.introR = null; }
    this.flashEl.style.opacity = '0';
    this.el.className = 'cine';
    this.capEl.classList.remove('show');
    this.tagEl.querySelector('span')!.textContent = 'REPLAY';
    this.fadeIn = fade ? INTRO.fade : 0;
    this.onChange('none');
  }

  /**
   * Called every frame with the live view. Returns the view to draw for the cinematic and
   * sets the renderer's camera; returns null when no cinematic is playing (draw the live view).
   * `allowReplay` is false online, in practice, in shoot-outs or when replays are off.
   */
  frame(live: ViewState, dt: number, r: GameRenderer, allowReplay: boolean): { view: ViewState; dt: number } | null {
    if (this.mode === 'none') {
      // Only record while the match moves (not while it is paused behind a menu).
      const key = `${live.clock}|${live.ball.pos.x}|${live.ball.pos.y}|${live.ball.pos.z}|${live.players[0]?.pos.x}|${live.players[12]?.pos.z}`;
      const moving = key !== this.lastKey;
      this.lastKey = key;
      if (moving) {
        this.clock += dt;
        this.rec.push(live, this.clock);
        this.book.capture(this.rec, this.clock);
      }
      if (this.fadeIn > 0) this.fadeIn = Math.max(0, this.fadeIn - dt);
      this.fadeEl.style.opacity = String(this.fadeIn / INTRO.fade);
      r.cine = null;
      r.setTunnelShot(false);
      if (this.varPending && this.clock >= this.varPending.at + VAR.wait) {
        const vp = this.varPending;
        this.varPending = null;
        if (this.varChecks && this.startVar(live, vp.info, r)) return this.frame(live, 0, r, allowReplay);
      }
      if (this.goalAt !== null && this.celebrate && !this.celebDone && this.clock >= this.goalAt + CELEB.delay && !live.shootout) {
        this.celebDone = true;
        if (this.startCelebration(live, r, allowReplay)) return this.frame(live, 0, r, allowReplay);
      }
      if (this.goalAt !== null && this.clock >= this.goalAt + REPLAY.delay) {
        const tg = this.goalAt;
        this.goalAt = null;
        if (allowReplay) this.startReplay(tg);
      }
      if (this.mode === 'none') return null;
    }
    this.t += dt;
    r.lightsOn = this.mode === 'intro' ? introLights(this.t) : 1;
    if (this.mode === 'intro') {
      // After the walk-out: the line-up, the handshakes and the team photos.
      if (this.ceremony && this.t >= INTRO_LENGTH) return this.ceremonyFrame(live, dt, r);
      if (this.ceremony) {
        // Mascots hand in hand with the players on the walk-out.
        this.introR = r;
        r.cineReactions = this.t >= INTRO.fly;
        r.mascotMode = this.t >= INTRO.fly ? 'hand' : null;
      }
      const f = introFrame(this.t, this.tunnel, this.ceremony);
      if (f.stage === 'done') { this.end(true); r.cine = null; r.setTunnelShot(false); return null; }
      // The referee and his assistants lead the teams out.
      this.introR = r;
      r.officialStage = f.stage === 'tunnel' ? { mode: 'tunnel', walk: f.walk, tunnel: this.tunnel } : { mode: 'hidden' };
      this.fadeEl.style.opacity = String(f.fade);
      this.capEl.classList.toggle('show', f.stage === 'fly' && this.t > 0.8 && this.t < INTRO.fly - 0.6);
      if (f.stage === 'tunnel' && !this.cheered && f.walk > 2.2) { this.cheered = true; this.onCue('walkout'); }
      r.setTunnelShot(f.stage === 'tunnel');
      r.cine = f.shot;
      return { view: stageIntro(live, f, this.tunnel), dt };
    }
    if (this.mode === 'instant') return this.instantFrame(live, dt, r);
    if (this.mode === 'highlights') return this.reelFrame(live, dt, r);
    if (this.mode === 'trophy') return this.trophyFrame(live, dt, r);
    if (this.mode === 'celebration') return this.celebFrame(live, dt, r);
    if (this.mode === 'aerial') return this.aerialFrame(live, dt, r);
    if (this.mode === 'var') return this.varFrame(live, dt, r);
    // Replay: slow motion through the recorded moment, from inside the goal.
    const rp = this.replay!;
    const rt = rp.t0 + this.t * REPLAY.speed;
    if (rt >= rp.t1) { this.end(true); r.cine = null; return null; }
    const s = this.rec.at(rt)!;
    const edge = Math.min(this.t / 0.35, (rp.t1 - rt) / (0.35 * REPLAY.speed), 1);
    this.fadeEl.style.opacity = String(1 - Math.max(0, edge));
    if (!rp.shown && rt >= rp.tg) { rp.shown = true; this.goalEl.classList.add('show'); }
    r.setTunnelShot(false);
    r.cine = netCamShot(rp.side, rp.z, s.ball.pos, rp.look, dt);
    return { view: stageReplay(live, s), dt: dt * REPLAY.speed };
  }

  /** The pre-match ceremony, `this.t - INTRO_LENGTH` seconds in (render/prematch.ts). */
  private ceremonyFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const s = this.t - INTRO_LENGTH;
    if (s >= PREMATCH_LENGTH) { this.end(true); r.cine = null; r.setTunnelShot(false); return null; }
    this.introR = r;
    r.setTunnelShot(false);
    r.cineReactions = true;
    const st = preStage(s);
    r.mascotMode = st.stage === 'line' ? 'front' : null;
    // The officials stand between the teams in the line-up, then wait by the centre circle.
    r.officialStage = st.stage === 'huddle' ? { mode: 'line', z: -1.2 } : st.stage === 'photo' ? { mode: 'hidden' } : { mode: 'line', z: PREMATCH.rowZ };
    // Through black at each cut.
    let f = s < INTRO.fade ? 1 - s / INTRO.fade : 0;
    for (const c of [...PREMATCH_CUTS, PREMATCH_LENGTH]) { const d = Math.abs(s - c); if (d < INTRO.fade) f = Math.max(f, 1 - d / INTRO.fade); }
    this.fadeEl.style.opacity = String(Math.min(1, f));
    this.capEl.classList.remove('show');
    // Photographers' flashes.
    let flash = 0;
    if (st.stage === 'photo') {
      for (const ft of PHOTO_FLASHES) { const d = st.t - ft; if (d >= 0 && d < 0.18) flash = Math.max(flash, 1 - d / 0.18); }
      const due = PHOTO_FLASHES.filter((ft) => st.t >= ft).length;
      for (; this.flashes < due; this.flashes++) this.onCue('flash');
    }
    this.flashEl.style.opacity = String(flash * 0.75);
    const view = stagePrematch(live, s);
    prematchPoses(view, s, r.reactions);
    r.cine = prematchShot(s);
    return { view, dt };
  }

  /** The net-cam replay of the goal scored at recorder time tg (false if too little was recorded). */
  private startReplay(tg: number): boolean {
    const g = this.rec.at(tg);
    if (!g || this.rec.first >= tg - 1) return false;
    const { side, z } = goalSideOf(g.ball.pos);
    this.replay = { t0: Math.max(this.rec.first, tg - REPLAY.before), t1: Math.min(this.rec.last, tg + REPLAY.after), tg, side, z, look: new THREE.Vector3(), shown: false };
    this.mode = 'replay';
    this.t = 0;
    this.el.className = 'cine on replay';
    this.goalEl.classList.remove('show');
    this.onChange('replay');
    return true;
  }

  /** The scorer's celebration (render/celebration.ts); the replay follows straight after when allowed. */
  private startCelebration(live: ViewState, r: GameRenderer, replayAfter: boolean): boolean {
    const by = this.goalBy;
    if (!by || by.team < 0) return false;
    const team = by.team as 0 | 1;
    let scorer = by.player;
    if (by.og || scorer < 0 || live.players[scorer]?.team !== team || live.players[scorer]?.off) {
      // An own goal: the nearest of the side that scored celebrates.
      const b = live.ball.pos;
      const mine = live.players.filter((p) => p.team === team && !p.off && p.role !== 'GK');
      mine.sort((a, c) => Math.hypot(a.pos.x - b.x, a.pos.z - b.z) - Math.hypot(c.pos.x - b.x, c.pos.z - b.z));
      if (!mine.length) return false;
      scorer = mine[0].id;
    }
    const kind = this.nextCeleb ?? celebKindFor(scorer, live.score[0] + live.score[1]);
    this.nextCeleb = null;
    const plan = planCelebration(live, scorer, team, kind);
    this.celeb = { plan, t: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), r, replay: replayAfter };
    r.cineReactions = true;
    celebrationReactions(plan, r.reactions);
    r.handheld.reset();
    this.mode = 'celebration';
    this.t = 0;
    this.el.className = 'cine on celebration';
    this.goalEl.classList.remove('show');
    this.onChange('celebration');
    return true;
  }

  private celebFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const c = this.celeb!;
    c.t += dt;
    if (c.t >= CELEB.length) {
      // Straight into the replay (the match stays paused), or back to the match.
      const tg = this.goalAt;
      r.cineReactions = false;
      this.celeb = null;
      if (c.replay && tg !== null) {
        this.goalAt = null;
        if (this.startReplay(tg)) return this.frame(live, 0, r, true);
      }
      this.end(true);
      r.cine = null;
      return null;
    }
    const edge = Math.min(c.t / CELEB.fade, (CELEB.length - c.t) / CELEB.fade, 1);
    this.fadeEl.style.opacity = String(1 - Math.max(0, edge));
    const view = stageCelebration(live, c.plan, c.t);
    r.setTunnelShot(false);
    r.cine = r.handheldShot(celebrationShot(c.plan, c.t, view, c, dt), dt);
    return { view, dt };
  }

  /**
   * Highlights: each clip plays at normal speed from the match camera, with a caption; a goal
   * is then shown again in slow motion from inside the net. Clips cut through black.
   */
  private reelFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const rl = this.reel!;
    rl.t += dt;
    let h = rl.list[rl.i];
    const t0 = rl.net ? Math.max(h.clip.first, h.t - REEL.netBefore) : h.clip.first;
    const t1 = rl.net ? Math.min(h.clip.last, h.t + REEL.netAfter) : h.clip.last;
    const speed = rl.net ? REEL.netSpeed : 1;
    const rt = t0 + rl.t * speed;
    if (rt >= t1) {
      // Next: the goal from the net, or the next clip.
      if (!rl.net && h.kind === 'goal' && h.clip.last - h.clip.first > 1) rl.net = true;
      else { rl.net = false; rl.i++; }
      rl.t = 0; rl.cued = false; rl.snapped = false; rl.look.set(0, 0, 0);
      this.goalEl.classList.remove('show');
      if (rl.i >= rl.list.length) { this.end(true); r.cine = null; return null; }
      h = rl.list[rl.i];
      return this.reelFrame(live, 0, r);
    }
    const s = h.clip.at(rt)!;
    const view = stageReplay(live, s);
    if (!rl.snapped) { rl.snapped = true; r.snapCamera(view); }
    // Through black at each cut.
    const left = (t1 - rt) / speed;
    const edge = Math.min(rl.t / REEL.fade, left / REEL.fade, 1);
    this.fadeEl.style.opacity = String(1 - Math.max(0, edge));
    // Caption at the start of each clip (not the net-cam repeat).
    const cap = !rl.net && rl.t > 0.25 && rl.t < REEL.caption;
    if (cap && !this.capEl.classList.contains('show')) {
      const e = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      this.capEl.innerHTML = `<b>${e(h.minute)}</b><span>${MOMENT_TITLE[h.kind]}</span><b>${e(h.who)}</b><small>${e(live.teams[h.team]?.name ?? '')} · ${rl.i + 1} of ${rl.list.length}</small>`;
    }
    this.capEl.classList.toggle('show', cap);
    if (!rl.net && !rl.cued && rt >= h.t) {
      rl.cued = true;
      if (h.kind === 'goal') this.goalEl.classList.add('show');
      this.onCue(h.kind === 'goal' ? 'goal' : 'chance');
    }
    r.setTunnelShot(false);
    if (rl.net) {
      const g = goalSideOf(h.clip.at(h.t)!.ball.pos);
      r.cine = netCamShot(g.side, g.z, s.ball.pos, rl.look, dt);
    } else r.cine = null;
    return { view, dt: dt * speed };
  }

  /** The trophy ceremony, frame by frame (render/ceremony.ts has the staging and the camera). */
  private trophyFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } | null {
    const tr = this.trophy!;
    tr.t += dt;
    if (tr.t >= TROPHY.length) { this.end(true); r.cine = null; return null; }
    const edge = Math.min(tr.t / TROPHY.fade, (TROPHY.length - tr.t) / TROPHY.fade, 1);
    this.fadeEl.style.opacity = String(1 - Math.max(0, edge));
    this.capEl.classList.toggle('show', tr.t > 0.8 && tr.t < TROPHY.lift - 0.2 || tr.t > TROPHY.crane + 0.5 && tr.t < TROPHY.length - 1.2);
    const lk = Math.min(1, Math.max(0, (tr.t - TROPHY.lift) / TROPHY.liftDur));
    r.trophyLift(lk * lk * (3 - 2 * lk));
    if (!tr.lifted && tr.t >= TROPHY.lift) { tr.lifted = true; r.ceremony?.celebrate(); this.onCue('trophy'); }
    const launched = r.ceremony?.launched ?? 0;
    for (; tr.bangs < launched; tr.bangs++) this.onCue('firework');
    r.setTunnelShot(false);
    r.cine = trophyShot(tr.t);
    return { view: stageTrophy(live, tr.team, tr.captain), dt };
  }

  /** Instant replay: step through the recording at the chosen speed, from the chosen camera. */
  private instantFrame(live: ViewState, dt: number, r: GameRenderer): { view: ViewState; dt: number } {
    const ip = this.instant!;
    if (ip.playing) {
      ip.t += dt * ip.speed;
      if (ip.t >= this.rec.last) { ip.t = this.rec.last; ip.playing = false; }
    }
    const s = this.rec.at(ip.t)!;
    this.fadeEl.style.opacity = '0';
    r.setTunnelShot(false);
    r.cine = instantShot(ip.cam, s.ball.pos, ip.look, ip.pos, dt);
    this.onInstant({ t: ip.t, first: this.rec.first, last: this.rec.last, playing: ip.playing, speed: ip.speed, cam: INSTANT.cams[ip.cam] });
    return { view: stageReplay(live, s), dt: ip.playing ? dt * ip.speed : 0 };
  }
}


/** Camera for an instant replay: null keeps the match camera; otherwise net cam, a low ball cam or a high view. */
function instantShot(cam: number, ball: { x: number; y: number; z: number }, look: THREE.Vector3, pos: THREE.Vector3, dt: number) {
  if (cam === 0) return null;
  if (cam === 1) { const g = goalSideOf(ball); return netCamShot(g.side, ball.z, ball, look, dt); }
  const side = ball.x >= 0 ? 1 : -1; // the goal the play is nearest
  const want = cam === 2
    ? new THREE.Vector3(ball.x - side * 11, 3.2, ball.z * 0.85 + (ball.z >= 0 ? -5 : 5))
    : new THREE.Vector3(ball.x * 0.85, 34, ball.z + 26);
  const target = new THREE.Vector3(ball.x, Math.max(0.3, Math.min(ball.y, 4)), ball.z);
  const k = 1 - Math.exp(-dt * 4);
  if (pos.lengthSq() === 0) { pos.copy(want); look.copy(target); } else { pos.lerp(want, k); look.lerp(target, Math.min(1, k * 1.6)); }
  return { pos: { x: pos.x, y: pos.y, z: pos.z }, look: { x: look.x, y: look.y, z: look.z }, fov: cam === 2 ? 48 : 40, near: 0.1 };
}

/** Floodlights coming on bank by bank during the stadium fly-in: 0 (off) .. 1 (all on). */
export function introCaption(home: string, away: string, ground = 'The Harbourside Ground') {
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<b>${esc(home)}</b><span>v</span><b>${esc(away)}</b><small>${esc(ground)}</small>`;
}

export { INTRO_LENGTH };
