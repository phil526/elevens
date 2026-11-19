// Floodlight haze: soft beams of light from the floodlight banks down into the bowl, picked out by
// the damp night air (more in rain, which the beams catch, and snow), slowly drifting. Drawn as
// open cones with an additive shader that fades at the edges, along the beam and near the
// ground, so there are no hard lines. Medium draws every other beam; Low has none.
// Also the order in which the floodlight banks come on in the match intro (render/renderer.ts).

import * as THREE from 'three';
import { INTRO } from './cinematic';

/**
 * When each floodlight bank comes on in the intro, 0..1: the bowl split into eight sectors
 * switched in opposite pairs, as a stadium's lighting is brought up.
 */
export function bankOrder(x: number, z: number): number {
  const a = Math.atan2(z, x);
  const s = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8) % 8;
  const seq = [0, 4, 2, 6, 1, 5, 3, 7];
  return (seq.indexOf(s) + 0.5) / 8;
}

/** How many banks are on (0..1) for lights-on progress `on` (all on once `on` reaches 1). */
export function litShare(on: number): number {
  return Math.max(0, Math.min(1, Math.floor(on * 8 + 0.5) / 8));
}

const VS = /* glsl */ `
attribute float aAlong;
attribute float aBank;
varying float vAlong, vBank;
varying vec3 vW, vN;
#include <common>
#include <fog_pars_vertex>
void main() {
  vAlong = aAlong; vBank = aBank;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FS = /* glsl */ `
uniform float uStrength, uTime, uOn;
uniform vec3 uColour;
varying float vAlong, vBank;
varying vec3 vW, vN;
#include <common>
#include <fog_pars_fragment>
float hHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hHash(i), hHash(i + vec2(1, 0)), f.x), mix(hHash(i + vec2(0, 1)), hHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  // A bank is lit once the intro's switch-on reaches it; it flares for a moment as it strikes up.
  float lit = step(vBank, uOn);
  if (lit < 0.5) discard;
  float strike = 1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.06, uOn - vBank)) * step(uOn, 0.999);
  vec3 V = normalize(cameraPosition - vW);
  // Brightest through the middle of the beam, fading to nothing at its edges.
  float face = pow(abs(dot(normalize(vN), V)), 1.6);
  // Strongest near the lamps, gone before the beam reaches the grass.
  float along = pow(1.0 - vAlong, 1.4) * smoothstep(0.0, 0.06, vAlong) * smoothstep(0.5, 7.0, vW.y);
  // Haze drifting through the light.
  float drift = 0.55 + 0.45 * hNoise(vW.xz * 0.06 + vec2(uTime * 0.05, vW.y * 0.08 - uTime * 0.03)) * hNoise(vW.xy * 0.11 - uTime * 0.04);
  float a = uStrength * face * along * drift * strike;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColour * a, 1.0);
  #include <fog_fragment>
}`;

export class FloodHaze {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  /** Beams built (tests). */
  count = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uStrength: { value: 0 }, uTime: { value: 0 }, uOn: { value: 1 }, uColour: { value: new THREE.Color(1, 0.95, 0.86) } }]),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  /** One beam from each lamp bank, aimed down into the pitch. Medium (q 1) keeps every other one. */
  setLamps(lamps: THREE.Vector3[], q: number) {
    this.mesh.geometry.dispose();
    this.count = 0;
    if (q < 1 || !lamps.length) { this.mesh.geometry = new THREE.BufferGeometry(); return; }
    const parts: THREE.BufferGeometry[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    lamps.forEach((p, i) => {
      if (q < 2 && i % 2) return;
      // Aimed at a spot on the pitch partway in from the bank, as floodlights are angled.
      const target = new THREE.Vector3(p.x * 0.28, 0, p.z * 0.28);
      const dir = target.clone().sub(p);
      const len = dir.length();
      const g = new THREE.CylinderGeometry(0.9, len * 0.12, len, q >= 2 ? 20 : 14, 1, true);
      // Cylinder runs along y from +len/2 (top, at the lamp) to -len/2; along = 0 at the lamp.
      const pos = g.getAttribute('position');
      const along = new Float32Array(pos.count), bank = new Float32Array(pos.count).fill(bankOrder(p.x, p.z));
      for (let k = 0; k < pos.count; k++) along[k] = 0.5 - pos.getY(k) / len;
      g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
      g.setAttribute('aBank', new THREE.BufferAttribute(bank, 1));
      g.translate(0, -len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up.clone().negate(), dir.clone().normalize()));
      g.translate(p.x, p.y, p.z);
      parts.push(g);
      this.count++;
    });
    const merged = new THREE.BufferGeometry();
    if (!parts.length) { this.mesh.geometry = merged; return; }
    // Merge by hand (all parts share the same attributes).
    const names = ['position', 'normal', 'aAlong', 'aBank'];
    let verts = 0, idx = 0;
    for (const g of parts) { verts += g.getAttribute('position').count; idx += g.getIndex()!.count; }
    const index = new Uint32Array(idx);
    let vo = 0, io = 0;
    const arrays = names.map((n) => new Float32Array(verts * parts[0].getAttribute(n).itemSize));
    for (const g of parts) {
      names.forEach((n, j) => arrays[j].set(g.getAttribute(n).array as Float32Array, vo * g.getAttribute(n).itemSize));
      const gi = g.getIndex()!.array;
      for (let k = 0; k < gi.length; k++) index[io + k] = gi[k] + vo;
      vo += g.getAttribute('position').count; io += gi.length;
      g.dispose();
    }
    names.forEach((n, j) => merged.setAttribute(n, new THREE.BufferAttribute(arrays[j], parts.length ? parts[0].getAttribute(n)?.itemSize ?? 1 : 1)));
    merged.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry = merged;
  }

  /** strength 0..1 from the lighting look and weather; `on` = intro lights-on progress (1 = all on). */
  update(time: number, strength: number, on: number) {
    this.mat.uniforms.uStrength.value = strength;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uOn.value = on;
    this.mesh.visible = strength > 0.002 && this.count > 0 && on > 0;
  }
}

/**
 * Floodlights during the match intro: off as the fly-in starts, then bank by bank (litShare)
 * from a tenth of the way through the fly-in until all are on at seven tenths.
 */
export function introLights(t: number, fly = INTRO.fly): number {
  const a = fly * 0.1, b = fly * 0.7;
  return Math.max(0, Math.min(1, (t - a) / (b - a)));
}
