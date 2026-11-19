// Club playing styles (19 Nov 2026). Every computer-controlled club plays its own way:
// keeping the ball, sitting deep and breaking, going long to the front men, or pressing high.
// Applied only to sides the computer runs, so your own team plays the way you play it.

import type { MentalityParams } from './config';
import type { Flavour } from './teams';
import { G6 } from './switches';

export type PlayStyle = 'possession' | 'counter' | 'longball' | 'press' | 'balanced';
export const PLAY_STYLES: PlayStyle[] = ['possession', 'counter', 'longball', 'press', 'balanced'];
export const PLAY_STYLE_NAMES: Record<PlayStyle, string> = {
  possession: 'Possession', counter: 'Counter-attack', longball: 'Long ball', press: 'High press', balanced: 'Balanced',
};
export const PLAY_STYLE_NOTES: Record<PlayStyle, string> = {
  possession: 'Short passes, patient build-up, the keeper rolls it out.',
  counter: 'Sits deep, then breaks fast the moment it wins the ball.',
  longball: 'Goes long early to the front men and fights for the second ball.',
  press: 'Hunts the ball high up the pitch with a high line.',
  balanced: 'Mixes it up: no strong preference.',
};

/** The built-in clubs' styles (by club id). Custom clubs follow their flavour. */
export const CLUB_STYLES: Record<string, PlayStyle> = {
  redmoor: 'press', kestrel: 'possession',
  ironbridge: 'counter', northgate: 'balanced', saltmarsh: 'counter', harrowfield: 'press', valeforge: 'possession', portcalder: 'longball',
  kingsmere: 'possession', stormhollow: 'press', copperfield: 'balanced', brackenridge: 'longball', gullhaven: 'counter', emberton: 'press',
  wexley: 'possession', duskmoor: 'counter', silverpine: 'possession', larkspur: 'press', oakhurst: 'longball', highmarsh: 'balanced',
};
const FLAVOUR_STYLE: Record<Flavour, PlayStyle> = { balanced: 'balanced', pace: 'counter', passing: 'possession', attack: 'press', defence: 'longball' };

/** A club's style by id (custom clubs: by their flavour when known). */
export function clubStyle(id: string, flavour?: Flavour): PlayStyle {
  return CLUB_STYLES[id] ?? (flavour ? FLAVOUR_STYLE[flavour] : 'balanced');
}

/** A style's effect on the team shape (line height, pressing, support distance, runs). */
export function applyPlayStyle(m: MentalityParams, s: PlayStyle | null): MentalityParams {
  switch (s) {
    case 'possession': return { ...m, supportDistance: m.supportDistance - 1.5, runChance: m.runChance * 0.85 };
    case 'counter': return { ...m, lineOffset: m.lineOffset - 3, pressers: Math.max(1, m.pressers - 1), pressRadius: Math.max(7, m.pressRadius - 2), stayHigh: true, dropBack: Math.max(m.dropBack ?? 0, 3) };
    case 'longball': return { ...m, lineOffset: m.lineOffset - 2, supportDistance: m.supportDistance + 2, runChance: Math.min(0.7, m.runChance + 0.08) };
    case 'press': return { ...m, lineOffset: m.lineOffset + 3, pressRadius: m.pressRadius + 2 };
    default: return m;
  }
}

/**
 * How a style tilts the ball carrier's choices: added to each option's score in ai/carrier.ts.
 * `kind` is the option, `progress` how far forward it goes (in 25 m units for passes), `d` the
 * pass length (m), `fresh` true in the first seconds after winning the ball back.
 */
export function styleBias(s: PlayStyle | null, kind: 'pass' | 'lob' | 'through' | 'dribble' | 'shoot' | 'cross' | 'clear', progress: number, d: number, fresh: boolean): number {
  switch (s) {
    case 'possession':
      if (kind === 'pass') return d < 20 ? 0.1 : -0.08;
      if (kind === 'lob') return -0.2;
      if (kind === 'clear') return -0.1;
      if (kind === 'shoot') return -0.05;
      return 0;
    case 'counter':
      if (!fresh) return kind === 'lob' && progress > 0.6 ? 0.05 : 0;
      // Just won it back: forward, fast, before the other side is set.
      if (kind === 'through') return 0.45;
      if ((kind === 'pass' || kind === 'lob') && progress > 0.4) return 0.35;
      if (kind === 'dribble' && progress > 0.5) return 0.25;
      if ((kind === 'pass' || kind === 'lob') && progress < 0) return -0.3;
      return 0;
    case 'longball':
      if (kind === 'lob' && progress > 0.6 && d > 25) return 0.55;
      if (kind === 'pass' && progress < 0.1) return -0.2;
      if (kind === 'dribble') return -0.1;
      if (kind === 'clear') return 0.2;
      return 0;
    case 'press':
      if (kind === 'through') return 0.1;
      if (kind === 'dribble' && progress > 0.5) return 0.08;
      return 0;
    default:
      return 0;
  }
}

/** Seconds after winning the ball in which a counter-attacking side looks to break. */
export const COUNTER_WINDOW = 5;

/** Seconds since this team won the ball back from the other side. */
export const sinceWon = (m: { time: number; wonBallAt: [number, number] }, team: number) => m.time - m.wonBallAt[team];

const styleCache = new Map<string, PlayStyle>();
/**
 * The style a side plays with: its club's, while the computer runs the whole side. Null for a
 * side a person controls (your teammates follow your play and your tactics instead).
 */
export function styleOf(m: { ctrl: { human: boolean }[]; teams: { id: string; style: string }[] }, team: number): PlayStyle | null {
  if (m.ctrl[team].human || !G6.styles) return null;
  const t = m.teams[team];
  let s = styleCache.get(t.id);
  if (!s) {
    s = CLUB_STYLES[t.id] ?? (/breaks? fast|counter/i.test(t.style) ? 'counter' : /keep the ball|possession/i.test(t.style) ? 'possession' : /strong in the tackle|long ball/i.test(t.style) ? 'longball' : /finishers|press/i.test(t.style) ? 'press' : 'balanced');
    if (!t.id.startsWith('custom-')) styleCache.set(t.id, s);
  }
  return s;
}

/** A club's style for menus and line-ups (custom clubs by their description). */
export function styleForClub(t: { id: string; style: string }): PlayStyle {
  return styleOf({ ctrl: [{ human: false }], teams: [t] }, 0)!;
}
