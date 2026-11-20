// World tournament screens (20 Nov 2026): pick a nation, then the group tables, the knockout
// bracket and your next match. The results go into the tournament (kept per save slot); winning
// the final puts the trophy in the profile's cabinet.

import type { Difficulty } from '../../shared/config';
import { MATCH } from '../../shared/config';
import { scoreText, type Fixture } from '../../shared/competition';
import { teamById, teamRatings } from '../../shared/teams';
import {
  GROUP_NAMES, KO_ROUNDS, NATION_SPECS, groupOf, groupTable, isTournament, myTourFixture, nationSpec, newTournament, recordTourResult, stageName, tourOpponent,
  type NationSpec, type Tournament,
} from '../../shared/tournament';
import type { ViewState } from '../view';
import { clubBadge } from '../ui/badge';
import type { ModeMatch } from './screens';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** A nation's flag as inline SVG (3:2). */
export function flagSvg(id: string, w = 30): string {
  const n = nationSpec(id);
  if (!n) return clubBadge(teamById(id), Math.round(w * 0.8));
  const [a, b, c] = n.flag.colours.map(hex);
  const h = Math.round(w * 2 / 3);
  let body = '';
  switch (n.flag.pattern) {
    case 'tri-v': body = `<rect width="10" height="20" fill="${a}"/><rect x="10" width="10" height="20" fill="${b}"/><rect x="20" width="10" height="20" fill="${c}"/>`; break;
    case 'tri-h': body = `<rect width="30" height="6.67" fill="${a}"/><rect y="6.67" width="30" height="6.67" fill="${b}"/><rect y="13.33" width="30" height="6.67" fill="${c}"/>`; break;
    case 'bi-h': body = `<rect width="30" height="10" fill="${a}"/><rect y="10" width="30" height="10" fill="${b}"/>`; break;
    case 'bi-v': body = `<rect width="15" height="20" fill="${a}"/><rect x="15" width="15" height="20" fill="${b}"/>`; break;
    case 'nordic': body = `<rect width="30" height="20" fill="${a}"/><rect x="8" width="4" height="20" fill="${b}"/><rect y="8" width="30" height="4" fill="${b}"/><rect x="9" width="2" height="20" fill="${c}"/><rect y="9" width="30" height="2" fill="${c}"/>`; break;
    case 'diag': body = `<rect width="30" height="20" fill="${a}"/><path d="M0 20 L30 0 L30 6 L9 20 Z" fill="${b}"/><path d="M0 20 L30 0 L30 3 L4.5 20 Z" fill="${c}"/>`; break;
    case 'star': body = `<rect width="30" height="20" fill="${a}"/><path d="M15 4 L16.8 9.2 L22.4 9.3 L17.9 12.6 L19.6 17.9 L15 14.7 L10.4 17.9 L12.1 12.6 L7.6 9.3 L13.2 9.2 Z" fill="${b}"/>`; break;
    case 'band': body = `<rect width="30" height="20" fill="${a}"/><rect y="7" width="30" height="6" fill="${b}"/>`; break;
    case 'canton': body = `<rect width="30" height="20" fill="${a}"/><rect y="10" width="30" height="10" fill="${b}"/><rect width="12" height="10" fill="${c}"/><circle cx="6" cy="5" r="2.2" fill="${a}"/>`; break;
    case 'saltire': body = `<rect width="30" height="20" fill="${a}"/><path d="M0 0 L30 20 M30 0 L0 20" stroke="${b}" stroke-width="4"/><circle cx="15" cy="10" r="3" fill="${c}"/>`; break;
  }
  return `<svg class="flag" width="${w}" height="${h}" viewBox="0 0 30 20" aria-hidden="true">${body}<rect width="30" height="20" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"/></svg>`;
}

export interface TourHost {
  set(html: string, cls?: string): void;
  on(sel: string, fn: (el: HTMLElement) => void): void;
  seg(name: string, values: [string, string][], cur: string): string;
  bindSeg(name: string, fn: (v: string) => void): void;
  home(): void;
  play(m: ModeMatch): void;
  slot(): number;
  choice(): { difficulty: Difficulty; minutes: number };
  /** The final is won: into the profile's trophy cabinet. */
  trophy(nation: string): void;
}

const key = (slot: number) => `elevens.tournament.v1.${slot}`;

export class TournamentScreens {
  t: Tournament | null = null;
  private slotNo = -1;
  private setup = { nation: 'n-halvaro', difficulty: 'pro' as Difficulty, minutes: 6 };
  private confirm = false;
  private done: { html: string; label: string; next: () => void } | null = null;
  private msg = '';

  constructor(private h: TourHost) { this.sync(); }

  sync() {
    if (this.slotNo === this.h.slot()) return;
    this.slotNo = this.h.slot();
    let raw: unknown = null;
    try { raw = JSON.parse(localStorage.getItem(key(this.slotNo)) ?? 'null'); } catch { raw = null; }
    const r = raw as { t?: unknown; difficulty?: Difficulty; minutes?: number } | null;
    this.t = r && isTournament(r.t) ? r.t : null;
    if (r?.difficulty) this.setup.difficulty = r.difficulty;
    if (r?.minutes) this.setup.minutes = r.minutes;
  }

  save() {
    try { localStorage.setItem(key(this.slotNo), JSON.stringify({ t: this.t, difficulty: this.setup.difficulty, minutes: this.setup.minutes })); } catch { /* blocked */ }
  }

  static clear(slot: number) { try { localStorage.removeItem(key(slot)); } catch { /* blocked */ } }

  menuButton(): string {
    this.sync();
    const t = this.t;
    const sub = t ? (t.champion ? (t.champion === t.nation ? '🏆 Champions' : 'Finished') : t.out ? 'Knocked out' : `${esc(teamById(t.nation).name)} · ${esc(stageName(t))}`) : '16 nations · groups and knockouts';
    return `<button class="btn" data-a="tour">World tournament<small>${sub}</small></button>`;
  }

  show() {
    this.sync();
    if (this.t) this.hub(); else this.setupScreen();
  }

  private setupScreen() {
    const s = this.setup;
    if (!s.difficulty) s.difficulty = this.h.choice().difficulty;
    const stars = (n: NationSpec) => '★'.repeat(Math.max(1, Math.round((n.strength + 5) / 2))) ;
    const card = (n: NationSpec) => {
      const t = teamById(n.id);
      return `<button class="club mini nation ${s.nation === n.id ? 'on' : ''}" data-nation="${n.id}"><span class="abbr">${flagSvg(n.id, 30)} ${n.abbr} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(n.name)}</span><span class="style">${esc(n.style)}</span><span class="pstyle">${stars(n)}</span></button>`;
    };
    this.h.set(`<div class="panel">
      <h2>World tournament</h2>
      <p class="note">Sixteen nations, four groups of four. Play everyone in your group once; the top two reach the quarter-finals. Then the semi-finals and the final, with extra time and penalties if it's level. All the nations are made up.</p>
      <h3>Your nation</h3>
      <div class="grid4">${NATION_SPECS.slice().sort((a, b) => b.strength - a.strength).map(card).join('')}</div>
      <div class="field"><span class="lbl">Computer difficulty</span>${this.h.seg('tdiff', [['casual', 'Casual'], ['pro', 'Pro'], ['elite', 'Elite'], ['adaptive', 'Adaptive']], s.difficulty)}</div>
      <div class="field"><span class="lbl">Match length (real minutes)</span>${this.h.seg('tmin', MATCH.allowedRealMinutes.map((m) => [String(m), `${m}`]), String(s.minutes))}</div>
      <div class="row end" style="margin-top:16px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="tstart">Start the tournament</button></div>
    </div>`, 'scroll');
    this.h.on('[data-nation]', (el) => { s.nation = el.dataset.nation!; this.setupScreen(); });
    this.h.bindSeg('tdiff', (v) => { s.difficulty = v as Difficulty; this.setupScreen(); });
    this.h.bindSeg('tmin', (v) => { s.minutes = Number(v); this.setupScreen(); });
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-a=tstart]', () => {
      this.t = newTournament(s.nation, (Math.random() * 2 ** 31) | 0);
      this.msg = '';
      this.save();
      this.hub();
    });
  }

  private hub() {
    const t = this.t!;
    const me = teamById(t.nation);
    const name = (id: string) => `<span class="${id === t.nation ? 'me' : ''}">${flagSvg(id, 18)} ${esc(teamById(id).name)}</span>`;
    const fx = (f: Fixture) => `<div class="fx${f.home === t.nation || f.away === t.nation ? ' mine' : ''}">${name(f.home)}<b>${esc(scoreText(f))}</b>${name(f.away)}</div>`;
    const myG = groupOf(t, t.nation);
    const groups = t.groups.map((_, g) => {
      const rows = groupTable(t, g);
      return `<div class="tgroup${g === myG ? ' mine' : ''}"><h4>Group ${GROUP_NAMES[g]}</h4><table class="ltable"><tr><th></th><th>Nation</th><th>P</th><th>GD</th><th>Pts</th></tr>${rows.map((r, i) => `<tr class="${r.id === t.nation ? 'me' : ''}${i < 2 && t.stage >= 3 ? ' through' : ''}"><td>${i + 1}</td><td>${flagSvg(r.id, 18)} ${esc(teamById(r.id).name)}</td><td>${r.p}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td><b>${r.pts}</b></td></tr>`).join('')}</table></div>`;
    }).join('');
    const myDays = t.groupDays.map((d, i) => d.filter((f) => t.groups[myG].includes(f.home)).map(fx).join('') ? `<h4>Matchday ${i + 1}</h4>${d.filter((f) => t.groups[myG].includes(f.home)).map(fx).join('')}` : '').join('');
    const bracket = t.ko.length ? `<h3>Knockouts</h3><div class="bracket">${KO_ROUNDS.map((rn, i) => `<div class="bround"><h4>${rn}</h4>${(t.ko[i] ?? []).map(fx).join('') || '<p class="note">To be decided</p>'}</div>`).join('')}</div>` : '';
    const f = myTourFixture(t), opp = tourOpponent(t);
    const head = t.champion
      ? `<div class="comp-banner ${t.champion === t.nation ? 'win' : ''}">${t.champion === t.nation ? `🏆 ${esc(me.name)} are world champions!` : `${esc(teamById(t.champion).name)} win the tournament.`}</div>`
      : t.out ? `<div class="comp-banner">${esc(me.name)} are out.</div>`
      : f && opp ? `<div class="comp-next"><span class="lbl">${esc(stageName(t))}</span><div class="final small">${flagSvg(t.nation, 30)} ${esc(me.name)} v ${esc(teamById(opp).name)} ${flagSvg(opp, 30)}</div></div>` : '';
    this.h.set(`<div class="panel tour">
      <h2>${flagSvg(t.nation, 40)} World tournament</h2>
      ${head}${this.msg ? `<p class="mode-msg">${esc(this.msg)}</p>` : ''}
      <div class="tgroups">${groups}</div>
      ${t.stage < 3 ? `<h3>Your group</h3>${myDays}` : bracket}
      <div class="row end" style="margin-top:16px">
        <button class="btn" data-a="back">Main menu</button>
        <button class="btn danger" data-a="tnew">${this.confirm ? 'Sure? Press again' : t.champion || t.out ? 'New tournament' : 'Abandon'}</button>
        ${f ? '<button class="btn primary" data-a="tplay" autofocus>Play match</button>' : ''}
      </div>
    </div>`, 'scroll');
    this.h.on('[data-a=back]', () => { this.confirm = false; this.h.home(); });
    this.h.on('[data-a=tnew]', () => {
      if (!this.confirm && !t.champion && !t.out) { this.confirm = true; this.hub(); return; }
      this.confirm = false;
      this.setup.nation = t.nation;
      this.t = null;
      this.save();
      this.setupScreen();
    });
    this.h.on('[data-a=tplay]', () => { this.confirm = false; if (opp) this.h.play(this.matchFor()); });
  }

  /** The next match as a mode match (neutral ground: your nation is team 0). */
  matchFor(): ModeMatch {
    const t = this.t!;
    const opp = tourOpponent(t)!;
    const ko = t.stage >= 3;
    this.done = null;
    return {
      kind: 'tournament', club: t.nation, opp, overrides: [], draw: ko ? 'extra' : 'stand', minutes: this.setup.minutes, difficulty: this.setup.difficulty,
      patch: { injuries: true }, detail: `World tournament · ${stageName(t)}`, intro: true,
    };
  }

  /** Would this result win the final? (for the trophy ceremony) */
  winsFinal(v: ViewState): boolean {
    const t = this.t;
    if (!t || t.stage !== 5 || t.champion) return false;
    const so = v.shootout;
    const pens: [number, number] | undefined = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : undefined;
    return recordTourResult(t, v.score[0], v.score[1], pens, v.half > 2).champion === t.nation;
  }

  /** Full time: the result goes into the tournament once; the panel gets the news and Continue. */
  finish(v: ViewState): { html: string; label: string; next: () => void } | null {
    if (this.done) return this.done;
    const t = this.t;
    if (!t || !myTourFixture(t)) return null;
    const so = v.shootout;
    const pens: [number, number] | undefined = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : undefined;
    const before = t;
    const after = recordTourResult(before, v.score[0], v.score[1], pens, v.half > 2);
    this.t = after;
    this.save();
    const me = teamById(after.nation).name;
    const notes: string[] = [];
    if (after.champion === after.nation) { notes.push(`🏆 ${me} are world champions!`); this.h.trophy(after.nation); }
    else if (after.out && !before.out) notes.push(before.stage < 3 ? `${me} finish ${['first', 'second', 'third', 'fourth'][groupTable(after, groupOf(after, after.nation)).findIndex((r) => r.id === after.nation)]} in the group and go home.` : `${me} are knocked out in the ${KO_ROUNDS[before.stage - 3]?.toLowerCase() ?? 'knockouts'}.`);
    else if (after.stage === 3 && before.stage === 2) notes.push(`${me} are through to the quarter-finals!`);
    else if (after.stage < 3) {
      const rows = groupTable(after, groupOf(after, after.nation));
      notes.push(`Group ${GROUP_NAMES[groupOf(after, after.nation)]}: ${me} are ${['top', 'second', 'third', 'bottom'][rows.findIndex((r) => r.id === after.nation)]} with ${rows.find((r) => r.id === after.nation)?.pts ?? 0} points.`);
    } else if (!after.out) notes.push(`${me} are into the ${KO_ROUNDS[after.stage - 3]?.toLowerCase()}.`);
    const opp = tourOpponent(after);
    if (opp) notes.push(`Next: ${stageName(after)} v ${teamById(opp).name}.`);
    this.done = { html: `<div class="mode-note">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>`, label: 'Continue', next: () => this.show() };
    return this.done;
  }
}
