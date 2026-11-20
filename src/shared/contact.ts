// Solid bodies and timed tackles (20 Nov 2026 evening).
//
// Solid bodies: players used to be nudged apart half each, so a sprinting winger shoved a
// planted centre-back aside as easily as the reverse and nobody could block a run. Now each
// body has a weight (build and strength, more when planted), the push is shared by weight, and
// the speed a runner carries into an opponent is taken off him: he slides round the man or
// stops, he can't run through him. Teammates still mostly slide past each other.
//
// Timed tackles: a standing tackle used to be mostly a dice roll on the two players' ratings. It
// is now won by timing: going in as the dribbler's touch takes the ball off his foot (and
// nearer to you than to him) wins it cleanly; going in while the ball is under his foot lets him
// skip past. Ratings still count, a little.

import { dirOf } from './math';
import { strengthOf } from './physical';
import type { Player, V2, V3 } from './types';

export const BODY = {
  /** Weight from strength: base + k * strength (about 0.7 for a slight winger to 1.45 for a big centre-back). */
  massBase: 0.6,
  massStrength: 0.8,
  /** A player standing (slower than bracedSpeed m/s) is planted and this much harder to move. */
  braced: 1.5,
  bracedSpeed: 1.5,
  /** Share of the closing speed taken off when opponents meet (1 = all of it), and when teammates do. */
  opp: 0.9,
  mate: 0.35,
  /** ...and when one of them is dribbling the ball (a human's own dribbler leans through more). */
  carrier: 0.6,
  humanCarrier: 0.45,
  /** Closing speed (m/s) that counts as a real bump (rumble and a thud for your own man). */
  bump: 3.2,
} as const;

/** How heavy a body is in a collision (see BODY). */
export function bodyMass(p: Player): number {
  const m = BODY.massBase + BODY.massStrength * strengthOf(p);
  return Math.hypot(p.vel.x, p.vel.z) < BODY.bracedSpeed ? m * BODY.braced : m;
}

/**
 * Push overlapping bodies apart (radius r each), shared by weight, and take the closing speed off
 * players who run into each other. `onBump(a, b, speed)` hears every hard opponent collision,
 * `a` being the one who came off worse. `carrier` is the player dribbling the ball (-1 none).
 */
export function separateBodies(players: Player[], r: number, onBump?: (loser: Player, winner: Player, speed: number) => void, carrier = -1, carrierK: number = BODY.carrier) {
  const n = players.length;
  const minD = r * 2;
  const mass: number[] = [];
  for (let i = 0; i < n; i++) mass.push(players[i].off ? 1 : bodyMass(players[i]));
  for (let i = 0; i < n; i++) {
    const a = players[i];
    if (a.off) continue;
    for (let j = i + 1; j < n; j++) {
      const b = players[j];
      if (b.off) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      // A keeper mid-dive or a slider is moved by his own script: he pushes, he isn't pushed.
      const fixedA = a.action.type === 'dive' || a.action.type === 'slide';
      const fixedB = b.action.type === 'dive' || b.action.type === 'slide';
      const ma = fixedA ? 1e3 : mass[i], mb = fixedB ? 1e3 : mass[j];
      const over = minD - d;
      const ka = mb / (ma + mb), kb = ma / (ma + mb);
      a.pos.x -= nx * over * ka; a.pos.z -= nz * over * ka;
      b.pos.x += nx * over * kb; b.pos.z += nz * over * kb;
      // Closing speed along the line between them (negative: running into each other).
      const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rel >= 0) continue;
      // A dribbler leans through contact a little (he is moving the ball on, not stopping).
      const k = a.team !== b.team ? (a.id === carrier || b.id === carrier ? carrierK : BODY.opp) : BODY.mate;
      const jImp = (-rel * k) / (1 / ma + 1 / mb);
      if (!fixedA) { a.vel.x -= (nx * jImp) / ma; a.vel.z -= (nz * jImp) / ma; }
      if (!fixedB) { b.vel.x += (nx * jImp) / mb; b.vel.z += (nz * jImp) / mb; }
      if (onBump && a.team !== b.team && -rel > BODY.bump) {
        // The lighter body takes more of the change in speed.
        if (ma < mb) onBump(a, b, -rel);
        else onBump(b, a, -rel);
      }
    }
  }
}

export const TIMING = {
  /** The dribbler's boot: this far in front of him along his facing (as in Match.dribble). */
  foot: 0.45,
  /** Ball this far (m) off the boot = no timing at all; this far = perfect. */
  gapFrom: 0.3,
  gapTo: 1.0,
  /** He is about to touch it again (seconds until his next touch below this): half the timing. */
  touchSoon: 0.05,
  /** The ball is nearer the tackler than the carrier: this much better. */
  nearer: 0.25,
  /** Carrier standing on the ball (slower than this m/s): neutral timing, it comes down to the ratings. */
  standing: 0.8,
  standingTiming: 0.45,
  /** A carrier on close control (the ball glued to his boot). */
  close: 0.15,
  /** Clean-win chance: base + k * timing + ratings. */
  base: 0.2,
  k: 0.78,
  tackling: 0.35,
  control: 0.25,
  /** Timing at or above this wins the ball cleanly at the tackler's feet; below `early` the carrier skips past. */
  perfect: 0.72,
  early: 0.28,
  /** A mistimed lunge at a running carrier this close (m) clips his ankles this often: a foul. */
  trip: 0.3,
  tripReach: 1.4,
} as const;

/**
 * How well timed a standing tackle is, 0..1, at the moment it reaches the ball: how far the
 * dribbler's last touch has taken the ball off his boot, whether he can touch it again yet, and
 * whether the ball is nearer the tackler than him. `close`: he is on close control.
 */
export function tackleTiming(t: Player, owner: Player, ball: V3 | V2, close = false): number {
  // Close control keeps the ball glued to the boot: there is no touch to time.
  if (close) return TIMING.close;
  const sp = Math.hypot(owner.vel.x, owner.vel.z);
  if (sp < TIMING.standing) return TIMING.standingTiming;
  const f = dirOf(owner.facing);
  const foot = { x: owner.pos.x + f.x * TIMING.foot, z: owner.pos.z + f.z * TIMING.foot };
  const gap = Math.hypot(ball.x - foot.x, ball.z - foot.z);
  let k = Math.min(1, Math.max(0, (gap - TIMING.gapFrom) / (TIMING.gapTo - TIMING.gapFrom)));
  if (owner.touchCooldown < TIMING.touchSoon) k *= 0.5;
  const dT = Math.hypot(ball.x - t.pos.x, ball.z - t.pos.z), dO = Math.hypot(ball.x - owner.pos.x, ball.z - owner.pos.z);
  if (dT < dO) k += TIMING.nearer;
  return Math.min(1, Math.max(0, k));
}

/** Chance that a standing tackle with this timing wins the ball (before shielding, angle and stance). */
export function timedTackleChance(timing: number, t: Player, owner: Player): number {
  return TIMING.base + TIMING.k * timing + TIMING.tackling * (t.a.tackling - 0.6) - TIMING.control * (owner.a.control - 0.6);
}
