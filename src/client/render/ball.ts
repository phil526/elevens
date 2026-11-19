// The match ball: an original six-panel design drawn from a 3D pattern (so it has no seams
// or pinching at the poles), with grooved seams for the light to catch, and how it spins:
// rolling on the ground, curling shots turn about the vertical (the side spin read from how
// the flight bends, so it works online too), lofted balls carry backspin.

import * as THREE from 'three';

/** Ball colours: white with deep navy swirls, a teal accent and a thin gold edge. */
export const BALL_COLOURS = { base: [247, 247, 242], ink: [20, 28, 52], accent: [24, 201, 151], edge: [232, 186, 60], seam: [70, 74, 80] } as const;

/**
 * The panel a direction on the ball belongs to (0..5) and how far it is from the nearest seam
 * (0 on the seam). Six cube-face panels whose seams are bent into S-curves.
 */
export function ballPanel(x: number, y: number, z: number): { panel: number; seam: number; u: number; v: number } {
  // Bend the seams: twist each axis a little by the others.
  const k = 0.32;
  const bx = x + k * Math.sin(2.4 * y + 0.6) * z;
  const by = y + k * Math.sin(2.4 * z + 1.7) * x;
  const bz = z + k * Math.sin(2.4 * x + 2.9) * y;
  const ax = Math.abs(bx), ay = Math.abs(by), az = Math.abs(bz);
  let panel: number, m1: number, m2: number, u: number, v: number;
  if (ax >= ay && ax >= az) { panel = bx > 0 ? 0 : 1; m1 = ax; m2 = Math.max(ay, az); u = by / ax; v = bz / ax; }
  else if (ay >= az) { panel = by > 0 ? 2 : 3; m1 = ay; m2 = Math.max(ax, az); u = bz / ay; v = bx / ay; }
  else { panel = bz > 0 ? 4 : 5; m1 = az; m2 = Math.max(ax, ay); u = bx / az; v = by / az; }
  return { panel, seam: m1 - m2, u, v };
}

/** RGB of the design at a direction (unit vector), and a height for the seam grooves (0 groove .. 1 panel). */
export function ballColourAt(x: number, y: number, z: number): { rgb: [number, number, number]; h: number } {
  const { panel, seam, u, v } = ballPanel(x, y, z);
  const C = BALL_COLOURS;
  let rgb: [number, number, number] = [...C.base];
  // A curved swoosh across each panel: navy on four panels, teal on two, edged in gold.
  const s = v - 0.55 * Math.sin(u * 2.1 + panel);
  const w = 0.2 + 0.08 * Math.cos(u * 3 + panel * 1.3);
  const d = Math.abs(s) - w;
  const ink = panel === 2 || panel === 5 ? C.accent : C.ink;
  if (d < 0) rgb = [...ink];
  else if (d < 0.035) rgb = [...C.edge];
  // A small accent triangle near each panel's corner.
  if (u > 0.45 && v < -0.35 && u + (-v) < 1.25) rgb = panel % 2 ? [...C.accent] : [...C.ink];
  const h = Math.min(1, seam / 0.03);
  if (seam < 0.012) rgb = [...C.seam];
  return { rgb, h };
}

/** Colour and bump maps (equirectangular), larger on higher quality. */
export function ballTextures(quality: number): { map: THREE.Texture; bump: THREE.Texture } {
  const W = quality >= 2 ? 1024 : 512, H = W / 2;
  const cMap = document.createElement('canvas'), cBump = document.createElement('canvas');
  cMap.width = cBump.width = W; cMap.height = cBump.height = H;
  const gm = cMap.getContext('2d')!, gb = cBump.getContext('2d')!;
  const im = gm.createImageData(W, H), ib = gb.createImageData(W, H);
  for (let j = 0; j < H; j++) {
    // SphereGeometry: v = 1 at the top (+y); canvas row 0 is the top with flipY.
    const theta = ((j + 0.5) / H) * Math.PI;
    const y = Math.cos(theta), r = Math.sin(theta);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W) * Math.PI * 2;
      // three's SphereGeometry: x = -cos(phi) sin(theta), z = sin(phi) sin(theta).
      const x = -Math.cos(phi) * r, z = Math.sin(phi) * r;
      const { rgb, h } = ballColourAt(x, y, z);
      const o = (j * W + i) * 4;
      im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
      const hb = Math.round(255 * (0.55 + 0.45 * h));
      ib.data[o] = ib.data[o + 1] = ib.data[o + 2] = hb; ib.data[o + 3] = 255;
    }
  }
  gm.putImageData(im, 0, 0);
  gb.putImageData(ib, 0, 0);
  const map = new THREE.CanvasTexture(cMap);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const bump = new THREE.CanvasTexture(cBump);
  return { map, bump };
}

/** The ball's material: glossy on High and Ultra (a clear coat), satin below. */
export function ballMaterial(quality: number): THREE.MeshStandardMaterial {
  const { map, bump } = ballTextures(quality);
  if (quality >= 2) {
    return new THREE.MeshPhysicalMaterial({ map, bumpMap: bump, bumpScale: 0.6, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.25 });
  }
  return new THREE.MeshStandardMaterial({ map, bumpMap: quality > 0 ? bump : null, bumpScale: 0.6, roughness: 0.4 });
}

/** Spin read from the flight: rad/s about the vertical (side spin) and about the travel's side axis (back/top spin). */
export const SPIN = { side: 6, maxSide: 26, back: 9, top: 4, smooth: 0.12 } as const;

/**
 * Turns the ball each frame. On the ground (or held) it rolls with its speed; in the air the
 * side spin follows the sideways bend of the flight and lofted balls turn backwards.
 */
export class BallSpin {
  private lat = 0;
  private prev = new THREE.Vector3();
  private have = false;
  private lofted = false;
  /** Smoothed side spin, rad/s (positive turns anticlockwise seen from above), for tests. */
  side = 0;
  private q = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  reset() { this.have = false; this.lat = 0; this.side = 0; }

  /** Advance `out` (the ball's orientation) by one frame. `radius` is the drawn radius. */
  step(out: THREE.Quaternion, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, inFlight: boolean, dt: number, radius: number) {
    if (dt <= 0) return;
    const v = new THREE.Vector3(vel.x, vel.y, vel.z);
    const sp = Math.hypot(v.x, v.z);
    // Sideways acceleration of the flight (gravity and drag act along y and the travel).
    let lat = 0;
    if (this.have && sp > 4) {
      const a = v.clone().sub(this.prev).divideScalar(dt);
      lat = (v.z * a.x - v.x * a.z) / sp; // + = bending to the left of travel (anticlockwise spin from above)
    }
    // A teleport (restart) or a new kick: start the estimate again.
    if (!this.have || v.distanceTo(this.prev) > 12) { this.lat = 0; this.lofted = v.y > 3.5; }
    const k = 1 - Math.exp(-dt / SPIN.smooth);
    this.lat += (THREE.MathUtils.clamp(lat, -12, 12) - this.lat) * k;
    this.prev.copy(v);
    this.have = true;
    const airborne = inFlight && pos.y > radius * 1.6;
    if (!inFlight) this.lofted = false;
    if (airborne) {
      this.side = THREE.MathUtils.clamp(this.lat * SPIN.side, -SPIN.maxSide, SPIN.maxSide);
      // Side spin about the vertical.
      if (Math.abs(this.side) > 0.05) {
        this.q.setFromAxisAngle(this.axis.set(0, 1, 0), this.side * dt);
        out.premultiply(this.q);
      }
      // Back spin on lofted balls, a little top spin on driven ones.
      if (sp > 2) {
        this.axis.set(v.z, 0, -v.x).normalize();
        const w = this.lofted ? -SPIN.back : SPIN.top;
        this.q.setFromAxisAngle(this.axis, w * dt);
        out.premultiply(this.q);
      }
    } else {
      this.side *= 1 - k;
      if (sp > 0.05) {
        this.axis.set(v.z, 0, -v.x).normalize();
        this.q.setFromAxisAngle(this.axis, (sp * dt) / radius);
        out.premultiply(this.q);
      }
    }
  }
}
