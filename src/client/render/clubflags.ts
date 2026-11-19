// Flags flying from poles along the roof in the home club's colours (some with the crest), and the
// four corner flags, which also carry the club's colours. The roof flags stream with the match's
// wind (all the same way); the corner posts sit on springs and swing over when the ball or a
// player clips them, then wobble back upright.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { Kit, TeamDef } from '../../shared/teams';
import { clubFlagTexture } from './badgetex';

const FLAG_W = 2.6, FLAG_H = 1.6, POLE_H = 5.5;

/** Wind for the flags: the match's wind, or a light breeze when it is still (m/s, x/z). */
export function flagWind(w?: { x: number; z: number }): { x: number; z: number } {
  if (!w || Math.hypot(w.x, w.z) < 0.5) return { x: 2.6, z: 0.9 };
  return w;
}

const FLAG_VERT = /* glsl */ `
attribute float aPhase;
attribute float aVar;
uniform float uTime;
uniform vec2 uWind;
uniform float uLen;
`;

/** Flags on the roof: one draw call for the cloth (instanced) and one for the poles. */
export class ClubFlags {
  readonly group = new THREE.Group();
  private uni = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(2.6, 0.9) }, uLen: { value: FLAG_W } };

  constructor(poles: THREE.Vector3[], team: TeamDef, kit: Kit, quality: number) {
    this.group.name = 'club-flags';
    if (!poles.length) return;
    const tex = clubFlagTexture(team, kit);
    const g = new THREE.PlaneGeometry(FLAG_W, FLAG_H, quality > 0 ? 14 : 6, quality > 0 ? 6 : 3);
    // Hoist edge at x 0, hanging down from the top of the pole.
    g.translate(FLAG_W / 2, -FLAG_H / 2, 0);
    const n = poles.length;
    const phase = new Float32Array(n), vari = new Float32Array(n);
    for (let i = 0; i < n; i++) { phase[i] = i * 1.731; vari[i] = i % 2; }
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    g.setAttribute('aVar', new THREE.InstancedBufferAttribute(vari, 1));
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${FLAG_VERT}`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
vMapUv.x = vMapUv.x * 0.5 + aVar * 0.5;
#endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float s = clamp(length(uWind), 0.0, 14.0);
  float u = clamp(transformed.x / uLen, 0.0, 1.0);
  float t = uTime * (2.2 + s * 0.35) + aPhase;
  float wave = (sin(u * 6.2 - t) * 0.16 + sin(u * 11.0 - t * 1.6 + transformed.y * 2.1) * 0.05) * u * (0.8 + s * 0.06);
  // Light winds let the flag droop against the pole.
  float droop = (1.0 - smoothstep(1.0, 7.0, s)) * u * u * 0.9;
  vec3 p = vec3(transformed.x * (1.0 - droop * 0.3), transformed.y - droop * transformed.x * 0.5, wave);
  float yaw = atan(uWind.y, uWind.x);
  transformed = vec3(p.x * cos(yaw) - p.z * sin(yaw), p.y, p.x * sin(yaw) + p.z * cos(yaw));
}`);
    };
    mat.customProgramCacheKey = () => 'elevens-clubflag';
    const cloth = new THREE.InstancedMesh(g, mat, n);
    const m = new THREE.Matrix4();
    poles.forEach((p, i) => cloth.setMatrixAt(i, m.makeTranslation(p.x, p.y + POLE_H - 0.1, p.z)));
    cloth.instanceMatrix.needsUpdate = true;
    cloth.computeBoundingSphere();
    cloth.frustumCulled = false;
    const pg: THREE.BufferGeometry[] = [];
    const base = new THREE.CylinderGeometry(0.05, 0.08, POLE_H, 6).translate(0, POLE_H / 2, 0);
    const pm = new THREE.InstancedMesh(base, new THREE.MeshLambertMaterial({ color: 0xd8dce2 }), n);
    poles.forEach((p, i) => pm.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
    pm.instanceMatrix.needsUpdate = true;
    pm.computeBoundingSphere();
    void pg;
    this.group.add(cloth, pm);
  }

  update(time: number, wind: { x: number; z: number }) {
    this.uni.uTime.value = time;
    // Smooth changes of direction.
    const w = this.uni.uWind.value;
    w.x += (wind.x - w.x) * 0.05;
    w.y += (wind.z - w.y) * 0.05;
  }
}

/** Corner posts: spring-mounted, so a touch from the ball or a player tips them over and they wobble back. */
export const CORNER = { k: 70, damp: 5.5, max: 0.95, reach: 0.32, ballKick: 0.075, playerKick: 0.05 } as const;

interface Post { group: THREE.Group; x: number; z: number; ax: number; az: number; vx: number; vz: number; cool: number }

export class CornerFlags {
  readonly group = new THREE.Group();
  private posts: Post[] = [];
  private uni = { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(2.6, 0.9) }, uLen: { value: 0.42 } };

  constructor(kit: Kit) {
    this.group.name = 'corner-flags';
    const L = PITCH.halfLength, W = PITCH.halfWidth;
    const second = kit.second && kit.second !== kit.shirt ? kit.second : kit.sleeves !== kit.shirt ? kit.sleeves : kit.number;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const g2 = c.getContext('2d')!;
    const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
    // Diagonal halves of the club's two colours.
    g2.fillStyle = hex(kit.shirt); g2.fillRect(0, 0, 64, 48);
    g2.fillStyle = hex(second); g2.beginPath(); g2.moveTo(64, 0); g2.lineTo(64, 48); g2.lineTo(0, 48); g2.closePath(); g2.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const flagGeo = new THREE.PlaneGeometry(0.42, 0.3, 6, 3).translate(0.21, -0.15, 0);
    const flagMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    flagMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uni);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform vec2 uWind;\nuniform float uLen;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float s = clamp(length(uWind), 0.0, 14.0);
  float u = clamp(transformed.x / uLen, 0.0, 1.0);
  float t = uTime * (5.0 + s * 0.5) + modelMatrix[3].x * 0.37 + modelMatrix[3].z;
  transformed.z += (sin(u * 7.0 - t) * 0.045 + sin(u * 13.0 - t * 1.5) * 0.012) * u * (0.6 + s * 0.08);
  transformed.y -= (1.0 - smoothstep(1.0, 6.0, s)) * u * u * 0.1;
}`);
    };
    flagMat.customProgramCacheKey = () => 'elevens-cornerflag';
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const stripe = new THREE.MeshLambertMaterial({ color: second === 0xffffff || second === 0xf4f4f4 ? kit.shirt : second });
    const poleGeo = new THREE.CylinderGeometry(0.018, 0.022, 1.5, 8).translate(0, 0.75, 0);
    const bandGeo = new THREE.CylinderGeometry(0.0195, 0.0195, 0.12, 8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const grp = new THREE.Group();
      grp.position.set(sx * L, 0, sz * W);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.castShadow = true;
      grp.add(pole);
      for (const y of [0.3, 0.6, 0.9, 1.2]) { const b = new THREE.Mesh(bandGeo, stripe); b.position.y = y; grp.add(b); }
      // The flag flies from the top of the post with the wind (its yaw is set each frame).
      const flagPivot = new THREE.Group();
      flagPivot.position.y = 1.5;
      flagPivot.name = 'flag';
      const f = new THREE.Mesh(flagGeo, flagMat);
      flagPivot.add(f);
      grp.add(flagPivot);
      this.group.add(grp);
      this.posts.push({ group: grp, x: sx * L, z: sz * W, ax: 0, az: 0, vx: 0, vz: 0, cool: 0 });
    }
  }

  /** Tilt of each post (radians from upright), for tests. */
  get tilts(): number[] {
    return this.posts.map((p) => Math.hypot(p.ax, p.az));
  }

  /** Knock a post over towards (dx, dz) (unit) by an angular speed (rad/s). */
  knock(i: number, dx: number, dz: number, w: number) {
    const p = this.posts[i];
    if (!p) return;
    p.vx += dx * w; p.vz += dz * w;
  }

  update(dt: number, time: number, wind: { x: number; z: number }, ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, players: { x: number; z: number; vx: number; vz: number }[]) {
    this.uni.uTime.value = time;
    this.uni.uWind.value.set(wind.x, wind.z);
    const yaw = Math.atan2(wind.z, wind.x);
    const h = Math.min(dt, 1 / 20);
    for (const p of this.posts) {
      p.cool = Math.max(0, p.cool - dt);
      // Contact: the ball (below the top of the post), or a player brushing past it.
      const bd = Math.hypot(ball.x - p.x, ball.z - p.z);
      const bs = Math.hypot(ball.vx, ball.vz);
      if (p.cool <= 0 && bd < CORNER.reach && ball.y < 1.55 && bs > 1) {
        const k = Math.min(1.6, bs * CORNER.ballKick * (1.6 - ball.y * 0.6));
        this.knockPost(p, ball.vx / bs, ball.vz / bs, k * 6);
        p.cool = 0.35;
      }
      for (const q of players) {
        const d = Math.hypot(q.x - p.x, q.z - p.z), s = Math.hypot(q.vx, q.vz);
        if (p.cool <= 0 && d < CORNER.reach + 0.18 && s > 1.2) {
          this.knockPost(p, q.vx / s, q.vz / s, Math.min(1.2, s * CORNER.playerKick) * 6);
          p.cool = 0.5;
        }
      }
      // Spring back upright (a little wind lean too).
      const lean = 0.012 * Math.min(12, Math.hypot(wind.x, wind.z));
      const tx = wind.x === 0 && wind.z === 0 ? 0 : (wind.x / Math.hypot(wind.x, wind.z)) * lean, tz = wind.x === 0 && wind.z === 0 ? 0 : (wind.z / Math.hypot(wind.x, wind.z)) * lean;
      p.vx += (-CORNER.k * (p.ax - tx) - CORNER.damp * p.vx) * h;
      p.vz += (-CORNER.k * (p.az - tz) - CORNER.damp * p.vz) * h;
      p.ax += p.vx * h; p.az += p.vz * h;
      const a = Math.hypot(p.ax, p.az);
      if (a > CORNER.max) { p.ax *= CORNER.max / a; p.az *= CORNER.max / a; p.vx *= 0.3; p.vz *= 0.3; }
      // Tilt towards (ax, az): rotate about the horizontal axis perpendicular to it.
      const ang = Math.hypot(p.ax, p.az);
      if (ang > 1e-5) p.group.quaternion.setFromAxisAngle(new THREE.Vector3(p.az / ang, 0, -p.ax / ang), ang);
      else p.group.quaternion.identity();
      const flag = p.group.getObjectByName('flag');
      if (flag) {
        // The flag keeps flying downwind whatever the post does.
        flag.quaternion.copy(p.group.quaternion).invert().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw));
      }
    }
  }

  private knockPost(p: Post, dx: number, dz: number, w: number) {
    p.vx += dx * w; p.vz += dz * w;
  }
}

export { FLAG_W, FLAG_H, POLE_H };
