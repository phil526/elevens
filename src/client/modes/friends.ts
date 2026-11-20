// Friends league on the client (20 Nov 2026): the leagues this device belongs to, kept in
// localStorage with every signed result it has seen (the match server has no lasting disk, so the
// members' devices are the league's memory), and the screens: your leagues, one league's table,
// results and members, and the buttons that open a league match.

import { leagueTable, mergeResults, LEAGUE, type LeagueInfo, type LeagueResult } from '../../shared/friends';
import { teamById } from '../../shared/teams';
import { clubBadge } from '../ui/badge';

const KEY = 'elevens.friends.v1';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface LocalLeague extends LeagueInfo {
  /** When this device last heard from the server about the league (0: never). */
  synced: number;
}

export function loadLeagues(): LocalLeague[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { leagues?: LocalLeague[] } | null;
    if (raw && Array.isArray(raw.leagues)) return raw.leagues.filter((l) => l && typeof l.code === 'string' && Array.isArray(l.results) && Array.isArray(l.members));
  } catch { /* none yet */ }
  return [];
}

export function saveLeagues(ls: LocalLeague[]) {
  try { localStorage.setItem(KEY, JSON.stringify({ leagues: ls })); } catch { /* storage blocked */ }
}

/** Take what the server sent: its members and name, and every result either side has. */
export function mergeLeague(ls: LocalLeague[], info: LeagueInfo, now = Date.now()): LocalLeague[] {
  const i = ls.findIndex((l) => l.code === info.code);
  const old = i >= 0 ? ls[i] : null;
  const next: LocalLeague = { code: info.code, name: info.name, members: info.members, results: mergeResults(old?.results ?? [], info.results), synced: now };
  return i >= 0 ? ls.map((l, k) => (k === i ? next : l)) : [...ls, next];
}

export function addResult(ls: LocalLeague[], code: string, r: LeagueResult): LocalLeague[] {
  return ls.map((l) => (l.code === code ? { ...l, results: mergeResults(l.results, [r]) } : l));
}

/** The results this device has that the server's copy lacks, in message-sized chunks. */
export function missingChunks(mine: LeagueResult[], server: LeagueResult[]): LeagueResult[][] {
  const have = new Set(server.map((r) => r.id));
  const miss = mine.filter((r) => !have.has(r.id));
  const out: LeagueResult[][] = [];
  for (let i = 0; i < miss.length; i += LEAGUE.chunk) out.push(miss.slice(i, i + LEAGUE.chunk));
  return out;
}

/** "1st", "2nd"… */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/** Your place in a league's table (1-based), or 0. */
export function placeIn(l: LeagueInfo, id: string): number {
  return leagueTable(l).findIndex((r) => r.id === id) + 1;
}

export function friendsListHtml(ls: LocalLeague[], me: string, status: string, error: string): string {
  const card = (l: LocalLeague) => {
    const t = leagueTable(l);
    const pos = t.findIndex((r) => r.id === me) + 1;
    return `<button class="btn league-card" data-lg="${l.code}"><b>${esc(l.name)}</b><small>${l.members.length} ${l.members.length === 1 ? 'player' : 'players'} · ${l.results.length} ${l.results.length === 1 ? 'match' : 'matches'}${pos ? ` · you are ${ordinal(pos)}` : ''} · code ${l.code}</small></button>`;
  };
  return `<div class="panel narrow friends">
    <h2>Friends league</h2>
    <p class="note">A league just for you and your friends. Make one and share its code; each friend joins with the code. League matches are online 1 v 1 matches you open from the league: 3 points for a win, 1 for a draw.</p>
    ${ls.length ? `<h3>Your leagues</h3><div class="stack">${ls.map(card).join('')}</div>` : ''}
    <h3>Make a league</h3>
    <div class="row"><input id="lgname" type="text" maxlength="24" placeholder="League name" style="flex:1;min-width:160px"><button class="btn primary" data-a="lgmake">Make league</button></div>
    <h3>Join a league</h3>
    <div class="row"><input id="lgcode" class="code" type="text" maxlength="6" placeholder="CODE" autocapitalize="characters"><button class="btn" data-a="lgjoin">Join league</button></div>
    <p class="err">${esc(error)}</p>
    <p class="note net-status">${esc(status)}</p>
    <div class="row end"><button class="btn" data-a="lgback">Back</button></div>
  </div>`;
}

export function leagueHtml(l: LocalLeague, me: string, link: string, status: string, error: string): string {
  const t = leagueTable(l);
  const form = (f: string[]) => f.map((o) => `<i class="form ${o}">${o}</i>`).join('');
  const table = t.length
    ? `<table class="ltable"><tr><th></th><th>Player</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th><th class="hide-narrow">Form</th></tr>${t.map((r, i) => `<tr class="${r.id === me ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gf - r.ga > 0 ? '+' : ''}${r.gf - r.ga}</td><td><b>${r.pts}</b></td><td class="hide-narrow">${form(r.form)}</td></tr>`).join('')}</table>`
    : '<p class="note">No players yet.</p>';
  const recent = [...l.results].reverse().slice(0, 8);
  const res = recent.length
    ? `<div class="lg-results">${recent.map((r) => `<div class="lg-res"><span>${clubBadge(teamById(r.ca), 16)} ${esc(r.an)}</span><b>${r.s[0]}–${r.s[1]}</b><span>${esc(r.bn)} ${clubBadge(teamById(r.cb), 16)}</span><small>${new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</small></div>`).join('')}</div>`
    : '<p class="note">No matches yet. Open a league match below and share the room code with a friend from the league.</p>';
  const lonely = l.members.length < 2;
  return `<div class="panel friends">
    <div class="row between"><h2>${esc(l.name)}</h2><span class="bigcode">${l.code}</span></div>
    <div class="row"><input type="text" readonly value="${esc(link)}" style="flex:1;min-width:200px;font-size:14px" id="lglink"><button class="btn small" data-a="lgcopy">Copy invite link</button></div>
    ${lonely ? '<p class="note">Share the code or link: friends join the league with it.</p>' : ''}
    <h3>Table</h3>${table}
    <h3>Latest results</h3>${res}
    <h3>League match</h3>
    <p class="note">Open a room and give its code to a friend from this league, or join their room. The result goes into the table at full time (online matches keep draws).</p>
    <div class="row"><button class="btn primary" data-a="lgplay">Open a league match</button></div>
    <div class="row" style="margin-top:8px"><input id="lgroom" class="code" type="text" maxlength="5" placeholder="ROOM" autocapitalize="characters"><button class="btn" data-a="lgroomjoin">Join their room</button></div>
    <p class="err">${esc(error)}</p>
    <p class="note net-status">${esc(status)}</p>
    <div class="row between"><button class="btn small" data-a="lgleave">Leave league</button><button class="btn" data-a="lglist">Back</button></div>
  </div>`;
}
