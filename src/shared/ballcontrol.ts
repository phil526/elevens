// Ball control (19 Nov 2026, thread "Add 10 ball control improvements"). The rules for what a
// carrier does with the ball beyond the plain assisted dribble in match.ts:
//   close control (a held button), the sole stop and setting off again, chops and cut-backs while
//   sprinting, heavy touches, flicking the ball up, keepy-ups and flicking it over a defender.
// Constants live in config.ts (BALLCTL); each feature can be switched off for a benchmark (switches.ts BC).

import { BALL, BALLCTL, PLAYER } from './config';
import { angleOf, clamp, dirOf, dist, norm, turnTowards, wrapAngle } from './math';
import { jogSpeed } from './movement';
import type { Match } from './match';
import type { InputFrame, Player, SkillMove, V2 } from './types';
import { BC } from './switches';

/** The ball-control skill moves (scripted in this file). */
export const BALL_SKILLS: SkillMove[] = ['chop', 'cutback', 'solestop', 'flickup', 'juggle', 'flickover'];
export const isJuggle = (a: Player['action']) => a.type === 'skill' && (a.skill === 'flickup' || a.skill === 'juggle');

/** Nearest opponent (not sent off) within `r` metres, or null. */
export function nearestOpp(m: Match, p: Player, r: number): Player | null {
  let best: Player | null = null, bd = r;
  for (const o of m.players) {
    if (o.team === p.team || o.off) continue;
    const d = dist(o.pos, p.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/** How tightly the carrier is pressed, 0 (nobody within 2.5 m) to 1 (someone within 0.8 m). */
export function pressureNear(m: Match, p: Player): number {
  const o = nearestOpp(m, p, 2.5);
  return o ? clamp(1 - (dist(o.pos, p.pos) - 0.8) / 1.7, 0, 1) : 0;
}

/**
 * Chance that a touch is heavy: only players with control below BALLCTL.heavyFrom, more so under
 * pressure, at full sprint, or on a wet or snowy pitch. A human's own player gets the difficulty's help.
 */
export function heavyChance(m: Match, p: Player, opts: { sprinting?: boolean; first?: boolean; inSpeed?: number }): number {
  if (!BC.heavy || p.role === 'GK') return 0;
  const lack = BALLCTL.heavyFrom - p.a.control;
  if (lack <= 0) return 0;
  const wet = m.wplay.control * 9; // rain 0.45, snow 0.36
  const press = pressureNear(m, p);
  const k = opts.first
    ? 1.2 * press + wet + clamp((opts.inSpeed ?? 0) / 25, 0, 0.8)
    : 1.1 * press + wet + (opts.sprinting ? 0.25 : 0);
  const help = m.controlOf(p) ? m.helpFor(p) : 0;
  return clamp(lack * k, 0, opts.first ? BALLCTL.heavyFirst : BALLCTL.heavyMax) * (1 - 0.6 * help);
}

/**
 * Defenders close behind or alongside the carrier, running the way he was going, carry on past him when he
 * stops or chops the ball away (a set, jockeying defender is harder to fool). Returns how many were beaten.
 */
export function overrun(m: Match, p: Player, heading: V2, reach: number, base: number): number {
  let n = 0;
  for (const o of m.players) {
    if (o.team === p.team || o.off || o.role === 'GK' || o.beaten > 0 || o.action.type !== 'none') continue;
    const dx = o.pos.x - p.pos.x, dz = o.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > reach) continue;
    const ahead = dx * heading.x + dz * heading.z; // how far in front of the carrier, along his old line
    const along = o.vel.x * heading.x + o.vel.z * heading.z; // how fast the defender runs that way
    if (ahead > 1.4 || along < 2.6) continue;
    const set = o.jockeying && o.jockeyT > PLAYER.jockeySetTime;
    const pBeat = clamp(base + 0.6 * (p.a.control - 0.7) - 0.35 * (o.a.tackling - 0.6) + 0.04 * (along - 3) - (set ? 0.2 : o.jockeying ? 0.1 : 0), 0.05, 0.8);
    if (!m.rng.chance(pBeat)) continue;
    o.beaten = PLAYER.beatenTime;
    o.contestCooldown = Math.max(o.contestCooldown, PLAYER.beatenTime);
    o.tackleCooldown = Math.max(o.tackleCooldown, PLAYER.beatenTime);
    n++;
  }
  if (n) m.emit('call', { team: p.team, player: p.id, text: 'beat' });
  return n;
}

/** A human carrier this tick: the sole stop, setting off after it, and chops / cut-backs while sprinting. */
export function humanCarrierInput(m: Match, p: Player, inp: InputFrame, mag: number, close: boolean) {
  const b = m.ball;
  if (b.owner !== p.id || b.state !== 'dribble' || p.role === 'GK') return;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  // Close control and the stick let go while moving: stop it dead under the sole.
  if (BC.sole && close && mag < 0.25 && sp > BALLCTL.soleMinSpeed && p.action.type === 'none') { startSoleStop(m, p); return; }
  // Just after a sole stop: pushing the stick sets off with a burst, the ball knocked a stride ahead.
  const go = m.soleGo.get(p.id);
  if (go !== undefined && m.time > go) m.soleGo.delete(p.id);
  else if (go !== undefined && mag >= 0.5 && p.action.type === 'none') {
    m.soleGo.delete(p.id);
    const d = { x: inp.mx / mag, z: inp.mz / mag };
    p.burst = Math.max(p.burst, 0.55);
    const ts = 2.4 + 0.8 * p.a.pace;
    b.pos.x = p.pos.x + d.x * 0.35; b.pos.z = p.pos.z + d.z * 0.35;
    b.vel = { x: d.x * ts, y: 0, z: d.z * ts };
    m.firstTouch = { pid: p.id, until: m.time + 0.16 };
    p.touchCooldown = Math.max(p.touchCooldown, 0.2);
    m.emit('kick', { player: p.id, team: p.team, power: ts * 0.3, text: 'touch' });
    return;
  }
  // Sprinting with the ball and the stick turned sharply: a chop (or, nearly reversed, a cut-back).
  if (BC.chops && !close && inp.sprint && mag > 0.6 && p.action.type === 'none' && sp > 0.8 * jogSpeed(p.a) && (m.chopCd.get(p.id) ?? -1) < m.time) {
    const turn = Math.abs(wrapAngle(angleOf(inp.mx, inp.mz) - angleOf(p.vel.x, p.vel.z)));
    if (turn >= BALLCTL.chopAngle) startChop(m, p, { x: inp.mx / mag, z: inp.mz / mag }, turn >= BALLCTL.cutAngle);
  }
}

/** Stop the ball dead under the sole: the body brakes hard and anyone chasing may run past. */
export function startSoleStop(m: Match, p: Player) {
  const b = m.ball;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const h = sp > 0.1 ? { x: p.vel.x / sp, z: p.vel.z / sp } : dirOf(p.facing);
  const f = dirOf(p.facing);
  p.action = { type: 'skill', t: 0, dur: BALLCTL.soleTime, skill: 'solestop', dir: { ...f } };
  p.vel.x *= 0.45; p.vel.z *= 0.45;
  b.pos.x = p.pos.x + f.x * 0.3; b.pos.z = p.pos.z + f.z * 0.3; b.pos.y = BALL.radius;
  b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
  m.soleGo.set(p.id, m.time + BALLCTL.soleTime + BALLCTL.soleGo);
  m.emit('skill', { player: p.id, team: p.team, text: 'solestop' });
  overrun(m, p, h, BALLCTL.soleOverrun, 0.3);
}

/**
 * Chop (stick 60-130 degrees off the run) or cut-back (nearly reversed) at a sprint: the ball is cut onto
 * the new line with the inside or outside of the boot, the body plants and turns with it, and a defender
 * running alongside can be left going the wrong way. Heavier for weaker players under pressure.
 */
export function startChop(m: Match, p: Player, dir: V2, cut: boolean) {
  const b = m.ball;
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const h = { x: p.vel.x / sp, z: p.vel.z / sp };
  const f = dirOf(p.facing);
  const side = f.x * dir.z - f.z * dir.x >= 0 ? 1 : -1;
  const c = p.a.control;
  // A weaker or tired player loses more pace in the turn.
  const keep = cut ? 0.22 : 0.55 * (0.82 + 0.35 * c) * (0.85 + 0.15 * p.stamina);
  p.action = { type: 'skill', t: 0, dur: cut ? BALLCTL.cutTime : BALLCTL.chopTime, skill: cut ? 'cutback' : 'chop', side, dir: { ...dir } };
  p.skillCd = Math.max(p.skillCd, 0.35);
  m.chopCd.set(p.id, m.time + BALLCTL.chopCooldown);
  if (cut) { p.vel.x *= keep; p.vel.z *= keep; }
  else {
    p.vel = { x: dir.x * sp * keep, z: dir.z * sp * keep };
    p.facing = turnTowards(p.facing, angleOf(dir.x, dir.z), 1.0);
  }
  let d = dir;
  let ts = cut ? 1.5 + 0.25 * sp : sp * keep + 1.3;
  const hc = heavyChance(m, p, { sprinting: true });
  if (hc > 0 && m.rng.chance(hc)) {
    // Over-cooked: the ball runs on further than meant, a little off the line.
    const a = angleOf(dir.x, dir.z) + m.rng.gauss() * 0.2;
    d = dirOf(a);
    ts *= 1.6 + 0.4 * m.rng.next();
    m.emit('call', { team: p.team, player: p.id, text: 'heavy' });
  }
  b.pos.x = p.pos.x + (cut ? f.x * 0.3 + d.x * 0.15 : d.x * 0.4);
  b.pos.z = p.pos.z + (cut ? f.z * 0.3 + d.z * 0.15 : d.z * 0.4);
  b.pos.y = BALL.radius;
  b.vel = { x: d.x * ts, y: 0, z: d.z * ts };
  m.firstTouch = { pid: p.id, until: m.time + (cut ? 0.3 : 0.22) };
  p.touchCooldown = Math.max(p.touchCooldown, 0.15);
  m.emit('kick', { player: p.id, team: p.team, power: ts * 0.3, text: 'touch' });
  m.emit('skill', { player: p.id, team: p.team, text: cut ? 'cutback' : 'chop' });
  overrun(m, p, h, BALLCTL.chopReach, cut ? 0.4 : 0.32);
}

/**
 * Close control + skill: flick the ball up off the boot. While it is up, skill again juggles it
 * (a keepy-up, up to BALLCTL.juggleMax), or with the stick (or right stick) pointing forward flicks it
 * over a defender's head to run onto. Returns the move, or null when it can't be done now.
 */
export function startFlick(m: Match, p: Player, dx: number, dz: number): SkillMove | null {
  if (!BC.flicks) return null;
  const b = m.ball;
  if (b.owner !== p.id || b.state !== 'dribble' || p.role === 'GK') return null;
  const a = p.action;
  const f = dirOf(p.facing);
  if (isJuggle(a)) {
    if (a.t < 0.2) return null;
    const mag = Math.hypot(dx, dz);
    const d = mag > 0.3 ? { x: dx / mag, z: dz / mag } : null;
    if (d && d.x * f.x + d.z * f.z > 0.2) return flickOver(m, p, d);
    const n = (a.chain ?? 0) + 1;
    if (n > BALLCTL.juggleMax) return null;
    p.action = { type: 'skill', t: 0, dur: BALLCTL.juggleTime, skill: 'juggle', chain: n, side: -(a.side ?? 1), dir: { ...f } };
    m.emit('skill', { player: p.id, team: p.team, text: 'juggle' });
    m.emit('kick', { player: p.id, team: p.team, power: 0.6, text: 'touch' });
    return 'juggle';
  }
  if (a.type !== 'none' || p.skillCd > 0) return null;
  p.vel.x *= 0.5; p.vel.z *= 0.5;
  p.skillCd = 0.3;
  p.stamina = Math.max(0, p.stamina - PLAYER.skillCost * 0.5);
  p.action = { type: 'skill', t: 0, dur: BALLCTL.flickTime, skill: 'flickup', chain: 0, side: 1, dir: { ...f } };
  m.emit('skill', { player: p.id, team: p.team, text: 'flickup' });
  m.emit('kick', { player: p.id, team: p.team, power: 0.8, text: 'touch' });
  return 'flickup';
}

/** The ball over a defender's head, a stride or two ahead to run onto (the flicker can't head it himself). */
export function flickOver(m: Match, p: Player, d: V2): SkillMove {
  const b = m.ball;
  const c = p.a.control;
  const sp = BALLCTL.overSpeed + 0.8 * c + 0.3 * Math.hypot(p.vel.x, p.vel.z);
  const a = angleOf(d.x, d.z) + m.rng.gauss() * (0.03 + 0.12 * (1 - c));
  const u = dirOf(a);
  b.vel = { x: u.x * sp, y: BALLCTL.overLift, z: u.z * sp };
  b.state = 'free';
  b.flight = 'none';
  b.owner = -1;
  b.kicker = p.id;
  b.kickLock = 0.3;
  b.stillTime = 0;
  b.receiver = -1;
  m.flickOver = { pid: p.id, until: m.time + 1.8 };
  p.action = { type: 'skill', t: 0, dur: 0.42, skill: 'flickover', dir: { ...u } };
  p.burst = Math.max(p.burst, PLAYER.burstTime * 0.7);
  p.skillCd = PLAYER.skillCooldown;
  m.emit('kick', { player: p.id, team: p.team, power: sp * 0.3, text: 'touch' });
  m.emit('skill', { player: p.id, team: p.team, text: 'flickover' });
  m.stepoverFeint(p, 'flickover');
  return 'flickover';
}

/** Where the ball is during a ball-control move (dribble step): returns true when it was placed here. */
export function placeBallForSkill(m: Match, p: Player): boolean {
  const a = p.action;
  if (a.type !== 'skill') return false;
  const b = m.ball;
  if (a.skill === 'flickup' || a.skill === 'juggle') {
    const u = clamp(a.t / a.dur, 0, 1);
    const top = a.skill === 'flickup' ? BALLCTL.flickHeight : BALLCTL.juggleHeight;
    const f = dirOf(p.facing);
    const r = 0.38;
    b.pos.x = p.pos.x + f.x * r; b.pos.z = p.pos.z + f.z * r;
    b.pos.y = BALL.radius + (top - BALL.radius) * Math.sin(Math.PI * u);
    b.vel = { x: p.vel.x, y: (top - BALL.radius) * Math.PI / a.dur * Math.cos(Math.PI * u), z: p.vel.z };
    return true;
  }
  if (a.skill === 'solestop') {
    const f = dirOf(p.facing);
    b.pos.x = p.pos.x + f.x * 0.28; b.pos.z = p.pos.z + f.z * 0.28; b.pos.y = BALL.radius;
    b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
    return true;
  }
  return false;
}

/** Movement during a ball-control move (stepActions): true when handled here. */
export function stepBallSkill(p: Player, dt: number): boolean {
  const a = p.action;
  if (a.type !== 'skill') return false;
  switch (a.skill) {
    case 'solestop': {
      // Plant and brake hard.
      if (a.t < 0.2) { const k = Math.pow(0.04, dt); p.vel.x *= k; p.vel.z *= k; }
      p.wish = { x: 0, z: 0, mode: 'walk', face: p.facing };
      return true;
    }
    case 'chop': {
      const d = a.dir!;
      p.wish = { x: d.x, z: d.z, mode: a.t < 0.12 ? 'jog' : 'sprint', face: null };
      if (a.t + dt >= a.dur) p.burst = Math.max(p.burst, 0.35);
      return true;
    }
    case 'cutback': {
      const d = a.dir!;
      if (a.t < 0.18) {
        // Planting: brake and swing round to the new line.
        const k = Math.pow(0.02, dt); p.vel.x *= k; p.vel.z *= k;
        p.facing = turnTowards(p.facing, angleOf(d.x, d.z), 14 * dt);
        p.wish = { x: 0, z: 0, mode: 'walk', face: angleOf(d.x, d.z) };
      } else p.wish = { x: d.x, z: d.z, mode: 'sprint', face: null };
      if (a.t + dt >= a.dur) p.burst = Math.max(p.burst, 0.4);
      return true;
    }
    case 'flickup':
    case 'juggle':
      p.wish = { x: 0, z: 0, mode: 'walk', face: p.facing };
      return true;
    case 'flickover': {
      const d = a.dir!;
      p.wish = { x: d.x, z: d.z, mode: 'sprint', face: null };
      return true;
    }
    default:
      return false;
  }
}

/**
 * Close control dribble (a human holding the button): the ball stays glued a foot in front, with a
 * little touch every BALLCTL.closeTouch seconds while moving. Returns false when the ball has got too
 * far away for it (the normal dribble then has to win it back).
 */
export function closeDribble(m: Match, p: Player): boolean {
  const b = m.ball;
  const f = dirOf(p.facing);
  const sp = Math.hypot(p.vel.x, p.vel.z);
  const foot = { x: p.pos.x + f.x * BALLCTL.closeFoot + p.vel.x * 0.04, z: p.pos.z + f.z * BALLCTL.closeFoot + p.vel.z * 0.04 };
  const d = Math.hypot(b.pos.x - foot.x, b.pos.z - foot.z);
  if (d > 1.4) return false;
  const k = 0.3 + 0.2 * p.a.control;
  b.pos.x += (foot.x - b.pos.x) * k;
  b.pos.z += (foot.z - b.pos.z) * k;
  b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
  if (sp > 0.6 && p.touchCooldown <= 0) {
    p.touchCooldown = BALLCTL.closeTouch;
    m.emit('kick', { player: p.id, team: p.team, power: 0.3 + sp * 0.1, text: 'touch' });
  }
  return true;
}

/**
 * Directional first touch, away from a defender (idea 1): an opponent closing in from the side the
 * touch goes away from is turned (a moment wrong-footed when he was charging in).
 */
export function touchAway(m: Match, p: Player, dir: V2) {
  if (!BC.touch) return;
  const o = nearestOpp(m, p, 3.2);
  if (!o || o.role === 'GK') return;
  const away = norm(p.pos.x - o.pos.x, p.pos.z - o.pos.z);
  if (dir.x * away.x + dir.z * away.z < 0.35) return;
  o.contestCooldown = Math.max(o.contestCooldown, 0.3);
  const closing = away.x * o.vel.x + away.z * o.vel.z; // the defender's speed towards the receiver
  if (closing < 2) return;
  const pBeat = clamp(0.2 + 0.6 * (p.a.control - 0.6) - 0.3 * (o.a.tackling - 0.6) + 0.05 * (closing - 2), 0.05, 0.7);
  if (m.rng.chance(pBeat)) {
    o.beaten = PLAYER.beatenTime * 0.8;
    o.tackleCooldown = Math.max(o.tackleCooldown, o.beaten);
    m.emit('call', { team: p.team, player: p.id, text: 'turned' });
  }
}
