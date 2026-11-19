// Live menu background: while the menus are up, the computer plays a match in the stadium
// behind them and slow TV-style cameras watch it (a high gantry pan, a long lens from the
// touchline, a drone circling play, a crane behind the goal and a spider-cam). Shots cut
// through a short dip to dark every 8-10 seconds.
//
// Presentation only: it runs its own AI-v-AI Match (no input, no sound) through the same
// GameRenderer the matches use, so going into a match reuses the stadium that is already
// built. On phones and tablets (and Low quality) it draws at 30 fps to save battery.

import * as THREE from 'three';
import { PITCH, SIM } from '../shared/config';
import { defaultConfig, Match } from '../shared/match';
import { ALL_CLUBS, teamById } from '../shared/teams';
import type { MatchConfig } from '../shared/types';
import type { CineShot } from './render/cinematic';
import type { GameRenderer } from './render/renderer';
import type { CameraSettings } from './render/camera';
import { MatchViewBuilder, type ViewState } from './view';

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The camera shots, in the order they play (then round again). */
export const MENU_SHOTS = ['gantry', 'touchline', 'drone', 'goal', 'spider', 'closeup'] as const;
export type MenuShot = (typeof MENU_SHOTS)[number];

/** Seconds each shot holds, and the dip to dark at a cut. */
export const MENU_CAM = { hold: 9, dip: 0.45 } as const;

/**
 * Camera pose for a shot `t` seconds in, watching the (smoothed) point of interest `f`.
 * `seed` varies the side and drift of each new shot. Positions stay inside the bowl and
 * clear of the stands (the near straight has no roof, so the gantry looks in from there).
 */
export function menuShot(kind: MenuShot, t: number, f: THREE.Vector3, seed: number): CineShot {
  const side = seed % 2 ? 1 : -1;
  const hl = PITCH.halfLength, hw = PITCH.halfWidth;
  switch (kind) {
    case 'gantry': {
      // The TV gantry above the near touchline, panning slowly across with play.
      const x = clamp(f.x * 0.55, -26, 26) + side * lerp(-6, 6, t / MENU_CAM.hold);
      return { pos: { x, y: 30, z: hw + 32 }, look: { x: f.x, y: 0.5, z: f.z * 0.8 }, fov: 27 };
    }
    case 'touchline': {
      // A long lens at head height just off the near touchline, trailing the ball.
      const x = clamp(f.x - side * 14, -hl + 2, hl - 2);
      return { pos: { x, y: 1.7, z: hw + 3.2 }, look: { x: f.x, y: 1.1, z: f.z }, fov: 20, near: 0.2 };
    }
    case 'drone': {
      // Circling play at stand height, never outside the touchlines.
      const a = seed * 1.7 + side * t * 0.09;
      const x = clamp(f.x + Math.cos(a) * 30, -hl - 2, hl + 2);
      const z = clamp(f.z + Math.sin(a) * 30, -hw - 2, hw + 2);
      return { pos: { x, y: 15, z }, look: { x: f.x, y: 0.4, z: f.z }, fov: 44 };
    }
    case 'goal': {
      // A crane behind the goal play is heading for, rising slowly.
      const gx = f.x >= 0 ? 1 : -1;
      return { pos: { x: gx * (hl + 3.5), y: lerp(6, 11, t / MENU_CAM.hold), z: side * lerp(10, 4, t / MENU_CAM.hold) }, look: { x: f.x, y: 0.6, z: f.z * 0.9 }, fov: 42, near: 0.2 };
    }
    case 'spider': {
      // High above play, looking steeply down and turning a little.
      const a = seed + t * 0.05 * side;
      return { pos: { x: clamp(f.x + Math.cos(a) * 9, -hl, hl), y: 26, z: clamp(f.z + Math.sin(a) * 9, -hw, hw) }, look: { x: f.x, y: 0, z: f.z }, fov: 48 };
    }
    case 'closeup':
    default: {
      // Tight on the ball from the near side, as a director's iso camera would.
      const x = clamp(f.x + side * 6, -hl, hl);
      return { pos: { x, y: 3.2, z: hw + 5 }, look: { x: f.x, y: 0.9, z: f.z }, fov: 11, near: 0.3 };
    }
  }
}

/** Two different clubs for the next background match. */
export function pickMenuTeams(rand: () => number = Math.random): [string, string] {
  const a = ALL_CLUBS[Math.floor(rand() * ALL_CLUBS.length) % ALL_CLUBS.length].id;
  let b = a;
  while (b === a) b = ALL_CLUBS[Math.floor(rand() * ALL_CLUBS.length) % ALL_CLUBS.length].id;
  return [a, b];
}

/** Home for the first club; the second wears whichever kit stands out more against it. */
export function menuKits(ids: [string, string]): ['home' | 'away', 'home' | 'away'] {
  const a = teamById(ids[0]).home.shirt, b = teamById(ids[1]);
  const dist = (x: number, y: number) => Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255));
  const h = dist(a, b.home.shirt);
  return ['home', h >= 120 || h >= dist(a, b.away.shirt) ? 'home' : 'away'];
}

export class MenuBackdrop {
  private match: Match | null = null;
  private builder: MatchViewBuilder | null = null;
  private cfg: MatchConfig | null = null;
  private acc = 0;
  private shotI = 0;
  private shotT = 0;
  private seed = 1;
  private focus = new THREE.Vector3();
  private skip = 0;
  /** The dark dip over the canvas at a cut. */
  private dipEl: HTMLDivElement;
  active = false;
  /** Draw every other frame (30 fps) to save battery. */
  halfRate = false;

  constructor(host: HTMLElement) {
    this.dipEl = document.createElement('div');
    this.dipEl.className = 'menu-dip';
    host.insertBefore(this.dipEl, document.getElementById('hud'));
  }

  /**
   * Start (or keep) the background match. `teams` keeps the stadium the renderer already
   * has (after a match, the same two clubs), so nothing is rebuilt.
   */
  start(r: GameRenderer, teams?: [string, string], keep?: ['home' | 'away', 'home' | 'away']) {
    const ids = teams ?? pickMenuTeams();
    const kits = keep ?? menuKits(ids);
    this.cfg = defaultConfig({
      teams: ids, kits, humans: [false, false], difficulty: ['elite', 'elite'], realMinutes: 20,
      autoSwitch: [false, false], seed: (Math.random() * 2 ** 31) | 0,
    });
    r.setupMatch([teamById(ids[0]), teamById(ids[1])], kits);
    this.newMatch();
    this.shotI = (Math.random() * MENU_SHOTS.length) | 0;
    this.shotT = 0;
    this.seed = 1 + ((Math.random() * 1000) | 0);
    this.active = true;
    document.body.classList.remove('menu-still');
    document.body.classList.add('menu-live');
  }

  /**
   * Stop. `keepFrame` leaves the last picture on screen behind the next one (the loading card
   * sits over the frozen stadium while the match is built), until `release()`.
   */
  stop(r?: GameRenderer | null, keepFrame = false) {
    if (keepFrame && this.active) document.body.classList.add('menu-still');
    if (!this.active) return;
    this.active = false;
    this.match = null;
    this.builder = null;
    if (r) r.cine = null;
    this.dipEl.style.opacity = '0';
    document.body.classList.remove('menu-live');
  }

  private newMatch() {
    const cfg = this.cfg!;
    cfg.seed = (Math.random() * 2 ** 31) | 0;
    this.match = new Match(cfg);
    this.builder = new MatchViewBuilder(this.match);
    // Jump past the kick-off line-up so play is under way when the menus appear.
    for (let i = 0; i < 60 * 4; i++) this.step();
    this.acc = 0;
  }

  private step() {
    const m = this.match!;
    this.builder!.capture();
    m.step();
    m.drainEvents();
    // No half-time or full-time on the menus: a fresh match carries on instead.
    if (m.phase === 'halftime' || m.phase === 'fulltime') this.newMatch();
  }

  /** One menu frame: advance the match and draw it from the current camera. */
  frame(r: GameRenderer, dt: number, cam: CameraSettings): ViewState | null {
    if (!this.active || !this.match) return null;
    this.acc += Math.min(dt, 0.25);
    let n = 0;
    while (this.acc >= SIM.dt && n < 4) { this.step(); this.acc -= SIM.dt; n++; }
    if (n >= 4) this.acc = 0;
    const v = this.builder!.build(Math.min(1, this.acc / SIM.dt));
    // Follow the ball loosely (a camera operator, not a lock-on).
    const b = v.ball.pos;
    const k = 1 - Math.exp(-dt * 1.6);
    this.focus.x += (clamp(b.x, -PITCH.halfLength, PITCH.halfLength) - this.focus.x) * k;
    this.focus.z += (clamp(b.z, -PITCH.halfWidth, PITCH.halfWidth) - this.focus.z) * k;
    this.shotT += dt;
    if (this.shotT >= MENU_CAM.hold) {
      this.shotT = 0;
      this.shotI = (this.shotI + 1) % MENU_SHOTS.length;
      this.seed++;
    }
    const d = MENU_CAM.dip;
    const edge = Math.min(this.shotT, MENU_CAM.hold - this.shotT);
    this.dipEl.style.opacity = edge < d ? (0.6 * (1 - edge / d)).toFixed(3) : '0';
    r.cine = menuShot(MENU_SHOTS[this.shotI], this.shotT, this.focus, this.seed);
    r.setTunnelShot(false);
    if (this.halfRate && (this.skip ^= 1)) return v; // simulate every frame, draw every other
    r.render(v, this.halfRate ? dt * 2 : dt, cam, { localTeams: [], receiver: -1, showNext: false, playerRing: false, highContrast: false });
    return v;
  }

  /** The frozen picture is no longer needed (the match is drawing). */
  release() {
    document.body.classList.remove('menu-still');
  }

  /** The clubs and kits on show (the next match can keep the stadium). */
  get teams(): [string, string] | null {
    return this.cfg ? [this.cfg.teams[0], this.cfg.teams[1]] : null;
  }

  get kits(): ['home' | 'away', 'home' | 'away'] | null {
    return this.cfg ? [this.cfg.kits[0], this.cfg.kits[1]] : null;
  }
}
