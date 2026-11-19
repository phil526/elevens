// The airship over the ground: a silver blimp with a (made-up) sponsor down each side, circling
// slowly high above the roof, its panels lit and a red light blinking at night. At half-time the
// cameras cut to it: a slow look down from the blimp, then a drone sweeping in over the roof and
// down into the bowl (offline; see CineDirector.startAerial).

import * as THREE from 'three';
import type { CineShot } from './cinematic';
import { canvasTex } from './textures';

export const BLIMP = { length: 30, radius: 3.8, orbit: 105, above: 40, speed: 0.016 } as const;
export const AERIAL = { blimp: 4.6, drone: 5.2, fade: 0.45 } as const;
export const AERIAL_LENGTH = AERIAL.blimp + AERIAL.drone;

export class Blimp {
  readonly group = new THREE.Group();
  private light: THREE.Mesh;
  private panels: THREE.MeshBasicMaterial;
  private angle = 2.1;
  readonly height: number;

  constructor(roofHeight: number) {
    this.group.name = 'blimp';
    this.height = roofHeight + BLIMP.above;
    const L = BLIMP.length, R = BLIMP.radius;
    // Envelope: a stretched sphere, slightly fuller at the front.
    const env = new THREE.SphereGeometry(1, 32, 16);
    const pos = env.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const k = 1 - 0.18 * Math.max(0, -x); // tail tapers
      pos.setXYZ(i, x * L / 2, pos.getY(i) * R * k, pos.getZ(i) * R * k);
    }
    env.computeVertexNormals();
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.45, metalness: 0.25 });
    this.group.add(new THREE.Mesh(env, skin));
    // Fins at the tail, a gondola underneath.
    const finMat = new THREE.MeshStandardMaterial({ color: 0x1f3a6b, roughness: 0.6 });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.2, 0.25), finMat);
      fin.position.set(-L / 2 + 3.2, 0, 0);
      fin.rotation.x = (i * Math.PI) / 2;
      fin.translateY(R * 0.75);
      this.group.add(fin);
    }
    const gondola = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.4, 1.6), new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.5 }));
    gondola.position.set(2.5, -R - 0.55, 0);
    this.group.add(gondola);
    // The sponsor panels down each side.
    const tex = canvasTex(512, 128, (g) => {
      g.fillStyle = '#123a7a'; g.fillRect(0, 0, 512, 128);
      g.fillStyle = '#ffffff'; g.font = '900 72px "Arial Black", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('SKYLARK AIR', 256, 60, 480);
      g.fillStyle = '#ffd60a'; g.fillRect(0, 112, 512, 16);
    });
    this.panels = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xd8d8d8 });
    for (const s of [-1, 1]) {
      // A plane bent onto the envelope, reading front to back from either side.
      const g = new THREE.PlaneGeometry(L * 0.5, R * 1.1, 24, 6);
      const gp = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < gp.count; i++) {
        const x = s * gp.getX(i) + 1, y = gp.getY(i);
        const ex = x / (L / 2), rk = R * Math.sqrt(Math.max(0, 1 - ex * ex)) * (1 - 0.18 * Math.max(0, -ex));
        gp.setXYZ(i, x, y, s * Math.sqrt(Math.max(0.01, rk * rk - y * y)) * 1.012);
      }
      g.computeVertexNormals();
      this.group.add(new THREE.Mesh(g, this.panels));
    }
    this.light = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a2a, toneMapped: false }));
    this.light.position.set(0, R + 0.2, 0);
    this.group.add(this.light);
    this.update(0);
  }

  /** Where it is now (world). */
  get position() { return this.group.position; }

  update(time: number, night = false) {
    this.light.visible = night;
    this.panels.color.setHex(night ? 0xffffff : 0xd8d8d8);
    const a = this.angle + time * BLIMP.speed;
    const r = BLIMP.orbit;
    this.group.position.set(Math.cos(a) * r, this.height + Math.sin(time * 0.21) * 1.2, Math.sin(a) * r * 0.8);
    // Nose along the orbit (anticlockwise seen from above), a gentle pitch.
    this.group.rotation.set(0, -(a + Math.PI / 2), Math.sin(time * 0.17) * 0.03);
    this.light.scale.setScalar(Math.sin(time * 4) > 0.6 ? 1 : 0.01);
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The half-time aerial shots `t` seconds in: from the blimp's gondola looking down on the ground
 * (or a high orbit when there is no blimp), then a drone coming in over the roof behind a goal
 * and dropping into the bowl. `roofTop` is the stand roof's height.
 */
export function aerialShot(t: number, blimp: THREE.Vector3 | null, roofTop: number): CineShot {
  if (t < AERIAL.blimp) {
    const u = t / AERIAL.blimp;
    const from = blimp ? blimp.clone().add(new THREE.Vector3(0, -BLIMP.radius - 1.4, 0)) : new THREE.Vector3(Math.cos(2.1 + u * 0.2) * 100, roofTop + 40, Math.sin(2.1 + u * 0.2) * 80);
    return { pos: { x: from.x, y: from.y, z: from.z }, look: { x: lerp(-8, 6, smooth(u)), y: 0, z: lerp(-6, 4, smooth(u)) }, fov: lerp(34, 27, smooth(u)) };
  }
  const u = (t - AERIAL.blimp) / AERIAL.drone;
  const e = smooth(u);
  // Over the roof behind the left-hand goal, into the bowl, along towards the centre circle.
  const x = lerp(-112, -38, e);
  const y = lerp(roofTop + 14, 15, Math.pow(e, 0.8));
  const z = lerp(-26, 6, e) + Math.sin(u * Math.PI) * 6;
  return { pos: { x, y, z }, look: { x: lerp(-30, 12, e), y: lerp(4, 0, e), z: lerp(-8, 0, e) }, fov: 52 };
}
