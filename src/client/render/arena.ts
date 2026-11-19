// The Harbourside Arena: a two-tier bowl with hospitality boxes, an LED ribbon, a ribbed roof
// with a light ring, rotating LED advertising boards, a tunnel and dugouts on the far side,
// TV cameras, photographers, stewards, ball kids, flares in the crowd and two big screens.
// Approved by Philip from the mock-ups in football-game/stadium-mockups (v3, 17 Nov 2026).
// Everything is generated here; every sponsor is fictional.
//
// Layout: the stands follow a rounded rectangle (half sizes 63 x 47 m, corner radius 16 m)
// pushed outward row by row, so every surface is built as a strip between two "rings".
// The near (+z) straight has no roof: the broadcast and panoramic cameras look over it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { canvasTex } from './textures';
import { bindMoments, buildFlags, FLAG_COUNTS, flagSecond, MOMENTS_GLSL, type FlagSpot } from './crowdlife';
import type { GroundStyle } from '../../shared/grounds';

const L = 52.5;
const W = 34;

export interface ArenaOptions {
  quality: number; // 0 low, 1 medium, 2 high, 3 ultra
  homeColour: number;
  awayColour: number;
  homeName: string;
  awayName: string;
  /** Three-letter codes for the big screens (the same ones the scoreboard uses). */
  homeShort?: string;
  awayShort?: string;
  /** The home club's ground (shared/grounds.ts): size, seats, roof, floodlights. The Harbourside Arena when missing. */
  ground?: GroundStyle;
}

/** The Harbourside Arena's look (the default ground). */
export const DEFAULT_GROUND: GroundStyle = { name: 'The Harbourside Arena', size: 2, lights: 'roof', roof: 0x9aa0aa, seats: 0x24428e, seats2: 0x24428e, cladding: 0x2a2e37, fill: 1 };

/** Tier layout by ground size: lower tier rows, upper tier rows (0: none) and rise, and the roof's overhang. */
export const GROUND_TIERS = [
  { low: 14, up: 0, upRise: 0, roofIn: 3, roofGap: 4.6 },
  { low: 20, up: 14, upRise: 0.56, roofIn: 0, roofGap: 4.8 },
  { low: 24, up: 30, upRise: 0.56, roofIn: -2, roofGap: 8 },
  { low: 26, up: 38, upRise: 0.6, roofIn: -5, roofGap: 6.5 },
] as const;

/** What the arena shows each frame: the score, the clock and how much of the GOAL! takeover is on. */
export interface ArenaInfo {
  goal: number; // 0..1
  score: [number, number];
  clock: number; // seconds of match time
  /** A team on a dangerous attack: the boards chase in its colours (k 0..1). */
  chase?: { team: 0 | 1; k: number };
  /** A near miss or a big save: a short takeover of the boards (k 0..1). */
  flash?: { kind: 'save' | 'close'; k: number };
  /** Live pictures for the big screens (render/bigscreen.ts), when on. */
  feed?: { tex: THREE.Texture | null; mode: 'live' | 'replay' } | null;
  /** An offside check on the big screens (render/var.ts draws the page; key changes redraw it). */
  varPage?: { key: string; draw: (g: CanvasRenderingContext2D) => void } | null;
}

/** A place for someone at pitchside: position and the way they face (yaw about +y, 0 = +z). */
export interface StaffSpot { x: number; z: number; yaw: number }

export interface Arena {
  group: THREE.Group;
  /** Where the photographers, stewards and ball kids stand (render/pitchside.ts brings them to life). */
  staff: { photographers: StaffSpot[]; stewards: StaffSpot[]; ballKids: StaffSpot[] };
  crowdCount: number;
  flareCount: number;
  flagCount: number;
  /** The two big screens and their overlays (hidden while the live feed is drawn). */
  screenMeshes: THREE.Object3D[];
  /** What the big screens show now, for tests: 'goal', 'feed', 'replay', 'score' or 'sponsor'. */
  readonly screenPage: string;
  /** The ground this is. */
  ground: GroundStyle;
  /** Flagpoles along the roof (or the stand tops): base of each pole, for render/clubflags.ts. */
  flagpoles: THREE.Vector3[];
  /** Height of the roof's front edge (the blimp and drone shots keep clear of it). */
  roofHeight: number;
  update(time: number, info: ArenaInfo): void;
}

// ---------- small helpers ----------

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const lambert = (color: THREE.ColorRepresentation, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const faceTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

interface Station { cx: number; cz: number; nx: number; nz: number; R: number }

/** Points round a rounded rectangle; offset d pushes each one out along its normal. */
function bowlStations(A: number, B: number, R: number, seg = 10): Station[] {
  const st: Station[] = [];
  const corners: [number, number, number][] = [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, 1.5 * Math.PI]];
  for (const [sx, sz, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      st.push({ cx: sx * (A - R), cz: sz * (B - R), nx: Math.cos(a), nz: Math.sin(a), R });
    }
  }
  st.push(st[0]);
  return st;
}
const at = (s: Station, d: number, y: number) => new THREE.Vector3(s.cx + s.nx * (s.R + d), y, s.cz + s.nz * (s.R + d));

/** Split long straight segments so features can be cut out of them. */
function subdivide(st: Station[], step: number): Station[] {
  const out: Station[] = [];
  for (let i = 0; i < st.length - 1; i++) {
    out.push(st[i]);
    const a = at(st[i], 0, 0), b = at(st[i + 1], 0, 0), n = Math.floor(a.distanceTo(b) / step);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      out.push({ cx: st[i].cx + (st[i + 1].cx - st[i].cx) * f, cz: st[i].cz + (st[i + 1].cz - st[i].cz) * f, nx: st[i].nx, nz: st[i].nz, R: st[i].R });
    }
  }
  out.push(st[st.length - 1]);
  return out;
}

type Facing = (p: THREE.Vector3) => THREE.Vector3;
const inward: Facing = (p) => new THREE.Vector3(-p.x, 0, -p.z).normalize();
const outward: Facing = (p) => new THREE.Vector3(p.x, 0, p.z).normalize();
const UP: Facing = () => new THREE.Vector3(0, 1, 0);
const DOWN: Facing = () => new THREE.Vector3(0, -1, 0);

/** Make every triangle face the way `facing` says (flipping winding and its uvs). */
function orient(g: THREE.BufferGeometry, facing: Facing) {
  const p = g.attributes.position.array as Float32Array;
  const uv = g.attributes.uv?.array as Float32Array | undefined;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < p.length / 9; t++) {
    a.fromArray(p, t * 9); b.fromArray(p, t * 9 + 3); c.fromArray(p, t * 9 + 6);
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.dot(facing(a)) >= 0) continue;
    for (let k = 0; k < 3; k++) { const s = p[t * 9 + 3 + k]; p[t * 9 + 3 + k] = p[t * 9 + 6 + k]; p[t * 9 + 6 + k] = s; }
    if (uv) for (let k = 0; k < 2; k++) { const s = uv[t * 6 + 2 + k]; uv[t * 6 + 2 + k] = uv[t * 6 + 4 + k]; uv[t * 6 + 4 + k] = s; }
  }
}

/** A strip between two rings (offset dA at height yA, offset dB at height yB). u = metres along ring A. */
function ringSurface(st: Station[], dA: number, yA: number, dB: number, yB: number, facing: Facing, keep?: (mid: THREE.Vector3) => boolean): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [];
  let u = 0;
  for (let i = 0; i < st.length - 1; i++) {
    const a0 = at(st[i], dA, yA), a1 = at(st[i + 1], dA, yA), b0 = at(st[i], dB, yB), b1 = at(st[i + 1], dB, yB);
    const du = a0.distanceTo(a1);
    if (du < 1e-4 && b0.distanceTo(b1) < 1e-4) continue;
    if (!keep || keep(a0.clone().add(a1).multiplyScalar(0.5))) {
      pos.push(...a0.toArray(), ...a1.toArray(), ...b1.toArray(), ...a0.toArray(), ...b1.toArray(), ...b0.toArray());
      uv.push(u, 0, u + du, 0, u + du, 1, u, 0, u + du, 1, u, 1);
    }
    u += du;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  orient(g, facing);
  g.computeVertexNormals();
  return g;
}

/** Points every `step` metres along ring (d, y). */
function along(st: Station[], d: number, y: number, step: number, start = 0): { p: THREE.Vector3; dir: THREE.Vector3 }[] {
  const out: { p: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  let acc = start;
  for (let i = 0; i < st.length - 1; i++) {
    const a = at(st[i], d, y), b = at(st[i + 1], d, y), len = a.distanceTo(b);
    if (len < 1e-4) continue;
    const dir = b.clone().sub(a).normalize();
    for (let t = (step - acc) % step; t < len; t += step) out.push({ p: a.clone().lerp(b, t / len), dir });
    acc = (acc + len) % step;
  }
  return out;
}

const tint = (g: THREE.BufferGeometry, col: THREE.ColorRepresentation) => {
  const c = new THREE.Color(col), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
};
export function box(w: number, h: number, d: number, x: number, y: number, z: number, col: THREE.ColorRepresentation) {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
  g.deleteAttribute('uv');
  return tint(g, col);
}
export function ball(r: number, x: number, y: number, z: number, col: THREE.ColorRepresentation) {
  const g = new THREE.IcosahedronGeometry(r, 1).translate(x, y, z);
  g.deleteAttribute('uv');
  return tint(g, col);
}

// ---------- sponsors and the LED boards ----------

interface Sponsor { name: string; sub?: string; bg: [string, string]; fg: string; serif?: boolean; mark?: string }
export const SPONSORS: Sponsor[] = [
  { name: 'VOLTA', sub: 'MOBILE', bg: ['#1631ff', '#6a2bff'], fg: '#ffffff', mark: 'bolt' },
  { name: 'Harlow Bank', bg: ['#0b3a2c', '#0e5a40'], fg: '#f3d27a', serif: true, mark: 'arch' },
  { name: 'NORTHWIND', bg: ['#b9c3d6', '#9fb0cc'], fg: '#0f2350', mark: 'wind' },
  { name: 'Kettle & Co.', bg: ['#ffcc1f', '#ffb000'], fg: '#1b1405', serif: true },
  { name: 'BRIGHTWELL', sub: 'ENERGY', bg: ['#ff5a0a', '#ff2d55'], fg: '#ffffff', mark: 'sun' },
  { name: 'ELEVENS', bg: ['#050608', '#0b0d12'], fg: '#c6ff1a', mark: 'chev' },
  { name: 'Saltmarsh Cider', bg: ['#6e1428', '#8f1d33'], fg: '#ffe9c7', serif: true },
  { name: 'KESTREL AIR', bg: ['#00a8e8', '#0077c8'], fg: '#ffffff', mark: 'wing' },
  { name: 'LUMORA', bg: ['#2a0b4f', '#7b1fd1'], fg: '#ffffff', mark: 'ring' },
  { name: 'PIXELFORGE', bg: ['#0a0a0a', '#151515'], fg: '#ff2fb3', mark: 'pix' },
  { name: 'BRAKKO TYRES', bg: ['#111111', '#1c1c1c'], fg: '#ffd400', mark: 'tyre' },
  { name: 'ollo', bg: ['#ff3c8e', '#ff6fae'], fg: '#ffffff', mark: 'dots' },
];
const ROW_GOAL = 12, ROW_SAVE = 16, ROW_CLOSE = 17, ROWS = 18;

function drawMark(g: CanvasRenderingContext2D, kind: string, x: number, y: number, s: number, col: string) {
  g.save(); g.fillStyle = col; g.strokeStyle = col; g.lineWidth = s * 0.14;
  const path = (pts: [number, number][], fill = true) => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(x + px * s, y + py * s) : g.moveTo(x + px * s, y + py * s))); g.closePath(); if (fill) g.fill(); else g.stroke(); };
  if (kind === 'bolt') path([[0.2, -0.5], [-0.25, 0.05], [0.02, 0.05], [-0.2, 0.5], [0.3, -0.08], [0.02, -0.08]]);
  if (kind === 'arch') { g.beginPath(); g.arc(x, y + s * 0.3, s * 0.42, Math.PI, 0); g.stroke(); }
  if (kind === 'wind') for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(x - s * 0.45, y - s * 0.25 + i * s * 0.25); g.quadraticCurveTo(x + s * 0.1, y - s * 0.45 + i * s * 0.25, x + s * 0.45, y - s * 0.2 + i * s * 0.25); g.stroke(); }
  if (kind === 'sun') { g.beginPath(); g.arc(x, y, s * 0.22, 0, 7); g.fill(); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; g.beginPath(); g.moveTo(x + Math.cos(a) * s * 0.32, y + Math.sin(a) * s * 0.32); g.lineTo(x + Math.cos(a) * s * 0.48, y + Math.sin(a) * s * 0.48); g.stroke(); } }
  if (kind === 'chev') for (let i = 0; i < 2; i++) { g.beginPath(); g.moveTo(x - s * 0.4 + i * s * 0.35, y - s * 0.4); g.lineTo(x - s * 0.05 + i * s * 0.35, y); g.lineTo(x - s * 0.4 + i * s * 0.35, y + s * 0.4); g.stroke(); }
  if (kind === 'wing') { g.beginPath(); g.moveTo(x - s * 0.5, y + s * 0.2); g.quadraticCurveTo(x, y - s * 0.6, x + s * 0.5, y - s * 0.3); g.quadraticCurveTo(x + s * 0.05, y - s * 0.05, x - s * 0.5, y + s * 0.2); g.fill(); }
  if (kind === 'ring') { g.beginPath(); g.arc(x, y, s * 0.36, 0, 7); g.stroke(); g.beginPath(); g.arc(x + s * 0.12, y - s * 0.1, s * 0.12, 0, 7); g.fill(); }
  if (kind === 'pix') for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2 === 0) g.fillRect(x - s * 0.4 + i * s * 0.27, y - s * 0.4 + j * s * 0.27, s * 0.24, s * 0.24);
  if (kind === 'tyre') { g.beginPath(); g.arc(x, y, s * 0.38, 0, 7); g.stroke(); g.beginPath(); g.arc(x, y, s * 0.14, 0, 7); g.fill(); }
  if (kind === 'dots') for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(x - s * 0.3 + i * s * 0.3, y, s * 0.11, 0, 7); g.fill(); }
  g.restore();
}

/** 1024 x 128 cells: the sponsors, GOAL!, then both clubs and a welcome message. */
function boardAtlas(o: ArenaOptions): THREE.CanvasTexture {
  const CW = 1024, CH = 128;
  const font = (w: number, serif: boolean | undefined, px: number) => `${serif ? 'italic ' : ''}${w} ${px}px ${serif ? 'Georgia, "Times New Roman", serif' : '"Arial Black", Arial, Helvetica, sans-serif'}`;
  const t = canvasTex(CW, CH * ROWS, (g) => {
    SPONSORS.forEach((s, i) => {
      const y = i * CH;
      const grd = g.createLinearGradient(0, y, CW, y + CH);
      grd.addColorStop(0, s.bg[0]); grd.addColorStop(1, s.bg[1]);
      g.fillStyle = grd; g.fillRect(0, y, CW, CH);
      g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = s.fg;
      g.font = font(900, s.serif, s.serif ? 70 : 76);
      const tw = g.measureText(s.name).width;
      let subw = 0;
      if (s.sub) { g.font = font(700, false, 30); subw = g.measureText(s.sub).width + 22; }
      const markW = s.mark ? 110 : 0;
      let x = (CW - (tw + subw + markW)) / 2;
      if (s.mark) { drawMark(g, s.mark, x + 45, y + CH / 2, 90, s.fg); x += markW; }
      g.font = font(900, s.serif, s.serif ? 70 : 76);
      g.fillText(s.name, x, y + CH / 2 + 4);
      if (s.sub) { g.font = font(700, false, 30); g.globalAlpha = 0.85; g.fillText(s.sub, x + tw + 22, y + CH / 2 + 18); g.globalAlpha = 1; }
    });
    let y = ROW_GOAL * CH;
    g.fillStyle = '#b8ff00'; g.fillRect(0, y, CW, CH);
    g.fillStyle = '#0a0d02'; g.globalAlpha = 0.18;
    for (let i = 0; i < 8; i++) { const x = i * 130 - 20; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 40, y); g.lineTo(x + 90, y + CH / 2); g.lineTo(x + 40, y + CH); g.lineTo(x, y + CH); g.lineTo(x + 50, y + CH / 2); g.closePath(); g.fill(); }
    g.globalAlpha = 1; g.font = font(900, false, 100); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('GOAL!', CW / 2, y + CH / 2 + 6);
    const club = (row: number, colour: number, text: string) => {
      y = row * CH;
      g.fillStyle = hex(colour); g.fillRect(0, y, CW, CH);
      const light = ((colour >> 16) * 0.299 + ((colour >> 8) & 255) * 0.587 + (colour & 255) * 0.114) > 150;
      g.fillStyle = light ? '#14181f' : '#ffffff';
      g.fillRect(0, y + 10, CW, 5); g.fillRect(0, y + CH - 15, CW, 5);
      g.font = font(900, false, 60); g.textAlign = 'center';
      g.fillText(text.toUpperCase(), CW / 2, y + CH / 2 + 4, CW - 60);
    };
    club(13, o.homeColour, o.homeName);
    club(15, o.awayColour, o.awayName);
    // Takeovers for a big save and a near miss.
    const banner = (row: number, bg: string, fg: string, text: string) => {
      y = row * CH;
      g.fillStyle = bg; g.fillRect(0, y, CW, CH);
      g.fillStyle = fg; g.globalAlpha = 0.2;
      for (let i = 0; i < 9; i++) g.fillRect(i * 120 - 10, y, 40, CH);
      g.globalAlpha = 1; g.font = font(900, false, 84); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, CW / 2, y + CH / 2 + 5, CW - 40);
    };
    banner(ROW_SAVE, '#0a2fff', '#ffffff', 'WHAT A SAVE!');
    banner(ROW_CLOSE, '#ff6a00', '#1a0a00', 'SO CLOSE!');
    y = 14 * CH;
    g.fillStyle = '#07080c'; g.fillRect(0, y, CW, CH);
    g.fillStyle = '#ffffff'; g.font = font(900, false, 58);
    g.fillText(`WELCOME TO ${(o.ground ?? DEFAULT_GROUND).name.toUpperCase()}`, CW / 2, y + CH / 2 + 4, CW - 60);
  });
  t.anisotropy = 4;
  return t;
}

// u is metres along the board run, v 0..1 up the face. Panels flip between sponsors every
// 5 s with a staggered roll; every seventh change the whole ring shows one brand as a
// marquee (or a club message); uGoal blends in the GOAL! takeover. A pixel grid shows up close.
// Livelier boards (19 Nov): a light sweep runs round the ring now and then, the boards chase in a
// club's colours while it attacks (uChase, the row in uChaseRow), a near miss or a big save takes
// them over briefly (uFlash, uFlashRow), and the ribbon runs a live score ticker (uTicker).
function ledMaterial(atlas: THREE.Texture, panel: number, seedOff: number, bright: number, rows: number, ticker: THREE.Texture | null = null) {
  return new THREE.ShaderMaterial({
    uniforms: {
      atlas: { value: atlas }, uTime: { value: 0 }, uPanel: { value: panel }, uSeed: { value: seedOff }, uBright: { value: bright }, uGoal: { value: 0 }, uRows: { value: rows },
      uChase: { value: 0 }, uChaseRow: { value: 13 }, uChaseDir: { value: 1 }, uFlash: { value: 0 }, uFlashRow: { value: ROW_SAVE },
      uTicker: { value: ticker }, uTickerOn: { value: ticker ? 1 : 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D atlas; uniform float uTime, uPanel, uSeed, uBright, uGoal, uRows;
      uniform float uChase, uChaseRow, uChaseDir, uFlash, uFlashRow, uTickerOn;
      uniform sampler2D uTicker;
      varying vec2 vUv;
      const float N = ${SPONSORS.length}.0; const float ROWS = ${ROWS}.0;
      vec3 logo(float i, vec2 p){ p = clamp(p, vec2(0.002), vec2(0.998)); return texture2D(atlas, vec2(p.x, 1.0 - (i + 1.0 - p.y) / ROWS)).rgb; }
      float takeover(float cyc){ float k = mod(floor(cyc / 7.0), 4.0); return k < 2.5 ? mod(floor(cyc / 7.0) + uSeed, N) : 13.0 + 2.0 * mod(floor(cyc / 28.0), 2.0); }
      void main(){
        float u = vUv.x / uPanel; float pi = floor(u); vec2 lp = vec2(fract(u), vUv.y);
        float period = 5.0;
        float tt = uTime - pi * 0.05;
        float cyc = floor(tt / period); float ph = tt - cyc * period;
        vec3 col;
        if (mod(cyc, 7.0) > 5.5) {
          col = logo(takeover(cyc), vec2(fract((vUv.x - uTime * 6.0) / uPanel), lp.y));
        } else {
          float cur = mod(cyc * 2.0 + mod(pi, 2.0) + uSeed, N);
          float prev = mod((cyc - 1.0) * 2.0 + mod(pi, 2.0) + uSeed, N);
          if (mod(cyc - 1.0, 7.0) > 5.5) prev = takeover(cyc - 1.0);
          float k = smoothstep(0.0, 0.5, ph);
          float s = lp.y + (1.0 - k);
          col = s < 1.0 ? logo(cur, vec2(lp.x, s)) : logo(prev, vec2(lp.x, s - 1.0));
          col += vec3(0.4) * smoothstep(0.45, 0.5, ph) * (1.0 - smoothstep(0.5, 0.95, ph)) * (1.0 - abs(lp.y - 0.5));
        }
        // The ribbon's score ticker: every other marquee runs the score and the clock instead.
        if (uTickerOn > 0.5 && mod(cyc, 7.0) > 5.5 && mod(floor(cyc / 7.0), 2.0) > 0.5) {
          col = texture2D(uTicker, vec2(fract((vUv.x - uTime * 6.0) / (uPanel * 2.0)), clamp(lp.y, 0.01, 0.99))).rgb;
        }
        // A light sweep round the ring every 14 s or so (a diagonal band).
        float sweep = mod(uTime * 38.0 + uSeed * 37.0, 520.0) - 60.0;
        float sd = (vUv.x + lp.y * 1.6 - sweep) / 2.2;
        col += vec3(0.55, 0.6, 0.65) * exp(-sd * sd) * 0.6;
        // Attack chase: the club's row scrolling towards the goal with pulsing chevrons.
        if (uChase > 0.0) {
          float xs = vUv.x - uChaseDir * uTime * 14.0;
          vec3 c = logo(uChaseRow, vec2(fract(xs / uPanel), lp.y));
          float chev = step(0.5, fract((xs + uChaseDir * abs(lp.y - 0.5) * 1.6) / 2.4));
          c *= mix(0.72, 1.15, chev);
          col = mix(col, c, uChase);
        }
        if (uFlash > 0.0) {
          vec3 fl = logo(uFlashRow, vec2(fract((vUv.x - uTime * 7.0) / uPanel), lp.y)) * mix(0.85, 1.1, step(0.5, fract(uTime * 3.0)));
          col = mix(col, fl, uFlash);
        }
        if (uGoal > 0.0) {
          vec3 g = logo(${ROW_GOAL}.0, vec2(fract((vUv.x + uTime * 9.0) / uPanel), lp.y)) * mix(0.75, 1.1, step(0.5, fract(uTime * 2.0)));
          col = mix(col, g, uGoal);
        }
        vec2 gp = vec2(vUv.x * uRows / 0.9, vUv.y * uRows);
        vec2 f = abs(fract(gp) - 0.5);
        float dotm = 1.0 - smoothstep(0.28, 0.5, max(f.x, f.y));
        float w = clamp(1.6 - fwidth(gp.x) * 2.0, 0.0, 1.0);
        col *= mix(1.0, mix(0.35, 1.2, dotm), w * 0.8);
        gl_FragColor = vec4(col * uBright, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------- spectators ----------

const SKIN = [0xf1c7a5, 0xe0a982, 0xc68863, 0x8d5a3b, 0x5b3a26, 0xf5d3b8];
const HAIR = [0x1b1410, 0x2b1d14, 0x3b2a1a, 0x5a4026, 0x8a6a3a, 0xb59a6a, 0x7a7a7a, 0x111111];
const DARKS = [0x15171c, 0x22252c, 0x2d2f36, 0x3a3c44, 0x101114, 0x4b4f5a, 0x5c5f66, 0x6b5a48, 0x7d7f86, 0x2f3d55, 0x4a3a2e, 0x8a8f99];

let fanMat: THREE.MeshLambertMaterial | null = null;
/** Fans move in the vertex shader, driven by the same excitement uniforms as crowd.ts. */
function fanMaterial(): THREE.MeshLambertMaterial {
  if (fanMat) return fanMat;
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    bindMoments(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2 uExcite;
        ${MOMENTS_GLSL}
        attribute float aPart;   // 0 body, 1 head, 2 arm, 3 hair, 4 scarf
        attribute vec3 aSkin;    // per fan
        attribute vec3 aHair;    // per fan
        attribute vec4 aInfo;    // per fan: phase, team (0 home, 1 away, 2 neutral), shade, holds a flare (1) or flag (2)
        attribute float aAct;    // per fan: 1 has a scarf`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float team = aInfo.y;
        float e = team < 0.5 ? uExcite.x : team < 1.5 ? uExcite.y : 0.5 * max(uExcite.x, uExcite.y);
        float ph = aInfo.x;
        vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
        float wv = waveAt(ip);
        float scarf = step(0.5, aAct);
        float sing = sideOf(uSing, team) * scarf;
        float clap = sideOf(uClap, team) * (1.0 - scarf * sideOf(uSing, team));
        float miss = sideOf(uMiss, team);
        transformed.x += sin(uTime * 1.1 + ph * 6.0) * 0.03;
        float jump = smoothstep(0.65, 1.0, e);
        transformed.y += jump * abs(sin(uTime * (7.0 + fract(ph * 13.0) * 3.0) + ph * 40.0)) * 0.3;
        // The wave: up off the seat with the arms in the air as it passes.
        transformed.y += wv * 0.3;
        if (aPart > 1.5 && aPart < 2.5) {
          float holds = (aInfo.w > 0.5 && position.x > 0.0) ? 1.0 : 0.0;
          float arms = max(max(smoothstep(0.5, 0.9, e), holds), max(wv, sing));
          float wiggle = 0.06 * sin(uTime * 8.0 + ph * 20.0) * (1.0 - min(aInfo.w, 1.0));
          // Near miss: hands go to heads (up and in) instead.
          float head = miss * (1.0 - arms);
          transformed.y += arms * (0.58 + wiggle) + head * 0.42;
          transformed.x += arms * sign(position.x) * 0.06 - head * sign(position.x) * 0.1;
          transformed.z -= head * 0.06;
          // Clapping in time with the rest of the stand: arms forward, hands meeting.
          float c = clap * (1.0 - arms) * (1.0 - head);
          transformed.y += c * 0.2;
          transformed.z -= c * 0.2;
          transformed.x -= c * sign(position.x) * (0.08 + 0.07 * abs(sin(uTime * 7.5)));
        }
        if (aPart > 3.5) {
          // Scarf: held up between the hands while the fans sing, twirled over the head at a goal.
          float twirl = scarf * jump * (1.0 - sing);
          float show = max(sing, twirl);
          if (show < 0.02) transformed = vec3(0.0, 1.3, 0.0);
          else {
            float a = twirl * (uTime * 9.0 + ph * 20.0);
            float x = transformed.x;
            transformed.x = x * cos(a);
            transformed.z += x * sin(a) * twirl;
            transformed.y += 0.58 * show - 0.58 + 0.06 * sin(uTime * 3.0 + ph * 9.0) * sing;
            transformed.x *= mix(0.3, 1.0, show);
          }
        }`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          if (aPart > 0.5 && aPart < 1.5) vColor.xyz = aSkin;
          if (aPart > 2.5 && aPart < 3.5) vColor.xyz = aHair;
          if (aPart > 3.5) vColor.xyz = mix(vColor.xyz, vec3(0.95), step(0.62, fract(position.x * 6.5 + 0.31)));
          vColor.xyz *= aInfo.z;
        #endif`);
  };
  fanMat = m;
  return m;
}

/**
 * One fan standing on the tread at the origin, facing -z: about 130 triangles, or 154 with a scarf.
 * Seen from the pitch a fan is a few pixels tall, so hidden caps are left off and heads and hair
 * are kept coarse; supporters without a scarf get a body with no scarf triangles at all.
 */
function fanGeometry(q: number, scarf = true): THREE.BufferGeometry {
  const seg = q >= 3 ? 7 : 6;
  const part = (g: THREE.BufferGeometry, id: number, shade: (y: number) => number = () => 1) => {
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, p = g.attributes.position.array, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = shade(p[i * 3 + 1]);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(id), 1));
    return g.index ? g.toNonIndexed() : g;
  };
  // Torso caps are hidden inside the shoulders and hips.
  const torso = new THREE.CylinderGeometry(0.2, 0.17, 0.62, seg, 1, true).scale(1, 1, 0.62).translate(0, 1.23, 0);
  const shoulders = new THREE.CylinderGeometry(0.22, 0.2, 0.12, seg, 1).scale(1, 1, 0.62).translate(0, 1.5, 0);
  const hips = new THREE.BoxGeometry(0.3, 0.9, 0.2).translate(0, 0.47, 0);
  const arm = (x: number) => new THREE.CylinderGeometry(0.055, 0.05, 0.6, 5, 1, true).rotateZ(x * 0.4).translate(x, 1.2, 0.02);
  const head = new THREE.SphereGeometry(0.105, 6, 4).scale(0.92, 1.08, 1).translate(0, 1.71, 0.01);
  const neck = new THREE.CylinderGeometry(0.055, 0.06, 0.12, 5, 1, true).translate(0, 1.58, 0);
  const hair = new THREE.SphereGeometry(0.112, 6, 2, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.95, 1.05, 1.02).translate(0, 1.73, -0.01);
  const parts = [
    part(torso, 0, (y) => 0.62 + 0.38 * THREE.MathUtils.clamp((y - 0.92) / 0.62, 0, 1)),
    part(shoulders, 0),
    part(hips, 0, () => 0.3),
    part(arm(-0.26), 2), part(arm(0.26), 2),
    part(head, 1), part(neck, 1),
    part(hair, 3),
  ];
  // Scarf held above the head (moved into place, or hidden, in the shader): a striped front and back.
  if (scarf) for (const [ry, z] of [[Math.PI, -0.0375], [0, -0.0225]] as const) parts.push(part(new THREE.PlaneGeometry(0.74, 0.13, 6, 1).rotateY(ry).translate(0, 2.2, z), 4));
  return mergeGeometries(parts);
}

/** A flare: burning core, glow, sparks and rising smoke. Lights only on Ultra. */
interface Flare { pos: THREE.Vector3; seed: number }

function smokeTexture(): THREE.CanvasTexture {
  return canvasTex(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.5, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  });
}

function windowsTexture(): THREE.CanvasTexture {
  return canvasTex(512, 64, (g) => {
    g.fillStyle = '#0c0d12'; g.fillRect(0, 0, 512, 64);
    for (let i = 0; i < 8; i++) {
      const x = i * 64, warm = rnd() < 0.8;
      const grd = g.createLinearGradient(0, 6, 0, 58);
      grd.addColorStop(0, warm ? '#ffd8a0' : '#9fc2ff'); grd.addColorStop(1, warm ? '#c98a4a' : '#4a6aa8');
      g.fillStyle = grd; g.fillRect(x + 3, 6, 58, 52);
      g.fillStyle = 'rgba(10,10,14,0.85)';
      for (let k = 0; k < 3; k++) if (rnd() < 0.7) { const px = x + 10 + k * 18 + rnd() * 6; g.fillRect(px, 30, 9, 28); g.beginPath(); g.arc(px + 4.5, 26, 5, 0, 7); g.fill(); }
    }
  }, [1, 1]);
}

// ---------- pitchside people (one merged, vertex-coloured mesh) ----------

export interface FigureOpts { top: number; bottom?: number; skin?: number; hair?: number; pose?: 'stand' | 'sit' | 'kneel'; vest?: number; scale?: number; extra?: ((hip: number) => THREE.BufferGeometry)[] }
export function figure(o: FigureOpts): THREE.BufferGeometry {
  const bottom = o.bottom ?? 0x1a1d24, skin = o.skin ?? pick(SKIN), hair = o.hair ?? 0x1b1410;
  const parts: THREE.BufferGeometry[] = [];
  const sit = o.pose === 'sit', kneel = o.pose === 'kneel';
  const hip = sit ? 0.5 : kneel ? 0.55 : 0.92;
  if (sit) parts.push(box(0.36, 0.16, 0.5, 0, hip - 0.05, 0.22, bottom), box(0.34, 0.5, 0.14, 0, 0.25, 0.45, bottom));
  else if (kneel) parts.push(box(0.15, 0.5, 0.18, -0.1, 0.25, -0.15, bottom), box(0.15, 0.18, 0.55, -0.1, 0.09, 0, bottom), box(0.15, 0.55, 0.16, 0.1, 0.28, 0.22, bottom), box(0.15, 0.2, 0.45, 0.1, 0.5, 0.05, bottom));
  else parts.push(box(0.15, hip, 0.17, -0.1, hip / 2, 0, bottom), box(0.15, hip, 0.17, 0.1, hip / 2, 0, bottom));
  parts.push(box(0.44, 0.62, 0.25, 0, hip + 0.31, 0, o.top));
  if (o.vest) parts.push(box(0.46, 0.5, 0.27, 0, hip + 0.33, 0, o.vest));
  parts.push(box(0.12, 0.58, 0.13, -0.29, hip + 0.32, 0, o.top), box(0.12, 0.58, 0.13, 0.29, hip + 0.32, 0, o.top));
  parts.push(ball(0.115, 0, hip + 0.78, 0, skin), box(0.24, 0.07, 0.24, 0, hip + 0.87, -0.01, hair));
  for (const f of o.extra ?? []) parts.push(f(hip));
  const g = mergeGeometries(parts);
  const s = o.scale ?? 1;
  g.scale(s, s, s);
  return g;
}

// ---------- the arena ----------

export function buildArena(o: ArenaOptions): Arena {
  seed = 7;
  const q = o.quality;
  const ground = o.ground ?? DEFAULT_GROUND;
  const groundUp = ground.name.toUpperCase();
  const TT = GROUND_TIERS[ground.size];
  const group = new THREE.Group();
  group.name = 'arena';
  const leds: THREE.ShaderMaterial[] = [];
  const staff: Arena['staff'] = { photographers: [], stewards: [], ballKids: [] };
  const atlas = boardAtlas(o);
  const short = (n: string) => n.replace(/[^A-Za-z ]/g, '').trim().slice(0, 3).toUpperCase();
  const homeS = o.homeShort ?? short(o.homeName), awayS = o.awayShort ?? short(o.awayName);
  // The ribbon's ticker (2048 x 128: two board panels wide), redrawn when the score or minute changes.
  const tickC = document.createElement('canvas'); tickC.width = 2048; tickC.height = 128;
  const ticker = new THREE.CanvasTexture(tickC); ticker.colorSpace = THREE.SRGBColorSpace; ticker.anisotropy = 4;
  let tickKey = '';
  const drawTicker = (info: ArenaInfo) => {
    const mins = Math.floor(info.clock / 60);
    const key = `${info.score}|${mins}`;
    if (key === tickKey) return;
    tickKey = key;
    const g = tickC.getContext('2d')!;
    g.fillStyle = '#05060a'; g.fillRect(0, 0, 2048, 128);
    g.textBaseline = 'middle'; g.textAlign = 'left';
    let x = 30;
    const put = (t: string, col: string, px = 70) => { g.font = `900 ${px}px "Arial Black", Arial, sans-serif`; g.fillStyle = col; g.fillText(t, x, 68); x += g.measureText(t).width + 34; };
    g.fillStyle = hex(o.homeColour); g.fillRect(x, 26, 16, 76); x += 34;
    put(homeS, '#ffffff'); put(`${info.score[0]} - ${info.score[1]}`, '#c6ff1a'); put(awayS, '#ffffff');
    g.fillStyle = hex(o.awayColour); g.fillRect(x - 20, 26, 16, 76); x += 20;
    put(`${mins}'`, '#ffd23f');
    put(`LIVE AT ${groundUp}`, '#9aa3b5', 50);
    ticker.needsUpdate = true;
  };
  const people: THREE.BufferGeometry[] = [];
  const person = (opts: FigureOpts, x: number, z: number, yaw: number, y = 0) => people.push(figure(opts).rotateY(yaw).translate(x, y, z));

  // Apron outside the grass, and a concrete walkway along the front of the stands.
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(260, 220), lambert(0x1e2722));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.03;
  group.add(apron);
  const st = bowlStations(63, 47, 16, q > 0 ? 12 : 8);
  const stFine = subdivide(st, 6);
  group.add(new THREE.Mesh(ringSurface(st, -3.2, 0.004, 0, 0.004, UP), lambert(0x3d4048)));

  // ---- LED perimeter boards: rounded corners, a gap on the far side for the tunnel and dugouts ----
  {
    const boardMat = ledMaterial(atlas, 9, 0, 1.15, 28);
    leds.push(boardMat);
    const A = 57.8, B = 40.2, H = 0.95, lean = 0.16;
    const bst = subdivide(bowlStations(A, B, 4.5, 8), 2);
    const pos: number[] = [], uv: number[] = [], back: THREE.BufferGeometry[] = [];
    let u = 0;
    for (let i = 0; i < bst.length - 1; i++) {
      const a = at(bst[i], 0, 0), b = at(bst[i + 1], 0, 0), du = a.distanceTo(b);
      if (du < 1e-4) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      if (!(mid.z < -B + 1 && Math.abs(mid.x) < 26)) {
        const na = new THREE.Vector3(bst[i].nx, 0, bst[i].nz), nb = new THREE.Vector3(bst[i + 1].nx, 0, bst[i + 1].nz);
        const a2 = a.clone().addScaledVector(na, lean).setY(H), b2 = b.clone().addScaledVector(nb, lean).setY(H);
        const a0 = a.clone().setY(0.06), b0 = b.clone().setY(0.06);
        pos.push(...a0.toArray(), ...b0.toArray(), ...b2.toArray(), ...a0.toArray(), ...b2.toArray(), ...a2.toArray());
        uv.push(u, 0, u + du, 0, u + du, 1, u, 0, u + du, 1, u, 1);
        const c = a.clone().addScaledVector(na, 0.25 + lean).add(b.clone().addScaledVector(nb, 0.25 + lean)).multiplyScalar(0.5);
        back.push(box(du + 0.02, H, 0.25, 0, 0, 0, 0x101216).rotateY(-Math.atan2(b.z - a.z, b.x - a.x)).translate(c.x, H / 2 + 0.03, c.z));
      }
      u += du;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    orient(g, inward);
    group.add(new THREE.Mesh(g, boardMat));
    group.add(new THREE.Mesh(mergeGeometries(back), lambert(0xffffff, { vertexColors: true })));
  }

  // ---- stands ----
  // Tiers by the ground's size (the Harbourside Arena: 24 rows below, 30 above).
  type Tier = { d0: number; rows: number; rd: number; rise: number; y0: number };
  const LOW: Tier = { d0: 0, rows: TT.low, rd: 0.8, rise: 0.42, y0: 1.6 };
  const lowTop0 = LOW.y0 + LOW.rows * LOW.rise;
  const UPR: Tier = { d0: LOW.rows * LOW.rd + 2.3, rows: TT.up, rd: 0.8, rise: TT.upRise || 0.56, y0: lowTop0 + 4.52 };
  const twoTier = UPR.rows > 0;
  // Rows deeper under the upper tier, and high under the roof, sit in shade.
  const shadeOf = (T: Tier, r: number) => (T === LOW ? 1 - Math.max(0, (r - LOW.rows / 2) / (T.rows / 2)) * (twoTier ? 0.55 : 0.35) : 1 - (r / T.rows) * 0.45);
  const concrete = 0x5d626d;
  for (const T of twoTier ? [LOW, UPR] : [LOW]) {
    const treads: THREE.BufferGeometry[] = [], risers: THREE.BufferGeometry[] = [];
    const seatCol = T === LOW ? ground.seats : ground.seats2;
    for (let r = 0; r < T.rows; r++) {
      const y = T.y0 + r * T.rise, d = T.d0 + r * T.rd, k = shadeOf(T, r);
      treads.push(tint(ringSurface(st, d, y, d + T.rd, y, UP), new THREE.Color(seatCol).multiplyScalar(k)));
      risers.push(tint(ringSurface(st, d + T.rd, y, d + T.rd, y + T.rise, inward), new THREE.Color(concrete).multiplyScalar(k)));
    }
    group.add(new THREE.Mesh(mergeGeometries([...treads, ...risers]), lambert(0xffffff, { vertexColors: true })));
  }
  group.add(new THREE.Mesh(ringSurface(st, 0, 0, 0, 1.6, inward), lambert(0x111318)));
  const lowTop = LOW.y0 + LOW.rows * LOW.rise;
  const boxD = LOW.d0 + LOW.rows * LOW.rd;
  // Hospitality boxes: warm glazing between the tiers.
  if (twoTier) {
    const win = windowsTexture();
    const g = ringSurface(st, boxD + 0.6, lowTop, boxD + 0.6, lowTop + 2.9, inward);
    const ua = g.attributes.uv.array as Float32Array;
    for (let i = 0; i < ua.length; i += 2) ua[i] /= 30;
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: win, color: 0xe6e6e6 })));
    group.add(new THREE.Mesh(ringSurface(st, boxD, lowTop, boxD + 0.6, lowTop, UP), lambert(concrete)));
  }
  if (twoTier) {
    group.add(new THREE.Mesh(ringSurface(st, boxD - 0.4, lowTop + 2.9, UPR.d0, lowTop + 2.9, DOWN), lambert(0x14161c)));
    group.add(new THREE.Mesh(ringSurface(st, boxD - 0.4, lowTop + 2.9, boxD - 0.4, UPR.y0, inward), lambert(0x0c0d11)));
  }
  if (twoTier) {
    const ribbon = ledMaterial(atlas, 14, 5, 1.05, 36, ticker);
    leds.push(ribbon);
    group.add(new THREE.Mesh(ringSurface(st, boxD - 0.45, lowTop + 3.05, boxD - 0.45, UPR.y0 - 0.15, inward), ribbon));
  }
  const backD = twoTier ? UPR.d0 + UPR.rows * UPR.rd : LOW.rows * LOW.rd + 1;
  const standTop = twoTier ? UPR.y0 + UPR.rows * UPR.rise : lowTop;
  // One tier: a concourse behind the back row.
  if (!twoTier) group.add(new THREE.Mesh(ringSurface(st, boxD, lowTop, boxD + 1.2, lowTop, UP), lambert(concrete)));
  // The roof's front edge sits a few metres above the back of the top tier (41 m at the Harbourside).
  const roofIn = TT.roofIn, roofY = Math.round((standTop + TT.roofGap) * 10) / 10;
  const roofTop = roofY + 3.5;
  group.add(new THREE.Mesh(ringSurface(st, backD, 0, backD, roofY + 3, inward), lambert(0x15171d, { side: THREE.DoubleSide })));
  group.add(new THREE.Mesh(ringSurface(st, backD + 1, 0, backD + 1, roofY + 3.8, outward), lambert(ground.cladding)));
  group.add(new THREE.Mesh(ringSurface(st, backD + 1.05, roofY * 0.63, backD + 1.05, roofY * 0.63 + 1.2, outward), new THREE.MeshBasicMaterial({ color: new THREE.Color(o.homeColour).multiplyScalar(1.6) })));

  // ---- roof (none over the near straight, where the TV gantry looks in) ----
  const roofed = (m: THREE.Vector3) => !(m.z > 40 && Math.abs(m.x) < 48);
  {
    group.add(new THREE.Mesh(ringSurface(stFine, roofIn, roofY, backD + 1, roofTop, DOWN, roofed), lambert(new THREE.Color(ground.roof).multiplyScalar(0.38), { side: THREE.DoubleSide })));
    const rt = canvasTex(64, 64, (g) => { g.fillStyle = '#c9ced8'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#8b919c'; g.fillRect(0, 0, 6, 64); g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 44, 64, 20); }, [1, 1]);
    const rg = ringSurface(stFine, roofIn, roofY + 0.3, backD + 1, roofTop + 0.3, UP, roofed);
    const ua = rg.attributes.uv.array as Float32Array;
    for (let i = 0; i < ua.length; i += 2) { ua[i] /= 3; ua[i + 1] *= 3; }
    group.add(new THREE.Mesh(rg, lambert(ground.roof, { map: rt })));
    group.add(new THREE.Mesh(ringSurface(stFine, roofIn, roofY - 2.6, roofIn, roofY, inward, roofed), lambert(0x0f1014)));
    // The light ring and lamp banks are floodlights: the renderer turns them on at dusk and night.
    if (ground.lights === 'roof') {
    const ring = new THREE.Mesh(ringSurface(stFine, roofIn - 0.05, roofY - 2.3, roofIn - 0.05, roofY - 2.0, inward, roofed), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    ring.userData.lamp = 0.55;
    group.add(ring);
    const lamps: THREE.BufferGeometry[] = [];
    for (const { p } of along(stFine, roofIn + 0.6, roofY - 0.8, 7)) {
      if (!roofed(p)) continue;
      const lg = new THREE.PlaneGeometry(1.6, 0.9);
      lg.lookAt(new THREE.Vector3(-p.x, -40, -p.z));
      lamps.push(lg.translate(p.x, p.y, p.z));
    }
    const lm = new THREE.Mesh(mergeGeometries(lamps), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    lm.userData.lamp = 0.6;
    group.add(lm);
    }
    if (q > 0) {
      const beams: THREE.BufferGeometry[] = [];
      for (const { p } of along(stFine, 0, 0, 12)) {
        if (!roofed(p)) continue;
        const n = new THREE.Vector3(p.x, 0, p.z);
        // Outward normal at this point of the bowl: from the nearest corner centre (or straight out on the sides).
        const cx = Math.sign(p.x) * Math.min(Math.abs(p.x), 63 - 16), cz = Math.sign(p.z) * Math.min(Math.abs(p.z), 47 - 16);
        n.set(p.x - cx, 0, p.z - cz).normalize();
        const p0 = p.clone().addScaledVector(n, roofIn).setY(roofY - 0.9), p1 = p.clone().addScaledVector(n, backD).setY(roofTop - 0.9);
        const bg = new THREE.BoxGeometry(0.5, 1.6, p0.distanceTo(p1));
        bg.applyMatrix4(new THREE.Matrix4().lookAt(p0, p1, new THREE.Vector3(0, 1, 0)));
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        beams.push(bg.translate(mid.x, mid.y, mid.z));
      }
      group.add(new THREE.Mesh(mergeGeometries(beams), lambert(0x3a3e48)));
    }
  }
  // Floodlight pylons in the four corners (grounds without lights along the roof).
  if (ground.lights === 'pylons') {
    const H = Math.max(34, roofTop + 16);
    const legs: THREE.BufferGeometry[] = [], heads: THREE.BufferGeometry[] = [], banks: THREE.BufferGeometry[] = [];
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
      const n = new THREE.Vector3(sx, 0, sz).normalize();
      const base = new THREE.Vector3(sx * (63 - 16), 0, sz * (47 - 16)).addScaledVector(n, 16 + backD + 3.5);
      const yaw = Math.atan2(-base.x, -base.z);
      // A tapering lattice mast: four corner legs and cross braces every 4 m.
      for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const leg = new THREE.CylinderGeometry(0.12, 0.22, H, 6).translate(ox * 0.7, H / 2, oz * 0.7);
        legs.push(leg.rotateY(yaw).translate(base.x, 0, base.z));
      }
      for (let y = 3; y < H - 2; y += 4) {
        legs.push(box(1.6, 0.12, 0.12, 0, y, 0.7, 0x9aa0aa).rotateY(yaw).translate(base.x, 0, base.z), box(1.6, 0.12, 0.12, 0, y, -0.7, 0x9aa0aa).rotateY(yaw).translate(base.x, 0, base.z));
        legs.push(box(0.12, 0.12, 1.6, 0.7, y + 2, 0, 0x9aa0aa).rotateY(yaw).translate(base.x, 0, base.z), box(0.12, 0.12, 1.6, -0.7, y + 2, 0, 0x9aa0aa).rotateY(yaw).translate(base.x, 0, base.z));
      }
      // The head: a frame of lamps tilted down at the pitch.
      const head = new THREE.Group();
      head.position.set(base.x, H + 2.4, base.z);
      head.lookAt(0, -26, 0);
      head.updateMatrixWorld(true);
      heads.push(box(7.6, 5.2, 0.5, 0, 0, -0.35, 0x2a2e36).applyMatrix4(head.matrixWorld));
      for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) {
        banks.push(new THREE.PlaneGeometry(1.0, 0.95).translate(-3.05 + c * 1.22, -1.75 + r * 1.17, 0.02).applyMatrix4(head.matrixWorld));
      }
      // One halo per pylon head (the renderer adds a glow sprite at each lamp === true mesh).
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
      glow.position.copy(head.position);
      glow.userData.lamp = true;
      group.add(glow);
    }
    group.add(new THREE.Mesh(mergeGeometries(legs.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { if (!g.getAttribute('color')) tint(g, 0x8b919c); g.deleteAttribute('uv'); return g; })), lambert(0xffffff, { vertexColors: true })));
    group.add(new THREE.Mesh(mergeGeometries(heads), lambert(0xffffff, { vertexColors: true })));
    const lm = new THREE.Mesh(mergeGeometries(banks), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    lm.userData.lamp = 0.6;
    group.add(lm);
  }

  // The near straight's TV gantry instead of a roof.
  {
    const gy = 34;
    const gantry = mergeGeometries([box(40, 2.6, 4, 0, gy, 47 + 23, 0x22252c), box(40, 0.3, 4.4, 0, gy + 1.45, 47 + 23, 0x3a3e47)]);
    group.add(new THREE.Mesh(gantry, lambert(0xffffff, { vertexColors: true })));
    for (const x of [-18, 18]) group.add(new THREE.Mesh(box(0.6, gy, 0.6, x, gy / 2, 47 + 24.5, 0x5d626d), lambert(0xffffff, { vertexColors: true })));
  }

  // Vomitories with green exit signs.
  {
    const vom: THREE.BufferGeometry[] = [], exits: THREE.BufferGeometry[] = [];
    const y = LOW.y0 + 12 * LOW.rise;
    for (const { p, dir } of along(st, 9.5, y, 32)) {
      const yaw = Math.atan2(dir.x, dir.z);
      const inn = new THREE.Vector3(-p.x, 0, -p.z).normalize();
      vom.push(box(3.2, 2.2, 3.0, 0, 1.1, 0, 0x050506).rotateY(yaw + Math.PI / 2).translate(p.x, y - 1.4, p.z));
      exits.push(box(0.7, 0.25, 0.05, 0, 0, 0, 0xffffff).rotateY(yaw + Math.PI / 2).translate(p.x + inn.x * 1.55, y + 0.95, p.z + inn.z * 1.55));
    }
    group.add(new THREE.Mesh(mergeGeometries(vom), new THREE.MeshBasicMaterial({ vertexColors: true })));
    group.add(new THREE.Mesh(mergeGeometries(exits), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1, 0.35).multiplyScalar(1.6) })));
  }

  // ---- crowd ----
  let crowdCount = 0;
  const flares: Flare[] = [];
  const homeC = [o.homeColour, o.homeColour, 0xd4d8e0, new THREE.Color(o.homeColour).multiplyScalar(0.6).getHex()];
  const awayC = [o.awayColour, o.awayColour, 0xd0d0d4, new THREE.Color(o.awayColour).multiplyScalar(0.6).getHex()];
  const maxFlares = q >= 3 ? 24 : q >= 2 ? 16 : q >= 1 ? 8 : 0;
  // Low: painted crowd on both tiers. Medium: 3D fans in the lower tier, painted upper tier. High/Ultra: 3D everywhere.
  // Painted crowd for tiers without 3D fans: club colours on dark seats, people at real spacing.
  const crowdTex = canvasTex(512, 256, (g) => {
    g.fillStyle = '#161c28';
    g.fillRect(0, 0, 512, 256);
    const pal = [hex(o.homeColour), hex(o.homeColour), hex(o.homeColour), '#d4d8e0', '#2a2c33', hex(o.awayColour), '#8a6a52', '#c9b8a2'];
    for (let y = 0; y < 256; y += 16) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, y + 13, 512, 3);
      for (let x = 2; x < 512; x += 9) {
        if (rnd() > 0.88) continue;
        const k = 0.75 + 0.25 * (y / 256);
        g.globalAlpha = k;
        g.fillStyle = pick(pal);
        g.fillRect(x - 3 + rnd(), y + 6, 6, 7);
        g.fillStyle = pick(['#e0b896', '#a87454', '#6b4430', '#f1d2b4']);
        g.beginPath(); g.arc(x + rnd(), y + 4, 2.6, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 1;
      }
    }
  }, [1, 1]);
  const paint = (T: Tier) => {
    const tex = crowdTex.clone();
    const g = ringSurface(st, T.d0, T.y0 + 0.4, T.d0 + T.rows * T.rd, T.y0 + T.rows * T.rise + 0.4, (p) => new THREE.Vector3(-p.x, 2, -p.z).normalize());
    const ua = g.attributes.uv.array as Float32Array;
    // 512 px = 57 people at 0.56 m; 256 px = 16 rows.
    for (let i = 0; i < ua.length; i += 2) { ua[i] /= 32; ua[i + 1] *= T.rows / 16; }
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    group.add(new THREE.Mesh(g, lambert(0xffffff, { map: tex })));
  };
  const fill = (q >= 3 ? 0.9 : q >= 2 ? 0.78 : 0.55) * ground.fill;
  const tiers3D = (q >= 2 ? [LOW, UPR] : q >= 1 ? [LOW] : []).filter((T) => T.rows > 0);
  if (q < 1) paint(LOW);
  if (q < 2 && twoTier) paint(UPR);
  // Flags and scarves use their own random numbers, so the rest of the ground is laid out as before.
  let lseed = 4242;
  const lr = () => ((lseed = (lseed * 16807) % 2147483647) / 2147483647);
  const flagSpots: FlagSpot[] = [];
  const maxFlags = FLAG_COUNTS[Math.max(0, Math.min(3, q))];
  const flagSpot = (mx: THREE.Matrix4, team: number) => {
    const colour = team === 0 ? o.homeColour : o.awayColour;
    flagSpots.push({ matrix: mx, team, colour, second: flagSecond(colour), pattern: Math.floor(lr() * 3), phase: lr() });
  };
  if (!tiers3D.length) {
    // Low: flags waved from the front rows of the painted lower tier.
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < maxFlags * 6 && flagSpots.length < maxFlags; k++) {
      const i = Math.floor(lr() * (st.length - 1)), r = 1 + Math.floor(lr() * 6);
      const p = at(st[i], LOW.d0 + r * LOW.rd + 0.4, LOW.y0 + r * LOW.rise);
      const team = p.x < -60 ? 0 : p.x > 60 ? 1 : lr() < 0.75 ? 0 : 1;
      if (Math.abs(p.x) < 60 && lr() < 0.5) continue; // mostly behind the goals
      qt.setFromAxisAngle(yAxis, Math.atan2(p.x, p.z));
      flagSpot(m.compose(p, qt, new THREE.Vector3(1, 1, 1)).clone(), team);
    }
  }
  if (tiers3D.length) {
    const mats: THREE.Matrix4[] = [], cols: number[] = [], skin: number[] = [], hair: number[] = [], info: number[] = [], act: number[] = [];
    const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), sc = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    const hand = new THREE.Vector3(0.32, 2.15, 0.02);
    const c = new THREE.Color();
    for (const T of tiers3D) {
      for (let r = 0; r < T.rows; r++) {
        const d = T.d0 + r * T.rd + 0.4, y = T.y0 + r * T.rise, shade = shadeOf(T, r);
        let idx = 0;
        for (let i = 0; i < st.length - 1; i++) {
          const a = at(st[i], d, y), b = at(st[i + 1], d, y), len = a.distanceTo(b);
          if (len < 1e-4) continue;
          for (let t = 0; t < len; t += 0.56) {
            idx++;
            if (idx % 30 < 2) continue; // gangways
            if (rnd() > fill) continue;
            const p = a.clone().lerp(b, t / len);
            const endHome = p.x < -60, endAway = p.x > 60;
            const roll = rnd();
            // Ends: mostly one club. Sides: mostly home, some away, many neutrals.
            const team = endHome ? (roll < 0.7 ? 0 : 2) : endAway ? (roll < 0.65 ? 1 : 2) : roll < 0.45 ? 0 : roll < 0.55 ? 1 : 2;
            c.setHex(team === 0 ? pick(homeC) : team === 1 ? pick(awayC) : pick(DARKS)).multiplyScalar(0.8 + rnd() * 0.25);
            const flare = T === LOW && r > 2 && r < 20 && flares.length < maxFlares && rnd() < (endHome ? 0.009 : endAway ? 0.004 : 0.0005);
            qt.setFromAxisAngle(yAxis, Math.atan2(p.x, p.z) + (rnd() - 0.5) * 0.5);
            const s = 0.88 + rnd() * 0.2;
            sc.set(s * (0.9 + rnd() * 0.25), s, s);
            m.compose(new THREE.Vector3(p.x + (rnd() - 0.5) * 0.12, y, p.z + (rnd() - 0.5) * 0.12), qt, sc);
            mats.push(m.clone());
            cols.push(c.r, c.g, c.b);
            c.setHex(pick(SKIN)); skin.push(c.r, c.g, c.b);
            c.setHex(rnd() < 0.12 ? (team === 1 ? pick(awayC) : pick(homeC)) : pick(HAIR)); hair.push(c.r, c.g, c.b);
            // Some supporters wave a flag (mostly behind the goals, in the front half of each tier).
            const flag = !flare && team < 2 && flagSpots.length < maxFlags && r > 0 && r < T.rows * 0.6 && lr() < (endHome || endAway ? 0.022 : 0.006);
            if (flag) flagSpot(m.clone(), team);
            info.push(rnd(), team, shade, flare ? 1 : flag ? 2 : 0);
            act.push(team < 2 && lr() < 0.38 ? 1 : 0);
            if (flare) flares.push({ pos: hand.clone().applyMatrix4(m), seed: rnd() * 100 });
          }
        }
      }
    }
    crowdCount = mats.length;
    // Fans are drawn in blocks (a slice of a stand, with or without scarves), so the stand behind the
    // camera is skipped instead of every supporter in the ground going through the GPU each frame.
    const geos = [fanGeometry(q, false), fanGeometry(q, true)];
    for (const g of geos) {
      g.computeBoundingSphere();
      // Room for jumping, arms up, the wave and a scarf held high (moved in the vertex shader).
      g.boundingSphere!.radius += 1.2;
    }
    const SECTORS = 12;
    const blocks = new Map<number, number[]>();
    mats.forEach((mx, i) => {
      const x = mx.elements[12], z = mx.elements[14];
      const sector = Math.floor(((Math.atan2(z, x) / (Math.PI * 2)) + 1) * SECTORS) % SECTORS;
      const tier = mx.elements[13] > LOW.y0 + LOW.rows * LOW.rise + 1 ? 1 : 0;
      const key = (tier * SECTORS + sector) * 2 + act[i];
      const list = blocks.get(key);
      if (list) list.push(i); else blocks.set(key, [i]);
    });
    for (const [key, ids] of [...blocks.entries()].sort((x, y) => x[0] - y[0])) {
      const base = geos[key & 1];
      const geo = new THREE.BufferGeometry();
      for (const name of Object.keys(base.attributes)) geo.setAttribute(name, base.attributes[name]);
      geo.boundingSphere = base.boundingSphere;
      const pickN = (src: number[], n: number) => { const out = new Float32Array(ids.length * n); ids.forEach((id, j) => { for (let k = 0; k < n; k++) out[j * n + k] = src[id * n + k]; }); return out; };
      geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(pickN(skin, 3), 3));
      geo.setAttribute('aHair', new THREE.InstancedBufferAttribute(pickN(hair, 3), 3));
      geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(pickN(info, 4), 4));
      geo.setAttribute('aAct', new THREE.InstancedBufferAttribute(pickN(act, 1), 1));
      const mesh = new THREE.InstancedMesh(geo, fanMaterial(), ids.length);
      ids.forEach((id, j) => mesh.setMatrixAt(j, mats[id]));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(pickN(cols, 3), 3);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.name = 'fans';
      group.add(mesh);
    }
  }
  const flagMesh = buildFlags(flagSpots);
  if (flagMesh) group.add(flagMesh);

  // ---- far side: tunnel, dugouts, fourth official ----
  {
    const club = new THREE.Color(o.homeColour);
    for (let i = 0; i < 4; i++) {
      const r = 2.1 - i * 0.04;
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1.6, 20, 1, true, -Math.PI / 2, Math.PI), lambert(i % 2 ? 0xf2f2f2 : 0xe6e8ec, { side: THREE.DoubleSide }));
      seg.rotation.x = Math.PI / 2; seg.position.set(0, 0.35, -46.2 + i * 1.5); group.add(seg);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.02, r + 0.02, 0.25, 20, 1, true, -Math.PI / 2, Math.PI), lambert(club, { side: THREE.DoubleSide }));
      band.rotation.x = Math.PI / 2; band.position.set(0, 0.35, -45.5 + i * 1.5); group.add(band);
    }
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.8), new THREE.MeshBasicMaterial({ color: 0x050507 }));
    mouth.position.set(0, 1.3, -46.98); group.add(mouth);
    const light = ((o.homeColour >> 16) * 0.299 + ((o.homeColour >> 8) & 255) * 0.587 + (o.homeColour & 255) * 0.114) > 150;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), new THREE.MeshBasicMaterial({ map: canvasTex(512, 64, (g) => { g.fillStyle = hex(o.homeColour); g.fillRect(0, 0, 512, 64); g.fillStyle = light ? '#111' : '#fff'; g.font = '900 34px "Arial Black", Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(`THIS IS ${o.homeName.toUpperCase()}`, 256, 34, 490); }) }));
    sign.position.set(0, 3.0, -46.95); group.add(sign);

    const seats: THREE.BufferGeometry[] = [];
    const dugout = (cx: number, colour: number, kit: number) => {
      const len = 14, z0 = -46.6, depth = 3.6;
      people.push(box(len, 0.2, depth, cx, 0.1, z0 + depth / 2, 0x30333a), box(len, 2.4, 0.15, cx, 1.2, z0 + 0.1, 0x16181d));
      const can = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, len, 24, 1, true, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
      can.rotation.z = Math.PI / 2; can.position.set(cx, -0.6, z0 + 0.2); group.add(can);
      for (const ex of [-len / 2, len / 2]) { const f = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.05, 5, 12, Math.PI / 2), lambert(0x9aa0aa)); f.rotation.y = Math.PI / 2; f.position.set(cx + ex, -0.6, z0 + 0.2); group.add(f); }
      for (let row = 0; row < 2; row++) for (let i = 0; i < 11; i++) {
        const x = cx - len / 2 + 0.9 + i * 1.22, z = z0 + 0.7 + row * 1.25, y = 0.2 + row * 0.35;
        seats.push(box(0.62, 0.18, 0.6, x, y + 0.42, z + 0.05, colour), box(0.62, 1.0, 0.18, x, y + 0.95, z - 0.25, colour), box(0.64, 0.06, 0.2, x, y + 1.47, z - 0.25, 0xffffff));
        if (rnd() < 0.6) person({ top: kit, bottom: 0x15171c, pose: 'sit' }, x, z + 0.1, 0, y + 0.32);
      }
      // The managers stand in the technical areas in front (render/managers.ts).
      person({ top: kit, bottom: 0x15171c }, cx + (cx < 0 ? 5.5 : -5.5), -39.4, faceTo(0, -39, -10, 0));
    };
    dugout(-15.5, o.homeColour, new THREE.Color(o.homeColour).multiplyScalar(0.8).getHex());
    dugout(15.5, o.awayColour, new THREE.Color(o.awayColour).multiplyScalar(0.8).getHex());
    group.add(new THREE.Mesh(mergeGeometries(seats), lambert(0xffffff, { vertexColors: true })));
    // Beside the tunnel (not in front of it), so the walk-out camera sees the pitch.
    const OX = 4.5;
    people.push(box(2.2, 0.08, 0.8, OX, 0.78, -41.2, 0x2b2e35), box(0.08, 0.78, 0.7, OX - 1, 0.39, -41.2, 0x2b2e35), box(0.08, 0.78, 0.7, OX + 1, 0.39, -41.2, 0x2b2e35), box(0.7, 0.45, 0.06, OX + 0.4, 1.06, -41.4, 0x0a0a0a));
    // The fourth official and his board are in render/touchline.ts.
  }

  // ---- broadcast and media ----
  const camRig = (x: number, z: number, yaw: number) => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; parts.push(box(0.04, 1.6, 0.04, Math.cos(a) * 0.3, 0.8, Math.sin(a) * 0.3, 0x1a1a1a)); }
    parts.push(box(0.32, 0.36, 0.7, 0, 1.8, 0.05, 0x26282d), box(0.2, 0.2, 0.55, 0, 1.78, 0.62, 0x101010), box(0.18, 0.12, 0.12, 0, 2.05, -0.1, 0x111111));
    people.push(mergeGeometries(parts).rotateY(yaw).translate(x, 0, z));
    person({ top: 0x202329, bottom: 0x15171c }, x - Math.sin(yaw) * 0.85, z - Math.cos(yaw) * 0.85, yaw);
  };
  for (const sx of [-1, 1]) {
    camRig(sx * 60.4, -9.5, faceTo(sx * 60.4, -9.5, 0, 0));
    camRig(sx * 60.4, 9.5, faceTo(sx * 60.4, 9.5, 0, 0));
    // Photographers behind each goal line and ball kids (animated in render/pitchside.ts).
    for (const side of [-1, 1]) for (let i = 0; i < 6; i++) {
      const z = side * (8.5 + i * 2.2), x = sx * (56.6 - rnd() * 0.3);
      staff.photographers.push({ x, z, yaw: faceTo(x, z, 0, 0) });
    }
    for (const sz of [-1, 1]) staff.ballKids.push({ x: sx * 56.8, z: sz * 27, yaw: faceTo(sx * 56.8, sz * 27, 0, 0) });
    staff.ballKids.push({ x: sx * 30, z: 39.2, yaw: Math.PI }, { x: sx * 34, z: -39.2, yaw: 0 });
    // Goal stanchions behind each net.
    for (const z of [-4.2, 4.2]) people.push(box(0.12, 3.2, 0.12, sx * (L + 2.6), 1.6, z, 0xd0202a));
  }
  people.push(box(25, 0.06, 0.06, 39, 0.1, -41.05, 0x8d939c), box(25, 0.06, 0.06, 39, 0.1, -40.75, 0x8d939c), box(1.0, 0.35, 0.8, 34, 0.3, -40.9, 0x202329), box(0.28, 0.3, 0.5, 34, 0.75, -40.7, 0x26282d));
  // Stewards in front of the stands, facing the crowd (animated in render/pitchside.ts).
  for (const { p } of along(st, -1.0, 0, 14)) {
    if (p.z < -45 && Math.abs(p.x) < 24) continue;
    staff.stewards.push({ x: p.x, z: p.z, yaw: faceTo(p.x, p.z, p.x * 2, p.z * 2) });
  }
  people.push(mergeGeometries([box(2.4, 0.6, 1.3, 0, 0.55, 0, 0xf2f2f2), box(0.8, 0.8, 1.3, -0.6, 1.2, 0, 0xf2f2f2), box(2.5, 0.06, 1.35, 0, 1.95, 0, 0x2b2e35), box(0.6, 0.18, 1.32, 0.6, 0.95, 0, 0x2e9d4f)]).rotateY(0.6).translate(-55, 0, -43));
  group.add(new THREE.Mesh(mergeGeometries(people), lambert(0xffffff, { vertexColors: true })));

  // ---- big screens in the two far corners ----
  // Each shows the live pictures (render/bigscreen.ts) with a score strip, a replay after a goal,
  // and now and then the score page or a sponsor; Low (or Big screen "Scores only") paints pages only.
  interface Scr { c: HTMLCanvasElement; tex: THREE.CanvasTexture; sx: number; mesh: THREE.Mesh; paint: THREE.MeshBasicMaterial; live: THREE.MeshBasicMaterial; over: THREE.Mesh; oc: HTMLCanvasElement; otex: THREE.CanvasTexture }
  const screens: Scr[] = [];
  const screenMeshes: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const paint = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff });
    const live = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.12, 1.12, 1.12) });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), paint);
    // Hung under the roof in the far corners; a small ground stands them on top of the corner stands.
    const corner = twoTier ? at({ cx: sx * (63 - 16), cz: -(47 - 16), nx: sx * Math.SQRT1_2, nz: -Math.SQRT1_2, R: 16 }, 10, roofY - 7)
      : at({ cx: sx * (63 - 16), cz: -(47 - 16), nx: sx * Math.SQRT1_2, nz: -Math.SQRT1_2, R: 16 }, backD + 0.5, roofTop + 5.2);
    scr.position.copy(corner); scr.lookAt(0, 10, 0);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(17, 9, 0.8), lambert(0x0a0b0e));
    frame.position.copy(corner).addScaledVector(scr.getWorldDirection(new THREE.Vector3()), -0.45); frame.quaternion.copy(scr.quaternion);
    // The overlay (LIVE / REPLAY tag and the score strip) just in front of the picture.
    const oc = document.createElement('canvas'); oc.width = 512; oc.height = 256;
    const otex = new THREE.CanvasTexture(oc); otex.colorSpace = THREE.SRGBColorSpace;
    const over = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshBasicMaterial({ map: otex, transparent: true, depthWrite: false }));
    over.position.copy(corner).addScaledVector(scr.getWorldDirection(new THREE.Vector3()), 0.04); over.quaternion.copy(scr.quaternion);
    over.visible = false;
    group.add(scr, frame, over);
    if (!twoTier) for (const k of [-5, 5]) {
      // Two legs down from the screen to the roof.
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(scr.quaternion);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.4, 0.4), lambert(0x30333a));
      leg.position.copy(corner).addScaledVector(scr.getWorldDirection(new THREE.Vector3()), -0.6).addScaledVector(right, k);
      leg.position.y -= 6.1;
      group.add(leg);
    }
    screens.push({ c, tex, sx, mesh: scr, paint, live, over, oc, otex });
    screenMeshes.push(scr, over);
  }
  let screenKey = '', overKey = '', screenPage = 'score';
  const drawScreens = (time: number, info: ArenaInfo) => {
    const goal = info.goal > 0.5;
    const feed = info.feed && info.feed.tex ? info.feed : null;
    // With live pictures: 30 s of pictures, then 10 s of the score (left) and a sponsor (right).
    const cycle = Math.floor(time / 10) % 4;
    const mins = Math.floor(info.clock / 60), secs = Math.floor(info.clock) % 60;
    const clock = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (!goal && info.varPage) {
      // VAR: the offside diagram takes over both screens.
      screenPage = 'var';
      for (const s of screens) { s.mesh.material = s.paint; s.over.visible = false; }
      const key = `var|${info.varPage.key}`;
      if (key !== screenKey) {
        screenKey = key;
        for (const { c, tex } of screens) { info.varPage.draw(c.getContext('2d')!); tex.needsUpdate = true; }
      }
      return;
    }
    const showFeed = !goal && !!feed && (feed.mode === 'replay' || cycle < 3);
    screenPage = goal ? 'goal' : showFeed ? (feed!.mode === 'replay' ? 'replay' : 'feed') : 'score';
    for (const s of screens) {
      s.mesh.material = showFeed ? s.live : s.paint;
      s.over.visible = showFeed;
      if (showFeed && s.live.map !== feed!.tex) { s.live.map = feed!.tex; s.live.needsUpdate = true; }
    }
    if (showFeed) {
      const ok = `${feed!.mode}|${info.score}|${clock}|${Math.floor(time * 1.5) % 2}`;
      if (ok !== overKey) {
        overKey = ok;
        for (const s of screens) {
          const g = s.oc.getContext('2d')!;
          g.clearRect(0, 0, 512, 256);
          g.textBaseline = 'middle';
          // Tag, top left.
          const replay = feed!.mode === 'replay';
          g.fillStyle = replay ? '#ffd23f' : 'rgba(5,6,10,0.75)'; g.fillRect(14, 12, replay ? 118 : 86, 30);
          g.font = '900 20px "Arial Black", Arial'; g.textAlign = 'left';
          if (!replay) { g.fillStyle = Math.floor(time * 1.5) % 2 ? '#ff2a2a' : '#7a1010'; g.beginPath(); g.arc(30, 27, 6, 0, 7); g.fill(); }
          g.fillStyle = replay ? '#111' : '#fff'; g.fillText(replay ? 'REPLAY' : 'LIVE', replay ? 24 : 42, 28);
          // Score strip, bottom.
          g.fillStyle = 'rgba(5,6,10,0.82)'; g.fillRect(96, 206, 320, 36);
          g.fillStyle = hex(o.homeColour); g.fillRect(96, 206, 8, 36); g.fillStyle = hex(o.awayColour); g.fillRect(408, 206, 8, 36);
          g.fillStyle = '#fff'; g.font = '900 22px "Arial Black", Arial'; g.textAlign = 'center';
          g.fillText(`${homeS}  ${info.score[0]}-${info.score[1]}  ${awayS}`, 228, 225);
          g.fillStyle = '#c6ff1a'; g.font = '800 18px Arial'; g.fillText(clock, 372, 225);
          s.otex.needsUpdate = true;
        }
      }
      return;
    }
    const page = feed ? (cycle === 3 ? 1 : 0) : Math.floor(time / 8) % 2;
    if (!goal) screenPage = page === 0 ? 'score' : 'sponsor';
    const key = `${goal}|${page}|${info.score}|${mins}:${secs}|${Math.floor(time / 16)}`;
    if (key === screenKey) return;
    screenKey = key;
    for (const { c, tex, sx } of screens) {
      const g = c.getContext('2d')!;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      if (goal) {
        g.fillStyle = '#b8ff00'; g.fillRect(0, 0, 512, 256);
        g.fillStyle = '#05060a'; g.font = '900 100px "Arial Black", Arial'; g.fillText('GOAL!', 256, 112);
        g.font = '800 28px Arial'; g.fillText(`${homeS} ${info.score[0]} - ${info.score[1]} ${awayS}`, 256, 200);
      } else if (sx < 0 || page === 0) {
        const grd = g.createLinearGradient(0, 0, 512, 256); grd.addColorStop(0, '#0d1430'); grd.addColorStop(1, '#2a0b4f'); g.fillStyle = grd; g.fillRect(0, 0, 512, 256);
        g.fillStyle = hex(o.homeColour); g.fillRect(24, 72, 200, 82); g.fillStyle = hex(o.awayColour); g.fillRect(288, 72, 200, 82);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(24, 72, 200, 82); g.fillRect(288, 72, 200, 82);
        g.fillStyle = '#fff'; g.font = '900 40px "Arial Black", Arial';
        g.fillText(homeS, 124, 114); g.fillText(awayS, 388, 114);
        g.font = '900 60px "Arial Black", Arial'; g.fillText(`${info.score[0]}-${info.score[1]}`, 256, 114);
        g.font = '700 32px Arial'; g.fillStyle = '#c6ff1a'; g.fillText(clock, 256, 200);
        g.fillStyle = '#9aa3b5'; g.font = '700 18px Arial'; g.fillText(groundUp, 256, 34, 480);
      } else {
        const s = SPONSORS[Math.floor(time / 16) % SPONSORS.length];
        g.fillStyle = s.bg[0]; g.fillRect(0, 0, 512, 256);
        g.fillStyle = s.fg; g.font = `900 56px ${s.serif ? 'Georgia' : '"Arial Black", Arial'}`; g.fillText(s.name, 256, 128, 480);
      }
      tex.needsUpdate = true;
    }
  };

  // ---- flares ----
  const halos: THREE.Sprite[] = [], smoke: THREE.Sprite[] = [], lights: THREE.PointLight[] = [];
  let sparks: THREE.Points | null = null;
  const SPARKS = 22, PUFFS = q >= 3 ? 10 : 7;
  if (flares.length) {
    const tex = smokeTexture();
    const sticks: THREE.BufferGeometry[] = [], cores: THREE.BufferGeometry[] = [];
    const haloMat = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(1, 0.16, 0.08).multiplyScalar(1.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    for (const f of flares) {
      sticks.push(box(0.05, 0.32, 0.05, f.pos.x, f.pos.y + 0.06, f.pos.z, 0x2a1a12));
      cores.push(ball(0.09, f.pos.x, f.pos.y + 0.26, f.pos.z, 0xffffff));
      const h = new THREE.Sprite(haloMat);
      h.position.set(f.pos.x, f.pos.y + 0.26, f.pos.z);
      h.userData.f = f;
      halos.push(h); group.add(h);
      for (let k = 0; k < PUFFS; k++) {
        const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5 }));
        sm.userData = { f, k, dx: rnd() - 0.5, dz: rnd() - 0.5 };
        smoke.push(sm); group.add(sm);
      }
    }
    group.add(new THREE.Mesh(mergeGeometries(sticks), lambert(0xffffff, { vertexColors: true })));
    group.add(new THREE.Mesh(mergeGeometries(cores), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.35, 0.25).multiplyScalar(8) })));
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flares.length * SPARKS * 3), 3));
    sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color: new THREE.Color(1, 0.6, 0.3).multiplyScalar(4), size: 0.07, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sparks.frustumCulled = false;
    group.add(sparks);
    if (q >= 3) for (const f of flares.slice(0, 4)) {
      const pl = new THREE.PointLight(0xff2a10, 90, 18, 1.5);
      pl.position.copy(f.pos).addScaledVector(new THREE.Vector3(-f.pos.x, 0, -f.pos.z).normalize(), 0.8).y += 0.5;
      pl.userData.f = f;
      lights.push(pl); group.add(pl);
    }
  }
  const updateFlares = (time: number) => {
    const flick = (f: Flare, k = 1) => 0.75 + 0.25 * Math.sin(time * 31 * k + f.seed) * Math.sin(time * 17.3 + f.seed * 2);
    for (const h of halos) h.scale.setScalar(1.2 + flick(h.userData.f as Flare) * 0.5);
    for (const l of lights) l.intensity = 80 * flick(l.userData.f as Flare, 0.8) + 25;
    for (const sm of smoke) {
      const { f, k, dx, dz } = sm.userData as { f: Flare; k: number; dx: number; dz: number };
      const age = (time * 0.16 + k / PUFFS + f.seed) % 1;
      sm.position.set(f.pos.x + dx * 1.6 * age * 3 + Math.sin(time * 0.5 + k) * 0.3 * age, f.pos.y + 0.4 + age * 12, f.pos.z + dz * 1.6 * age * 3);
      const s = 0.8 + age * 8.5;
      sm.scale.set(s, s, 1);
      const warm = Math.max(0, 1 - age * 2.2);
      (sm.material as THREE.SpriteMaterial).color.setRGB(0.66 + warm * 0.34, 0.52 - warm * 0.3, 0.54 - warm * 0.36);
      (sm.material as THREE.SpriteMaterial).opacity = 0.7 * Math.min(1, age * 6) * Math.pow(1 - age, 1.3);
    }
    if (sparks) {
      const a = sparks.geometry.attributes.position.array as Float32Array;
      flares.forEach((f, fi) => {
        for (let i = 0; i < SPARKS; i++) {
          const ph = (time * 1.7 + i / SPARKS + f.seed) % 1, ang = i * 2.399 + f.seed, sp = 0.9 + ((i * 37) % 10) / 10;
          const j = (fi * SPARKS + i) * 3;
          a[j] = f.pos.x + Math.cos(ang) * sp * ph * 0.9;
          a[j + 1] = f.pos.y + 0.3 + sp * ph * 1.4 - 2.45 * ph * ph;
          a[j + 2] = f.pos.z + Math.sin(ang) * sp * ph * 0.9;
        }
      });
      sparks.geometry.attributes.position.needsUpdate = true;
    }
  };

  // Flagpoles on the back of the roof: along the far side and both ends (render/clubflags.ts flies the flags).
  const flagpoles: THREE.Vector3[] = [];
  for (const { p } of along(st, backD + 0.4, roofTop + 0.3, q >= 2 ? 18 : 26, 9)) {
    if (p.z > 20) continue;
    flagpoles.push(p);
  }

  return {
    group,
    staff,
    ground,
    flagpoles,
    roofHeight: roofY,
    crowdCount,
    flareCount: flares.length,
    flagCount: flagSpots.length,
    screenMeshes,
    get screenPage() { return screenPage; },
    update(time, info) {
      const chase = info.chase && info.goal < 0.05 ? info.chase : null;
      const flash = info.flash && info.goal < 0.05 ? info.flash : null;
      for (const m of leds) {
        const u = m.uniforms;
        u.uTime.value = time; u.uGoal.value = info.goal;
        u.uChase.value = chase ? chase.k : 0;
        if (chase) { u.uChaseRow.value = chase.team === 0 ? 13 : 15; u.uChaseDir.value = chase.team === 0 ? 1 : -1; }
        u.uFlash.value = flash ? flash.k : 0;
        if (flash) u.uFlashRow.value = flash.kind === 'save' ? ROW_SAVE : ROW_CLOSE;
      }
      drawTicker(info);
      updateFlares(time);
      drawScreens(time, info);
    },
  };
}
