// Cinematic cameras: the pre-match intro (a fly-in over the stadium, then the teams walking
// out of the tunnel) and the net-cam goal replay. Everything here is presentation only:
// the match simulation is paused while a cinematic plays, and the views built here are
// copies of the live view with players and ball placed for the shot.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { V3 } from '../../shared/types';
import type { ViewPlayer, ViewState } from '../view';

/** A camera pose that replaces the match camera for one frame. */
export interface CineShot {
  pos: V3;
  look: V3;
  fov: number;
  up?: V3;
  near?: number;
}

/** Where the players' tunnel meets the pitch surround: mouth centre on the ground, dir = +1 if players walk out towards +z. */
export interface TunnelInfo { x: number; z: number; dir: 1 | -1 }

/** The stadium can say where its tunnel is (`userData.tunnel`); otherwise the far side, in front of the main stand. */
export function tunnelOf(stadium: THREE.Object3D | null): TunnelInfo {
  const t = stadium?.userData?.tunnel as Partial<TunnelInfo> | undefined;
  if (t && typeof t.x === 'number' && typeof t.z === 'number') return { x: t.x, z: t.z, dir: t.dir === -1 ? -1 : 1 };
  return { x: 0, z: -(PITCH.halfWidth + 9), dir: 1 };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const smoother = (x: number) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };

// ------------------------------------------------------------------ intro

export const INTRO = {
  fly: 6.2, // stadium fly-in
  tunnel: 7.6, // walk-out from the tunnel
  fade: 0.45, // fade through black at each cut
  walkSpeed: 1.6, // m/s
  gap: 1.8, // m between pairs
  lead: -8, // first pair's start, metres from the mouth (negative = inside)
  file: 0.9, // each team's file this far either side of the tunnel's centre line
  corridor: 26, // tunnel length behind the mouth
};
export const INTRO_LENGTH = INTRO.fly + INTRO.tunnel;

export type IntroStage = 'fly' | 'tunnel' | 'done';

export interface IntroFrame {
  stage: IntroStage;
  shot: CineShot;
  /** 0 clear .. 1 black. */
  fade: number;
  /** Seconds into the walk-out (tunnel stage), else 0. */
  walk: number;
}

/** Fade to black around a cut at time c (and in from black at the very start). */
function fadeAt(t: number, cuts: number[]): number {
  let f = t < INTRO.fade ? 1 - t / INTRO.fade : 0;
  for (const c of cuts) {
    const d = Math.abs(t - c);
    if (d < INTRO.fade) f = Math.max(f, 1 - d / INTRO.fade);
  }
  return clamp01(f);
}

/**
 * The intro camera at time t. Fly-in: straight down from high above the roof, turning
 * slowly, then sweeping down into the bowl to a broadcast-height view of the empty pitch.
 * Walk-out: inside the tunnel behind the leading players, dollying out towards the light.
 */
export function introFrame(t: number, tunnel: TunnelInfo, _ceremony = false): IntroFrame {
  if (t < INTRO.fly) {
    const u = t / INTRO.fly;
    const e = smoother(u);
    const h = lerp(150, 27, e);
    const r = lerp(0, 80, Math.pow(smooth(u * 1.1 - 0.05), 1.5));
    const a = lerp(-1.0, 0.18, e);
    const pos = { x: Math.sin(a) * r, y: h, z: Math.cos(a) * r };
    // Screen-up starts as "away from the camera's heading" (top-down) and ends as world up.
    const away = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
    const up = away.lerp(new THREE.Vector3(0, 1, 0), smooth(u * 1.25 - 0.1)).normalize();
    return { stage: 'fly', shot: { pos, look: { x: 0, y: 0, z: lerp(0, -5, e) }, up: { x: up.x, y: up.y, z: up.z }, fov: lerp(38, 33, e) }, fade: fadeAt(t, [INTRO.fly]), walk: 0 };
  }
  if (t < INTRO_LENGTH) {
    const s = t - INTRO.fly;
    const u = s / INTRO.tunnel;
    // Chest height and nearly level, a little further back with a longer lens: looking down on
    // the players from close up foreshortened their backs and made them look squashed.
    const along = lerp(-16, -3.2, smooth(u));
    const d = tunnel.dir;
    const pos = { x: tunnel.x, y: lerp(1.42, 1.58, smooth(u)), z: tunnel.z + d * along };
    const look = { x: tunnel.x, y: lerp(1.3, 1.22, u), z: tunnel.z + d * (along + 24) };
    return { stage: 'tunnel', shot: { pos, look, fov: 42, near: 0.08 }, fade: fadeAt(t, [INTRO.fly, INTRO_LENGTH]), walk: s };
  }
  return { stage: 'done', shot: { pos: { x: 0, y: 30, z: 80 }, look: { x: 0, y: 0, z: 0 }, fov: 30 }, fade: 0, walk: 0 };
}

/** Walk-out position of pair i, metres from the tunnel mouth (negative = inside), after s seconds. */
export function walkAlong(i: number, s: number) {
  return INTRO.lead + INTRO.walkSpeed * s - INTRO.gap * i;
}

function blankAction(): ViewPlayer['action'] {
  return { type: 'none', t: 0, dur: 0 };
}

/**
 * The live view staged for the intro. Fly-in: an empty pitch (the teams are in the tunnel).
 * Walk-out: each team in single file, side by side, walking out of the tunnel; players still
 * deep inside (out of the corridor) are hidden.
 */
export function stageIntro(live: ViewState, frame: IntroFrame, tunnel: TunnelInfo): ViewState {
  const order: number[][] = [[], []];
  for (const p of live.players) if (!p.off) order[p.team].push(p.id);
  const players = live.players.map((p) => {
    const base = { ...p, vel: { x: 0, z: 0 }, sprinting: false, jockeying: false, action: blankAction(), off: true };
    if (frame.stage !== 'tunnel' || p.off) return base;
    const i = order[p.team].indexOf(p.id);
    const along = walkAlong(i, frame.walk);
    if (along < -(INTRO.corridor - 1.5)) return base;
    const side = p.team === 0 ? -1 : 1;
    // Lateral is across the walking direction; keep the home team on the camera's left.
    const lat = side * INTRO.file * -tunnel.dir;
    return {
      ...base,
      off: false,
      pos: { x: tunnel.x + lat, z: tunnel.z + tunnel.dir * along },
      vel: { x: 0, z: tunnel.dir * INTRO.walkSpeed },
      facing: tunnel.dir > 0 ? Math.PI / 2 : -Math.PI / 2,
    };
  });
  return {
    ...live, players, humans: [false, false], restart: null,
    ball: { ...live.ball, pos: { x: 0, y: 0.11, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1 },
  };
}

// ------------------------------------------------------------------ replay

interface SnapPlayer { pos: { x: number; z: number }; vel: { x: number; z: number }; facing: number; sprinting: boolean; jockeying: boolean; off: boolean; action: ViewPlayer['action'] }
export interface Snap {
  t: number;
  phase: ViewState['phase'];
  players: SnapPlayer[];
  ball: ViewState['ball'];
}

export function snapOf(v: ViewState, t: number): Snap {
  return {
    t,
    phase: v.phase,
    players: v.players.map((p) => ({
      pos: { x: p.pos.x, z: p.pos.z }, vel: { x: p.vel.x, z: p.vel.z }, facing: p.facing, sprinting: p.sprinting, jockeying: p.jockeying, off: p.off,
      action: { ...p.action, ...(p.action.target ? { target: { ...p.action.target } } : {}) },
    })),
    ball: { ...v.ball, pos: { ...v.ball.pos }, vel: { ...v.ball.vel } },
  };
}

/** Keeps the last few seconds of rendered views so a goal can be shown again. */
export class ReplayRecorder {
  private snaps: Snap[] = [];
  constructor(private keep = 8, private every = 1 / 40) {}

  push(v: ViewState, t: number) {
    const last = this.snaps[this.snaps.length - 1];
    if (last && t - last.t < this.every) return;
    this.snaps.push(snapOf(v, t));
    while (this.snaps.length > 2 && this.snaps[0].t < t - this.keep) this.snaps.shift();
  }

  clear() { this.snaps = []; }

  /** A copy of the recorded play between t0 and t1 (snapshots are never changed, so they are shared). */
  slice(t0: number, t1: number): ReplayRecorder {
    const r = new ReplayRecorder(Infinity, this.every);
    r.snaps = this.snaps.filter((s) => s.t >= t0 && s.t <= t1);
    return r;
  }

  /** The recorded snapshots (saved goal clips), and a recorder made from saved ones. */
  snapshots(): Snap[] { return this.snaps; }
  static of(snaps: Snap[]): ReplayRecorder { const r = new ReplayRecorder(Infinity); r.snaps = snaps; return r; }

  get first() { return this.snaps[0]?.t ?? 0; }
  get last() { return this.snaps[this.snaps.length - 1]?.t ?? 0; }
  get length() { return this.snaps.length; }

  /** The recorded state at time t, interpolated between the two nearest snapshots. */
  at(t: number): Snap | null {
    const s = this.snaps;
    if (!s.length) return null;
    if (t <= s[0].t) return s[0];
    if (t >= s[s.length - 1].t) return s[s.length - 1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m; else hi = m; }
    const a = s[lo], b = s[hi];
    const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const near = (x: number, y: number) => Math.abs(x - y) < 3; // teleports (restarts) are not smeared
    return {
      t, phase: k < 0.5 ? a.phase : b.phase,
      players: a.players.map((p, i) => {
        const q = b.players[i] ?? p;
        const lp = near(p.pos.x, q.pos.x) && near(p.pos.z, q.pos.z);
        return { ...(k < 0.5 ? p : q), pos: lp ? { x: lerp(p.pos.x, q.pos.x, k), z: lerp(p.pos.z, q.pos.z, k) } : (k < 0.5 ? p : q).pos };
      }),
      ball: { ...(k < 0.5 ? a.ball : b.ball), pos: near(a.ball.pos.x, b.ball.pos.x) && near(a.ball.pos.z, b.ball.pos.z) ? { x: lerp(a.ball.pos.x, b.ball.pos.x, k), y: lerp(a.ball.pos.y, b.ball.pos.y, k), z: lerp(a.ball.pos.z, b.ball.pos.z, k) } : (k < 0.5 ? a.ball : b.ball).pos },
    };
  }
}

/** The live view with a recorded moment's players and ball (score and names stay live). */
export function stageReplay(live: ViewState, s: Snap): ViewState {
  return {
    ...live,
    phase: s.phase === 'goal' ? 'goal' : 'play',
    players: live.players.map((p, i) => ({ ...p, ...(s.players[i] ?? {}) })),
    ball: s.ball, humans: [false, false], restart: null,
  };
}

export const REPLAY = {
  before: 3.6, // seconds shown before the ball crosses the line
  after: 0.9, // and after
  speed: 0.62, // slow motion
  delay: 1.1, // live celebration before the replay starts
};

/**
 * Net cam: inside the goal, in the corner away from where the ball goes in, looking out
 * through the posts. It follows the ball but never turns to look back into the net.
 */
export function netCamShot(side: number, goalZ: number, ball: V3, look: THREE.Vector3, dt: number): CineShot {
  const L = PITCH.halfLength;
  const pos = { x: side * (L + 1.5), y: 1.9, z: goalZ >= 0 ? -2.3 : 2.3 };
  const tx = side > 0 ? Math.min(ball.x, L - 3) : Math.max(ball.x, -(L - 3));
  const target = new THREE.Vector3(tx, Math.max(0.6, Math.min(ball.y, 6)), Math.max(-30, Math.min(30, ball.z)));
  if (look.lengthSq() === 0) look.copy(target);
  else look.lerp(target, 1 - Math.exp(-dt * 5));
  return { pos, look: { x: look.x, y: look.y, z: look.z }, fov: 52, near: 0.06 };
}

/** Which end the goal went in (+1 / -1) and where across the goal (z), from the ball at the moment of the goal. */
export function goalSideOf(ball: V3): { side: number; z: number } {
  return { side: ball.x >= 0 ? 1 : -1, z: ball.z };
}

// ------------------------------------------------------------------ tunnel set

/**
 * The inside of the players' tunnel, only shown during the walk-out. The stadium's own
 * geometry that pokes into the corridor (the front rows of the stand behind it) is
 * clipped away for that shot, so the camera sees a clean corridor opening onto the pitch.
 */
export class TunnelSet {
  group = new THREE.Group();
  private planes: THREE.Plane[] = [];
  private clipped: THREE.Material[] = [];

  constructor() {
    this.group.visible = false;
    this.group.name = 'tunnel-set';
  }

  build(scene: THREE.Scene, t: TunnelInfo, clubColour: number) {
    scene.remove(this.group);
    this.group = new THREE.Group();
    this.group.name = 'tunnel-set';
    this.group.visible = false;
    const W = 4.4, H = 3.1, len = INTRO.corridor;
    const wall = new THREE.MeshLambertMaterial({ color: 0x41464f, emissive: 0x15171b, side: THREE.DoubleSide });
    const floor = new THREE.MeshLambertMaterial({ color: 0x1f2227, emissive: 0x0b0c0e, side: THREE.DoubleSide });
    const ceil = new THREE.MeshLambertMaterial({ color: 0x2a2d33, emissive: 0x0d0e10, side: THREE.DoubleSide });
    const band = new THREE.MeshBasicMaterial({ color: clubColour, side: THREE.DoubleSide });
    const lamp = new THREE.MeshBasicMaterial({ color: 0xfff4dc });
    const plane = (w: number, h: number, m: THREE.Material) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    // Local frame: +z is the walking direction, the mouth is at z 0, the corridor runs back to -len.
    const f = plane(W, len, floor); f.rotation.x = -Math.PI / 2; f.position.set(0, 0.005, -len / 2);
    const c = plane(W, len, ceil); c.rotation.x = Math.PI / 2; c.position.set(0, H, -len / 2);
    const back = plane(W, H, wall); back.position.set(0, H / 2, -len);
    this.group.add(f, c, back);
    for (const sx of [-1, 1]) {
      const w = plane(len, H, wall); w.rotation.y = sx * Math.PI / 2; w.position.set(sx * W / 2, H / 2, -len / 2);
      const b = plane(len, 0.32, band); b.rotation.y = sx * Math.PI / 2; b.position.set(sx * (W / 2 - 0.01), 1.25, -len / 2);
      this.group.add(w, b);
    }
    // Strip lights along the ceiling, and a lit header over the mouth.
    for (let z = -len + 1.5; z < -0.5; z += 2.6) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.22), lamp);
      l.position.set(0, H - 0.04, z);
      this.group.add(l);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(W, 0.5, 0.2), band);
    header.position.set(0, H - 0.25, -0.15);
    this.group.add(header);
    this.group.position.set(t.x, 0, t.z);
    this.group.rotation.y = t.dir > 0 ? 0 : Math.PI;
    scene.add(this.group);
    // Clip box (world space) = the corridor's volume, slightly inside its walls.
    const z0 = t.dir > 0 ? t.z - len : t.z, z1 = t.dir > 0 ? t.z : t.z + len;
    const hw = W / 2 - 0.02;
    this.planes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), t.x - hw), // clipped where x > x - hw
      new THREE.Plane(new THREE.Vector3(1, 0, 0), -(t.x + hw)), // x < x + hw
      new THREE.Plane(new THREE.Vector3(0, -1, 0), -0.5), // y > -0.5
      new THREE.Plane(new THREE.Vector3(0, 1, 0), -(H - 0.02)), // y < H
      new THREE.Plane(new THREE.Vector3(0, 0, -1), z0), // z > z0
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -z1), // z < z1
    ];
  }

  /** Show the corridor and clip the stadium inside it (or undo both). */
  setActive(on: boolean, renderer: THREE.WebGLRenderer, stadium: THREE.Object3D | null) {
    if (on === this.group.visible) return;
    this.group.visible = on;
    if (on) {
      renderer.localClippingEnabled = true;
      const seen = new Set<THREE.Material>();
      stadium?.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of Array.isArray(mm) ? mm : mm ? [mm] : []) {
          if (seen.has(m)) continue;
          seen.add(m);
          m.clippingPlanes = this.planes;
          m.clipIntersection = true;
          m.needsUpdate = true;
        }
      });
      this.clipped = [...seen];
    } else {
      for (const m of this.clipped) { m.clippingPlanes = null; m.clipIntersection = false; m.needsUpdate = true; }
      this.clipped = [];
      renderer.localClippingEnabled = false;
    }
  }
}
