// In-match HUD: score bug, clock, controlled player, stamina, shot power,
// radar, connection status, banners, restart hints and the control guide.

import { GAME_PLAN_NAMES, PITCH, type GamePlan } from '../../shared/config';
import { windText } from '../../shared/weather';
import { clockText, minuteText } from '../../shared/snapshot';
import { ROUTINES } from '../../shared/ai/team';
import type { MatchEvent } from '../../shared/types';
import { footProfile } from '../../shared/teams';
import { PEN_TECH_NAMES, favouriteSide, matchPressureView, setPieceRatings, type PenTech } from '../../shared/setpieces';
import type { PlayerDef } from '../../shared/teams';
import type { ViewState } from '../view';
import { MOMENTUM } from '../../shared/momentum';

/** Calls handled by Hud.g6Call (any team). */
const G6_CALLS = new Set(['crowd', 'tactical', 'trapped', 'deflection', 'hold', 'muscle', 'aerial', 'scramble', 'heavy', 'beat', 'turned']);
import { possessionTeam } from '../view';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const RESTART_NAMES: Record<string, string> = { throwin: 'Throw-in', goalkick: 'Goal kick', corner: 'Corner', freekick: 'Free kick', penalty: 'Penalty', kickoff: 'Kick-off', dropball: 'Dropped ball' };

export interface HudInfo {
  localTeams: number[];
  charge: number; // -1 not charging
  chargeLabel?: string; // what the held button will play (PASS, CHIP, ...)
  ringAt?: { x: number; y: number; visible: boolean; q: number } | null; // set-piece timing ring (q 0 = perfect)
  powerAt: { x: number; y: number; visible: boolean } | null;
  chargeTicks?: boolean; // pass charge picks near/middle/far teammates: show the bands
  conn: { show: boolean; state: string; latency: number; colour: string } | null;
  guide: string;
  debug: string | null;
  /** The frame-rate readout (Settings > Graphics > Frame rate), or null when it is off. */
  fps?: string | null;
  /** Local multiplayer: the other players' kick charges (null: not charging). */
  extraPower?: ({ x: number; y: number; visible: boolean; charge: number; label: string } | null)[];
  /** Your player is off the screen: an arrow at the edge pointing to him, with his shirt number (20 Nov 2026). */
  edge?: { x: number; y: number; angle: number; label: string } | null;
}

export class Hud {
  el: HTMLElement;
  private bug: HTMLDivElement;
  private pcard: HTMLDivElement;
  private power: HTMLDivElement;
  private tring: HTMLDivElement;
  private edgeEl!: HTMLDivElement;
  private extraBars: HTMLDivElement[] = [];
  private localSet = new Set<number>([0]);
  /** Momentum meter under the score bug. */
  private mom: HTMLDivElement;
  private momKey = '';
  /** Score bug size, re-read only when it changes (reading it every frame forced a page layout each frame). */
  private bugBox = '';
  private momW = '';
  /** The players people control right now (for battle calls). */
  private ctlIds = new Set<number>();
  private radar: HTMLCanvasElement;
  private conn: HTMLDivElement;
  private banner: HTMLDivElement;
  private hint: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private debugEl: HTMLDivElement;
  private fpsEl!: HTMLDivElement;
  private fpsText: string | null = null;
  private guideEl: HTMLDivElement;
  private bannerTimer = 0;
  private toastTimer = 0;
  private lastBug = '';
  private lastCard = '';

  constructor(root: HTMLElement) {
    this.el = root;
    root.innerHTML = `
      <div class="scorebug"></div>
      <div class="mom" title="Momentum"><i class="h"></i><i class="a"></i><b></b></div>
      <div class="pcard"><div class="nm"></div><div class="stam"><i></i></div></div>
      <div class="power"><i></i><b></b></div>
      <div class="tring"><i></i></div>
      <div class="edgearrow"><i></i><b></b></div>
      <canvas class="radar" width="210" height="136"></canvas>
      <div class="conn"><span class="dot"></span><span class="txt"></span></div>
      <div class="banner"><div class="big"></div><div class="sub"></div></div>
      <div class="hint"></div>
      <div class="toast"></div>
      <div class="debug"></div>
      <div class="fpsbox"></div>
      <div class="guide"></div>`;
    this.bug = root.querySelector('.scorebug')!;
    this.mom = root.querySelector('.mom')!;
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.bugBox = ''; }).observe(this.bug);
    this.pcard = root.querySelector('.pcard')!;
    this.power = root.querySelector('.power')!;
    this.tring = root.querySelector('.tring')!;
    this.edgeEl = root.querySelector('.edgearrow')!;
    this.radar = root.querySelector('.radar')!;
    this.conn = root.querySelector('.conn')!;
    this.banner = root.querySelector('.banner')!;
    this.hint = root.querySelector('.hint')!;
    this.toastEl = root.querySelector('.toast')!;
    this.debugEl = root.querySelector('.debug')!;
    this.fpsEl = root.querySelector('.fpsbox')!;
    this.guideEl = root.querySelector('.guide')!;
    this.show(false);
  }

  show(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
  }

  private practice: string | null = null;
  /** Flash a caption for routine restarts (throw-ins, goal kicks, corners, free kicks). Penalties always show. */
  restartCaptions = false;
  /** Practice mode: the clock in the score bug becomes the drill's name. */
  private challenge = 0;
  setPractice(drill: 'free' | 'freekick' | 'penalty' | 'crosses' | 'crossbar' | 'targets' | 'control' | null | undefined, challenge = 0) {
    this.practice = drill ? { free: 'PRACTICE', freekick: 'FREE KICKS', penalty: 'PENALTIES', crosses: 'CROSSES', crossbar: 'CROSSBAR', targets: 'TARGETS', control: 'BALL CONTROL' }[drill] : null;
    this.challenge = drill && drill !== 'control' ? challenge : 0;
    this.lastBug = '';
  }
  /** The match clock, or the penalty count during a shootout. */
  private clockFor(v: ViewState) {
    if (!v.shootout) return clockText(v.clock, v.half);
    const [a, b] = v.shootout.kicks;
    return `${a.filter(Boolean).length} – ${b.filter(Boolean).length}`;
  }
  /** The practice label, with the attempt count in a challenge. */
  private practiceText(v: ViewState) {
    if (!this.practice) return null;
    // Ball control drill: the time left.
    if (v.skill?.timeLeft !== undefined) { const s = Math.ceil(v.skill.timeLeft); return `${this.practice} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    return this.challenge ? `${this.practice} ${Math.min(v.attempts, this.challenge)}/${this.challenge}` : this.practice;
  }

  setHighContrast(v: boolean) {
    this.el.classList.toggle('hc', v);
  }

  /** Fourth official's board: minutes of added time. */
  board(min: number) {
    const el = document.createElement('div');
    el.className = 'board4';
    el.innerHTML = `<span>+${min}</span><small>added time</small>`;
    this.el.appendChild(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3800);
  }

  toast(msg: string, ms = 2500) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  flash(big: string, sub: string, kind = '', ms = 2200) {
    this.banner.className = `banner show ${kind}`;
    (this.banner.querySelector('.big') as HTMLElement).textContent = big;
    const s = this.banner.querySelector('.sub') as HTMLElement;
    s.textContent = sub;
    s.style.display = sub ? 'inline-block' : 'none';
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  /**
   * The 19 Nov 2026 gameplay calls: crowd lift, tactical fouls, the offside trap springing,
   * deflections, and physical battles your own player wins or loses (scrambles stay unannounced).
   */
  /** The taker's set-piece rating, composure and the pressure on him, for the restart hint. */
  private takerLine(v: ViewState, taker: number, kind: 'pen' | 'fk'): string {
    const p = v.players[taker];
    if (!p) return kind === 'pen' ? 'Penalty' : 'Free kick';
    const rt = setPieceRatings(p.def);
    const pr = matchPressureView({ ...v, practice: this.practice }, p.team);
    return `${kind === 'pen' ? 'Penalty' : 'Free kick'} · ${p.def.short} ${kind === 'pen' ? 'PEN' : 'FK'} ${kind === 'pen' ? rt.pen : rt.fk} · nerve ${rt.comp}${pr >= 0.55 ? ' · big pressure' : pr >= 0.45 ? ' · under pressure' : ''}`;
  }

  private g6Call(view: ViewState, e: MatchEvent, tm: string) {
    const p = e.player !== undefined && e.player >= 0 ? view.players[e.player] : null;
    const who = p ? `#${p.def.number} ${p.def.short}` : '';
    const mine = e.team !== undefined && this.localSet.has(e.team);
    switch (e.text) {
      case 'crowd': this.toast(`The ${view.teams[0].abbr} crowd is lifting their side`, 2200); break;
      case 'tactical': this.toast(`Tactical foul${who ? `: ${who}` : ''} stops the break`, 1800); break;
      case 'trapped': this.toast(`Caught by the ${tm} offside trap`, 1800); break;
      case 'deflection': this.toast('Deflected!', 1100); break;
      case 'hold': if (mine && this.ctlIds.has(e.player ?? -1)) this.toast(`${who} holds them off`, 1000); break;
      case 'muscle': if (!mine && this.ctlIds.has(e.power ?? -1)) this.toast(`${who} muscles you off the ball`, 1000); break;
      case 'aerial': if (mine) this.toast(`${who} wins the header`, 1000); break;
      // Ball control (19 Nov 2026): only for your own player.
      case 'heavy': if (mine && this.ctlIds.has(e.player ?? -1)) this.toast('Heavy touch', 900); break;
      case 'beat': if (mine && this.ctlIds.has(e.player ?? -1)) this.toast('Left him for dead', 900); break;
      case 'turned': if (mine && this.ctlIds.has(e.player ?? -1)) this.toast('Turned him with the first touch', 1000); break;
      default: break;
    }
  }

  /**
   * Momentum meter: a thin bar under the score bug that grows from the middle towards the side
   * on top, in that side's colours, and glows while the home crowd is lifting the home side.
   */
  private momentumMeter(v: ViewState, c0: string, c1: string) {
    const mv = v.momentum;
    const show = mv !== undefined && !this.practice && (v.phase === 'play' || v.phase === 'restart' || v.phase === 'kickoff' || v.phase === 'goal');
    if (!show) { this.mom.style.display = 'none'; return; }
    if (this.mom.style.display !== 'block') { this.mom.style.display = 'block'; this.bugBox = ''; }
    if (!this.bugBox || typeof ResizeObserver === 'undefined') this.bugBox = `${this.bug.offsetWidth}|${this.bug.offsetHeight}|${this.bug.offsetTop}|${this.bug.offsetLeft}`;
    const key = `${c0}|${c1}|${this.bugBox}`;
    if (key !== this.momKey) {
      this.momKey = key;
      this.mom.style.top = `${this.bug.offsetTop + this.bug.offsetHeight + 3}px`;
      this.mom.style.left = `${this.bug.offsetLeft}px`;
      this.mom.style.width = `${this.bug.offsetWidth}px`;
      (this.mom.children[0] as HTMLElement).style.background = c0;
      (this.mom.children[1] as HTMLElement).style.background = c1;
    }
    const w = Math.round(Math.min(1, Math.abs(mv!)) * 50);
    const wk = `${mv! > 0 ? w : 0}|${mv! < 0 ? w : 0}|${mv! > MOMENTUM.liftFrom}`;
    if (wk === this.momW) return;
    this.momW = wk;
    (this.mom.children[0] as HTMLElement).style.width = `${mv! > 0 ? w : 0}%`;
    (this.mom.children[1] as HTMLElement).style.width = `${mv! < 0 ? w : 0}%`;
    this.mom.classList.toggle('lift', mv! > MOMENTUM.liftFrom);
  }

  /** Banner text for simulation events. */
  onEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      const tm = e.team !== undefined && e.team >= 0 ? view.teams[e.team].abbr : '';
      if (e.type === 'goal' && view.shootout) { /* shootout kicks are shown by the 'pen' event */ }
      else if (e.type === 'pen') {
        if (e.text === 'start') this.flash('PENALTIES', 'Five each, then sudden death', '', 2200);
        else {
          const so = view.shootout;
          const p = e.player !== undefined && e.player >= 0 ? view.players[e.player] : null;
          // How the shootout stands after this kick, and when it goes to sudden death.
          const k = so ? so.kicks : null;
          const tally = k ? `${k[0].filter(Boolean).length}-${k[1].filter(Boolean).length}` : '';
          const sudden = k && k[0].length === 5 && k[1].length === 5 && so!.winner < 0 ? ' · SUDDEN DEATH' : '';
          this.flash(e.text === 'scored' ? 'SCORED' : 'MISSED', `${tm}${p ? ` · ${p.def.short}` : ''}${tally ? ` · ${tally}` : ''}${sudden}`, e.text === 'scored' ? 'goal' : '', 1600);
        }
      } else if (e.type === 'goal') {
        const p = e.player !== undefined && e.player >= 0 ? view.players[e.player] : null;
        this.flash('GOAL!', `${tm} · ${p ? p.def.short : ''}${e.text === 'og' ? ' (own goal)' : ''} ${minuteText(view.clock, view.half)}`, 'goal', 2800);
      } else if (e.type === 'offside') this.flash('OFFSIDE', tm, '', 1600);
      else if (e.type === 'foul') this.flash('FOUL', tm, '', 1400);
      else if (e.type === 'advantage' && e.text === 'over') this.toast('Advantage over: play on', 1500);
      else if (e.type === 'advantage') this.flash('ADVANTAGE', tm ? `Play on · ${tm}` : 'Play on', 'adv', 1500);
      else if (e.type === 'switch' && e.text === 'keeper' && e.team !== undefined && this.localSet.has(e.team) && view.restart?.type === 'penalty') { /* the penalty hint explains it */ }
      else if (e.type === 'switch' && e.text === 'keeper' && e.team !== undefined && this.localSet.has(e.team)) this.toast('You have the keeper: SHOOT dives, PASS comes out. SKILL hands him back', 2600);
      else if (e.type === 'call' && e.text?.startsWith('pen:')) {
        // Penalty techniques everyone sees: a Panenka or a blast.
        const t = e.text.slice(4) as PenTech;
        if (t === 'panenka') this.toast('Panenka!', 1400);
        else if (t === 'blast' && e.team !== undefined && this.localSet.has(e.team)) this.toast('Blasted!', 900);
      }
      else if (e.type === 'call' && e.text === 'stutter' && e.team !== undefined && this.localSet.has(e.team)) this.toast(e.power ? 'Stutter run-up: ON (he checks, the keeper may go first)' : 'Stutter run-up: off', 1600);
      else if (e.type === 'call' && e.text === 'retake') this.flash('RETAKE', 'Keeper off his line too early', '', 2000);
      else if (e.type === 'call' && e.text === 'wallback') this.toast(e.power && e.power >= 2 ? 'The wall crept in again: booked' : 'Referee: the wall has crept in, back ten yards', 2000);
      else if (e.type === 'call' && e.text === 'knuckle') this.toast('Knuckleball!', 1100);
      else if (e.type === 'call' && e.text === 'lieblock') this.toast('Blocked by the man lying behind the wall', 1600);
      else if (e.type === 'call' && e.text === 'runup' && e.team !== undefined && this.localSet.has(e.team)) this.toast(`Run-up: ${['standard', 'long (more pace)', 'short (tidier)', 'straight on (less curl, more knuckle)'][e.power ?? 0]}`, 1600);
      else if (e.type === 'call' && e.text === 'lie' && e.team !== undefined && this.localSet.has(e.team)) this.toast(e.power ? 'A man lies down behind the wall' : 'Nobody lying behind the wall', 1400);
      else if (e.type === 'call' && e.text === 'dummy2') { /* seen on the pitch */ }
      else if (e.type === 'call' && e.text === 'habit' && e.team !== undefined && this.localSet.has(e.team)) this.toast(`Their keeper has seen your last ${e.power ?? 3} penalties go the same way`, 2600);
      else if (e.type === 'call' && (e.text === 'gkcommit' || e.text === 'check')) { /* seen on the pitch */ }
      else if (e.type === 'card') {
        const p = e.player !== undefined && e.player >= 0 ? view.players[e.player] : null;
        const who = `${tm} · #${p?.def.number ?? ''} ${p?.def.short ?? ''}`;
        if (e.text === 'yellow') this.flash('YELLOW CARD', who, 'yellow', 2000);
        else this.flash('RED CARD', `${who} · ${e.text === 'second' ? 'second yellow' : 'sent off'}`, 'red', 2600);
      }
      else if (e.type === 'restart' && e.text && e.text !== 'kickoff') {
        if (e.text === 'penalty') this.flash('PENALTY', tm, '', 2200);
        else if (this.restartCaptions) this.flash(RESTART_NAMES[e.text] ?? '', tm, '', 1300);
      } else if (e.type === 'kickoff') this.flash(view.half === 1 && view.clock < 1 ? 'KICK-OFF' : '', view.half === 2 && view.clock < 2700.5 ? 'Second half' : view.half === 3 && view.clock < 5400.5 ? 'Extra time' : '', '', 1200);
      else if (e.type === 'sub' && e.text) { const [o, n] = e.text.split('>'); this.toast(`Substitution${tm ? ` · ${tm}` : ''}: ${o} off, ${n} on`, 2600); }
      else if (e.type === 'addedtime') this.board(e.power ?? 1);
      else if (e.type === 'recovery') this.toast('Referee drops the ball');
      else if (e.type === 'call' && e.text && G6_CALLS.has(e.text)) this.g6Call(view, e, tm);
      else if ((e.type === 'call' || e.type === 'rush') && e.team !== undefined && this.localSet.has(e.team)) {
        const p = e.player !== undefined && e.player >= 0 ? view.players[e.player] : null;
        if (e.text?.startsWith('routine:')) {
          const kind = e.text.slice(8) as 'corner' | 'freekick' | 'throwin';
          this.toast(`${kind === 'corner' ? 'Corner' : kind === 'throwin' ? 'Throw-in' : 'Free kick'} routine: ${ROUTINES[kind]?.[e.power ?? 0] ?? ''}`, 1600);
        } else if (e.text?.startsWith('plan:')) {
          const pl = e.text.slice(5) as GamePlan;
          this.flash(GAME_PLAN_NAMES[pl] ?? '', 'Game plan', 'plan', 1400);
        } else if (e.text === 'wall') this.toast(`Wall: ${e.power ?? ''} men`, 1000);
        else if (e.text?.startsWith('link:')) {
          const q = e.power !== undefined && e.power >= 0 ? view.players[e.power] : null;
          const pair = `#${p?.def.number ?? ''} ${p?.def.short ?? ''} & #${q?.def.number ?? ''} ${q?.def.short ?? ''}`;
          this.toast(e.text === 'link:2' ? `Partnership: ${pair} have a great understanding` : `Partnership: ${pair} are linking up`, 2200);
        }
        else if (e.text === 'jump' || e.text === 'dive') { /* seen on the pitch */ }
        else this.toast(e.type === 'rush' ? 'Keeper rushes out' : e.text === 'press' ? 'Team press!' : e.text === 'trap' ? 'Offside trap: line steps up' : e.text === 'dummy' ? 'Dummy: let it run' : e.text === 'onetwo' ? `One-two: #${p?.def.number ?? ''} ${p?.def.short ?? ''} goes` : `#${p?.def.number ?? ''} ${p?.def.short ?? ''}: run in behind`, 1300);
      }
    }
  }

  update(v: ViewState, info: HudInfo) {
    // Score bug.
    const k0 = v.teams[0][v.kits[0]], k1 = v.teams[1][v.kits[1]];
    const half = this.practice ? '' : v.shootout && v.phase !== 'fulltime' ? 'PENS' : v.phase === 'halftime' ? (v.half === 2 ? 'FT' : 'HT') : v.phase === 'fulltime' ? (v.shootout ? 'PENS' : v.half > 2 ? 'AET' : 'FT') : ['1st', '2nd', 'ET1', 'ET2'][v.half - 1];
    // Red cards are shown next to the club as small red rectangles.
    const reds = [0, 1].map((t) => v.players.filter((p) => p.team === t && p.off && p.cards > 0).length);
    const rc = (n: number) => '<i class="rc"></i>'.repeat(n);
    const dots = (k: boolean[]) => k.map((x) => `<i class="pk ${x ? 'in' : 'out'}"></i>`).join('') + '<i class="pk"></i>'.repeat(Math.max(0, 5 - k.length));
    const so = v.shootout ? `<div class="pens"><span>${dots(v.shootout.kicks[0])}</span><span>${dots(v.shootout.kicks[1])}</span></div>` : '';
    const bug = `${v.teams[0].abbr}|${v.score[0]}|${v.score[1]}|${v.teams[1].abbr}|${this.practiceText(v) ?? this.clockFor(v)}|${half}|${reds.join(',')}|${so}`;
    if (bug !== this.lastBug) {
      this.lastBug = bug;
      this.bug.innerHTML = `<div class="tm"><i class="chip" style="background:${hex(k0.shirt)}"></i>${v.teams[0].abbr}${rc(reds[0])}</div><div class="sc">${v.score[0]} – ${v.score[1]}</div><div class="tm">${rc(reds[1])}${v.teams[1].abbr}<i class="chip" style="background:${hex(k1.shirt)}"></i></div><div class="clk">${this.practiceText(v) ?? this.clockFor(v)}<span class="half">${half}</span></div>${so}`;
      this.momKey = '';
    }
    this.momentumMeter(v, hex(k0.shirt), hex(k1.shirt));
    // Controlled player card.
    const lt = info.localTeams[0];
    this.localSet = new Set(info.localTeams);
    this.ctlIds = new Set(info.localTeams.map((t) => v.ctl[t]).filter((i) => i >= 0));
    if (lt !== undefined && v.humans[lt] && v.ctl[lt] >= 0) {
      const p = v.players[v.ctl[lt]];
      const plan = v.plans?.[lt] ?? 'balanced';
      const card = `${p.def.number}|${p.def.short}|${p.role}|${p.cards}|${plan}`;
      if (card !== this.lastCard) {
        this.lastCard = card;
        (this.pcard.querySelector('.nm') as HTMLElement).innerHTML = `#${p.def.number} ${p.def.short.toUpperCase()}<small>${p.role}</small>${footTag(p.def)}${p.cards === 1 ? '<i class="yc" title="Booked"></i>' : ''}${plan !== 'balanced' ? `<span class="plantag">${GAME_PLAN_NAMES[plan].toUpperCase()}</span>` : ''}`;
        this.pcard.style.borderLeftColor = lt === 0 || info.localTeams.length > 1 ? 'var(--p1)' : 'var(--p2)';
      }
      (this.pcard.querySelector('.stam i') as HTMLElement).style.width = `${Math.round(p.stamina * 100)}%`;
      this.pcard.style.display = 'block';
    } else this.pcard.style.display = 'none';
    // Shot power.
    if (info.charge >= 0 && info.powerAt && info.powerAt.visible) {
      this.power.style.display = 'block';
      this.power.classList.toggle('ticks', !!info.chargeTicks);
      this.power.style.left = `${info.powerAt.x}px`;
      this.power.style.top = `${info.powerAt.y}px`;
      (this.power.firstElementChild as HTMLElement).style.width = `${Math.round(info.charge * 100)}%`;
      const lb = this.power.querySelector('b') as HTMLElement;
      if (lb.textContent !== (info.chargeLabel ?? '')) lb.textContent = info.chargeLabel ?? '';
    } else this.power.style.display = 'none';
    const xs = info.extraPower ?? [];
    while (this.extraBars.length < xs.length) {
      const el = document.createElement('div');
      el.className = 'power extra';
      el.innerHTML = '<i></i><b></b>';
      this.el.appendChild(el);
      this.extraBars.push(el);
    }
    this.extraBars.forEach((el, i) => {
      const x = xs[i];
      if (!x || !x.visible) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      el.style.left = `${x.x}px`;
      el.style.top = `${x.y}px`;
      (el.firstElementChild as HTMLElement).style.width = `${Math.round(x.charge * 100)}%`;
      const lb = el.querySelector('b') as HTMLElement;
      if (lb.textContent !== x.label) lb.textContent = x.label;
    });
    // Connection.
    if (info.conn && info.conn.show) {
      this.conn.style.display = 'block';
      (this.conn.querySelector('.txt') as HTMLElement).textContent = info.conn.latency >= 0 ? `${info.conn.state} · ${Math.round(info.conn.latency)} ms` : info.conn.state;
      (this.conn.querySelector('.dot') as HTMLElement).style.background = info.conn.colour;
    } else this.conn.style.display = 'none';
    // Set-piece timing ring: strike when the outer ring closes on the inner one.
    const rg = info.ringAt;
    if (rg && rg.visible) {
      const size = 22 + 58 * rg.q;
      this.tring.style.display = 'block';
      this.tring.style.left = `${rg.x}px`;
      this.tring.style.top = `${rg.y}px`;
      const o = this.tring.firstElementChild as HTMLElement;
      o.style.width = o.style.height = `${size}px`;
      this.tring.classList.toggle('good', rg.q < 0.2);
    } else this.tring.style.display = 'none';
    // Your man off the screen: an arrow at the edge points to him.
    const ed = info.edge;
    if (ed) {
      this.edgeEl.style.display = 'block';
      this.edgeEl.style.left = `${ed.x}px`;
      this.edgeEl.style.top = `${ed.y}px`;
      (this.edgeEl.firstElementChild as HTMLElement).style.transform = `translate(-50%, -50%) rotate(${ed.angle}rad)`;
      const b = this.edgeEl.lastElementChild as HTMLElement;
      if (b.textContent !== ed.label) b.textContent = ed.label;
    } else if (this.edgeEl.style.display !== 'none') this.edgeEl.style.display = 'none';
    // Restart hint for a human taker.
    const r = v.restart;
    if (r && r.ready && lt !== undefined && r.team === lt && v.ctl[lt] === r.taker && v.humans[lt]) {
      this.hint.style.display = 'block';
      this.hint.textContent = r.type === 'kickoff' ? 'Kick-off: pass to start'
        : r.type === 'penalty' ? `${this.takerLine(v, r.taker, 'pen')}: aim, hold SHOOT and release as the ring closes · SKILL stutter${r.stutter ? ' (on)' : ''} · LOB+SHOOT Panenka · SWITCH+SHOOT side-foot · modifier+sprint blast`
        : r.type === 'corner' ? 'Corner: move the target, LOB to cross or PASS short'
        : r.type === 'freekick' ? (r.quick ? 'Quick free kick: pass, lob or shoot' : (Math.hypot(r.spot.x - PITCH.halfLength * v.attackDir[lt], r.spot.z) < 32 ? `${this.takerLine(v, r.taker, 'fk')} · ` : '') + (Math.abs(r.curve ?? 0) > 0.02 || (r.dip ?? 0) > 0.02 ? `Free kick: bend ${Math.round(Math.abs(r.curve ?? 0) * 100)}% ${(r.curve ?? 0) >= 0 ? 'right' : 'left'}, dip ${Math.round((r.dip ?? 0) * 100)}%. Shoot as the ring closes` : 'Free kick: move the target, then pass, lob or shoot as the ring closes. Hold the modifier and move to bend or dip a shot') + (Math.hypot(r.spot.x - PITCH.halfLength * v.attackDir[lt], r.spot.z) < 30 ? '. SKILL: run-up · modifier+sprint+SHOOT: knuckleball · THROUGH+SHOOT: low under the wall · SWITCH: routine' : ''))
        : r.type === 'throwin' ? `Throw-in: PASS short to feet, LOB long, THROUGH down the line${Math.abs(r.spot.x - PITCH.halfLength * v.attackDir[lt]) < 32 ? '. SWITCH: long throw into the box' : ''}`
        : `${RESTART_NAMES[r.type]}: move the target, then pass or lob`;
    } else if (r && r.type === 'penalty' && lt !== undefined && r.team !== lt && v.humans[lt] && v.players[v.ctl[lt]]?.role === 'GK') {
      // Penalty keeper duel.
      const tk = v.players[r.taker];
      const fav = tk ? favouriteSide(tk.def) : null;
      this.hint.style.display = 'block';
      this.hint.textContent = (r.gkCommit !== undefined ? (r.gkCommit === 0 ? 'Standing tall. ' : 'You have picked your side. ') : '') +
        `Their penalty${tk ? ` (${tk.def.short}${fav ? `, usually puts it to his ${fav.side === 'L' ? 'left' : 'right'}` : ''})` : ''}: move along your line with the stick, point the way and press SHOOT to dive, or centred to stand tall. Go too early and he will see it`;
    } else if (r && r.type === 'freekick' && lt !== undefined && r.team !== lt && v.humans[lt] && Math.hypot(r.spot.x + PITCH.halfLength * v.attackDir[lt], r.spot.z) < 30) {
      this.hint.style.display = 'block';
      this.hint.textContent = 'Their free kick: move the stick to shift your wall, SWITCH changes how many stand in it, SHOOT makes it jump, PASS puts a man down behind it';
    } else if (v.ball.state === 'held' && v.ball.owner >= 0 && lt !== undefined && v.players[v.ball.owner].team === lt && v.humans[lt] && v.phase === 'play') {
      this.hint.style.display = 'block';
      this.hint.textContent = 'Keeper\'s ball: PASS rolls it out, LOB throws, THROUGH drop-kicks, SHOOT punts. Aim with the stick, hold for distance';
    } else if (v.skill?.task) {
      // Ball control drill: what to do now.
      this.hint.style.display = 'block';
      this.hint.textContent = v.skill.task;
    } else this.hint.style.display = 'none';
    this.guideEl.innerHTML = info.guide;
    this.guideEl.style.display = info.guide ? 'block' : 'none';
    if (info.debug !== null) { this.debugEl.style.display = 'block'; this.debugEl.textContent = info.debug; }
    else this.debugEl.style.display = 'none';
    const fps = info.fps ?? null;
    if (fps !== this.fpsText) { this.fpsText = fps; this.fpsEl.style.display = fps ? 'block' : 'none'; if (fps) this.fpsEl.textContent = fps; }
    this.drawRadar(v, info.localTeams);
  }

  private drawRadar(v: ViewState, local: number[]) {
    const c = this.radar;
    const g = c.getContext('2d')!;
    const W = c.width, H = c.height, pad = 6;
    const sx = (W - pad * 2) / PITCH.length, sz = (H - pad * 2) / PITCH.width;
    const X = (x: number) => pad + (x + PITCH.halfLength) * sx;
    const Z = (z: number) => pad + (z + PITCH.halfWidth) * sz;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(40,90,50,0.55)';
    g.fillRect(pad, pad, W - pad * 2, H - pad * 2);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 1;
    g.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    g.beginPath(); g.moveTo(X(0), Z(-PITCH.halfWidth)); g.lineTo(X(0), Z(PITCH.halfWidth)); g.stroke();
    g.beginPath(); g.arc(X(0), Z(0), PITCH.centreCircleRadius * sx, 0, Math.PI * 2); g.stroke();
    for (const s of [-1, 1]) {
      const x0 = X(s * PITCH.halfLength), x1 = X(s * (PITCH.halfLength - PITCH.penaltyAreaDepth));
      g.strokeRect(Math.min(x0, x1), Z(-PITCH.penaltyAreaHalfWidth), Math.abs(x1 - x0), PITCH.penaltyAreaHalfWidth * 2 * sz);
    }
    const kits = [v.teams[0][v.kits[0]], v.teams[1][v.kits[1]]];
    for (const p of v.players) {
      if (p.off) continue;
      const x = X(p.pos.x), y = Z(p.pos.z);
      g.fillStyle = hex(p.role === 'GK' ? kits[p.team].keeper : kits[p.team].shirt);
      g.strokeStyle = '#000';
      g.lineWidth = 1.2;
      g.beginPath();
      // Shape as well as colour: home side circles, away side squares.
      if (p.team === 0) g.arc(x, y, 3.4, 0, Math.PI * 2);
      else g.rect(x - 3.1, y - 3.1, 6.2, 6.2);
      g.fill();
      g.stroke();
    }
    for (const t of local) {
      if (!v.humans[t] || v.ctl[t] < 0) continue;
      const p = v.players[v.ctl[t]];
      g.strokeStyle = t === local[0] ? '#ffd60a' : '#4cc9f0';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(X(p.pos.x), Z(p.pos.z), 6, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(X(v.ball.pos.x), Z(v.ball.pos.z), 2.4, 0, Math.PI * 2);
    g.fill();
    // Wind: an arrow the way it blows, longer when stronger, with its speed.
    const w = v.weather;
    if (w && w.wind >= 1) {
      const L = 8 + w.wind * 2.2, cx = W - 30, cy = 16, dx = Math.cos(w.windDir), dz = Math.sin(w.windDir);
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(W - 58, pad, 52, 26);
      g.strokeStyle = '#cfe8ff'; g.fillStyle = '#cfe8ff'; g.lineWidth = 2;
      const x0 = cx - dx * L / 2, y0 = cy - dz * L / 2, x1 = cx + dx * L / 2, y1 = cy + dz * L / 2;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - dx * 5 - dz * 3.5, y1 - dz * 5 + dx * 3.5); g.lineTo(x1 - dx * 5 + dz * 3.5, y1 - dz * 5 - dx * 3.5); g.fill();
      g.font = '600 9px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText(`${Math.round(w.wind * 3.6)} km/h`, W - 32, pad + 24);
      g.restore();
      c.title = `${windText(w.wind)}, ${Math.round(w.wind * 3.6)} km/h`;
    }
    void possessionTeam;
  }
}

/** Stronger foot and weak-foot stars, e.g. "R ★★★☆☆". */
function footTag(def: PlayerDef) {
  const f = footProfile(def);
  return `<small class="ft" title="${f.foot === 1 ? 'Right' : 'Left'}-footed, weak foot ${f.stars}/5">${f.foot === 1 ? 'R' : 'L'} ${'★'.repeat(f.stars)}${'☆'.repeat(5 - f.stars)}</small>`;
}
