// Match analysis (20 Nov 2026): what the full-time panel's "Match analysis" button shows. It is
// built on the client from the view and its events, so it works offline and online alike: a shot
// map with the expected-goals value of every shot, each side's heat map, your pass map, a momentum
// graph, and one coaching tip from the numbers.

import { PITCH } from '../shared/config';
import { xgFor, type ShotKind } from '../shared/xg';
import type { MatchEvent } from '../shared/types';
import type { ViewState } from './view';

export interface ShotDot { team: 0 | 1; player: number; x: number; z: number; xg: number; kind: ShotKind; goal: boolean; minute: number; at: number }
export interface PassLine { team: 0 | 1; x0: number; z0: number; x1: number; z1: number; ok: boolean }

/** Heat map grid over the pitch, in each team's own frame (attacking to the right). */
export const HEAT_X = 21, HEAT_Z = 13;
/** Momentum buckets: one per 5 football minutes (extra time adds more). */
const BUCKET = 5 * 60;

const PASS_KINDS = new Set(['pass', 'through', 'lob', 'cross', 'floated', 'whipped', 'lowcross', 'driven', 'lofted', 'clear', 'roll', 'throw', 'dropkick', 'punt', 'chip']);

export class MatchAnalysis {
  shots: ShotDot[] = [];
  passes: PassLine[] = [];
  heat: [number[], number[]] = [new Array(HEAT_X * HEAT_Z).fill(0), new Array(HEAT_X * HEAT_Z).fill(0)];
  /** Pressure per bucket for each team (time in the final third, plus xG). */
  pressure: [number[], number[]] = [[], []];
  private pending: { team: 0 | 1; kicker: number; x: number; z: number; t: number } | null = null;
  private lastOwner = -1;
  private lastClock = -1;
  private sampleAcc = 0;
  /** Seconds of match clock, counting every half (so buckets run on through extra time). */
  private elapsed = 0;
  active = false;

  reset(on: boolean) {
    this.shots = []; this.passes = [];
    this.heat = [new Array(HEAT_X * HEAT_Z).fill(0), new Array(HEAT_X * HEAT_Z).fill(0)];
    this.pressure = [[], []];
    this.pending = null; this.lastOwner = -1; this.lastClock = -1; this.sampleAcc = 0; this.elapsed = 0;
    this.active = on;
  }

  /** Converts a world point to a team's own frame (attacking +x). */
  private own(v: ViewState, team: 0 | 1, x: number, z: number) {
    const d = v.attackDir[team] || (team === 0 ? 1 : -1);
    return { x: x * d, z: z * d };
  }

  frame(v: ViewState, evs: MatchEvent[]) {
    if (!this.active || v.shootout) return;
    // Clock: count only while it runs (the clock restarts each half).
    if (this.lastClock >= 0 && v.clock > this.lastClock && v.clock - this.lastClock < 30) this.elapsed += v.clock - this.lastClock;
    const dClock = this.lastClock >= 0 && v.clock > this.lastClock ? Math.min(30, v.clock - this.lastClock) : 0;
    this.lastClock = v.clock;
    const playing = v.phase === 'play';
    const minute = Math.floor(v.clock / 60) + (v.half === 2 ? 45 : v.half === 3 ? 90 : v.half === 4 ? 105 : 0);
    for (const e of evs) this.event(v, e, minute);
    if (!playing) return;
    // Pass outcome: the next player to have the ball.
    const owner = v.ball.owner;
    if (owner !== this.lastOwner && owner >= 0) {
      const pd = this.pending;
      const op = v.players[owner];
      if (pd && op && owner !== pd.kicker) {
        const a = this.own(v, pd.team, pd.x, pd.z), b = this.own(v, pd.team, op.pos.x, op.pos.z);
        this.passes.push({ team: pd.team, x0: a.x, z0: a.z, x1: b.x, z1: b.z, ok: op.team === pd.team });
        this.pending = null;
      }
    }
    this.lastOwner = owner;
    // Heat and pressure, sampled from match time.
    this.sampleAcc += dClock;
    if (this.sampleAcc >= 4) {
      this.sampleAcc = 0;
      for (const p of v.players) {
        if (p.off || p.role === 'GK') continue;
        const t = p.team;
        const o = this.own(v, t, p.pos.x, p.pos.z);
        const gx = Math.min(HEAT_X - 1, Math.max(0, Math.floor(((o.x + PITCH.halfLength) / PITCH.length) * HEAT_X)));
        const gz = Math.min(HEAT_Z - 1, Math.max(0, Math.floor(((o.z + PITCH.halfWidth) / PITCH.width) * HEAT_Z)));
        this.heat[t][gz * HEAT_X + gx]++;
      }
      const bt = v.ball.lastTouchTeam;
      if (bt === 0 || bt === 1) {
        const o = this.own(v, bt as 0 | 1, v.ball.pos.x, v.ball.pos.z);
        if (o.x > PITCH.halfLength / 3) this.bump(bt as 0 | 1, 4 * (o.x > PITCH.halfLength - 18 ? 1.6 : 1));
      }
    }
  }

  private bump(team: 0 | 1, n: number) {
    const b = Math.floor(this.elapsed / BUCKET);
    for (const t of [0, 1] as const) while (this.pressure[t].length <= b) this.pressure[t].push(0);
    this.pressure[team][b] += n;
  }

  private event(v: ViewState, e: MatchEvent, minute: number) {
    if (e.team !== 0 && e.team !== 1) { if ((e.type === 'out' || e.type === 'offside' || e.type === 'foul') && this.pending) this.missed(v); return; }
    const team = e.team as 0 | 1;
    if (e.type === 'kick' && e.player !== undefined) {
      const p = v.players[e.player];
      const x = e.x ?? p?.pos.x ?? v.ball.pos.x, z = e.z ?? p?.pos.z ?? v.ball.pos.z;
      const o = this.own(v, team, x, z);
      const k = e.text ?? '';
      const fromSpot = v.restart?.type === 'penalty' || (Math.abs(Math.abs(o.x) - (PITCH.halfLength - PITCH.penaltySpot)) < 0.6 && Math.abs(o.z) < 0.6 && v.phase !== 'play');
      const shotKind: ShotKind | null = k === 'shot' ? (fromSpot ? 'pen' : 'shot') : k === 'volley' ? 'volley' : k === 'overhead' ? 'overhead'
        : k === 'header' && o.x > PITCH.halfLength - 18 && Math.abs(o.z) < 12 ? 'header' : null;
      if (shotKind) {
        const xg = xgFor(o.x, o.z, 1, shotKind);
        this.shots.push({ team, player: e.player, x: o.x, z: o.z, xg, kind: shotKind, goal: false, minute, at: performance.now() });
        this.bump(team, xg * 60);
        this.pending = null;
      } else if (PASS_KINDS.has(k)) {
        this.pending = { team, kicker: e.player, x, z, t: performance.now() };
      }
    } else if (e.type === 'goal') {
      // The last shot by the scoring side within a few seconds becomes a goal (own goals have none).
      const s = [...this.shots].reverse().find((x) => x.team === team && performance.now() - x.at < 9000 && !x.goal);
      if (s && e.text !== 'og') s.goal = true;
    } else if ((e.type === 'out' || e.type === 'offside' || e.type === 'foul') && this.pending) this.missed(v);
  }

  private missed(v: ViewState) {
    const pd = this.pending;
    if (!pd) return;
    const a = this.own(v, pd.team, pd.x, pd.z), b = this.own(v, pd.team, v.ball.pos.x, v.ball.pos.z);
    this.passes.push({ team: pd.team, x0: a.x, z0: a.z, x1: b.x, z1: b.z, ok: false });
    this.pending = null;
  }

  xg(team: 0 | 1) { return this.shots.filter((s) => s.team === team).reduce((n, s) => n + s.xg, 0); }

  /** One coaching tip for `me`, the most useful thing the numbers say. */
  tip(v: ViewState, me: 0 | 1): string {
    const mine = this.shots.filter((s) => s.team === me && s.kind !== 'pen');
    const far = mine.filter((s) => s.x < PITCH.halfLength - PITCH.penaltyAreaDepth).length;
    const passes = this.passes.filter((p) => p.team === me);
    const ok = passes.filter((p) => p.ok).length;
    const pct = passes.length ? ok / passes.length : 1;
    const xgMe = this.xg(me), xgThem = this.xg((1 - me) as 0 | 1);
    const goals = v.score[me], against = v.score[1 - me];
    const st = v.stats[me];
    const ticks = st.possessionTicks + v.stats[1 - me].possessionTicks;
    const poss = ticks > 1800 ? st.possessionTicks / ticks : 0.5; // 30 s of play before possession means anything
    if (mine.length >= 5 && far / mine.length > 0.55) return `${far} of your ${mine.length} shots came from outside the box (average ${(mine.reduce((n, s) => n + s.xg, 0) / mine.length).toFixed(2)} xG). Work the ball closer: a shot from inside the box is worth three or four from distance.`;
    if (passes.length >= 20 && pct < 0.68) return `Only ${Math.round(pct * 100)}% of your passes found a teammate. Look for the player with space before you press pass, and use shorter balls when you are pressed.`;
    if (xgMe > 1.6 && goals <= xgMe - 1.2) return `You created ${xgMe.toFixed(1)} expected goals but scored ${goals}. Try placed shots (hold the modifier) and aim for the corners when you are through on goal.`;
    if (xgThem > 1.5 && against <= xgThem - 1.2) return `They created ${xgThem.toFixed(1)} expected goals and scored ${against}: your keeper had a good day. Track runners back and switch to the man on the ball earlier.`;
    if (mine.length <= 3 && poss > 0.52) return `You had ${Math.round(poss * 100)}% of the ball but only ${mine.length} shot${mine.length === 1 ? '' : 's'}. Play through balls into the runners and get shots away when the keeper is exposed.`;
    if (poss < 0.4) return `They had the ball ${Math.round((1 - poss) * 100)}% of the time. Keep it longer: hold up play with shield and pass sideways before going forward.`;
    if (st.fouls >= 6) return `${st.fouls} fouls gave them chances. Jockey and contain instead of diving in, and only slide when you are sure.`;
    if (xgMe > xgThem + 0.8) return `A good performance: ${xgMe.toFixed(1)} expected goals to their ${xgThem.toFixed(1)}. Keep making chances like that.`;
    return `Expected goals ${xgMe.toFixed(1)} to ${xgThem.toFixed(1)}. Shots from inside the box and through balls behind the defence make the best chances.`;
  }
}

// ------------------------------------------------------------------ drawing

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The pitch outline as SVG (x right, z down), 105 x 68 user units with a margin. */
export function pitchSvg(inner: string, cls = ''): string {
  const W = PITCH.length, H = PITCH.width;
  const L = PITCH.halfLength, Wd = PITCH.halfWidth, pa = PITCH.penaltyAreaDepth, pw = PITCH.penaltyAreaHalfWidth, ga = PITCH.goalAreaDepth, gw = PITCH.goalAreaHalfWidth;
  const line = 'fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="0.4"';
  return `<svg class="an-pitch ${cls}" viewBox="${-L - 3} ${-Wd - 3} ${W + 6} ${H + 6}" preserveAspectRatio="xMidYMid meet" role="img">
    <rect x="${-L}" y="${-Wd}" width="${W}" height="${H}" fill="#2c6b39" />
    <rect x="${-L}" y="${-Wd}" width="${W}" height="${H}" ${line} />
    <line x1="0" y1="${-Wd}" x2="0" y2="${Wd}" ${line} /><circle cx="0" cy="0" r="${PITCH.centreCircleRadius}" ${line} />
    <rect x="${-L}" y="${-pw}" width="${pa}" height="${pw * 2}" ${line} /><rect x="${L - pa}" y="${-pw}" width="${pa}" height="${pw * 2}" ${line} />
    <rect x="${-L}" y="${-gw}" width="${ga}" height="${gw * 2}" ${line} /><rect x="${L - ga}" y="${-gw}" width="${ga}" height="${gw * 2}" ${line} />
    <rect x="${-L - 1.5}" y="${-PITCH.goalHalfWidth}" width="1.5" height="${PITCH.goalHalfWidth * 2}" fill="rgba(255,255,255,0.7)" /><rect x="${L}" y="${-PITCH.goalHalfWidth}" width="1.5" height="${PITCH.goalHalfWidth * 2}" fill="rgba(255,255,255,0.7)" />
    ${inner}</svg>`;
}

export type AnalysisTab = 'shots' | 'heat' | 'passes' | 'momentum';

/** The analysis panel body for one tab. `me` is the local side (passes and the tip are theirs). */
export function analysisHtml(a: MatchAnalysis, v: ViewState, tab: AnalysisTab, me: 0 | 1, heatTeam: 0 | 1): string {
  const col = (t: 0 | 1) => hex(v.teams[t][v.kits[t]].shirt === 0xffffff && t === 1 ? 0xdddddd : v.teams[t][v.kits[t]].shirt);
  const name = (t: 0 | 1) => esc(v.teams[t].abbr);
  const xg = [a.xg(0), a.xg(1)];
  const head = `<div class="an-xg"><span><i style="background:${col(0)}"></i>${name(0)} <b>${v.score[0]}</b> <small>xG ${xg[0].toFixed(2)}</small></span><span><small>xG ${xg[1].toFixed(2)}</small> <b>${v.score[1]}</b> ${name(1)}<i style="background:${col(1)}"></i></span></div>`;
  let body = '';
  if (tab === 'shots') {
    // Team 0 attacks right, team 1 attacks left (mirror team 1's own frame).
    const dots = a.shots.map((s) => {
      const x = s.team === 0 ? s.x : -s.x, z = s.team === 0 ? s.z : -s.z;
      const r = 0.9 + Math.sqrt(s.xg) * 3.2;
      return `<circle cx="${x.toFixed(1)}" cy="${z.toFixed(1)}" r="${r.toFixed(2)}" fill="${s.goal ? col(s.team) : 'rgba(0,0,0,0.25)'}" stroke="${col(s.team)}" stroke-width="0.6"><title>${esc(v.players[s.player]?.def.short ?? '')} ${s.minute}' · ${s.kind} · xG ${s.xg.toFixed(2)}${s.goal ? ' · GOAL' : ''}</title></circle>`;
    }).join('');
    const big = (t: 0 | 1) => a.shots.filter((s) => s.team === t && s.xg >= 0.3).length;
    body = `${pitchSvg(dots)}<p class="note">Bigger circles were better chances; filled circles are goals. ${name(0)} shoot right, ${name(1)} shoot left. Big chances: ${name(0)} ${big(0)}, ${name(1)} ${big(1)}.</p>`;
  } else if (tab === 'heat') {
    const h = a.heat[heatTeam];
    const max = Math.max(1, ...h);
    const cw = PITCH.length / HEAT_X, ch = PITCH.width / HEAT_Z;
    const c = col(heatTeam);
    const cells = h.map((n, i) => n ? `<rect x="${(-PITCH.halfLength + (i % HEAT_X) * cw).toFixed(2)}" y="${(-PITCH.halfWidth + Math.floor(i / HEAT_X) * ch).toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" fill="${c}" fill-opacity="${(0.08 + 0.8 * (n / max) ** 0.8).toFixed(2)}" />` : '').join('');
    body = `<div class="seg an-heat-team">${([0, 1] as const).map((t) => `<button class="${t === heatTeam ? 'on' : ''}" data-heat="${t}">${name(t)}</button>`).join('')}</div>${pitchSvg(cells)}<p class="note">Where ${name(heatTeam)}'s outfield players spent the match, attacking to the right.</p>`;
  } else if (tab === 'passes') {
    const mine = a.passes.filter((p) => p.team === me);
    const ok = mine.filter((p) => p.ok).length;
    const lines = mine.map((p) => `<line x1="${p.x0.toFixed(1)}" y1="${p.z0.toFixed(1)}" x2="${p.x1.toFixed(1)}" y2="${p.z1.toFixed(1)}" stroke="${p.ok ? '#7be38a' : '#ff7a6b'}" stroke-opacity="${p.ok ? 0.55 : 0.75}" stroke-width="0.45" marker-end="url(#an-arrow-${p.ok ? 'ok' : 'bad'})" />`).join('');
    const defs = `<defs><marker id="an-arrow-ok" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#7be38a" /></marker><marker id="an-arrow-bad" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#ff7a6b" /></marker></defs>`;
    const fwd = mine.filter((p) => p.ok && p.x1 - p.x0 > 8).length;
    body = `${pitchSvg(defs + lines)}<p class="note">${name(me)}'s passes, attacking to the right: green found a teammate, red did not. ${ok} of ${mine.length} completed${mine.length ? ` (${Math.round((ok / mine.length) * 100)}%)` : ''}, ${fwd} of them forward by 8 m or more.</p>`;
  } else {
    const n = Math.max(a.pressure[0].length, a.pressure[1].length, 1);
    const vals = Array.from({ length: n }, (_, i) => (a.pressure[0][i] ?? 0) - (a.pressure[1][i] ?? 0));
    const max = Math.max(8, ...vals.map(Math.abs));
    const bw = 100 / n;
    const bars = vals.map((x, i) => {
      const h = (Math.abs(x) / max) * 38;
      return `<rect x="${(i * bw + bw * 0.12).toFixed(2)}" y="${x >= 0 ? (40 - h).toFixed(2) : '40'}" width="${(bw * 0.76).toFixed(2)}" height="${h.toFixed(2)}" fill="${x >= 0 ? col(0) : col(1)}" rx="0.6" />`;
    }).join('');
    const goals = v.goals.map((g) => {
      const mins = g.minute + (g.added ?? 0);
      const xpos = Math.min(99, (mins * 60 / BUCKET) * bw);
      return `<text x="${xpos.toFixed(1)}" y="${g.team === 0 ? 6 : 78}" font-size="5" text-anchor="middle">⚽</text>`;
    }).join('');
    const marks = Array.from({ length: n + 1 }, (_, i) => i % 3 === 0 ? `<text x="${(i * bw).toFixed(1)}" y="86" font-size="4" fill="rgba(255,255,255,0.6)" text-anchor="middle">${i * 5}'</text>` : '').join('');
    body = `<svg class="an-momentum" viewBox="-2 0 104 90" preserveAspectRatio="none" role="img"><line x1="0" y1="40" x2="100" y2="40" stroke="rgba(255,255,255,0.4)" stroke-width="0.3" />${bars}${goals}${marks}</svg>
      <p class="note">Who was on top, five minutes at a time: bars above the line are ${name(0)}'s pressure (time near goal and chances), below are ${name(1)}'s.</p>`;
  }
  return `${head}${body}<div class="an-tip"><b>Coach's tip</b><span>${esc(a.tip(v, me))}</span></div>`;
}
