// Be a Pro (19 Nov 2026): you are one player for a whole career. In a match you control only him
// (Match `lock`); pass or through ball without the ball calls for it and the teammate on the ball
// plays it to you. After each match his rating earns experience; levels give points to spend on
// his attributes, so his overall climbs season by season. Pure data and functions, no DOM.

import { leadTarget } from './kick';
import { Rng } from './rng';
import { newCompetition, myFixture, opponentOf, recordResult, roundName, leagueTable, type Competition } from './competition';
import { ROLES, statLine, teamById, type Attributes, type PlayerDef, type Role, type TeamDef } from './teams';
import type { Match } from './match';
import type { InputEvent, Player } from './types';

// ------------------------------------------------------------------ in the match

/**
 * Be a Pro: pass, through ball or lob pressed without the ball while a teammate has it (or the
 * keeper holds it) asks him to play it to you. Returns true when the press was used for that.
 */
export function callForBall(m: Match, p: Player, e: InputEvent): boolean {
  if (e.k !== 'pass' && e.k !== 'through' && e.k !== 'lob') return false;
  const b = m.ball;
  if (b.owner < 0 || b.owner === p.id) return false;
  const carrier = m.players[b.owner];
  if (carrier.team !== p.team) return false;
  p.callUntil = m.time + 1.4;
  m.emit('call', { team: p.team, player: p.id, text: e.k === 'through' ? 'callthrough' : 'callball' });
  if (carrier.action.type !== 'none') return true;
  const kind = e.k;
  const dir = m.attackDir(p.team);
  if (b.state === 'held' && carrier.role === 'GK') {
    // The keeper rolls it out or throws it to you.
    m.startKick(carrier, { kind: 'throw', variant: Math.hypot(p.pos.x - carrier.pos.x, p.pos.z - carrier.pos.z) < 25 ? 'roll' : undefined, receiver: p.id, target: { x: p.pos.x, y: 0, z: p.pos.z } }, true);
    return true;
  }
  if (b.state !== 'dribble') return true;
  const T = leadTarget(carrier, p, kind === 'lob' ? 'lob' : kind, dir);
  // A through ball goes into the space ahead of you.
  const ahead = kind === 'through' ? { x: T.x + dir * 4, z: T.z } : T;
  m.startKick(carrier, { kind, receiver: p.id, target: { x: ahead.x, y: 0, z: ahead.z } });
  return true;
}

// ------------------------------------------------------------------ the pro's career

export const PRO_POSITIONS: Role[] = ['ST', 'RW', 'LW', 'RCM', 'CDM', 'RCB', 'RB'];
export const PRO_POS_NAMES: Record<string, string> = { ST: 'Striker', RW: 'Right winger', LW: 'Left winger', RCM: 'Central midfielder', CDM: 'Defensive midfielder', RCB: 'Centre-back', RB: 'Full-back' };
export const PRO_ATTRS: (keyof Attributes)[] = ['pace', 'acceleration', 'stamina', 'control', 'passing', 'shooting', 'tackling'];
export const ATTR_NAMES: Record<keyof Attributes, string> = { pace: 'Pace', acceleration: 'Acceleration', stamina: 'Stamina', control: 'Ball control', passing: 'Passing', shooting: 'Shooting', tackling: 'Tackling', goalkeeping: 'Goalkeeping' };
/** What each position improves by itself at a level-up. */
const FOCUS: Record<string, (keyof Attributes)[]> = {
  ST: ['shooting', 'control'], RW: ['pace', 'control'], LW: ['pace', 'control'], RCM: ['passing', 'control'], CDM: ['tackling', 'passing'], RCB: ['tackling', 'pace'], RB: ['pace', 'tackling'],
};
const START: Record<string, Attributes> = {
  ST: { pace: 72, acceleration: 72, stamina: 66, control: 62, passing: 52, shooting: 66, tackling: 30, goalkeeping: 10 },
  RW: { pace: 76, acceleration: 76, stamina: 66, control: 64, passing: 56, shooting: 56, tackling: 32, goalkeeping: 10 },
  LW: { pace: 76, acceleration: 76, stamina: 66, control: 64, passing: 56, shooting: 56, tackling: 32, goalkeeping: 10 },
  RCM: { pace: 64, acceleration: 66, stamina: 72, control: 64, passing: 66, shooting: 54, tackling: 52, goalkeeping: 10 },
  CDM: { pace: 62, acceleration: 62, stamina: 74, control: 60, passing: 62, shooting: 46, tackling: 66, goalkeeping: 10 },
  RCB: { pace: 64, acceleration: 60, stamina: 70, control: 54, passing: 56, shooting: 34, tackling: 68, goalkeeping: 10 },
  RB: { pace: 72, acceleration: 70, stamina: 72, control: 58, passing: 58, shooting: 40, tackling: 62, goalkeeping: 10 },
};

export interface ProLine { apps: number; goals: number; assists: number; ratingSum: number; motm: number }
export interface ProSeason extends ProLine { season: number; club: string; pos: number; size: number; ovr: number }

export interface ProPlayer {
  v: 1;
  name: string;
  short: string;
  number: number;
  pos: Role;
  attrs: Attributes;
  skin: number;
  hair: number;
  foot: 'R' | 'L';
  club: string;
  age: number;
  xp: number;
  level: number;
  /** Points from levelling up, to spend on attributes. */
  points: number;
  season: number;
  comp: Competition;
  total: ProLine;
  current: ProLine;
  history: ProSeason[];
  /** The last few matches: result text and rating. */
  recent: { text: string; rating: number }[];
  /** A bigger club wants you (decided at the end of a season). */
  offer: string | null;
  seed: number;
}

const emptyLine = (): ProLine => ({ apps: 0, goals: 0, assists: 0, ratingSum: 0, motm: 0 });

export function newPro(name: string, pos: Role, club: string, seed: number, look: { skin: number; hair: number; foot: 'R' | 'L'; number: number }): ProPlayer {
  const clean = name.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 24) || 'Alex Player';
  const parts = clean.split(/\s+/);
  const pp: ProPlayer = {
    v: 1, name: clean, short: parts[parts.length - 1].slice(0, 14), number: Math.max(2, Math.min(99, look.number || 18)), pos: PRO_POSITIONS.includes(pos) ? pos : 'ST',
    attrs: { ...START[PRO_POSITIONS.includes(pos) ? pos : 'ST'] }, skin: look.skin, hair: look.hair, foot: look.foot, club, age: 18, xp: 0, level: 1, points: 3, season: 1,
    comp: newCompetition('league', club, seed, 12), total: emptyLine(), current: emptyLine(), history: [], recent: [], offer: null, seed,
  };
  return pp;
}

export const proDef = (p: ProPlayer): PlayerDef => ({ name: p.name, short: p.short, number: p.number, role: p.pos, attrs: { ...p.attrs }, skin: p.skin, hair: p.hair, foot: p.foot });
export const proOverall = (p: ProPlayer) => statLine(proDef(p)).ovr;
export const proSlot = (p: ProPlayer) => ROLES.indexOf(p.pos);
export const xpToNext = (level: number) => 120 + level * 30;

/** Your club with you in the side, in your position (the player you replace sits out). */
export function proTeam(p: ProPlayer, base: TeamDef = teamById(p.club)): TeamDef {
  const players = base.players.slice();
  const slot = proSlot(p);
  const taken = new Set(players.map((x, i) => (i === slot ? -1 : x.number)));
  const me = proDef(p);
  if (taken.has(me.number)) { let n = 18; while (taken.has(n)) n++; me.number = n; }
  players[slot] = me;
  return { ...base, players };
}

/** Experience from one match: the rating matters most; goals, assists, Man of the Match and a win add. */
export function xpFor(r: { rating: number; goals: number; assists: number; motm: boolean; result: 'W' | 'D' | 'L' }): number {
  const x = 50 + (r.rating - 6) * 45 + r.goals * 30 + r.assists * 20 + (r.motm ? 40 : 0) + (r.result === 'W' ? 20 : r.result === 'D' ? 8 : 0);
  return Math.max(15, Math.round(x));
}

export interface ProMatch { rating: number; goals: number; assists: number; motm: boolean; gf: number; ga: number; pens?: [number, number]; oppName: string }

/** After a match: experience and levels, the league moves on. Returns what to tell the player. */
export function recordProMatch(p: ProPlayer, r: ProMatch): { xp: number; levels: number; notes: string[] } {
  const result: 'W' | 'D' | 'L' = r.gf > r.ga ? 'W' : r.gf < r.ga ? 'L' : 'D';
  const xp = xpFor({ ...r, result });
  const notes: string[] = [];
  p.xp += xp;
  let levels = 0;
  while (p.xp >= xpToNext(p.level)) {
    p.xp -= xpToNext(p.level);
    p.level++;
    levels++;
    p.points += 3;
    // His position's key skills come on by themselves too.
    for (const k of FOCUS[p.pos] ?? []) p.attrs[k] = Math.min(99, p.attrs[k] + 1);
  }
  if (levels) notes.push(`Level ${p.level}! ${levels * 3} points to spend on your attributes.`);
  for (const line of [p.current, p.total]) {
    line.apps++; line.goals += r.goals; line.assists += r.assists; line.ratingSum += r.rating; line.motm += r.motm ? 1 : 0;
  }
  p.recent.unshift({ text: `${result} ${r.gf}–${r.ga} v ${r.oppName}`, rating: r.rating });
  p.recent = p.recent.slice(0, 8);
  if (myFixture(p.comp)) p.comp = recordResult(p.comp, r.gf, r.ga, r.pens);
  return { xp, levels, notes };
}

export function spendPoint(p: ProPlayer, k: keyof Attributes): boolean {
  if (p.points <= 0 || !PRO_ATTRS.includes(k) || p.attrs[k] >= 99) return false;
  p.attrs[k]++;
  p.points--;
  return true;
}

export const proNext = (p: ProPlayer) => { const f = myFixture(p.comp); return f ? { opp: opponentOf(p.comp)!, home: f.home === p.club, round: roundName(p.comp) } : null; };

/**
 * End of season: the season goes in the history, he turns a year older, a new league starts.
 * A strong season (average 7.0+) brings an offer from a club higher up the table.
 */
export function endProSeason(p: ProPlayer): ProSeason {
  const table = leagueTable(p.comp);
  const pos = table.findIndex((r) => r.id === p.club) + 1;
  const c = p.current;
  const s: ProSeason = { ...c, season: p.season, club: p.club, pos, size: table.length, ovr: proOverall(p) };
  p.history.push(s);
  const avg = c.apps ? c.ratingSum / c.apps : 0;
  p.offer = null;
  if (avg >= 7 && pos > 1) {
    const better = table.slice(0, Math.max(1, pos - 1)).map((r) => r.id).filter((id) => id !== p.club);
    const rng = new Rng((p.seed ^ (p.season * 7919)) >>> 0);
    if (better.length) p.offer = better[Math.floor(rng.next() * Math.min(3, better.length))];
  }
  p.season++;
  p.age++;
  p.current = emptyLine();
  p.comp = newCompetition('league', p.club, (p.seed + p.season * 1009) >>> 0, 12);
  return s;
}

/** Take the offer: a new club from next match (the league is redrawn with them). */
export function acceptOffer(p: ProPlayer) {
  if (!p.offer) return;
  p.club = p.offer;
  p.offer = null;
  p.comp = newCompetition('league', p.club, (p.seed + p.season * 1009 + 1) >>> 0, 12);
}

export const seasonDone = (p: ProPlayer) => !myFixture(p.comp);

export function isPro(x: unknown): x is ProPlayer {
  const p = x as ProPlayer;
  return !!p && p.v === 1 && typeof p.name === 'string' && !!p.attrs && !!p.comp;
}
