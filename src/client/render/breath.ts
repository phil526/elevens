// Players' breath on cold nights: a small puff of vapour from each mouth, more often and bigger
// when a player is sprinting or tired, drifting with the wind and fading. Shown in the snow and
// on night matches (Medium and up); one pooled point-sprite system for everyone on the pitch.


import { Particles } from './vfx';
import type { ViewState } from '../view';
import type { MatchTime } from './vfx';
import type { Weather } from './weather';

/** Is it cold enough to see breath? Snow always; a night match in clear or wet weather. */
export function coldFor(time: MatchTime, weather: Weather): boolean {
  return weather === 'snow' || time === 'night';
}

/** Seconds between breaths: resting, jogging, sprinting; tired players breathe faster. */
export const BREATH = { rest: 1.25, jog: 0.95, sprint: 0.6, tired: 0.75, life: 1.25 } as const;

export function breathInterval(speed: number, sprinting: boolean, stamina: number): number {
  const base = sprinting || speed > 6 ? BREATH.sprint : speed > 2 ? BREATH.jog : BREATH.rest;
  return base * (stamina < 0.4 ? BREATH.tired / BREATH.rest + 0.2 : 1);
}

export class Breath {
  readonly parts = new Particles(260);
  private next: number[] = [];
  on = false;

  get points() { return this.parts.points; }

  reset() { this.next = []; }

  /**
   * Each frame. `heights` gives each player's mouth height (their build); `extra` adds mouths
   * that are not players (the managers on the touchline).
   */
  update(view: ViewState, dt: number, time: number, heights: number[], wind: { x: number; z: number }, extra: { x: number; y: number; z: number; facing: number; rate: number }[] = []) {
    if (!this.on) { if (this.parts.points.visible) this.parts.update(dt); return; }
    const puff = (x: number, y: number, z: number, fx: number, fz: number, vx: number, vz: number, k: number) => {
      for (let j = 0; j < 2; j++) {
        this.parts.add({
          x: x + fx * 0.14, y: y + (Math.random() - 0.5) * 0.02, z: z + fz * 0.14,
          vx: vx * 0.35 + fx * (0.55 + 0.25 * k) + wind.x * 0.12 + (Math.random() - 0.5) * 0.1,
          vy: 0.05 + Math.random() * 0.08,
          vz: vz * 0.35 + fz * (0.55 + 0.25 * k) + wind.z * 0.12 + (Math.random() - 0.5) * 0.1,
          life: 0, max: BREATH.life * (0.8 + Math.random() * 0.4), size: 0.07 + 0.03 * k, grow: 4.5 + 2 * k,
          r: 0.9, g: 0.92, b: 0.95, a: 0.16 + 0.08 * k, drag: 2.2, grav: -0.05,
        });
      }
    };
    view.players.forEach((p, i) => {
      if (p.off) return;
      if (this.next[i] === undefined) this.next[i] = time + Math.random() * 1.2;
      if (time < this.next[i]) return;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      this.next[i] = time + breathInterval(sp, p.sprinting, p.stamina) * (0.85 + Math.random() * 0.3);
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
      const k = p.sprinting ? 1 : sp > 2 ? 0.5 : 0;
      puff(p.pos.x, heights[i] ?? 1.62, p.pos.z, fx, fz, p.vel.x, p.vel.z, k);
    });
    extra.forEach((m, j) => {
      const i = 100 + j;
      if (this.next[i] === undefined) this.next[i] = time + Math.random();
      if (time < this.next[i]) return;
      this.next[i] = time + m.rate * (0.85 + Math.random() * 0.3);
      puff(m.x, m.y, m.z, Math.cos(m.facing), Math.sin(m.facing), 0, 0, 0.3);
    });
    this.parts.update(dt);
  }
}

