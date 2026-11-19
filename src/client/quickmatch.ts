// Quick match: the last match setup (clubs, kits, difficulty, length, draw rule, tactics mood)
// is kept on this device, so the main menu can kick off with it in one press. Also which
// optional menu sections ("More modes", "More match options") the player left open.
// Best effort: storage can be unavailable (private mode), and then defaults are used.

import { MATCH, type Difficulty, type Mentality } from '../shared/config';

export interface MatchChoice {
  club: string;
  opp: string;
  kit: 'home' | 'away';
  oppKit: 'home' | 'away';
  difficulty: Difficulty;
  mentality: Mentality;
  minutes: number;
  draw: 'stand' | 'extra' | 'pens';
}

export interface MenuOpen {
  /** Main menu: the other modes (local multiplayer, cup and league, practice, online, profile). */
  modes: boolean;
  /** Match settings: tactics, formation, sliders, auto-switch, quick restarts. */
  options: boolean;
}

const CHOICE_KEY = 'elevens.quickmatch.v1';
const MENU_KEY = 'elevens.menuopen.v1';

const DIFFS: readonly Difficulty[] = ['casual', 'pro', 'elite', 'adaptive'];
const MENTS: readonly Mentality[] = ['defensive', 'balanced', 'attacking'];
const DRAWS = ['stand', 'extra', 'pens'] as const;
const KITS = ['home', 'away'] as const;

/** A stored setup, checked field by field against `base` (anything unknown keeps the base value). */
export function cleanChoice(raw: unknown, base: MatchChoice, clubOk: (id: string) => boolean = () => true): MatchChoice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
  const out: MatchChoice = {
    club: typeof r.club === 'string' && clubOk(r.club) ? r.club : base.club,
    opp: typeof r.opp === 'string' && clubOk(r.opp) ? r.opp : base.opp,
    kit: pick(r.kit, KITS, base.kit),
    oppKit: pick(r.oppKit, KITS, base.oppKit),
    difficulty: pick(r.difficulty, DIFFS, base.difficulty),
    mentality: pick(r.mentality, MENTS, base.mentality),
    minutes: pick(r.minutes, MATCH.allowedRealMinutes, base.minutes),
    draw: pick(r.draw, DRAWS, base.draw),
  };
  if (out.opp === out.club) out.opp = base.opp !== out.club ? base.opp : base.club;
  return out;
}

export function loadChoice(base: MatchChoice): MatchChoice {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    return raw ? cleanChoice(JSON.parse(raw), base) : { ...base };
  } catch {
    return { ...base };
  }
}

export function saveChoice(c: MatchChoice) {
  try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch { /* storage unavailable */ }
}

export function loadMenuOpen(): MenuOpen {
  try {
    const r = JSON.parse(localStorage.getItem(MENU_KEY) ?? '{}') as Partial<MenuOpen>;
    return { modes: r.modes === true, options: r.options === true };
  } catch {
    return { modes: false, options: false };
  }
}

export function saveMenuOpen(m: MenuOpen) {
  try { localStorage.setItem(MENU_KEY, JSON.stringify(m)); } catch { /* storage unavailable */ }
}

