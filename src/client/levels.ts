// Club levels, weekly challenges and cosmetic rewards (20 Nov 2026). Every match that counts for
// the profile (against the computer, cup and league, career, Be a Pro, tournaments, online) earns
// points towards a level; three challenges come round each week (Monday to Sunday, local time)
// for bonus points; each level unlocks something to wear or show: match balls, net colours, ball
// trails, menu colours, titles and a signature goal celebration. Kept per save slot.

import type { MatchSummary } from './profile';
import { CELEB_KINDS } from './render/celebration';

export type CosmeticKind = 'ball' | 'net' | 'trail' | 'accent' | 'title' | 'celebration';

export interface Cosmetic { id: string; kind: CosmeticKind; name: string; level: number }

/** Everything that can be unlocked, in level order. Level 1 items are what the game always had. */
export const COSMETICS: Cosmetic[] = [
  { id: 'ball-elevens', kind: 'ball', name: 'Elevens match ball', level: 1 },
  { id: 'net-white', kind: 'net', name: 'White nets', level: 1 },
  { id: 'trail-white', kind: 'trail', name: 'White trail', level: 1 },
  { id: 'accent-green', kind: 'accent', name: 'Pitch green menus', level: 1 },
  { id: 'title-rookie', kind: 'title', name: 'Rookie', level: 1 },
  { id: 'ball-classic', kind: 'ball', name: 'Classic black and white ball', level: 2 },
  { id: 'net-black', kind: 'net', name: 'Black nets', level: 3 },
  { id: 'title-regular', kind: 'title', name: 'Regular', level: 4 },
  { id: 'trail-ice', kind: 'trail', name: 'Ice blue trail', level: 5 },
  { id: 'ball-winter', kind: 'ball', name: 'Hi-vis winter ball', level: 6 },
  { id: 'net-red', kind: 'net', name: 'Red nets', level: 7 },
  { id: 'trail-fire', kind: 'trail', name: 'Fire trail', level: 8 },
  { id: 'title-captain', kind: 'title', name: 'Captain', level: 9 },
  { id: 'ball-neon', kind: 'ball', name: 'Neon ball', level: 10 },
  { id: 'accent-red', kind: 'accent', name: 'Derby red menus', level: 11 },
  { id: 'net-club', kind: 'net', name: 'Nets in your club colour', level: 12 },
  { id: 'celebration-pick', kind: 'celebration', name: 'Signature celebration', level: 13 },
  { id: 'accent-purple', kind: 'accent', name: 'Royal purple menus', level: 14 },
  { id: 'trail-club', kind: 'trail', name: 'Trail in your club colour', level: 15 },
  { id: 'title-star', kind: 'title', name: 'Star player', level: 16 },
  { id: 'ball-night', kind: 'ball', name: 'Midnight ball', level: 18 },
  { id: 'net-gold', kind: 'net', name: 'Gold nets', level: 20 },
  { id: 'accent-blue', kind: 'accent', name: 'Electric blue menus', level: 22 },
  { id: 'title-legend', kind: 'title', name: 'Club legend', level: 24 },
  { id: 'trail-gold', kind: 'trail', name: 'Gold trail', level: 26 },
  { id: 'accent-gold', kind: 'accent', name: 'Champions gold menus', level: 28 },
  { id: 'ball-gold', kind: 'ball', name: 'Golden ball', level: 30 },
  { id: 'title-icon', kind: 'title', name: 'Icon', level: 30 },
];

export const MAX_LEVEL = 30;

/** Points needed to go from level n to n + 1. */
export const xpForLevel = (n: number) => 400 + 100 * (n - 1);

/** Level and progress for a points total. */
export function levelOf(xp: number): { level: number; into: number; need: number } {
  let level = 1, left = Math.max(0, Math.floor(xp));
  while (level < MAX_LEVEL && left >= xpForLevel(level)) { left -= xpForLevel(level); level++; }
  return { level, into: left, need: level >= MAX_LEVEL ? 0 : xpForLevel(level) };
}

// ------------------------------------------------------------------ weekly challenges

/** What a challenge looks at: the match summary plus a few numbers from the match analysis. */
export interface MatchFacts extends MatchSummary {
  /** Your pass completion 0..1 (from the analysis; NaN when unknown). */
  passPct: number;
  /** Mode name for challenges ('tournament', 'career', 'pro', 'friends' or the summary's mode). */
  kind: string;
}

export interface ChallengeDef {
  id: string;
  text: string;
  /** How many it takes. */
  target: number;
  /** How much one match adds. */
  add: (f: MatchFacts) => number;
}

const won = (f: MatchFacts) => f.gf > f.ga || (!!f.pens && f.pens[0] > f.pens[1]);
const hard = (d: string) => d === 'elite' || d === 'world' || d === 'adaptive';

export const CHALLENGES: ChallengeDef[] = [
  { id: 'win3', text: 'Win 3 matches', target: 3, add: (f) => (won(f) ? 1 : 0) },
  { id: 'win5', text: 'Win 5 matches', target: 5, add: (f) => (won(f) ? 1 : 0) },
  { id: 'goals8', text: 'Score 8 goals', target: 8, add: (f) => f.gf },
  { id: 'goals15', text: 'Score 15 goals', target: 15, add: (f) => f.gf },
  { id: 'clean2', text: 'Keep 2 clean sheets', target: 2, add: (f) => (f.ga === 0 ? 1 : 0) },
  { id: 'header', text: 'Score 2 headers', target: 2, add: (f) => f.goals.filter((g) => g.kind === 'header').length },
  { id: 'volley', text: 'Score a volley', target: 1, add: (f) => f.goals.filter((g) => g.kind === 'volley').length },
  { id: 'longshot', text: 'Score 2 goals from outside the box', target: 2, add: (f) => f.goals.filter((g) => g.distance > 17).length },
  { id: 'freekick', text: 'Score a direct free kick', target: 1, add: (f) => f.goals.filter((g) => g.kind === 'freekick').length },
  { id: 'thrash', text: 'Win a match by 3 goals or more', target: 1, add: (f) => (f.gf - f.ga >= 3 ? 1 : 0) },
  { id: 'passing', text: 'Complete 80% of your passes in a match', target: 1, add: (f) => (f.passPct >= 0.8 ? 1 : 0) },
  { id: 'elite', text: 'Beat the computer on Elite or harder', target: 1, add: (f) => (won(f) && hard(f.difficulty) ? 1 : 0) },
  { id: 'comeback', text: 'Win a match after going behind', target: 1, add: (f) => (won(f) && comeback(f) ? 1 : 0) },
  { id: 'possession', text: 'Win with 60% of the ball or more', target: 1, add: (f) => (won(f) && f.possession >= 0.6 ? 1 : 0) },
  { id: 'bothhalves', text: 'Score in both halves of a match', target: 2, add: (f) => (f.goals.some((g) => g.minute < 45) && f.goals.some((g) => g.minute >= 45) ? 1 : 0) },
  { id: 'shots', text: 'Have 25 shots on target', target: 25, add: (f) => f.stats.onTarget },
  { id: 'online', text: 'Play 2 online matches', target: 2, add: (f) => (f.mode === 'online' ? 1 : 0) },
  { id: 'competition', text: 'Win 2 cup, league or tournament matches', target: 2, add: (f) => (won(f) && (f.mode === 'cup' || f.mode === 'league' || f.kind === 'tournament' || f.kind === 'career') ? 1 : 0) },
  { id: 'tackles', text: 'Make 30 tackles', target: 30, add: (f) => f.stats.tackles },
  { id: 'hattrick', text: 'Score a hat-trick', target: 1, add: (f) => (Object.values(f.goals.reduce<Record<string, number>>((m, g) => ((m[g.scorer] = (m[g.scorer] ?? 0) + 1), m), {})).some((n) => n >= 3) ? 1 : 0) },
];

function comeback(f: MatchFacts): boolean {
  let s = 0;
  for (const g of f.sequence) { s += g.side; if (s < 0) return true; }
  return false;
}

export const CHALLENGE_XP = 300;

/** Monday of this week (local time) as YYYY-MM-DD: the week's id. */
export function weekOf(d = new Date()): string {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}

/** The three challenges for a week: picked from the list by the week, never two of a kind. */
export function weeklyChallenges(week: string): ChallengeDef[] {
  let h = 2166136261;
  for (let i = 0; i < week.length; i++) h = Math.imul(h ^ week.charCodeAt(i), 16777619);
  const out: ChallengeDef[] = [];
  const families = new Set<string>();
  const fam = (id: string) => id.replace(/\d+$/, '');
  let k = 0;
  while (out.length < 3 && k < 200) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const c = CHALLENGES[h % CHALLENGES.length];
    if (!families.has(fam(c.id))) { families.add(fam(c.id)); out.push(c); }
    k++;
  }
  return out;
}

// ------------------------------------------------------------------ the store

export interface LevelStore {
  v: 1;
  xp: number;
  week: string;
  /** Progress on this week's challenges, by id. */
  progress: Record<string, number>;
  /** Challenges finished this week. */
  done: string[];
  /** Weeks with all three done (a star each). */
  stars: number;
  /** What's equipped, by kind. */
  equip: Partial<Record<CosmeticKind, string>>;
  /** Signature celebration (when unlocked): a celebration kind, or '' for the usual mix. */
  celebration: string;
  /** Matches that earned points. */
  matches: number;
}

export const newLevels = (): LevelStore => ({ v: 1, xp: 0, week: weekOf(), progress: {}, done: [], stars: 0, equip: {}, celebration: '', matches: 0 });

const key = (slot: number) => `elevens.levels.v1.${slot}`;

export function loadLevels(slot: number): LevelStore {
  let raw: Partial<LevelStore> | null = null;
  try { raw = JSON.parse(localStorage.getItem(key(slot)) ?? 'null'); } catch { raw = null; }
  const d = newLevels();
  if (!raw || typeof raw !== 'object') return d;
  const s: LevelStore = {
    v: 1,
    xp: typeof raw.xp === 'number' && raw.xp >= 0 ? raw.xp : 0,
    week: typeof raw.week === 'string' ? raw.week : d.week,
    progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : {},
    done: Array.isArray(raw.done) ? raw.done.filter((x) => typeof x === 'string') : [],
    stars: typeof raw.stars === 'number' ? raw.stars : 0,
    equip: raw.equip && typeof raw.equip === 'object' ? raw.equip : {},
    celebration: typeof raw.celebration === 'string' ? raw.celebration : '',
    matches: typeof raw.matches === 'number' ? raw.matches : 0,
  };
  rollWeek(s);
  return s;
}

export function saveLevels(slot: number, s: LevelStore) {
  try { localStorage.setItem(key(slot), JSON.stringify(s)); } catch { /* storage blocked */ }
}

export function clearLevels(slot: number) {
  try { localStorage.removeItem(key(slot)); } catch { /* storage blocked */ }
}

/** A new week: fresh challenges. */
export function rollWeek(s: LevelStore, now = new Date()) {
  const w = weekOf(now);
  if (s.week !== w) { s.week = w; s.progress = {}; s.done = []; }
}

export const unlocked = (s: LevelStore, c: Cosmetic) => levelOf(s.xp).level >= c.level;

/** The item of a kind in use (the level 1 default if nothing unlocked is chosen). */
export function equipped(s: LevelStore, kind: CosmeticKind): string {
  const id = s.equip[kind];
  const c = COSMETICS.find((x) => x.id === id && x.kind === kind);
  if (c && unlocked(s, c)) return c.id;
  return COSMETICS.find((x) => x.kind === kind && x.level === 1)?.id ?? '';
}

export const titleOf = (s: LevelStore) => COSMETICS.find((c) => c.id === equipped(s, 'title'))?.name ?? 'Rookie';

const DIFF_K: Record<string, number> = { casual: 0.8, pro: 1, elite: 1.2, world: 1.35, adaptive: 1.25, '': 1.15 };

/** Points for one match, with the reasons. */
export function matchXp(f: MatchFacts): { total: number; lines: [string, number][] } {
  const lines: [string, number][] = [['Played', 100]];
  if (won(f)) lines.push(['Win', 60]);
  else if (f.gf === f.ga && !f.pens) lines.push(['Draw', 25]);
  if (f.gf) lines.push([`${f.gf} goal${f.gf === 1 ? '' : 's'}`, Math.min(6, f.gf) * 15]);
  if (f.ga === 0) lines.push(['Clean sheet', 30]);
  if (f.mode === 'cup' || f.mode === 'league' || f.kind === 'tournament' || f.kind === 'career' || f.kind === 'friends') lines.push(['Competition', 30]);
  const base = lines.reduce((n, [, x]) => n + x, 0);
  const k = DIFF_K[f.difficulty] ?? 1;
  if (k !== 1) lines.push([f.difficulty ? `${f.difficulty[0].toUpperCase()}${f.difficulty.slice(1)} difficulty` : 'Online', Math.round(base * (k - 1))]);
  return { total: lines.reduce((n, [, x]) => n + x, 0), lines };
}

export interface LevelResult {
  xp: number;
  lines: [string, number][];
  before: number;
  after: number;
  unlocks: Cosmetic[];
  finished: ChallengeDef[];
  star: boolean;
}

/** Counts a match: points, challenge progress, new level and unlocks. */
export function recordLevels(s: LevelStore, f: MatchFacts, now = new Date()): LevelResult {
  rollWeek(s, now);
  const before = levelOf(s.xp).level;
  const { total, lines } = matchXp(f);
  let xp = total;
  const finished: ChallengeDef[] = [];
  for (const c of weeklyChallenges(s.week)) {
    if (s.done.includes(c.id)) continue;
    const add = c.add(f);
    if (!add) continue;
    s.progress[c.id] = Math.min(c.target, (s.progress[c.id] ?? 0) + add);
    if (s.progress[c.id] >= c.target) { s.done.push(c.id); finished.push(c); xp += CHALLENGE_XP; lines.push([`Challenge: ${c.text}`, CHALLENGE_XP]); }
  }
  const star = finished.length > 0 && s.done.length >= 3;
  if (star) { s.stars++; xp += 500; lines.push(['All three this week', 500]); }
  s.xp += xp;
  s.matches++;
  const after = levelOf(s.xp).level;
  const unlocks = COSMETICS.filter((c) => c.level > before && c.level <= after);
  return { xp, lines, before, after, unlocks, finished, star };
}

// ------------------------------------------------------------------ screen


const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const CELEB_NAMES: Record<string, string> = {
  kneeSlide: 'Knee slide', badgeKiss: 'Badge kiss', huddle: 'Team huddle', cheer: 'Fist pump', aeroplane: 'Aeroplane',
  kneelSky: 'Kneel and point', cupEar: 'Cup the ear', pointCrowd: 'Point to the crowd', dance: 'Dance', bow: 'Take a bow',
};

const KIND_NAMES: Record<CosmeticKind, string> = { ball: 'Match balls', net: 'Goal nets', trail: 'Ball trails', accent: 'Menu colours', title: 'Titles', celebration: 'Celebration' };

/** Menu accent colours: [accent, ink on accent]. */
export const ACCENTS: Record<string, [string, string]> = {
  'accent-green': ['#3ee08f', '#062b18'], 'accent-red': ['#ff5a5f', '#2b0608'], 'accent-purple': ['#b07cff', '#1b0b33'],
  'accent-blue': ['#3fb7ff', '#04203a'], 'accent-gold': ['#f2c14e', '#2e2104'],
};

export function applyAccent(id: string) {
  const a = ACCENTS[id] ?? ACCENTS['accent-green'];
  try { document.documentElement.style.setProperty('--accent', a[0]); document.documentElement.style.setProperty('--accent-ink', a[1]); } catch { /* no document */ }
}

/** Swatch shown on reward cards. */
const SWATCH: Record<string, string> = {
  'ball-elevens': 'radial-gradient(circle at 35% 35%, #fff, #e8e8e0 55%, #18c997 56%, #141c34)',
  'ball-classic': 'radial-gradient(circle at 35% 35%, #fff, #eee 50%, #121214 51%)',
  'ball-winter': 'radial-gradient(circle at 35% 35%, #ffd27a, #ffa820 55%, #101840 56%)',
  'ball-neon': 'radial-gradient(circle at 35% 35%, #f7ff9a, #ecff3c 55%, #ff2896 56%)',
  'ball-night': 'radial-gradient(circle at 35% 35%, #444, #1a1c22 55%, #3ce68c 56%)',
  'ball-gold': 'radial-gradient(circle at 35% 35%, #fff4c8, #ecc45c 60%, #966418)',
  'net-white': '#ffffff', 'net-black': '#1a1a1a', 'net-red': '#e0322c', 'net-club': 'linear-gradient(135deg, #3ee08f, #1f6fde)', 'net-gold': '#e6b84a',
  'trail-white': '#fffff6', 'trail-ice': '#8fe3ff', 'trail-fire': 'linear-gradient(90deg, #ffd23a, #ff5a1f)', 'trail-club': 'linear-gradient(135deg, #3ee08f, #1f6fde)', 'trail-gold': '#f2c14e',
  'accent-green': '#3ee08f', 'accent-red': '#ff5a5f', 'accent-purple': '#b07cff', 'accent-blue': '#3fb7ff', 'accent-gold': '#f2c14e',
};

/** Net and trail colours for the renderer (null = the usual). `club` is your shirt colour. */
export function netColour(id: string, club: number): number | null {
  return ({ 'net-black': 0x262626, 'net-red': 0xd8302a, 'net-club': club, 'net-gold': 0xe6b84a } as Record<string, number>)[id] ?? null;
}
export function trailColour(id: string, club: number): number | null {
  return ({ 'trail-ice': 0x8fe3ff, 'trail-fire': 0xff8a2a, 'trail-club': club, 'trail-gold': 0xf2c14e } as Record<string, number>)[id] ?? null;
}

export function levelBar(s: LevelStore, small = false): string {
  const l = levelOf(s.xp);
  const pct = l.need ? Math.round((l.into / l.need) * 100) : 100;
  return `<div class="lvl-bar${small ? ' small' : ''}"><span class="lvl-n">${l.level}</span><div><b>Club level ${l.level} · ${esc(titleOf(s))}</b><div class="lvl-track"><i style="width:${pct}%"></i></div><small>${l.need ? `${l.into} / ${l.need} points to level ${l.level + 1}` : 'Top level reached'}</small></div></div>`;
}

/** What the full-time panel shows after a match counted. */
export function levelNoteHtml(s: LevelStore, r: LevelResult): string {
  const ups = r.after > r.before ? `<p class="lvl-up">Level up! Club level ${r.after}.${r.unlocks.length ? ` Unlocked: ${r.unlocks.map((u) => esc(u.name)).join(', ')}.` : ''}</p>` : '';
  return `<div class="lvl-note">${levelBar(s, true)}<p class="note">+${r.xp} points: ${r.lines.map(([t, n]) => `${esc(t)} ${n > 0 ? '+' : ''}${n}`).join(' · ')}</p>${ups}${r.finished.map((c) => `<p class="lvl-ch">✓ Weekly challenge done: ${esc(c.text)}</p>`).join('')}</div>`;
}

export interface LevelsHost {
  set(html: string, cls?: string): void;
  on(sel: string, fn: (el: HTMLElement) => void): void;
  back(): void;
  changed(): void;
}

/** "Club level and challenges": progress, this week's challenges and the rewards to equip. */
export function showLevels(h: LevelsHost, s: LevelStore) {
  rollWeek(s);
  const lvl = levelOf(s.xp).level;
  const week = weeklyChallenges(s.week);
  const ends = new Date(`${s.week}T00:00:00`);
  ends.setDate(ends.getDate() + 7);
  const daysLeft = Math.max(1, Math.ceil((ends.getTime() - Date.now()) / 86_400_000));
  const ch = week.map((c) => {
    const n = Math.min(c.target, s.progress[c.id] ?? 0), done = s.done.includes(c.id);
    return `<div class="wk${done ? ' done' : ''}"><span class="ic">${done ? '✓' : '★'}</span><div><b>${esc(c.text)}</b><div class="lvl-track"><i style="width:${Math.round((n / c.target) * 100)}%"></i></div><small>${n} / ${c.target} · +${CHALLENGE_XP} points</small></div></div>`;
  }).join('');
  const kinds: CosmeticKind[] = ['ball', 'net', 'trail', 'accent', 'title'];
  const rewards = kinds.map((k) => `<h4>${KIND_NAMES[k]}</h4><div class="rewards">${COSMETICS.filter((c) => c.kind === k).map((c) => {
    const open = unlocked(s, c), on = equipped(s, k) === c.id;
    const sw = SWATCH[c.id];
    return `<button class="reward${on ? ' on' : ''}${open ? '' : ' locked'}" data-equip="${c.id}" ${open ? '' : 'disabled'}>${sw ? `<span class="sw" style="background:${sw}"></span>` : ''}<b>${esc(c.name)}</b><small>${open ? (on ? 'In use' : 'Use') : `Level ${c.level}`}</small></button>`;
  }).join('')}</div>`).join('');
  const celebOpen = lvl >= (COSMETICS.find((c) => c.id === 'celebration-pick')?.level ?? 13);
  const celeb = `<h4>Signature celebration</h4>${celebOpen
    ? `<div class="seg wrap" data-seg="celeb">${[['', 'Mix them up'], ...CELEB_KINDS.map((k) => [k, CELEB_NAMES[k] ?? k])].map(([v, t]) => `<button class="${s.celebration === v ? 'on' : ''}" data-v="${v}">${esc(t)}</button>`).join('')}</div><p class="note">Your scorers do this after every goal (offline matches with celebrations on).</p>`
    : `<p class="note">Unlocks at level 13: choose the celebration your players do after every goal.</p>`}`;
  h.set(`<div class="panel levels">
    <h2>Club level and challenges</h2>
    ${levelBar(s)}
    <p class="note">Every match earns points: more for wins, goals, clean sheets, competitions and harder opponents. ${s.matches} matches counted · ${s.stars} perfect week${s.stars === 1 ? '' : 's'}.</p>
    <h3>This week's challenges <small class="note">${daysLeft} day${daysLeft === 1 ? '' : 's'} left</small></h3>
    <div class="weekly">${ch}</div>
    <p class="note">Finish all three for a 500 point bonus. New challenges every Monday.</p>
    <h3>Rewards</h3>
    ${rewards}${celeb}
    <div class="row end" style="margin-top:16px"><button class="btn primary" data-a="back" autofocus>Back</button></div>
  </div>`, 'scroll');
  h.on('[data-a=back]', () => h.back());
  h.on('[data-equip]', (el) => {
    const c = COSMETICS.find((x) => x.id === el.dataset.equip);
    if (!c || !unlocked(s, c)) return;
    s.equip[c.kind] = c.id;
    if (c.kind === 'accent') applyAccent(c.id);
    h.changed();
    showLevels(h, s);
  });
  h.on('[data-seg=celeb] button', (el) => { s.celebration = el.dataset.v ?? ''; h.changed(); showLevels(h, s); });
}
