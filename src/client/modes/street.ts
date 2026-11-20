// 5-a-side street football (20 Nov 2026): a quick match in a walled cage, five a side, no offside,
// the ball comes back off the boards. Pick your club and the opposition, then play. A small
// record of street results is kept per save slot.

import type { Difficulty } from '../../shared/config';
import { playableClubs, teamById } from '../../shared/teams';
import type { ViewState } from '../view';
import { clubBadge } from '../ui/badge';
import type { ModeMatch } from './screens';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface StreetHost {
  set(html: string, cls?: string): void;
  on(sel: string, fn: (el: HTMLElement) => void): void;
  seg(name: string, values: [string, string][], cur: string): string;
  bindSeg(name: string, fn: (v: string) => void): void;
  home(): void;
  play(m: ModeMatch): void;
  slot(): number;
  choice(): { club: string; difficulty: Difficulty };
}

export interface StreetRecord { p: number; w: number; d: number; l: number; gf: number; ga: number; best: [number, number] | null }
const blank = (): StreetRecord => ({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, best: null });
const key = (slot: number) => `elevens.street.v1.${slot}`;

/** Street matches are short: real minutes for the whole match. */
export const STREET_MINUTES = [2, 4, 6] as const;

/** Add a result to the record; the best win is the biggest margin (then the most goals). */
export function addStreetResult(r: StreetRecord, gf: number, ga: number): StreetRecord {
  const out = { ...r, p: r.p + 1, gf: r.gf + gf, ga: r.ga + ga };
  if (gf > ga) out.w++; else if (gf === ga) out.d++; else out.l++;
  if (gf > ga && (!r.best || gf - ga > r.best[0] - r.best[1] || (gf - ga === r.best[0] - r.best[1] && gf > r.best[0]))) out.best = [gf, ga];
  return out;
}

export class StreetScreens {
  rec: StreetRecord = blank();
  private slotNo = -1;
  private setup: { club: string; opp: string; difficulty: Difficulty; minutes: number } = { club: '', opp: '', difficulty: 'pro', minutes: 4 };
  private done: { html: string; label: string; next: () => void } | null = null;

  constructor(private h: StreetHost) {}

  private sync() {
    if (this.slotNo === this.h.slot()) return;
    this.slotNo = this.h.slot();
    let raw: unknown = null;
    try { raw = JSON.parse(localStorage.getItem(key(this.slotNo)) ?? 'null'); } catch { raw = null; }
    const r = raw as (Partial<StreetRecord> & { setup?: Partial<StreetScreens['setup']> }) | null;
    this.rec = { ...blank(), ...(r && typeof r.p === 'number' ? r : {}) } as StreetRecord;
    const st = r?.setup;
    if (st?.club && playableClubs().some((t) => t.id === st.club)) this.setup.club = st.club;
    if (st?.opp && playableClubs().some((t) => t.id === st.opp)) this.setup.opp = st.opp;
    if (st?.difficulty) this.setup.difficulty = st.difficulty;
    if (st?.minutes && (STREET_MINUTES as readonly number[]).includes(st.minutes)) this.setup.minutes = st.minutes;
  }

  private save() {
    try { localStorage.setItem(key(this.slotNo), JSON.stringify({ ...this.rec, setup: this.setup })); } catch { /* blocked */ }
  }

  static clear(slot: number) { try { localStorage.removeItem(key(slot)); } catch { /* blocked */ } }

  menuButton(): string {
    this.sync();
    const r = this.rec;
    return `<button class="btn" data-a="street">Street 5-a-side<small>${r.p ? `Played ${r.p} · won ${r.w}` : 'Five a side in a cage, no offside'}</small></button>`;
  }

  show() {
    this.sync();
    const s = this.setup;
    const clubs = playableClubs();
    if (!s.club || !clubs.some((t) => t.id === s.club)) s.club = this.h.choice().club;
    if (!s.opp || s.opp === s.club) s.opp = clubs.find((t) => t.id !== s.club)!.id;
    const r = this.rec;
    const card = (id: string, which: 'sclub' | 'sopp') => {
      const t = teamById(id);
      const on = (which === 'sclub' ? s.club : s.opp) === id;
      const off = which === 'sopp' && id === s.club;
      return `<button class="club mini ${on ? 'on' : ''}" data-${which}="${id}" ${off ? 'disabled' : ''}><span class="abbr">${clubBadge(t, 22)} ${esc(t.abbr)}</span><span class="name">${esc(t.name)}</span></button>`;
    };
    this.h.set(`<div class="panel street">
      <h2>Street 5-a-side</h2>
      <p class="note">Five a side in a floodlit cage: a keeper, two at the back, one in midfield and a striker. The ball comes back off the boards, so there are no throw-ins, corners or goal kicks, and there is no offside. Short and quick.</p>
      ${r.p ? `<p class="street-rec">Your street record: <b>${r.w}</b> won, <b>${r.d}</b> drawn, <b>${r.l}</b> lost · goals ${r.gf}–${r.ga}${r.best ? ` · best win ${r.best[0]}–${r.best[1]}` : ''}</p>` : ''}
      <h3>Your club</h3>
      <div class="grid4 street-clubs">${clubs.map((t) => card(t.id, 'sclub')).join('')}</div>
      <h3>Against</h3>
      <div class="grid4 street-clubs">${clubs.map((t) => card(t.id, 'sopp')).join('')}</div>
      <div class="field"><span class="lbl">Computer difficulty</span>${this.h.seg('sdiff', [['casual', 'Casual'], ['pro', 'Pro'], ['elite', 'Elite'], ['adaptive', 'Adaptive']], s.difficulty)}</div>
      <div class="field"><span class="lbl">Match length (real minutes)</span>${this.h.seg('smin', STREET_MINUTES.map((m) => [String(m), `${m}`]), String(s.minutes))}</div>
      <div class="row end" style="margin-top:16px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="sgo">Kick off</button></div>
    </div>`, 'scroll');
    this.h.on('[data-sclub]', (el) => { s.club = el.dataset.sclub!; if (s.opp === s.club) s.opp = ''; this.show(); });
    this.h.on('[data-sopp]', (el) => { s.opp = el.dataset.sopp!; this.show(); });
    this.h.bindSeg('sdiff', (v) => { s.difficulty = v as Difficulty; this.show(); });
    this.h.bindSeg('smin', (v) => { s.minutes = Number(v); this.show(); });
    this.h.on('[data-a=back]', () => this.h.home());
    this.h.on('[data-a=sgo]', () => { this.save(); this.done = null; this.h.play(this.matchFor()); });
  }

  matchFor(): ModeMatch {
    const s = this.setup;
    const diff = ({ casual: 'Casual', pro: 'Pro', elite: 'Elite', adaptive: 'Adaptive' } as Record<string, string>)[s.difficulty] ?? s.difficulty;
    return {
      kind: 'street', club: s.club, opp: s.opp, overrides: [], draw: 'stand', minutes: s.minutes, difficulty: s.difficulty,
      // Street: the cage, five a side; dry and still (the cage has a roof net), no injuries or tunnel walk-out.
      patch: { street: true, injuries: false, weather: { kind: 'clear', wind: 0, windDir: 0 }, momentum: false },
      detail: `Street 5-a-side · ${diff} · ${s.minutes} min`, intro: false,
    };
  }

  /** Full time: the result goes into the street record (once), and Continue goes back to the street screen. */
  finish(v: ViewState): { html: string; label: string; next: () => void } {
    if (this.done) return this.done;
    this.sync();
    const gf = v.score[0], ga = v.score[1];
    const before = this.rec.best;
    this.rec = addStreetResult(this.rec, gf, ga);
    this.save();
    const r = this.rec;
    const best = gf > ga && this.rec.best !== before && r.w > 1 ? ' That is your best street win.' : '';
    const html = `<div class="mode-note"><p>Street record: ${r.w} won, ${r.d} drawn, ${r.l} lost.${best}</p></div>`;
    this.done = { html, label: 'Continue', next: () => { this.done = null; this.show(); } };
    return this.done;
  }
}
