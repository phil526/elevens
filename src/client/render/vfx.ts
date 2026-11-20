// Visual effects that sit on top of the stadium: match-time lighting looks, the colour grade,
// goal-net cloth, the ball trail and turf/dust particles. Everything here is cosmetic and
// reads only the ViewState the renderer already has, so it behaves the same online and offline.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import { canvasTex } from './textures';
import { CAS_GLSL } from './sharp';

export type MatchTime = 'day' | 'dusk' | 'night';

// ------------------------------------------------------------------ lighting looks

export interface LightingLook {
  sky: [number, string][];
  fog: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  sun: number;
  sunI: number;
  sunPos: [number, number, number];
  exposure: number;
  lamps: number; // floodlight panel brightness (0 = off)
  halo: number; // floodlight glow sprite opacity
  bloom: number;
  crossShadow: number; // opacity of the strongest of the four floodlight shadows under players
  glare: number; // lens glare (streak and ghosts) when the camera looks towards a floodlight
  pool: number; // brightening of the pitch under the floodlights
  env: number;
  grade: { lift: [number, number, number]; gain: [number, number, number]; sat: number; contrast: number; vignette: number };
}

export const LOOKS: Record<MatchTime, LightingLook> = {
  day: {
    sky: [[0, '#2c64ad'], [0.42, '#78aee3'], [0.6, '#d4e6f3'], [1, '#6d7b6c']],
    fog: 0x9fc4e4, fogNear: 220, fogFar: 560,
    hemiSky: 0xdfeeff, hemiGround: 0x3b5a31, hemi: 1.0,
    sun: 0xfff3e2, sunI: 2.7, sunPos: [-35, 95, 45],
    exposure: 1.0, lamps: 0, halo: 0, bloom: 0.1, crossShadow: 0, glare: 0, pool: 0, env: 0.25,
    grade: { lift: [0.0, 0.004, 0.012], gain: [1.02, 1.0, 0.98], sat: 0.95, contrast: 1.04, vignette: 0.25 },
  },
  dusk: {
    sky: [[0, '#0b1a33'], [0.45, '#27486f'], [0.62, '#e0a96d'], [1, '#3a3f45']],
    fog: 0x2a4566, fogNear: 170, fogFar: 430,
    hemiSky: 0xc4d8ff, hemiGround: 0x2f4a2a, hemi: 0.95,
    sun: 0xffcf9a, sunI: 2.1, sunPos: [-70, 55, 55],
    exposure: 1.05, lamps: 2.2, halo: 0.45, bloom: 0.2, crossShadow: 0.1, glare: 0.3, pool: 0.03, env: 0.22,
    grade: { lift: [0.012, 0.006, 0.02], gain: [1.04, 0.99, 0.95], sat: 0.93, contrast: 1.06, vignette: 0.35 },
  },
  night: {
    sky: [[0, '#020409'], [0.4, '#070d1c'], [0.6, '#1d2740'], [1, '#0c0e12']],
    fog: 0x0b1322, fogNear: 150, fogFar: 420,
    hemiSky: 0x9fb4dc, hemiGround: 0x1d2c1d, hemi: 0.45,
    sun: 0xeef3ff, sunI: 2.05, sunPos: [-10, 100, 30],
    exposure: 1.0, lamps: 6, halo: 0.85, bloom: 0.32, crossShadow: 0.3, glare: 0.8, pool: 0.07, env: 0.3,
    grade: { lift: [0.0, 0.0, 0.012], gain: [0.97, 1.0, 1.05], sat: 0.95, contrast: 1.14, vignette: 0.5 },
  },
};

export function skyTexture(stops: [number, string][]): THREE.CanvasTexture {
  return canvasTex(4, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256);
    for (const [o, c] of stops) grd.addColorStop(o, c);
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
  });
}

/** Soft round glow used for floodlight halos and particles. */
export function glowTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,250,235,0.55)');
    grd.addColorStop(1, 'rgba(255,245,220,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

/**
 * Where the floodlight comes from (x, z on the ground): the four corners of the lamp ring under
 * the roof (render/arena.ts puts the lamp banks about 61 m out along the ends and 45 m out along
 * the sides, 40 m up). The light ring runs all the way round, but the corners dominate the shadows.
 */
export const MASTS: [number, number][] = [];
for (const sx of [-1, 1]) for (const sz of [-1, 1]) MASTS.push([sx * 58, sz * 42]);

// ------------------------------------------------------------------ colour grade

/** Final grade in display space: contrast, saturation, lift/gain tint and a soft vignette. */
export const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uLift: { value: new THREE.Vector3() },
    uGain: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
    uAspect: { value: 1.78 },
    /** Sharper picture (render/sharp.ts): contrast-adaptive sharpening before the grade, 0 = off. */
    uSharp: { value: 0 },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uLift, uGain;
    uniform float uSat, uContrast, uVignette, uAspect, uSharp;
    uniform vec2 uTexel;
    varying vec2 vUv;
    ${CAS_GLSL}
    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = clamp(t.rgb, 0.0, 1.0);
      if (uSharp > 0.001) {
        c = casSharpen(c, clamp(texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb, 0.0, 1.0), clamp(texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb, 0.0, 1.0),
          clamp(texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb, 0.0, 1.0), clamp(texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb, 0.0, 1.0), uSharp);
      }
      c = (c - 0.5) * uContrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = c * uGain + uLift * (1.0 - c);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0) / max(1.0, uAspect) * 1.6;
      c *= 1.0 - uVignette * smoothstep(0.35, 1.05, dot(d, d));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), t.a);
    }`,
};

// ------------------------------------------------------------------ grass shader

export interface GrassUniforms {
  uPool: { value: number };
  uStripe: { value: number };
  /** Weather (render/weather.ts): 0 dry .. 1 soaked, 0 green .. 1 snow-covered, floodlight glints on wet grass. */
  uWet?: { value: number };
  uSnow?: { value: number };
  uGlint?: { value: number };
  /** Wear built up during the match (render/wear.ts): R scuffed, G mud; uAge 0..1 = how far into the match. */
  uWearMap?: { value: THREE.Texture };
  uWearOn?: { value: number };
  uAge?: { value: number };
  /** Mowing pattern (index into MOW_PATTERNS). */
  uMow?: { value: number };
  /** Footprints, slide tracks and torn turf (render/marks.ts): R pressed, G torn; texel size for relief. */
  uMarks?: { value: THREE.Texture };
  uMarksOn?: { value: number };
  uMarksTexel?: { value: THREE.Vector2 };
  /** Mirror image of the players, ball, floodlights and sky for a wet pitch (render/wet.ts; High and Ultra in rain). */
  uRefl?: { value: THREE.Texture };
  uReflMat?: { value: THREE.Matrix4 };
  uReflOn?: { value: number };
}

/** Mowing patterns the groundsman can cut (Settings > Graphics > Mowing; Random picks one each match). */
export const MOW_PATTERNS = ['stripes', 'checks', 'diagonal', 'diamonds', 'rings', 'wide'] as const;
export type MowPattern = (typeof MOW_PATTERNS)[number];
export type MowSetting = MowPattern | 'random';
export const MOW_NAMES: Record<MowPattern, string> = { stripes: 'Stripes', checks: 'Checks', diagonal: 'Diagonal', diamonds: 'Diamonds', rings: 'Rings', wide: 'Wide stripes' };

/**
 * GLSL: mowGrain(w, toCam, pattern) = how much lighter (+) or darker (-) the grass looks at pitch
 * point w for a camera in direction toCam. Each band is mown one way; the sign flips band to band
 * and the look strengthens when the camera looks along the cut. Shared with the 3D grass blades.
 */
export const MOW_GLSL = /* glsl */ `
float mowGrain(vec2 w, vec3 toCam, float pat) {
  vec2 m = w + vec2(${(PITCH.halfLength + 5).toFixed(1)}, ${(PITCH.halfWidth + 6).toFixed(1)});
  float bw = ${((2 * PITCH.halfLength + 10) / 18).toFixed(4)};
  float dir;
  float view = toCam.x;
  if (pat < 0.5) {
    dir = mod(floor(m.x / bw), 2.0) * 2.0 - 1.0;
  } else if (pat < 1.5) {
    // Checks: cut along the length, then across.
    float a = mod(floor(m.x / bw), 2.0), b = mod(floor(m.y / bw), 2.0);
    dir = abs(a - b) * 2.0 - 1.0;
    view = mix(toCam.x, toCam.z, b);
  } else if (pat < 2.5) {
    dir = mod(floor((m.x + m.y) / (bw * 1.1)), 2.0) * 2.0 - 1.0;
    view = (toCam.x + toCam.z) * 0.7071;
  } else if (pat < 3.5) {
    // Diamonds: two diagonal cuts crossing.
    float a = mod(floor((m.x + m.y) / (bw * 1.2)), 2.0), b = mod(floor((m.x - m.y) / (bw * 1.2)), 2.0);
    dir = abs(a - b) * 2.0 - 1.0;
    view = (toCam.x + (b * 2.0 - 1.0) * toCam.z) * 0.7071;
  } else if (pat < 4.5) {
    // Rings round the centre spot inside a band of stripes.
    float r = length(w);
    if (r < 20.0) { dir = mod(floor(r / 2.6), 2.0) * 2.0 - 1.0; view = dot(normalize(w + 1e-3), toCam.xz); }
    else dir = mod(floor(m.x / bw), 2.0) * 2.0 - 1.0;
  } else {
    // Wide and narrow stripes in turn.
    float c = mod(m.x, bw * 3.0);
    dir = c < bw * 2.0 ? 1.0 : -1.0;
  }
  return dir * (0.07 + 0.045 * view);
}
`;

const blankWear = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
blankWear.needsUpdate = true;

/**
 * Turns the grass texture into a mown pitch: stripes that brighten or darken with the viewing
 * angle (as real mowing does), a fine detail layer close to the camera so the grass never looks
 * smeared, worn patches in the goalmouths and centre circle, and light pools under the floodlights.
 */
export function grassMaterial(map: THREE.Texture, quality: number): { material: THREE.MeshStandardMaterial; uniforms: GrassUniforms } {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.92 });
  const uniforms: GrassUniforms = { uPool: { value: 0 }, uStripe: { value: 1 }, uWet: { value: 0 }, uSnow: { value: 0 }, uGlint: { value: 0 }, uWearMap: { value: blankWear }, uWearOn: { value: 0 }, uAge: { value: 0 }, uMow: { value: 0 }, uMarks: { value: blankWear }, uMarksOn: { value: 0 }, uMarksTexel: { value: new THREE.Vector2(1 / 1024, 1 / 680) }, uRefl: { value: blankWear }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 } };
  const detail = quality > 0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPool = uniforms.uPool;
    sh.uniforms.uStripe = uniforms.uStripe;
    sh.uniforms.uWet = uniforms.uWet!;
    sh.uniforms.uSnow = uniforms.uSnow!;
    sh.uniforms.uGlint = uniforms.uGlint!;
    sh.uniforms.uWearMap = uniforms.uWearMap!;
    sh.uniforms.uWearOn = uniforms.uWearOn!;
    sh.uniforms.uAge = uniforms.uAge!;
    sh.uniforms.uMow = uniforms.uMow!;
    sh.uniforms.uMarks = uniforms.uMarks!;
    sh.uniforms.uMarksOn = uniforms.uMarksOn!;
    sh.uniforms.uMarksTexel = uniforms.uMarksTexel!;
    sh.uniforms.uRefl = uniforms.uRefl!;
    sh.uniforms.uReflMat = uniforms.uReflMat!;
    sh.uniforms.uReflOn = uniforms.uReflOn!;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGrassW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGrassW;
uniform float uPool, uStripe, uWet, uSnow, uGlint, uWearOn, uAge, uMow, uMarksOn;
uniform sampler2D uWearMap, uMarks, uRefl;
uniform vec2 uMarksTexel;
uniform mat4 uReflMat;
uniform float uReflOn;
${MOW_GLSL}
float gPuddle, gMud;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 w = vGrassW.xz;
  // Mowing pattern: each band is mown the opposite way, so it looks lighter when the camera
  // looks along the grain and darker against it (MOW_GLSL: stripes, checks, diagonals, ...).
  vec3 toCam = normalize(cameraPosition - vGrassW);
  float grain = mowGrain(w, toCam, uMow);
  float n = gNoise(w * 0.35) * 0.6 + gNoise(w * 1.7) * 0.4;
  diffuseColor.rgb *= (1.0 + grain * uStripe) * (0.95 + 0.1 * n);
  ${detail ? `// Fine blade detail fades in near the camera.
  float camD = length(cameraPosition - vGrassW);
  float near = 1.0 - smoothstep(8.0, 45.0, camD);
  vec3 det = texture2D(map, vMapUv * 26.0).rgb / max(vec3(0.05), texture2D(map, vMapUv * 0.5).rgb);
  diffuseColor.rgb *= mix(vec3(1.0), clamp(det, 0.7, 1.35), near * 0.8);` : ''}
  // Wear: goalmouths, penalty spots and the centre circle.
  float wear = 0.0;
  for (int s = 0; s < 2; s++) {
    float gx = (s == 0 ? -1.0 : 1.0) * ${PITCH.halfLength.toFixed(1)};
    vec2 d = (w - vec2(gx - sign(gx) * 3.2, 0.0)) / vec2(4.2, 6.5);
    wear += exp(-dot(d, d) * 1.6) * 0.9;
    vec2 ps = (w - vec2(gx - sign(gx) * 11.0, 0.0)) / vec2(1.4, 1.4);
    wear += exp(-dot(ps, ps)) * 0.4;
  }
  vec2 cc = w / vec2(5.0, 4.0);
  wear += exp(-dot(cc, cc) * 1.6) * 0.18;
  // The worn areas spread a little as the match goes on.
  wear *= 1.0 + uAge * 0.45 * uWearOn;
  // Wear from this match's play: runs, turns, slides and dives (render/wear.ts).
  gMud = 0.0;
  if (uWearOn > 0.0) {
    vec2 wuv = (w + vec2(${(PITCH.halfLength + 4).toFixed(1)}, ${(PITCH.halfWidth + 4).toFixed(1)})) / vec2(${(2 * (PITCH.halfLength + 4)).toFixed(1)}, ${(2 * (PITCH.halfWidth + 4)).toFixed(1)});
    vec4 wm = texture2D(uWearMap, wuv);
    // Broken up by noise so scuffs read as torn turf, not smooth blobs (only where there is wear).
    if (wm.r + wm.g > 0.004) {
      float br = gNoise(w * 3.1) * 0.7 + n * 0.3;
      wear += wm.r * (0.55 + 0.9 * br) * uWearOn;
      gMud = clamp(wm.g * (0.6 + 0.8 * br), 0.0, 1.0) * uWearOn;
    }
  }
  wear *= smoothstep(0.15, 0.6, gNoise(w * 1.3) * 0.7 + gNoise(w * 4.0) * 0.3 + wear * 0.5);
  vec3 soil = vec3(0.36, 0.33, 0.2) * (0.8 + 0.3 * n);
  diffuseColor.rgb = mix(diffuseColor.rgb, soil * dot(diffuseColor.rgb, vec3(0.6)) * 2.2, clamp(wear, 0.0, 0.72));
  // Churned mud: dark, brown and (below) glossy.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.15, 0.09) * (0.7 + 0.6 * gNoise(w * 5.0)), clamp(gMud * 1.2, 0.0, 0.8));
  // Marks from this match (render/marks.ts): turf torn up by slides and divots, boot prints in mud.
  vec4 gMk = vec4(0.0);
  vec2 muv = (w + vec2(${(PITCH.halfLength + 4).toFixed(1)}, ${(PITCH.halfWidth + 4).toFixed(1)})) / vec2(${(2 * (PITCH.halfLength + 4)).toFixed(1)}, ${(2 * (PITCH.halfWidth + 4)).toFixed(1)});
  if (uMarksOn > 0.0) gMk = texture2D(uMarks, muv);
  if (gMk.g > 0.004) {
    float tn = gNoise(w * 13.0) * 0.6 + gNoise(w * 37.0) * 0.4;
    float torn = clamp(gMk.g * (0.7 + 0.6 * tn), 0.0, 1.0);
    // Flattened, scraped grass round the edge of the gouge; dark soil where the turf is ripped out.
    float rim = smoothstep(0.03, 0.22, gMk.g) * (1.0 - smoothstep(0.3, 0.65, gMk.g));
    diffuseColor.rgb *= 1.0 + rim * 0.16;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.12, 0.07) * (0.7 + 0.55 * tn), smoothstep(0.28, 0.7, torn) * 0.92 * (1.0 - 0.6 * min(1.0, uSnow * 3.0)));
    gMud = max(gMud, smoothstep(0.3, 0.8, torn) * uWet);
  }
  // Boot prints show in mud.
  diffuseColor.rgb *= 1.0 - clamp(gMk.r, 0.0, 1.0) * gMud * 0.45;
  // Floodlight pools: a little brighter under each bank of lights.
  float pool = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 m = vec2(i < 2 ? -1.0 : 1.0, mod(float(i), 2.0) < 0.5 ? -1.0 : 1.0) * vec2(${(PITCH.halfLength - 14).toFixed(1)}, ${(PITCH.halfWidth - 10).toFixed(1)});
    vec2 dd = (w - m) / 30.0;
    pool += exp(-dot(dd, dd));
  }
  diffuseColor.rgb *= 1.0 + uPool * (pool - 0.6);
  // Rain: darker, richer grass, with standing water where the pitch is worn.
  // (Both only cost anything when it is raining or snowing: the noise is skipped on a dry pitch.)
  gPuddle = 0.0;
  if (uWet > 0.0) {
    gPuddle = uWet * smoothstep(0.55, 0.8, gNoise(w * 0.22) * 0.6 + gNoise(w * 0.9) * 0.25 + wear * 0.5);
    diffuseColor.rgb *= 1.0 - uWet * 0.3 - gPuddle * 0.35;
  }
  // Snow: settles in drifts first, then covers all but the worn goalmouths.
  if (uSnow > 0.0) {
    float drift = gNoise(w * 0.18) * 0.55 + gNoise(w * 1.1) * 0.3 + gNoise(w * 6.0) * 0.15;
    // Never a white sheet: trodden, swept patches keep showing the grass through.
    float snowK = smoothstep(0.0, 0.3, uSnow + drift - 1.05 - wear * 0.9) * min(1.0, uSnow * 3.0);
    vec3 snowC = vec3(0.74, 0.77, 0.82) * (0.9 + 0.14 * drift);
    if (gMk.r + gMk.g > 0.004) {
      // Footprints and tracks pressed into the snow: compacted (greyer) and shaded as dents, and
      // slides and heavy trampling scrape it down to the grass.
      float rx = texture2D(uMarks, muv + vec2(uMarksTexel.x, 0.0)).r - texture2D(uMarks, muv - vec2(uMarksTexel.x, 0.0)).r;
      float rz = texture2D(uMarks, muv + vec2(0.0, uMarksTexel.y)).r - texture2D(uMarks, muv - vec2(0.0, uMarksTexel.y)).r;
      float pressed = clamp(gMk.r, 0.0, 1.0);
      snowC *= (1.0 - pressed * 0.3) * (1.0 + clamp(rx * 0.4 - rz * 0.55, -0.3, 0.25));
      snowC = mix(snowC, snowC * vec3(0.86, 0.9, 1.0), pressed * 0.5);
      snowK *= 1.0 - clamp(gMk.g * 1.4, 0.0, 0.92) - smoothstep(0.85, 1.0, pressed) * 0.18;
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, snowC, snowK * 0.88);
  }
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.55, uWet);
  roughnessFactor = mix(roughnessFactor, 0.32, gPuddle);
  roughnessFactor = mix(roughnessFactor, 0.4, gMud * uWet);`)
      .replace('#include <opaque_fragment>', `{
  // Floodlights mirrored in the wet surface: soft glints that slide with the camera.
  if (uWet * uGlint > 0.001) {
    vec3 Vw = normalize(cameraPosition - vGrassW);
    vec2 rip = vec2(gNoise(vGrassW.xz * 0.7) - 0.5, gNoise(vGrassW.xz * 0.7 + 17.0) - 0.5) * (0.07 - 0.055 * gPuddle / max(uWet, 0.001)) + vec2(gNoise(vGrassW.xz * 4.0) - 0.5, 0.0) * 0.012;
    vec3 Nw = normalize(vec3(rip.x, 1.0, rip.y));
    vec3 R = reflect(-Vw, Nw);
    float g = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 Lp = vec3(i < 2 ? -1.0 : 1.0, 0.0, mod(float(i), 2.0) < 0.5 ? -1.0 : 1.0) * vec3(58.0, 0.0, 42.0) + vec3(0.0, 40.0, 0.0);
      vec3 Ld = normalize(Lp - vGrassW);
      vec3 a = R - Ld;
      // Stretched vertically on screen, as reflections on a rough wet surface are.
      g += exp(-(a.x * a.x + a.z * a.z) * 140.0 - a.y * a.y * 22.0);
    }
    outgoingLight += vec3(1.0, 0.96, 0.88) * min(g, 1.5) * uGlint * (uWet * 0.7 + gPuddle * 2.6) * (1.0 - 0.45 * uReflOn);
  }
  // The pitch as a wet mirror (High and Ultra): players, ball, floodlights and sky, blurred by the
  // wet grass and sharper in the puddles, broken up by raindrops landing.
  if (uReflOn * uWet > 0.001) {
    vec3 Vw = normalize(cameraPosition - vGrassW);
    float fres = 0.05 + 0.95 * pow(1.0 - clamp(Vw.y, 0.0, 1.0), 5.0);
    float k = clamp((uWet * 0.5 + gPuddle * 2.2) * (0.3 + fres * 1.6), 0.0, 0.8) * (1.0 - gMud * 0.4);
    if (k > 0.002) {
      float sharp = clamp(gPuddle / max(uWet, 0.001), 0.0, 1.0);
      vec2 rip = vec2(gNoise(vGrassW.xz * 1.3) - 0.5, gNoise(vGrassW.xz * 1.3 + 9.0) - 0.5) * mix(0.3, 0.05, sharp);
      // Smeared towards the camera, as reflections in a wet, uneven surface are (vertical streaks).
      vec2 toward = normalize(Vw.xz + vec2(1e-4, 0.0)) * mix(0.55, 0.12, sharp);
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 4; i++) {
        vec2 o = rip + toward * (float(i) - 1.5);
        vec4 rc = uReflMat * vec4(vGrassW.x + o.x, 0.0, vGrassW.z + o.y, 1.0);
        acc += min(texture2D(uRefl, rc.xy / rc.w).rgb, vec3(0.9));
      }
      outgoingLight += acc * 0.25 * k * uReflOn;
    }
  }
}
#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `grass-${detail}`;
  return { material: m, uniforms };
}

// ------------------------------------------------------------------ goal nets

/**
 * One panel of goal net as a grid of points that can move along the panel's normal.
 * The edges are tied to the frame; the inside behaves like a damped membrane, so a shot
 * that hits it makes a bulge that ripples out and settles.
 */
/** Goal-net cloth: how hard a shot pushes it, how wide the bulge spreads and how slowly it settles. */
export const NET = { push: 0.27, spread: 0.38, spreadMax: 0.42, spreadPer: 0.017, spring: 19, damp: 4.4, maxOut: 1.1 } as const;

export class NetPanel {
  mesh: THREE.Mesh;
  private base: Float32Array;
  private d: Float32Array;
  private v: Float32Array;
  private pos: THREE.BufferAttribute;
  private uvw: Float32Array; // panel-space (u metres, v metres) per vertex
  private active = false;
  private cool = 0;
  constructor(
    private origin: THREE.Vector3,
    private U: THREE.Vector3, // unit vector along the panel's width
    private V: THREE.Vector3, // unit vector along its height
    private N: THREE.Vector3, // unit outward normal (out of the goal)
    private w: number,
    private hAt: (u: number) => number, // panel height at u (0..1)
    private nu: number,
    private nv: number,
    material: THREE.Material,
  ) {
    const cnt = (nu + 1) * (nv + 1);
    this.base = new Float32Array(cnt * 3);
    this.d = new Float32Array(cnt);
    this.v = new Float32Array(cnt);
    this.uvw = new Float32Array(cnt * 2);
    const uv = new Float32Array(cnt * 2);
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const k = j * (nu + 1) + i;
      const u = i / nu, um = u * w, vm = (j / nv) * hAt(u);
      const p = origin.clone().addScaledVector(U, um).addScaledVector(V, vm);
      this.base.set([p.x, p.y, p.z], k * 3);
      this.uvw[k * 2] = um;
      this.uvw[k * 2 + 1] = vm;
      uv[k * 2] = um;
      uv[k * 2 + 1] = vm;
    }
    const idx: number[] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, e = c + 1;
      idx.push(a, b, e, a, e, c);
    }
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(this.base.slice(), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.mesh = new THREE.Mesh(g, material);
  }

  /** Ball contact: compare this frame's velocity with last frame's along the normal. */
  touch(p: THREE.Vector3, vel: THREE.Vector3, prevVel: THREE.Vector3, radius: number) {
    const rel = p.clone().sub(this.origin);
    const dist = rel.dot(this.N);
    if (Math.abs(dist) > radius + 0.5) return;
    const u = rel.dot(this.U), v = rel.dot(this.V);
    if (u < -0.3 || u > this.w + 0.3 || v < -0.3 || v > this.hAt(Math.min(1, Math.max(0, u / this.w))) + 0.3) return;
    const before = prevVel.dot(this.N), after = vel.dot(this.N);
    // A hit reverses (or kills) the ball's motion into the net.
    const hit = Math.abs(before) > 1.2 && Math.sign(before) !== Math.sign(after || -before) ? before : 0;
    if (!hit || this.cool > 0) return;
    this.cool = 0.12;
    // A wide, deep bulge (NET.push): a hard shot balloons the net out behind the goal.
    const sigma2 = 2 * (NET.spread + Math.min(NET.spreadMax, Math.abs(hit) * NET.spreadPer)) ** 2;
    for (let k = 0; k < this.d.length; k++) {
      const du = this.uvw[k * 2] - u, dv = this.uvw[k * 2 + 1] - v;
      const f = Math.exp(-(du * du + dv * dv) / sigma2);
      if (f < 0.01) continue;
      this.v[k] += hit * NET.push * f;
    }
    this.active = true;
  }

  step(dt: number) {
    this.cool -= dt;
    if (!this.active) return;
    const { nu, nv, d, v } = this;
    const hu = this.w / nu;
    const sub = 2, h = Math.min(dt, 1 / 30) / sub;
    let energy = 0;
    for (let s = 0; s < sub; s++) {
      for (let j = 1; j < nv; j++) {
        const hv = this.hAt(0.5) / nv;
        for (let i = 1; i < nu; i++) {
          const k = j * (nu + 1) + i;
          const lap = (d[k - 1] + d[k + 1] - 2 * d[k]) / (hu * hu) + (d[k - nu - 1] + d[k + nu + 1] - 2 * d[k]) / (hv * hv);
          v[k] += (6 * lap - NET.spring * d[k] - NET.damp * v[k]) * h;
        }
      }
      for (let k = 0; k < d.length; k++) {
        d[k] = Math.max(-0.5, Math.min(NET.maxOut, d[k] + v[k] * h));
      }
    }
    // Edges stay on the frame.
    for (let i = 0; i <= nu; i++) { d[i] = v[i] = 0; d[nv * (nu + 1) + i] = v[nv * (nu + 1) + i] = 0; }
    for (let j = 0; j <= nv; j++) { d[j * (nu + 1)] = v[j * (nu + 1)] = 0; d[j * (nu + 1) + nu] = v[j * (nu + 1) + nu] = 0; }
    const arr = this.pos.array as Float32Array;
    for (let k = 0; k < d.length; k++) {
      energy += Math.abs(d[k]) + Math.abs(v[k]);
      arr[k * 3] = this.base[k * 3] + this.N.x * d[k];
      arr[k * 3 + 1] = this.base[k * 3 + 1] + this.N.y * d[k];
      arr[k * 3 + 2] = this.base[k * 3 + 2] + this.N.z * d[k];
    }
    this.pos.needsUpdate = true;
    if (energy < 1e-3 * d.length) {
      d.fill(0); v.fill(0);
      arr.set(this.base);
      this.active = false;
    }
  }
}

// ------------------------------------------------------------------ ball trail

/** A short fading ribbon behind fast balls (shots, driven passes, long balls). */
export class BallTrail {
  mesh: THREE.Mesh;
  private pts: { p: THREE.Vector3; t: number; s: number }[] = [];
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private static N = 28;
  private static LIFE = 0.32;
  private rgb: [number, number, number] = [1, 1, 0.97];
  /** Trail colour (null: the usual white). */
  tint(c: number | null) {
    this.rgb = c == null ? [1, 1, 0.97] : [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
  }
  constructor() {
    const n = BallTrail.N;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(n * 2 * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** strength 0..1: how visible the trail should be at this ball speed. */
  update(time: number, ballPos: THREE.Vector3, strength: number, cam: THREE.Vector3, radius: number, reset: boolean) {
    if (reset) this.pts.length = 0;
    this.pts.unshift({ p: ballPos.clone(), t: time, s: strength });
    while (this.pts.length > BallTrail.N || (this.pts.length && time - this.pts[this.pts.length - 1].t > BallTrail.LIFE)) this.pts.pop();
    const pa = this.pos.array as Float32Array, ca = this.col.array as Float32Array;
    const n = this.pts.length;
    let any = false;
    const side = new THREE.Vector3(), tan = new THREE.Vector3(), view = new THREE.Vector3();
    for (let i = 0; i < BallTrail.N; i++) {
      const q = this.pts[Math.min(i, n - 1)];
      if (!q) { ca.fill(0); break; }
      const a = i < n ? 1 - (time - q.t) / BallTrail.LIFE : 0;
      const j = Math.min(i, n - 1);
      const prev = this.pts[Math.max(0, j - 1)].p, next = this.pts[Math.min(n - 1, j + 1)].p;
      tan.subVectors(prev, next);
      view.subVectors(cam, q.p);
      side.crossVectors(tan, view);
      if (side.lengthSq() < 1e-8) side.set(0, 1, 0);
      side.normalize().multiplyScalar(radius * 0.9 * Math.max(0, a) * (0.4 + 0.6 * (1 - i / BallTrail.N)));
      pa.set([q.p.x + side.x, q.p.y + side.y, q.p.z + side.z, q.p.x - side.x, q.p.y - side.y, q.p.z - side.z], i * 6);
      const alpha = Math.max(0, a) ** 1.4 * q.s * 0.55;
      if (alpha > 0.01) any = true;
      const [r, g, b] = this.rgb;
      ca.set([r, g, b, alpha, r, g, b, alpha], i * 8);
    }
    this.mesh.visible = any;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ particles

const PART_VS = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uScale;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const PART_FS = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.15, length(c));
    if (a * vColor.a < 0.01) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * a);
    #include <colorspace_fragment>
  }`;

export interface Particle { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; size: number; grow: number; r: number; g: number; b: number; a: number; drag: number; grav: number }

/** Pooled point sprites: grass cuttings, soil and dust kicked up by the ball. */
export class Particles {
  points: THREE.Points;
  private ps: Particle[] = [];
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private size: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  constructor(private cap = 320) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
    this.size = new THREE.BufferAttribute(new Float32Array(cap), 1);
    for (const a of [this.pos, this.col, this.size]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aSize', this.size);
    this.mat = new THREE.ShaderMaterial({ vertexShader: PART_VS, fragmentShader: PART_FS, uniforms: { uScale: { value: 600 } }, transparent: true, depthWrite: false });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  setScale(viewportHeightPx: number, fovDeg: number) {
    this.mat.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  /** Grass and soil thrown up where the ball is struck or lands. power ~ 0..1. */
  turf(x: number, z: number, dirX: number, dirZ: number, power: number, rnd = Math.random) {
    const n = Math.round(6 + power * 18);
    for (let i = 0; i < n; i++) {
      const soil = rnd() < 0.25;
      const sp = (0.8 + rnd() * 2.6) * (0.5 + power);
      const a = rnd() * Math.PI * 2;
      this.add({
        x: x + (rnd() - 0.5) * 0.2, y: 0.04, z: z + (rnd() - 0.5) * 0.2,
        vx: Math.cos(a) * sp * 0.5 + dirX * sp * 0.5, vy: 1.2 + rnd() * 2.5 * (0.4 + power), vz: Math.sin(a) * sp * 0.5 + dirZ * sp * 0.5,
        life: 0, max: 0.5 + rnd() * 0.5, size: 0.035 + rnd() * 0.04, grow: 0,
        r: soil ? 0.3 : 0.2 + rnd() * 0.1, g: soil ? 0.24 : 0.42 + rnd() * 0.15, b: soil ? 0.14 : 0.12, a: 0.95, drag: 1.2, grav: 9.8,
      });
    }
    // A low puff of dust that spreads and fades.
    for (let i = 0; i < Math.round(2 + power * 4); i++) {
      this.add({
        x: x + (rnd() - 0.5) * 0.3, y: 0.08, z: z + (rnd() - 0.5) * 0.3,
        vx: (rnd() - 0.5) * 0.8 + dirX * 0.6, vy: 0.2 + rnd() * 0.3, vz: (rnd() - 0.5) * 0.8 + dirZ * 0.6,
        life: 0, max: 0.7 + rnd() * 0.5, size: 0.25 + rnd() * 0.2, grow: 0.9, r: 0.62, g: 0.64, b: 0.5, a: 0.22 * (0.4 + power), drag: 2.5, grav: -0.1,
      });
    }
  }

  /** Water thrown up off a wet pitch (rain) or powder off snow, where the ball is struck or lands. */
  spray(x: number, z: number, dirX: number, dirZ: number, power: number, snow = false, rnd = Math.random) {
    const n = Math.round(8 + power * 22);
    for (let i = 0; i < n; i++) {
      const sp = (1 + rnd() * 3) * (0.5 + power);
      const a = rnd() * Math.PI * 2;
      this.add({
        x: x + (rnd() - 0.5) * 0.25, y: 0.05, z: z + (rnd() - 0.5) * 0.25,
        vx: Math.cos(a) * sp * 0.6 + dirX * sp * 0.6, vy: 0.8 + rnd() * 2.2 * (0.4 + power), vz: Math.sin(a) * sp * 0.6 + dirZ * sp * 0.6,
        life: 0, max: 0.35 + rnd() * 0.4, size: snow ? 0.05 + rnd() * 0.05 : 0.025 + rnd() * 0.03, grow: snow ? 1.5 : 0.2,
        r: 0.86, g: 0.9, b: 0.95, a: snow ? 0.8 : 0.6, drag: snow ? 3 : 1.4, grav: snow ? 3 : 9.8,
      });
    }
  }

  /** Add one particle (oldest dropped when the pool is full). */
  add(p: Particle) {
    if (this.ps.length >= this.cap) this.ps.shift();
    this.ps.push(p);
  }

  update(dt: number) {
    const pa = this.pos.array as Float32Array, ca = this.col.array as Float32Array, sa = this.size.array as Float32Array;
    this.ps = this.ps.filter((p) => (p.life += dt) < p.max);
    this.ps.forEach((p, i) => {
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k; p.vy = p.vy * k - p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy = 0; p.vx *= 0.5; p.vz *= 0.5; }
      const f = p.life / p.max;
      pa[i * 3] = p.x; pa[i * 3 + 1] = p.y; pa[i * 3 + 2] = p.z;
      ca.set([p.r, p.g, p.b, p.a * (1 - f * f)], i * 4);
      sa[i] = p.size * (1 + p.grow * f);
    });
    this.points.geometry.setDrawRange(0, this.ps.length);
    this.points.visible = this.ps.length > 0;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ floodlight shadows

/** Height of the floodlight banks above the pitch (metres), for shadow lengths. */
export const LAMP_HEIGHT = 40;

/**
 * Shadow of a player from one mast: it points away from the mast, gets longer the further away
 * the mast is (the light comes in lower), and is darkest from the nearest mast.
 */
export function crossShadowFor(px: number, pz: number, mx: number, mz: number, nearest: number): { angle: number; len: number; alpha: number } {
  const dx = px - mx, dz = pz - mz;
  const dist = Math.hypot(dx, dz);
  return {
    angle: Math.atan2(dz, dx),
    len: Math.min(6.5, Math.max(1.2, (1.85 * dist) / LAMP_HEIGHT)),
    alpha: Math.max(0.35, Math.min(1, (nearest / Math.max(dist, 1)) ** 1.3)),
  };
}

/**
 * Under floodlights every player casts four shadows, one away from each mast: dark and short
 * from the nearest mast, longer and fainter from the far ones. Drawn as one instanced mesh of
 * soft tapered shapes (one draw call for all 88) with a strength per shadow.
 */
export class CrossShadows {
  mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private alpha: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  constructor(count: number) {
    // A body-shaped shadow: narrow at the feet, wider at the shoulders, soft head at the end.
    const tex = canvasTex(128, 32, (g) => {
      const img = g.createImageData(128, 32);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) {
        const u = x / 127, v = (y - 15.5) / 15.5;
        const width = 0.28 + 0.55 * Math.sin(Math.min(1, u * 1.25) * Math.PI * 0.62) - (u > 0.82 ? (u - 0.82) * 2.2 : 0);
        const edge = Math.max(0, 1 - Math.abs(v) / Math.max(0.05, width));
        const a = Math.min(1, edge * 2.2) * Math.min(1, u * 10) * Math.max(0, 1 - Math.max(0, u - 0.9) * 10) * (1 - u * 0.45);
        img.data.set([0, 0, 0, Math.round(a * 255)], (y * 128 + x) * 4);
      }
      g.putImageData(img, 0, 0);
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0.5, 0, 0); // starts at the feet and stretches away
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(count * MASTS.length), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, uOpacity: { value: 0.1 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying vec2 vUv;
        varying float vA;
        void main() {
          vUv = uv; vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vA;
        void main() {
          float a = texture2D(map, vec2(vUv.x, 1.0 - vUv.y)).a * uOpacity * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count * MASTS.length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(players: { x: number; z: number; visible: boolean }[], opacity: number) {
    this.mat.uniforms.uOpacity.value = opacity;
    this.mesh.visible = opacity > 0;
    if (!this.mesh.visible) return;
    let k = 0;
    const al = this.alpha.array as Float32Array;
    for (const pl of players) {
      let nearest = Infinity;
      for (const [mx, mz] of MASTS) nearest = Math.min(nearest, Math.hypot(pl.x - mx, pl.z - mz));
      for (const [mx, mz] of MASTS) {
        const sh = crossShadowFor(pl.x, pl.z, mx, mz, nearest);
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -sh.angle);
        this.s.set(pl.visible ? sh.len : 0, 1, pl.visible ? 0.62 : 0);
        this.p.set(pl.x, 0.018, pl.z);
        this.m.compose(this.p, this.q, this.s);
        al[k] = sh.alpha;
        this.mesh.setMatrixAt(k++, this.m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ floodlight glare

/**
 * Lens glare from the floodlights, as a broadcast camera sees them at night: a horizontal streak
 * through each lamp bank in view and a few faint coloured ghosts mirrored through the middle of
 * the picture. Sprites drawn over the scene (no extra pass), strongest when a lamp is near the
 * centre of the shot.
 */
export class FloodGlare {
  readonly group = new THREE.Group();
  private lamps: THREE.Vector3[] = [];
  private items: { streak: THREE.Sprite; ghosts: THREE.Sprite[] }[] = [];
  private static GHOSTS: [number, number, number][] = [[0.3, 0.05, 0x9fd0ff], [0.62, 0.09, 0xffd59a], [0.8, 0.035, 0xb8ffcf], [1.15, 0.14, 0x9fb4ff]];
  private ndc = new THREE.Vector3();
  constructor() {
    this.group.renderOrder = 20;
  }

  /** The lamp banks (world positions), one glare each. */
  setLamps(lamps: THREE.Vector3[]) {
    this.group.clear();
    this.items = [];
    this.lamps = lamps.map((l) => l.clone());
    const streakTex = canvasTex(256, 16, (g) => {
      const grd = g.createLinearGradient(0, 0, 256, 0);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 256, 16);
      const v = g.createLinearGradient(0, 0, 0, 16);
      v.addColorStop(0, 'rgba(0,0,0,1)');
      v.addColorStop(0.5, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = v;
      g.fillRect(0, 0, 256, 16);
    });
    const ghostTex = canvasTex(64, 64, (g) => {
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,0.15)');
      grd.addColorStop(0.75, 'rgba(255,255,255,0.35)');
      grd.addColorStop(0.92, 'rgba(255,255,255,0.12)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    });
    const mk = (map: THREE.Texture, colour: number) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: colour, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, opacity: 0 }));
      sp.renderOrder = 20;
      sp.visible = false;
      this.group.add(sp);
      return sp;
    };
    for (let i = 0; i < this.lamps.length; i++) this.items.push({ streak: mk(streakTex, 0xd8e8ff), ghosts: FloodGlare.GHOSTS.map(([, , c]) => mk(ghostTex, c)) });
  }

  /** strength 0..1 (from the lighting look); hidden while 0. */
  update(cam: THREE.PerspectiveCamera, strength: number) {
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    // First how strongly each lamp bank glares (in shot, nearer the middle = stronger) ...
    const ks = this.lamps.map((lamp) => {
      if (strength <= 0) return { k: 0, x: 0, y: 0 };
      this.ndc.copy(lamp).project(cam);
      const inFront = lamp.clone().sub(cam.position).dot(fwd) > 0;
      const off = Math.max(Math.abs(this.ndc.x), Math.abs(this.ndc.y));
      const k = inFront && off < 1.1 ? strength * Math.min(1, (1.1 - off) / 0.3) * (1 - 0.4 * Math.min(1, Math.hypot(this.ndc.x, this.ndc.y))) : 0;
      return { k, x: this.ndc.x, y: this.ndc.y };
    });
    // ... then share it out, so a whole row of banks in shot doesn't white the picture out.
    const total = ks.reduce((a, b) => a + b.k, 0);
    const share = total > 1 ? 1 / Math.sqrt(total) : 1;
    this.lamps.forEach((lamp, i) => {
      const it = this.items[i];
      const { k: k0, x, y } = ks[i];
      const k = k0 * share;
      it.streak.visible = k > 0.01;
      for (const g of it.ghosts) g.visible = k > 0.01;
      if (k <= 0.01) return;
      // The streak sits on the lamp, sized as a share of the picture so it reads the same at any distance.
      const h = 2 * lamp.distanceTo(cam.position) * tanH;
      it.streak.position.copy(lamp);
      it.streak.scale.set(h * 0.55 * cam.aspect, h * 0.016, 1);
      (it.streak.material as THREE.SpriteMaterial).opacity = Math.min(0.9, k * 0.85);
      // Ghosts on the line from the lamp through the middle of the picture, just in front of the camera.
      const near = 6, hn = 2 * near * tanH;
      FloodGlare.GHOSTS.forEach(([t, size], j) => {
        const g = it.ghosts[j];
        const v = new THREE.Vector3(x * (1 - 2 * t), y * (1 - 2 * t), 0.5).unproject(cam).sub(cam.position).normalize();
        g.position.copy(cam.position).addScaledVector(v, near / Math.max(0.2, v.dot(fwd)));
        g.scale.setScalar(hn * size);
        (g.material as THREE.SpriteMaterial).opacity = k * 0.26;
      });
    });
  }
}
