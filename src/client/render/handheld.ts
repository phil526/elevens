// A handheld pitchside camera for goal celebrations: an operator on the touchline with the camera
// on the shoulder. It sways and breathes, bobs a little as the operator steps, rolls slightly off
// level, and chases the action a beat late (it overshoots and settles when the players move).
// It wraps the planned celebration shots (client/cine.ts) and, where those don't play (online),
// gives the live match a pitchside shot of the scorer's group after a goal.

import * as THREE from 'three';
import type { CineShot } from './cinematic';
import type { ViewState } from '../view';
import { PITCH } from '../../shared/config';

/** Wobble in metres (position, look target), roll in radians and zoom breathing (share of fov). */
export const HANDHELD = { pos: 0.05, look: 0.07, bob: 0.022, roll: 0.014, zoom: 0.018, delay: 0.6 } as const;

const n = (t: number, f: number, o: number) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.13 + o * 1.7) * 0.4;

export class Handheld {
  private t = 0;
  private fresh = true;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private lv = new THREE.Vector3();
  private pv = new THREE.Vector3();
  private lastWant = new THREE.Vector3();
  private step = 0;
  /** How much it is wobbling now (0 steady .. 1), for tests. */
  amount = 0;

  /** Start again (a new shot: no chasing from the old one). */
  reset() {
    this.fresh = true;
  }

  /** The shot as an operator would hold it. `k`: 0 (steady) .. 1 (full handheld). */
  shake(shot: CineShot, dt: number, k = 1): CineShot {
    const want = new THREE.Vector3(shot.pos.x, shot.pos.y, shot.pos.z), target = new THREE.Vector3(shot.look.x, shot.look.y, shot.look.z);
    if (this.fresh || dt > 0.5) {
      this.fresh = false;
      this.pos.copy(want); this.look.copy(target); this.lv.set(0, 0, 0); this.pv.set(0, 0, 0); this.lastWant.copy(want);
    }
    this.amount = k;
    if (k <= 0) return shot;
    this.t += dt;
    const t = this.t;
    if (dt > 0) {
      // The framing chases the subject a beat late: springs that overshoot a little and settle.
      const spring = (x: THREE.Vector3, v: THREE.Vector3, to: THREE.Vector3, w: number, z: number) => {
        const a = to.clone().sub(x).multiplyScalar(w * w).addScaledVector(v, -2 * z * w);
        v.addScaledVector(a, Math.min(dt, 0.05));
        x.addScaledVector(v, Math.min(dt, 0.05));
      };
      spring(this.look, this.lv, target, 7.5, 0.5);
      spring(this.pos, this.pv, want, 5, 0.75);
      // Footsteps while the operator is moving to keep up.
      const moving = Math.min(1, want.distanceTo(this.lastWant) / Math.max(1e-4, dt) / 2);
      this.lastWant.copy(want);
      this.step += dt * 11 * (0.35 + moving);
    }
    const lookAt = this.look.clone().lerp(target, 1 - k);
    const from = this.pos.clone().lerp(want, 1 - k);
    from.x += n(t, 0.7, 1) * HANDHELD.pos * k;
    from.y += (n(t, 0.9, 2) * HANDHELD.pos * 0.8 + Math.abs(Math.sin(this.step)) * HANDHELD.bob) * k;
    from.z += n(t, 0.6, 3) * HANDHELD.pos * k;
    const d = Math.max(1, from.distanceTo(lookAt));
    const lw = HANDHELD.look * k * Math.min(2, d / 6);
    lookAt.x += n(t, 1.3, 4) * lw; lookAt.y += n(t, 1.1, 5) * lw * 0.8; lookAt.z += n(t, 1.2, 6) * lw;
    // Off level a touch: roll the up vector around the view direction.
    const fwd = lookAt.clone().sub(from).normalize();
    const up = new THREE.Vector3(shot.up?.x ?? 0, shot.up?.y ?? 1, shot.up?.z ?? 0).applyAxisAngle(fwd, n(t, 0.45, 7) * HANDHELD.roll * k);
    return {
      pos: { x: from.x, y: from.y, z: from.z },
      look: { x: lookAt.x, y: lookAt.y, z: lookAt.z },
      up: { x: up.x, y: up.y, z: up.z },
      fov: shot.fov * (1 + n(t, 0.23, 8) * HANDHELD.zoom * k),
      near: shot.near ?? 0.1,
    };
  }
}

/**
 * The live pitchside shot after a goal (where the celebration cinematic doesn't play): from the
 * nearest touchline, chest height, on the scorer and whoever has joined him. Null when nobody is
 * celebrating yet.
 */
export function pitchsideShot(view: ViewState, team: number, state: { pos: THREE.Vector3; look: THREE.Vector3; on: boolean }, dt: number): CineShot | null {
  const cel = view.players.filter((p) => !p.off && p.action.type === 'celebrate' && (team < 0 || p.team === team));
  const lead = cel[0];
  if (!lead) return null;
  let fx = 0, fz = 0, c = 0;
  for (const p of view.players) {
    if (p.off || p.team !== lead.team || Math.hypot(p.pos.x - lead.pos.x, p.pos.z - lead.pos.z) > 7) continue;
    fx += p.pos.x; fz += p.pos.z; c++;
  }
  fx /= c; fz /= c;
  // The operator runs along the nearest touchline, a few metres off to one side of the group.
  const side = fz >= 0 ? 1 : -1;
  const lineZ = side * (PITCH.halfWidth + 1.5);
  const dz = Math.abs(lineZ - fz);
  const off = Math.max(0, 7 - dz) * (fx >= 0 ? -0.8 : 0.8);
  const want = new THREE.Vector3(Math.max(-PITCH.halfLength - 3, Math.min(PITCH.halfLength + 3, fx + off)), 1.75, dz < 4 ? lineZ + side * (4 - dz) : lineZ);
  const look = new THREE.Vector3(fx, 1.2, fz);
  const k = 1 - Math.exp(-dt * 2.2);
  if (!state.on) { state.pos.copy(want); state.look.copy(look); state.on = true; } else { state.pos.lerp(want, k); state.look.lerp(look, Math.min(1, k * 2)); }
  const dist = state.pos.distanceTo(state.look);
  return { pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z }, look: { x: state.look.x, y: state.look.y, z: state.look.z }, fov: Math.max(24, Math.min(46, 40 - (dist - 8) * 0.9)), near: 0.1 };
}
