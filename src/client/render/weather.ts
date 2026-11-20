// Match weather: rain or snow falling round the camera, splashes on a wet pitch, and the
// overcast light that comes with it. Everything moves on the GPU from a time uniform, so a
// storm costs one or two draw calls and no per-frame work on the CPU.
//
// The falling drops live in a box that tiles space: each drop's position is wrapped into the
// box around the camera's focus, so the camera can move anywhere without dragging the
// weather with it and without drops popping in at the edges.

import * as THREE from 'three';
import type { LightingLook } from './vfx';

export type Weather = 'clear' | 'rain' | 'snow';
export type WeatherSetting = Weather | 'random';

export const WEATHER_NAMES: Record<Weather, string> = { clear: 'Clear', rain: 'Rain', snow: 'Snow' };

/** Chances for Random: mostly dry, rain often, snow now and then. */
export function rollWeather(r = Math.random()): Weather {
  return r < 0.55 ? 'clear' : r < 0.85 ? 'rain' : 'snow';
}

/** How many drops / flakes / splashes each quality preset draws. Low stays cheap for tablets. */
export const WEATHER_COUNTS = {
  rain: [1400, 4200, 9000, 14000],
  snow: [900, 2600, 5200, 8000],
  splash: [0, 260, 520, 800],
} as const;

const BOX = { rain: new THREE.Vector3(70, 36, 70), snow: new THREE.Vector3(60, 30, 60) };
/** A small dense box just in front of the camera (close drops), and a big one over the play. */
const NEAR_BOX = new THREE.Vector3(22, 18, 22);
const NEAR_SHARE = 0.4;

const FALL_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uCentre;
uniform vec3 uBox;
uniform vec2 uWind;
uniform float uSpeed;
uniform float uSnow;
uniform float uScale;
attribute vec4 aSeed;   // xyz: position in the box 0..1, w: speed/size jitter
attribute float aEnd;   // rain: 0 head, 1 tail of the streak
varying float vFade;
void main() {
  float sp = uSpeed * (0.8 + 0.4 * aSeed.w);
  vec3 p = aSeed.xyz * uBox;
  p.y -= uTime * sp;
  p.xz += uWind * uTime * (0.7 + 0.6 * aSeed.w);
  // Snow drifts and flutters on its way down.
  p.x += uSnow * sin(uTime * (0.6 + aSeed.w) + aSeed.y * 40.0) * 0.6;
  p.z += uSnow * cos(uTime * (0.5 + aSeed.w * 0.7) + aSeed.x * 40.0) * 0.6;
  // Wrap into the box round the focus point (the box tiles space).
  vec3 lo = uCentre - 0.5 * uBox;
  p = lo + mod(p - lo, uBox);
  // Rain: the tail trails up-wind of the head, as long as the drop falls in ~1/40 s.
  vec3 v = vec3(uWind.x, -sp, uWind.y);
  p -= aEnd * v * 0.028;
  // Fade out near the bottom of the box and at its sides, so the wrap is invisible.
  vec3 q = abs(p - uCentre) / (0.5 * uBox);
  vFade = (1.0 - smoothstep(0.75, 1.0, max(q.x, q.z))) * smoothstep(0.0, 0.08, p.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSnow > 0.5 ? clamp(uScale * (0.05 + 0.04 * aSeed.w) / -mv.z, 1.0, 14.0) : 1.0;
}`;

const RAIN_FS = /* glsl */ `
uniform vec3 uColour;
uniform float uAlpha;
varying float vFade;
void main() { gl_FragColor = vec4(uColour, uAlpha * vFade); }`;

const SNOW_FS = /* glsl */ `
uniform vec3 uColour;
uniform float uAlpha;
varying float vFade;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = 1.0 - smoothstep(0.25, 0.5, length(d));
  gl_FragColor = vec4(uColour, uAlpha * vFade * a);
}`;

// Splashes: little rings that open and fade where drops hit the grass round the play.
const SPLASH_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uCentre;
uniform float uScale;
attribute vec3 aSeed;   // xy: position 0..1 in a 60 x 40 m patch, z: phase
varying float vLife;
void main() {
  float cyc = 0.55;
  float t = uTime / cyc + aSeed.z;
  float k = floor(t);
  vLife = fract(t);
  // A new spot each cycle.
  vec2 r = fract(vec2(aSeed.x + k * 0.6180339, aSeed.y + k * 0.4142135));
  vec3 p = vec3(uCentre.x + (r.x - 0.5) * 60.0, 0.03, uCentre.z + (r.y - 0.5) * 40.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uScale * (0.04 + 0.12 * vLife) / -mv.z, 1.0, 10.0);
}`;

const SPLASH_FS = /* glsl */ `
uniform float uAlpha;
varying float vLife;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  float ring = smoothstep(0.5, 0.4, r) * smoothstep(0.2, 0.38, r);
  gl_FragColor = vec4(vec3(0.85, 0.9, 0.95), uAlpha * ring * (1.0 - vLife));
}`;

/** Lighting for a wet or snowy day: a grey sky, lower sun and closer fog over the chosen match time. */
export function weatherLook(L: LightingLook, w: Weather): LightingLook {
  if (w === 'clear') return L;
  const mixHex = (a: number, b: number, k: number) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();
  const grey = w === 'snow' ? 0xb8c0cc : 0x5c6670;
  const night = L.lamps > 0.8;
  return {
    ...L,
    sky: L.sky.map(([s, c]) => [s, '#' + new THREE.Color(c).lerp(new THREE.Color(grey), night ? 0.25 : 0.6).getHexString()] as [number, string]),
    fog: mixHex(L.fog, grey, 0.6),
    fogNear: L.fogNear * (w === 'snow' ? 0.45 : 0.55),
    fogFar: L.fogFar * (w === 'snow' ? 0.5 : 0.62),
    sunI: L.sunI * (night ? 0.9 : 0.55),
    hemi: L.hemi * (w === 'snow' ? 1.12 : 0.95),
    hemiSky: mixHex(L.hemiSky, grey, 0.5),
    exposure: L.exposure * (w === 'snow' ? 0.98 : 0.94),
    crossShadow: L.crossShadow * 0.8,
    grade: { ...L.grade, sat: L.grade.sat * (w === 'snow' ? 0.82 : 0.86) },
  };
}

function fallMaterial(snow: boolean) {
  return new THREE.ShaderMaterial({
    vertexShader: FALL_VS,
    fragmentShader: snow ? SNOW_FS : RAIN_FS,
    uniforms: {
      uTime: { value: 0 }, uCentre: { value: new THREE.Vector3() }, uBox: { value: (snow ? BOX.snow : BOX.rain).clone() },
      uWind: { value: new THREE.Vector2(snow ? 0.6 : 1.6, snow ? 0.3 : 0.8) }, uSpeed: { value: snow ? 1.3 : 13 }, uSnow: { value: snow ? 1 : 0 },
      uScale: { value: 600 }, uColour: { value: new THREE.Color(snow ? 0xffffff : 0xb9c6d4) }, uAlpha: { value: snow ? 0.9 : 0.32 },
    },
    transparent: true,
    depthWrite: false,
  });
}

/** Rain or snow for one match. `setup` builds it for the weather and quality, `update` each frame. */
export class WeatherFx {
  group = new THREE.Group();
  weather: Weather = 'clear';
  private falls: (THREE.Points | THREE.LineSegments)[] = [];
  private splash: THREE.Points | null = null;
  private mats: THREE.ShaderMaterial[] = [];
  /** 0 dry .. 1 soaked (rain), or 0 green .. 1 white over (snow): builds up over the first minutes. */
  cover = 0;
  private scale = 600;

  constructor() {
    this.group.name = 'weather';
    this.group.renderOrder = 5;
  }

  /** The match wind (m/s, world x/z): rain and snow drift with it. */
  setWind(wx: number, wz: number) {
    for (const m of this.mats) {
      // (The ground splashes have no wind.)
      if (!m.uniforms.uWind || !m.uniforms.uSnow) continue;
      const snow = m.uniforms.uSnow.value > 0.5;
      // A little of the old default drift always, so still air doesn't look frozen.
      m.uniforms.uWind.value.set((snow ? 0.6 : 1.6) * 0.4 + wx * (snow ? 0.5 : 0.8), (snow ? 0.3 : 0.8) * 0.4 + wz * (snow ? 0.5 : 0.8));
    }
  }

  setup(w: Weather, quality: number) {
    for (const o of [...this.falls, this.splash]) if (o) { this.group.remove(o); o.geometry.dispose(); }
    for (const m of this.mats) m.dispose();
    this.falls = [];
    this.splash = null;
    this.mats = [];
    this.weather = w;
    this.cover = w === 'rain' ? 0.55 : w === 'snow' ? 0.25 : 0;
    if (w === 'clear') return;
    const q = Math.max(0, Math.min(3, quality));
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const snow = w === 'snow';
    const total = (snow ? WEATHER_COUNTS.snow : WEATHER_COUNTS.rain)[q];
    for (const near of [true, false]) {
      const n = Math.round(total * (near ? NEAR_SHARE : 1 - NEAR_SHARE));
      const g = new THREE.BufferGeometry();
      const per = snow ? 1 : 2;
      const seed = new Float32Array(n * per * 4), end = new Float32Array(n * per), pos = new Float32Array(n * per * 3);
      for (let i = 0; i < n; i++) {
        const a = [rnd(), rnd(), rnd(), rnd()];
        for (let k = 0; k < per; k++) { seed.set(a, (i * per + k) * 4); end[i * per + k] = k; }
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
      g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      const fm = fallMaterial(snow);
      if (near) { fm.uniforms.uBox.value.copy(NEAR_BOX); fm.uniforms.uAlpha.value *= snow ? 1 : 0.8; }
      fm.userData.near = near;
      this.mats.push(fm);
      const o = snow ? new THREE.Points(g, fm) : new THREE.LineSegments(g, fm);
      o.frustumCulled = false;
      o.renderOrder = 5;
      this.falls.push(o);
      this.group.add(o);
    }
    const ns = snow ? 0 : WEATHER_COUNTS.splash[q];
    if (ns > 0) {
      const sg = new THREE.BufferGeometry();
      const ss = new Float32Array(ns * 3);
      for (let i = 0; i < ns * 3; i++) ss[i] = rnd();
      sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ns * 3), 3));
      sg.setAttribute('aSeed', new THREE.BufferAttribute(ss, 3));
      const sm = new THREE.ShaderMaterial({ vertexShader: SPLASH_VS, fragmentShader: SPLASH_FS, uniforms: { uTime: { value: 0 }, uCentre: { value: new THREE.Vector3() }, uScale: { value: 600 }, uAlpha: { value: 0.55 } }, transparent: true, depthWrite: false });
      this.mats.push(sm);
      this.splash = new THREE.Points(sg, sm);
      this.splash.frustumCulled = false;
      this.splash.renderOrder = 4;
      this.group.add(this.splash);
    }
    this.setScale(this.scale);
  }

  /** Pixels per metre at 1 m from the camera (for point sizes). */
  setScale(s: number) {
    this.scale = s;
    for (const m of this.mats) m.uniforms.uScale.value = s;
  }

  /** `focus` is where the camera looks on the pitch; the falling box sits between it and the camera. */
  update(time: number, dt: number, cam: THREE.Camera, focus: THREE.Vector3) {
    if (this.weather === 'clear') return;
    // Rain soaks the pitch quickly; snow settles over the first ten minutes or so of play.
    this.cover = Math.min(1, this.cover + dt * (this.weather === 'rain' ? 0.02 : 0.0016));
    const far = new THREE.Vector3().copy(cam.position).lerp(focus, 0.55);
    far.y = Math.max(far.y, (this.weather === 'snow' ? BOX.snow : BOX.rain).y * 0.5);
    // The near box sits just ahead of the lens, filling the foreground with close drops.
    const ahead = new THREE.Vector3();
    cam.getWorldDirection(ahead);
    const near = new THREE.Vector3().copy(cam.position).addScaledVector(ahead, NEAR_BOX.x * 0.5 + 1);
    for (const m of this.mats) {
      m.uniforms.uTime.value = time;
      m.uniforms.uCentre.value.copy(m.userData.near === true ? near : m.userData.near === false ? far : focus);
    }
  }
}
