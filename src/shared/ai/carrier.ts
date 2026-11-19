// Ball-carrier decisions: each option gets an understandable score
// (DESIGN §8) and the best one (plus difficulty noise) is executed.

import { PITCH } from '../config';
import { inCrossZone, laneBlock, leadTarget, pressureOn } from '../kick';
import { angleOf, clamp, dist, norm, wrapAngle } from '../math';
import type { Match, KickRequest } from '../match';
import type { Player, V2 } from '../types';
import { levelOf } from './team';
import { gameState } from './gamestate';
import { keeperClearOption, onBallBias } from './mates3';
import { COUNTER_WINDOW, sinceWon, styleBias, styleOf } from '../playstyle';
import { G6 } from '../switches';

interface Option {
  score: number;
  label: string;
  req?: KickRequest;
  dribbleTo?: V2;
  sprint?: boolean;
}

/** Diagnostics hook (scripts only): sees every scored option list. */
export let decideTrace: ((p: Player, opts: Option[]) => void) | null = null;
export function setDecideTrace(f: typeof decideTrace) { decideTrace = f; }

const pending = new WeakMap<Player, { req: KickRequest; since: number }>();

export function carrierAI(m: Match, p: Player, _dt: number) {
  if (p.action.type !== 'none') return;
  const lvl = levelOf(m, p.team);
  // Turn towards a chosen pass before striking it (or strike anyway after a moment).
  const pend = pending.get(p);
  if (pend) {
    const t = pend.req.target!;
    const want = angleOf(t.x - p.pos.x, t.z - p.pos.z);
    if (Math.abs(wrapAngle(want - p.facing)) < 0.9 || m.time - pend.since > 0.35) {
      pending.delete(p);
      kickAndMove(m, p, pend.req);
      return;
    }
    const d = { x: Math.cos(want), z: Math.sin(want) };
    p.wish = { x: d.x * 0.4, z: d.z * 0.4, mode: 'jog', face: want };
    return;
  }

  if (m.time >= p.aiNextDecision) {
    p.aiNextDecision = m.time + lvl.decisionInterval * (0.8 + 0.4 * m.rng.next());
    const best = decide(m, p);
    p.aiIntent = best.label;
    if (best.req) {
      const t = best.req.target!;
      const want = angleOf(t.x - p.pos.x, t.z - p.pos.z);
      if (Math.abs(wrapAngle(want - p.facing)) > 1.1 && best.req.kind !== 'shot') {
        pending.set(p, { req: best.req, since: m.time });
        return;
      }
      kickAndMove(m, p, best.req);
      return;
    }
    if (best.dribbleTo) {
      p.aiTarget = best.dribbleTo;
      p.aiRunUntil = best.sprint ? 1 : 0;
      // Pressed from the front while dribbling: sometimes try to beat the defender with a skill move.
      if (tryAISkill(m, p, lvl.skill)) return;
    }
  }
  const T = p.aiTarget;
  const dx = T.x - p.pos.x, dz = T.z - p.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) { p.wish = { x: 0, z: 0, mode: 'walk', face: null }; return; }
  p.wish = { x: dx / d, z: dz / d, mode: p.aiRunUntil === 1 ? 'sprint' : 'jog', face: null };
}

/** Pass and move: after a short pass, attacking players often run on for a return ball (one-two). */
const GIVE_GO_CHANCE = 0.35;
function kickAndMove(m: Match, p: Player, req: KickRequest) {
  m.startKick(p, req);
  if (req.kind !== 'pass' || req.receiver === undefined || req.receiver < 0 || !req.target) return;
  if (p.role === 'GK' || p.role === 'LCB' || p.role === 'RCB') return;
  const dir = m.attackDir(p.team);
  const d = dist(p.pos, req.target);
  const fx = p.pos.x * dir;
  if (d > 22 || fx < -20 || fx > 40) return;
  if (m.rng.chance(GIVE_GO_CHANCE)) p.giveGoUntil = m.time + 2.4;
}

function tryAISkill(m: Match, p: Player, chance: number): boolean {
  if (p.skillCd > 0 || p.a.control < 0.55) return false;
  let front: Player | null = null;
  for (const o of m.teamPlayers(1 - p.team)) {
    if (o.role === 'GK') continue;
    const d = dist(o.pos, p.pos);
    if (d > 3.2) continue;
    if (Math.abs(wrapAngle(angleOf(o.pos.x - p.pos.x, o.pos.z - p.pos.z) - p.facing)) < 0.9) { front = o; break; }
  }
  if (!front || !m.rng.chance(chance * (0.6 + 0.6 * p.a.control))) return false;
  // Break to the side with more room (towards the centre near the touchline).
  const T = p.aiTarget;
  const tx = T.x - p.pos.x, tz = T.z - p.pos.z;
  const goalX = m.ownGoalX(1 - p.team);
  const dGoal = Math.hypot(goalX - p.pos.x, p.pos.z);
  const fd = dist(front.pos, p.pos);
  const closing = ((p.pos.x - front.pos.x) * front.vel.x + (p.pos.z - front.pos.z) * front.vel.z) / Math.max(0.5, fd);
  const r = m.rng.next();
  // In range of goal with a defender stepping across to block: sell a shot and cut inside.
  if (dGoal < 30 && r < 0.4) return !!m.startSkill(p, tx, tz, true);
  // A defender charging in close: roll round them with a roulette to the side of the target.
  if (fd < 2.4 && closing > 2 && r < 0.75) {
    const f = { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    const side = f.x * tz - f.z * tx >= 0 ? 1 : -1;
    // Diagonally back on that side (about 120 degrees from facing).
    const a = p.facing + side * 2.1;
    return !!m.startSkill(p, Math.cos(a), Math.sin(a));
  }
  // Skilful players also have the modifier moves (19 Nov 2026): an elastico past a defender
  // closing in, a ball roll across one standing off.
  if (G6.aiSkills && p.a.control > 0.72 && r > 0.75 && r < 0.9) {
    const f = { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    if (closing > 1.5) return !!m.startSkill(p, f.x, f.z, false, true);
    const side = f.x * tz - f.z * tx >= 0 ? 1 : -1;
    return !!m.startSkill(p, -f.z * side, f.x * side, false, true);
  }
  return !!m.startSkill(p, tx, tz);
}

export function decide(m: Match, p: Player): Option {
  const lvl = levelOf(m, p.team);
  const dir = m.attackDir(p.team);
  const opp = m.teamPlayers(1 - p.team);
  const mates = m.teamPlayers(p.team).filter((t) => t.id !== p.id);
  const fx = p.pos.x * dir;
  const pressure = pressureOn(p, m.players);
  const goal = { x: dir * PITCH.halfLength, z: 0 };
  const dGoal = dist(p.pos, goal);
  const opts: Option[] = [];
  const noise = () => m.rng.gauss() * lvl.noise;
  const heldFor = m.time - m.possessionStart;
  // Score-aware: > 0 chasing the game (direct, shoots from further), < 0 protecting a lead (keeps the ball).
  const urge = gameState(m, p.team);
  const chase = Math.max(0, urge), protect = Math.max(0, -urge);
  // Club style (19 Nov 2026): how this side likes to play when the computer runs it.
  const playStyle = styleOf(m, p.team);
  const fresh = sinceWon(m, p.team) < COUNTER_WINDOW;

  // Shoot: visible goal angle and distance, minus bodies in the way.
  if (dGoal < 32 && fx > 15) {
    const a1 = angleOf(goal.x - p.pos.x, PITCH.goalHalfWidth - p.pos.z);
    const a2 = angleOf(goal.x - p.pos.x, -PITCH.goalHalfWidth - p.pos.z);
    const visible = Math.abs(wrapAngle(a1 - a2));
    let blockers = 0;
    for (const o of opp) if (o.role !== 'GK' && laneBlock(p.pos, goal, [o]) > 0.3) blockers++;
    let s = 2.3 * clamp(visible / 0.35, 0, 1) * clamp(1.85 - dGoal / 26, 0, 1.2) + 0.35 * p.a.shooting - blockers * 0.15 + (dGoal < 14 ? 0.4 : 0) + (dGoal < 24 ? pressure * 0.3 : 0);
    if (dGoal > 22) s -= 0.25 * clamp((dGoal - 22) / 6, 0, 1) * (1 - chase); // prefer working a closer chance over a speculative long shot
    if (chase > 0 && dGoal > 18) s += 0.25 * chase; // chasing the game: have a go
    s += noise();
    const gk = m.keeper(1 - p.team);
    const side = Math.abs(gk.pos.z) < 0.4 ? (m.rng.chance(0.5) ? 1 : -1) : gk.pos.z > 0 ? -1 : 1;
    // Aim inside the posts and avoid over-hitting: better finishers aim closer to the corners.
    const aimZ = side * m.rng.range(1.1, 1.9 + 0.8 * p.a.shooting);
    let power = dGoal > 18 ? m.rng.range(0.66, 0.84) : m.rng.range(0.5, 0.74);
    // Keeper well off their line: chip it. Close in: often drive it low.
    const gkOff = Math.abs(goal.x - gk.pos.x);
    let variant: 'chip' | 'low' | 'power' | 'placed' | undefined;
    if (gkOff > 5.5 && dGoal > 11 && dGoal < 30 && dist(gk.pos, p.pos) > 4 && m.rng.chance(0.6)) { variant = 'chip'; power = m.rng.range(0.42, 0.62); }
    else if (dGoal < 16 && m.rng.chance(0.35)) variant = 'low';
    // Shot types (19 Nov 2026): a strong shooter lets fly from range; a cool finisher side-foots it in close.
    else if (G6.aiShots && dGoal > 22 && m.rng.chance(0.15 + 0.3 * p.a.shooting)) { variant = 'power'; power = m.rng.range(0.6, 0.8); }
    else if (G6.aiShots && dGoal < 13 && m.rng.chance(0.3)) { variant = 'placed'; power = m.rng.range(0.55, 0.85); }
    const placed = !variant && dGoal > 13 && dGoal < 24 && m.rng.chance(0.4);
    s += styleBias(playStyle, 'shoot', 0, dGoal, fresh);
    opts.push({ score: s, label: 'shoot', req: { kind: 'shot', power, placed, variant, target: { x: goal.x, y: 0, z: variant === 'chip' ? aimZ * 0.6 : aimZ } } });
  }

  // Patience: in the middle third with few teammates ahead of the ball, keep possession while
  // the attacking shape forms instead of forcing the play forward.
  const ahead = mates.filter((t) => t.pos.x * dir > fx + 4).length;
  const wait = fx > -10 && fx < 30 && ahead < 3 && pressure < 0.7 && chase < 0.35;
  // Passes (ground, lofted, through).
  for (const t of mates) {
    if (t.role === 'GK' && !(pressure > 0.6 && fx < -20)) continue;
    const P = { x: t.pos.x + t.vel.x * 0.5, z: t.pos.z + t.vel.z * 0.5 };
    const d = dist(p.pos, P);
    if (d < 5 || d > 48) continue;
    const lane = laneBlock(p.pos, P, opp);
    let space = 99;
    for (const o of opp) space = Math.min(space, dist(o.pos, P));
    const progress = (P.x * dir - fx) / 25;
    // A long-ball side goes over the top sooner.
    const lob = playStyle === 'longball' && progress > 0.4 ? d > 22 || (lane > 0.4 && d > 12) : d > 30 || (lane > 0.6 && d > 14);
    let s = 0.8 + 0.9 * progress - (lob ? 0.3 : 1.2 * lane) - 0.8 * clamp((5 - space) / 5, 0, 1) - (d > 30 ? (d - 30) / 25 : 0);
    if (t.pos.x * dir > 36 && Math.abs(t.pos.z) < 14) s += 0.4;
    else if (t.pos.x * dir > 22 && Math.abs(t.pos.z) < 20) s += 0.2;
    if (progress < -0.3 && pressure < 0.3 && !wait) s -= 0.2; // don't recycle backwards without reason
    if (wait && progress > -0.6 && progress < 0.3 && lane < 0.3 && space > 5) s += 0.3; // keep it while the attack forms
    if (t.pos.x * dir > 20 && space > 4 && progress > 0.2) s += 0.6; // find a free attacker
    if (pressure > 0.3 && lane < 0.3 && space > 4 && !lob) s += 0.45 * pressure; // pressed: keep it simple
    if (chase > 0) s += chase * (0.35 * progress + (lob && progress > 0.6 ? 0.25 : 0)); // chasing: get it forward
    if (protect > 0) s += protect * ((lane < 0.3 && space > 5 && !lob ? 0.3 : 0) - 0.3 * Math.max(0, progress) - (lob ? 0.2 : 0)); // protecting: keep it
    // Cut-back: from near the byline, a ground pass back to a teammate arriving around the penalty spot.
    const tfx = t.pos.x * dir;
    if (fx > 38 && Math.abs(p.pos.z) > 7 && tfx > 31 && tfx < 46 && Math.abs(t.pos.z) < 11 && lane < 0.35 && !lob) s += 0.9;
    s += onBallBias(m, p, lob ? 'lob' : 'pass', { progress, lane, space });
    s += styleBias(playStyle, lob ? 'lob' : 'pass', progress, d, fresh);
    s += noise();
    opts.push({ score: s, label: lob ? 'lob' : 'pass', req: { kind: lob ? 'lob' : 'pass', receiver: t.id, target: { x: P.x, y: 0, z: P.z } } });
    const goer = t.giveGoUntil > m.time;
    const running = t.aiRunUntil > m.time || goer;
    if (running && t.pos.x * dir > fx + (goer ? 0 : 3)) {
      const T = leadTarget(p, t, 'through', dir);
      let tspace = 99;
      for (const o of opp) tspace = Math.min(tspace, dist(o.pos, T));
      const tl = laneBlock(p.pos, T, opp);
      const ts = 0.9 + 0.8 * ((T.x * dir - fx) / 25) - 0.9 * tl - (tspace < 3 ? 0.6 : 0) + (goer && heldFor < 1.2 ? 0.45 : 0) + (t.runLane === 4 && t.aiRunUntil > m.time ? 0.35 : 0) - (t.runLane === 5 && t.aiRunUntil > m.time ? 0.4 : 0) + styleBias(playStyle, 'through', (T.x * dir - fx) / 25, dist(p.pos, T), fresh) + noise();
      opts.push({ score: ts, label: 'through', req: { kind: 'through', receiver: t.id, target: { x: T.x, y: 0, z: T.z } } });
    }
  }

  // Crosses from wide areas: floated to the far post, whipped into the gap in front of goal for a
  // runner (also early, from deeper), or driven low across the six-yard box from near the byline.
  if (inCrossZone(p.pos, dir, true)) {
    const early = !inCrossZone(p.pos, dir);
    const inBox = mates.filter((t) => t.pos.x * dir > 33 && Math.abs(t.pos.z) < 16);
    const runners = mates.filter((t) => t.pos.x * dir > 24 && Math.abs(t.pos.z) < 18 && t.vel.x * dir > 3);
    const pool = early ? runners : inBox;
    if (pool.length) {
      const side = Math.sign(p.pos.z) || 1;
      const nearPost = pool.filter((t) => t.pos.z * side > -2 && Math.abs(t.pos.z) < 9).sort((a, c) => c.pos.x * dir - a.pos.x * dir)[0];
      let style: 'floated' | 'whipped' | 'lowcross';
      let t: Player;
      if (early) { style = 'whipped'; t = pool.sort((a, c) => c.vel.x * dir - a.vel.x * dir)[0]; }
      else if (fx > 40 && nearPost && m.rng.chance(0.55)) { style = 'lowcross'; t = nearPost; }
      else if (runners.length && m.rng.chance(0.5)) { style = 'whipped'; t = runners.sort((a, c) => Math.abs(a.pos.z) - Math.abs(c.pos.z))[0]; }
      else { style = 'floated'; t = pool.sort((a, c) => a.pos.z * side - c.pos.z * side)[0]; } // the far-post man
      const base = early ? 0.55 + 0.25 * runners.length : 0.8 + 0.25 * inBox.length + 0.3 * pressure;
      const req: KickRequest = style === 'lowcross'
        ? { kind: 'pass', variant: 'lowcross', receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } }
        : { kind: 'cross', variant: style, receiver: t.id, target: { x: t.pos.x, y: 0, z: t.pos.z } };
      opts.push({ score: base + styleBias(playStyle, 'cross', 1, 30, fresh) + noise(), label: 'cross', req });
    }
  }

  // Clear when under pressure in our own third (a human's keeper on the ball clears as soon as anyone closes in).
  if ((fx < -30 && pressure > 0.6) || keeperClearOption(m, p)) {
    const wing = p.pos.z >= 0 ? 1 : -1;
    const T = { x: p.pos.x + dir * 38, z: clamp(wing * 22, -30, 30) };
    opts.push({ score: 0.9 + onBallBias(m, p, 'clear', { progress: 1, lane: 0, space: 0 }) + styleBias(playStyle, 'clear', 1, 38, fresh) + noise(), label: 'clear', req: { kind: 'clear', receiver: -1, target: { x: T.x, y: 0, z: T.z } } });
  }

  // Dribble into space.
  const fwdAng = dir > 0 ? 0 : Math.PI;
  for (const off of [0, 0.6, -0.6, 1.3, -1.3]) {
    const a = fwdAng + off;
    const Q = { x: p.pos.x + Math.cos(a) * 7, z: p.pos.z + Math.sin(a) * 7 };
    if (Math.abs(Q.z) > PITCH.halfWidth - 2 || Math.abs(Q.x) > PITCH.halfLength - 1) continue;
    let space = 99, crowd = 0;
    for (const o of opp) {
      space = Math.min(space, dist(o.pos, Q));
      if (o.role !== 'GK' && laneBlock(p.pos, Q, [o]) > 0.2) crowd++; // bodies in the way of the run
    }
    const progress = (Q.x * dir - fx) / 7;
    let s = 0.15 + progress * 0.35 + clamp(space / 9, 0, 1) * 0.5 - pressure * 0.45 - 0.2 * Math.min(crowd, 3);
    if (fx > 25 && Math.abs(Q.z) < Math.abs(p.pos.z)) s += 0.1; // cut inside near goal
    if (fx > 25 && space < 4) s -= 0.3; // don't run into a crowded box
    if (fx > 18 && dist(Q, goal) < dGoal - 3) s += 0.3; // attack the goal once in the final third
    if (heldFor < 0.35 && dGoal > 16) s += 0.5; // take a touch before acting (but finish first time in the box)
    if (wait && progress > 0.5) s -= 0.4; // no solo runs while waiting for support
    if (protect > 0.5 && fx > 30 && Math.abs(Q.z) > Math.abs(p.pos.z) && space > 3) s += 0.35 * protect; // run it into the corner
    if (chase > 0 && progress > 0.5) s += 0.15 * chase;
    s += onBallBias(m, p, 'dribble', { progress, lane: 0, space, crowd });
    s += styleBias(playStyle, 'dribble', progress, 7, fresh);
    s += noise();
    const runDir = norm(Q.x - p.pos.x, Q.z - p.pos.z);
    opts.push({ score: s, label: 'dribble', dribbleTo: { x: p.pos.x + runDir.x * 10, z: p.pos.z + runDir.z * 10 }, sprint: space > 6 && progress > 0.3 });
  }

  opts.sort((a, b) => b.score - a.score);
  if (decideTrace) decideTrace(p, opts);
  return opts[0];
}
