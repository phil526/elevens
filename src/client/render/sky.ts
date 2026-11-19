// A living sky over the stadium: the match time's gradient, clouds that drift across it, a
// low sun that sets during a dusk match (the sky deepens towards night by full time), and
// twinkling stars and a moon on a night match. One shader on the sky dome; Low skips the clouds,
// Medium uses three noise layers and High and Ultra five.

import * as THREE from 'three';
import type { LightingLook, MatchTime } from './vfx';
import type { Weather } from './weather';

/** How cloudy each match time is in clear weather, and in rain or snow (overcast). */
export const CLOUD_COVER: Record<MatchTime, number> = { day: 0.42, dusk: 0.5, night: 0.32 };
export const OVERCAST = { rain: 0.86, snow: 0.8 } as const;

/** Where the sun sits for the sky (not the shadows): high by day, on the horizon at dusk. */
export function skySun(time: MatchTime, sunPos: [number, number, number], set = 0): THREE.Vector3 {
  const az = Math.atan2(sunPos[2], sunPos[0]);
  // Dusk: about 7 degrees up at kick-off, just below the horizon at full time.
  const el = time === 'day' ? 0.95 : time === 'dusk' ? 0.12 - 0.19 * set : -0.4;
  return new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
}

const VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always on the far plane
}`;

const FS = /* glsl */ `
uniform vec3 uC0, uC1, uC2, uC3;
uniform vec4 uStops;
uniform vec3 uNight0, uNight1, uNight2;
uniform float uTime, uCover, uSet, uStars, uMoon, uSunVis, uLit, uDark;
uniform vec3 uSun, uSunCol, uCloudLit, uCloudShade, uMoonDir;
uniform vec2 uWind;
varying vec3 vDir;
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), f.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < OCTAVES; i++) { s += a * sNoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
vec3 grad(float t) {
  vec3 c = mix(uC0, uC1, smoothstep(uStops.x, uStops.y, t));
  c = mix(c, uC2, smoothstep(uStops.y, uStops.z, t));
  return mix(c, uC3, smoothstep(uStops.z, uStops.w, t));
}
void main() {
  vec3 d = normalize(vDir);
  float t = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  vec3 col = grad(t);
  // Dusk: the sky deepens towards night as the sun goes down.
  vec3 nightCol = mix(uNight0, uNight1, smoothstep(0.0, 0.42, t));
  nightCol = mix(nightCol, uNight2, smoothstep(0.42, 0.62, t));
  col = mix(col, nightCol, uDark);
  float up = max(d.y, 0.0);
  // The sun: a warm glow along the horizon on its side of the sky, a disc and a halo.
  float sd = max(dot(d, uSun), 0.0);
  float horizon = exp(-abs(d.y) * 9.0);
  col += uSunCol * (pow(sd, 6.0) * 0.35 * horizon + pow(sd, 60.0) * 0.6 + smoothstep(0.9993, 0.99965, sd) * 3.0) * uSunVis;
  // Stars (night, and once a dusk sun has gone): a fixed field that twinkles, thinning towards the horizon.
  if (uStars > 0.01 && d.y > 0.02) {
    vec2 sp = vec2(atan(d.z, d.x) * 120.0, d.y * 190.0);
    vec2 cell = floor(sp);
    float h = sHash(cell);
    if (h > 0.965) {
      vec2 o = vec2(sHash(cell + 3.1), sHash(cell + 7.7)) * 0.6 + 0.2;
      float r = length(fract(sp) - o);
      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 4.0) + h * 60.0);
      col += vec3(0.85, 0.9, 1.0) * smoothstep(0.32, 0.0, r) * (h - 0.965) * 30.0 * tw * uStars * smoothstep(0.02, 0.25, d.y);
    }
  }
  // The moon on a clear night.
  if (uMoon > 0.01) {
    float md = dot(d, uMoonDir);
    col += vec3(0.95, 0.96, 1.0) * (smoothstep(0.99955, 0.9997, md) * 1.6 + pow(max(md, 0.0), 300.0) * 0.12) * uMoon;
  }
#if CLOUDS
  // Clouds on a plane overhead, drifting with the wind; thicker towards the horizon (perspective).
  if (d.y > -0.02) {
    vec2 p = d.xz / (d.y + 0.08) * 0.55 + uWind;
    float n = fbm(p * 0.9);
    float cov = smoothstep(1.0 - uCover, 1.0 - uCover + 0.32, n + 0.12 * sNoise(p * 4.0));
    float thick = smoothstep(0.35, 0.9, n);
    // Lit edges on the sun's side; floodlight glow from below on dusk and night clouds.
    float toward = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-4), normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-4)), 0.0), 3.0);
    vec3 cc = mix(uCloudShade, uCloudLit, clamp((1.0 - thick) * 0.7 + toward * 0.5 * uSunVis, 0.0, 1.0));
    cc += vec3(1.0, 0.85, 0.62) * uLit * (1.0 - smoothstep(0.0, 0.35, d.y)) * 0.25;
    float fade = smoothstep(-0.02, 0.12, d.y);
    col = mix(col, cc, cov * fade * 0.92);
  }
#endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const lin = (hex: string | number) => new THREE.Color(hex);

export class Sky {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  private look: MatchTime = 'dusk';
  private sunPos: [number, number, number] = [-70, 55, 55];
  private cover = 0.5;

  constructor(quality = 1) {
    this.u = {
      uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() },
      uStops: { value: new THREE.Vector4(0, 0.45, 0.62, 1) },
      uNight0: { value: lin('#03060d') }, uNight1: { value: lin('#0a1226') }, uNight2: { value: lin('#232a3c') },
      uTime: { value: 0 }, uCover: { value: 0.5 }, uSet: { value: 0 }, uStars: { value: 0 }, uMoon: { value: 0 }, uSunVis: { value: 1 }, uLit: { value: 0 }, uDark: { value: 0 },
      uSun: { value: new THREE.Vector3(0, 0.1, 1) }, uSunCol: { value: new THREE.Color(1, 0.6, 0.3) },
      uCloudLit: { value: new THREE.Color(1, 1, 1) }, uCloudShade: { value: new THREE.Color(0.5, 0.55, 0.6) },
      uMoonDir: { value: new THREE.Vector3(0.45, 0.42, -0.79).normalize() },
      uWind: { value: new THREE.Vector2(0, 0) }, // drifted cloud offset
    };
    const m = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.u, side: THREE.BackSide, depthWrite: false, depthTest: true });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 20), m);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';
    this.setQuality(quality);
  }

  setQuality(q: number) {
    const m = this.mesh.material as THREE.ShaderMaterial;
    const defines = { CLOUDS: q > 0 ? 1 : 0, OCTAVES: q >= 2 ? 5 : 3 };
    if (m.defines?.CLOUDS !== defines.CLOUDS || m.defines?.OCTAVES !== defines.OCTAVES) {
      m.defines = defines;
      m.needsUpdate = true;
    }
  }

  /** The match time's colours (already greyed by the weather), its sun and how cloudy it is. */
  setLook(L: LightingLook, time: MatchTime, weather: Weather) {
    this.look = time;
    this.sunPos = L.sunPos;
    const u = this.u;
    const stops = L.sky;
    const col = (i: number) => stops[Math.min(i, stops.length - 1)];
    (u.uC0.value as THREE.Color).set(col(0)[1]); (u.uC1.value as THREE.Color).set(col(1)[1]);
    (u.uC2.value as THREE.Color).set(col(2)[1]); (u.uC3.value as THREE.Color).set(col(3)[1]);
    (u.uStops.value as THREE.Vector4).set(col(0)[0], col(1)[0], col(2)[0], col(3)[0]);
    this.cover = weather === 'clear' ? CLOUD_COVER[time] : OVERCAST[weather];
    u.uCover.value = this.cover;
    const clear = weather === 'clear';
    u.uSunVis.value = time === 'night' ? 0 : clear ? 1 : 0.25;
    (u.uSunCol.value as THREE.Color).set(time === 'day' ? 0xfff4e0 : 0xff9a4a);
    u.uLit.value = time === 'day' ? 0 : time === 'dusk' ? 0.5 : 1;
    // Cloud colours: white and grey by day, pink-orange lit and slate shade at dusk, dark at night.
    const lit = time === 'day' ? (clear ? 0xffffff : 0xb9c0c8) : time === 'dusk' ? (clear ? 0xffb489 : 0x8a8a94) : (clear ? 0x2c3346 : 0x3a3f4a);
    const shade = time === 'day' ? (clear ? 0x9eabbb : 0x7b838d) : time === 'dusk' ? (clear ? 0x3b3f5c : 0x4a4d57) : (clear ? 0x0d1220 : 0x1d212b);
    (u.uCloudLit.value as THREE.Color).setHex(lit);
    (u.uCloudShade.value as THREE.Color).setHex(shade);
    u.uMoon.value = time === 'night' && clear ? 1 : 0;
    this.update(0, 0);
  }

  /** Each frame: drift the clouds, and at dusk let the sun go down with `progress` (0 kick-off .. 1 full time). */
  update(time: number, progress: number, wind?: { x: number; z: number }, dt = 0) {
    const u = this.u;
    u.uTime.value = time;
    const set = this.look === 'dusk' ? Math.max(0, Math.min(1, progress)) : 0;
    u.uSet.value = set;
    (u.uSun.value as THREE.Vector3).copy(skySun(this.look, this.sunPos, set));
    // The sky darkens in the last part of a dusk match; stars come out once the sun is down.
    u.uDark.value = this.look === 'dusk' ? 0.75 * THREE.MathUtils.smoothstep(set, 0.3, 1) : 0;
    const clearK = 1 - Math.max(0, (this.cover - 0.6) / 0.3);
    u.uStars.value = (this.look === 'night' ? 1 : this.look === 'dusk' ? THREE.MathUtils.smoothstep(set, 0.55, 1) * 0.7 : 0) * Math.max(0, clearK);
    // A breeze always moves the clouds a little; the match wind moves them faster.
    const wx = 0.006 + (wind?.x ?? 0) * 0.0025, wz = 0.002 + (wind?.z ?? 0) * 0.0025;
    (u.uWind.value as THREE.Vector2).x += wx * dt;
    (u.uWind.value as THREE.Vector2).y += wz * dt;
  }

  /** For tests: the current uniforms. */
  get uniforms() { return this.u; }
}
