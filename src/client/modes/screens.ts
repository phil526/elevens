// Menus for the modes added on 19 Nov 2026: Career (manage a club over several seasons), Be a
// Pro (one player's career), Daily scenarios, Skill games, the Trophy cabinet and club history,
// and My goals (saved clips). The app hands over a small host (screen helpers and starting a
// match); the full-time panel asks `finish` what the match meant for the mode.

import './modes.css';
import type { Difficulty } from '../../shared/config';
import { MATCH } from '../../shared/config';
import {
  ACADEMY_MAX, CAREER_LEAGUE_SIZES, GROUP_NAME, SQUAD_MAX, applySquads, buyPlayer, careerTeam, clubName, cupProgress, endSeason, leagueTable, money, newCareer,
  nextFixture, offerFor, ordinalText, ovrOf, promoteYouth, recordCareerMatch, releasePlayer, roleGroup, seasonOver, seasonYear, sellPlayer, swapLineup, teamSheet, topScorers, valueOf,
  type Career, type CareerPlayer,
} from '../../shared/career';
import { cupRounds, scoreText, type Fixture } from '../../shared/competition';
import {
  ATTR_NAMES, PRO_ATTRS, PRO_POSITIONS, PRO_POS_NAMES, acceptOffer, endProSeason, newPro, proNext, proOverall, proSlot, proTeam, recordProMatch, seasonDone, spendPoint, xpToNext, type ProPlayer,
} from '../../shared/pro';
import { GOAL_TEXT, SCENARIOS, dailyScenario, clubsFor, dateSeed, fillStory, scenarioMet, scenarioMinutes, scenarioStart, type Scenario } from '../../shared/scenarios';
import { SKILL_GAMES, SKILL_HELP, SKILL_NAMES, type SkillGame } from '../../shared/skillgames';
import { ALL_CLUBS, HR, ROLES, SK, teamById, teamRatings, type TeamDef } from '../../shared/teams';
import type { MatchConfig } from '../../shared/types';
import type { Match } from '../../shared/match';
import type { Profile, Trophy } from '../profile';
import { clubBadge } from '../ui/badge';
import type { ViewState } from '../view';
import { deleteClip, listClips, type GoalClip } from './clips';
import { addToCabinet, dailyStreak, loadModes, recordClubMatch, saveModes, type CabinetItem, type ModeStore } from './store';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const todayStr = () => new Date().toISOString().slice(0, 10);
const niceDate = (d: string) => { try { return new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d; } };

export type ModeKind = 'career' | 'pro' | 'scenario' | 'skill';

/** A match one of the modes wants played. */
export interface ModeMatch {
  kind: ModeKind;
  club: string;
  opp: string;
  /** Squads standing in for the clubs' own (career and Be a Pro). */
  overrides: TeamDef[];
  draw: 'stand' | 'extra';
  minutes: number;
  difficulty: Difficulty;
  patch: Partial<MatchConfig>;
  /** Loading-card line. */
  detail: string;
  /** Stadium fly-in and walk-out first (not for a scenario picked up mid-match or a skill game). */
  intro: boolean;
  /** What it was for (scenario id, skill game). */
  ref?: string;
}

export interface ModeHost {
  set(html: string, cls?: string): void;
  on(sel: string, fn: (el: HTMLElement) => void): void;
  seg(name: string, values: [string, string][], cur: string): string;
  bindSeg(name: string, fn: (v: string) => void): void;
  kitSwatch(club: string, kit: 'home' | 'away'): string;
  home(): void;
  play(m: ModeMatch): void;
  slot(): number;
  profile(): Profile;
  /** The last quick-match setup (difficulty and length for career and Be a Pro). */
  choice(): { club: string; difficulty: Difficulty; minutes: number };
  watchClip(c: GoalClip, record: boolean): void;
  focusFirst(): void;
}

type CareerTab = 'home' | 'squad' | 'transfers' | 'academy' | 'league' | 'cup' | 'history';
type CabinetTab = 'cabinet' | 'clubs' | 'career' | 'pro';

export class ModeScreens {
  store: ModeStore;
  private slotNo: number;
  private careerTab: CareerTab = 'home';
  private pick = '';
  private msg = '';
  private setup = { club: '', size: 12, manager: '' };
  private proSetup = { name: '', pos: 'ST' as (typeof PRO_POSITIONS)[number], club: '', number: 18, foot: 'R' as 'R' | 'L', skin: 2, hair: 1 };
  private confirm = '';
  private cabinetTab: CabinetTab = 'cabinet';
  private clubOpen = '';
  /** What the last full time meant, kept so the panel can be shown again without counting twice. */
  private finished: { html: string; label: string; next: () => void } | null = null;
  current: ModeMatch | null = null;

  constructor(private h: ModeHost) {
    this.slotNo = h.slot();
    this.store = loadModes(this.slotNo);
  }

  /** The save slot changed: load its modes. */
  syncSlot(force = false) {
    if (!force && this.h.slot() === this.slotNo) return;
    this.slotNo = this.h.slot();
    this.store = loadModes(this.slotNo);
  }

  save() { saveModes(this.slotNo, this.store); }

  // ------------------------------------------------------------------ menu entry

  /** Buttons for the More modes list. */
  menuButtons(): string {
    const d = dailyScenario(todayStr());
    const doneToday = this.store.daily[todayStr()]?.met;
    return `<button class="btn" data-mode="career">Career${this.store.career ? `<small>${esc(clubName(this.store.career.club))} · ${seasonYear(this.store.career)}</small>` : ''}</button>
      <button class="btn" data-mode="pro">Be a Pro${this.store.pro ? `<small>${esc(this.store.pro.name)} · ${proOverall(this.store.pro)}</small>` : ''}</button>
      <button class="btn" data-mode="daily">Daily scenario<small>${doneToday ? '✓ done today' : esc(d.scenario.title)}</small></button>
      <button class="btn" data-mode="skill">Skill games</button>
      <button class="btn" data-mode="cabinet">Trophy cabinet and club history</button>
      <button class="btn" data-mode="clips">My goals</button>`;
  }

  bindMenu() {
    this.h.on('[data-mode=career]', () => { this.careerTab = 'home'; this.showCareer(); });
    this.h.on('[data-mode=pro]', () => this.showPro());
    this.h.on('[data-mode=daily]', () => this.showScenarios());
    this.h.on('[data-mode=skill]', () => this.showSkillGames());
    this.h.on('[data-mode=cabinet]', () => { this.cabinetTab = 'cabinet'; this.clubOpen = ''; this.showCabinet(); });
    this.h.on('[data-mode=clips]', () => void this.showClips());
  }

  /** Back to this mode's own screen after a match. */
  backToMode(kind: ModeKind) {
    if (kind === 'career') this.showCareer();
    else if (kind === 'pro') this.showPro();
    else if (kind === 'scenario') this.showScenarios();
    else this.showSkillGames();
  }

  private flash() { return this.msg ? `<p class="mode-msg">${esc(this.msg)}</p>` : ''; }

  // ------------------------------------------------------------------ career

  showCareer() {
    const c = this.store.career;
    if (!c) { this.showCareerSetup(); return; }
    const me = teamById(c.club);
    const tabs: [CareerTab, string][] = [['home', 'Overview'], ['squad', 'Squad'], ['transfers', 'Transfers'], ['academy', 'Academy'], ['league', 'League'], ['cup', 'Cup'], ['history', 'History']];
    let body = '';
    switch (this.careerTab) {
      case 'home': body = this.careerHome(c); break;
      case 'squad': body = this.careerSquad(c); break;
      case 'transfers': body = this.careerTransfers(c); break;
      case 'academy': body = this.careerAcademy(c); break;
      case 'league': body = this.careerLeague(c); break;
      case 'cup': body = this.careerCup(c); break;
      case 'history': body = this.careerHistory(c); break;
    }
    const fx = nextFixture(c);
    this.h.set(`<div class="panel wide mode-panel">
      <div class="mode-head">${clubBadge(me, 42)}<div><h2>${esc(me.name)}</h2><p class="note">${esc(c.manager)} · Season ${c.season} (${seasonYear(c)}) · Budget <b>${money(c.budgets[c.club])}</b></p></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${this.careerTab === k ? 'on' : ''}" data-ctab="${k}">${l}</button>`).join('')}</div>
      ${this.flash()}
      ${body}
      <div class="row end" style="margin-top:14px">
        <button class="btn" data-a="back">Main menu</button>
        <button class="btn danger" data-a="quit">${this.confirm === 'career' ? 'Sure? Press again' : 'End career'}</button>
        ${fx ? `<button class="btn primary" data-a="cplay" autofocus>Play ${esc(fx.round.split(' · ')[0].toLowerCase())} match</button>` : `<button class="btn primary" data-a="cseason" autofocus>End the season</button>`}
      </div></div>`, 'scroll');
    this.msg = '';
    this.h.on('[data-ctab]', (el) => { this.careerTab = el.dataset.ctab as CareerTab; this.pick = ''; this.confirm = ''; this.showCareer(); });
    this.h.on('[data-a=back]', () => { this.confirm = ''; this.h.home(); });
    this.h.on('[data-a=quit]', () => {
      if (this.confirm !== 'career') { this.confirm = 'career'; this.showCareer(); return; }
      this.confirm = '';
      this.store.career = null;
      this.save();
      this.showCareerSetup();
    });
    this.h.on('[data-a=cplay]', () => this.playCareer());
    this.h.on('[data-a=cseason]', () => this.endCareerSeason());
    this.bindCareerTab(c);
  }

  private showCareerSetup() {
    const s = this.setup;
    const clubs = ALL_CLUBS.slice().sort((a, b) => teamRatings(a).ovr - teamRatings(b).ovr);
    if (!s.club) s.club = clubs[Math.floor(clubs.length / 3)].id;
    if (!s.manager) s.manager = this.h.profile().name;
    const ch = this.h.choice();
    this.h.set(`<div class="panel mode-panel">
      <h2>Career</h2>
      <p class="note">Take charge of a club for as many seasons as you like: a league and a cup each season, a board target, a transfer budget, and an academy that brings through young players. Players age, grow, decline and retire; other clubs buy and sell too.</p>
      <div class="field"><span class="lbl">Manager</span><input class="text-in" data-in="manager" maxlength="24" value="${esc(s.manager)}"></div>
      <div class="field"><span class="lbl">League size</span>${this.h.seg('csize', CAREER_LEAGUE_SIZES.map((n) => [String(n), `${n} clubs`]), String(s.size))}
        <span class="note">${s.size >= 16 ? 'The cup has 16 clubs.' : 'The cup has 8 clubs.'} ${s.size - 1} league matches a season.</span></div>
      <div class="field"><span class="lbl">Computer difficulty</span>${this.h.seg('cdiff', [['casual', 'Casual'], ['pro', 'Pro'], ['elite', 'Elite'], ['adaptive', 'Adaptive']], ch.difficulty)}</div>
      <div class="field"><span class="lbl">Match length (real minutes)</span>${this.h.seg('cmin', MATCH.allowedRealMinutes.map((m) => [String(m), String(m)]), String(ch.minutes))}</div>
      <h3>Choose your club</h3>
      <p class="note">Weaker clubs have smaller budgets and humbler targets.</p>
      <div class="grid4">${clubs.map((t) => `<button class="club mini ${s.club === t.id ? 'on' : ''}" data-cclub="${t.id}"><span class="abbr">${clubBadge(t, 28)} ${t.abbr} ${this.h.kitSwatch(t.id, 'home')} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(t.name)}</span></button>`).join('')}</div>
      <div class="row end" style="margin-top:14px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="cstart">Start career</button></div>
    </div>`, 'scroll');
    const nameIn = () => (document.querySelector<HTMLInputElement>('[data-in=manager]')?.value ?? s.manager).trim();
    this.h.bindSeg('csize', (v) => { s.manager = nameIn(); s.size = Number(v); this.showCareerSetup(); });
    this.h.bindSeg('cdiff', (v) => { s.manager = nameIn(); ch.difficulty = v as Difficulty; this.showCareerSetup(); });
    this.h.bindSeg('cmin', (v) => { s.manager = nameIn(); ch.minutes = Number(v); this.showCareerSetup(); });
    this.h.on('[data-cclub]', (el) => { s.manager = nameIn(); s.club = el.dataset.cclub!; this.showCareerSetup(); });
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-a=cstart]', () => {
      s.manager = nameIn() || 'Manager';
      this.store.career = newCareer(s.club, (Math.random() * 2 ** 31) >>> 0, s.size, s.manager, new Date().getFullYear());
      this.save();
      this.careerTab = 'home';
      this.showCareer();
    });
  }

  private playerRow(c: Career, p: CareerPlayer, extra: string, opts: { xi?: number; picked?: boolean } = {}) {
    const ovr = ovrOf(p);
    return `<div class="sq-row${opts.picked ? ' picked' : ''}${p.injured > 0 ? ' hurt' : ''}" data-pid="${p.id}">
      <span class="sq-pos ${roleGroup(opts.xi !== undefined && opts.xi >= 0 ? ROLES[opts.xi] : p.pos).toLowerCase()}">${opts.xi !== undefined && opts.xi >= 0 ? ROLES[opts.xi] : p.pos}</span>
      <span class="sq-num">${p.number || ''}</span>
      <span class="sq-name">${esc(p.name)}${p.youth ? ' <i class="tag">Academy</i>' : ''}${p.injured > 0 ? ` <i class="tag red">Injured ${p.injured}</i>` : ''}</span>
      <span class="sq-age">${p.age}</span>
      <span class="sq-ovr"><b>${ovr}</b><small>${p.potential > ovr + 2 ? ` → ${Math.round(p.potential)}` : ''}</small></span>
      <span class="sq-val">${money(valueOf(p))}</span>
      <span class="sq-act">${extra}</span></div>`;
  }

  private careerHome(c: Career): string {
    const fx = nextFixture(c);
    const table = leagueTable(c.league);
    const pos = table.findIndex((r) => r.id === c.club) + 1;
    const row = table[pos - 1];
    const { xi } = teamSheet(c, c.club);
    const avg = Math.round(xi.reduce((s, p, i) => s + ovrOf(p, ROLES[i]), 0) / Math.max(1, xi.length));
    const next = fx ? `<div class="comp-next"><span class="lbl">${esc(fx.round)} · ${fx.home ? 'Home' : 'Away'}</span>
        <div class="final small">${clubBadge(teamById(c.club), 26)} ${esc(clubName(c.club))} v ${esc(clubName(fx.opp))} ${clubBadge(teamById(fx.opp), 26)}</div></div>`
      : `<div class="comp-banner">The season is over. ${pos === 1 ? '🏆 Champions!' : `You finished ${ordinalText(pos)}.`} End the season to see the summary and start the next one.</div>`;
    return `${next}
      <div class="mode-cards">
        <div class="mcard"><span class="lbl">League</span><b>${ordinalText(pos)}</b><span>${row.pts} pts · P${row.p} W${row.w} D${row.d} L${row.l}</span></div>
        <div class="mcard"><span class="lbl">Cup</span><b>${esc(c.cup.champion === c.club ? 'Winners' : c.cup.out ? 'Out' : cupRounds(c.cup)[c.cup.round] ?? '')}</b><span>${esc(cupProgress(c))}</span></div>
        <div class="mcard"><span class="lbl">Board target</span><b>${esc(c.objective.text)}</b><span>${pos <= c.objective.pos ? 'On track' : 'Below target'}</span></div>
        <div class="mcard"><span class="lbl">Starting eleven</span><b>${avg}</b><span>average rating</span></div>
      </div>
      <h3>News</h3>
      <div class="news">${c.news.slice(0, 8).map((n) => `<p>${esc(n.text)}</p>`).join('') || '<p class="note">Nothing yet.</p>'}</div>`;
  }

  private careerSquad(c: Career): string {
    const sq = c.squads[c.club];
    const { xi, bench } = teamSheet(c, c.club);
    const rest = sq.filter((p) => !xi.includes(p) && !bench.includes(p));
    const pickNote = this.pick ? 'Now pick the player to swap with.' : 'Pick a player, then another, to swap them (starters change places, or a substitute comes into the eleven).';
    const sellBtn = (p: CareerPlayer) => {
      const o = offerFor(c, p.id);
      return `<button class="btn tiny" data-sell="${p.id}" ${o ? '' : 'disabled'}>${this.confirm === `sell:${p.id}` && o ? `Sell to ${esc(clubName(o.club))} for ${money(o.price)}?` : 'Sell'}</button><button class="btn tiny" data-rel="${p.id}">${this.confirm === `rel:${p.id}` ? 'Release?' : 'Release'}</button>`;
    };
    return `<p class="note">${pickNote} ${sq.length}/${SQUAD_MAX} players.</p>
      <div class="sq-head"><span>Pos</span><span>#</span><span>Name</span><span>Age</span><span>Rating</span><span>Value</span><span></span></div>
      <h4>Starting eleven</h4>${xi.map((p, i) => this.playerRow(c, p, sellBtn(p), { xi: i, picked: this.pick === p.id })).join('')}
      <h4>Substitutes</h4>${bench.map((p) => this.playerRow(c, p, sellBtn(p), { picked: this.pick === p.id })).join('')}
      ${rest.length ? `<h4>Reserves and injured</h4>${rest.map((p) => this.playerRow(c, p, sellBtn(p), { picked: this.pick === p.id })).join('')}` : ''}`;
  }

  private careerTransfers(c: Career): string {
    const list = c.market.map((m) => { const sq = c.squads[m.club]; const p = sq?.find((x) => x.id === m.id); return p ? { m, p } : null; }).filter((x): x is { m: Career['market'][number]; p: CareerPlayer } => !!x)
      .sort((a, b) => ovrOf(b.p) - ovrOf(a.p));
    return `<p class="note">Players other clubs will sell. Budget ${money(c.budgets[c.club])}. Sell from the Squad tab: the best offer comes in at once.</p>
      <div class="sq-head"><span>Pos</span><span>#</span><span>Name</span><span>Age</span><span>Rating</span><span>Price</span><span></span></div>
      ${list.map(({ m, p }) => this.playerRow(c, p, `<span class="note">${esc(clubName(m.club))}</span> <button class="btn tiny primary" data-buy="${p.id}" ${c.budgets[c.club] >= m.price ? '' : 'disabled'}>${this.confirm === `buy:${p.id}` ? `Pay ${money(m.price)}?` : `Buy ${money(m.price)}`}</button>`)).join('') || '<p class="note">Nobody is for sale right now. The list changes every season.</p>'}`;
  }

  private careerAcademy(c: Career): string {
    return `<p class="note">Young players from your academy (${c.academy.length}/${ACADEMY_MAX}). They grow fastest when they play; at 19 they move up or leave. New prospects arrive every season.</p>
      <div class="sq-head"><span>Pos</span><span>#</span><span>Name</span><span>Age</span><span>Rating</span><span>Value</span><span></span></div>
      ${c.academy.map((p) => this.playerRow(c, p, `<button class="btn tiny primary" data-promote="${p.id}">Promote</button><button class="btn tiny" data-rel="${p.id}">${this.confirm === `rel:${p.id}` ? 'Release?' : 'Release'}</button>`)).join('') || '<p class="note">The academy is empty until next season\'s intake.</p>'}`;
  }

  private careerLeague(c: Career): string {
    const rows = leagueTable(c.league);
    const name = (id: string) => `${clubBadge(teamById(id), 18)} ${esc(clubName(id))}`;
    const last = c.league.round > 0 ? c.league.rounds[c.league.round - 1] : null;
    const fxRow = (x: Fixture) => `<div class="fx${x.home === c.club || x.away === c.club ? ' mine' : ''}"><span>${name(x.home)}</span><b>${esc(scoreText(x))}</b><span>${name(x.away)}</span></div>`;
    return `<table class="ltable"><tr><th></th><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>${rows.map((r, i) => `<tr class="${r.id === c.club ? 'me' : ''}"><td>${i + 1}</td><td>${name(r.id)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td><b>${r.pts}</b></td></tr>`).join('')}</table>
      ${last ? `<h4>Last round</h4>${last.map(fxRow).join('')}` : ''}
      <h4>Top scorers</h4>${topScorers(c, 8).map((s) => `<div class="fx"><span>${esc(s.name)}</span><b>${s.goals}</b><span>${esc(clubName(s.club))}</span></div>`).join('') || '<p class="note">No goals yet.</p>'}`;
  }

  private careerCup(c: Career): string {
    const name = (id: string) => `<span class="${id === c.club ? 'me' : ''}">${clubBadge(teamById(id), 16)} ${esc(clubName(id))}</span>`;
    return `<p class="note">One cup round is played every few league rounds. A draw goes to extra time and penalties.</p><div class="bracket${cupRounds(c.cup).length > 3 ? ' wide' : ''}">${cupRounds(c.cup).map((rn, i) => `<div class="bround"><h4>${rn}</h4>${(c.cup.rounds[i] ?? []).map((x) => `<div class="fx${x.home === c.club || x.away === c.club ? ' mine' : ''}">${name(x.home)}<b>${esc(scoreText(x))}</b>${name(x.away)}</div>`).join('') || '<p class="note">To be decided</p>'}</div>`).join('')}</div>`;
  }

  private careerHistory(c: Career): string {
    const hon = c.honours.length ? `<div class="honours">${c.honours.map((x) => `<span class="trophy-chip ${x.kind}">${x.kind === 'league' ? '🏆 League' : '🏆 Cup'} ${seasonYear(c, x.season)}</span>`).join('')}</div>` : '';
    return `${hon}${c.history.length ? `<table class="ltable"><tr><th>Season</th><th>Pos</th><th>Pts</th><th>W-D-L</th><th>Goals</th><th>Cup</th><th>Top scorer</th><th>Target</th></tr>${c.history.map((s) => `<tr><td>${esc(s.year)}</td><td><b>${ordinalText(s.pos)}</b>/${s.size}</td><td>${s.pts}</td><td>${s.w}-${s.d}-${s.l}</td><td>${s.gf}:${s.ga}</td><td>${esc(s.cup)}</td><td>${s.topScorer ? `${esc(s.topScorer.name)} ${s.topScorer.goals}` : '-'}</td><td>${s.met ? '✓' : '✗'}</td></tr>`).join('')}</table>` : '<p class="note">Your first season is under way. Finished seasons are listed here.</p>'}`;
  }

  private bindCareerTab(c: Career) {
    const redraw = (text = '') => { this.msg = text; this.save(); this.showCareer(); };
    this.h.on('[data-pid]', (el) => {
      if (this.careerTab !== 'squad') return;
      if ((document.activeElement as HTMLElement | null)?.dataset?.sell || (document.activeElement as HTMLElement | null)?.dataset?.rel) return;
      const id = el.dataset.pid!;
      if (!this.pick) { this.pick = id; this.showCareer(); return; }
      if (this.pick !== id) swapLineup(c, this.pick, id);
      this.pick = '';
      redraw();
    });
    const stop = (fn: (el: HTMLElement) => void) => (el: HTMLElement) => fn(el);
    document.querySelectorAll<HTMLElement>('[data-sell],[data-rel],[data-buy],[data-promote]').forEach((b) => b.addEventListener('click', (e) => e.stopPropagation()));
    this.h.on('[data-sell]', stop((el) => {
      const id = el.dataset.sell!;
      if (this.confirm !== `sell:${id}`) { this.confirm = `sell:${id}`; this.showCareer(); return; }
      this.confirm = '';
      redraw(sellPlayer(c, id).text);
    }));
    this.h.on('[data-rel]', stop((el) => {
      const id = el.dataset.rel!;
      if (this.confirm !== `rel:${id}`) { this.confirm = `rel:${id}`; this.showCareer(); return; }
      this.confirm = '';
      redraw(releasePlayer(c, id).text);
    }));
    this.h.on('[data-buy]', stop((el) => {
      const id = el.dataset.buy!;
      if (this.confirm !== `buy:${id}`) { this.confirm = `buy:${id}`; this.showCareer(); return; }
      this.confirm = '';
      redraw(buyPlayer(c, id).text);
    }));
    this.h.on('[data-promote]', stop((el) => redraw(promoteYouth(c, el.dataset.promote!).text)));
  }

  private playCareer() {
    const c = this.store.career;
    const fx = c && nextFixture(c);
    if (!c || !fx) return;
    applySquads(c);
    const overrides = ALL_CLUBS.map((t) => careerTeam(c, t.id, t));
    const ch = this.h.choice();
    this.h.play({
      kind: 'career', club: c.club, opp: fx.opp, overrides, draw: fx.comp === 'cup' ? 'extra' : 'stand', minutes: ch.minutes, difficulty: ch.difficulty,
      patch: { injuries: true }, detail: `Career · ${fx.round}`, intro: true,
    });
  }

  private endCareerSeason() {
    const c = this.store.career;
    if (!c || !seasonOver(c)) return;
    const { summary, notes } = endSeason(c);
    const me = clubName(c.club);
    if (summary.pos === 1) addToCabinet(this.store, { kind: 'career-league', title: 'League champions', sub: `${me} · ${summary.year}`, club: c.club, date: todayStr() });
    this.save();
    this.h.set(`<div class="panel mode-panel">
      <h2>Season ${esc(summary.year)} · ${esc(me)}</h2>
      <div class="comp-banner ${summary.pos === 1 ? 'win' : ''}">${summary.pos === 1 ? '🏆 League champions!' : `Finished ${ordinalText(summary.pos)} of ${summary.size}`} · ${summary.pts} points</div>
      <div class="mode-cards">
        <div class="mcard"><span class="lbl">Record</span><b>${summary.w}-${summary.d}-${summary.l}</b><span>Goals ${summary.gf}:${summary.ga}</span></div>
        <div class="mcard"><span class="lbl">Cup</span><b>${esc(summary.cup)}</b><span>${summary.cupWinner ? `Won by ${esc(clubName(summary.cupWinner))}` : ''}</span></div>
        <div class="mcard"><span class="lbl">Champions</span><b>${esc(clubName(summary.champion))}</b><span>${summary.topScorer ? `Golden boot: ${esc(summary.topScorer.name)}, ${summary.topScorer.goals}` : ''}</span></div>
        <div class="mcard"><span class="lbl">Board</span><b>${summary.met ? 'Happy' : 'Disappointed'}</b><span>${esc(summary.objective)}</span></div>
      </div>
      <div class="news">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>
      <div class="row end" style="margin-top:14px"><button class="btn primary" data-a="next" autofocus>Start season ${c.season} (${seasonYear(c)})</button></div>
    </div>`, 'scroll');
    this.h.on('[data-a=next]', () => { this.careerTab = 'home'; this.showCareer(); });
  }

  // ------------------------------------------------------------------ Be a Pro

  showPro() {
    const p = this.store.pro;
    if (!p) { this.showProCreate(); return; }
    const club = teamById(p.club);
    const next = proNext(p);
    const ovr = proOverall(p);
    const need = xpToNext(p.level);
    const line = p.current;
    const avg = line.apps ? (line.ratingSum / line.apps).toFixed(2) : '-';
    const table = leagueTable(p.comp);
    const pos = table.findIndex((r) => r.id === p.club) + 1;
    const attrRows = PRO_ATTRS.map((k) => `<div class="attr-row"><span>${ATTR_NAMES[k]}</span><div class="attr-bar"><i style="width:${p.attrs[k]}%"></i></div><b>${p.attrs[k]}</b>${p.points > 0 && p.attrs[k] < 99 ? `<button class="btn tiny" data-up="${k}">+1</button>` : '<span></span>'}</div>`).join('');
    this.h.set(`<div class="panel wide mode-panel">
      <div class="mode-head pro-head"><div class="pro-badge"><span class="pro-ovr">${ovr}</span><span class="pro-pos">${p.pos}</span></div>
        <div><h2>${esc(p.name)} <small>#${p.number}</small></h2><p class="note">${esc(PRO_POS_NAMES[p.pos] ?? p.pos)} · ${clubBadge(club, 18)} ${esc(club.name)} · Age ${p.age} · Season ${p.season}</p>
        <div class="xp"><span>Level ${p.level}</span><div class="attr-bar xpbar"><i style="width:${Math.round((p.xp / need) * 100)}%"></i></div><span>${p.xp}/${need} XP</span></div></div></div>
      ${this.flash()}
      ${p.offer ? `<div class="comp-banner win">${esc(clubName(p.offer))} want to sign you! <button class="btn small primary" data-a="accept">Join them</button> <button class="btn small" data-a="decline">Stay</button></div>` : ''}
      <div class="pro-cols">
        <div><h3>Attributes ${p.points > 0 ? `<span class="tag">${p.points} points to spend</span>` : ''}</h3>${attrRows}
          <p class="note">You earn experience from every match: your rating matters most, and goals, assists, Man of the Match and wins add to it. Each level gives 3 points and improves your position's key skills by itself.</p></div>
        <div>
          ${next ? `<div class="comp-next"><span class="lbl">${esc(next.round)} · ${next.home ? 'Home' : 'Away'}</span><div class="final small">${esc(club.name)} v ${esc(clubName(next.opp))}</div></div>` : `<div class="comp-banner">Season over: you finished ${ordinalText(pos)}.</div>`}
          <div class="mode-cards">
            <div class="mcard"><span class="lbl">This season</span><b>${line.apps} apps</b><span>${line.goals} goals · ${line.assists} assists</span></div>
            <div class="mcard"><span class="lbl">Average rating</span><b>${avg}</b><span>${line.motm} × Man of the Match</span></div>
            <div class="mcard"><span class="lbl">League</span><b>${ordinalText(pos)}</b><span>${table[pos - 1]?.pts ?? 0} pts</span></div>
            <div class="mcard"><span class="lbl">Career</span><b>${p.total.apps} apps</b><span>${p.total.goals} goals · ${p.total.assists} assists</span></div>
          </div>
          <h4>Recent matches</h4>${p.recent.map((r) => `<div class="fx"><span>${esc(r.text)}</span><b class="rating ${r.rating >= 8 ? 'r-top' : r.rating >= 7 ? 'r-good' : r.rating >= 6 ? 'r-mid' : 'r-low'}">${r.rating.toFixed(1)}</b></div>`).join('') || '<p class="note">No matches yet.</p>'}
          ${p.history.length ? `<h4>Seasons</h4><table class="ltable"><tr><th>Season</th><th>Club</th><th>Apps</th><th>Goals</th><th>Ast</th><th>Avg</th><th>Pos</th><th>OVR</th></tr>${p.history.map((s) => `<tr><td>${s.season}</td><td>${esc(clubName(s.club))}</td><td>${s.apps}</td><td>${s.goals}</td><td>${s.assists}</td><td>${s.apps ? (s.ratingSum / s.apps).toFixed(2) : '-'}</td><td>${ordinalText(s.pos)}</td><td>${s.ovr}</td></tr>`).join('')}</table>` : ''}
        </div>
      </div>
      <p class="note">In a match you control only ${esc(p.short)}. Without the ball, press pass (or through ball) to call for it: the teammate on the ball plays it to you.</p>
      <div class="row end" style="margin-top:12px">
        <button class="btn" data-a="back">Main menu</button>
        <button class="btn danger" data-a="retire">${this.confirm === 'pro' ? 'Sure? Press again' : 'Retire'}</button>
        ${next ? '<button class="btn primary" data-a="pplay" autofocus>Play next match</button>' : '<button class="btn primary" data-a="pseason" autofocus>Next season</button>'}
      </div></div>`, 'scroll');
    this.msg = '';
    this.h.on('[data-up]', (el) => { if (spendPoint(p, el.dataset.up as (typeof PRO_ATTRS)[number])) { this.save(); this.showPro(); } });
    this.h.on('[data-a=accept]', () => { const to = p.offer!; acceptOffer(p); this.msg = `You join ${clubName(to)}.`; this.save(); this.showPro(); });
    this.h.on('[data-a=decline]', () => { p.offer = null; this.save(); this.showPro(); });
    this.h.on('[data-a=back]', () => { this.confirm = ''; this.h.home(); });
    this.h.on('[data-a=retire]', () => {
      if (this.confirm !== 'pro') { this.confirm = 'pro'; this.showPro(); return; }
      this.confirm = '';
      this.store.pro = null;
      this.save();
      this.showProCreate();
    });
    this.h.on('[data-a=pplay]', () => this.playPro());
    this.h.on('[data-a=pseason]', () => {
      if (!seasonDone(p)) return;
      const s = endProSeason(p);
      if (s.pos === 1) addToCabinet(this.store, { kind: 'pro-league', title: 'League champion', sub: `${p.name} · ${clubName(s.club)} · season ${s.season}`, club: s.club, date: todayStr() });
      const avg = s.apps ? s.ratingSum / s.apps : 0;
      if (avg >= 7.5 && s.apps >= 5) addToCabinet(this.store, { kind: 'pro-award', title: 'Player of the season', sub: `${p.name} · average ${avg.toFixed(2)} · season ${s.season}`, club: s.club, date: todayStr() });
      this.msg = `Season ${s.season} done: ${s.apps} apps, ${s.goals} goals, finished ${ordinalText(s.pos)}.${p.offer ? ` ${clubName(p.offer)} have made you an offer.` : ''}`;
      this.save();
      this.showPro();
    });
  }

  private showProCreate() {
    const s = this.proSetup;
    if (!s.name) s.name = this.h.profile().name;
    const clubs = ALL_CLUBS.slice().sort((a, b) => teamRatings(a).ovr - teamRatings(b).ovr);
    if (!s.club) s.club = clubs[2].id;
    const SKINS = ['Light', 'Fair', 'Tan', 'Brown', 'Dark', 'Deep'], HAIRS = ['Black', 'Dark brown', 'Brown', 'Blond', 'Grey', 'Red'];
    this.h.set(`<div class="panel mode-panel">
      <h2>Be a Pro</h2>
      <p class="note">Create a player and play his whole career: you control only him. Every match earns experience; level up and spend points on his attributes, win offers from bigger clubs, and watch his rating grow.</p>
      <div class="field"><span class="lbl">Name</span><input class="text-in" data-in="pname" maxlength="24" value="${esc(s.name)}"></div>
      <div class="field"><span class="lbl">Position</span>${this.h.seg('ppos', PRO_POSITIONS.map((r) => [r, PRO_POS_NAMES[r] ?? r]), s.pos).replace('class="seg"', 'class="seg wrap pro-pos"')}</div>
      <div class="field"><span class="lbl">Shirt number</span><input class="text-in num" data-in="pnum" type="number" min="2" max="99" value="${s.number}"></div>
      <div class="field"><span class="lbl">Stronger foot</span>${this.h.seg('pfoot', [['R', 'Right'], ['L', 'Left']], s.foot)}</div>
      <div class="field"><span class="lbl">Skin</span>${this.h.seg('pskin', SKINS.map((x, i) => [String(i), x]), String(s.skin))}</div>
      <div class="field"><span class="lbl">Hair</span>${this.h.seg('phair', HAIRS.map((x, i) => [String(i), x]), String(s.hair))}</div>
      <h3>First club</h3>
      <p class="note">Start small and earn a move, or join a big club and fight for your place.</p>
      <div class="grid4">${clubs.map((t) => `<button class="club mini ${s.club === t.id ? 'on' : ''}" data-pclub="${t.id}"><span class="abbr">${clubBadge(t, 28)} ${t.abbr} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(t.name)}</span></button>`).join('')}</div>
      <div class="row end" style="margin-top:14px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="pstart">Start career</button></div>
    </div>`, 'scroll');
    const read = () => {
      s.name = (document.querySelector<HTMLInputElement>('[data-in=pname]')?.value ?? s.name).trim();
      s.number = Math.max(2, Math.min(99, Number(document.querySelector<HTMLInputElement>('[data-in=pnum]')?.value) || s.number));
    };
    this.h.bindSeg('ppos', (v) => { read(); s.pos = v as typeof s.pos; this.showProCreate(); });
    this.h.bindSeg('pfoot', (v) => { read(); s.foot = v as 'R' | 'L'; this.showProCreate(); });
    this.h.bindSeg('pskin', (v) => { read(); s.skin = Number(v); this.showProCreate(); });
    this.h.bindSeg('phair', (v) => { read(); s.hair = Number(v); this.showProCreate(); });
    this.h.on('[data-pclub]', (el) => { read(); s.club = el.dataset.pclub!; this.showProCreate(); });
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-a=pstart]', () => {
      read();
      this.store.pro = newPro(s.name, s.pos, s.club, (Math.random() * 2 ** 31) >>> 0, { skin: SK[s.skin] ?? SK[2], hair: HR[s.hair] ?? HR[1], foot: s.foot, number: s.number });
      this.save();
      this.showPro();
    });
  }

  private playPro() {
    const p = this.store.pro;
    const next = p && proNext(p);
    if (!p || !next) return;
    const ch = this.h.choice();
    this.h.play({
      kind: 'pro', club: p.club, opp: next.opp, overrides: [proTeam(p)], draw: 'stand', minutes: ch.minutes, difficulty: ch.difficulty,
      patch: { lock: [proSlot(p), -1], injuries: true, autoSwitch: [false, false] }, detail: `Be a Pro · ${p.short} · ${next.round}`, intro: true,
    });
  }

  // ------------------------------------------------------------------ daily scenarios

  showScenarios() {
    const today = todayStr();
    const d = dailyScenario(today);
    const rec = this.store.daily[today];
    const streak = dailyStreak(this.store, today);
    const card = (s: Scenario, club: string, opp: string, daily: boolean) => {
      const best = this.store.scenarios[s.id];
      return `<div class="scen-card${daily ? ' daily' : ''}">
        <div class="scen-top"><span class="scen-min">${s.minute}'</span><span class="scen-score">${s.score[0]}–${s.score[1]}</span>${s.reds ? `<span class="tag red">${11 - s.reds[0].length} v ${11 - s.reds[1].length}</span>` : ''}${s.weather ? `<span class="tag">${s.weather === 'rain' ? 'Rain' : 'Snow'}</span>` : ''}<span class="tag">${s.difficulty === 'elite' ? 'Elite' : s.difficulty === 'casual' ? 'Casual' : 'Pro'}</span></div>
        <h3>${esc(s.title)} ${best?.met ? '<span class="tick">✓</span>' : ''}</h3>
        <p>${esc(fillStory(s, clubName(club), clubName(opp)))}</p>
        <p class="scen-goal"><b>Target:</b> ${esc(GOAL_TEXT[s.goal])}</p>
        <button class="btn ${daily ? 'primary big' : 'small'}" data-scen="${s.id}" data-club="${club}" data-opp="${opp}" ${daily ? 'autofocus' : ''}>${daily ? (rec?.met ? 'Play again' : 'Play today\'s scenario') : 'Play'}</button>
      </div>`;
    };
    const h = dateSeed(today);
    this.h.set(`<div class="panel wide mode-panel">
      <h2>Daily scenario</h2>
      <p class="note">A new match situation every day, the same for everyone on that date. Pick the match up part of the way through and meet the target. ${streak ? `<b>Streak: ${streak} day${streak === 1 ? '' : 's'}.</b>` : ''} ${rec ? (rec.met ? `Today: done (${rec.score[0]}–${rec.score[1]}).` : `Today: not yet (${rec.score[0]}–${rec.score[1]}). Try again.`) : ''}</p>
      ${card(d.scenario, d.club, d.opp, true)}
      <h3>All scenarios <small class="note">${Object.values(this.store.scenarios).filter((x) => x.met).length}/${SCENARIOS.length} done</small></h3>
      <div class="scen-grid">${SCENARIOS.filter((s) => s.id !== d.scenario.id).map((s, i) => { const cl = clubsFor(s, (h >>> 3) + i * 7919); return card(s, cl.club, cl.opp, false); }).join('')}</div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="back">Main menu</button></div>
    </div>`, 'scroll');
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-scen]', (el) => {
      const s = SCENARIOS.find((x) => x.id === el.dataset.scen);
      if (!s) return;
      this.playScenario(s, el.dataset.club!, el.dataset.opp!, s.id === d.scenario.id);
    });
  }

  private playScenario(s: Scenario, club: string, opp: string, daily: boolean) {
    const patch: Partial<MatchConfig> = { startAt: scenarioStart(s), injuries: true };
    if (s.weather) patch.weather = { kind: s.weather, wind: s.weather === 'rain' ? 4 : 2, windDir: 1.2 };
    this.h.play({
      kind: 'scenario', club, opp, overrides: [], draw: 'stand', minutes: scenarioMinutes(s), difficulty: s.difficulty,
      patch, detail: `${daily ? 'Daily scenario' : 'Scenario'} · ${s.title} · ${GOAL_TEXT[s.goal]}`, intro: false, ref: `${s.id}${daily ? ':daily' : ''}`,
    });
  }

  // ------------------------------------------------------------------ skill games

  showSkillGames() {
    const club = this.h.choice().club;
    this.h.set(`<div class="panel narrow mode-panel">
      <h2>Skill games</h2>
      <p class="note">Ten free kicks with nobody else on the pitch. Time the ring for accuracy and curl it with the stick. Best scores are kept for this profile.</p>
      <div class="stack" style="margin-top:12px">
        ${SKILL_GAMES.map((g, i) => `<button class="btn big ${i === 0 ? 'primary' : ''}" data-skill="${g}" ${i === 0 ? 'autofocus' : ''}>${SKILL_NAMES[g]}${this.store.skillBest[g] !== undefined ? ` · best ${this.store.skillBest[g]} pts` : ''}</button><p class="note">${SKILL_HELP[g]}</p>`).join('')}
      </div>
      <p class="note">You take them with ${esc(teamById(club).name)} (your quick-match club).</p>
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="back">Main menu</button></div>
    </div>`, 'scroll');
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-skill]', (el) => {
      const g = el.dataset.skill as SkillGame;
      const opp = ALL_CLUBS.find((t) => t.id !== club)!.id;
      this.h.play({ kind: 'skill', club, opp, overrides: [], draw: 'stand', minutes: 3, difficulty: 'pro', patch: { practice: g, challenge: 10 }, detail: `Skill games · ${SKILL_NAMES[g]}`, intro: false, ref: g });
    });
  }

  // ------------------------------------------------------------------ full time

  /** Started a mode match: forget the previous full-time result. */
  started(m: ModeMatch) { this.current = m; this.finished = null; }

  /**
   * Full time of a mode match: the result goes into the career, the pro's record, the scenario
   * or the skill game (once), and the panel gets a note and a Continue button.
   */
  finish(v: ViewState, match: Match): { html: string; label: string; next: () => void } | null {
    const mm = this.current;
    if (!mm) return null;
    if (this.finished) return this.finished;
    let html = '';
    const label = 'Continue';
    const next = () => this.backToMode(mm.kind);
    const so = v.shootout;
    const pens: [number, number] | undefined = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : undefined;
    const injuries = match.injuries.filter((x) => x.team === 0 && x.matches > 0).map((x) => ({ short: x.short, matches: x.matches }));
    if (mm.kind === 'career' && this.store.career) {
      const c = this.store.career;
      const cupBefore = c.cup.champion;
      const scorers = v.goals.filter((g) => g.team === 0 && !g.ownGoal).map((g) => v.players[g.player]?.def.short ?? '');
      const played = (v.ratings ?? []).filter((r) => r.team === 0).map((r) => r.short);
      const notes = recordCareerMatch(c, { gf: v.score[0], ga: v.score[1], pens, et: v.half > 2, scorers, played, injuries });
      if (c.cup.champion === c.club && cupBefore !== c.club) {
        addToCabinet(this.store, { kind: 'career-cup', title: 'Cup winners', sub: `${clubName(c.club)} · ${seasonYear(c)}`, club: c.club, date: todayStr() });
        notes.unshift('🏆 You have won the cup!');
      }
      const fx = nextFixture(c);
      const lt = leagueTable(c.league);
      notes.push(`League: ${ordinalText(lt.findIndex((r) => r.id === c.club) + 1)} of ${lt.length}.${fx ? ` Next: ${fx.round} v ${clubName(fx.opp)}.` : ' The season is over.'}`);
      html = `<div class="mode-note">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>`;
    } else if (mm.kind === 'pro' && this.store.pro) {
      const p = this.store.pro;
      const pid = proSlot(p);
      const r = (v.ratings ?? []).find((x) => x.team === 0 && x.pid === pid && x.from === 0) ?? (v.ratings ?? []).find((x) => x.team === 0 && x.pid === pid);
      const res = recordProMatch(p, { rating: r?.rating ?? 6, goals: r?.goals ?? 0, assists: r?.assists ?? 0, motm: !!r?.motm, gf: v.score[0], ga: v.score[1], pens, oppName: v.teams[1].name });
      html = `<div class="mode-note pro-result"><span class="rating big ${(r?.rating ?? 6) >= 8 ? 'r-top' : (r?.rating ?? 6) >= 7 ? 'r-good' : (r?.rating ?? 6) >= 6 ? 'r-mid' : 'r-low'}">${(r?.rating ?? 6).toFixed(1)}</span><div><b>${esc(p.name)}</b><p>${r?.goals ?? 0} goals · ${r?.assists ?? 0} assists${r?.motm ? ' · Man of the Match' : ''}</p><p>+${res.xp} XP${res.notes.map((n) => ` · ${esc(n)}`).join('')}</p></div></div>`;
    } else if (mm.kind === 'scenario' && mm.ref) {
      const [id, daily] = mm.ref.split(':');
      const s = SCENARIOS.find((x) => x.id === id);
      if (s) {
        const score: [number, number] = [v.score[0], v.score[1]];
        const met = scenarioMet(s, score);
        const rec = { id, met, score, date: todayStr() };
        const prev = this.store.scenarios[id];
        if (!prev || (met && !prev.met)) this.store.scenarios[id] = rec;
        if (daily) { const d = this.store.daily[todayStr()]; if (!d || (met && !d.met)) this.store.daily[todayStr()] = rec; }
        if (met && !prev?.met) addToCabinet(this.store, { kind: 'scenario', title: s.title, sub: `${GOAL_TEXT[s.goal]} · ${score[0]}–${score[1]}`, club: v.teams[0].id, date: todayStr() });
        const streak = dailyStreak(this.store, todayStr());
        html = `<div class="mode-note scen-result ${met ? 'met' : ''}"><b>${met ? 'Target met!' : 'Target missed.'}</b> ${esc(GOAL_TEXT[s.goal])}.${daily && met ? ` Daily streak: ${streak} day${streak === 1 ? '' : 's'}.` : ''}</div>`;
      }
    } else if (mm.kind === 'skill' && mm.ref) {
      const pts = match.skill?.points ?? v.score[0];
      const prev = this.store.skillBest[mm.ref];
      if (prev === undefined || pts > prev) this.store.skillBest[mm.ref] = pts;
      const name = SKILL_NAMES[mm.ref as SkillGame];
      if ((prev === undefined || pts > prev) && pts >= (mm.ref === 'crossbar' ? 9 : 15)) addToCabinet(this.store, { kind: 'skill', title: name, sub: `${pts} points`, club: v.teams[0].id, date: todayStr() });
      html = `<div class="final">${pts} points</div><p class="note" style="text-align:center">${prev === undefined ? 'First try: your best so far.' : pts > prev ? `New best! (was ${prev})` : `Best: ${prev}`}</p>`;
    }
    this.save();
    this.finished = { html, label, next };
    return this.finished;
  }

  /** Any finished match against the computer goes in the club's history. */
  recordClub(r: { club: string; opp: string; oppName: string; gf: number; ga: number; pens?: [number, number]; scorers: string[]; mode: string }) {
    recordClubMatch(this.store, { ...r, date: todayStr() });
    this.save();
  }

  // ------------------------------------------------------------------ trophy cabinet and club history

  showCabinet() {
    const prof = this.h.profile();
    const tabs: [CabinetTab, string][] = [['cabinet', 'Trophy cabinet'], ['clubs', 'Club history'], ['career', 'Career'], ['pro', 'Be a Pro']];
    let body = '';
    if (this.cabinetTab === 'cabinet') body = this.cabinetHtml(prof.trophies);
    else if (this.cabinetTab === 'clubs') body = this.clubOpen ? this.clubDetail(this.clubOpen) : this.clubList();
    else if (this.cabinetTab === 'career') body = this.store.career ? this.careerHistory(this.store.career) : '<p class="note">No career in progress. Start one from More modes > Career.</p>';
    else body = this.store.pro ? this.proHistoryHtml(this.store.pro) : '<p class="note">No pro in progress. Start one from More modes > Be a Pro.</p>';
    this.h.set(`<div class="panel wide mode-panel">
      <h2>${esc(prof.name)}'s trophy cabinet</h2>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${this.cabinetTab === k ? 'on' : ''}" data-ttab="${k}">${l}</button>`).join('')}</div>
      ${body}
      <div class="row end" style="margin-top:12px">${this.clubOpen ? '<button class="btn" data-a="clubs">All clubs</button>' : ''}<button class="btn" data-a="back" autofocus>Main menu</button></div>
    </div>`, 'scroll');
    this.h.on('[data-ttab]', (el) => { this.cabinetTab = el.dataset.ttab as CabinetTab; this.clubOpen = ''; this.showCabinet(); });
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-a=clubs]', () => { this.clubOpen = ''; this.showCabinet(); });
    this.h.on('[data-hclub]', (el) => { this.clubOpen = el.dataset.hclub!; this.showCabinet(); });
  }

  private cabinetHtml(profileTrophies: Trophy[]): string {
    type Shelf = { icon: string; cls: string; title: string; sub: string; date: string; club: string };
    const items: Shelf[] = [
      ...profileTrophies.map((t) => ({ icon: '🏆', cls: t.kind === 'league' ? 'gold' : 'silver', title: t.kind === 'league' ? 'Elevens League' : 'Elevens Cup', sub: `${t.clubName} · ${t.size} clubs`, date: t.date, club: t.club })),
      ...this.store.cabinet.map((c: CabinetItem) => ({
        icon: c.kind === 'scenario' ? '🎖️' : c.kind === 'skill' ? '🎯' : c.kind === 'pro-award' ? '⭐' : c.kind === 'ranked' ? '🛡️' : '🏆',
        cls: c.kind === 'career-league' || c.kind === 'pro-league' ? 'gold' : c.kind === 'career-cup' ? 'silver' : 'medal',
        title: c.title, sub: c.sub, date: c.date, club: c.club,
      })),
    ];
    const big = items.filter((x) => x.cls !== 'medal'), small = items.filter((x) => x.cls === 'medal');
    const tile = (x: Shelf) => `<div class="trophy ${x.cls}"><span class="t-icon">${x.icon}</span><b>${esc(x.title)}</b><span>${esc(x.sub)}</span><small>${niceDate(x.date)}</small></div>`;
    const counts = { played: this.h.profile().stats.played, won: this.h.profile().stats.won };
    return `<p class="note">${counts.played} matches played, ${counts.won} won. Cups and leagues from Cup and league, Career and Be a Pro go on the top shelf; medals for scenarios, skill games and awards below.</p>
      <div class="shelf">${big.map(tile).join('') || '<p class="note">No trophies yet. Win a cup or a league!</p>'}</div>
      <h3>Medals and awards</h3>
      <div class="shelf small">${small.map(tile).join('') || '<p class="note">Complete a daily scenario or set a high score in the skill games.</p>'}</div>`;
  }

  private clubList(): string {
    const list = Object.entries(this.store.clubs).sort((a, b) => b[1].played - a[1].played);
    if (!list.length) return '<p class="note">Every match you finish against the computer goes into your club\'s history. Play one and come back.</p>';
    return `<div class="club-hist">${list.map(([id, h]) => { const t = teamById(id); return `<button class="hist-card" data-hclub="${id}">${clubBadge(t, 34)}<div><b>${esc(t.name)}</b><span>${h.played} played · ${h.w}W ${h.d}D ${h.l}L · ${Math.round((h.w / Math.max(1, h.played)) * 100)}% won</span></div></button>`; }).join('')}</div>`;
  }

  private clubDetail(id: string): string {
    const h = this.store.clubs[id];
    if (!h) return '';
    const t = teamById(id);
    const top = Object.entries(h.scorers).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const vs = Object.entries(h.vs).sort((a, b) => (b[1][0] + b[1][1] + b[1][2]) - (a[1][0] + a[1][1] + a[1][2]));
    const trophies = [...this.h.profile().trophies.filter((x) => x.club === id).map((x) => `${x.kind === 'league' ? 'League' : 'Cup'} (${niceDate(x.date)})`), ...this.store.cabinet.filter((x) => x.club === id && x.kind !== 'scenario' && x.kind !== 'skill').map((x) => `${x.title} (${x.sub.split(' · ').pop()})`)];
    return `<div class="mode-head">${clubBadge(t, 46)}<div><h3>${esc(t.name)}</h3><p class="note">Your first match with them: ${niceDate(h.first)}</p></div></div>
      <div class="mode-cards">
        <div class="mcard"><span class="lbl">Record</span><b>${h.w}-${h.d}-${h.l}</b><span>${h.played} played · ${Math.round((h.w / Math.max(1, h.played)) * 100)}% won</span></div>
        <div class="mcard"><span class="lbl">Goals</span><b>${h.gf}:${h.ga}</b><span>${(h.gf / Math.max(1, h.played)).toFixed(1)} a match</span></div>
        <div class="mcard"><span class="lbl">Biggest win</span><b>${h.best ? esc(h.best.text) : '-'}</b><span>${h.best ? niceDate(h.best.date) : ''}</span></div>
        <div class="mcard"><span class="lbl">Heaviest defeat</span><b>${h.worst ? esc(h.worst.text) : '-'}</b><span>${h.worst ? niceDate(h.worst.date) : ''}</span></div>
      </div>
      ${trophies.length ? `<h4>Honours</h4><div class="honours">${trophies.map((x) => `<span class="trophy-chip">🏆 ${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="pro-cols">
        <div><h4>Top scorers</h4>${top.map(([n, g]) => `<div class="fx"><span>${esc(n)}</span><b>${g}</b></div>`).join('') || '<p class="note">No goals yet.</p>'}</div>
        <div><h4>Against each club</h4>${vs.map(([o, r]) => `<div class="fx"><span>${clubBadge(teamById(o), 16)} ${esc(teamById(o).name)}</span><b>${r[0]}W ${r[1]}D ${r[2]}L</b></div>`).join('')}</div>
      </div>
      <h4>Recent results</h4>${h.recent.map((r) => `<div class="fx"><span class="res ${r.res}">${r.res}</span><span>${esc(r.text)}</span><small>${niceDate(r.date)}</small></div>`).join('')}`;
  }

  private proHistoryHtml(p: ProPlayer): string {
    return `<div class="mode-cards">
      <div class="mcard"><span class="lbl">${esc(p.name)}</span><b>${proOverall(p)}</b><span>${esc(PRO_POS_NAMES[p.pos] ?? p.pos)} · age ${p.age}</span></div>
      <div class="mcard"><span class="lbl">Career</span><b>${p.total.apps} apps</b><span>${p.total.goals} goals · ${p.total.assists} assists</span></div>
      <div class="mcard"><span class="lbl">Man of the Match</span><b>${p.total.motm}</b><span>average ${p.total.apps ? (p.total.ratingSum / p.total.apps).toFixed(2) : '-'}</span></div>
      <div class="mcard"><span class="lbl">Level</span><b>${p.level}</b><span>${esc(clubName(p.club))}</span></div>
    </div>
    ${p.history.length ? `<table class="ltable"><tr><th>Season</th><th>Club</th><th>Apps</th><th>Goals</th><th>Ast</th><th>Avg</th><th>Pos</th><th>OVR</th></tr>${p.history.map((s) => `<tr><td>${s.season}</td><td>${esc(clubName(s.club))}</td><td>${s.apps}</td><td>${s.goals}</td><td>${s.assists}</td><td>${s.apps ? (s.ratingSum / s.apps).toFixed(2) : '-'}</td><td>${ordinalText(s.pos)}</td><td>${s.ovr}</td></tr>`).join('')}</table>` : '<p class="note">Finished seasons appear here.</p>'}`;
  }

  // ------------------------------------------------------------------ my goals (clips)

  async showClips(note = '') {
    const clips = await listClips();
    this.h.set(`<div class="panel mode-panel">
      <h2>My goals</h2>
      <p class="note">Goals you saved from the full-time screen. Watch them again, or share one as a video (on iPad the share sheet opens; on a PC it downloads).</p>
      ${note ? `<p class="mode-msg">${esc(note)}</p>` : ''}
      <div class="clip-list">${clips.map((c) => `<div class="clip-row"><div><b>${esc(c.title)}</b><span>${esc(c.sub)}</span><small>${niceDate(c.date)}</small></div>
        <div class="clip-btns"><button class="btn small primary" data-watch="${c.id}">Watch</button><button class="btn small" data-share="${c.id}">Share video</button><button class="btn small" data-del="${c.id}">${this.confirm === `del:${c.id}` ? 'Delete?' : 'Delete'}</button></div></div>`).join('') || '<p class="note">No saved goals yet. After a match, press Save on a goal on the full-time screen.</p>'}</div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="back">Main menu</button></div>
    </div>`, 'scroll');
    this.h.on('[data-a=back]', () => { this.confirm = ''; this.h.home(); });
    const find = (id: string) => clips.find((c) => c.id === id);
    this.h.on('[data-watch]', (el) => { const c = find(el.dataset.watch!); if (c) this.h.watchClip(c, false); });
    this.h.on('[data-share]', (el) => { const c = find(el.dataset.share!); if (c) this.h.watchClip(c, true); });
    this.h.on('[data-del]', (el) => {
      const id = el.dataset.del!;
      if (this.confirm !== `del:${id}`) { this.confirm = `del:${id}`; void this.showClips(); return; }
      this.confirm = '';
      void deleteClip(id).then(() => this.showClips('Deleted.'));
    });
  }
}

export { GROUP_NAME };
