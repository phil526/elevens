// Authoritative ball physics: one model used by the match, the AI's predictions,
// the keeper's shot reading and the pass/shot solvers. Sub-stepped so the ball
// never moves more than BALL.maxSubstep per step (no tunnelling through posts,
// bodies or the goal line).

import { BALL, PITCH, onPitchChange } from './config';
import type { BallPhys, V3 } from './types';

export type Crossing =
  | { kind: 'goal'; side: 1 | -1; z: number; y: number }
  | { kind: 'byline'; side: 1 | -1; z: number; y: number }
  | { kind: 'touch'; side: 1 | -1; x: number };

export interface BallStepResult {
  crossing: Crossing | null;
  hitPost: boolean;
  hitBar: boolean;
  hitNet: boolean;
  bounced: number; // impact speed of the strongest bounce this step
  /** Street cage: the ball hit the boards at this speed this step. */
  hitWall?: number;
}

let GL = PITCH.halfLength;
let GW = PITCH.goalHalfWidth;
let GH = PITCH.goalHeight;
let PR = PITCH.postRadius;
onPitchChange(() => { GL = PITCH.halfLength; GW = PITCH.goalHalfWidth; GH = PITCH.goalHeight; PR = PITCH.postRadius; });
const R = BALL.radius;

/**
 * The conditions the ball plays in: wind (m/s, world axes, felt only in the air) and the pitch
 * (rolling friction, bounce). Set by each match before it steps (see Match.step), so every
 * physics call, prediction and keeper read in that match uses the same weather. The kick
 * solvers (flyTo, landingPoint) always plan in still air: wind is something players misjudge.
 */
export interface BallEnv {
  wx: number;
  wz: number;
  roll: number; // rolling deceleration (m/s^2)
  restitution: number;
  bounceFriction: number;
}
export const CALM: BallEnv = { wx: 0, wz: 0, roll: BALL.rollDecel, restitution: BALL.restitution, bounceFriction: BALL.bounceFriction };
let env: BallEnv = CALM;
export function setBallEnv(e: BallEnv) { env = e; }
export const ballEnv = () => env;

export const isAirborne = (b: BallPhys) => b.pos.y > R + 0.02 || b.vel.y > 0.05;

function integrate(b: BallPhys, h: number, e: BallEnv = env) {
  const p = b.pos, v = b.vel;
  if (p.y > R + 1e-4 || v.y > 1e-4) {
    // Airborne: gravity, quadratic drag against the air (which moves with the wind), lateral curve.
    const rx = v.x - e.wx, rz = v.z - e.wz;
    const sp = Math.hypot(rx, v.y, rz);
    const drag = BALL.airDrag * sp * h;
    v.x -= rx * drag;
    v.y -= v.y * drag + BALL.gravity * h;
    v.z -= rz * drag;
    const vh = Math.hypot(v.x, v.z);
    if (b.spin !== 0 && vh > 1) {
      const a = b.spin * (vh / 20) * h;
      const ox = v.x;
      v.x += (-v.z / vh) * a;
      v.z += (ox / vh) * a;
    }
    b.spin *= Math.max(0, 1 - BALL.spinDecay * h);
    // Topspin (a dipping free kick): pulls the ball down harder the faster it travels.
    if (b.dip) {
      if (vh > 1) v.y -= b.dip * (vh / 20) * h;
      b.dip *= Math.max(0, 1 - BALL.spinDecay * h);
    }
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    if (p.y < R) {
      p.y = R;
      if (v.y < -BALL.restVy) {
        const impact = -v.y;
        v.y = impact * e.restitution;
        v.x *= e.bounceFriction;
        v.z *= e.bounceFriction;
        b.spin *= 0.5;
        b.dip = 0;
        return impact;
      }
      v.y = 0;
    }
    return 0;
  }
  // Rolling: constant friction deceleration.
  p.y = R;
  v.y = 0;
  const vh = Math.hypot(v.x, v.z);
  if (vh > 0) {
    const nv = Math.max(0, vh - e.roll * h);
    const k = nv / vh;
    v.x *= k;
    v.z *= k;
  }
  b.spin *= Math.max(0, 1 - BALL.spinDecay * 4 * h);
  p.x += v.x * h;
  p.z += v.z * h;
  return 0;
}

function reflect(v: { x: number; y: number; z: number }, nx: number, ny: number, nz: number, e: number) {
  const vn = v.x * nx + v.y * ny + v.z * nz;
  if (vn < 0) {
    v.x -= (1 + e) * vn * nx;
    v.y -= (1 + e) * vn * ny;
    v.z -= (1 + e) * vn * nz;
  }
}

/** How much speed the ball keeps off the boards of a street cage. */
export const WALL_BOUNCE = 0.62;

/**
 * Street cage (PITCH.walls): the ball comes back off the side walls and the end walls, except
 * through the goal mouth (the posts and bar themselves are collideFrame's). Returns the impact speed.
 */
function collideWalls(b: BallPhys, prevX: number): number {
  const p = b.pos, v = b.vel;
  let hit = 0;
  const zl = PITCH.halfWidth - R;
  if (Math.abs(p.z) > zl) {
    const s = Math.sign(p.z);
    p.z = s * zl;
    if (v.z * s > 0) { hit = Math.max(hit, Math.abs(v.z)); v.z = -v.z * WALL_BOUNCE; v.x *= 0.92; v.y *= 0.92; }
  }
  const xl = GL - R;
  if (Math.abs(p.x) > xl && Math.abs(prevX) <= GL) {
    const mouth = Math.abs(p.z) < GW + PR && p.y < GH + PR;
    if (!mouth) {
      const s = Math.sign(p.x);
      p.x = s * xl;
      if (v.x * s > 0) { hit = Math.max(hit, Math.abs(v.x)); v.x = -v.x * WALL_BOUNCE; v.z *= 0.92; v.y *= 0.92; }
    }
  }
  return hit;
}

/** Posts (vertical cylinders) and crossbar (horizontal cylinder along z). */
function collideFrame(b: BallPhys, res: BallStepResult) {
  const p = b.pos;
  if (Math.abs(Math.abs(p.x) - GL) > 1.0) return;
  const side = p.x > 0 ? 1 : -1;
  const px = side * (GL + PR);
  for (const pz of [-(GW + PR), GW + PR]) {
    if (p.y > GH + PR + R) continue;
    const dx = p.x - px, dz = p.z - pz;
    const d = Math.hypot(dx, dz);
    if (d < R + PR && d > 1e-6) {
      const nx = dx / d, nz = dz / d;
      p.x = px + nx * (R + PR);
      p.z = pz + nz * (R + PR);
      reflect(b.vel, nx, 0, nz, BALL.postRestitution);
      res.hitPost = true;
    }
  }
  if (Math.abs(p.z) <= GW + PR) {
    const by = GH + PR;
    const dx = p.x - px, dy = p.y - by;
    const d = Math.hypot(dx, dy);
    if (d < R + PR && d > 1e-6) {
      const nx = dx / d, ny = dy / d;
      p.x = px + nx * (R + PR);
      p.y = by + ny * (R + PR);
      reflect(b.vel, nx, ny, 0, BALL.postRestitution);
      res.hitBar = true;
    }
  }
}

/** Net walls as planes; the side of the plane the ball came from decides the push direction. */
function collideNet(b: BallPhys, prevX: number, prevY: number, prevZ: number, res: BallStepResult) {
  const p = b.pos, v = b.vel;
  const ax = Math.abs(p.x);
  if (ax < GL - R || ax > GL + PITCH.goalDepth + 0.5) return;
  const side = p.x > 0 ? 1 : -1;
  const back = GL + PITCH.goalDepth;
  const inX = ax > GL && ax < back + R;
  // Back net.
  if (Math.abs(p.z) < GW && p.y < GH) {
    const pax = Math.abs(prevX);
    if (pax <= back - R && ax > back - R) {
      p.x = side * (back - R);
      v.x = -v.x * BALL.netAbsorb;
      v.z *= 0.5;
      v.y *= 0.5;
      res.hitNet = true;
    }
  }
  // Side nets (from inside or outside).
  if (inX && p.y < GH) {
    for (const s of [-1, 1]) {
      const wall = s * GW;
      const before = prevZ - wall, after = p.z - wall;
      const near = Math.abs(after) < R;
      if ((before > 0) !== (after > 0) || near) {
        const fromInside = Math.abs(prevZ) < GW;
        p.z = fromInside ? wall - s * R : wall + s * R;
        v.z = -v.z * BALL.netAbsorb;
        v.x *= 0.6;
        res.hitNet = true;
      }
    }
  }
  // Roof.
  if (inX && Math.abs(p.z) < GW) {
    if ((prevY - GH > 0) !== (p.y - GH > 0) || Math.abs(p.y - GH) < R) {
      const fromInside = prevY < GH;
      p.y = fromInside ? GH - R : GH + R;
      v.y = -v.y * BALL.netAbsorb;
      res.hitNet = true;
    }
  }
}

/**
 * Advance the ball by dt. When `inPlay` is true the first boundary crossing is
 * reported (the caller turns it into a goal or restart); a goal is detected only
 * when the whole ball has crossed the goal line between the posts and under the bar.
 */
export function stepBall(b: BallPhys, dt: number, inPlay: boolean): BallStepResult {
  const res: BallStepResult = { crossing: null, hitPost: false, hitBar: false, hitNet: false, bounced: 0 };
  const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
  if (sp > BALL.maxSpeed) {
    const k = BALL.maxSpeed / sp;
    b.vel.x *= k; b.vel.y *= k; b.vel.z *= k;
  }
  const n = Math.max(1, Math.ceil((sp * dt) / BALL.maxSubstep));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    const px = b.pos.x, py = b.pos.y, pz = b.pos.z;
    const imp = integrate(b, h);
    if (imp > res.bounced) res.bounced = imp;
    collideFrame(b, res);
    collideNet(b, px, py, pz, res);
    if (PITCH.walls) { const w = collideWalls(b, px); if (w > 0) res.hitWall = Math.max(res.hitWall ?? 0, w); }
    if (inPlay && !res.crossing) {
      const lineX = GL + R;
      if (Math.abs(px) <= lineX && Math.abs(b.pos.x) > lineX) {
        // Interpolate the crossing point for a precise in/out decision.
        const t = (lineX - Math.abs(px)) / Math.max(1e-9, Math.abs(b.pos.x) - Math.abs(px));
        const cz = pz + (b.pos.z - pz) * t;
        const cy = py + (b.pos.y - py) * t;
        const side = b.pos.x > 0 ? 1 : -1;
        if (Math.abs(cz) < GW && cy < GH) res.crossing = { kind: 'goal', side, z: cz, y: cy };
        else res.crossing = { kind: 'byline', side, z: cz, y: cy };
      } else if (Math.abs(pz) <= PITCH.halfWidth + R && Math.abs(b.pos.z) > PITCH.halfWidth + R) {
        res.crossing = { kind: 'touch', side: b.pos.z > 0 ? 1 : -1, x: b.pos.x };
      }
    }
  }
  return res;
}

export const cloneBall = (b: BallPhys): BallPhys => ({ pos: { ...b.pos }, vel: { ...b.vel }, spin: b.spin, dip: b.dip });

/** Predict future ball positions (no player interaction). Returns samples every `step` seconds. */
export function predictBall(b: BallPhys, seconds: number, step = 1 / 30): { t: number; x: number; y: number; z: number }[] {
  const c = cloneBall(b);
  const out: { t: number; x: number; y: number; z: number }[] = [];
  for (let t = step; t <= seconds + 1e-9; t += step) {
    stepBall(c, step, false);
    out.push({ t, x: c.pos.x, y: c.pos.y, z: c.pos.z });
  }
  return out;
}

/** Where (and when) a moving ball will cross the plane |x| = GL on the given side, if within `seconds`. */
export function predictGoalLine(b: BallPhys, side: 1 | -1, seconds = 2): { t: number; y: number; z: number } | null {
  const c = cloneBall(b);
  const step = 1 / 120;
  let prevX = c.pos.x, prevY = c.pos.y, prevZ = c.pos.z;
  for (let t = step; t <= seconds; t += step) {
    stepBall(c, step, false);
    if (side * prevX < GL && side * c.pos.x >= GL) {
      const f = (GL - side * prevX) / Math.max(1e-9, side * c.pos.x - side * prevX);
      return { t: t - step + f * step, y: prevY + (c.pos.y - prevY) * f, z: prevZ + (c.pos.z - prevZ) * f };
    }
    prevX = c.pos.x; prevY = c.pos.y; prevZ = c.pos.z;
    if (Math.hypot(c.vel.x, c.vel.z) < 0.5 && c.pos.y <= R + 0.01) return null;
  }
  return null;
}

/** Where a ball (with its spin) first comes down, simulated through the air only. */
export function landingPoint(pos: V3, vel: V3, spin: number): { x: number; z: number; t: number } {
  const b: BallPhys = { pos: { x: pos.x, y: Math.max(pos.y, R), z: pos.z }, vel: { ...vel }, spin };
  const h = 1 / 240;
  let t = 0;
  for (let i = 0; i < 2400; i++) {
    const py = b.pos.y;
    integrate(b, h, CALM);
    t += h;
    if (py > R + 1e-4 && b.pos.y <= R + 1e-6) break;
  }
  return { x: b.pos.x, z: b.pos.z, t };
}

/** Air-only trajectory: horizontal distance travelled when the ball first lands (or reaches `atDist`). */
export function flyTo(vh: number, vy: number, y0: number, atDist?: number, dip = 0): { dist: number; t: number; y: number } {
  const b: BallPhys = { pos: { x: 0, y: Math.max(y0, R), z: 0 }, vel: { x: vh, y: vy, z: 0 }, spin: 0, dip };
  const h = 1 / 240;
  let t = 0;
  for (let i = 0; i < 2400; i++) {
    const px = b.pos.x, py = b.pos.y;
    integrate(b, h, CALM);
    t += h;
    if (atDist !== undefined && b.pos.x >= atDist) {
      const f = (atDist - px) / Math.max(1e-9, b.pos.x - px);
      return { dist: atDist, t: t - h + f * h, y: py + (b.pos.y - py) * f };
    }
    if (py > R + 1e-4 && b.pos.y <= R + 1e-6) return { dist: b.pos.x, t, y: R };
    if (py <= R + 1e-4 && b.vel.y <= 0) return { dist: b.pos.x, t, y: R }; // never left the ground
  }
  return { dist: b.pos.x, t, y: b.pos.y };
}
