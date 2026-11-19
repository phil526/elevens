// Teammate AI, third set (19 Nov): box tracking, shot blocks, set-piece marking, second balls,
// blindside runs, underlaps and partnerships for the human's side. Everything here is gated on
// the team having a human (`m.ctrl[team].human`), so computer v computer matches are unchanged.

import { PITCH, PLAYER } from '../config';
import { landingPoint } from '../ball';
import { laneBlock, pressureOn } from '../kick';
import { angleOf, clamp, dist, norm } from '../math';
import { sprintTop } from '../movement';
import { isDefender, isMidfielder, type Role } from '../teams';
import type { Match } from '../match';
import type { Player, Restart, V2 } from '../types';
import { TEAMMATE_ON, basePos, instrOf, levelOf, tacticsOf, type TeamPlan } from './team';

/** Constants for the third set of teammate behaviours. */
export const MATES3 = {
  /** Box tracking: the ball this deep (team frame) or their cross in flight; marker reach. */
  trackFrom: -20, trackReach: 18, trackMidReach: 12,
  /** Shot blocks: the blocker steps onto the shot line this far from the carrier; lunges at a shot. */
  blockRange: 27, blockStand: 3.0, lungeMin: 0.3, lungeMax: 2.4, lungeAlong: 11, lungers: 2,
  /** Second balls: spots this far beyond and short of where a header or clearance drops. */
  secondOn: 7.5, secondBack: 7, secondReach: 18,
  /** Blindside runs: chance per plan update, total length, drift time, how long a defender takes to notice. */
  blindChance: 0.07, blindLength: 3.4, blindDrift: 0.9, blindRest: 2.5, blindUnseen: 0.55,
  /** Underlaps: carrier this wide; chance of the inside run past a wide winger. */
  underWide: 21, underInside: 0.08,
  /** Set pieces against: how long the assignments hold after the delivery. */
  setPieceHold: 3.5,
} as const;

/** Partnerships: completed passes between a pair build their understanding (full at `full` points). */
export const LINK = { full: 10, steps: [4, 10], accuracy: 0.3, reach: 0.25, call: 0.5 } as const;

const toFrame = (dir: number, p: V2): V2 => ({ x: p.x * dir, z: p.z * dir });
const fromFrame = toFrame;
export const humanSide = (m: Match, team: number) => m.ctrl[team].human;

// ------------------------------------------------------------------ 2. box tracking

/**
 * Defenders track runners into the box: with the ball in our last third (or their cross on its
 * way), every opponent in or arriving in our area is picked up by the nearest free defender (or a
 * holding/central midfielder close by), who stays goal-side and ball-side of him instead of
 * watching the ball. The same marker keeps the same man from one plan to the next.
 */
export function trackBoxRunners(m: Match, plan: TeamPlan, squad: Player[], opp: Player[], old: TeamPlan | null, busy: (id: number) => boolean, taken: Set<number>) {
  const b = m.ball;
  const dir = m.attackDir(plan.team);
  const cross = b.state === 'flight' && b.lastTouchTeam === 1 - plan.team && (b.flight === 'cross' || b.flight === 'lob');
  if (plan.bx > MATES3.trackFrom && !cross) return;
  const goal = { x: m.ownGoalX(plan.team), z: 0 };
  const threats: { o: Player; s: number }[] = [];
  for (const o of opp) {
    if (o.off || o.role === 'GK' || o.id === b.owner) continue;
    const f = toFrame(dir, o.pos);
    const vin = -o.vel.x * dir; // speed towards our goal
    const inBox = f.x < -36 && Math.abs(f.z) < 20;
    const arriving = f.x < -22 && Math.abs(f.z) < 26 && vin > 2.5 && f.x - vin * 1.2 < -36;
    if (!inBox && !arriving) continue;
    threats.push({ o, s: 1 - dist(o.pos, goal) / 30 + Math.max(0, vin) / 12 + (Math.abs(f.z) < 9 ? 0.2 : 0) });
  }
  if (!threats.length) return;
  threats.sort((a, c) => c.s - a.s);
  const used = new Set<number>();
  for (const { o } of threats) {
    let best: Player | null = null, bs = Infinity;
    for (const p of squad) {
      if (p.off || used.has(p.id) || busy(p.id) || plan.fill.has(p.id) || m.isHumanControlled(p) || p.id === plan.cover) continue;
      const mid = p.role === 'CDM' || p.role === 'LCM' || p.role === 'RCM';
      if (!isDefender(p.role) && !mid) continue;
      if (instrOf(m, p) > 0 && !isDefender(p.role)) continue; // told to stay up for the break
      const d = dist(p.pos, o.pos);
      if (d > (mid ? MATES3.trackMidReach : MATES3.trackReach)) continue;
      let s = d;
      if (old?.marks.get(p.id) === o.id) s -= 4; // stay with the same man
      if (!mid) s -= 1.5; // defenders first
      if (s < bs) { bs = s; best = p; }
    }
    if (!best) continue;
    used.add(best.id);
    taken.add(o.id);
    plan.marks.set(best.id, o.id);
    plan.tightMarks.add(best.id);
    plan.boxMarks.add(best.id);
  }
}

/** Where a box marker stands: goal-side of his man and a little towards the ball, a step ahead of the run. */
export function boxMarkSpot(m: Match, p: Player, o: Player): V2 {
  const goal = { x: m.ownGoalX(p.team), z: 0 };
  const g = norm(goal.x - o.pos.x, goal.z - o.pos.z);
  const bl = norm(m.ball.pos.x - o.pos.x, m.ball.pos.z - o.pos.z);
  return { x: o.pos.x + o.vel.x * 0.25 + g.x * 0.9 + bl.x * 0.5, z: o.pos.z + o.vel.z * 0.25 + g.z * 0.9 + bl.z * 0.5 };
}

// ------------------------------------------------------------------ 3. shot blocks

/**
 * Shot line: with an opponent carrying the ball within shooting range of our goal, a teammate
 * who isn't pressing steps onto the line between the ball and goal, a few metres off the carrier,
 * so a shot has to get past a body. Not needed when someone is already standing on that line.
 */
export function shotLine(m: Match, plan: TeamPlan, squad: Player[]) {
  const b = m.ball;
  const carrier = b.owner >= 0 && b.state === 'dribble' ? m.players[b.owner] : null;
  if (!carrier || carrier.team === plan.team) return;
  const goal = { x: m.ownGoalX(plan.team), z: 0 };
  const dG = dist(carrier.pos, goal);
  if (dG > MATES3.blockRange || Math.abs(carrier.pos.z) > 24) return;
  const g = norm(goal.x - carrier.pos.x, goal.z - carrier.pos.z);
  // Anyone (the human included) already standing in the line, 1.5-8 m from the ball?
  for (const p of m.teamPlayers(plan.team)) {
    if (p.off || p.role === 'GK') continue;
    const rx = p.pos.x - carrier.pos.x, rz = p.pos.z - carrier.pos.z;
    const along = rx * g.x + rz * g.z;
    if (along > 1.5 && along < 8 && Math.abs(rx * g.z - rz * g.x) < 1.2) return;
  }
  const S = { x: carrier.pos.x + g.x * MATES3.blockStand, z: carrier.pos.z + g.z * MATES3.blockStand };
  let best: Player | null = null, bs = 10;
  for (const p of squad) {
    if (p.off || m.isHumanControlled(p) || plan.pressers[0] === p.id || plan.counter.has(p.id) || plan.boxMarks.has(p.id)) continue;
    let s = dist(p.pos, S) - (isDefender(p.role) || p.role === 'CDM' ? 1.5 : 0);
    if (dist(p.pos, goal) > dG + 1) s += 3; // has to get back round the ball first
    if (s < bs) { bs = s; best = p; }
  }
  if (!best) return;
  plan.blocker = best.id;
  plan.blockSpot = S;
  plan.marks.delete(best.id);
  plan.tightMarks.delete(best.id);
  plan.laneCover.delete(best.id);
  if (plan.cover === best.id) plan.cover = -1;
}

/**
 * The shot is struck: up to two teammates near its path, who can get there in time, throw
 * themselves in front of it (a block slide across the line). Anyone already right in the path
 * blocks it with their body as before.
 */
export function shotBlockLunges(m: Match, shooter: Player) {
  const team = 1 - shooter.team;
  if (!humanSide(m, team) || !TEAMMATE_ON.block) return;
  const b = m.ball;
  const sp = Math.hypot(b.vel.x, b.vel.z);
  if (sp < 6) return;
  const ux = b.vel.x / sp, uz = b.vel.z / sp;
  const lvl = levelOf(m, team);
  const cands: { p: Player; ap: number; along: number }[] = [];
  for (const p of m.teamPlayers(team)) {
    if (p.off || p.role === 'GK' || m.isHumanControlled(p) || p.action.type !== 'none' || p.beaten > 0) continue;
    const rx = p.pos.x - b.pos.x, rz = p.pos.z - b.pos.z;
    const along = rx * ux + rz * uz;
    if (along < 1.2 || along > MATES3.lungeAlong) continue;
    const ap = Math.abs(rx * uz - rz * ux);
    if (ap < MATES3.lungeMin || ap > MATES3.lungeMax) continue;
    const t = along / sp;
    const y = b.pos.y + b.vel.y * t - 4.9 * t * t;
    if (t < 0.07 || y > 1.3) continue; // no time to react, or it goes over them
    cands.push({ p, ap, along });
  }
  cands.sort((a, c) => a.ap - c.ap);
  let n = 0;
  for (const { p, along } of cands) {
    if (n >= MATES3.lungers) break;
    if (!m.rng.chance(clamp(0.45 + 0.35 * p.a.tackling + 0.2 * lvl.tackleEagerness, 0, 0.9))) continue;
    const C = { x: b.pos.x + ux * along, z: b.pos.z + uz * along };
    p.facing = angleOf(C.x - p.pos.x, C.z - p.pos.z);
    p.action = { type: 'slide', t: 0, dur: PLAYER.slideDuration * 0.8, block: true };
    p.tackleCooldown = PLAYER.slideRecovery;
    n++;
  }
}

// ------------------------------------------------------------------ 4. set pieces against

/** How a human's side defends corners and wide free kicks (Tactics.marking). */
export type Marking = 'mixed' | 'man' | 'zonal';
export interface SetPieceDef { marks: Map<number, number>; zones: Map<number, V2> }
const spCache = new WeakMap<Match, { key: string; def: SetPieceDef }>();

/** A set piece that will be delivered into our box: a corner, or a free kick out wide or too far out to shoot. */
export function crossingSetPiece(m: Match, r: Restart): boolean {
  if (r.type === 'corner') return true;
  if (r.type !== 'freekick') return false;
  const d = dist(r.spot, { x: m.ownGoalX(1 - r.team), z: 0 });
  return d > 16 && d < 42 && (Math.abs(r.spot.z) > 16 || d > 30);
}

/**
 * Who marks whom at a corner or wide free kick against a human's side, and who holds a zone.
 * Mixed (default): three zones (near post, front of the six-yard box, edge of the area) and the rest
 * man-mark the most dangerous attackers. Man: everyone but a near-post man and the edge picks up an
 * attacker. Zonal: a grid across the six-yard box and the penalty spot, nobody follows anyone.
 * `attackT` are the attackers' set-piece positions; the result is cached per restart.
 */
export function setPieceDefence(m: Match, r: Restart, attackT: V2[]): SetPieceDef | null {
  const team = 1 - r.team;
  if (!humanSide(m, team) || !TEAMMATE_ON.setPiece || !crossingSetPiece(m, r)) return null;
  const mode: Marking = tacticsOf(m, team).marking ?? 'mixed';
  const key = `${r.type}:${r.spot.x.toFixed(1)}:${r.spot.z.toFixed(1)}:${r.routine ?? 0}:${r.taker}:${mode}`;
  const hit = spCache.get(m);
  if (hit && hit.key === key) return hit.def;
  const dir = m.attackDir(team);
  const sf = toFrame(dir, r.spot);
  const s = Math.sign(sf.z) || 1;
  const goal = { x: m.ownGoalX(team), z: 0 };
  // Defenders: the usual set-piece eight (two forwards stay up for the break).
  const ROLES: Role[] = ['RCB', 'LCB', 'CDM', 'RB', 'LB', 'LCM', 'RCM', 'LW'];
  const defenders = m.teamPlayers(team).filter((p) => !p.off && ROLES.includes(p.role));
  // Threats: attackers whose set-piece spot is in or around our area, most dangerous first.
  const threats = m.teamPlayers(r.team)
    .filter((o) => !o.off && o.role !== 'GK' && o.id !== r.taker)
    .map((o) => ({ o, T: attackT[o.id] ?? o.pos }))
    .filter(({ T }) => { const f = toFrame(dir, T); return f.x < -32 && Math.abs(f.z) < 22; })
    .map(({ o, T }) => ({ o, s: 1 - dist(T, goal) / 25 + (o.role === 'ST' || o.role === 'RCB' || o.role === 'LCB' ? 0.5 : 0) + 0.3 * o.a.shooting }))
    .sort((a, c) => c.s - a.s);
  const Z = (x: number, z: number) => fromFrame(dir, { x, z });
  const zoneSpots = mode === 'zonal'
    ? [Z(-51.3, s * 3.1), Z(-48.3, s * 2.6), Z(-48.3, -s * 1), Z(-48.6, -s * 4.6), Z(-44.8, s * 1.2), Z(-44.6, -s * 3.6), Z(-50.6, -s * 3.6), Z(-37.5, 0)]
    : mode === 'man' ? [Z(-51.3, s * 3.1), Z(-37.5, -s * 2)]
      : [Z(-51.3, s * 3.1), Z(-47.8, s * 0.8), Z(-37.5, -s * 2)];
  const def: SetPieceDef = { marks: new Map(), zones: new Map() };
  const free = new Set(defenders.map((p) => p.id));
  // Zones go to full-backs and midfielders first (the centre-backs and holding man mark the big threats).
  const zoneOrder = (p: Player) => (p.role === 'RB' || p.role === 'LB' ? 0 : p.role === 'LW' || p.role === 'LCM' || p.role === 'RCM' ? 1 : 2);
  zoneSpots.forEach((Zp, i) => {
    const pool = defenders.filter((p) => free.has(p.id)).sort((a, c) => (i === zoneSpots.length - 1 && mode !== 'zonal'
      ? zoneOrder(c) - zoneOrder(a) // edge of the box: a midfielder
      : zoneOrder(a) - zoneOrder(c)) || dist(a.pos, Zp) - dist(c.pos, Zp));
    const p = pool[0];
    if (!p) return;
    free.delete(p.id);
    def.zones.set(p.id, Zp);
  });
  if (mode !== 'zonal') {
    for (const { o } of threats) {
      const T = attackT[o.id] ?? o.pos;
      const pool = defenders.filter((p) => free.has(p.id));
      if (!pool.length) break;
      // Centre-backs and the holding midfielder take the big men; then whoever is nearest.
      pool.sort((a, c) => (dist(a.pos, T) - (a.role === 'RCB' || a.role === 'LCB' || a.role === 'CDM' ? 8 : 0)) - (dist(c.pos, T) - (c.role === 'RCB' || c.role === 'LCB' || c.role === 'CDM' ? 8 : 0)));
      free.delete(pool[0].id);
      def.marks.set(pool[0].id, o.id);
    }
  }
  // Anyone left over guards the space in front of the six-yard box.
  let k = 0;
  for (const id of free) def.zones.set(id, Z(-45.5, (k++ % 2 ? -s : s) * 3));
  spCache.set(m, { key, def });
  return def;
}

/** Restart position for a marker: goal-side of his man, shading towards the ball. */
export function setPieceMarkSpot(m: Match, team: number, at: V2, ballAt: V2): V2 {
  const goal = { x: m.ownGoalX(team), z: 0 };
  const g = norm(goal.x - at.x, goal.z - at.z);
  const bl = norm(ballAt.x - at.x, ballAt.z - at.z);
  return { x: at.x + g.x * 0.9 + bl.x * 0.35, z: at.z + g.z * 0.9 + bl.z * 0.35 };
}

/** The set piece has been delivered: keep the marks and zones for a few seconds of the scramble. */
export function armSetPiece(m: Match, r: Restart) {
  const hit = spCache.get(m);
  const team = 1 - r.team;
  if (!hit || !humanSide(m, team) || !crossingSetPiece(m, r)) { m.setPieceDef = null; return; }
  m.setPieceDef = { team, until: m.time + MATES3.setPieceHold, marks: hit.def.marks, zones: hit.def.zones };
  spCache.delete(m);
}

/** During the few seconds after a set piece: the markers stay with their men and the zones are held. */
export function applySetPiece(m: Match, plan: TeamPlan) {
  const sp = m.setPieceDef;
  if (!sp || sp.team !== plan.team) return;
  const b = m.ball;
  const ours = b.owner >= 0 && m.players[b.owner].team === plan.team;
  const dir = m.attackDir(plan.team);
  if (m.time > sp.until || ours || m.restart || toFrame(dir, b.pos).x > -22) { m.setPieceDef = null; return; }
  for (const [d, a] of sp.marks) {
    const p = m.players[d], o = m.players[a];
    if (p.off || o.off || m.isHumanControlled(p)) continue;
    plan.marks.set(d, a);
    plan.tightMarks.add(d);
    plan.boxMarks.add(d);
  }
  for (const [d, Z] of sp.zones) {
    if (m.players[d].off || m.isHumanControlled(m.players[d])) continue;
    plan.zones.set(d, Z);
  }
}

// ------------------------------------------------------------------ 5. second balls

/**
 * Second balls: when a header, clearance or deflection is dropping, the teammate best placed
 * attacks where it lands, and up to two more (midfielders first) take up the spots where it
 * usually falls next: a few metres on (flicked on) and a few metres short (headed back).
 */
export function secondBalls(m: Match, plan: TeamPlan, squad: Player[]) {
  const b = m.ball;
  const aerial = (b.state === 'flight' && (b.flight === 'header' || b.flight === 'clear' || b.flight === 'deflect')) || (b.state === 'free' && b.pos.y > 1.2);
  if (!aerial || b.owner >= 0 || (b.pos.y < 0.9 && b.vel.y < 2)) return;
  if (b.receiver >= 0 && m.players[b.receiver].team === plan.team) return; // our own pass: the receiver has it
  const L = landingPoint(b.pos, b.vel, b.spin);
  if (L.t < 0.25 || L.t > 3.5 || Math.abs(L.x) > PITCH.halfLength || Math.abs(L.z) > PITCH.halfWidth) return;
  const eta = (p: Player) => dist(p.pos, L) / (sprintTop(p.a) * 0.92);
  const ours = m.teamPlayers(plan.team).filter((p) => !p.off && p.role !== 'GK');
  const avail = (p: Player) => !m.isHumanControlled(p) && !plan.boxMarks.has(p.id) && !plan.tightMarks.has(p.id) && plan.chaser !== p.id && plan.interceptor !== p.id;
  // Attack the drop: the quickest of ours, unless it is the human (they go themselves).
  const first = ours.slice().sort((a, c) => eta(a) - eta(c))[0];
  if (first && !m.isHumanControlled(first) && avail(first) && eta(first) < L.t + 1.2) plan.secondBall.set(first.id, { x: L.x, z: L.z });
  const sp = Math.hypot(b.vel.x, b.vel.z);
  const u = sp > 1 ? { x: b.vel.x / sp, z: b.vel.z / sp } : { x: m.attackDir(plan.team), z: 0 };
  const spots = [
    { x: L.x + u.x * MATES3.secondOn, z: L.z + u.z * MATES3.secondOn },
    { x: L.x - u.x * MATES3.secondBack, z: L.z - u.z * MATES3.secondBack },
  ].filter((S) => Math.abs(S.x) < PITCH.halfLength - 2 && Math.abs(S.z) < PITCH.halfWidth - 1.5);
  const dir = m.attackDir(plan.team);
  for (const S of spots) {
    if (ours.some((p) => dist(p.pos, S) < 3) || [...plan.secondBall.values()].some((Q) => dist(Q, S) < 3)) continue;
    // Not in front of our own goal: the back line holds its shape there.
    if (toFrame(dir, S).x < -30) continue;
    let best: Player | null = null, bs: number = MATES3.secondReach;
    for (const p of squad) {
      if (p.off || !avail(p) || plan.secondBall.has(p.id)) continue;
      if (isDefender(p.role) && toFrame(dir, p.pos).x < 0) continue; // defenders in our half keep the line
      const s = dist(p.pos, S) - (isMidfielder(p.role) ? 3 : 0) + (p.role === 'RCB' || p.role === 'LCB' ? 4 : 0);
      if (s < bs) { bs = s; best = p; }
    }
    if (best) plan.secondBall.set(best.id, S);
  }
}

// ------------------------------------------------------------------ 6. blindside runs

const blindOf = new WeakMap<Player, { def: number; goAt: number }>();

/**
 * Blindside run: with the human carrying it forward, the striker (or the far-side winger) drifts
 * onto the shoulder of a centre-back on the side away from the ball, out of his eyeline, then
 * darts in behind on that side. Defenders take a moment to pick the run up.
 */
export function blindRun(m: Match, plan: TeamPlan, squad: Player[], carrier: Player) {
  const dir = m.attackDir(plan.team);
  const cf = toFrame(dir, carrier.pos);
  for (const p of squad) {
    if (p.runLane === 7 && p.aiRunUntil > m.time) { plan.runners.add(p.id); plan.supportSpots.delete(p.id); plan.boxTargets.delete(p.id); return; }
  }
  if (cf.x < -8 || cf.x > 36 || Math.cos(carrier.facing) * dir < 0.2) return;
  const line = plan.offsideLineFx;
  const opps = m.teamPlayers(1 - plan.team).filter((o) => !o.off && o.role !== 'GK');
  for (const p of squad) {
    if (p.id === carrier.id || p.off || m.isHumanControlled(p) || instrOf(m, p) < 0) continue;
    const farWing = (p.role === 'LW' || p.role === 'RW') && Math.sign(basePos(m, p.team, p.role).z) !== Math.sign(cf.z || 1) && Math.abs(cf.z) > 6;
    if (p.role !== 'ST' && !farWing) continue;
    if (p.aiHoldUntil > m.time || (p.runLane && p.aiRunUntil > m.time) || p.giveGoUntil > m.time) continue;
    const f = toFrame(dir, p.pos);
    if (f.x < line - 9 || dist(p.pos, carrier.pos) < 10) continue;
    if (!m.rng.chance(MATES3.blindChance)) continue;
    // The centre-back (or nearest defender on the line) to get behind.
    let D: Player | null = null, dd = 10;
    for (const o of opps) {
      const of = toFrame(dir, o.pos);
      if (of.x < line - 3) continue;
      const d = dist(o.pos, p.pos);
      if (d < dd) { dd = d; D = o; }
    }
    if (!D) continue;
    p.runLane = 7;
    p.runStart = m.time;
    p.runTo = null;
    p.aiRunUntil = m.time + MATES3.blindLength;
    p.aiHoldUntil = m.time + MATES3.blindLength + MATES3.blindRest;
    blindOf.set(p, { def: D.id, goAt: -1 });
    plan.runners.add(p.id);
    plan.supportSpots.delete(p.id);
    plan.boxTargets.delete(p.id);
    return;
  }
}

/** Target for a blindside runner now (drift onto the blind shoulder, then in behind), or null when it is over. */
export function blindTarget(m: Match, p: Player, plan: TeamPlan): { T: V2; mode: 'jog' | 'sprint' } | null {
  if (p.runLane !== 7 || p.aiRunUntil <= m.time) return null;
  const info = blindOf.get(p);
  if (!plan.inPossession || !info) { p.aiRunUntil = 0; return null; }
  const dir = m.attackDir(p.team);
  const D = m.players[info.def];
  const df = toFrame(dir, D.pos), f = toFrame(dir, p.pos), bf = toFrame(dir, m.ball.pos);
  const away = -(Math.sign(bf.z - df.z) || 1); // the side of the defender away from the ball
  const line = Math.min(plan.offsideLineFx, PITCH.halfLength - 6);
  if (info.goAt < 0) {
    const spot = { x: Math.min(line - 0.8, df.x - 0.4), z: df.z + away * 2.0 };
    const there = Math.hypot(f.x - spot.x, f.z - spot.z) < 1.3;
    if ((there && m.time - p.runStart > 0.5) || m.time - p.runStart > MATES3.blindDrift + 0.6) info.goAt = m.time;
    else return { T: fromFrame(dir, spot), mode: Math.hypot(f.x - spot.x, f.z - spot.z) > 4 ? 'sprint' : 'jog' };
  }
  // In behind on the blind side, bending towards goal.
  p.callUntil = Math.max(p.callUntil, m.time + 0.2);
  const z = clamp((df.z + away * 3) * 0.65, -20, 20);
  return { T: fromFrame(dir, { x: Math.min(line + 11, PITCH.halfLength - 6), z }), mode: 'sprint' };
}

/**
 * A computer defender hasn't seen a blindside runner yet: while he drifts onto the shoulder, and
 * for a moment after he goes (less on higher difficulties).
 */
export function unseenRunner(m: Match, o: Player, defTeam: number): boolean {
  if (o.runLane !== 7 || o.aiRunUntil <= m.time) return false;
  const info = blindOf.get(o);
  if (!info) return false;
  if (info.goAt < 0) return true;
  return m.time - info.goAt < MATES3.blindUnseen * (1.3 - 0.5 * levelOf(m, defTeam).interceptAwareness);
}

// ------------------------------------------------------------------ 7. underlaps

/** Underlap around a wide winger: the full-back the run goes inside of (overlapTarget's obstacle). */
export const overlapAround = new WeakMap<Player, number>();

/**
 * Underlap decision for a wide human carrier: inside when the carrier hugs the line, or when an
 * opponent is already blocking the outside, otherwise half the time once properly wide.
 */
export function wantUnderlap(m: Match, carrier: Player, cf: V2, rnd: number): boolean {
  if (Math.abs(cf.z) > PITCH.halfWidth - 8) return true;
  if (!TEAMMATE_ON.underlap || Math.abs(cf.z) < MATES3.underWide) return false;
  const dir = m.attackDir(carrier.team);
  const blocked = m.teamPlayers(1 - carrier.team).some((o) => {
    if (o.off || o.role === 'GK') return false;
    const of = toFrame(dir, o.pos);
    return of.x > cf.x && of.x - cf.x < 8 && Math.abs(of.z) >= Math.abs(cf.z) - 1.5 && Math.abs(of.z - cf.z) < 6;
  });
  return blocked || rnd < 0.5;
}

/** Underlap target: into the inside channel, towards the corner of the area. */
export function underlapTo(cf: V2, s: number): V2 {
  return { x: Math.min(cf.x + 16, PITCH.halfLength - 6), z: s * clamp(Math.abs(cf.z) - 11, 11, 17) };
}

/**
 * Inside run past a wide winger: the human has it in the middle, the winger is holding the
 * touchline, so the full-back behind him runs the channel between winger and midfield.
 */
export function underlapInside(m: Match, plan: TeamPlan, squad: Player[], carrier: Player): Player | null {
  if (!TEAMMATE_ON.underlap) return null;
  const dir = m.attackDir(plan.team);
  const cf = toFrame(dir, carrier.pos);
  if (Math.abs(cf.z) > 15 || cf.x < -5 || cf.x > 30 || Math.cos(carrier.facing) * dir < 0.2) return null;
  for (const s of [1, -1]) {
    const w = squad.find((p) => (p.role === 'LW' || p.role === 'RW') && Math.sign(basePos(m, p.team, p.role).z) === s && !p.off);
    const fb = squad.find((p) => (p.role === 'LB' || p.role === 'RB') && Math.sign(basePos(m, p.team, p.role).z) === s && !p.off);
    if (!w || !fb || m.isHumanControlled(fb) || instrOf(m, fb) < 0 || fb.aiHoldUntil > m.time || fb.giveGoUntil > m.time) continue;
    if (fb.runLane && fb.aiRunUntil > m.time) continue;
    const wf = toFrame(dir, w.pos), ff = toFrame(dir, fb.pos);
    if (Math.abs(wf.z) < 22 || ff.x > wf.x - 3 || dist(fb.pos, w.pos) > 35) continue;
    if (!m.rng.chance(MATES3.underInside * (instrOf(m, fb) > 0 ? 2 : 1))) continue;
    fb.runLane = 6;
    fb.runStart = m.time;
    fb.runTo = fromFrame(dir, { x: Math.min(wf.x + 12, PITCH.halfLength - 6), z: s * clamp(Math.abs(wf.z) - 10, 12, 17) });
    fb.aiRunUntil = m.time + 3.6;
    fb.aiHoldUntil = m.time + 6.6;
    overlapAround.set(fb, w.id);
    return fb;
  }
  return null;
}

// ------------------------------------------------------------------ 9. partnerships

/** Understanding between two teammates (0..1) built from passes they've completed to each other. */
export function linkLevel(m: Match, a: number, b: number): number {
  if (a < 0 || b < 0 || a === b) return 0;
  const p = m.players[a];
  if (!p || p.team !== m.players[b]?.team || !humanSide(m, p.team) || !TEAMMATE_ON.links) return 0;
  return clamp((m.links[p.team].get(linkKey(a, b)) ?? 0) / LINK.full, 0, 1);
}
export const linkKey = (a: number, b: number) => Math.min(a, b) * 32 + Math.max(a, b);

/** The teammate (not `exclude`) with the best understanding with `p`, if any. */
export function bestPartner(m: Match, p: Player, min = 0.3): { id: number; level: number } | null {
  let best: { id: number; level: number } | null = null;
  for (const q of m.teamPlayers(p.team)) {
    if (q.id === p.id || q.off) continue;
    const l = linkLevel(m, p.id, q.id);
    if (l >= min && (!best || l > best.level)) best = { id: q.id, level: l };
  }
  return best;
}

/** The pairs with an understanding, best first (for the pause menu). */
export function partnerships(m: Match, team: number): { a: number; b: number; level: number; passes: number }[] {
  const out: { a: number; b: number; level: number; passes: number }[] = [];
  for (const [k, v] of m.links[team]) {
    const a = Math.floor(k / 32), b = k % 32;
    out.push({ a, b, level: clamp(v / LINK.full, 0, 1), passes: v });
  }
  return out.sort((x, y) => y.passes - x.passes);
}

// ------------------------------------------------------------------ 10. on the ball

/** A teammate of the human on the ball (the keeper after a back pass or a sweep): what to add to each option. */
export function onBallBias(m: Match, p: Player, kind: 'pass' | 'lob' | 'dribble' | 'clear', o: { progress: number; lane: number; space: number; crowd?: number }): number {
  if (!humanSide(m, p.team) || !TEAMMATE_ON.onBall || m.isHumanControlled(p)) return 0;
  let s = 0;
  if (kind === 'dribble') {
    // Don't run into trouble: bodies in the way, or a keeper anywhere near an opponent.
    s -= 0.35 * Math.min(o.crowd ?? 0, 3) + (o.space < 4 ? 0.4 : 0);
    if (p.role === 'GK') s -= o.space > 12 ? 0.3 : 1.2;
  } else if (kind === 'pass' || kind === 'lob') {
    if (o.progress > 0 && o.space > 5 && o.lane < 0.3) s += 0.35 + 0.25 * Math.min(o.progress, 1); // forward to a free man
    if (o.lane > 0.45 && kind === 'pass') s -= 0.4; // a pass that can be cut out
    if (p.role === 'GK' && o.space < 6) s -= 0.5; // never to a marked man near our goal
  } else if (kind === 'clear') {
    s += p.role === 'GK' ? 0.6 : 0.2;
  }
  return s;
}

/** For the keeper on the ball for a human side: a clearance is always an option when someone closes in. */
export function keeperClearOption(m: Match, p: Player): boolean {
  if (!humanSide(m, p.team) || !TEAMMATE_ON.onBall || p.role !== 'GK' || m.isHumanControlled(p)) return false;
  let near = 99;
  for (const o of m.teamPlayers(1 - p.team)) if (!o.off) near = Math.min(near, dist(o.pos, p.pos));
  return near < 9 || pressureOn(p, m.players) > 0.35;
}

/** Restarts the game takes for a human's side: the most open teammate going forward, if there is one. */
export function forwardRestartOption(m: Match, taker: Player, maxD: number): Player | null {
  if (!humanSide(m, taker.team) || !TEAMMATE_ON.onBall) return null;
  const dir = m.attackDir(taker.team);
  const opp = m.teamPlayers(1 - taker.team).filter((o) => !o.off);
  let best: Player | null = null, bs = 0.4;
  for (const t of m.teamPlayers(taker.team)) {
    if (t.id === taker.id || t.off || t.role === 'GK') continue;
    const d = dist(t.pos, taker.pos);
    if (d < 6 || d > maxD) continue;
    let open = 99;
    for (const o of opp) open = Math.min(open, dist(o.pos, t.pos));
    if (open < 5) continue;
    const progress = ((t.pos.x - taker.pos.x) * dir) / 20;
    const s = Math.min(open, 12) / 12 + progress - laneBlock(taker.pos, t.pos, opp) * 1.5;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}
