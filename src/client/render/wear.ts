// Wear that builds up over a match: the pitch scuffs and turns to mud where players run, turn,
// tackle and dive (render/vfx.ts grass shader reads the map), and kits pick up mud and sweat.
// Purely visual: driven by the ViewState each frame, so it behaves the same online and offline.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { ViewPlayer, ViewState } from '../view';

/** Area the wear map covers (the pitch and a little of the surround), metres. */
export const WEAR_AREA = { halfX: PITCH.halfLength + 4, halfZ: PITCH.halfWidth + 4 } as const;
/** Cells per metre. */
const RES = 2;
export const WEAR_W = Math.round(WEAR_AREA.halfX * 2 * RES);
export const WEAR_H = Math.round(WEAR_AREA.halfZ * 2 * RES);

/** How much wear each kind of contact adds to the ground (0..1 per cell, scaled by the stamp). */
export const WEAR_RATE = {
  run: 0.05, // per metre run at sprint pace (turning hard counts double)
  slide: 0.55, // a slide tackle's streak
  tackle: 0.3,
  down: 0.35, // landing after a dive, a fall
  bounce: 0.12, // the ball landing hard
} as const;

/**
 * Wear map: R = scuffed grass (turns to soil), G = mud (only builds while the pitch is wet).
 * One small texture (226 x 152 cells, half a metre each) uploaded at most four times a second.
 */
export class PitchWear {
  readonly data: Uint8Array;
  readonly texture: THREE.DataTexture;
  private acc: Float32Array; // full-precision wear (R) and mud (G)
  private dirty = false;
  private upload = 0;
  private prev = new Map<number, { x: number; z: number; a: string; vx: number; vz: number }>();
  private ballVy = 0;

  constructor() {
    this.acc = new Float32Array(WEAR_W * WEAR_H * 2);
    this.data = new Uint8Array(WEAR_W * WEAR_H * 4);
    this.texture = new THREE.DataTexture(this.data, WEAR_W, WEAR_H, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
  }

  reset() {
    this.acc.fill(0);
    this.data.fill(0);
    this.prev.clear();
    this.texture.needsUpdate = true;
  }

  /** Wear (0..1) and mud (0..1) at a point, for tests and kit dirt. */
  at(x: number, z: number): { wear: number; mud: number } {
    const i = this.cell(x, z);
    return i < 0 ? { wear: 0, mud: 0 } : { wear: this.acc[i * 2], mud: this.acc[i * 2 + 1] };
  }

  private cell(x: number, z: number): number {
    const cx = Math.floor((x + WEAR_AREA.halfX) * RES), cz = Math.floor((z + WEAR_AREA.halfZ) * RES);
    if (cx < 0 || cz < 0 || cx >= WEAR_W || cz >= WEAR_H) return -1;
    return cz * WEAR_W + cx;
  }

  /** Add wear in a soft ellipse: centre, half-length along (dx, dz) and half-width, metres. */
  stamp(x: number, z: number, amount: number, wet: number, len = 0.35, wid = 0.35, dx = 1, dz = 0) {
    const r = Math.max(len, wid) + 0.5;
    const n = Math.hypot(dx, dz) || 1;
    const ux = dx / n, uz = dz / n;
    for (let gz = Math.floor((z - r + WEAR_AREA.halfZ) * RES); gz <= Math.floor((z + r + WEAR_AREA.halfZ) * RES); gz++) {
      if (gz < 0 || gz >= WEAR_H) continue;
      for (let gx = Math.floor((x - r + WEAR_AREA.halfX) * RES); gx <= Math.floor((x + r + WEAR_AREA.halfX) * RES); gx++) {
        if (gx < 0 || gx >= WEAR_W) continue;
        const px = (gx + 0.5) / RES - WEAR_AREA.halfX - x, pz = (gz + 0.5) / RES - WEAR_AREA.halfZ - z;
        const a = (px * ux + pz * uz) / len, b = (-px * uz + pz * ux) / wid;
        const f = Math.exp(-(a * a + b * b) * 1.4);
        if (f < 0.02) continue;
        const i = gz * WEAR_W + gx;
        this.acc[i * 2] = Math.min(1, this.acc[i * 2] + amount * f);
        if (wet > 0) this.acc[i * 2 + 1] = Math.min(1, this.acc[i * 2 + 1] + amount * f * wet * 1.6);
        this.data[i * 4] = Math.round(this.acc[i * 2] * 255);
        this.data[i * 4 + 1] = Math.round(this.acc[i * 2 + 1] * 255);
      }
    }
    this.dirty = true;
  }

  /**
   * Feed one frame of play. `wet` 0..1 (rain soaking the pitch) turns scuffs into mud.
   * Only moving play counts: dt is 0 while paused or during a replay.
   */
  update(view: ViewState, dt: number, wet: number) {
    if (dt > 0 && (view.phase === 'play' || view.phase === 'restart' || view.phase === 'kickoff')) {
      for (const p of view.players) {
        if (p.off) continue;
        const a = p.action.type;
        const last = this.prev.get(p.id);
        const sp = Math.hypot(p.vel.x, p.vel.z);
        if (last) {
          // Running wears the turf in proportion to pace; hard turns and stops tear it more.
          const turn = Math.hypot(p.vel.x - last.vx, p.vel.z - last.vz) / Math.max(dt, 1e-3);
          const k = sp > 3 ? (sp / 8) ** 2 * (1 + Math.min(2, turn / 25)) : 0;
          if (k > 0) this.stamp(p.pos.x, p.pos.z, WEAR_RATE.run * k * sp * dt, wet, 0.3, 0.3);
          if (a !== last.a) {
            if (a === 'slide') this.stamp(p.pos.x + p.vel.x * 0.25, p.pos.z + p.vel.z * 0.25, WEAR_RATE.slide, wet, 1.4, 0.32, p.vel.x || Math.cos(p.facing), p.vel.z || Math.sin(p.facing));
            else if (a === 'tackle') this.stamp(p.pos.x, p.pos.z, WEAR_RATE.tackle, wet, 0.5, 0.35, Math.cos(p.facing), Math.sin(p.facing));
            else if (a === 'down' || (a === 'stumble' && last.a !== 'slide')) this.stamp(p.pos.x, p.pos.z, WEAR_RATE.down, wet, 0.8, 0.45, Math.cos(p.facing), Math.sin(p.facing));
          }
          // A keeper's dive lands across the goalmouth.
          if (a === 'dive' && last.a !== 'dive') this.stamp(p.pos.x, p.pos.z, WEAR_RATE.down * 0.6, wet, 0.9, 0.5, -Math.sin(p.facing), Math.cos(p.facing));
        }
        if (last) { last.x = p.pos.x; last.z = p.pos.z; last.a = a; last.vx = p.vel.x; last.vz = p.vel.z; }
        else this.prev.set(p.id, { x: p.pos.x, z: p.pos.z, a, vx: p.vel.x, vz: p.vel.z });
      }
      // The ball landing hard leaves a pitch mark.
      const b = view.ball;
      if (b.pos.y < 0.3 && this.ballVy < -7 && b.vel.y > 0) this.stamp(b.pos.x, b.pos.z, WEAR_RATE.bounce, wet, 0.2, 0.2);
      this.ballVy = b.vel.y;
    }
    this.upload -= dt;
    if (this.dirty && this.upload <= 0) {
      this.texture.needsUpdate = true;
      this.dirty = false;
      this.upload = 0.25;
    }
  }
}

/** Mud and sweat on one player's kit (0..1 each), and which side the mud is on. */
export interface KitState {
  mud: number;
  /** Mud on the front (dives, falls forward) as against the back and sides (slides). */
  front: number;
  sweat: number;
  /** Share of the match already played when this player came on (substitutes start fresh). */
  since: number;
  /** Rain soaking into the kit and hair, 0..1 (darker, glossier cloth that ripples less). */
  soak: number;
  /** Snow settled on the shoulders and head, 0..1 (shaken off when he sprints). */
  snow: number;
  /** Late in the match: shirt hanging out over the shorts, 0..1. */
  untucked: number;
  /** Late in the match: socks rolled down to mid-shin, 0..1. */
  socks: number;
}

/** Clothes for the weather, picked per player at kick-off: 0 or 1 each. */
export interface KitGear {
  /** Long sleeves (base layer) under the shirt. */
  sleeves: number;
  /** Outfield players' black gloves. */
  gloves: number;
  /** Thermal tights showing down to the knee under the shorts. */
  tights: number;
}

/** How likely each look is (per player, fixed by his name so he wears the same each cold match). */
export const KIT_WEATHER = {
  sleevesAlways: 0.12, sleevesCold: 0.38, sleevesSnow: 0.18, keeperSleeves: 0.6,
  glovesCold: 0.22, glovesSnow: 0.28,
  tightsCold: 0.14, tightsSnow: 0.18,
  /** Share of outfielders who untuck their shirt / roll their socks down at some point, and from when (share of the match played). */
  untuck: 0.32, socks: 0.26, lateFrom: 0.55, lateSpan: 0.35,
  /** Rain: soaking reaches the weather's cover after about a quarter of the match; slides and dives soak at once. */
  soakBase: 0.45, soakRamp: 4, soakSlide: 0.25,
  /** Snow settles at this rate while standing or jogging, and is shaken off when sprinting. */
  snowSettle: 0.035, snowShake: 0.3, snowMax: 0.8,
} as const;

/** A stable 0..1 number for a player and a purpose (name hash), so choices don't change from frame to frame. */
export function kitRoll(name: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** What a player wears for this match: cold = snow or a night match (as for breath). */
export function gearFor(name: string, keeper: boolean, cold: boolean, snow: boolean): KitGear {
  const K = KIT_WEATHER;
  const sleevesChance = keeper ? K.keeperSleeves + (cold ? 0.25 : 0) : K.sleevesAlways + (cold ? K.sleevesCold : 0) + (snow ? K.sleevesSnow : 0);
  const glovesChance = keeper ? 0 : (cold ? K.glovesCold : 0) + (snow ? K.glovesSnow : 0);
  const tightsChance = (cold ? K.tightsCold : 0) + (snow ? K.tightsSnow : 0);
  return {
    sleeves: kitRoll(name, 11) < sleevesChance ? 1 : 0,
    gloves: kitRoll(name, 23) < glovesChance ? 1 : 0,
    tights: kitRoll(name, 37) < tightsChance ? 1 : 0,
  };
}

/** Shirt out and socks down as the match goes on: by player, more and sooner when tired. Keepers stay tidy. */
export function lateLook(name: string, keeper: boolean, played: number, stamina: number): { untucked: number; socks: number } {
  if (keeper) return { untucked: 0, socks: 0 };
  const K = KIT_WEATHER;
  const tired = 1 - Math.max(0, Math.min(1, stamina));
  // When he does it: a point in the last part of the match, earlier for a tired player.
  const when = (salt: number) => K.lateFrom + kitRoll(name, salt) * K.lateSpan - tired * 0.2;
  const ramp = (t: number) => Math.max(0, Math.min(1, (played - t) / 0.04));
  return {
    untucked: kitRoll(name, 51) < K.untuck ? ramp(when(52)) : 0,
    socks: kitRoll(name, 61) < K.socks ? ramp(when(62)) : 0,
  };
}

/**
 * Kits get dirtier with every slide, fall and dive (much more on a wet or muddy pitch), and
 * shirts darken with sweat as players tire over the match. Keepers get muddy fronts.
 */
export class KitWear {
  readonly state: KitState[] = [];
  private prev: string[] = [];

  reset() {
    this.state.length = 0;
    this.prev.length = 0;
  }

  get(id: number): KitState {
    return (this.state[id] ??= { mud: 0, front: 0.5, sweat: 0, since: 0, soak: 0, snow: 0, untucked: 0, socks: 0 });
  }

  /** A substitute comes on in a clean, dry kit, shirt tucked in. */
  fresh(id: number, view: ViewState) {
    this.state[id] = { mud: 0, front: 0.5, sweat: 0, since: playedShare(view), soak: 0, snow: 0, untucked: 0, socks: 0 };
  }

  /**
   * One frame. `wet` 0..1 from the rain (none when dry); `snowing` 0..1 from the snow; `pitch` gives
   * the mud underfoot.
   */
  update(view: ViewState, dt: number, wet: number, pitch: PitchWear | null, snowing = 0) {
    const K = KIT_WEATHER;
    // Sweat follows the match clock (both halves, plus extra time) and how tired each player is.
    const played = playedShare(view);
    for (const p of view.players) {
      const s = this.get(p.id);
      const a = p.action.type;
      const last = this.prev[p.id] ?? 'none';
      if (dt > 0 && a !== last) {
        const ground = pitch ? pitch.at(p.pos.x, p.pos.z) : { wear: 0, mud: 0 };
        const soil = 0.35 + wet * 0.6 + ground.mud * 0.8 + ground.wear * 0.3;
        if (a === 'slide') this.add(s, 0.3 * soil, 0);
        else if (a === 'dive') this.add(s, 0.22 * soil, 1);
        if ((a === 'slide' || a === 'dive' || a === 'down') && wet > 0) s.soak = Math.min(1, s.soak + K.soakSlide * wet);
        else if (a === 'down' && last !== 'dive') this.add(s, 0.18 * soil, 0.8);
        else if (a === 'stumble' && last !== 'slide') this.add(s, 0.12 * soil, 0.6);
        else if (a === 'tackle') this.add(s, 0.05 * soil, 0.4);
      }
      // Running splashes mud up the socks and shins, a lot on a wet, churned pitch.
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (dt > 0 && sp > 3) {
        const ground = pitch ? pitch.at(p.pos.x, p.pos.z).mud : 0;
        s.mud = Math.min(1, s.mud + dt * sp * (0.0001 + wet * 0.00025 + ground * 0.003));
      }
      this.prev[p.id] = a;
      const mine = Math.max(0, played - s.since);
      s.sweat = sweatLevel(mine, p);
      // Rain soaks in over the first part of the match (and never dries out during it).
      if (wet > 0) s.soak = Math.max(s.soak, wet * Math.min(1, K.soakBase + mine * K.soakRamp));
      // Snow settles on the shoulders and head while standing or jogging; a sprint shakes it off.
      if (dt > 0) {
        if (snowing > 0 && sp < 5.5) s.snow = Math.min(K.snowMax * snowing, s.snow + dt * K.snowSettle * snowing * (sp < 2 ? 1.6 : 1));
        else if (sp >= 5.5) s.snow = Math.max(0, s.snow - dt * K.snowShake * (sp / 7));
      }
      const late = lateLook(p.def.name, p.role === 'GK', played, p.stamina);
      s.untucked = Math.max(s.untucked, late.untucked * (s.since > 0 ? 0 : 1));
      s.socks = Math.max(s.socks, late.socks * (s.since > 0 ? 0 : 1));
    }
  }

  private add(s: KitState, amount: number, front: number) {
    const total = s.mud + amount;
    if (total > 0) s.front = (s.front * s.mud + front * amount) / total;
    s.mud = Math.min(1, total);
  }
}

/** Sweat (0..1): builds over the match, faster for tired players; keepers barely sweat. */
export function sweatLevel(played: number, p: Pick<ViewPlayer, 'stamina' | 'role'>): number {
  const tired = 1 - Math.max(0, Math.min(1, p.stamina));
  const k = Math.min(1, played * 0.75 + tired * 0.45);
  return p.role === 'GK' ? k * 0.35 : k;
}

/** How much of the match has been played, 0..1 (extra time stays at 1). */
export function playedShare(view: Pick<ViewState, 'clock'>): number {
  // The view's clock already counts on from 45:00 in the second half.
  return Math.max(0, Math.min(1, view.clock / (90 * 60)));
}
