// The pre-match ceremony after the walk-out (part of the intro, offline): both teams line up
// along the halfway line facing the cameras with their mascots in front, the away side walks
// down the home line shaking hands, then each team poses for its photo (back row standing tall,
// front row crouching) as the flashes go off. Staged views only, like the intro.

import type { ViewPlayer, ViewState } from '../view';
import type { CineShot } from './cinematic';
import type { ReactionDirector } from './reactions';

export const PREMATCH = {
  line: 4.4, // the line-up with the mascots
  shake: 6.4, // the handshakes
  photo: 5.2, // both team photos
  rowZ: -6, // the line, facing +z (the main cameras)
  gap: 0.9, // between players in the line
  shakeZ: 0.95, // the away side walks this far in front of the home line
  shakeSpeed: 1.45,
  shakeEvery: 0.62, // seconds between away players setting off
  photoX: 22, // each team's photo in its own half
  photoZ: -4,
} as const;
export const PREMATCH_LENGTH = PREMATCH.line + PREMATCH.shake + PREMATCH.photo;

export type PreStage = 'line' | 'shake' | 'photo';

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Which stage `s` seconds into the ceremony, and how far into it. */
export function preStage(s: number): { stage: PreStage; u: number; t: number } {
  if (s < PREMATCH.line) return { stage: 'line', u: s / PREMATCH.line, t: s };
  if (s < PREMATCH.line + PREMATCH.shake) { const t = s - PREMATCH.line; return { stage: 'shake', u: t / PREMATCH.shake, t }; }
  const t = s - PREMATCH.line - PREMATCH.shake;
  return { stage: 'photo', u: t / PREMATCH.photo, t };
}

/** Cuts inside the ceremony (seconds from its start), for fades through black. */
export const PREMATCH_CUTS = [PREMATCH.line, PREMATCH.line + PREMATCH.shake, PREMATCH.line + PREMATCH.shake + PREMATCH.photo / 2];

/** Spot in the line for the i-th player of a team (0 nearest the halfway line). */
export function lineSpot(team: 0 | 1, i: number) {
  return { x: (team === 0 ? -1 : 1) * (0.55 + i * PREMATCH.gap), z: PREMATCH.rowZ };
}

/** Team photo spots: back row of six standing, front row of five crouching. */
export function photoSpot(team: 0 | 1, i: number) {
  const cx = (team === 0 ? -1 : 1) * PREMATCH.photoX;
  if (i < 6) return { x: cx + (i - 2.5) * 0.74, z: PREMATCH.photoZ, front: false };
  return { x: cx + (i - 6 - 2) * 0.8, z: PREMATCH.photoZ + 0.85, front: true };
}

/** The camera for each stage. */
export function prematchShot(s: number): CineShot {
  const { stage, u, t } = preStage(s);
  const z = PREMATCH.rowZ;
  if (stage === 'line') {
    // A slow track along the line at head height.
    const x = lerp(-11, 11, smooth(u * 0.9 + 0.05));
    return { pos: { x, y: 1.55, z: z + 5.2 }, look: { x: x * 0.82, y: 1.15, z }, fov: 40, near: 0.1 };
  }
  if (stage === 'shake') {
    // Side-on to the home line as the away side files past.
    const x = lerp(-2.2, -5.2, smooth(u));
    return { pos: { x: x + 1.6, y: 1.75, z: z + 6.2 }, look: { x: x - 0.6, y: 1.2, z: z + 0.4 }, fov: 42, near: 0.1 };
  }
  // The photographers' view: home team, then away.
  const team = t < PREMATCH.photo / 2 ? 0 : 1;
  const cx = (team === 0 ? -1 : 1) * PREMATCH.photoX;
  const k = (t - (team === 0 ? 0 : PREMATCH.photo / 2)) / (PREMATCH.photo / 2);
  return { pos: { x: cx, y: 1.3, z: PREMATCH.photoZ + lerp(7.4, 6.9, k) }, look: { x: cx, y: 0.95, z: PREMATCH.photoZ }, fov: 36, near: 0.1 };
}

/** When the photographers' flashes go off in the photo stage (seconds into it). */
export const PHOTO_FLASHES = [1.15, 1.6, 1.85, PREMATCH.photo / 2 + 1.15, PREMATCH.photo / 2 + 1.55];

function blank(): ViewPlayer['action'] { return { type: 'none', t: 0, dur: 0 }; }

/** The live view staged for the ceremony `s` seconds in. `order` lists each team's players (on the pitch). */
export function stagePrematch(live: ViewState, s: number): ViewState {
  const { stage, t } = preStage(s);
  const order: number[][] = [[], []];
  for (const p of live.players) if (!p.off) order[p.team].push(p.id);
  const players = live.players.map((p) => {
    const base = { ...p, vel: { x: 0, z: 0 }, sprinting: false, jockeying: false, action: blank(), facing: Math.PI / 2 };
    if (p.off) return base;
    const team = p.team as 0 | 1;
    const i = order[team].indexOf(p.id);
    if (stage === 'photo') {
      const show = t < PREMATCH.photo / 2 ? 0 : 1;
      if (team !== show) return { ...base, off: true };
      const sp = photoSpot(team, i);
      return { ...base, pos: { x: sp.x, z: sp.z } };
    }
    const spot = lineSpot(team, i);
    if (stage === 'line' || team === 0) {
      // Home players turn a little towards each away player as he comes to them.
      return { ...base, pos: spot, facing: stage === 'shake' ? Math.PI / 2 - 0.45 : Math.PI / 2 };
    }
    // The away side: a step forward, then along the home line, shaking hands.
    const t0 = 0.3 + i * PREMATCH.shakeEvery;
    if (t < t0) return { ...base, pos: spot };
    const st = t - t0;
    const step = Math.min(1, st / 0.7);
    if (st < 0.7) return { ...base, pos: { x: spot.x - 0.2 * step, z: spot.z + PREMATCH.shakeZ * smooth(step) }, vel: { x: -0.3, z: 1.2 }, facing: lerp(Math.PI / 2, Math.PI, smooth(step)) };
    const x = spot.x - 0.2 - (st - 0.7) * PREMATCH.shakeSpeed;
    return { ...base, pos: { x, z: spot.z + PREMATCH.shakeZ }, vel: { x: -PREMATCH.shakeSpeed, z: 0 }, facing: Math.PI };
  });
  return {
    ...live, players, humans: [false, false], restart: null,
    ball: { ...live.ball, pos: { x: 0, y: 0.11, z: 0 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1 },
  };
}

/** Hold the right poses for this frame: hands shaken as players meet, standing straight and crouching for the photo. */
export function prematchPoses(view: ViewState, s: number, rr: ReactionDirector) {
  const { stage, t } = preStage(s);
  if (stage === 'photo') {
    const show = t < PREMATCH.photo / 2 ? 0 : 1;
    let i = 0;
    for (const p of view.players) {
      if (p.team !== show || p.off) continue;
      const kind = photoSpot(show as 0 | 1, i++).front ? 'photoCrouch' : 'photoStand';
      if (rr.kindOf(p.id) !== kind) rr.cancel(p.id);
      rr.hold(p.id, kind, 0.6);
    }
    return;
  }
  if (stage === 'shake') {
    const home = view.players.filter((p) => p.team === 0 && !p.off), away = view.players.filter((p) => p.team === 1 && !p.off);
    const shake = (id: number) => { if (rr.kindOf(id) !== 'shake') rr.cancel(id); rr.hold(id, 'shake', 0.5); };
    for (const a of away) {
      if (Math.abs(a.pos.z - (PREMATCH.rowZ + PREMATCH.shakeZ)) > 0.05) continue;
      for (const h of home) if (Math.abs(a.pos.x - h.pos.x) < 0.42) { shake(a.id); shake(h.id); }
    }
  }
  // Everyone else stands tall, arms by their sides.
  for (const p of view.players) if (!p.off) rr.hold(p.id, 'lineUp', 0.6);
}
