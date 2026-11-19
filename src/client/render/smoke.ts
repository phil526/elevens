// Smoke from the flares in the crowd drifting out over the pitch: big soft puffs that leave the
// flares tinted by their glow, roll down out of the stands into the bowl, spread and thin as they
// cross the pitch with the wind, lit by the floodlights. A trickle all match, thick clouds as the
// teams come out and from the scorers' end after a goal. One instanced draw of camera-facing
// quads; puffs near the camera fade out so they never fill the screen.

import * as THREE from 'three';

/** Most puffs alive at once by quality (Low has no flares, so no smoke). */
export const SMOKE_PUFFS = [0, 22, 34, 48] as const;

interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; s0: number; s1: number; seed: number; heat: number }

const VS = /* glsl */ `
attribute vec4 iPos;   // x, y, z, size
attribute vec4 iLook;  // alpha, heat (flare glow), seed, unused
varying vec2 vQ;
varying float vA, vHeat, vSeed;
#include <common>
#include <fog_pars_vertex>
void main() {
  vQ = position.xy;
  vA = iLook.x; vHeat = iLook.y; vSeed = iLook.z;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = iPos.xyz + (right * position.x + up * position.y) * iPos.w;
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  // Thin out puffs close to the lens (and never draw ones right on it).
  vA *= smoothstep(3.0, 14.0, -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FS = /* glsl */ `
uniform vec3 uLight, uGlow;
uniform float uTime;
varying vec2 vQ;
varying float vA, vHeat, vSeed;
#include <common>
#include <fog_pars_fragment>
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  // Billowing: a few octaves of noise turning slowly, so each puff has lumps and wisps.
  float a = vSeed * 6.28 + uTime * 0.03;
  vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * vQ * 2.2 + vSeed * 17.0;
  float n = sNoise(q) * 0.55 + sNoise(q * 2.3 + 5.0) * 0.3 + sNoise(q * 5.1 - 3.0) * 0.15;
  float d = smoothstep(1.0, 0.15, r) * smoothstep(0.25, 0.75, n + 0.35 * (1.0 - r));
  float alpha = d * vA;
  if (alpha < 0.004) discard;
  // Floodlit grey-white, glowing the flare's red where it is still fresh.
  vec3 c = mix(uLight, uGlow, vHeat) * (0.82 + 0.25 * n);
  gl_FragColor = vec4(c, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export class FlareSmoke {
  readonly mesh: THREE.InstancedMesh;
  private pos: THREE.InstancedBufferAttribute;
  private look: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private puffs: Puff[] = [];
  private flares: THREE.Vector3[] = [];
  private cap = 0;
  private acc = 0;
  private warmed = false;
  private surge: { team: 0 | 1 | -1; t: number } = { team: -1, t: 0 };
  /** Puffs alive (tests). */
  get count() { return this.puffs.length; }

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const max = SMOKE_PUFFS[3];
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.look = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage); this.look.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.pos);
    g.setAttribute('iLook', this.look);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uLight: { value: new THREE.Color(0.8, 0.8, 0.82) }, uGlow: { value: new THREE.Color(1, 0.35, 0.28) }, uTime: { value: 0 } }]),
      transparent: true, depthWrite: false, fog: true,
    });
    this.mesh = new THREE.InstancedMesh(g, this.mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  /** The flares for this match's ground, and how many puffs this quality allows. */
  setup(flares: THREE.Vector3[], q: number) {
    this.flares = flares;
    this.cap = flares.length ? SMOKE_PUFFS[Math.max(0, Math.min(3, q))] : 0;
    this.puffs.length = 0;
    this.acc = 0;
    this.warmed = false;
    this.surge = { team: -1, t: 0 };
    this.mesh.count = 0;
  }

  /** A goal: the scorers' fans light more flares at their end (home end is -x). */
  goal(team: 0 | 1) {
    this.surge = { team, t: 18 };
  }

  /** Floodlit colour of the smoke (the scene's light), set when the lighting look changes. */
  setLight(c: THREE.Color) {
    this.mat.uniforms.uLight.value.copy(c);
  }

  private emit(fromTeam: 0 | 1 | -1) {
    if (!this.flares.length || this.puffs.length >= this.cap) return;
    // A flare at the chosen end (or any), the smoke starting just above it.
    let list = this.flares;
    if (fromTeam >= 0) { const end = this.flares.filter((f) => (fromTeam === 0 ? f.x < -55 : f.x > 55)); if (end.length) list = end; }
    const f = list[Math.floor(Math.random() * list.length)];
    const inx = -f.x, inz = -f.z, n = Math.hypot(inx, inz) || 1;
    const sp = 1.3 + Math.random() * 1.1;
    this.puffs.push({
      x: f.x, y: f.y + 1.5, z: f.z,
      vx: (inx / n) * sp, vy: 0.5 + Math.random() * 0.4, vz: (inz / n) * sp,
      age: 0, life: 28 + Math.random() * 22, s0: 1.6 + Math.random(), s1: 11 + Math.random() * 8, seed: Math.random(), heat: 1,
    });
  }

  /**
   * One frame. `waiting`: before the first kick-off (thick smoke as the teams come out).
   * `wind`: the match wind (m/s, x/z).
   */
  update(dt: number, time: number, waiting: boolean, wind: { x: number; z: number }) {
    this.mat.uniforms.uTime.value = time;
    if (!this.cap) { this.mesh.visible = false; return; }
    // The flares were lit before the camera got there: start the walk-out with the smoke already out.
    if (!this.warmed) {
      this.warmed = true;
      if (waiting) for (let i = 0; i < 40; i++) this.step(0.5, time - 20 + i * 0.5, true, wind);
    }
    this.step(dt, time, waiting, wind);
    this.write();
  }

  private step(dt: number, time: number, waiting: boolean, wind: { x: number; z: number }) {
    if (dt > 0) {
      this.surge.t = Math.max(0, this.surge.t - dt);
      const rate = waiting ? 1.4 : this.surge.t > 0 ? 1.6 : 0.12;
      this.acc += dt * rate;
      for (; this.acc >= 1; this.acc -= 1) this.emit(this.surge.t > 0 ? this.surge.team : waiting ? (Math.random() < 0.75 ? 0 : -1) : -1);
    }
    this.puffs = this.puffs.filter((p) => (p.age += dt) < p.life);
    for (const p of this.puffs) {
      // Rolls down out of the stand and out over the pitch, then hangs and drifts with the wind.
      const settle = Math.min(1, p.age / 14);
      const tx = wind.x * 0.55 + Math.sin(time * 0.11 + p.seed * 9) * 0.25, tz = wind.z * 0.55 + Math.cos(time * 0.09 + p.seed * 7) * 0.25;
      const k = 1 - Math.exp(-dt * 0.12);
      p.vx += (tx - p.vx) * k * settle; p.vz += (tz - p.vz) * k * settle;
      const floor = 5 + p.seed * 8;
      p.vy += ((p.y > floor ? -0.12 : 0.1) - p.vy) * (1 - Math.exp(-dt * 0.4));
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.heat = Math.max(0, 1 - p.age / 3);
    }
  }

  private write() {
    const P = this.pos.array as Float32Array, L = this.look.array as Float32Array;
    let n = 0;
    for (const p of this.puffs) {
      const u = p.age / p.life;
      const size = p.s0 + (p.s1 - p.s0) * (1 - Math.pow(1 - Math.min(1, u * 1.6), 2));
      const alpha = 0.42 * Math.min(1, p.age / 1.5) * Math.pow(1 - u, 1.5);
      P[n * 4] = p.x; P[n * 4 + 1] = p.y; P[n * 4 + 2] = p.z; P[n * 4 + 3] = size;
      L[n * 4] = alpha; L[n * 4 + 1] = p.heat; L[n * 4 + 2] = p.seed; L[n * 4 + 3] = 0;
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.pos.needsUpdate = this.look.needsUpdate = true;
  }
}
