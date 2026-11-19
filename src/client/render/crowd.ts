// Spectators: thousands of simple figures drawn with one instanced mesh per stand.
// All movement (idle sway, standing up, jumping, arms up) happens in the vertex
// shader from two "excitement" values, one per team's supporters.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Where a stand's seats are, in the stand's local frame (x along, z back from the front). */
export interface SeatRows {
  length: number;
  rows: number;
  rowDepth: number;
  rise: number;
  baseY: number;
  seatPitch: number;
  shaded: boolean; // under a roof: back rows are darker
}

/** Share of each team's supporters among the people in a stand (the rest are neutral). */
export interface Allegiance {
  home: number;
  away: number;
}

const SKIN = [0xf1c8a5, 0xd9a47c, 0xb57b52, 0x8a5a3a, 0x5c3a24, 0xf5d2b8];
const NEUTRAL = [0x2b2b2b, 0xe8e2d4, 0x3b6ea5, 0x6b4a2b, 0x888888, 0x1f3b2d, 0x5e2a4a, 0xd8d0b0, 0x23324f];

// Shared by every stand so one set of uniforms drives the whole ground.
const uniforms = {
  uTime: { value: 0 },
  uExcite: { value: new THREE.Vector2(0.1, 0.1) },
};
/** The same uniforms, for crowds built elsewhere (the arena's instanced fans). */
export const crowdUniforms = uniforms;
let material: THREE.MeshLambertMaterial | null = null;

function crowdMaterial(): THREE.MeshLambertMaterial {
  if (material) return material;
  material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uExcite;
        attribute float aPart;   // 0 body, 1 head, 2 arm
        attribute vec3 aSkin;    // per person
        attribute vec3 aInfo;    // per person: phase, team (0 home, 1 away, 2 neutral), height up the stand 0..1`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float team = aInfo.y;
        float e = team < 0.5 ? uExcite.x : team < 1.5 ? uExcite.y : 0.5 * max(uExcite.x, uExcite.y);
        float ph = aInfo.x;
        // Idle: a slow sway and the occasional shift in the seat.
        transformed.x += sin(uTime * 1.1 + ph * 6.0) * 0.03;
        // Rising tension: people get up out of their seats.
        float up = smoothstep(0.25, 0.6, e);
        transformed.y += up * 0.28;
        // Celebration: bouncing, out of step with each other.
        float jump = smoothstep(0.65, 1.0, e);
        transformed.y += jump * abs(sin(uTime * (7.0 + fract(ph * 13.0) * 3.0) + ph * 40.0)) * 0.3;
        // Arms go up as excitement peaks.
        if (aPart > 1.5) {
          float arms = smoothstep(0.5, 0.9, e);
          transformed.y += arms * (0.62 + 0.08 * sin(uTime * 8.0 + ph * 20.0));
          transformed.x += arms * sign(transformed.x) * 0.12;
        }`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          if (aPart > 0.5 && aPart < 1.5) vColor.xyz = aSkin;
          if (aPart > 1.5) vColor.xyz = mix(vColor.xyz, aSkin, 0.35);
          // Rows towards the back sit in the roof's shade.
          vColor.xyz *= 1.0 - 0.35 * smoothstep(0.35, 1.0, aInfo.z);
        #endif`,
      );
  };
  return material;
}

/** A box without the faces nobody sees from inside the ground (bottom and back): 8 triangles. */
function frontBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(w, h, d);
  const index = box.index!.array;
  const keep: number[] = [];
  // BoxGeometry groups in order: +x, -x, +y, -y, +z (back), -z (front).
  for (const gi of [0, 1, 2, 5]) {
    const grp = box.groups[gi];
    for (let i = grp.start; i < grp.start + grp.count; i++) keep.push(index[i]);
  }
  box.setIndex(keep);
  box.clearGroups();
  return box;
}

/** One spectator, feet on the tread at the origin, facing -z (towards the pitch). */
function personGeometry(): THREE.BufferGeometry {
  const part = (g: THREE.BufferGeometry, id: number) => {
    g.deleteAttribute('uv');
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(id), 1));
    return g;
  };
  const torso = frontBox(0.42, 0.6, 0.26).translate(0, 0.65, 0);
  const head = frontBox(0.2, 0.22, 0.2).translate(0, 1.07, -0.01);
  const armL = frontBox(0.1, 0.5, 0.12).translate(-0.27, 0.68, -0.02);
  const armR = frontBox(0.1, 0.5, 0.12).translate(0.27, 0.68, -0.02);
  return mergeGeometries([part(torso, 0), part(head, 1), part(armL, 2), part(armR, 2)]);
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/**
 * Fill a stand's rows with people. `fill` is the share of seats taken. Supporters
 * wear their team's shirt colour; neutrals wear everyday colours.
 */
export function buildCrowd(rows: SeatRows, fill: number, who: Allegiance, colours: [number, number], seedValue: number): THREE.InstancedMesh | null {
  seed = seedValue;
  const spots: { x: number; y: number; z: number; h: number }[] = [];
  const perRow = Math.floor(rows.length / rows.seatPitch) - 2;
  for (let r = 0; r < rows.rows; r++) {
    // Gangways every 24 seats, and a few gaps where nobody sits.
    for (let i = 0; i < perRow; i++) {
      if (i % 24 === 0) continue;
      if (rnd() > fill) continue;
      const x = -rows.length / 2 + (i + 1.5) * rows.seatPitch + (rnd() - 0.5) * 0.08;
      spots.push({ x, y: rows.baseY + (r + 1) * rows.rise, z: (r + 0.6) * rows.rowDepth, h: rows.shaded ? r / rows.rows : 0 });
    }
  }
  if (!spots.length) return null;
  const geo = personGeometry();
  const n = spots.length;
  const skin = new Float32Array(n * 3);
  const info = new Float32Array(n * 3);
  const mesh = new THREE.InstancedMesh(geo, crowdMaterial(), n);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const s = spots[i];
    const h = 0.9 + rnd() * 0.2;
    sc.set(0.9 + rnd() * 0.25, h, 1);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 0.5);
    m.compose(new THREE.Vector3(s.x, s.y, s.z), q, sc);
    mesh.setMatrixAt(i, m);
    const roll = rnd();
    const team = roll < who.home ? 0 : roll < who.home + who.away ? 1 : 2;
    if (team < 2) {
      c.setHex(colours[team as 0 | 1]);
      // Not everybody wears the shirt: some wear a darker jacket in a similar colour.
      if (rnd() < 0.25) c.multiplyScalar(0.55);
    } else c.setHex(NEUTRAL[Math.floor(rnd() * NEUTRAL.length)]);
    mesh.setColorAt(i, c);
    c.setHex(SKIN[Math.floor(rnd() * SKIN.length)]);
    skin.set([c.r, c.g, c.b], i * 3);
    info.set([rnd(), team, s.h], i * 3);
  }
  geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 3));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  // Moved in the shader, so the CPU bounds would be slightly wrong; stands are always near the view anyway.
  mesh.frustumCulled = false;
  return mesh;
}

/** Drive every crowd in the ground. `excite` is 0 (quiet) to 1 (goal) for home and away supporters. */
export function updateCrowd(time: number, homeExcite: number, awayExcite: number) {
  uniforms.uTime.value = time;
  uniforms.uExcite.value.set(homeExcite, awayExcite);
}
