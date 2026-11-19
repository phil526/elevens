// Goal celebrations, staged as a short cinematic before the net-cam replay (offline; the match
// waits): the scorer peels away towards the corner and then slides on his knees, kisses the club
// crest in front of the fans, pulls his teammates into a bouncing huddle, banks round like an
// aeroplane, drops to his knees pointing at the sky, cups his ear or points at the camera, leads a
// little dance in a line, has his teammates bow down to him, or plays one of the captured
// cheers, while the nearest teammates chase him and join in. Presentation only: the
// views here are copies of the live view with the players moved for the shot.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { ViewPlayer, ViewState } from '../view';
import type { CineShot } from './cinematic';
import type { ReactionDirector, ReactionKind } from './reactions';

export type CelebKind = 'kneeSlide' | 'badgeKiss' | 'huddle' | 'cheer' | 'aeroplane' | 'kneelSky' | 'cupEar' | 'pointCrowd' | 'dance' | 'bow';
export const CELEB_KINDS: readonly CelebKind[] = ['kneeSlide', 'badgeKiss', 'huddle', 'cheer', 'aeroplane', 'kneelSky', 'cupEar', 'pointCrowd', 'dance', 'bow'];

export const CELEB = {
  length: 6.4, // seconds
  fade: 0.35,
  delay: 0.45, // live play after the goal before the cut
  run: 6.6, // scorer's sprint, m/s
  maxRun: 19, // metres
  slide: 3.4, // knee slide, metres
  slideTime: 1.15,
  mateSpeed: 6.6,
  mates: 4,
  arc: 0.3, // the aeroplane's curve, as a share of the run
  dancers: 2, // teammates either side of him in the dance line
  clear: 5, // other players are kept this far from the celebration
} as const;

interface XZ { x: number; z: number }
interface Mate { id: number; from: XZ; to: XZ; t0: number; t1: number; face: number; kind: ReactionKind }
export interface CelebPlan {
  kind: CelebKind;
  scorer: number;
  team: 0 | 1;
  from: XZ;
  to: XZ;
  runEnd: number;
  slideTo: XZ;
  face: number;
  mates: Mate[];
  /** Where the camera ends up looking. */
  centre: XZ;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** Which celebration for this goal: varied by the scorer and the number of goals so far. */
export function celebKindFor(scorer: number, goals: number): CelebKind {
  return CELEB_KINDS[(scorer * 3 + goals * 7 + 1) % CELEB_KINDS.length];
}

/**
 * Plan the celebration from the live view at the cut. `scorer` celebrates (for an own goal, the
 * nearest player of the scoring side is passed in instead).
 */
export function planCelebration(live: ViewState, scorer: number, team: 0 | 1, kind: CelebKind): CelebPlan {
  const L = PITCH.halfLength, W = PITCH.halfWidth;
  const s = live.players[scorer];
  const from = { x: s.pos.x, z: s.pos.z };
  const side = Math.sign(live.ball.pos.x || from.x || 1);
  const zs = Math.sign(from.z || 1);
  // Towards the corner by the fans (a huddle stays near where he scored).
  let to: XZ = kind === 'huddle' ? { x: from.x - side * 3, z: from.z * 0.8 } : { x: side * (L - 7), z: zs * (W - 4.5) };
  let dx = to.x - from.x, dz = to.z - from.z, d = Math.hypot(dx, dz);
  const maxRun = kind === 'huddle' ? 7 : CELEB.maxRun;
  if (d > maxRun) { to = { x: from.x + (dx / d) * maxRun, z: from.z + (dz / d) * maxRun }; dx = to.x - from.x; dz = to.z - from.z; d = maxRun; }
  if (d < 2) { to = { x: from.x - side * 4, z: from.z + zs * 3 }; dx = to.x - from.x; dz = to.z - from.z; d = Math.hypot(dx, dz); }
  const runEnd = Math.min(2.8, Math.max(1, d / CELEB.run));
  const ux = dx / d, uz = dz / d;
  const slideTo = kind === 'kneeSlide' ? { x: to.x + ux * CELEB.slide, z: to.z + uz * CELEB.slide } : { ...to };
  // Facing at the end: along the slide, out to the fans for the crest, else back up the pitch.
  const runFace = Math.atan2(uz, ux);
  const out = Math.abs(slideTo.z) > W - 9 ? Math.atan2(Math.sign(slideTo.z), 0) : Math.atan2(0, side);
  const face = kind === 'kneeSlide' ? runFace : kind === 'badgeKiss' ? out : Math.atan2(-slideTo.z, -slideTo.x);
  const centre = { ...slideTo };
  // The nearest teammates chase him (not the keeper).
  const near = live.players
    .filter((p) => p.team === team && p.id !== scorer && !p.off && p.role !== 'GK')
    .map((p) => ({ p, d: Math.hypot(p.pos.x - centre.x, p.pos.z - centre.z) }))
    .filter((q) => q.d < 60)
    .sort((a, b) => a.d - b.d)
    .slice(0, kind === 'huddle' ? CELEB.mates + 1 : CELEB.mates);
  const mates: Mate[] = near.map(({ p }, i) => {
    let slot: XZ;
    if (kind === 'dance' && i < CELEB.dancers) {
      // In a line with him, shoulder to shoulder, all facing the same way.
      const side = i % 2 ? -1 : 1, rank = Math.floor(i / 2) + 1;
      slot = { x: centre.x - Math.sin(face) * side * rank * 0.95, z: centre.z + Math.cos(face) * side * rank * 0.95 };
    } else if (kind === 'bow') {
      // Either side of him and a little in front (the camera still sees him), bowing down.
      const side = i % 2 ? -1 : 1, rank = Math.floor(i / 2);
      const a = face + side * (1.3 + rank * 0.4);
      slot = { x: centre.x + Math.cos(a) * (1.6 + rank * 0.3), z: centre.z + Math.sin(a) * (1.6 + rank * 0.3) };
    } else if (kind === 'huddle') {
      // A ring, shoulder to shoulder, the scorer in it too.
      const n = near.length + 1, a = face + ((i + 1) / n) * Math.PI * 2;
      slot = { x: centre.x + Math.cos(a) * 0.62, z: centre.z + Math.sin(a) * 0.62 };
    } else {
      // Round him on the pitch side, a little apart (behind the line for a dance, so the camera sees it).
      const back = Math.atan2(-centre.z, -centre.x) + (kind === 'dance' ? Math.PI : 0);
      const a = back + (i - (near.length - 1) / 2) * 0.62;
      const r = 1.05 + (i % 2) * 0.35;
      slot = { x: centre.x + Math.cos(a) * r, z: centre.z + Math.sin(a) * r };
    }
    const d0 = Math.hypot(slot.x - p.pos.x, slot.z - p.pos.z);
    const t0 = 0.2 + i * 0.18;
    const t1 = t0 + d0 / CELEB.mateSpeed;
    const toC = Math.atan2(centre.z - slot.z, centre.x - slot.x);
    const kinds: ReactionKind[] = ['armsUp', 'fistPump', 'highFive', 'clap'];
    const dancer = kind === 'dance' && i < CELEB.dancers;
    const mk: ReactionKind = kind === 'huddle' ? 'huddle' : kind === 'bow' ? 'bow' : dancer ? 'dance' : kinds[i % kinds.length];
    return { id: p.id, from: { x: p.pos.x, z: p.pos.z }, to: slot, t0, t1, face: dancer ? face : toC, kind: mk };
  });
  if (kind === 'huddle') {
    // The scorer stands in the ring.
    const n = near.length + 1;
    slideTo.x = centre.x + Math.cos(face) * 0.62 * (n > 1 ? 1 : 0);
    slideTo.z = centre.z + Math.sin(face) * 0.62 * (n > 1 ? 1 : 0);
  }
  return { kind, scorer, team, from, to, runEnd, slideTo, face: kind === 'huddle' ? Math.atan2(centre.z - slideTo.z, centre.x - slideTo.x) : face, mates, centre: { ...centre } };
}

/** Queue the poses (render/reactions.ts) for the plan on the renderer's reaction director. */
export function celebrationReactions(plan: CelebPlan, rr: ReactionDirector) {
  const s = plan.scorer, end = CELEB.length + 0.5;
  rr.cancel(s);
  for (const m of plan.mates) rr.cancel(m.id);
  if (plan.kind === 'kneeSlide') rr.add(s, 'kneeSlide', end - plan.runEnd + 0.1, Math.max(0, plan.runEnd - 0.12));
  else if (plan.kind === 'badgeKiss') { rr.add(s, 'badgeKiss', 2.6, plan.runEnd + 0.1); rr.add(s, 'armsUp', end, plan.runEnd + 2.6); }
  else if (plan.kind === 'huddle') {
    const first = Math.min(...plan.mates.map((m) => m.t1), plan.runEnd + 0.5);
    rr.add(s, 'huddle', end, first);
  }
  else if (plan.kind === 'aeroplane') { rr.add(s, 'aeroplane', plan.runEnd + 1.2, 0.25); rr.add(s, 'armsUp', end, plan.runEnd + 1.2); }
  else if (plan.kind === 'kneelSky') rr.add(s, 'kneelSky', end - plan.runEnd, plan.runEnd);
  else if (plan.kind === 'cupEar') { rr.add(s, 'cupEar', 2.4, plan.runEnd + 0.25); rr.add(s, 'armsWide', end, plan.runEnd + 2.6); }
  else if (plan.kind === 'pointCrowd') { rr.add(s, 'pointCrowd', 2.4, plan.runEnd + 0.15); rr.add(s, 'fistPump', end, plan.runEnd + 2.5); }
  else if (plan.kind === 'bow') rr.add(s, 'armsWide', end, plan.runEnd + 0.3);
  let danceAt = 0;
  if (plan.kind === 'dance') {
    // Everyone in the line starts on the same beat.
    // (A dancer still on his way joins in step as he arrives.)
    danceAt = Math.min(CELEB.length - 3, Math.max(plan.runEnd + 0.6, ...plan.mates.filter((m) => m.kind === 'dance').map((m) => m.t1 + 0.4)));
    rr.add(s, 'armsUp', danceAt, plan.runEnd);
    rr.add(s, 'dance', end, danceAt);
  }
  for (const m of plan.mates) rr.add(m.id, m.kind, end, m.kind === 'dance' ? danceAt : m.t1 + (m.kind === 'huddle' ? 0 : 0.1));
}

const at = (a: XZ, b: XZ, k: number): XZ => ({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });

/** The scorer's position, velocity and facing t seconds in. */
function scorerAt(plan: CelebPlan, t: number): { pos: XZ; vel: XZ; face: number; sprint: boolean } {
  const dx = plan.to.x - plan.from.x, dz = plan.to.z - plan.from.z;
  const run = Math.atan2(dz, dx);
  if (t < plan.runEnd) {
    const k = t / plan.runEnd;
    const v = Math.hypot(dx, dz) / plan.runEnd;
    // Easing off over the last metres unless he slides.
    const slide = plan.kind === 'kneeSlide';
    const e = slide ? k : 0.7 * k + 0.3 * (1 - (1 - k) * (1 - k));
    const sp = slide ? v : v * (0.7 + 0.6 * (1 - k));
    const pos = at(plan.from, plan.to, e);
    if (plan.kind === 'aeroplane') {
      // Banking round in a wide curve, away from the touchline and back.
      // Bending in towards the middle of the pitch, never out over the touchline.
      const d = Math.hypot(dx, dz), nz = -dx / d, mz = (plan.from.z + plan.to.z) / 2;
      const bend = CELEB.arc * d * (nz * mz > 0 ? -1 : 1);
      const off = Math.sin(Math.PI * e) * bend, dOff = Math.cos(Math.PI * e) * Math.PI * bend / d;
      pos.x += (dz / d) * off; pos.z += (-dx / d) * off;
      const f = run - Math.atan(dOff);
      return { pos, vel: { x: Math.cos(f) * sp, z: Math.sin(f) * sp }, face: f, sprint: sp > 5 };
    }
    return { pos, vel: { x: Math.cos(run) * sp, z: Math.sin(run) * sp }, face: run, sprint: sp > 5 };
  }
  if (plan.kind === 'kneeSlide') {
    // On his knees: the body skates on, slowing (no stride: zero velocity keeps the legs folded).
    const k = clamp01((t - plan.runEnd) / CELEB.slideTime);
    const e = 1 - (1 - k) * (1 - k);
    return { pos: at(plan.to, plan.slideTo, e), vel: { x: 0, z: 0 }, face: run, sprint: false };
  }
  // Turning to the fans (or into the ring) once there.
  const k = smooth((t - plan.runEnd) / 0.6);
  const pos = plan.kind === 'huddle' ? at(plan.to, plan.slideTo, k) : plan.to;
  let f = run + Math.atan2(Math.sin(plan.face - run), Math.cos(plan.face - run)) * k;
  if (plan.kind === 'huddle' && k >= 1) f = plan.face;
  return { pos, vel: { x: 0, z: 0 }, face: f, sprint: false };
}

function blank(): ViewPlayer['action'] { return { type: 'none', t: 0, dur: 0 }; }

/** The live view with the celebration staged t seconds in. */
export function stageCelebration(live: ViewState, plan: CelebPlan, t: number): ViewState {
  const players = live.players.map((p) => {
    if (p.id === plan.scorer) {
      const s = scorerAt(plan, t);
      const cheer = plan.kind === 'cheer' && t >= plan.runEnd;
      return { ...p, pos: s.pos, vel: s.vel, facing: s.face, sprinting: s.sprint, jockeying: false, action: cheer ? { type: 'celebrate' as const, t: t - plan.runEnd, dur: CELEB.length } : blank() };
    }
    const m = plan.mates.find((q) => q.id === p.id);
    if (m) {
      const k = clamp01((t - m.t0) / Math.max(0.01, m.t1 - m.t0));
      const moving = t > m.t0 && t < m.t1;
      const dx = m.to.x - m.from.x, dz = m.to.z - m.from.z, d = Math.hypot(dx, dz) || 1;
      const v = moving ? CELEB.mateSpeed : 0;
      const runF = Math.atan2(dz, dx);
      const arrived = t >= m.t1;
      const fk = smooth((t - m.t1) / 0.4);
      const face = arrived ? runF + Math.atan2(Math.sin(m.face - runF), Math.cos(m.face - runF)) * fk : runF;
      return { ...p, pos: at(m.from, m.to, k), vel: { x: (dx / d) * v, z: (dz / d) * v }, facing: face, sprinting: moving, jockeying: false, action: blank() };
    }
    // Everyone else stands still, out of the way of the celebration.
    let pos = p.pos;
    const ox = p.pos.x - plan.centre.x, oz = p.pos.z - plan.centre.z, od = Math.hypot(ox, oz);
    if (od < CELEB.clear) pos = od > 0.01 ? { x: plan.centre.x + (ox / od) * CELEB.clear, z: plan.centre.z + (oz / od) * CELEB.clear } : { x: plan.centre.x, z: plan.centre.z - Math.sign(plan.centre.z || 1) * CELEB.clear };
    return { ...p, pos, vel: { x: 0, z: 0 }, sprinting: false, jockeying: false, action: p.action.type === 'celebrate' ? blank() : p.action };
  });
  return { ...live, phase: 'goal', players, humans: [false, false], restart: null, ball: { ...live.ball, vel: { x: 0, y: 0, z: 0 } } };
}

/**
 * The camera: low and close on the pitch side of the scorer, the fans behind him, following the
 * run and swinging slowly round him; higher for a huddle. `state` keeps the smoothing.
 */
export function celebrationShot(plan: CelebPlan, t: number, view: ViewState, state: { pos: THREE.Vector3; look: THREE.Vector3 }, dt: number): CineShot {
  const sp = view.players[plan.scorer].pos;
  // Focus: the scorer, then the middle of the group as they arrive.
  let fx = sp.x, fz = sp.z, n = 1;
  for (const m of plan.mates) if (t > m.t1 - 0.3) { const q = view.players[m.id].pos; fx += q.x; fz += q.z; n++; }
  fx /= n; fz /= n;
  const huddle = plan.kind === 'huddle';
  const low = (plan.kind === 'kneeSlide' || plan.kind === 'kneelSky') && t > plan.runEnd;
  const wide = plan.kind === 'dance' || plan.kind === 'bow' ? 1.6 : 0;
  const back = Math.atan2(-fz, -fx * 0.6); // towards the middle of the pitch
  const swing = -0.55 + 1.1 * smooth(t / CELEB.length);
  const a = back + swing;
  const dist = huddle ? 4.4 - 0.6 * smooth(t / CELEB.length) : 6.4 + wide - 1.6 * smooth((t - 1) / 3);
  const h = huddle ? 3.3 : low ? 1.25 : 1.6 + wide * 0.3;
  const want = new THREE.Vector3(fx + Math.cos(a) * dist, h, fz + Math.sin(a) * dist);
  const look = new THREE.Vector3(fx, huddle || low ? 0.85 : 1.15, fz);
  const k = 1 - Math.exp(-dt * 5);
  if (state.pos.lengthSq() === 0) { state.pos.copy(want); state.look.copy(look); } else { state.pos.lerp(want, k); state.look.lerp(look, Math.min(1, k * 1.5)); }
  return { pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z }, look: { x: state.look.x, y: state.look.y, z: state.look.z }, fov: 44, near: 0.08 };
}
