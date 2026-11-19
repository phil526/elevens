// Real grass blades for close shots: the net cam, the tunnel walk-out, low replay cameras and
// photo mode. A patch of thin blades sits where the camera is looking and wraps round as it
// moves (each blade keeps its own spot on the pitch), coloured from the same grass texture and
// mowing pattern as the turf under it, swaying in the wind and pushed aside by the ball.
// Far shots (the broadcast camera) never draw it. Medium and up; more blades on High and Ultra.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import { MOW_GLSL } from './vfx';

/** Patch size (m) and blades per quality level (Low has none). */
export const BLADES = { size: [0, 14, 18, 22], count: [0, 16000, 36000, 60000], height: [0.045, 0.085], width: 0.007, showWithin: 26 } as const;

const LINE_GLSL = /* glsl */ `
// Distance (m) to the nearest painted line, so blades on a line are painted white too.
float segD(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float lineDist(vec2 w) {
  const float L = ${PITCH.halfLength.toFixed(2)}, W = ${PITCH.halfWidth.toFixed(2)};
  vec2 a = vec2(abs(w.x), abs(w.y));
  float d = min(abs(a.y - W) + step(L, a.x) * 1e3, abs(a.x - L) + step(W, a.y) * 1e3);
  d = min(d, abs(w.x) + step(W, a.y) * 1e3);
  d = min(d, abs(length(w) - ${PITCH.centreCircleRadius.toFixed(2)}));
  d = min(d, max(length(w) - 0.3, 0.0));
  float pa = L - ${PITCH.penaltyAreaDepth.toFixed(2)}, ga = L - ${PITCH.goalAreaDepth.toFixed(2)};
  d = min(d, segD(a, vec2(pa, ${PITCH.penaltyAreaHalfWidth.toFixed(2)}), vec2(L, ${PITCH.penaltyAreaHalfWidth.toFixed(2)})));
  d = min(d, segD(a, vec2(pa, 0.0), vec2(pa, ${PITCH.penaltyAreaHalfWidth.toFixed(2)})));
  d = min(d, segD(a, vec2(ga, ${PITCH.goalAreaHalfWidth.toFixed(2)}), vec2(L, ${PITCH.goalAreaHalfWidth.toFixed(2)})));
  d = min(d, segD(a, vec2(ga, 0.0), vec2(ga, ${PITCH.goalAreaHalfWidth.toFixed(2)})));
  vec2 spot = vec2(L - ${PITCH.penaltySpot.toFixed(2)}, 0.0);
  d = min(d, max(length(a - spot) - 0.22, 0.0));
  if (a.x < pa) d = min(d, abs(length(a - spot) - ${PITCH.centreCircleRadius.toFixed(2)}));
  if (a.x > L - 1.2 && a.y > W - 1.2) d = min(d, abs(length(a - vec2(L, W)) - ${PITCH.cornerArcRadius.toFixed(2)}));
  return d;
}
`;

export class GrassBlades {
  readonly mesh: THREE.Mesh | null = null;
  private u: Record<string, THREE.IUniform> = {};
  private size = 0;
  private ray = new THREE.Raycaster();
  private hit = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(quality: number, grassMap: THREE.Texture | null, mowUniform: { value: number }) {
    const n = BLADES.count[Math.min(3, quality)];
    if (!n || !grassMap) return;
    this.size = BLADES.size[Math.min(3, quality)];
    // One blade = a thin triangle; three verts with a 0..1 "up" in uv.y and side in uv.x.
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0], 3));
    base.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    const g = new THREE.InstancedBufferGeometry();
    g.index = null;
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, base.getAttribute(k));
    // Per blade: x, z within the patch, height, facing.
    const a = new Float32Array(n * 4);
    let s = 12345;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      a[i * 4] = r() * this.size;
      a[i * 4 + 1] = r() * this.size;
      a[i * 4 + 2] = BLADES.height[0] + (BLADES.height[1] - BLADES.height[0]) * r() * r();
      a[i * 4 + 3] = r() * Math.PI * 2;
    }
    g.setAttribute('aBlade', new THREE.InstancedBufferAttribute(a, 4));
    g.instanceCount = n;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.u = {
      uCentre: { value: new THREE.Vector2() }, uSize: { value: this.size }, uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0.4, 0.2) }, uBall: { value: new THREE.Vector3(0, -10, 0) },
      uGrass: { value: grassMap }, uMow: mowUniform, uFade: { value: 1 },
      uRepeat: { value: new THREE.Vector2(1, 1) },
    };
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec4 aBlade;
uniform vec2 uCentre, uWind;
uniform float uSize, uTime, uFade;
uniform vec3 uBall;
varying vec2 vBladeW;
varying float vUp;`)
        .replace('#include <begin_vertex>', `
// Each blade keeps its spot on the pitch: the patch wraps round the centre.
vec2 off = mod(aBlade.xy - uCentre + uSize * 0.5, uSize) - uSize * 0.5;
vec2 bw = uCentre + off;
// Thin out towards the patch edge so it has no border, and off the pitch surround.
float edge = 1.0 - smoothstep(0.3, 0.5, max(abs(off.x), abs(off.y)) / uSize);
float onPitch = step(abs(bw.x), ${(PITCH.halfLength + 4.5).toFixed(1)}) * step(abs(bw.y), ${(PITCH.halfWidth + 5.5).toFixed(1)});
float h = aBlade.z * edge * onPitch * uFade;
float c = cos(aBlade.w), s = sin(aBlade.w);
vec3 transformed = vec3(position.x * ${BLADES.width.toFixed(4)} * c, position.y * h, position.x * ${BLADES.width.toFixed(4)} * s);
float up = position.y;
// Sway, and pushed away from a ball rolling over them.
vec2 sway = uWind * (0.35 + 0.65 * sin(uTime * 2.3 + bw.x * 1.7 + bw.y * 1.3)) * 0.018;
vec2 fromBall = bw - uBall.xz;
float bd = length(fromBall);
sway += (uBall.y < 0.35 ? 1.0 : 0.0) * normalize(fromBall + 1e-4) * 0.03 * (1.0 - smoothstep(0.08, 0.3, bd));
transformed.xz += sway * up * up;
transformed.y -= length(sway) * up * up * 0.5;
transformed.xz += bw;
vBladeW = bw;
vUp = up;`)
        .replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + vec3(cos(aBlade.w + 1.57), 0.0, sin(aBlade.w + 1.57)) * 0.35);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uGrass;
uniform float uMow;
uniform vec2 uRepeat;
varying vec2 vBladeW;
varying float vUp;
${MOW_GLSL}${LINE_GLSL}`)
        .replace('#include <map_fragment>', `
// The turf's own colour here (the grass plane spans the pitch plus 10 m by 12 m).
vec2 guv = (vBladeW + vec2(${(PITCH.halfLength + 5).toFixed(1)}, ${(PITCH.halfWidth + 6).toFixed(1)})) / vec2(${(2 * PITCH.halfLength + 10).toFixed(1)}, ${(2 * PITCH.halfWidth + 12).toFixed(1)});
vec3 gc = texture2D(uGrass, vec2(guv.x, 1.0 - guv.y) * uRepeat).rgb;
vec3 toCamB = normalize(cameraPosition - vec3(vBladeW.x, 0.0, vBladeW.y));
gc *= 1.0 + mowGrain(vBladeW, toCamB, uMow);
// Darker at the root, lighter and a little yellower at the tip.
diffuseColor.rgb = gc * mix(0.72, 1.15, vUp) + vec3(0.02, 0.02, -0.01) * vUp;
// Painted lines: the blades there are white too.
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.88, 0.85) * mix(0.8, 1.0, vUp), 1.0 - smoothstep(0.05, 0.075, lineDist(vBladeW)));`)
        // Lit like the turf under them (no dark back faces): the normal points up.
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`);
    };
    m.customProgramCacheKey = () => 'grass-blades';
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = 'grassBlades';
    (this as { mesh: THREE.Mesh | null }).mesh = mesh;
  }

  /**
   * Each frame: centre the patch on where the camera looks (or just in front of a low camera),
   * hide it when the camera is far from the ground.
   */
  update(cam: THREE.PerspectiveCamera, time: number, ball: { x: number; y: number; z: number }, wind: { x: number; z: number }, snow: number) {
    if (!this.mesh) return;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    this.ray.set(cam.position, dir);
    let centre: THREE.Vector3 | null = this.ray.ray.intersectPlane(this.plane, this.hit);
    // Looking level (tunnel, net cam): put the patch a little ahead of the lens instead.
    const dist = centre ? centre.distanceTo(cam.position) : Infinity;
    if (!centre || dist > BLADES.showWithin) {
      if (cam.position.y < 4) centre = this.hit.set(cam.position.x + dir.x * this.size * 0.35, 0, cam.position.z + dir.z * this.size * 0.35);
      else centre = null;
    }
    // Hidden from far and high cameras, and under settled snow.
    const show = !!centre && cam.position.y < 14 && snow < 0.6;
    this.mesh.visible = show;
    if (!show || !centre) return;
    // Pull the patch towards the camera so the nearest blades (the ones you can see) are covered.
    const toward = new THREE.Vector2(cam.position.x - centre.x, cam.position.z - centre.z);
    const tl = toward.length();
    if (tl > 0.01) toward.multiplyScalar(Math.min(tl, this.size * 0.3) / tl);
    (this.u.uCentre.value as THREE.Vector2).set(centre.x + toward.x, centre.z + toward.y);
    this.u.uTime.value = time;
    (this.u.uWind.value as THREE.Vector2).set(0.4 + wind.x * 0.12, 0.2 + wind.z * 0.12);
    (this.u.uBall.value as THREE.Vector3).set(ball.x, ball.y, ball.z);
    this.u.uFade.value = 1 - snow;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
