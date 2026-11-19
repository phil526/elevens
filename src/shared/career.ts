// Career mode (19 Nov 2026): run a club across seasons. Every club in the game has a squad of
// about 18 with ages, potential and transfer values; you pick your starting eleven, buy and sell
// players, bring youngsters up from the academy, and play a league season with a cup alongside.
// At the end of each season players grow or decline, the oldest retire, prize money comes in and
// a new intake joins the academy. Pure data and functions (no DOM), saved in the profile.

import { Rng } from './rng';
import { newCompetition, myFixture, opponentOf, recordResult, leagueTable, roundName, cupRounds, type Competition } from './competition';
import { ALL_CLUBS, ROLES, benchFor, statLine, setSquadOverrides, clearSquadOverrides, type Attributes, type PlayerDef, type Role, type TeamDef } from './teams';

export const CAREER_LEAGUE_SIZES = [8, 12, 16, 20];
export const SQUAD_MAX = 24;
export const SQUAD_MIN = 16;
export const ACADEMY_MAX = 6;

export interface CareerPlayer {
  id: string;
  name: string;
  short: string;
  number: number;
  /** Natural position. */
  pos: Role;
  attrs: Attributes;
  skin: number;
  hair: number;
  foot?: 'R' | 'L';
  age: number;
  /** The best overall rating this player can reach. */
  potential: number;
  /** Matches this season and in the career at this club. */
  apps: number;
  goals: number;
  /** Matches still to miss through injury. */
  injured: number;
  /** Came through the academy. */
  youth?: boolean;
}

export interface CareerNews { season: number; text: string }

export interface SeasonSummary {
  season: number;
  year: string;
  pos: number;
  size: number;
  pts: number;
  w: number; d: number; l: number; gf: number; ga: number;
  /** How far you went in the cup ('Winners', 'Final', 'Semi-finals' ...). */
  cup: string;
  champion: string;
  cupWinner: string;
  topScorer: { name: string; goals: number } | null;
  objective: string;
  met: boolean;
}

export interface Career {
  v: 1;
  club: string;
  manager: string;
  season: number;
  startYear: number;
  seed: number;
  size: number;
  /** Every club's squad (id -> players). */
  squads: Record<string, CareerPlayer[]>;
  budgets: Record<string, number>; // thousands
  league: Competition;
  cup: Competition;
  /** League rounds after which each cup round is played. */
  cupAfter: number[];
  academy: CareerPlayer[];
  /** Players other clubs will sell: id, club, asking price (thousands). */
  market: { id: string; club: string; price: number }[];
  /** Your starting eleven in ROLES order (player ids); filled automatically when a slot is empty. */
  lineup: string[];
  news: CareerNews[];
  history: SeasonSummary[];
  objective: { pos: number; text: string };
  nextId: number;
  /** League goals this season, by player id (all clubs), for the top scorers. */
  scorers: Record<string, number>;
  /** Trophies won in this career. */
  honours: { season: number; kind: 'league' | 'cup' }[];
}

const FIRST = ['Alex', 'Ben', 'Cal', 'Dev', 'Eli', 'Femi', 'Gus', 'Hal', 'Ian', 'Jon', 'Kai', 'Leo', 'Max', 'Nat', 'Ozzy', 'Pat', 'Raf', 'Sol', 'Tom', 'Vic', 'Wes', 'Yan', 'Zak', 'Amir', 'Bruno', 'Cian', 'Dami', 'Erik', 'Hugo', 'Ivo',
  'Joel', 'Remy', 'Ilan', 'Finn', 'Arlo', 'Mateo', 'Theo', 'Rory', 'Jude', 'Kofi', 'Luca', 'Milo', 'Noah', 'Oscar', 'Rafa', 'Sami', 'Tariq', 'Umar', 'Viktor', 'Yusuf', 'Ezra', 'Callum', 'Declan', 'Ollie', 'Kian', 'Reece', 'Ade', 'Bram'];
const LAST = ['Archer', 'Booth', 'Carver', 'Dunmore', 'Ellis', 'Fenn', 'Garside', 'Holm', 'Irwin', 'Jessop', 'Kerr', 'Lowry', 'Madden', 'Nash', 'Oduro', 'Parr', 'Quarry', 'Rennie', 'Stroud', 'Tait', 'Usher', 'Varley', 'Wood', 'Yeo', 'Abara', 'Bianchi', 'Costa', 'Dahl', 'Eze', 'Faure',
  'Hale', 'Brennan', 'Lindqvist', 'Varga', 'Moreau', 'Teague', 'Achebe', 'Sorensen', 'Pike', 'Ruiz', 'Doyle', 'Okonjo', 'Halloran', 'Petrov', 'Kowal', 'Mensah', 'Rocha', 'Silva', 'Ferris', 'Dempsey', 'Nkemelu', 'Ward', 'Castillo', 'Brooks', 'Lund', 'Marchetti', 'Osei', 'Quinlan'];
const SK = [0xf1c7a5, 0xe0ac86, 0xc68a5f, 0x9c6a43, 0x6e4a2f, 0x4b3221];
const HR = [0x1c1410, 0x3b2516, 0x6b4a2b, 0xb48a52, 0x2a2a2a, 0x8a3b1d];

/** Roles grouped for picking teams: a player can play anywhere in his group without a penalty. */
export const roleGroup = (r: Role): 'GK' | 'DEF' | 'MID' | 'FWD' => (r === 'GK' ? 'GK' : r === 'RB' || r === 'RCB' || r === 'LCB' || r === 'LB' ? 'DEF' : r === 'CDM' || r === 'RCM' || r === 'LCM' ? 'MID' : 'FWD');
export const GROUP_NAME = { GK: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward' } as const;

export const ovrOf = (p: CareerPlayer, role: Role = p.pos) => statLine(defOf(p, role), role).ovr;

/** How well a player fits a slot: his rating there, less a little out of his natural group. */
export function fitFor(p: CareerPlayer, role: Role): number {
  const g = roleGroup(p.pos), want = roleGroup(role);
  if (g === 'GK' || want === 'GK') return g === want ? ovrOf(p, role) : 0;
  return ovrOf(p, role) - (g === want ? (p.pos === role ? 0 : 1) : 8);
}

export function defOf(p: CareerPlayer, role: Role = p.pos, number = p.number): PlayerDef {
  return { name: p.name, short: p.short, number, role, attrs: { ...p.attrs }, skin: p.skin, hair: p.hair, ...(p.foot ? { foot: p.foot } : {}) };
}

/** Transfer value in thousands: grows steeply with quality, more for young players with room to grow. */
export function valueOf(p: CareerPlayer): number {
  const ovr = ovrOf(p);
  let v = 50 * Math.pow(1.17, ovr - 50);
  if (p.age <= 21) v *= 1 + Math.max(0, p.potential - ovr) / 22;
  else if (p.age >= 33) v *= 0.35;
  else if (p.age >= 30) v *= 0.65;
  return Math.max(10, Math.round(v / 10) * 10);
}

/** Money as text: £850k, £4.2m. */
export function money(k: number): string {
  const neg = k < 0;
  const a = Math.abs(k);
  const s = a >= 1000 ? `£${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}m` : `£${Math.round(a)}k`;
  return neg ? `-${s}` : s;
}

// ------------------------------------------------------------------ making players

const TEMPLATES: Record<'GK' | 'DEF' | 'MID' | 'FWD', Attributes> = {
  GK: { pace: 50, acceleration: 56, stamina: 66, control: 56, passing: 60, shooting: 26, tackling: 28, goalkeeping: 74 },
  DEF: { pace: 70, acceleration: 66, stamina: 76, control: 60, passing: 62, shooting: 42, tackling: 74, goalkeeping: 10 },
  MID: { pace: 68, acceleration: 70, stamina: 80, control: 72, passing: 74, shooting: 60, tackling: 60, goalkeeping: 10 },
  FWD: { pace: 80, acceleration: 80, stamina: 72, control: 72, passing: 62, shooting: 74, tackling: 40, goalkeeping: 10 },
};

const clampAttr = (v: number) => Math.max(20, Math.min(99, Math.round(v)));

/** Scale a player's attributes so his overall moves by about `d` (the ones his position uses most move most). */
export function shiftOverall(p: CareerPlayer, d: number) {
  if (!d) return;
  const keys = Object.keys(p.attrs) as (keyof Attributes)[];
  for (let i = 0; i < 6 && Math.abs(d) > 0.2; i++) {
    const before = ovrOf(p);
    for (const k of keys) {
      if (k === 'goalkeeping' && p.pos !== 'GK') continue;
      p.attrs[k] = clampAttr(p.attrs[k] + d * (k === 'stamina' ? 0.6 : 1));
    }
    const moved = ovrOf(p) - before;
    d -= moved || d;
  }
}

let nameRng: Rng | null = null;
function uniqueName(rng: Rng, used: Set<string>): { name: string; short: string } {
  nameRng = rng;
  for (let k = 0; k < 40; k++) {
    const first = rng.pick(FIRST), last = rng.pick(LAST);
    if (!used.has(last)) { used.add(last); return { name: `${first} ${last}`, short: last }; }
  }
  const last = `${rng.pick(LAST)}-${rng.pick(LAST)}`;
  used.add(last);
  return { name: `${rng.pick(FIRST)} ${last}`, short: last };
}
void nameRng;

/** A generated player of about `ovr` in a position. */
export function makePlayer(c: { nextId: number }, rng: Rng, pos: Role, ovr: number, age: number, potential: number, used: Set<string>, number = 0): CareerPlayer {
  const t = TEMPLATES[roleGroup(pos)];
  const attrs = { ...t };
  for (const k of Object.keys(attrs) as (keyof Attributes)[]) attrs[k] = clampAttr(attrs[k] + rng.gauss() * 6);
  const nm = uniqueName(rng, used);
  const p: CareerPlayer = { id: `p${c.nextId++}`, ...nm, number, pos, attrs, skin: rng.pick(SK), hair: rng.pick(HR), age, potential: Math.max(ovr, Math.round(potential)), apps: 0, goals: 0, injured: 0 };
  if (rng.chance(0.2)) p.foot = 'L';
  shiftOverall(p, ovr - ovrOf(p));
  return p;
}

function fromDef(c: { nextId: number }, d: PlayerDef, rng: Rng, starter: boolean): CareerPlayer {
  const p: CareerPlayer = {
    id: `p${c.nextId++}`, name: d.name, short: d.short, number: d.number, pos: d.role, attrs: { ...d.attrs }, skin: d.skin, hair: d.hair,
    age: starter ? 21 + Math.floor(rng.next() * 12) : 19 + Math.floor(rng.next() * 12), potential: 0, apps: 0, goals: 0, injured: 0,
  };
  if (d.foot) p.foot = d.foot;
  const ovr = ovrOf(p);
  p.potential = p.age <= 23 ? ovr + 3 + Math.floor(rng.next() * 10) : p.age <= 27 ? ovr + Math.floor(rng.next() * 4) : ovr;
  return p;
}

/** A club's squad for a new career: its eleven, its five substitutes and two youngsters. */
export function seedSquad(c: { nextId: number }, team: TeamDef, rng: Rng): CareerPlayer[] {
  const used = new Set(team.players.map((p) => p.short));
  const squad = [...team.players.map((d) => fromDef(c, d, rng, true)), ...benchFor({ ...team, bench: undefined }).map((d) => fromDef(c, d, rng, false))];
  for (const pos of ['RB', 'LCM'] as Role[]) {
    const base = squad.find((p) => p.pos === pos)!;
    squad.push(makePlayer(c, rng, pos, ovrOf(base) - 10 - Math.floor(rng.next() * 4), 18 + Math.floor(rng.next() * 2), ovrOf(base) + Math.floor(rng.next() * 8), used));
  }
  renumber(squad);
  return squad;
}

/** Give everyone a distinct shirt number (starters keep theirs where they can). */
export function renumber(squad: CareerPlayer[]) {
  const taken = new Set<number>();
  for (const p of squad) { if (p.number > 0 && p.number < 100 && !taken.has(p.number)) taken.add(p.number); else p.number = 0; }
  for (const p of squad) if (!p.number) { let n = roleGroup(p.pos) === 'GK' ? 13 : 14; while (taken.has(n)) n++; p.number = n; taken.add(n); }
}

// ------------------------------------------------------------------ starting a career

/** The board's target for the season, from how strong your squad is against the rest. */
export function boardObjective(c: Career): { pos: number; text: string } {
  const ids = leagueClubs(c);
  const rank = ids.map((id) => ({ id, s: squadStrength(c, id) })).sort((a, b) => b.s - a.s).findIndex((x) => x.id === c.club) + 1;
  const n = ids.length;
  if (rank <= 1) return { pos: 1, text: 'Win the league' };
  if (rank <= Math.ceil(n * 0.25)) return { pos: Math.ceil(n * 0.25), text: `Finish in the top ${Math.ceil(n * 0.25)}` };
  if (rank <= Math.ceil(n / 2)) return { pos: Math.ceil(n / 2), text: 'Finish in the top half' };
  return { pos: n - 2, text: `Stay out of the bottom two (finish ${ordinalText(n - 2)} or better)` };
}

export const ordinalText = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

export function newCareer(club: string, seed: number, size = 12, manager = 'Manager', year = 2026): Career {
  const rng = new Rng(seed);
  const c: Career = {
    v: 1, club, manager, season: 1, startYear: year, seed, size: CAREER_LEAGUE_SIZES.includes(size) ? size : 12,
    squads: {}, budgets: {}, league: null as unknown as Competition, cup: null as unknown as Competition, cupAfter: [],
    academy: [], market: [], lineup: [], news: [], history: [], objective: { pos: 1, text: '' }, nextId: 1, scorers: {}, honours: [],
  };
  for (const t of ALL_CLUBS) {
    c.squads[t.id] = seedSquad(c, t, rng);
    const s = squadStrength(c, t.id);
    c.budgets[t.id] = Math.round((800 + Math.max(0, s - 60) * 260 + rng.next() * 900) / 50) * 50;
  }
  startSeason(c, rng, true);
  return c;
}

export function leagueClubs(c: Career): string[] {
  return [...new Set(c.league.rounds[0].flatMap((f) => [f.home, f.away]))];
}

/** A new season's league and cup (the same clubs every season), board target, academy intake and transfer list. */
function startSeason(c: Career, rng: Rng, first: boolean) {
  const lseed = (c.seed + c.season * 1009) >>> 0;
  if (first) c.league = newCompetition('league', c.club, lseed, c.size);
  else {
    // The same clubs every season, with a new fixture list.
    const rng2 = new Rng(lseed);
    const ids = leagueClubs(c).map((id) => ({ id, k: rng2.next() })).sort((a, b) => a.k - b.k).map((x) => x.id);
    c.league = { kind: 'league', club: c.club, seed: lseed, round: 0, rounds: roundRobin(ids), size: ids.length };
  }
  c.cup = newCompetition('cup', c.club, (lseed ^ 0x5bd1e995) >>> 0, c.size >= 16 ? 16 : 8);
  const L = c.league.rounds.length, R = cupRounds(c.cup).length;
  c.cupAfter = Array.from({ length: R }, (_, k) => Math.max(1, Math.floor(((k + 1) * L) / (R + 1))));
  c.scorers = {};
  for (const sq of Object.values(c.squads)) for (const p of sq) { p.apps = 0; p.goals = 0; }
  c.objective = boardObjective(c);
  youthIntake(c, rng, first ? 3 : 3);
  refreshMarket(c, rng);
  c.lineup = [];
  c.news.unshift({ season: c.season, text: `Season ${seasonYear(c)} begins. The board's target: ${c.objective.text.toLowerCase()}.` });
}

/** Everyone plays everyone once (circle method), home and away alternating. */
function roundRobin(ids: string[]): Competition['rounds'] {
  const n = ids.length;
  const list = ids.slice();
  const rounds: Competition['rounds'] = [];
  for (let r = 0; r < n - 1; r++) {
    const fx: Competition['rounds'][number] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      fx.push((r + i) % 2 === 0 ? { home: a, away: b } : { home: b, away: a });
    }
    rounds.push(fx);
    list.splice(1, 0, list.pop()!);
  }
  return rounds;
}

export const seasonYear = (c: Career, s = c.season) => `${c.startYear + s - 1}/${String((c.startYear + s) % 100).padStart(2, '0')}`;

/** Two to four academy prospects, aged 15 to 17: modest now, some with a lot of room to grow. */
export function youthIntake(c: Career, rng: Rng, n = 3) {
  const used = new Set([...c.squads[c.club].map((p) => p.short), ...c.academy.map((p) => p.short)]);
  const pool: Role[] = ['GK', 'RCB', 'LB', 'CDM', 'RCM', 'LCM', 'RW', 'ST', 'LW', 'RB'];
  for (let i = 0; i < n && c.academy.length < ACADEMY_MAX; i++) {
    const pos = i === 0 && !c.academy.some((p) => p.pos === 'GK') && rng.chance(0.25) ? 'GK' : rng.pick(pool);
    const star = rng.chance(0.12);
    const pot = star ? 82 + rng.next() * 12 : 62 + rng.next() * 20;
    const p = makePlayer(c, rng, pos, 42 + Math.floor(rng.next() * 12), 15 + Math.floor(rng.next() * 3), pot, used);
    p.youth = true;
    c.academy.push(p);
    c.news.unshift({ season: c.season, text: `Academy: ${p.name} (${p.age}, ${GROUP_NAME[roleGroup(p.pos)].toLowerCase()}) joins the youth squad${star ? '. The coaches are excited about this one' : ''}.` });
  }
}

/** Ten to fourteen players other clubs would sell, at a premium on their value. */
export function refreshMarket(c: Career, rng: Rng) {
  const list: Career['market'] = [];
  const clubs = Object.keys(c.squads).filter((id) => id !== c.club);
  for (let k = 0; k < 60 && list.length < 12; k++) {
    const club = rng.pick(clubs);
    const sq = c.squads[club];
    if (sq.length <= SQUAD_MIN) continue;
    const p = rng.pick(sq);
    if (list.some((x) => x.id === p.id) || p.injured > 0) continue;
    list.push({ id: p.id, club, price: Math.round((valueOf(p) * (1.1 + rng.next() * 0.25)) / 10) * 10 });
  }
  c.market = list.sort((a, b) => b.price - a.price);
}

// ------------------------------------------------------------------ squads and line-ups

export function findPlayer(c: Career, id: string): { p: CareerPlayer; club: string } | null {
  for (const [club, sq] of Object.entries(c.squads)) { const p = sq.find((x) => x.id === id); if (p) return { p, club }; }
  return null;
}

/** Best available eleven for a club, in ROLES order (ids); keeps the slots you set where the player is fit. */
export function pickEleven(squad: CareerPlayer[], keep: string[] = []): string[] {
  const avail = squad.filter((p) => p.injured <= 0);
  const out: string[] = new Array(11).fill('');
  const used = new Set<string>();
  ROLES.forEach((r, i) => {
    const k = keep[i];
    if (k && avail.some((p) => p.id === k) && !used.has(k)) { out[i] = k; used.add(k); }
  });
  // Fill the scarcest slots first: keeper, centre-backs, then the rest.
  const order = [0, 2, 3, 1, 4, 5, 9, 6, 7, 8, 10];
  for (const i of order) {
    if (out[i]) continue;
    const r = ROLES[i];
    let best: CareerPlayer | null = null, bs = -1;
    for (const p of avail) { if (used.has(p.id)) continue; const f = fitFor(p, r); if (f > bs) { bs = f; best = p; } }
    if (best) { out[i] = best.id; used.add(best.id); }
  }
  // Too few fit players: anyone, even injured.
  ROLES.forEach((_, i) => { if (!out[i]) { const p = squad.find((q) => !used.has(q.id)); if (p) { out[i] = p.id; used.add(p.id); } } });
  return out;
}

/** The eleven and bench a club would field (your club uses your line-up). */
export function teamSheet(c: Career, club: string): { xi: CareerPlayer[]; bench: CareerPlayer[] } {
  const sq = c.squads[club] ?? [];
  const ids = pickEleven(sq, club === c.club ? c.lineup : []);
  const xi = ids.map((id) => sq.find((p) => p.id === id)!).filter(Boolean);
  const rest = sq.filter((p) => !ids.includes(p.id) && p.injured <= 0);
  const gk = rest.filter((p) => p.pos === 'GK').sort((a, b) => ovrOf(b) - ovrOf(a))[0];
  const others = rest.filter((p) => p !== gk).sort((a, b) => ovrOf(b) - ovrOf(a)).slice(0, gk ? 6 : 7);
  return { xi, bench: gk ? [gk, ...others] : others };
}

/** A club as the match engine sees it: its own kits and crest with the career squad. */
export function careerTeam(c: Career, club: string, base: TeamDef): TeamDef {
  const { xi, bench } = teamSheet(c, club);
  return {
    ...base,
    players: xi.map((p, i) => defOf(p, ROLES[i])),
    bench: bench.map((p) => defOf(p)),
  };
}

export function squadStrength(c: Career, club: string): number {
  const { xi } = teamSheet(c, club);
  return xi.reduce((s, p, i) => s + fitFor(p, ROLES[i]), 0) / Math.max(1, xi.length);
}

/** Run fn with every club's career squad standing in for its own (results, strengths, the match). */
export function withSquads<T>(c: Career, fn: () => T): T {
  applySquads(c);
  try { return fn(); } finally { clearSquadOverrides(); }
}

export function applySquads(c: Career) {
  setSquadOverrides(ALL_CLUBS.map((t) => careerTeam(c, t.id, t)));
}

/** Swap two of your players: starters change places, or a reserve comes into the eleven. */
export function swapLineup(c: Career, a: string, b: string) {
  const ids = pickEleven(c.squads[c.club], c.lineup);
  const ia = ids.indexOf(a), ib = ids.indexOf(b);
  if (ia < 0 && ib < 0) return;
  if (ia >= 0 && ib >= 0) { ids[ia] = b; ids[ib] = a; }
  else if (ia >= 0) ids[ia] = b;
  else ids[ib] = a;
  c.lineup = ids;
}

// ------------------------------------------------------------------ transfers and academy

export type TransferResult = { ok: true; text: string } | { ok: false; text: string };

export function buyPlayer(c: Career, id: string): TransferResult {
  const m = c.market.find((x) => x.id === id);
  const f = findPlayer(c, id);
  if (!m || !f || f.club === c.club) return { ok: false, text: 'That player is not for sale.' };
  if (c.squads[c.club].length >= SQUAD_MAX) return { ok: false, text: `Your squad is full (${SQUAD_MAX}). Sell or release someone first.` };
  if (c.budgets[c.club] < m.price) return { ok: false, text: `Not enough money: he costs ${money(m.price)} and you have ${money(c.budgets[c.club])}.` };
  const from = c.squads[f.club];
  c.squads[f.club] = from.filter((p) => p.id !== id);
  c.budgets[c.club] -= m.price;
  c.budgets[f.club] += m.price;
  f.p.apps = 0; f.p.goals = 0; f.p.number = 0;
  c.squads[c.club].push(f.p);
  renumber(c.squads[c.club]);
  c.market = c.market.filter((x) => x.id !== id);
  topUp(c, f.club, new Rng((c.seed ^ c.nextId * 31) >>> 0));
  const text = `${f.p.name} signs from ${clubName(f.club)} for ${money(m.price)}.`;
  c.news.unshift({ season: c.season, text });
  return { ok: true, text };
}

/** An offer for one of your players: the richest club that needs him, at 85-100% of his value. */
export function offerFor(c: Career, id: string): { club: string; price: number } | null {
  const p = c.squads[c.club].find((x) => x.id === id);
  if (!p) return null;
  const v = valueOf(p);
  const rng = new Rng((c.seed ^ hashId(id) ^ (c.season * 977) ^ c.league.round * 131) >>> 0);
  const price = Math.round((v * (0.85 + rng.next() * 0.15)) / 10) * 10;
  const buyers = Object.keys(c.squads).filter((k) => k !== c.club && c.budgets[k] >= price && c.squads[k].length < SQUAD_MAX).sort((a, b) => c.budgets[b] - c.budgets[a]);
  return buyers.length ? { club: buyers[Math.floor(rng.next() * Math.min(3, buyers.length))], price } : null;
}

export function sellPlayer(c: Career, id: string): TransferResult {
  if (c.squads[c.club].length <= SQUAD_MIN) return { ok: false, text: `You need at least ${SQUAD_MIN} players.` };
  const o = offerFor(c, id);
  const p = c.squads[c.club].find((x) => x.id === id);
  if (!o || !p) return { ok: false, text: 'Nobody can afford him right now.' };
  c.squads[c.club] = c.squads[c.club].filter((x) => x.id !== id);
  c.lineup = c.lineup.map((x) => (x === id ? '' : x));
  c.budgets[c.club] += o.price;
  c.budgets[o.club] -= o.price;
  p.apps = 0; p.goals = 0; p.number = 0;
  c.squads[o.club].push(p);
  renumber(c.squads[o.club]);
  const text = `${p.name} joins ${clubName(o.club)} for ${money(o.price)}.`;
  c.news.unshift({ season: c.season, text });
  return { ok: true, text };
}

export function promoteYouth(c: Career, id: string): TransferResult {
  const p = c.academy.find((x) => x.id === id);
  if (!p) return { ok: false, text: 'Not in the academy.' };
  if (c.squads[c.club].length >= SQUAD_MAX) return { ok: false, text: `Your squad is full (${SQUAD_MAX}).` };
  c.academy = c.academy.filter((x) => x.id !== id);
  p.number = 0;
  c.squads[c.club].push(p);
  renumber(c.squads[c.club]);
  const text = `${p.name} is promoted from the academy to the first-team squad.`;
  c.news.unshift({ season: c.season, text });
  return { ok: true, text };
}

export function releasePlayer(c: Career, id: string): TransferResult {
  const inAcademy = c.academy.some((x) => x.id === id);
  if (inAcademy) { const p = c.academy.find((x) => x.id === id)!; c.academy = c.academy.filter((x) => x.id !== id); return { ok: true, text: `${p.name} is released from the academy.` }; }
  if (c.squads[c.club].length <= SQUAD_MIN) return { ok: false, text: `You need at least ${SQUAD_MIN} players.` };
  const p = c.squads[c.club].find((x) => x.id === id);
  if (!p) return { ok: false, text: 'Not in your squad.' };
  c.squads[c.club] = c.squads[c.club].filter((x) => x.id !== id);
  c.lineup = c.lineup.map((x) => (x === id ? '' : x));
  return { ok: true, text: `${p.name} is released.` };
}

/** A club short of players signs a free agent to get back to the minimum. */
function topUp(c: Career, club: string, rng: Rng) {
  const sq = c.squads[club];
  const used = new Set(sq.map((p) => p.short));
  while (sq.length < SQUAD_MIN) {
    const need: Role = !sq.some((p) => p.pos === 'GK') ? 'GK' : (['RCB', 'RCM', 'ST', 'LB', 'RW'] as Role[])[sq.length % 5];
    const avg = sq.reduce((s, p) => s + ovrOf(p), 0) / Math.max(1, sq.length);
    sq.push(makePlayer(c, rng, need, Math.round(avg - 6), 22 + Math.floor(rng.next() * 10), avg - 3, used));
  }
  renumber(sq);
}

export const clubName = (id: string) => ALL_CLUBS.find((t) => t.id === id)?.name ?? id;

function hashId(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// ------------------------------------------------------------------ playing the season

export interface CareerFixture { comp: 'league' | 'cup'; opp: string; home: boolean; round: string }

/** Your next match: a cup round once its league round has been played, otherwise the league. */
export function nextFixture(c: Career): CareerFixture | null {
  const cupDue = !c.cup.out && !c.cup.champion && myFixture(c.cup) && c.league.round >= (c.cupAfter[c.cup.round] ?? Infinity);
  const comp = cupDue ? c.cup : myFixture(c.league) ? c.league : null;
  if (!comp) return null;
  const f = myFixture(comp)!;
  return { comp: comp.kind, opp: opponentOf(comp)!, home: f.home === c.club, round: comp.kind === 'cup' ? `Cup · ${roundName(comp)}` : `League · ${roundName(comp)}` };
}

export const seasonOver = (c: Career) => !nextFixture(c);

export interface CareerResult {
  gf: number;
  ga: number;
  pens?: [number, number];
  et?: boolean;
  /** Your scorers' player names (short names as on the shirt), one entry per goal. */
  scorers: string[];
  /** Short names of your players who played. */
  played: string[];
  /** Your players injured in the match: short name and matches out. */
  injuries?: { short: string; matches: number }[];
}

/** Record your result: the competition moves on, the round's other matches are played, injuries heal. */
export function recordCareerMatch(c: Career, r: CareerResult): string[] {
  const fx = nextFixture(c);
  if (!fx) return [];
  const notes: string[] = [];
  const mine = c.squads[c.club];
  const byShort = (s: string) => mine.find((p) => p.short === s);
  // Injuries count down for everyone at the club, then the new ones start.
  for (const sq of Object.values(c.squads)) for (const p of sq) if (p.injured > 0) p.injured--;
  for (const s of r.played) { const p = byShort(s); if (p) p.apps++; }
  for (const s of r.scorers) {
    const p = byShort(s);
    if (!p) continue;
    p.goals++;
    if (fx.comp === 'league') c.scorers[p.id] = (c.scorers[p.id] ?? 0) + 1;
  }
  for (const inj of r.injuries ?? []) {
    const p = byShort(inj.short);
    if (p && inj.matches > 0) { p.injured = Math.max(p.injured, inj.matches); notes.push(`${p.name} is out for ${inj.matches} ${inj.matches === 1 ? 'match' : 'matches'}.`); }
  }
  const round = fx.comp === 'league' ? c.league.round : c.cup.round;
  // A cup tie can't end level: settled on penalties if the match didn't say how.
  if (fx.comp === 'cup' && r.gf === r.ga && !r.pens) { const k = new Rng((c.seed ^ round * 17 ^ c.season) >>> 0); r = { ...r, pens: k.chance(0.5) ? [5, 4] : [3, 4] }; }
  withSquads(c, () => {
    if (fx.comp === 'league') c.league = recordResult(c.league, r.gf, r.ga, r.pens, r.et);
    else c.cup = recordResult(c.cup, r.gf, r.ga, r.pens, r.et);
  });
  // Goals in the round's other league matches go to their players (for the top scorers).
  const rng = new Rng((c.seed ^ (round * 7349) ^ (c.season * 13)) >>> 0);
  if (fx.comp === 'league') {
    for (const f of c.league.rounds[round]) {
      if (f.home === c.club || f.away === c.club) continue;
      for (const [club, n] of [[f.home, f.hg ?? 0], [f.away, f.ag ?? 0]] as [string, number][]) for (let i = 0; i < n; i++) {
        const s = pickScorer(teamSheet(c, club).xi, rng);
        if (s) { s.goals++; c.scorers[s.id] = (c.scorers[s.id] ?? 0) + 1; }
      }
      for (const club of [f.home, f.away]) for (const p of teamSheet(c, club).xi) p.apps++;
      // Now and then a player elsewhere picks up a knock.
      if (rng.chance(0.25)) { const sq = c.squads[rng.chance(0.5) ? f.home : f.away]; const p = rng.pick(sq); p.injured = Math.max(p.injured, 1 + Math.floor(rng.next() * 3)); }
    }
  }
  // Young players with games grow a little through the season.
  for (const p of mine) if (p.age <= 23 && r.played.includes(p.short) && ovrOf(p) < p.potential && rng.chance(0.18)) shiftOverall(p, 1);
  // The transfer list changes every few weeks.
  if (c.league.round % 3 === 0) refreshMarket(c, rng);
  // A different team sheet next time if someone in the eleven is now injured (others keep their places).
  c.lineup = c.lineup.map((id) => (mine.find((p) => p.id === id && p.injured > 0) ? '' : id));
  for (const n of notes) c.news.unshift({ season: c.season, text: n });
  return notes;
}

function pickScorer(xi: CareerPlayer[], rng: Rng): CareerPlayer | null {
  const w = xi.map((p, i) => (i === 0 ? 0.01 : Math.max(1, p.attrs.shooting - 30) * (roleGroup(ROLES[i]) === 'FWD' ? 3 : roleGroup(ROLES[i]) === 'MID' ? 1.4 : 0.5)));
  const tot = w.reduce((a, b) => a + b, 0);
  let x = rng.next() * tot;
  for (let i = 0; i < xi.length; i++) { x -= w[i]; if (x <= 0) return xi[i]; }
  return xi[xi.length - 1] ?? null;
}

/** Top scorers this season (league goals), most first. */
export function topScorers(c: Career, n = 10): { id: string; name: string; club: string; goals: number }[] {
  return Object.entries(c.scorers).map(([id, goals]) => { const f = findPlayer(c, id); return f ? { id, name: f.p.name, club: f.club, goals } : null; })
    .filter((x): x is { id: string; name: string; club: string; goals: number } => !!x).sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name)).slice(0, n);
}

/** How far you went in the cup this season, as text. */
export function cupProgress(c: Career): string {
  if (c.cup.champion === c.club) return 'Winners';
  const names = cupRounds(c.cup);
  const lastPlayed = c.cup.rounds.findIndex((r) => r.some((f) => (f.home === c.club || f.away === c.club) && f.winner && f.winner !== c.club));
  if (lastPlayed >= 0) return names[lastPlayed] === 'Final' ? 'Runners-up' : names[lastPlayed] ?? 'Out';
  return names[Math.min(c.cup.round, names.length - 1)] ?? '';
}

/**
 * End of season: the summary goes into the history, prize money is paid, everyone ages a year
 * (young players grow, older ones decline, the oldest retire), and the next season starts.
 */
export function endSeason(c: Career): { summary: SeasonSummary; notes: string[] } {
  const rng = new Rng((c.seed ^ (c.season * 104729)) >>> 0);
  // Anything still unplayed (it shouldn't be) is played out.
  let guard = 0;
  while (nextFixture(c) && guard++ < 60) recordCareerMatch(c, { gf: 0, ga: 0, scorers: [], played: [] });
  const table = withSquads(c, () => leagueTable(c.league));
  const posIdx = table.findIndex((r) => r.id === c.club);
  const row = table[posIdx];
  const top = topScorers(c, 1)[0];
  const summary: SeasonSummary = {
    season: c.season, year: seasonYear(c), pos: posIdx + 1, size: table.length, pts: row.pts, w: row.w, d: row.d, l: row.l, gf: row.gf, ga: row.ga,
    cup: cupProgress(c), champion: table[0].id, cupWinner: c.cup.champion ?? '', topScorer: top ? { name: `${top.name} (${clubName(top.club)})`, goals: top.goals } : null,
    objective: c.objective.text, met: posIdx + 1 <= c.objective.pos,
  };
  c.history.push(summary);
  if (table[0].id === c.club) c.honours.push({ season: c.season, kind: 'league' });
  if (c.cup.champion === c.club) c.honours.push({ season: c.season, kind: 'cup' });
  const notes: string[] = [];
  // Prize money: by league position, plus the cup.
  for (let i = 0; i < table.length; i++) c.budgets[table[i].id] += Math.round((table.length - i) * 350 + (i === 0 ? 2500 : 0));
  const cupPrize = summary.cup === 'Winners' ? 1500 : summary.cup === 'Runners-up' ? 700 : 200;
  c.budgets[c.club] += cupPrize;
  notes.push(`Prize money: ${money((table.length - posIdx) * 350 + (posIdx === 0 ? 2500 : 0) + cupPrize)}.`);
  notes.push(summary.met ? `The board are happy: target met (${c.objective.text.toLowerCase()}).` : `The board expected more (${c.objective.text.toLowerCase()}).`);
  if (summary.met) c.budgets[c.club] += 500;
  // Ageing, growth and decline.
  for (const [club, sq] of Object.entries(c.squads)) {
    for (const p of [...sq]) {
      ageOne(p, rng);
      if (p.age >= 34 && rng.chance(0.35 + (p.age - 34) * 0.25)) {
        c.squads[club] = c.squads[club].filter((x) => x !== p);
        if (club === c.club) notes.push(`${p.name} retires at ${p.age}.`);
      }
    }
    topUp(c, club, rng);
  }
  for (const p of c.academy) ageOne(p, rng);
  // Academy players who reach 19 must be promoted or let go: the best are promoted if there is room.
  for (const p of [...c.academy]) if (p.age >= 19) {
    if (c.squads[c.club].length < SQUAD_MAX) { promoteYouth(c, p.id); notes.push(`${p.name} (19) moves up from the academy.`); } else { c.academy = c.academy.filter((x) => x !== p); notes.push(`${p.name} leaves the academy.`); }
  }
  // A few transfers between other clubs over the summer.
  const others = Object.keys(c.squads).filter((k) => k !== c.club);
  for (let i = 0; i < 6; i++) {
    const a = rng.pick(others), b = rng.pick(others);
    if (a === b || c.squads[a].length <= SQUAD_MIN || c.squads[b].length >= SQUAD_MAX) continue;
    const p = rng.pick(c.squads[a]);
    const price = valueOf(p);
    if (c.budgets[b] < price) continue;
    c.squads[a] = c.squads[a].filter((x) => x !== p); c.squads[b].push(p); c.budgets[b] -= price; c.budgets[a] += price; p.number = 0; renumber(c.squads[b]);
    if (rng.chance(0.5)) c.news.unshift({ season: c.season, text: `Elsewhere: ${p.name} moves from ${clubName(a)} to ${clubName(b)} for ${money(price)}.` });
  }
  for (const n of notes) c.news.unshift({ season: c.season, text: n });
  c.season++;
  startSeason(c, rng, false);
  c.news = c.news.slice(0, 60);
  return { summary, notes };
}

function ageOne(p: CareerPlayer, rng: Rng) {
  p.age++;
  const ovr = ovrOf(p);
  let d = 0;
  if (p.age <= 21) d = Math.min(p.potential - ovr, 2 + Math.floor(rng.next() * 5) + Math.min(3, Math.floor(p.apps / 8)));
  else if (p.age <= 24) d = Math.min(p.potential - ovr, 1 + Math.floor(rng.next() * 3) + Math.min(2, Math.floor(p.apps / 10)));
  else if (p.age <= 29) d = Math.min(Math.max(0, p.potential - ovr), Math.floor(rng.next() * 2));
  else if (p.age <= 32) d = -Math.floor(rng.next() * 3);
  else d = -(2 + Math.floor(rng.next() * 3));
  shiftOverall(p, d);
}

/** Is this a saved career we can resume? */
export function isCareer(x: unknown): x is Career {
  const c = x as Career;
  return !!c && c.v === 1 && typeof c.club === 'string' && !!c.squads && !!c.league && !!c.cup && Array.isArray(c.history);
}

export { leagueTable };
