// Broadcast graphics: a TV-style score bug, team line-ups before kick-off, lower-thirds for
// goals and the odd match stat, and the half-time / full-time stats graphic with bars in the
// club colours. All DOM and CSS (no canvas), so it costs nothing on the GPU.

import { minuteText } from '../../shared/snapshot';
import type { MatchEvent, TeamStats } from '../../shared/types';
import type { ViewState } from '../view';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Text colour that reads on a club colour. */
const ink = (c: number) => (((c >> 16) & 255) * 0.299 + ((c >> 8) & 255) * 0.587 + (c & 255) * 0.114 > 150 ? '#0b0f14' : '#ffffff');
const ROLE_ORDER: Record<string, number> = { GK: 0, RB: 1, RCB: 2, LCB: 3, LB: 4, CDM: 5, RCM: 6, LCM: 7, RW: 8, ST: 9, LW: 10 };

const CSS = `
.tvhud .scorebug { background: linear-gradient(180deg, #1b2230 0%, #0c1018 100%); border-radius: 3px; border-top: 2px solid var(--accent, #3ee08f); box-shadow: 0 6px 18px #0008; }
.tvhud .scorebug .tm { font-weight: 800; letter-spacing: .08em; padding: 6px 12px; position: relative; }
.tvhud .scorebug .chip { width: 6px; height: 26px; border-radius: 1px; border: none; }
.tvhud .scorebug .sc { background: #f4f6f8; color: #0b0f14; font-weight: 900; padding: 6px 14px; font-variant-numeric: tabular-nums; min-width: 78px; }
.tvhud .scorebug .clk { background: #0b0e14; font-weight: 700; }
.tvhud .scorebug .half { color: var(--accent, #3ee08f); font-weight: 800; }
.tvhud .scorebug.tv-scored .sc { animation: tvPulse 0.9s ease-in-out 4; }
@keyframes tvPulse { 50% { background: var(--accent, #3ee08f); } }
.tv-ticker { position: absolute; top: calc(56px + var(--safe-t, 0px)); left: calc(12px + var(--safe-l, 0px)); display: flex; flex-direction: column; gap: 2px; pointer-events: none; }
.tv-ticker div { background: rgba(11, 15, 20, 0.88); border-left: 4px solid var(--c); padding: 3px 10px; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; animation: tvIn .35s ease-out; }
.tv-l3 { position: absolute; left: 50%; bottom: calc(158px + var(--safe-b, 0px)); transform: translateX(-50%); display: flex; align-items: stretch; min-width: min(560px, 92vw); max-width: 92vw; pointer-events: none; opacity: 0; transition: opacity .3s, transform .35s; }
.tv-l3.show { opacity: 1; transform: translateX(-50%) translateY(-6px); }
body.touch .tv-l3 { bottom: auto; top: calc(60px + var(--safe-t, 0px)); min-width: min(460px, 60vw); max-width: 60vw; }
.tv-l3 .tag { background: var(--c); color: var(--ci); font-weight: 900; letter-spacing: .12em; padding: 10px 14px; display: flex; align-items: center; font-size: 18px; }
.tv-l3 .body { flex: 1; background: linear-gradient(90deg, #121824, #0b0f14); padding: 7px 14px; border-top: 2px solid var(--accent, #3ee08f); }
.tv-l3 .body b { display: block; font-size: 20px; letter-spacing: .06em; text-transform: uppercase; }
.tv-l3 .body small { color: #b8c2d0; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
.tv-l3 .bar { display: flex; height: 8px; margin-top: 5px; border-radius: 2px; overflow: hidden; }
@keyframes tvIn { from { transform: translateX(-12px); opacity: 0; } }
.tv-lineups { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; z-index: 5; }
.tv-lineups.show { display: flex; }
.tv-lu { width: min(980px, 96vw); max-height: 92vh; overflow: hidden; background: linear-gradient(180deg, rgba(16, 21, 31, 0.95), rgba(8, 11, 16, 0.95)); border-top: 3px solid var(--accent, #3ee08f); border-radius: 4px; box-shadow: 0 18px 50px #000a; animation: tvRise .45s ease-out; }
@keyframes tvRise { from { transform: translateY(18px); opacity: 0; } }
.tv-lu header { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 16px 6px; letter-spacing: .12em; text-transform: uppercase; }
.tv-lu header b { font-size: 20px; font-weight: 900; }
.tv-lu header span { color: #b8c2d0; font-size: 13px; }
.tv-lu .cols { display: grid; grid-template-columns: 1fr 1.25fr 1fr; gap: 10px; padding: 4px 14px 12px; }
.tv-lu .team h4 { margin: 0 0 6px; padding: 6px 10px; background: var(--c); color: var(--ci); letter-spacing: .1em; font-size: 15px; text-transform: uppercase; display: flex; justify-content: space-between; }
.tv-lu .team h4 small { opacity: .8; font-weight: 600; }
.tv-lu .pl { display: grid; grid-template-columns: 30px 1fr 34px; align-items: center; padding: 3px 8px; font-size: 14px; letter-spacing: .04em; border-bottom: 1px solid #ffffff12; animation: tvIn .3s ease-out backwards; }
.tv-lu .pl i { font-style: normal; font-weight: 900; color: var(--accent, #3ee08f); }
.tv-lu .pl em { font-style: normal; color: #8e9aac; font-size: 11px; text-align: right; }
.tv-lu .pitch { position: relative; background: repeating-linear-gradient(90deg, #2f7a3a 0 9.09%, #2a7034 9.09% 18.18%); border: 2px solid #ffffffb0; border-radius: 3px; aspect-ratio: 105 / 68; align-self: center; }
.tv-lu .pitch::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; border-left: 2px solid #ffffffb0; }
.tv-lu .pitch::after { content: ''; position: absolute; left: 50%; top: 50%; width: 17%; aspect-ratio: 1; border: 2px solid #ffffffb0; border-radius: 50%; transform: translate(-50%, -50%); }
.tv-lu .dot { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: var(--c); color: var(--ci); font: 800 10px/20px system-ui, sans-serif; text-align: center; border: 1px solid #0008; z-index: 1; }
.tv-lu footer { height: 3px; background: #ffffff14; }
.tv-lu footer i { display: block; height: 100%; width: 0; background: var(--accent, #3ee08f); }
.tv-lu .skip { text-align: center; color: #8e9aac; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; padding: 0 0 8px; }
@media (max-width: 760px) { .tv-lu .cols { grid-template-columns: 1fr 1fr; } .tv-lu .pitch { display: none; } .tv-lu .pl { font-size: 12px; padding: 2px 6px; } }
@media (max-height: 520px) { .tv-lu .pl { padding: 1px 8px; font-size: 12px; } .tv-lu header { padding: 6px 12px 4px; } }
.tvstats { margin: 10px 0; }
.tvstats .r { display: grid; grid-template-columns: 56px 1fr 56px; align-items: center; gap: 8px; margin: 7px 0; }
.tvstats .v { font-weight: 900; font-size: 18px; font-variant-numeric: tabular-nums; text-align: center; }
.tvstats .mid { text-align: center; }
.tvstats .mid small { display: block; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #b8c2d0; margin-bottom: 3px; }
.tvstats .bar { display: flex; gap: 2px; height: 7px; }
.tvstats .bar i { display: block; height: 100%; border-radius: 2px; transition: width .6s ease-out; }
.tvstats .r.big .bar { height: 12px; }
.tvstats .r.big .v { font-size: 22px; }
.tvstats .head { display: grid; grid-template-columns: 1fr 1fr; font-weight: 900; letter-spacing: .1em; font-size: 13px; }
.tvstats .head span:last-child { text-align: right; }
.tvstats .head i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: var(--c); margin: 0 6px; vertical-align: -1px; }
`;

/** Team stats as a TV graphic: each stat with both values and a bar split in the club colours. */
export function statsGraphic(v: ViewState): string {
  const [a, b] = v.stats as [TeamStats, TeamStats];
  const k0 = v.teams[0][v.kits[0]].shirt, k1 = v.teams[1][v.kits[1]].shirt;
  // Two clubs in similar colours: the away side's bar is drawn in its second colour.
  const c1 = Math.abs(k0 - k1) < 0x202020 ? v.teams[1][v.kits[1]].shorts : k1;
  const pt = a.possessionTicks + b.possessionTicks || 1;
  const pa = Math.round((100 * a.possessionTicks) / pt);
  const pct = (c: number, n: number) => (n ? `${Math.round((100 * c) / n)}%` : '–');
  const rows: [string, number, number, string?, string?][] = [
    ['Possession', pa, 100 - pa, `${pa}%`, `${100 - pa}%`],
    ['Shots', a.shots, b.shots], ['On target', a.onTarget, b.onTarget],
    ['Pass accuracy', a.passes ? a.passesCompleted / a.passes : 0, b.passes ? b.passesCompleted / b.passes : 0, pct(a.passesCompleted, a.passes), pct(b.passesCompleted, b.passes)],
    ['Passes', a.passes, b.passes], ['Tackles', a.tackles, b.tackles], ['Corners', a.corners, b.corners],
    ['Fouls', a.fouls, b.fouls], ['Offsides', a.offsides, b.offsides], ['Saves', a.saves, b.saves],
    ['Yellow cards', a.yellows ?? 0, b.yellows ?? 0], ['Red cards', a.reds ?? 0, b.reds ?? 0],
  ];
  const row = ([name, x, y, tx, ty]: (typeof rows)[number], i: number) => {
    const sum = x + y;
    const wx = sum > 0 ? (100 * x) / sum : 50;
    return `<div class="r${i === 0 ? ' big' : ''}"><span class="v">${tx ?? x}</span><div class="mid"><small>${name}</small><div class="bar"><i style="width:${wx.toFixed(1)}%;background:${hex(k0)}"></i><i style="width:${(100 - wx).toFixed(1)}%;background:${hex(c1)}"></i></div></div><span class="v">${ty ?? y}</span></div>`;
  };
  const skip = new Set(['Red cards', 'Offsides', 'Saves']);
  return `<div class="tvstats"><div class="head"><span><i style="--c:${hex(k0)}"></i>${esc(v.teams[0].abbr)}</span><span>${esc(v.teams[1].abbr)}<i style="--c:${hex(c1)}"></i></span></div>${rows.filter(([n, x, y]) => !skip.has(n) || x + y > 0).map(row).join('')}</div>`;
}

interface L3 { tag: string; colour: number; title: string; sub: string; bar?: [number, number, number, number]; ms: number }

/** Owns the broadcast overlays during a match. */
export class TvGraphics {
  /** Line-ups before kick-off and lower-thirds can be switched off in Settings; the score bug style stays. */
  enabled = true;
  private lineupsEl: HTMLDivElement;
  private l3: HTMLDivElement;
  private ticker: HTMLDivElement;
  private bug: HTMLElement | null;
  private l3Queue: L3[] = [];
  private l3Until = 0;
  private now = 0;
  private pendingGoal: L3 | null = null;
  private statsShown = new Set<number>();
  private lu: { t: number; dur: number; hold: boolean; done: () => void } | null = null;
  private tickerItems: { el: HTMLElement; until: number }[] = [];

  constructor(hud: HTMLElement) {
    if (!document.getElementById('tvgfx-css')) {
      const st = document.createElement('style');
      st.id = 'tvgfx-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    hud.classList.add('tvhud');
    this.bug = hud.querySelector('.scorebug');
    this.l3 = document.createElement('div');
    this.l3.className = 'tv-l3';
    this.ticker = document.createElement('div');
    this.ticker.className = 'tv-ticker';
    hud.append(this.l3, this.ticker);
    this.lineupsEl = document.createElement('div');
    this.lineupsEl.className = 'tv-lineups';
    document.body.insertBefore(this.lineupsEl, document.getElementById('ui'));
  }

  /** True while the line-ups hold the match (any button skips). */
  get holding() {
    return !!this.lu?.hold;
  }

  /** A new match (or back to the menus). */
  reset() {
    this.l3Queue = [];
    this.pendingGoal = null;
    this.statsShown.clear();
    this.l3.classList.remove('show');
    this.l3Until = 0;
    for (const t of this.tickerItems) t.el.remove();
    this.tickerItems = [];
    this.endLineups();
  }

  /**
   * The starting line-ups, with a mini pitch of where everyone stands for kick-off. `hold`
   * pauses the match until it finishes or is skipped (offline); online it just shows.
   */
  showLineups(v: ViewState, opts: { hold: boolean; venue: string; weather: string; done?: () => void }) {
    const team = (t: 0 | 1) => {
      const kit = v.teams[t][v.kits[t]];
      const ps = v.players.filter((p) => p.team === t && !p.off).sort((a, b) => (ROLE_ORDER[a.role] ?? 5) - (ROLE_ORDER[b.role] ?? 5));
      return `<div class="team" style="--c:${hex(kit.shirt)};--ci:${ink(kit.shirt)}"><h4>${esc(v.teams[t].name)}<small>${t === 0 ? 'Home' : 'Away'}</small></h4>${ps.map((p, i) => `<div class="pl" style="animation-delay:${(0.15 + i * 0.05).toFixed(2)}s"><i>${p.def.number}</i><span>${esc(p.def.short)}</span><em>${p.role}</em></div>`).join('')}</div>`;
    };
    const dots = v.players.filter((p) => !p.off).map((p) => {
      const kit = v.teams[p.team][v.kits[p.team]];
      const c = p.role === 'GK' ? kit.keeper : kit.shirt;
      const x = 50 + (p.pos.x / 105) * 100, y = 50 + (p.pos.z / 68) * 100;
      return `<span class="dot" style="left:${Math.max(2, Math.min(98, x)).toFixed(1)}%;top:${Math.max(3, Math.min(97, y)).toFixed(1)}%;--c:${hex(c)};--ci:${ink(c)}">${p.def.number}</span>`;
    }).join('');
    this.lineupsEl.innerHTML = `<div class="tv-lu"><header><b>Team line-ups</b><span>${esc(opts.venue)} · ${esc(opts.weather)}</span></header><div class="cols">${team(0)}<div class="pitch">${dots}</div>${team(1)}</div>${opts.hold ? '<div class="skip">Press any button to kick off</div>' : ''}<footer><i></i></footer></div>`;
    this.lineupsEl.classList.add('show');
    this.lu = { t: 0, dur: opts.hold ? 9 : 7, hold: opts.hold, done: opts.done ?? (() => {}) };
  }

  /** How long the line-ups stay up (the stadium announcer reading them can ask for longer). */
  setLineupsLength(sec: number) {
    if (this.lu) this.lu.dur = Math.max(this.lu.dur, sec);
  }

  /** Skip the line-ups. */
  skip() {
    if (this.lu) this.endLineups();
  }

  private endLineups() {
    const lu = this.lu;
    this.lu = null;
    this.lineupsEl.classList.remove('show');
    this.lineupsEl.innerHTML = '';
    lu?.done();
  }

  /** Called every frame with real time, while a match (or its intro) runs. */
  tick(dt: number) {
    this.now += dt;
    if (this.lu) {
      this.lu.t += dt;
      const bar = this.lineupsEl.querySelector('footer i') as HTMLElement | null;
      if (bar) bar.style.width = `${Math.min(100, (100 * this.lu.t) / this.lu.dur).toFixed(1)}%`;
      if (this.lu.t >= this.lu.dur) this.endLineups();
    }
  }

  onEvents(v: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      if (e.type === 'goal' && !v.shootout && e.team !== undefined && e.team >= 0) {
        const p = e.player !== undefined && e.player >= 0 ? v.players[e.player] : null;
        const kit = v.teams[e.team][v.kits[e.team]];
        const og = e.text === 'og';
        const tally = p && !og ? v.goals.filter((g) => g.player === p.id && !g.ownGoal).length : 0;
        const min = minuteText(v.clock, v.half);
        const g: L3 = {
          tag: 'GOAL', colour: kit.shirt,
          title: p ? `${p.def.short}${og ? ' (own goal)' : ''}` : v.teams[e.team].name,
          sub: `${v.teams[e.team].name} · ${min}${tally >= 3 ? ' · hat-trick!' : tally === 2 ? ' · second goal' : ''} · ${v.teams[0].abbr} ${v.score[0]}–${v.score[1]} ${v.teams[1].abbr}`,
          ms: 5200,
        };
        // Shown when play restarts (after the celebration and any replay), as on TV.
        this.pendingGoal = g;
        this.addTicker(kit.shirt, `⚽ ${min} ${p ? p.def.short : ''}${og ? ' (og)' : ''}`);
        this.bug?.classList.add('tv-scored');
        window.setTimeout(() => this.bug?.classList.remove('tv-scored'), 3800);
      } else if ((e.type === 'kickoff' || (e.type === 'restart' && e.text === 'kickoff')) && this.pendingGoal) {
        this.l3Queue.push(this.pendingGoal);
        this.pendingGoal = null;
      } else if (e.type === 'card' && e.text !== 'yellow' && e.player !== undefined && e.player >= 0) {
        const p = v.players[e.player];
        this.l3Queue.push({ tag: 'RED', colour: 0xd7263d, title: `#${p.def.number} ${p.def.short}`, sub: `${v.teams[p.team].name} · ${e.text === 'second' ? 'second yellow' : 'straight red'} · ${minuteText(v.clock, v.half)}`, ms: 4200 });
      }
    }
  }

  private addTicker(colour: number, text: string) {
    const el = document.createElement('div');
    el.style.setProperty('--c', hex(colour));
    el.textContent = text;
    this.ticker.appendChild(el);
    this.tickerItems.push({ el, until: this.now + 14 });
  }

  /** Every frame of play: lower-thirds, the ticker and the occasional stat. */
  update(v: ViewState) {
    if (!this.bug || !this.bug.isConnected) this.bug = document.querySelector('.tvhud .scorebug');
    for (const t of this.tickerItems) if (t.until < this.now) t.el.remove();
    this.tickerItems = this.tickerItems.filter((t) => t.until >= this.now);
    // A stat strip at quiet moments of each half (15', 30', 60', 75').
    if (this.enabled && v.phase === 'play' && !v.shootout) {
      const min = Math.floor(v.clock / 60);
      for (const at of [15, 30, 60, 75]) {
        if (min >= at && min < at + 3 && !this.statsShown.has(at)) {
          this.statsShown.add(at);
          this.l3Queue.push(this.statStrip(v, at));
        }
      }
    }
    if (this.l3Until && this.now > this.l3Until) {
      this.l3.classList.remove('show');
      this.l3Until = 0;
    }
    if (!this.l3Until && this.l3Queue.length && v.phase !== 'halftime' && v.phase !== 'fulltime') {
      const n = this.l3Queue.shift()!;
      if (!this.enabled && n.tag !== 'GOAL' && n.tag !== 'RED') return;
      this.showL3(n);
    }
  }

  private statStrip(v: ViewState, at: number): L3 {
    const [a, b] = v.stats as [TeamStats, TeamStats];
    const k0 = v.teams[0][v.kits[0]].shirt, k1 = v.teams[1][v.kits[1]].shirt;
    if (at === 15 || at === 60) {
      const pt = a.possessionTicks + b.possessionTicks || 1;
      const pa = Math.round((100 * a.possessionTicks) / pt);
      return { tag: 'STATS', colour: 0x3ee08f, title: `Possession  ${v.teams[0].abbr} ${pa}% – ${100 - pa}% ${v.teams[1].abbr}`, sub: at === 15 ? 'First 15 minutes' : 'Match so far', bar: [pa, k0, 100 - pa, k1], ms: 5200 };
    }
    return { tag: 'STATS', colour: 0x3ee08f, title: `Shots  ${v.teams[0].abbr} ${a.shots} (${a.onTarget}) – ${b.shots} (${b.onTarget}) ${v.teams[1].abbr}`, sub: 'Shots (on target)', bar: [a.shots || 1, k0, b.shots || 1, k1], ms: 5200 };
  }

  private showL3(n: L3) {
    const bar = n.bar ? `<div class="bar"><i style="width:${n.bar[0]}%;background:${hex(n.bar[1])}"></i><i style="width:${n.bar[2]}%;background:${hex(n.bar[3])}"></i></div>` : '';
    const total = n.bar ? n.bar[0] + n.bar[2] : 0;
    this.l3.innerHTML = `<div class="tag">${esc(n.tag)}</div><div class="body"><b>${esc(n.title)}</b><small>${esc(n.sub)}</small>${total ? bar.replace(/width:(\d+(\.\d+)?)%/g, (_m, w) => `width:${((100 * Number(w)) / total).toFixed(1)}%`) : ''}</div>`;
    this.l3.style.setProperty('--c', hex(n.colour));
    this.l3.style.setProperty('--ci', ink(n.colour));
    this.l3.classList.add('show');
    this.l3Until = this.now + n.ms / 1000;
  }
}
