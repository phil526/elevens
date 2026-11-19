// A livelier crowd: flags waved in the stands, scarves held up while the fans sing, rhythmic
// clapping, hands on heads after a near miss, and now and then a Mexican wave going round
// the ground. The fans themselves are animated in arena.ts's shader; this module owns the
// shared "crowd moment" uniforms that drive them, and builds the waved flags.
//
// Flags are one instanced mesh (one draw call) animated in the vertex shader: the flag swings
// from the fan's raised hand and the cloth ripples, harder as the supporters get excited.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { crowdUniforms } from './crowd';

/** Crowd moments, shared by every fan and flag shader in the ground. */
export const moments = {
  /** Mexican wave: x = angle of the front round the ground (radians), y = strength 0..1. */
  uWave: { value: new THREE.Vector2(0, 0) },
  /** Scarves up and singing, per side (home, away) 0..1. */
  uSing: { value: new THREE.Vector2(0, 0) },
  /** Rhythmic clapping, per side. */
  uClap: { value: new THREE.Vector2(0, 0) },
  /** Hands on heads after a near miss, per side. */
  uMiss: { value: new THREE.Vector2(0, 0) },
};

/** GLSL shared by the fans and the flags: how much each moment applies to a fan of a team at an angle. */
export const MOMENTS_GLSL = /* glsl */ `
uniform vec2 uWave;
uniform vec2 uSing;
uniform vec2 uClap;
uniform vec2 uMiss;
float sideOf(vec2 v, float team) { return team < 0.5 ? v.x : team < 1.5 ? v.y : 0.35 * max(v.x, v.y); }
float waveAt(vec2 ip) {
  float a = atan(ip.y, ip.x);
  float d = mod(a - uWave.x + 3.14159265, 6.2831853) - 3.14159265;
  return uWave.y * exp(-d * d / 0.022);
}`;

/** Bind the moment uniforms (and time/excitement) into a shader being compiled. */
export function bindMoments(sh: { uniforms: Record<string, THREE.IUniform> }) {
  sh.uniforms.uTime = crowdUniforms.uTime;
  sh.uniforms.uExcite = crowdUniforms.uExcite;
  sh.uniforms.uWave = moments.uWave;
  sh.uniforms.uSing = moments.uSing;
  sh.uniforms.uClap = moments.uClap;
  sh.uniforms.uMiss = moments.uMiss;
}

/** One waved flag: where the fan stands (their instance matrix) and the club's colours. */
export interface FlagSpot {
  matrix: THREE.Matrix4;
  team: number; // 0 home, 1 away
  colour: number;
  second: number; // the other colour of the flag
  pattern: number; // 0 vertical bands, 1 horizontal halves, 2 diagonal
  phase: number;
}

/** Flag, pole and all, in the fan's frame (facing -z): the pole rises from the raised right hand. */
function flagGeometry(): THREE.BufferGeometry {
  const hand = new THREE.Vector3(0.32, 2.12, 0.0);
  const pole = new THREE.BoxGeometry(0.035, 2.4, 0.035).translate(hand.x, hand.y + 0.75, hand.z);
  const cloth = new THREE.PlaneGeometry(1.6, 1.0, 8, 3).translate(hand.x + 0.82, hand.y + 1.45, hand.z - 0.01);
  cloth.rotateY(0); // the plane faces +z; the fans see it from the pitch side through DoubleSide
  const tag = (g: THREE.BufferGeometry, isCloth: boolean) => {
    const n = g.attributes.position.count;
    const u = new Float32Array(n);
    const p = g.attributes.position.array;
    for (let i = 0; i < n; i++) u[i] = isCloth ? (p[i * 3] - (hand.x + 0.02)) / 1.6 : -1;
    g.setAttribute('aCloth', new THREE.BufferAttribute(u, 1));
    if (g.index) return g.toNonIndexed();
    return g;
  };
  const geo = mergeGeometries([tag(pole, false), tag(cloth, true)]);
  geo.deleteAttribute('normal');
  geo.computeVertexNormals();
  geo.userData.hand = hand;
  return geo;
}

let flagMat: THREE.MeshLambertMaterial | null = null;
function flagMaterial(): THREE.MeshLambertMaterial {
  if (flagMat) return flagMat;
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    bindMoments(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2 uExcite;
        ${MOMENTS_GLSL}
        attribute float aCloth;  // -1 pole, else 0..1 out along the flag
        attribute vec4 aFlag;    // phase, team, pattern, 0
        attribute vec3 aSecond;  // the flag's other colour
        varying vec2 vFlagUv;
        varying float vPole;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = aFlag.x, team = aFlag.y;
        float e = team < 0.5 ? uExcite.x : uExcite.y;
        vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
        // The fan's own movement (the same as in the fan shader): jumping, standing for the wave.
        float jump = smoothstep(0.65, 1.0, e) * abs(sin(uTime * (7.0 + fract(ph * 13.0) * 3.0) + ph * 40.0)) * 0.3;
        float lift = jump + waveAt(ip) * 0.3;
        vFlagUv = vec2(max(aCloth, 0.0), (position.y - 3.57) / 1.0 + 0.5);
        vPole = aCloth < 0.0 ? 1.0 : 0.0;
        // Cloth: a ripple running out along the flag, bigger at the free end.
        if (aCloth >= 0.0) {
          float k = aCloth;
          transformed.z += sin(k * 5.0 - uTime * (6.0 + 4.0 * e) + ph * 9.0) * 0.2 * k * (0.6 + e);
          transformed.y -= k * k * 0.16 * (1.0 - e);
        }
        // The whole flag swings from the hand, side to side, harder when it's exciting.
        float sw = sin(uTime * (2.2 + fract(ph * 7.0)) + ph * 30.0) * (0.35 + 0.55 * e) - 0.25;
        vec2 hd = vec2(0.32, 2.12);
        vec2 r = transformed.xy - hd;
        float cs = cos(sw), sn = sin(sw);
        transformed.xy = hd + vec2(cs * r.x - sn * r.y, sn * r.x + cs * r.y);
        transformed.y += lift;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vFlagSecond = aSecond;
        vFlagPattern = aFlag.z;`)
      .replace('#include <common>', `#include <common>
        varying vec3 vFlagSecond;
        varying float vFlagPattern;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vFlagUv;
        varying float vPole;
        varying vec3 vFlagSecond;
        varying float vFlagPattern;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float band = vFlagPattern < 0.5 ? step(0.333, vFlagUv.x) * step(vFlagUv.x, 0.667)
            : vFlagPattern < 1.5 ? step(0.5, vFlagUv.y)
            : step(vFlagUv.y, vFlagUv.x * 0.62 + 0.18) * step(vFlagUv.x * 0.62 - 0.18, vFlagUv.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vFlagSecond, band);
          if (vPole > 0.5) diffuseColor.rgb = vec3(0.12);
        }`);
  };
  flagMat = m;
  return m;
}

/** All the waved flags in the ground as one instanced mesh. */
export function buildFlags(spots: FlagSpot[]): THREE.InstancedMesh | null {
  if (!spots.length) return null;
  const geo = flagGeometry();
  const n = spots.length;
  const flag = new Float32Array(n * 4), second = new Float32Array(n * 3);
  const mesh = new THREE.InstancedMesh(geo, flagMaterial(), n);
  const c = new THREE.Color();
  spots.forEach((s, i) => {
    mesh.setMatrixAt(i, s.matrix);
    mesh.setColorAt(i, c.setHex(s.colour));
    c.setHex(s.second);
    second.set([c.r, c.g, c.b], i * 3);
    flag.set([s.phase, s.team, s.pattern, 0], i * 4);
  });
  geo.setAttribute('aFlag', new THREE.InstancedBufferAttribute(flag, 4));
  geo.setAttribute('aSecond', new THREE.InstancedBufferAttribute(second, 3));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.name = 'flags';
  return mesh;
}

/** How many flags each preset waves: Low keeps a handful in front of its painted crowd. */
export const FLAG_COUNTS = [26, 70, 120, 160] as const;

/** A flag's second colour: white, or black on a light club colour. */
export function flagSecond(colour: number): number {
  const c = new THREE.Color(colour);
  return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.75 ? 0x16181d : 0xf2f2f2;
}

/**
 * Times the crowd moments. The renderer calls `trigger` for events (chances, chants, the
 * walk-out) and `update` each frame; a Mexican wave starts by itself in quiet spells.
 */
export class CrowdMoments {
  private sing: [number, number] = [0, 0]; // seconds left
  private clap: [number, number] = [0, 0];
  private miss: [number, number] = [0, 0];
  private wave = { on: false, a: 0, left: 0, k: 0 };
  private quiet = 0;
  private nextWave = 150 + Math.random() * 120;
  private level = { sing: [0, 0], clap: [0, 0], miss: [0, 0] };

  reset() {
    this.sing = [0, 0]; this.clap = [0, 0]; this.miss = [0, 0];
    this.wave = { on: false, a: 0, left: 0, k: 0 };
    this.quiet = 0;
    moments.uWave.value.set(0, 0);
  }

  trigger(kind: 'chant' | 'stomp' | 'walkout' | 'kickoff' | 'miss' | 'wave', team = 0) {
    if (kind === 'chant') this.sing[team] = Math.max(this.sing[team], 9);
    else if (kind === 'stomp') { this.clap[0] = Math.max(this.clap[0], 7); this.clap[1] = Math.max(this.clap[1], 5); }
    else if (kind === 'walkout' || kind === 'kickoff') { this.sing = [10, 10]; this.clap = [6, 6]; }
    else if (kind === 'miss') this.miss[team] = 2.6;
    else if (kind === 'wave') this.startWave();
  }

  private startWave() {
    if (this.wave.on) return;
    this.wave = { on: true, a: Math.random() * Math.PI * 2, left: 1.5 * Math.PI * 2, k: 0 };
  }

  /** `calm` is true while play is quiet (no attack near either goal). */
  update(dt: number, calm: boolean) {
    const ease = (cur: number, want: number, rate: number) => cur + (want - cur) * Math.min(1, rate * dt);
    for (const [arr, key, rate] of [[this.sing, 'sing', 2.5], [this.clap, 'clap', 4], [this.miss, 'miss', 6]] as const) {
      for (const t of [0, 1]) {
        arr[t] = Math.max(0, arr[t] - dt);
        this.level[key][t] = ease(this.level[key][t], arr[t] > 0 ? 1 : 0, rate);
      }
    }
    moments.uSing.value.set(this.level.sing[0], this.level.sing[1]);
    moments.uClap.value.set(this.level.clap[0], this.level.clap[1]);
    moments.uMiss.value.set(this.level.miss[0], this.level.miss[1]);
    // The wave: starts in a quiet spell, goes round about one and a half times, then dies out.
    this.quiet = calm ? this.quiet + dt : 0;
    if (!this.wave.on && this.quiet > 25 && (this.nextWave -= dt) <= 0) { this.startWave(); this.nextWave = 180 + Math.random() * 180; }
    const w = this.wave;
    if (w.on) {
      const step = 0.62 * dt; // ~10 s a lap
      w.a = (w.a + step) % (Math.PI * 2);
      w.left -= step;
      w.k = ease(w.k, w.left > 1.2 ? 1 : 0, 1.2);
      if (w.left <= 0 && w.k < 0.02) w.on = false;
      moments.uWave.value.set(w.a, w.k);
    } else moments.uWave.value.set(0, 0);
  }

  /** For tests and screenshots. */
  get state() {
    return { wave: this.wave.on, sing: [...this.level.sing], clap: [...this.level.clap], miss: [...this.level.miss] };
  }
}
