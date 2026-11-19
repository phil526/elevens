// Injuries (19 Nov 2026, offline matches): a heavy foul can leave the fouled player hurt. Play
// stops; he stays down, the physios run on, and either he gets up and plays on or he is carried
// off on a stretcher and replaced (a side with no substitutions left plays on a man short). The
// time it takes goes into added time. The renderer draws the physios and the stretcher from
// `Match.injury` (see client/render/medics.ts). Career mode keeps injured players out for a few matches.

import { PITCH } from './config';
import type { Match } from './match';
import type { Player, TeamIndex, V2 } from './types';

/** Seconds (match time, not football time) for each part of the treatment. */
export const INJURY = { down: 1.6, runOn: 3.4, treat: 3.2, lift: 1.2, carrySpeed: 1.7, carryMax: 9 } as const;

export interface Injury {
  pid: number;
  team: TeamIndex;
  /** 1 knock (plays on), 2 off on a stretcher (out 1-3 matches), 3 serious (out 3-6). */
  severity: 1 | 2 | 3;
  t: number;
  stage: 'down' | 'runon' | 'treat' | 'lift' | 'carry' | 'done';
  /** Where he went down, and the touchline point the physios come from and go back to. */
  at: V2;
  edge: V2;
  /** Matches he will miss (career mode). */
  matches: number;
}

/** The chance a foul injures: higher for slides, from behind and red-card challenges. */
export function injuryChance(how: { slide?: boolean; fromBehind?: boolean }, card: number): number {
  return 0.1 + (how.slide ? 0.08 : 0) + (how.fromBehind ? 0.06 : 0) + (card === 2 ? 0.15 : card === 1 ? 0.04 : 0);
}

/** After a foul that stopped play: perhaps the fouled player is hurt. */
export function maybeInjure(m: Match, victim: Player, how: { slide?: boolean; fromBehind?: boolean }, card: number) {
  if (!m.cfg.injuries || m.injury || victim.off || victim.role === 'GK' || m.cfg.practice || m.shootout) return;
  if (!m.rng.chance(injuryChance(how, card) * (m.cfg.injuries === 'more' ? 2.5 : 1))) return;
  const roll = m.rng.next();
  const severity: 1 | 2 | 3 = roll < 0.55 ? 1 : roll < 0.92 ? 2 : 3;
  startInjury(m, victim, severity);
}

export function startInjury(m: Match, victim: Player, severity: 1 | 2 | 3) {
  const side = victim.pos.z >= 0 ? 1 : -1;
  const at = { ...victim.pos };
  const edge = { x: Math.max(-PITCH.halfLength + 4, Math.min(PITCH.halfLength - 4, at.x)), z: side * (PITCH.halfWidth + 1.6) };
  const matches = severity === 1 ? 0 : severity === 2 ? 1 + Math.floor(m.rng.next() * 3) : 3 + Math.floor(m.rng.next() * 4);
  m.injury = { pid: victim.id, team: victim.team, severity, t: 0, stage: 'down', at, edge, matches };
  victim.action = { type: 'down', t: 0, dur: 99 };
  victim.vel = { x: 0, z: 0 };
  m.emit('injury', { team: victim.team, player: victim.id, power: severity, x: at.x, z: at.z });
}

/**
 * One step of treatment while play is stopped. Returns true while it goes on (the restart waits);
 * false once he is up again or has been carried off and replaced.
 */
export function stepInjury(m: Match, dt: number): boolean {
  const j = m.injury;
  if (!j || j.stage === 'done') return false;
  const p = m.players[j.pid];
  j.t += dt;
  // Everyone else waits where they are (the restart setup carries on afterwards).
  for (const q of m.players) if (q.id !== p.id && !q.off) q.wish = { x: 0, z: 0, mode: 'walk', face: null };
  p.action = { type: 'down', t: Math.min(j.t, 1), dur: 99 };
  p.vel = { x: 0, z: 0 };
  const endTreat = INJURY.down + INJURY.runOn + INJURY.treat;
  if (j.t < INJURY.down) j.stage = 'down';
  else if (j.t < INJURY.down + INJURY.runOn) j.stage = 'runon';
  else if (j.t < endTreat) j.stage = 'treat';
  else if (j.severity === 1) return finish(m, p, false);
  else if (j.t < endTreat + INJURY.lift) j.stage = 'lift';
  else {
    j.stage = 'carry';
    const d = Math.hypot(j.edge.x - p.pos.x, j.edge.z - p.pos.z);
    const step = INJURY.carrySpeed * dt;
    if (d <= step || j.t > endTreat + INJURY.lift + INJURY.carryMax) return finish(m, p, true);
    p.pos = { x: p.pos.x + ((j.edge.x - p.pos.x) / d) * step, z: p.pos.z + ((j.edge.z - p.pos.z) / d) * step };
  }
  return true;
}

function finish(m: Match, p: Player, carried: boolean): false {
  const j = m.injury!;
  j.stage = 'done';
  m.injuries.push({ pid: p.id, team: j.team, short: p.def.short, name: p.def.name, severity: j.severity, matches: j.matches });
  m.stoppage += carried ? 75 : 40;
  if (!carried) {
    p.action = { type: 'none', t: 0, dur: 0 };
    m.emit('injury', { team: j.team, player: p.id, power: 0, text: 'up' });
    m.injury = null;
    return false;
  }
  // Replaced by the substitute nearest his position, or the side plays on with ten. His name goes
  // in the event text, because the substitute takes over his slot (and id) straight away.
  const who = p.def.short;
  const group = (r: string) => (r === 'GK' ? 0 : ['RB', 'RCB', 'LCB', 'LB'].includes(r) ? 1 : ['CDM', 'RCM', 'LCM'].includes(r) ? 2 : r === 'ST' ? 4 : 3);
  const free = m.benchFree(j.team).filter((i) => m.bench[j.team][i].role !== 'GK');
  const pick = free.find((i) => group(m.bench[j.team][i].role) === group(p.role)) ?? free[0];
  const subbed = pick !== undefined && m.subsUsed(j.team) < m.maxSubs && m.requestSub(j.team, p.id, pick);
  if (!subbed) { p.off = true; p.pos = { ...j.edge }; }
  p.action = { type: 'none', t: 0, dur: 0 };
  // The substitute (or nobody) comes on where the injured man went down.
  if (subbed) p.pos = { x: j.edge.x, z: j.edge.z - Math.sign(j.edge.z) * 1.5 };
  m.emit('injury', { team: j.team, player: p.id, power: j.severity, text: `${subbed ? 'subbed' : 'tenmen'}:${who}` });
  m.injury = null;
  return false;
}
