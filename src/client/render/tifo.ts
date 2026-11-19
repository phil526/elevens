// A giant fan display across the home end before kick-off: thousands of supporters hold up
// coloured cards (and the front rows a banner) that together make the club's crest on stripes in
// its colours, its name across the upper tier and a slogan below. The cards go up row by row
// from the front as the teams come out, ripple a little as arms tire, and come down from the top
// at kick-off, uncovering the fans behind. Everything is drawn here; it reads the ViewState only.

import * as THREE from 'three';
import type { Kit, TeamDef } from '../../shared/teams';
import { badgeFor } from '../../shared/teams';
import { drawBadge } from './badgetex';
import type { ArenaTier } from './arena';

/** Seconds for the cards to go up (front row to back) and to come down. */
export const TIFO = { rise: 3.2, fall: 1.8, card: 0.56 } as const;

const SLOGANS = ['WE ARE {N}', '{N} FOREVER', 'THIS IS OUR HOME', 'TOGETHER AS ONE', 'ONE CLUB · ONE DREAM', 'NEVER WALK ALONE'];

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** The display's picture: stripes in the club colours, the crest, the name and a slogan. */
function tifoCanvas(team: TeamDef, kit: Kit, rowsLow: number, rowsUp: number): HTMLCanvasElement {
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const a = kit.shirt, b = kit.second ?? kit.number;
  const lum = (x: number) => ((x >> 16) & 255) * 0.3 + ((x >> 8) & 255) * 0.59 + (x & 255) * 0.11;
  const light = lum(a) > lum(b) ? a : b, dark = light === a ? b : a;
  const ink = lum(dark) < 90 ? dark : 0x111111;
  // Share of the picture that is the lower tier (it is drawn across both, bottom to top).
  const split = rowsUp > 0 ? rowsLow / (rowsLow + rowsUp) : 1;
  // Wide stripes in the two colours.
  const n = 9;
  for (let i = 0; i < n; i++) { g.fillStyle = hex(i % 2 ? b : a); g.fillRect((i * W) / n, 0, W / n + 1, H); }
  // A darker band for the name across the top and the slogan across the bottom.
  g.fillStyle = hex(ink);
  g.globalAlpha = 0.92;
  if (rowsUp > 0) g.fillRect(0, 0, W, H * 0.2);
  g.fillRect(0, H * (1 - Math.min(0.22, split * 0.42)), W, H * Math.min(0.22, split * 0.42));
  g.globalAlpha = 1;
  // The crest in the middle, on a light disc.
  const cy = rowsUp > 0 ? H * 0.52 : H * 0.42, r = H * (rowsUp > 0 ? 0.3 : 0.26);
  g.fillStyle = hex(light);
  g.beginPath(); g.arc(W / 2, cy, r * 1.08, 0, Math.PI * 2); g.fill();
  g.lineWidth = r * 0.07; g.strokeStyle = hex(ink); g.stroke();
  g.save();
  g.translate(W / 2 - r * 0.86, cy - r * 0.86);
  g.scale((r * 1.72) / 100, (r * 1.72) / 100);
  drawBadge(g, badgeFor(team), team.abbr);
  g.restore();
  // The name and a slogan, in the light colour on the dark bands.
  g.fillStyle = hex(light === ink ? 0xffffff : light);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (rowsUp > 0) {
    g.font = `900 ${H * 0.15}px "Arial Black", Arial, sans-serif`;
    g.fillText(team.name.toUpperCase(), W / 2, H * 0.105, W * 0.92);
  }
  const slogan = SLOGANS[(team.id.length * 7 + team.name.length) % SLOGANS.length].replace('{N}', team.name.toUpperCase());
  const bandH = H * Math.min(0.22, split * 0.42);
  g.font = `900 ${bandH * 0.7}px "Arial Black", Arial, sans-serif`;
  g.fillText(slogan, W / 2, H - bandH / 2, W * 0.92);
  return c;
}

/**
 * The display. `build` it for the home end of a match's ground; `update` it each frame with
 * whether the match is still waiting for its first kick-off.
 */
export class FanDisplay {
  readonly group = new THREE.Group();
  private mat: THREE.MeshLambertMaterial | null = null;
  private u = { uRise: { value: 0 }, uTime: { value: 0 }, uRows: { value: 1 } };
  /** How far up the cards are, 0 (all down) .. 1 (the whole display). */
  level = 0;
  private up = false;

  build(team: TeamDef, kit: Kit, low: ArenaTier, upr: ArenaTier | null) {
    this.dispose();
    const rowsUp = upr ? upr.rows : 0;
    const tex = new THREE.CanvasTexture(tifoCanvas(team, kit, low.rows, rowsUp));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    // One sloping strip per tier across the home end's straight (x = -63 - d), held overhead.
    const Z = 29.5, LIFT = 1.95;
    const pos: number[] = [], uv: number[] = [], row: number[] = [], idx: number[] = [];
    const total = low.rows + rowsUp;
    const strip = (T: ArenaTier, r0: number) => {
      const base = pos.length / 3;
      const cols = 24;
      for (let r = 0; r <= T.rows; r++) {
        const d = T.d0 + r * T.rd + 0.15, y = T.y0 + r * T.rise + LIFT;
        const v = (r0 + r) / total;
        for (let k = 0; k <= cols; k++) {
          const z = Z - (2 * Z * k) / cols;
          pos.push(-63 - d, y, z);
          uv.push(k / cols, v);
          row.push(r0 + r);
        }
      }
      for (let r = 0; r < T.rows; r++) for (let k = 0; k < cols; k++) {
        const i = base + r * (cols + 1) + k;
        idx.push(i, i + 1, i + cols + 1, i + 1, i + cols + 2, i + cols + 1);
      }
    };
    strip(low, 0);
    if (upr) strip(upr, low.rows);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aRow', new THREE.Float32BufferAttribute(row, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Facing the pitch (+x): make sure the normals point that way.
    const nrm = geo.getAttribute('normal');
    if (nrm.getX(0) < 0) { for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, -nrm.getX(i), -nrm.getY(i), -nrm.getZ(i)); }
    const m = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    const u = this.u;
    u.uRows.value = total;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRow;\nvarying float vRow;\nvarying vec3 vTW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRow = aRow;\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uRise, uTime, uRows;
varying float vRow;
varying vec3 vTW;
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
{
  // One card per supporter: ${TIFO.card} m across, a row deep; a thin dark gap between cards.
  vec2 cell = vec2(floor(vTW.z / ${TIFO.card.toFixed(2)}), floor(vRow));
  vec2 f = vec2(fract(vTW.z / ${TIFO.card.toFixed(2)}), fract(vRow));
  float h = tHash(cell);
  // Cards go up row by row from the front (a little ragged), and come down the same way.
  float at = (cell.y + h * 2.5) / (uRows + 2.5);
  if (at > uRise) discard;
  float gap = step(0.06, f.x) * step(f.x, 0.94) * step(0.08, f.y) * step(f.y, 0.92);
  // Each card at its own slight angle (brightness) and the odd one wobbling.
  float tilt = 0.9 + 0.16 * h + 0.06 * sin(uTime * (1.5 + h * 2.0) + h * 40.0) * step(0.7, h);
  diffuseColor.rgb *= mix(0.25, tilt, gap) * 0.72;
}`);
    };
    m.customProgramCacheKey = () => 'tifo-cards';
    this.mat = m;
    const mesh = new THREE.Mesh(geo, m);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.group.visible = false;
    this.level = 0;
    this.up = false;
  }

  /**
   * One frame. `waiting`: before the first kick-off (the intro, the walk-out and the kick-off
   * itself), when the display goes up; once play starts it comes down.
   */
  update(dt: number, time: number, waiting: boolean) {
    if (!this.mat) return;
    if (waiting && !this.up && this.level <= 0) this.up = true;
    if (!waiting) this.up = false;
    this.level = this.up ? Math.min(1, this.level + dt / TIFO.rise) : Math.max(0, this.level - dt / TIFO.fall);
    this.u.uRise.value = this.level * 1.02;
    this.u.uTime.value = time;
    this.group.visible = this.level > 0.001;
  }

  /** Cards down, ready to go up again for the next match. */
  reset() {
    this.level = 0;
    this.up = false;
    this.group.visible = false;
  }

  dispose() {
    for (const c of this.group.children) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.MeshLambertMaterial).map?.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.group.clear();
    this.mat = null;
    this.level = 0;
  }
}
