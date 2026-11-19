// Ranked online on the client (19 Nov 2026): this device's ranked identity (a random id and secret
// key, kept in localStorage; the server keeps only a hash of the key), the last record the server
// sent, and the ranked screen (division badge, points bar, record, leaderboard, club choice).

import { divisionName, divisionOf, divisionProgress, RANK, type RankedRecord } from '../../shared/ranked';
import { ALL_CLUBS, teamById, teamRatings } from '../../shared/teams';
import { clubBadge } from '../ui/badge';

const KEY = 'elevens.ranked.v1';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface RankedLocal {
  id: string; key: string; club: string; rec: RankedRecord | null; board: RankedRecord[];
  /** The server's signature of `rec`: lets a restarted server take the record back. */
  sig?: string;
}

const hex32 = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export function loadRanked(): RankedLocal {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RankedLocal | null;
    if (r && /^[a-f0-9]{32}$/.test(r.id) && /^[a-f0-9]{32}$/.test(r.key)) return { ...r, board: Array.isArray(r.board) ? r.board : [], club: ALL_CLUBS.some((t) => t.id === r.club) ? r.club : ALL_CLUBS[0].id };
  } catch { /* new identity */ }
  const fresh: RankedLocal = { id: hex32(), key: hex32(), club: ALL_CLUBS[0].id, rec: null, board: [] };
  saveRanked(fresh);
  return fresh;
}

export function saveRanked(r: RankedLocal) {
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* storage blocked: a new identity next time */ }
}

/** Division badge: a shield with the division number (or ELITE). */
export function divisionBadge(points: number, size = 64): string {
  const d = divisionOf(points);
  const tier = d === 0 ? 'elite' : d <= 3 ? 'gold' : d <= 6 ? 'silver' : 'bronze';
  return `<span class="div-badge ${tier}" style="width:${size}px;height:${Math.round(size * 1.15)}px"><b>${d === 0 ? '★' : d}</b><small>${d === 0 ? 'ELITE' : 'DIV'}</small></span>`;
}

export function rankedHtml(r: RankedLocal, status: string, queued: boolean, waiting: number, connected: boolean): string {
  const rec = r.rec;
  const pts = rec?.points ?? 0;
  const prog = divisionProgress(pts);
  const d = divisionOf(pts);
  const clubs = ALL_CLUBS.slice().sort((a, b) => teamRatings(b).ovr - teamRatings(a).ovr);
  return `<div class="panel mode-panel">
    <h2>Ranked online</h2>
    <p class="note">Play people of about your level and climb from Division 10 to Division 1, then Elite. A win earns about ${RANK.win} points (more against a stronger player), a draw ${RANK.draw}; a defeat costs ${RANK.loss}, and leaving a match counts as a defeat. ${RANK.perDivision} points take you up a division.</p>
    <div class="rank-card">
      ${divisionBadge(pts, 70)}
      <div class="rank-info">
        <b>${divisionName(pts)}</b>
        <div class="attr-bar rankbar"><i style="width:${d === 0 ? 100 : prog}%"></i></div>
        <span>${d === 0 ? `${prog} points above the Elite line` : `${prog}/${RANK.perDivision} points to Division ${d - 1 || 'Elite'}`.replace('Division Elite', 'Elite')}</span>
        <span>${rec ? `${rec.w} won · ${rec.d} drawn · ${rec.l} lost · best ${divisionName(rec.best)}` : 'Your record appears after you connect.'}</span>
      </div>
    </div>
    <h3>Your club</h3>
    <div class="grid4">${clubs.map((t) => `<button class="club mini ${r.club === t.id ? 'on' : ''}" data-rclub="${t.id}"><span class="abbr">${clubBadge(t, 26)} ${t.abbr} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(t.name)}</span></button>`).join('')}</div>
    <p class="note net-status">${esc(status)}${queued ? ` ${waiting > 1 ? `${waiting} players searching.` : 'Waiting for another player…'}` : ''}</p>
    ${r.board.length ? `<h3>Top players</h3><table class="ltable"><tr><th></th><th>Player</th><th>Division</th><th>Pts</th><th>W-D-L</th></tr>${r.board.map((x, i) => `<tr class="${x.id === r.id ? 'me' : ''}"><td>${i + 1}</td><td>${esc(x.name)}</td><td>${divisionName(x.points)}</td><td>${x.points}</td><td>${x.w}-${x.d}-${x.l}</td></tr>`).join('')}</table>` : ''}
    <div class="row end" style="margin-top:12px"><button class="btn" data-a="rback">Back</button>${queued ? '<button class="btn" data-a="rcancel">Stop searching</button>' : `<button class="btn primary" data-a="rfind" autofocus>${connected ? 'Find a match' : 'Connect and find a match'}</button>`}</div>
  </div>`;
}

/** The ranked note on the full-time panel. */
export function rankedResultHtml(res: { before: RankedRecord; after: RankedRecord; delta: number; opp: string }): string {
  const up = divisionOf(res.after.points) < divisionOf(res.before.points) || (divisionOf(res.after.points) === 0 && divisionOf(res.before.points) !== 0);
  const down = divisionOf(res.after.points) > divisionOf(res.before.points);
  return `<div class="mode-note rank-result">${divisionBadge(res.after.points, 40)}<div><b>${res.delta >= 0 ? '+' : ''}${res.delta} points</b> · ${divisionName(res.after.points)} (${res.after.points} pts)
    ${up ? `<p class="good">Promoted to ${divisionName(res.after.points)}!</p>` : down ? `<p>Down to ${divisionName(res.after.points)}.</p>` : ''}</div></div>`;
}

export const rankedClubName = (id: string) => teamById(id).name;
