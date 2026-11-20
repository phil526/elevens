// World tournament (20 Nov 2026): sixteen made-up nations in four groups of four. Everyone in a
// group plays each other once (three points for a win); the top two go through to the
// quarter-finals, then the semi-finals and the final, where a level match goes to extra time and
// penalties. You play your nation's matches; the rest are worked out from the squads' strength.

import { Rng } from './rng';
import { simulatePens, simulateScore, type Fixture, type TableRow } from './competition';
import { addTeams, makeNation, type Kit, type TeamDef } from './teams';

export type FlagPattern = 'tri-v' | 'tri-h' | 'nordic' | 'bi-h' | 'bi-v' | 'diag' | 'star' | 'band' | 'canton' | 'saltire';

export interface NationSpec {
  id: string;
  name: string;
  abbr: string;
  /** Strength relative to the main clubs (-4 .. +3) and playing flavour. */
  strength: number;
  flavour: 'pace' | 'passing' | 'defence' | 'attack' | 'balanced';
  flag: { pattern: FlagPattern; colours: [number, number, number] };
  home: Kit;
  away: Kit;
  style: string;
  /** Name style: first names and family names this nation's players are drawn from. */
  first: string[];
  last: string[];
}

const kit = (shirt: number, shorts: number, socks: number, number: number, keeper: number, sleeves = shirt): Kit => ({ shirt, sleeves, shorts, socks, number, keeper });

/** Sixteen fictional nations: none of these are real countries. */
export const NATION_SPECS: NationSpec[] = [
  { id: 'n-aurelia', name: 'Aurelia', abbr: 'AUR', strength: 3, flavour: 'passing', flag: { pattern: 'tri-v', colours: [0x14306b, 0xf2c14e, 0x14306b] },
    home: kit(0xf2c14e, 0x14306b, 0xf2c14e, 0x14306b, 0x1f9d55), away: kit(0x14306b, 0x14306b, 0x14306b, 0xf2c14e, 0xe8742a), style: 'Tournament favourites. Patient, gifted passers.',
    first: ['Alessio', 'Dario', 'Marco', 'Teo', 'Luca', 'Enzo', 'Fabio', 'Nico', 'Rafael', 'Sandro', 'Vito', 'Bruno'], last: ['Aurelli', 'Bassani', 'Corvo', 'Delmar', 'Ferro', 'Galli', 'Lombi', 'Marchetto', 'Orsini', 'Pavan', 'Rinaldo', 'Vescovi'] },
  { id: 'n-brakmor', name: 'Brakmor', abbr: 'BKM', strength: 2, flavour: 'defence', flag: { pattern: 'tri-h', colours: [0x111111, 0xc8102e, 0xf4f4f4] },
    home: kit(0xc8102e, 0x111111, 0xc8102e, 0xffffff, 0xf2b705), away: kit(0xf4f4f4, 0xf4f4f4, 0x111111, 0xc8102e, 0x2f6fde), style: 'Big, organised and very hard to score against.',
    first: ['Dragan', 'Ivo', 'Milos', 'Stanko', 'Bogdan', 'Petar', 'Zoran', 'Luka', 'Vuk', 'Rade', 'Goran', 'Nenad'], last: ['Brakovic', 'Drenjak', 'Horvat', 'Kostic', 'Lazar', 'Marek', 'Novak', 'Petrov', 'Radan', 'Stanic', 'Tomas', 'Zelen'] },
  { id: 'n-caldera', name: 'Caldera', abbr: 'CDR', strength: 1, flavour: 'attack', flag: { pattern: 'diag', colours: [0xf28c28, 0xf4f4f4, 0x1c7c3c] },
    home: kit(0xf28c28, 0xf4f4f4, 0xf28c28, 0x111111, 0x2b2d33), away: kit(0xf4f4f4, 0x1c7c3c, 0xf4f4f4, 0x1c7c3c, 0xe23d28), style: 'Flair and goals: dangerous going forward, open at the back.',
    first: ['Mateo', 'Tiago', 'Rui', 'Joao', 'Diego', 'Caio', 'Andre', 'Lucas', 'Felipe', 'Hugo', 'Renato', 'Iago'], last: ['Almeida', 'Barros', 'Calde', 'Duarte', 'Esteves', 'Fontes', 'Lacerda', 'Moura', 'Neves', 'Prado', 'Rocha', 'Teixo'] },
  { id: 'n-dravnia', name: 'Dravnia', abbr: 'DRV', strength: 0, flavour: 'balanced', flag: { pattern: 'nordic', colours: [0x1c7c3c, 0xf4f4f4, 0x1c7c3c] },
    home: kit(0x1c7c3c, 0xf4f4f4, 0x1c7c3c, 0xffffff, 0xf2b705), away: kit(0xf4f4f4, 0x1c7c3c, 0xf4f4f4, 0x1c7c3c, 0x7b3fe4), style: 'Solid all over, with no stars and no weaknesses.',
    first: ['Anders', 'Bjorn', 'Erik', 'Halvar', 'Jonas', 'Kjell', 'Leif', 'Mats', 'Nils', 'Olav', 'Sindre', 'Tor'], last: ['Dravik', 'Eklund', 'Fjell', 'Haug', 'Lindqvist', 'Moen', 'Norberg', 'Rask', 'Solberg', 'Strand', 'Vik', 'Wahl'] },
  { id: 'n-esvara', name: 'Esvara', abbr: 'ESV', strength: 1, flavour: 'pace', flag: { pattern: 'star', colours: [0xd81f3c, 0xf6c344, 0xd81f3c] },
    home: kit(0xd81f3c, 0xd81f3c, 0xd81f3c, 0xf6c344, 0x1f9d55), away: kit(0xf6c344, 0xd81f3c, 0xf6c344, 0xd81f3c, 0x2b2d33), style: 'Lightning quick on the counter-attack.',
    first: ['Kwesi', 'Kofi', 'Yaw', 'Ama', 'Nana', 'Kojo', 'Femi', 'Tunde', 'Sekou', 'Moussa', 'Idris', 'Bakary'], last: ['Asamoah', 'Boakye', 'Diallo', 'Esvar', 'Kamara', 'Mensah', 'Nkemelu', 'Ofori', 'Sarr', 'Toure', 'Yeboah', 'Zongo'] },
  { id: 'n-fjordmark', name: 'Fjordmark', abbr: 'FJM', strength: 0, flavour: 'pace', flag: { pattern: 'nordic', colours: [0x7ec8e3, 0xf4f4f4, 0x0e2a52] },
    home: kit(0x7ec8e3, 0xf4f4f4, 0x7ec8e3, 0x0e2a52, 0xe8742a), away: kit(0x0e2a52, 0x0e2a52, 0x0e2a52, 0x7ec8e3, 0xf2b705), style: 'Fit and fast, they run all day.',
    first: ['Aksel', 'Brede', 'Eirik', 'Frode', 'Gaute', 'Håkon', 'Ivar', 'Magnus', 'Oskar', 'Ragnar', 'Sigurd', 'Trygve'], last: ['Aas', 'Berge', 'Dahl', 'Fjord', 'Grove', 'Hovland', 'Kvam', 'Lie', 'Myhre', 'Rønning', 'Sæther', 'Tveit'] },
  { id: 'n-galmont', name: 'Galmont', abbr: 'GLM', strength: -1, flavour: 'defence', flag: { pattern: 'band', colours: [0x7a1f3d, 0x8cc1e3, 0x7a1f3d] },
    home: kit(0x7a1f3d, 0x7a1f3d, 0x8cc1e3, 0xffffff, 0xf2b705, 0x8cc1e3), away: kit(0x8cc1e3, 0x7a1f3d, 0x8cc1e3, 0x7a1f3d, 0x1f9d55), style: 'Stubborn defenders who frustrate better sides.',
    first: ['Aled', 'Bryn', 'Cai', 'Dafydd', 'Emyr', 'Gethin', 'Huw', 'Iolo', 'Owain', 'Rhodri', 'Steffan', 'Tomos'], last: ['Bevan', 'Galmor', 'Griffith', 'Howell', 'Llewellyn', 'Madoc', 'Owen', 'Parry', 'Pryce', 'Rees', 'Vaughan', 'Wynne'] },
  { id: 'n-halvaro', name: 'Halvaro', abbr: 'HLV', strength: 2, flavour: 'balanced', flag: { pattern: 'canton', colours: [0xf4f4f4, 0xd81f3c, 0x14306b] },
    home: kit(0xf4f4f4, 0x14306b, 0xf4f4f4, 0xd81f3c, 0x1f9d55, 0xd81f3c), away: kit(0xd81f3c, 0xd81f3c, 0x14306b, 0xffffff, 0x2b2d33), style: 'Proven winners with a strong spine.',
    first: ['Adrien', 'Baptiste', 'Clement', 'Damien', 'Etienne', 'Florian', 'Gael', 'Julien', 'Mathis', 'Remi', 'Theo', 'Yann'], last: ['Arnaud', 'Bellamy', 'Chevalier', 'Dufort', 'Fabre', 'Garnier', 'Halvert', 'Lemaire', 'Marchand', 'Roussel', 'Vasseur', 'Vidal'] },
  { id: 'n-isolde', name: 'Isolde Isles', abbr: 'ISI', strength: -3, flavour: 'pace', flag: { pattern: 'saltire', colours: [0x0f8b8d, 0xf4f4f4, 0xf6c344] },
    home: kit(0x0f8b8d, 0xf4f4f4, 0x0f8b8d, 0xffffff, 0xe23d28), away: kit(0xf6c344, 0x0f8b8d, 0xf6c344, 0x0f8b8d, 0x2b2d33), style: 'Island outsiders: quick, brave and dangerous on the break.',
    first: ['Kai', 'Manu', 'Tane', 'Rangi', 'Nikau', 'Ari', 'Hemi', 'Wiremu', 'Ihaia', 'Koa', 'Leilani', 'Mika'], last: ['Ahomana', 'Faleolo', 'Isolu', 'Kaufana', 'Lealofi', 'Manumea', 'Paepae', 'Ropati', 'Sopoaga', 'Tuilagi', 'Vaifale', 'Waaka'] },
  { id: 'n-jarvonia', name: 'Jarvonia', abbr: 'JRV', strength: -1, flavour: 'passing', flag: { pattern: 'bi-h', colours: [0x5b2a86, 0xf2c14e, 0x5b2a86] },
    home: kit(0x5b2a86, 0x5b2a86, 0xf2c14e, 0xf2c14e, 0x1f9d55), away: kit(0xf2c14e, 0x5b2a86, 0xf2c14e, 0x5b2a86, 0xe23d28), style: 'Neat passers who like the ball and hate running after it.',
    first: ['Andras', 'Bence', 'Csaba', 'Dominik', 'Gergo', 'Istvan', 'Janos', 'Levente', 'Marton', 'Peter', 'Tamas', 'Zsolt'], last: ['Balogh', 'Csonka', 'Farkas', 'Horvath', 'Jarvas', 'Kovacs', 'Lakatos', 'Meszaros', 'Nagy', 'Szabo', 'Toth', 'Varga'] },
  { id: 'n-korvash', name: 'Korvash', abbr: 'KVS', strength: -2, flavour: 'attack', flag: { pattern: 'bi-v', colours: [0x111111, 0xe8742a, 0x111111] },
    home: kit(0x111111, 0x111111, 0xe8742a, 0xe8742a, 0x2f6fde, 0xe8742a), away: kit(0xe8742a, 0x111111, 0xe8742a, 0x111111, 0x1f9d55), style: 'Goals in them, but the back line can be got at.',
    first: ['Aram', 'Davit', 'Gor', 'Hayk', 'Karen', 'Levon', 'Narek', 'Ruben', 'Sarkis', 'Tigran', 'Vardan', 'Zaven'], last: ['Arakelyan', 'Baghdasar', 'Danielyan', 'Grigoryan', 'Hakobyan', 'Korvashian', 'Manukyan', 'Mkrtchyan', 'Petrosyan', 'Sargsyan', 'Torosyan', 'Vardanyan'] },
  { id: 'n-lunaria', name: 'Lunaria', abbr: 'LNR', strength: -1, flavour: 'balanced', flag: { pattern: 'star', colours: [0x0e2a52, 0xd5dbe0, 0x0e2a52] },
    home: kit(0x0e2a52, 0xd5dbe0, 0x0e2a52, 0xd5dbe0, 0xf2b705), away: kit(0xd5dbe0, 0x0e2a52, 0xd5dbe0, 0x0e2a52, 0xe23d28), style: 'Tidy and well drilled, short of a cutting edge.',
    first: ['Aleks', 'Dmitri', 'Egor', 'Fyodor', 'Ilya', 'Kirill', 'Lev', 'Maksim', 'Oleg', 'Pavel', 'Roman', 'Yuri'], last: ['Antonov', 'Belov', 'Dorin', 'Grekov', 'Ivanko', 'Lunin', 'Orlov', 'Popov', 'Sokolov', 'Titov', 'Volkov', 'Zorin'] },
  { id: 'n-mardesh', name: 'Mardesh', abbr: 'MRD', strength: -2, flavour: 'defence', flag: { pattern: 'tri-v', colours: [0x1c7c3c, 0xf4f4f4, 0xd81f3c] },
    home: kit(0xf4f4f4, 0x1c7c3c, 0xf4f4f4, 0x1c7c3c, 0xe8742a), away: kit(0x1c7c3c, 0x1c7c3c, 0xd81f3c, 0xffffff, 0x2b2d33), style: 'Deep defence and long balls: tough to break down.',
    first: ['Amir', 'Bilal', 'Hamza', 'Karim', 'Malik', 'Nabil', 'Omar', 'Rami', 'Samir', 'Tarek', 'Yasin', 'Zaid'], last: ['Aziz', 'Bakri', 'Darwish', 'Haddad', 'Kassem', 'Mansour', 'Mardi', 'Nasser', 'Rahal', 'Saleh', 'Toumi', 'Zein'] },
  { id: 'n-novaterra', name: 'Novaterra', abbr: 'NVT', strength: 1, flavour: 'attack', flag: { pattern: 'diag', colours: [0xf2c500, 0x1c7c3c, 0x14306b] },
    home: kit(0xf2c500, 0x14306b, 0xf2c500, 0x1c7c3c, 0x111111), away: kit(0x14306b, 0x14306b, 0x14306b, 0xf2c500, 0xe8742a), style: 'Samba-style attackers with tricks to spare.',
    first: ['Adriano', 'Bento', 'Cauã', 'Davi', 'Edson', 'Gabriel', 'Jorge', 'Leandro', 'Nilton', 'Otavio', 'Thiago', 'Wesley'], last: ['Araujo', 'Batista', 'Cardoso', 'Dantas', 'Freitas', 'Gomes', 'Lima', 'Nogueira', 'Novaes', 'Ribeiro', 'Santana', 'Vieira'] },
  { id: 'n-ostrova', name: 'Ostrova', abbr: 'OSV', strength: -4, flavour: 'balanced', flag: { pattern: 'tri-h', colours: [0xf4f4f4, 0x1d4fd8, 0xd81f3c] },
    home: kit(0xf4f4f4, 0x1d4fd8, 0xd81f3c, 0x1d4fd8, 0xf2b705), away: kit(0x1d4fd8, 0x1d4fd8, 0x1d4fd8, 0xf4f4f4, 0x1f9d55), style: 'Plucky debutants just happy to be here.',
    first: ['Andrei', 'Bogdan', 'Ciprian', 'Dorin', 'Florin', 'Ionut', 'Marius', 'Mihai', 'Radu', 'Sorin', 'Tudor', 'Vlad'], last: ['Albu', 'Barbu', 'Ciobanu', 'Dumitru', 'Enache', 'Ionescu', 'Lupu', 'Munteanu', 'Ostrov', 'Popa', 'Stoica', 'Toma'] },
  { id: 'n-pelagos', name: 'Pelagos', abbr: 'PLG', strength: 1, flavour: 'pace', flag: { pattern: 'band', colours: [0x1d4fd8, 0xf4f4f4, 0x1d4fd8] },
    home: kit(0x1d4fd8, 0xf4f4f4, 0x1d4fd8, 0xffffff, 0xf2b705), away: kit(0xf4f4f4, 0x1d4fd8, 0xf4f4f4, 0x1d4fd8, 0xe23d28), style: 'Rapid wingers and a high line.',
    first: ['Alexis', 'Christos', 'Dimitris', 'Giorgos', 'Ilias', 'Kostas', 'Manolis', 'Nikos', 'Panos', 'Stelios', 'Thanos', 'Vasilis'], last: ['Andreou', 'Galanis', 'Karras', 'Lambrou', 'Mavros', 'Nikolaou', 'Pappas', 'Pelagou', 'Samaras', 'Stamos', 'Vlachos', 'Zervas'] },
];

/** The nations as full squads (built once; ids start with "n-"). */
export const NATIONS: TeamDef[] = NATION_SPECS.map((n) => makeNation(n));
addTeams(NATIONS);
export const isNation = (id: string) => id.startsWith('n-');
export const nationSpec = (id: string) => NATION_SPECS.find((n) => n.id === id) ?? null;

export const GROUP_NAMES = ['A', 'B', 'C', 'D'];
export const KO_ROUNDS = ['Quarter-finals', 'Semi-finals', 'Final'];

export interface Tournament {
  v: 1;
  seed: number;
  nation: string;
  /** Four groups of four nation ids. */
  groups: string[][];
  /** Group matchdays 0..2: every group's two fixtures for that day. */
  groupDays: Fixture[][];
  /** Knockout rounds as they are drawn (quarter-finals, semi-finals, final). */
  ko: Fixture[][];
  /** 0..2 group matchdays, 3 quarter-finals, 4 semi-finals, 5 final, 6 over. */
  stage: number;
  out?: boolean;
  champion?: string;
}

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** A new tournament: seeded draw (the four strongest are spread across the groups). */
export function newTournament(nation: string, seed: number): Tournament {
  const rng = new Rng(seed);
  const bySeed = NATION_SPECS.slice().sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id)).map((n) => n.id);
  const pots = [0, 1, 2, 3].map((p) => shuffle(bySeed.slice(p * 4, p * 4 + 4), rng));
  const groups = [0, 1, 2, 3].map((g) => pots.map((pot) => pot[g]));
  // Each group: day 1 A v B, C v D; day 2 A v C, D v B; day 3 D v A, B v C.
  const order: [number, number][][] = [[[0, 1], [2, 3]], [[0, 2], [3, 1]], [[3, 0], [1, 2]]];
  const groupDays = order.map((day) => groups.flatMap((g) => day.map(([h, a]) => ({ home: g[h], away: g[a] }))));
  return { v: 1, seed, nation, groups, groupDays, ko: [], stage: 0 };
}

const teamOf = (id: string): TeamDef => NATIONS.find((t) => t.id === id) ?? NATIONS[0];

export function groupOf(t: Tournament, id: string): number {
  return t.groups.findIndex((g) => g.includes(id));
}

/** A group's table from the matches played so far. */
export function groupTable(t: Tournament, g: number): TableRow[] {
  const ids = t.groups[g];
  const rows = new Map<string, TableRow>(ids.map((id) => [id, { id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
  for (const day of t.groupDays) for (const f of day) {
    if (!rows.has(f.home) || f.hg === undefined || f.ag === undefined) continue;
    const h = rows.get(f.home)!, a = rows.get(f.away)!;
    h.p++; a.p++; h.gf += f.hg; h.ga += f.ag; a.gf += f.ag; a.ga += f.hg;
    if (f.hg > f.ag) { h.w++; a.l++; h.pts += 3; } else if (f.hg < f.ag) { a.w++; h.l++; a.pts += 3; } else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  for (const r of rows.values()) r.gd = r.gf - r.ga;
  // Head-to-head is not used: points, goal difference, goals, then the draw order.
  return [...rows.values()].sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || ids.indexOf(x.id) - ids.indexOf(y.id));
}

export function stageName(t: Tournament, s = t.stage): string {
  if (s < 3) return `Group ${GROUP_NAMES[groupOf(t, t.nation)] ?? ''} · matchday ${s + 1}`;
  return KO_ROUNDS[s - 3] ?? 'Final';
}

/** Your fixture at this stage, or null (out, or the tournament is over). */
export function myTourFixture(t: Tournament): Fixture | null {
  if (t.out || t.champion) return null;
  const list = t.stage < 3 ? t.groupDays[t.stage] : t.ko[t.stage - 3];
  return list?.find((f) => f.home === t.nation || f.away === t.nation) ?? null;
}

export function tourOpponent(t: Tournament): string | null {
  const f = myTourFixture(t);
  return f ? (f.home === t.nation ? f.away : f.home) : null;
}

function winnerOf(f: Fixture): string | undefined {
  if (f.hg === undefined || f.ag === undefined) return undefined;
  if (f.hg !== f.ag) return f.hg > f.ag ? f.home : f.away;
  if (f.pens) return f.pens[0] > f.pens[1] ? f.home : f.away;
  return undefined;
}

function simulate(f: Fixture, rng: Rng, knockout: boolean) {
  const h = teamOf(f.home), a = teamOf(f.away);
  [f.hg, f.ag] = simulateScore(h, a, rng);
  // Neutral grounds: take back some of the home lift by sometimes moving a goal.
  if (knockout && f.hg === f.ag) {
    f.et = true;
    const [eh, ea] = simulateScore(h, a, rng).map((g) => (rng.chance(0.35) ? Math.min(g, 1) : 0));
    f.hg += eh; f.ag += ea;
    if (f.hg === f.ag) f.pens = simulatePens(h, a, rng);
  }
  f.winner = winnerOf(f);
}

/** Quarter-finals: A1 v B2, C1 v D2, B1 v A2, D1 v C2 (so group-mates can only meet again in the final). */
function drawQuarters(t: Tournament): Fixture[] {
  const top = t.groups.map((_, g) => groupTable(t, g).slice(0, 2).map((r) => r.id));
  return [{ home: top[0][0], away: top[1][1] }, { home: top[2][0], away: top[3][1] }, { home: top[1][0], away: top[0][1] }, { home: top[3][0], away: top[2][1] }];
}

/** Records your result and plays the rest of the stage, then moves on (drawing the next round). */
export function recordTourResult(t0: Tournament, mine: number, theirs: number, pens?: [number, number], et = false): Tournament {
  const t: Tournament = JSON.parse(JSON.stringify(t0));
  const f = myTourFixture(t);
  if (!f) return t;
  const rng = new Rng((t.seed ^ (t.stage * 7919 + 101)) >>> 0);
  const home = f.home === t.nation;
  f.hg = home ? mine : theirs; f.ag = home ? theirs : mine; f.et = et || undefined;
  if (pens) f.pens = home ? pens : [pens[1], pens[0]];
  f.winner = winnerOf(f);
  const ko = t.stage >= 3;
  const list = ko ? t.ko[t.stage - 3] : t.groupDays[t.stage];
  for (const o of list) if (o !== f) simulate(o, rng, ko);
  advance(t);
  // Out: play the rest at once so the final can be seen.
  if (t.out) while (!t.champion) { const fx = t.ko[t.stage - 3] ?? t.groupDays[t.stage]; for (const o of fx) if (o.hg === undefined) simulate(o, rng, t.stage >= 3); advance(t); }
  return t;
}

function advance(t: Tournament) {
  t.stage++;
  if (t.stage === 3) {
    const qf = drawQuarters(t);
    t.ko.push(qf);
    if (!qf.some((f) => f.home === t.nation || f.away === t.nation)) t.out = true;
  } else if (t.stage > 3) {
    const prev = t.ko[t.stage - 4];
    const winners = prev.map((f) => f.winner!);
    if (!t.out && !winners.includes(t.nation)) t.out = true;
    if (winners.length === 1) { t.champion = winners[0]; t.stage = 6; return; }
    const next: Fixture[] = [];
    for (let i = 0; i < winners.length; i += 2) next.push({ home: winners[i], away: winners[i + 1] });
    t.ko.push(next);
  }
}

export function isTournament(x: unknown): x is Tournament {
  const t = x as Tournament;
  return !!t && t.v === 1 && typeof t.nation === 'string' && Array.isArray(t.groups) && t.groups.length === 4 && Array.isArray(t.groupDays) && Array.isArray(t.ko) && typeof t.stage === 'number';
}
