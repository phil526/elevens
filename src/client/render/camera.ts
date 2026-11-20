// Match cameras, both on the same (near, +z) side of the ground for both halves.
// - Tracking (default): an elevated sideline camera that slides along the touchline with
//   play, so screen-right is always +x.
// - Broadcast: a fixed TV gantry high above the halfway line that pans and zooms to follow
//   play, like a television match camera. It turns towards each end, so movement input is
//   rotated by its heading (inputYaw) to keep "up" meaning "away from the camera".
// - Wide: the tracking camera pulled up and back, so more of the team shape is in view.
// - Panoramic: very high and far back, showing nearly the whole pitch; it drifts only
//   gently with play. Wide and Panoramic keep screen-right as +x, like Tracking.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { ViewState } from '../view';
import { possessionTeam } from '../view';

export type CameraMode = 'tracking' | 'broadcast' | 'wide' | 'panoramic';

/** Sideline cameras: distance from the focus, angle down, how far it slides with play and how far ahead it leads. */
const SIDELINE = {
  tracking: { dist: 58, angle: 0.43, slide: 0.9, lead: 7, edge: 14, fov: 30 },
  wide: { dist: 82, angle: 0.5, slide: 0.75, lead: 10, edge: 22, fov: 30 },
  panoramic: { dist: 112, angle: 0.6, slide: 0.3, lead: 6, edge: 30, fov: 32 },
} as const;

export interface CameraSettings {
  mode?: CameraMode;
  height: 'low' | 'standard' | 'high';
  zoom: 'near' | 'standard' | 'far';
  reducedMotion: boolean;
  /** Set-piece camera (20 Nov 2026): behind the ball for penalties and free kicks in range (default on). */
  setPiece?: boolean;
}

const HEIGHT = { low: 0.78, standard: 1, high: 1.28 };
const ZOOM = { near: 0.8, standard: 1, far: 1.2 };

/** Critically damped spring (no overshoot, no snapping). */
class Spring {
  v = 0;
  constructor(public x: number) {}
  step(target: number, omega: number, dt: number) {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    const x = (f * this.x + dt * this.v + hhoo * target) * det;
    this.v = (this.v + hoo * (target - this.x)) * det;
    this.x = x;
    return x;
  }
}

export class BroadcastCamera {
  cam: THREE.PerspectiveCamera;
  private fx = new Spring(0);
  private fz = new Spring(0);
  private zoom = new Spring(1);
  /** Heading of the camera on the ground plane, radians (0 = looking along -z). Input uses it. */
  inputYaw = 0;
  private mode: CameraMode | null = 'tracking';
  private yawS = new Spring(0);
  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(30, aspect, 0.5, 1200);
    this.cam.position.set(0, 26, 80);
    this.cam.lookAt(0, 0, 0);
  }

  snap(view: ViewState) {
    this.fx.x = view.ball.pos.x;
    this.fx.v = 0;
    this.fz.x = view.ball.pos.z;
    this.fz.v = 0;
    this.yawS.x = this.mode === 'broadcast' ? Math.atan2(this.fx.x, PITCH.halfWidth + (PITCH.walls ? 21 : 36) - (this.fz.x * 0.6 + 2)) : 0;
    this.yawS.v = 0;
  }

  /** Set-piece camera: how far it has blended in (0..1), and the shot it is holding. */
  private sp = new Spring(0);
  /** How far the set-piece view has blended in (0 to 1); the renderer hides the taker's pointer in it. */
  setPieceK = 0;
  private spShot: { from: THREE.Vector3; goalX: number; kicked: number; aim: THREE.Vector3 } | null = null;
  private _q = new THREE.Quaternion();
  private _p = new THREE.Vector3();
  private _m = new THREE.Matrix4();

  update(view: ViewState, dt: number, s: CameraSettings) {
    this.updateBase(view, dt, s);
    const mode = s.mode ?? 'tracking';
    const base = mode === 'broadcast' ? this.cam.fov : SIDELINE[mode].fov;
    const k = this.setPieceView(view, dt, s);
    const fov = base + (40 - base) * k;
    if (Math.abs(fov - this.cam.fov) > 0.01) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }
  }

  /**
   * Behind the ball for a penalty or a free kick in shooting range (not a quick one): the camera
   * stands a few metres back from the ball looking at the goal, and after the kick watches the
   * ball until play moves on. Blended over the normal camera.
   */
  private setPieceView(view: ViewState, dt: number, s: CameraSettings): number {
    const rs = view.restart;
    const direct = (r: NonNullable<ViewState['restart']>) => r.type === 'penalty' || (r.type === 'freekick' && !r.quick && Math.hypot(r.spot.x - PITCH.halfLength * view.attackDir[r.team], r.spot.z) < 30);
    const ball = view.ball.pos;
    if (s.setPiece !== false && rs && view.phase === 'restart' && direct(rs) && Math.hypot(ball.x - rs.spot.x, ball.z - rs.spot.z) < 0.5) {
      const gx = PITCH.halfLength * view.attackDir[rs.team];
      const g = new THREE.Vector3(gx - rs.spot.x, 0, -rs.spot.z).normalize();
      const back = rs.type === 'penalty' ? 9 : 8;
      this.spShot = { from: new THREE.Vector3(rs.spot.x - g.x * back - g.z * 1.2, rs.type === 'penalty' ? 2.6 : 3.2, rs.spot.z - g.z * back + g.x * 1.2), goalX: gx, kicked: -1,
        // A free kick from further out looks at a point short of the goal, so the ball and the taker stay in shot.
        aim: rs.type === 'penalty' ? new THREE.Vector3(gx, 1.2, 0) : new THREE.Vector3(rs.spot.x + (gx - rs.spot.x) * 0.28, 0, rs.spot.z * 0.72) };
    } else if (this.spShot && this.spShot.kicked < 0 && view.phase === 'play') this.spShot.kicked = 0;
    const sh = this.spShot;
    let want = 0;
    if (sh) {
      if (sh.kicked >= 0) sh.kicked += dt;
      want = sh.kicked < 0 || (sh.kicked < 1.8 && view.phase === 'play') || (view.phase === 'goal' && sh.kicked < 3.5) ? 1 : 0;
      if (!want && this.sp.x < 0.02) this.spShot = null;
    }
    const k = this.sp.step(want, s.reducedMotion ? 2.5 : 4, dt);
    this.setPieceK = sh ? k : 0;
    if (!sh || k < 0.005) return 0;
    // Look at the goal before the kick, then follow the ball.
    const look = sh.kicked < 0 ? sh.aim.clone() : new THREE.Vector3(view.ball.pos.x, Math.max(0.6, view.ball.pos.y), view.ball.pos.z);
    this._m.lookAt(sh.from, look, new THREE.Vector3(0, 1, 0));
    this._q.setFromRotationMatrix(this._m);
    this._p.copy(this.cam.position).lerp(sh.from, k);
    this.cam.position.copy(this._p);
    this.cam.quaternion.slerp(this._q, k);
    // The stick follows the view once it has settled behind the ball.
    if (k > 0.5) {
      const f = new THREE.Vector3(look.x - sh.from.x, 0, look.z - sh.from.z);
      if (sh.kicked < 0) this.inputYaw = Math.atan2(f.x, -f.z);
    }
    return k;
  }

  private updateBase(view: ViewState, dt: number, s: CameraSettings) {
    const mode = s.mode ?? 'tracking';
    if (mode !== this.mode) {
      this.mode = mode;
      this.yawS.x = 0;
      this.yawS.v = 0;
      if (mode !== 'broadcast') { this.cam.fov = SIDELINE[mode].fov; this.cam.updateProjectionMatrix(); }
    }
    if (mode === 'broadcast') { this.updateBroadcast(view, dt, s); return; }
    const L = SIDELINE[mode];
    this.inputYaw = 0;
    const b = view.ball;
    const pt = possessionTeam(view);
    // Lead the ball towards the attacking direction of the team in possession so forward options are visible.
    const lead = pt >= 0 ? view.attackDir[pt] * L.lead : 0;
    let tx = b.pos.x + b.vel.x * 0.35 + lead;
    if (view.restart && !view.restart.ready && view.phase !== 'kickoff') tx = view.restart.spot.x;
    if (view.phase === 'kickoff' || view.phase === 'halftime' || view.phase === 'fulltime') tx = 0;
    tx = THREE.MathUtils.clamp(tx, -PITCH.halfLength + L.edge, PITCH.halfLength - L.edge);
    const tz = THREE.MathUtils.clamp(b.pos.z + b.vel.z * 0.2, -PITCH.halfWidth, PITCH.halfWidth);
    const omega = s.reducedMotion ? 1.4 : 2.4;
    const fx = this.fx.step(tx, omega, dt);
    const fz = this.fz.step(tz, omega * 0.7, dt);
    // Modest widening for long balls in the air.
    const airborne = b.pos.y > 2 && Math.hypot(b.vel.x, b.vel.z) > 14;
    const zt = (s.reducedMotion ? 1 : airborne ? 1.12 : 1) * ZOOM[s.zoom];
    const z = this.zoom.step(zt, 1.2, dt);
    const h = HEIGHT[s.height];
    const aspect = this.cam.aspect;
    // Narrow (portrait-ish) screens pull back a little so the play stays readable.
    const narrow = aspect < 1.3 ? 1 + (1.3 - aspect) * 0.6 : 1;
    const dist = L.dist * z * narrow;
    const pitchAngle = L.angle * h; // tracking: ~25° down at standard height
    const wideness = mode === 'tracking' ? 1 : 0.5; // wider views follow the ball's depth less
    this.cam.position.set(fx * L.slide, Math.sin(pitchAngle) * dist + 2, fz * 0.35 * wideness + PITCH.halfWidth * 0.4 + Math.cos(pitchAngle) * dist);
    this.cam.lookAt(fx * (mode === 'panoramic' ? 0.6 : 1), 0, fz * 0.6 * wideness + 3);
  }

  /** Where play is: the ball, led towards the attacking direction, held on restarts and kick-offs. */
  private focus(view: ViewState, lead: number, edge: number) {
    const b = view.ball;
    const pt = possessionTeam(view);
    let tx = b.pos.x + b.vel.x * 0.35 + (pt >= 0 ? view.attackDir[pt] * lead : 0);
    if (view.restart && !view.restart.ready && view.phase !== 'kickoff') tx = view.restart.spot.x;
    if (view.phase === 'kickoff' || view.phase === 'halftime' || view.phase === 'fulltime') tx = 0;
    tx = THREE.MathUtils.clamp(tx, -PITCH.halfLength + edge, PITCH.halfLength - edge);
    const tz = THREE.MathUtils.clamp(b.pos.z + b.vel.z * 0.2, -PITCH.halfWidth, PITCH.halfWidth);
    return { tx, tz };
  }

  /**
   * TV gantry: the camera stays put above the halfway line, behind the near stand, and only
   * pans, tilts and zooms. The field of view narrows as play moves away so players keep
   * roughly the same size on screen, and the pan lags a little like a camera operator's.
   */
  private updateBroadcast(view: ViewState, dt: number, s: CameraSettings) {
    const { tx, tz } = this.focus(view, 5, 6);
    const omega = s.reducedMotion ? 1.2 : 1.9;
    const fx = this.fx.step(tx, omega, dt);
    const fz = this.fz.step(tz, omega * 0.6, dt);
    const b = view.ball;
    const airborne = b.pos.y > 2 && Math.hypot(b.vel.x, b.vel.z) > 14;
    const z = this.zoom.step((s.reducedMotion ? 1 : airborne ? 1.12 : 1) * ZOOM[s.zoom], 1.2, dt);
    const h = HEIGHT[s.height];
    // A street cage is small: the gantry is lower and nearer, and keeps less of the pitch in shot.
    const cage = PITCH.walls;
    const camY = (cage ? 19 : 34) * h;
    const camZ = PITCH.halfWidth + (cage ? 21 : 36);
    this.cam.position.set(0, camY, camZ);
    const lookZ = fz * 0.6 + 2;
    this.cam.lookAt(fx, 0, lookZ);
    // Keep about 34 m of pitch (by height at the target) in shot whatever the distance.
    const aspect = this.cam.aspect;
    const narrow = aspect < 1.3 ? 1 + (1.3 - aspect) * 0.6 : 1;
    const d = Math.hypot(fx, camY, camZ - lookZ);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(((cage ? 25 : 34) * z * narrow) / 2 / d));
    if (Math.abs(fov - this.cam.fov) > 0.01) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }
    // Heading for input: smoothed so a pan doesn't jerk the controls mid-run.
    this.inputYaw = this.yawS.step(Math.atan2(fx, camZ - lookZ), 3, dt);
  }

  /** After a cinematic: set the field of view again on the next update. */
  resetLens() {
    this.mode = null;
  }

  resize(aspect: number) {
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }
}
