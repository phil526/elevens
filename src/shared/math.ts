// Small allocation-light helpers for the horizontal (x, z) plane.

export interface V2 { x: number; z: number }
export interface V3 { x: number; y: number; z: number }

export const v2 = (x = 0, z = 0): V2 => ({ x, z });
export const len = (x: number, z: number) => Math.hypot(x, z);
export const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.z - b.z);
export const dist2 = (a: V2, b: V2) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sign = (v: number) => (v < 0 ? -1 : 1);

export function norm(x: number, z: number): V2 {
  const l = Math.hypot(x, z);
  return l > 1e-9 ? { x: x / l, z: z / l } : { x: 0, z: 0 };
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Facing angle convention: 0 = +x, PI/2 = +z. */
export const angleOf = (x: number, z: number) => Math.atan2(z, x);
export const dirOf = (a: number): V2 => ({ x: Math.cos(a), z: Math.sin(a) });

export function turnTowards(current: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(current + Math.sign(d) * maxStep);
}

/** Distance from point p to segment a-b, plus the projection parameter t in [0,1]. */
export function pointSegment(p: V2, a: V2, b: V2): { d: number; t: number } {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-9 ? ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = a.x + abx * t, cz = a.z + abz * t;
  return { d: Math.hypot(p.x - cx, p.z - cz), t };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
