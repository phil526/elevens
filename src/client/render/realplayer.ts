// Realistic footballer: a scanned-looking skinned mesh generated with Higgsfield (Meshy
// image-to-3D, auto-rigged) driven by motion-captured clips (idle, walk, jog, sprint, kick, slide).
//
// The kit is a chroma key in the source texture; scripts/build-players.mjs turns it into grey
// shading plus a mask so each club's colours are applied here in the shader.
//
// Locomotion blends the clips by ground speed with one shared gait phase (so blending never
// crosses the legs) advanced by distance travelled (so feet don't slide). The kick clip is
// time-warped so the boot meets the ball exactly when the simulation releases it, and the slide
// clip is warped onto the simulation's slide and the time spent down afterwards. Every other
// action (tackles, slides when the slide clip is missing, keeper dives and catches, headers, throw-ins, skills, celebrations,
// jockeying) reuses the procedural pose solver from player.ts, mapped onto the skeleton.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER } from '../../shared/config';
import { handWindup } from '../../shared/kick';
import { footProfile, type Kit } from '../../shared/teams';
import { KIT_PATTERN_GLSL, noSponsor, patternIndex, SPONSOR_BOX, sponsorColour, sponsorTexture } from './kitstyle';
import { BADGE_SPOT, badgeTexture, kitClub } from './badgetex';
import type { ViewPlayer } from '../view';
import { BRX, BRZ, BY, ELX, ERX, HLX, HLZ, HRX, HRZ, KLX, KRX, LEGS, NKX, PlayerModel, SLX, SLZ, SPX, SRX, SRZ, UPPER } from './player';
import type { ReactionFrame } from './reactions';
import { Hair, type HairStyle } from './hair';
import { GaitTracker, gestureParts, solveLeg, type Gesture } from './motion';
/** A call for the ball moves only the right arm. */
const RIGHT_ARM: ReadonlySet<Seg> = new Set(['armR', 'foreR'] as Seg[]);
const ARMS: ReadonlySet<Seg> = new Set(['armL', 'foreL', 'armR', 'foreR'] as Seg[]);
import { canvasTex, numberTexture } from './textures';
import { readableOn } from './look';

const BODIES = [
  { file: 'body-a', tone: 0xe6b48e },
  { file: 'body-b', tone: 0x5c3d2a },
  { file: 'body-c', tone: 0xb98258 },
];
const LOCO = ['idle', 'walk', 'jog', 'sprint'] as const;
// How much the compact arm pump overrides the captured arms when running.
const ARM_PUMP = 0.15;
/** Walking arms: how far (radians) each upper arm hangs out from the side of the body. */
const WALK_ARM_OUT = 0.18;
/** Walking arms: forearm turn (radians, about the hanging forearm) that brings the palms round to the thighs. */
const WALK_FORE_TWIST = 1.5;
/** Walking posture targets (radians): pelvis, chest and neck lean forward, face pitch below the bind pose's. */
const WALK_POSTURE = { pelvis: 0, chest: 0.04, neck: 0.04, face: 0 } as const;
// Game speeds (m/s) each locomotion clip represents: walk, jogging pace, sprinting.
const LOCO_SPEED = { walk: 1.7, jog: 5.0, sprint: 7.9 } as const;
// Captured one-shot actions: keeper side leap and jumping catch, jumping header, goal celebrations.
const SHOTS = ['dive', 'catch', 'header', 'cheera', 'cheerb', 'cheerc'] as const;
const CHEERS = ['cheera', 'cheerb', 'cheerc'] as const;
type ShotName = (typeof SHOTS)[number];
type ClipName = (typeof LOCO)[number] | 'kick' | 'slide' | ShotName;

interface ClipSrc {
  clip: THREE.AnimationClip;
  rig: THREE.Object3D; // the skeleton the clip was authored on (bind pose kept in restChar)
  restChar: Map<string, THREE.Quaternion>;
  hipsRest: THREE.Vector3; // rest position of the Hips bone in the rig the clip was made on
  speed: number; // ground speed the clip was authored for (m/s, in its own rig's scale)
  phase0: number; // time at which the left foot is furthest forward
  cycle: number; // duration of one gait cycle (a clip may hold several)
  contact: number; // kick: time the boot meets the ball
  backswing: number; // kick: time the kicking foot is furthest back before contact
  slide: { drop: number; low: number; rise: number; end: number }; // slide: hips start to fall, reach the ground, start to rise, are back up
  toeY: number[]; // height of the lower toe over the clip, sampled evenly (used to keep the slide on the ground)
}

interface Body {
  scene: THREE.Group;
  mesh: THREE.SkinnedMesh;
  material: THREE.MeshStandardMaterial;
  kitMask: THREE.Texture;
  hipsRest: THREE.Vector3;
  backZ: number; // depth of the shirt's back at number height
  nameZ: number; // depth of the shirt's back just above the number
  shorts: THREE.Vector3; // front of the left thigh on the shorts, for the shorts number
  band: { pos: THREE.Vector3; dir: THREE.Vector3; r: number } | null; // captain's armband on the left upper arm
  tone: THREE.Color;
  /** Jaw hinge (bind pose, metres: y, z) for an open mouth, and the hair's mean brightness. */
  face: { hingeY: number; hingeZ: number; hairLum: number };
}

/**
 * Per-vertex kit detail in bind pose, stored as attribute aKit = (trim, boot, glove):
 * trim marks shirt and sleeve vertices bordering bare skin (collar and cuffs),
 * boot the bare vertices at the feet, glove the bare vertices past the wrists.
 * Works from 3D neighbours, so UV seams never produce stray trim lines.
 */
function kitDetail(mesh: THREE.SkinnedMesh, scene: THREE.Object3D, bmp: ImageBitmap) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  const n = pos.count;
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  // Category per vertex: 0 bare (skin, hair, boots), 1 shirt, 2 sleeves, 3 shorts, 4 socks.
  const cat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.min(bmp.width - 1, Math.max(0, Math.floor(uv.getX(i) * bmp.width)));
    const y = Math.min(bmp.height - 1, Math.max(0, Math.floor(uv.getY(i) * bmp.height)));
    const o = (y * bmp.width + x) * 4;
    let best = 0, bv = 110;
    for (let c = 0; c < 4; c++) if (px[o + c] > bv) { bv = px[o + c]; best = c + 1; }
    cat[i] = best;
  }
  const P = (i: number) => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  // Spatial hash of the bare vertices above the boots (skin), 3 cm cells.
  const cell = 0.03, grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) if (cat[i] === 0 && pos.getY(i) > 0.16) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  const near = (i: number, r: number) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${Math.floor(x / cell) + dx},${Math.floor(y / cell) + dy},${Math.floor(z / cell) + dz}`);
      if (list) for (const j of list) { const ex = pos.getX(j) - x, ey = pos.getY(j) - y, ez = pos.getZ(j) - z; if (ex * ex + ey * ey + ez * ez < r * r) return true; }
    }
    return false;
  };
  // Wrists and forearms in bind pose. The skinned mesh's vertices are already in scene units
  // (metres) even though the armature is scaled, so joints are compared in world space.
  scene.updateMatrixWorld(true);
  const local = (name: string) => { const o = scene.getObjectByName(name); return o ? o.getWorldPosition(new THREE.Vector3()) : null; };
  const hands = (['Left', 'Right'] as const).map((s) => ({ wrist: local(`${s}Hand`), fore: local(`${s}ForeArm`) }));
  // Clean geometric bands rather than "next to skin" (which came out blotchy): the collar is the
  // top 2.5 cm of shirt in each slice around the neck, a cuff the last 2.5 cm of each sleeve.
  const trim = new Float32Array(n);
  const neck = local('neck') ?? new THREE.Vector3(0, 1.5, 0);
  const SECT = 32, top = new Float32Array(SECT).fill(-1);
  const sector = (i: number) => Math.floor(((Math.atan2(pos.getZ(i) - neck.z, pos.getX(i) - neck.x) + Math.PI) / (2 * Math.PI)) * SECT) % SECT;
  for (let i = 0; i < n; i++) if (cat[i] === 1 && pos.getY(i) > neck.y - 0.25) top[sector(i)] = Math.max(top[sector(i)], pos.getY(i));
  for (let i = 0; i < n; i++) if (cat[i] === 1 && top[sector(i)] > 0 && pos.getY(i) > top[sector(i)] - 0.025) trim[i] = 1;
  for (const side of ['Left', 'Right'] as const) {
    const sh = local(`${side}Arm`), el = local(`${side}ForeArm`);
    if (!sh || !el) continue;
    const dir = el.clone().sub(sh).normalize();
    const mine = (i: number) => cat[i] === 2 && Math.sign(pos.getX(i)) === Math.sign(sh.x);
    let tmax = -1;
    for (let i = 0; i < n; i++) if (mine(i)) tmax = Math.max(tmax, P(i).sub(sh).dot(dir));
    for (let i = 0; i < n; i++) if (mine(i) && P(i).sub(sh).dot(dir) > tmax - 0.025) trim[i] = 1;
  }
  void near;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (cat[i] > 0) { a[i * 3] = trim[i]; continue; }
    const y = pos.getY(i);
    if (y < 0.13) { a[i * 3 + 1] = 1; continue; }
    const v = P(i);
    for (const h of hands) {
      if (!h.wrist || !h.fore) continue;
      const along = v.clone().sub(h.wrist).dot(h.wrist.clone().sub(h.fore).normalize());
      if (along > -0.02 && v.distanceTo(h.wrist) < 0.24) a[i * 3 + 2] = 1;
    }
  }
  g.setAttribute('aKit', new THREE.BufferAttribute(a, 3));
  // Shorts number spot: front of the left thigh, 10-20 cm below the waistband.
  let front = new THREE.Vector3(0.1, 0.8, 0.12), fz = -1;
  for (let i = 0; i < n; i++) if (cat[i] === 3 && Math.abs(pos.getX(i)) > 0.04 && Math.abs(pos.getX(i)) < 0.18 && pos.getY(i) > 0.62 && pos.getY(i) < 0.86 && pos.getZ(i) > fz) { fz = pos.getZ(i); front = P(i); }
  // Armband: a third of the way down the left upper arm, sized to the sleeve-free arm.
  let band: Body['band'] = null;
  const sh = local('LeftArm'), el = local('LeftForeArm');
  if (sh && el) {
    const dir = el.clone().sub(sh).normalize();
    const c = sh.clone().lerp(el, 0.42);
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const d = P(i).sub(c);
      const t = d.dot(dir);
      if (Math.abs(t) < 0.02) { const r = d.sub(dir.clone().multiplyScalar(t)).length(); if (r < 0.12) { sum += r; cnt++; } }
    }
    if (cnt) band = { pos: c, dir, r: (sum / cnt) * 1.12 };
  }
  return { front, band };
}

/**
 * Face and hair from the bind-pose mesh and its albedo: an `aFace` attribute per vertex with
 * x = hair (and beard and brows: darker than the cheeks and coloured unlike them, above the chin),
 * y = jaw (the chin and lower lip, which swing down about a hinge when the mouth opens),
 * z = lip line (darkened as the mouth opens, showing the inside of the mouth).
 * The nose is the front-most point of the head's centre line; the mouth sits 4 cm below it.
 */
export function faceDetail(mesh: THREE.SkinnedMesh, albedo: CanvasImageSource & { width: number; height: number } | null) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  const n = pos.count;
  let noseY = 1.66, noseZ = -1;
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(pos.getX(i)) < 0.012 && y > 1.58 && y < 1.72 && z > noseZ) { noseZ = z; noseY = y; }
  }
  const mouthY = noseY - 0.042, chinY = noseY - 0.078;
  const face = { hingeY: mouthY + 0.03, hingeZ: -0.04, hairLum: 0.12 };
  const a = new Float32Array(n * 3);
  // Jaw: the front of the head below the mouth line, fading out towards the ears and down the neck.
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (y < chinY - 0.035 || y > mouthY + 0.004 || z < -0.02) continue;
    const lip = 1 - sm01((y - (mouthY - 0.006)) / 0.01);
    const side = 1 - sm01((Math.abs(x) - 0.035) / 0.04);
    const under = sm01((y - (chinY - 0.035)) / 0.025);
    a[i * 3 + 1] = lip * side * under * sm01((z + 0.02) / 0.04);
  }
  // Lip line: the narrow band either side of the mouth that opens up (dark inside) when the jaw drops.
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (z < 0.03 || Math.abs(x) > 0.032) continue;
    a[i * 3 + 2] = (1 - sm01(Math.abs(y - (mouthY - 0.001)) / 0.006)) * (1 - sm01((Math.abs(x) - 0.018) / 0.014));
  }
  if (albedo && albedo.width > 0) {
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(albedo.width, albedo.height) : Object.assign(document.createElement('canvas'), { width: albedo.width, height: albedo.height });
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(albedo, 0, 0);
    const px = ctx.getImageData(0, 0, albedo.width, albedo.height).data;
    const col = (i: number) => {
      const x = Math.min(albedo.width - 1, Math.max(0, Math.floor(uv.getX(i) * albedo.width)));
      const y = Math.min(albedo.height - 1, Math.max(0, Math.floor(uv.getY(i) * albedo.height)));
      const o = (y * albedo.width + x) * 4;
      return [px[o] / 255, px[o + 1] / 255, px[o + 2] / 255];
    };
    // Cheek colour: the sides of the face between the mouth and the nose.
    const sk = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.abs(pos.getX(i)), y = pos.getY(i), z = pos.getZ(i);
      if (x > 0.035 && x < 0.06 && y > mouthY && y < noseY && z > 0.02) { const c = col(i); sk[0] += c[0]; sk[1] += c[1]; sk[2] += c[2]; cnt++; }
    }
    if (cnt > 3) {
      for (let k = 0; k < 3; k++) sk[k] /= cnt;
      const skL = sk[0] * 0.3 + sk[1] * 0.59 + sk[2] * 0.11;
      let hl = 0, hc = 0;
      for (let i = 0; i < n; i++) {
        const y = pos.getY(i);
        if (y < chinY - 0.03) continue;
        const c = col(i);
        const L = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
        const d = Math.hypot(c[0] / Math.max(L, 0.02) - sk[0] / skL, c[1] / Math.max(L, 0.02) - sk[1] / skL, c[2] / Math.max(L, 0.02) - sk[2] / skL);
        const dark = 1 - sm01((L / skL - 0.45) / 0.3);
        // Above the brow line anything darker than skin is hair; on the face it must also differ in colour.
        const w = y > noseY + 0.06 ? dark : dark * sm01((d - 0.12) / 0.2);
        a[i * 3] = w;
        if (w > 0.6) { hl += L; hc++; }
      }
      if (hc) face.hairLum = hl / hc;
    }
  }
  g.setAttribute('aFace', new THREE.BufferAttribute(a, 3));
  // Expressions (aFace2): x = brows (raised in joy, knitted down in effort and frustration),
  // y = mouth corners (up in a smile, down in a frown; +1 right, -1 left), z = cheeks and lower
  // lids (pushed up in a grin or a squint).
  const e = new Float32Array(n * 3);
  const eyeY = noseY + 0.034, browY = noseY + 0.056;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), ax = Math.abs(x);
    if (z < 0.0 || y < chinY - 0.02 || y > browY + 0.04) continue;
    const front = sm01((z - 0.0) / 0.04);
    // Brows: a band above the eyes, strongest over them, fading towards the temples and the forehead.
    const bw = (1 - sm01(Math.abs(y - browY) / 0.022)) * (1 - sm01((ax - 0.05) / 0.02)) * sm01((ax - 0.004) / 0.01);
    e[i * 3] = bw * front;
    // Mouth corners: either side of the mouth line, the corner itself most.
    const cw = (1 - sm01(Math.abs(y - (mouthY - 0.002)) / 0.016)) * sm01((ax - 0.008) / 0.016) * (1 - sm01((ax - 0.038) / 0.014));
    e[i * 3 + 1] = cw * front * Math.sign(x || 1);
    // Cheeks and lower lids: between the mouth and the eyes, out to the cheekbones.
    const kw = (1 - sm01(Math.abs(y - (eyeY - 0.022)) / 0.022)) * sm01((ax - 0.012) / 0.012) * (1 - sm01((ax - 0.058) / 0.014));
    e[i * 3 + 2] = kw * front;
  }
  g.setAttribute('aFace2', new THREE.BufferAttribute(e, 3));
  return face;
}

/** A face: brows (-1 knitted .. 1 raised), smile (-1 frown .. 1 grin), squint and gritted teeth (0..1). */
export interface FaceExpr { brow: number; smile: number; squint: number; grit: number }

/** What each mood looks like (render/realplayer.ts updateFace blends between them). */
export const MOODS: Record<'calm' | 'joy' | 'effort' | 'anger', FaceExpr> = {
  calm: { brow: 0, smile: 0, squint: 0, grit: 0 },
  joy: { brow: 0.75, smile: 1, squint: 0.55, grit: 0 },
  effort: { brow: -0.6, smile: -0.15, squint: 0.75, grit: 0.9 },
  anger: { brow: -1, smile: -0.9, squint: 0.35, grit: 0.25 },
};

export interface PlayerAssets {
  bodies: Body[];
  clips: Partial<Record<ClipName, ClipSrc>>;
}

let pending: Promise<PlayerAssets | null> | null = null;

/** What happened to the realistic models, shown in Settings so a failure can be reported. */
export let playerAssetStatus: { state: 'idle' | 'loading' | 'ready' | 'failed'; detail: string } = { state: 'idle', detail: '' };

function b64Bytes(uri: string): Uint8Array {
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/**
 * Turn glTF JSON with embedded data: URIs into a binary GLB in memory. Pages served with a strict
 * content security policy may refuse to fetch data: or blob: URLs, which is how three.js reads
 * embedded buffers and images, so everything is decoded here and handed over as one binary chunk.
 */
export async function gltfJsonToGlb(json: any, base: string): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const add = (bytes: Uint8Array) => { const at = size; parts.push(bytes); size += bytes.length; const pad = (4 - (size % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); size += pad; } return at; };
  const offsets: number[] = [];
  for (const b of json.buffers ?? []) offsets.push(add(b.uri?.startsWith('data:') ? b64Bytes(b.uri) : await fetchBytes(base + b.uri)));
  for (const v of json.bufferViews ?? []) { v.byteOffset = (v.byteOffset ?? 0) + offsets[v.buffer ?? 0]; v.buffer = 0; }
  json.bufferViews ??= [];
  for (const img of json.images ?? []) {
    if (img.uri === undefined) continue;
    const bytes = img.uri.startsWith('data:') ? b64Bytes(img.uri) : await fetchBytes(base + img.uri);
    if (!img.mimeType) img.mimeType = /^data:([^;,]+)/.exec(img.uri)?.[1] ?? (/\.png$/i.test(img.uri) ? 'image/png' : 'image/jpeg');
    json.bufferViews.push({ buffer: 0, byteOffset: add(bytes), byteLength: bytes.length });
    img.bufferView = json.bufferViews.length - 1;
    delete img.uri;
  }
  json.buffers = size ? [{ byteLength: size }] : [];
  let text = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (text.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(text.length + jpad).fill(0x20); t.set(text); text = t; }
  const total = 12 + 8 + text.length + (size ? 8 + size : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, text.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(text, 20);
  if (size) {
    let at = 20 + text.length;
    dv.setUint32(at, size, true); dv.setUint32(at + 4, 0x004e4942, true); at += 8;
    for (const p of parts) { out.set(p, at); at += p.length; }
  }
  return out.buffer;
}

/** Decode an image straight from its bytes (no object URL to fetch). */
async function bitmapFrom(bytes: BlobPart, type: string, opts: ImageBitmapOptions): Promise<ImageBitmap | HTMLImageElement> {
  const blob = new Blob([bytes], { type });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, opts); } catch { try { return await createImageBitmap(blob); } catch { /* fall through */ } }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/** GLTFLoader plugin: decode embedded textures without fetching a blob: URL. */
function inlineTextures(parser: any) {
  return {
    name: 'ELEVENS_inline_textures',
    loadTexture(index: number) {
      const json = parser.json;
      const def = json.textures[index];
      const src = json.images?.[def.source];
      if (!src || src.bufferView === undefined) return null;
      return parser.getDependency('bufferView', src.bufferView).then(async (view: ArrayBuffer) => {
        const img = await bitmapFrom(view, src.mimeType ?? 'image/png', { premultiplyAlpha: 'none' });
        const t = new THREE.Texture(img as HTMLImageElement);
        t.flipY = false;
        t.name = def.name || src.name || '';
        const sm = (json.samplers ?? [])[def.sampler] ?? {};
        const FILT: Record<number, THREE.TextureFilter> = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
        const WRAP: Record<number, THREE.Wrapping> = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
        t.magFilter = (FILT[sm.magFilter] as THREE.MagnificationTextureFilter) ?? THREE.LinearFilter;
        t.minFilter = FILT[sm.minFilter] ?? THREE.LinearMipmapLinearFilter;
        t.wrapS = WRAP[sm.wrapS] ?? THREE.RepeatWrapping;
        t.wrapT = WRAP[sm.wrapT] ?? THREE.RepeatWrapping;
        t.userData.mimeType = src.mimeType;
        t.needsUpdate = true;
        parser.associations.set(t, { textures: index });
        return t;
      });
    },
  };
}

/** Binary glTF normally; hosts that won't serve .glb get the same model as glTF JSON. Either way
 * the file is fetched as plain bytes from its own URL and parsed in memory. */
async function loadModel(loader: GLTFLoader, path: string) {
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  let glb: ArrayBuffer;
  try {
    const r = await fetch(`${path}.glb`);
    const buf = r.ok ? await r.arrayBuffer() : null;
    if (!buf || new DataView(buf).getUint32(0, true) !== 0x46546c67) throw new Error('no glb');
    glb = buf;
  } catch {
    const r = await fetch(`${path}.json`);
    if (!r.ok) throw new Error(`${path}.json: HTTP ${r.status}`);
    glb = await gltfJsonToGlb(await r.json(), dir);
  }
  return loader.parseAsync(glb, dir);
}

/** The kit mask: alpha is the socks, so RGB must stay exactly as stored. */
async function loadMask(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return bitmapFrom(await r.arrayBuffer(), 'image/png', { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' } as ImageBitmapOptions);
}

/** Load the bodies and clips once. Resolves null if the files are missing or fail to load. */
export function loadPlayerAssets(base = 'models/'): Promise<PlayerAssets | null> {
  if (pending) return pending;
  pending = (async () => {
    playerAssetStatus = { state: 'loading', detail: '' };
    const loader = new GLTFLoader();
    loader.register(inlineTextures);
    const loaded = await Promise.allSettled(
      BODIES.map(async (b) => {
        const [g, bmp] = await Promise.all([loadModel(loader, `${base}${b.file}`), loadMask(`${base}${b.file}-kit.png`)]);
        let mesh: THREE.SkinnedMesh | null = null;
        g.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh; });
        if (!mesh) throw new Error(`${b.file}: no skinned mesh`);
        const m = mesh as THREE.SkinnedMesh;
        const kitMask = new THREE.Texture(bmp as unknown as HTMLImageElement);
        kitMask.flipY = false;
        kitMask.colorSpace = THREE.NoColorSpace;
        kitMask.needsUpdate = true;
        const hips = g.scene.getObjectByName('Hips')!;
        // Back of the shirt at number height, from the bind-pose vertices.
        const pos = m.geometry.getAttribute('position');
        let backZ = -0.12, nameZ = -0.12;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          if (Math.abs(x) < 0.06 && y > 1.26 && y < 1.42 && z < backZ) backZ = z;
          if (Math.abs(x) < 0.12 && y > 1.44 && y < 1.51 && z < nameZ) nameZ = z;
        }
        let detail: ReturnType<typeof kitDetail> = { front: new THREE.Vector3(0.1, 0.8, 0.12), band: null };
        try { detail = kitDetail(m, g.scene, bmp as ImageBitmap); } catch (e) { console.warn('[players] kit detail unavailable', e); }
        let face: Body['face'] = { hingeY: 1.65, hingeZ: -0.04, hairLum: 0.12 };
        try { face = faceDetail(m, ((m.material as THREE.MeshStandardMaterial).map?.image ?? null) as never); } catch (e) { console.warn('[players] face detail unavailable', e); }
        return { scene: g.scene, mesh: m, material: m.material as THREE.MeshStandardMaterial, kitMask, hipsRest: hips.position.clone(), backZ, nameZ, shorts: detail.front, band: detail.band, tone: new THREE.Color(b.tone), face } as Body;
      }),
    );
    const bodies = loaded.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!bodies.length) throw (loaded[0] as PromiseRejectedResult).reason;
    const clips: PlayerAssets['clips'] = {};
    await Promise.all(
      (['idle', 'walk', 'jog', 'sprint', 'kick', 'slide', ...SHOTS] as ClipName[]).map(async (name) => {
        try {
          const g = await loadModel(loader, `${base}anim-${name}`);
          clips[name] = analyseClip(g.scene, g.animations[0]);
        } catch {
          /* optional clip: locomotion blends between whichever clips exist */
        }
      }),
    );
    if (!clips.idle) throw new Error('idle clip missing');
    const failed = loaded.filter((r) => r.status === 'rejected').length;
    playerAssetStatus = { state: 'ready', detail: `${bodies.length} bodies, ${Object.keys(clips).length} moves${failed ? `, ${failed} failed` : ''}` };
    console.info('[players] realistic models ready:', playerAssetStatus.detail);
    return { bodies, clips };
  })().catch((err) => {
    console.warn('[players] realistic models unavailable, using procedural players:', err);
    playerAssetStatus = { state: 'failed', detail: String((err as Error)?.message ?? err).slice(0, 160) };
    return null;
  });
  return pending;
}

/** Measure a clip: authored ground speed, gait phase origin and kick timing. */
/** Bind orientation of every named node relative to the model root (animation files carry no
 * skin, so their joints load as plain nodes rather than bones). */
function restOrientations(root: THREE.Object3D) {
  const out = new Map<string, THREE.Quaternion>();
  root.traverse((o) => {
    if (!o.name) return;
    const q = new THREE.Quaternion();
    for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) q.premultiply(n.quaternion);
    out.set(o.name, q);
  });
  return out;
}

function analyseClip(rig: THREE.Object3D, clip: THREE.AnimationClip): ClipSrc {
  const hipsRest = rig.getObjectByName('Hips')!.position.clone();
  const restChar = restOrientations(rig);
  const mixer = new THREE.AnimationMixer(rig);
  mixer.clipAction(clip).play();
  const lf = rig.getObjectByName('LeftFoot')!, rf = rig.getObjectByName('RightFoot')!, hips = rig.getObjectByName('Hips')!;
  const N = 90;
  const L: THREE.Vector3[] = [], R: THREE.Vector3[] = [], H: number[] = [], HZ: number[] = [], toeY: number[] = [];
  const lt = rig.getObjectByName('LeftToeBase'), rt = rig.getObjectByName('RightToeBase');
  for (let i = 0; i <= N; i++) {
    mixer.setTime(Math.min((clip.duration * i) / N, clip.duration - 1e-4)); // the very end would wrap to the start
    rig.updateMatrixWorld(true);
    L.push(lf.getWorldPosition(new THREE.Vector3()));
    R.push(rf.getWorldPosition(new THREE.Vector3()));
    const hp = hips.getWorldPosition(new THREE.Vector3());
    H.push(hp.y); HZ.push(hp.z);
    toeY.push(lt && rt ? Math.min(lt.getWorldPosition(new THREE.Vector3()).y, rt.getWorldPosition(new THREE.Vector3()).y) : 0);
  }
  const dt = clip.duration / N;
  // Stance speed: how fast a low foot travels backwards.
  let sum = 0, n = 0;
  for (const F of [L, R]) {
    const minY = Math.min(...F.map((v) => v.y));
    for (let i = 1; i <= N; i++) if (F[i].y < minY + 0.04 && F[i - 1].y < minY + 0.04) { sum += (F[i - 1].z - F[i].z) / dt; n++; }
  }
  // Clips with root motion keep the planted foot still and move the hips instead.
  const travel = (HZ[N] - HZ[0]) / clip.duration;
  let speed = Math.max(n ? Math.max(0, sum / n) : 0, travel > 0.3 ? travel : 0);
  // Foot positions relative to the hips, so root motion doesn't hide the gait.
  const LZ = L.map((v, i) => v.z - HZ[i]);
  let phase0 = 0, best = -1e9;
  LZ.forEach((z, i) => { if (z > best) { best = z; phase0 = i * dt; } });
  // Gait cycles in the clip: upward crossings of the left foot's mean fore-aft position.
  const meanZ = LZ.reduce((a, z) => a + z, 0) / LZ.length;
  let cycles = 0;
  for (let i = 1; i <= N; i++) if (LZ[i - 1] < meanZ && LZ[i] >= meanZ) cycles++;
  const cycle = clip.duration / Math.max(1, cycles);
  // In-place clips: a planted foot sweeps the step length backwards, two steps per cycle.
  if (speed < 0.3 || (travel <= 0.3 && cycles > 0)) {
    const rangeZ = Math.max(...LZ) - Math.min(...LZ);
    speed = Math.max(speed, cycles > 0 ? (2 * rangeZ * 0.95) / cycle : 0);
  }
  // Kick: contact at the kicking foot's fastest forward swing, backswing at its rearmost point before.
  let contactI = 0, vmax = -1e9;
  for (let i = 1; i <= N; i++) { const v = (R[i].z - R[i - 1].z) / dt; if (v > vmax) { vmax = v; contactI = i; } }
  let backI = 0, zmin = 1e9;
  for (let i = 0; i <= contactI; i++) if (R[i].z < zmin) { zmin = R[i].z; backI = i; }
  // Slide: the beats of the hips' drop to the ground and rise back up.
  let lowI = 0;
  H.forEach((y, i) => { if (y < H[lowI]) lowI = i; });
  const top = H[0], range = Math.max(1e-6, top - H[lowI]);
  let dropI = lowI, riseI = lowI, endI = N;
  // Start a quarter of the way down: the clip opens with a run-in and a hop the simulation doesn't have.
  while (dropI > 0 && H[dropI - 1] < top - 0.25 * range) dropI--;
  while (riseI < N && H[riseI + 1] < H[lowI] + 0.15 * range) riseI++;
  for (let i = riseI; i <= N; i++) if (H[i] > top - 0.08 * range) { endI = i; break; }
  mixer.stopAllAction();
  return { clip, rig, restChar, hipsRest, speed, phase0, cycle, contact: contactI * dt, backswing: backI * dt, slide: { drop: dropI * dt, low: lowI * dt, rise: riseI * dt, end: endI * dt }, toeY };
}

/**
 * Copy a clip onto one body. The clips come from rigs whose bones have slightly different bind
 * orientations, so rotations are transferred as character-space deltas from each rig's bind
 * pose; the hips' bob and sway are scaled to the body's height.
 */
const retargeted = new WeakMap<Body, Map<ClipSrc, THREE.AnimationClip>>();

function retarget(src: ClipSrc, body: Body, inPlace: boolean | 'xz'): THREE.AnimationClip {
  let cache = retargeted.get(body);
  if (!cache) retargeted.set(body, (cache = new Map()));
  let clip = cache.get(src);
  if (!clip) cache.set(src, (clip = retargetClip(src, body, inPlace)));
  return clip;
}

function retargetClip(src: ClipSrc, body: Body, inPlace: boolean | 'xz'): THREE.AnimationClip {
  const k = body.hipsRest.y / src.hipsRest.y;
  const tracks: THREE.KeyframeTrack[] = [];
  const hipsTrack = src.clip.tracks.find((t) => t.name === 'Hips.position');
  if (hipsTrack) {
    const v = hipsTrack.values.slice();
    for (let i = 0; i < v.length; i += 3) {
      // 'xz': the simulation moves the player, so drop all of the clip's travel over the ground.
      v[i] = inPlace === 'xz' ? body.hipsRest.x : body.hipsRest.x + (v[i] - src.hipsRest.x) * k;
      v[i + 1] = body.hipsRest.y + (v[i + 1] - src.hipsRest.y) * k;
      v[i + 2] = inPlace ? body.hipsRest.z : body.hipsRest.z + (v[i + 2] - src.hipsRest.z) * k;
    }
    tracks.push(new THREE.VectorKeyframeTrack('Hips.position', hipsTrack.times, v));
  }
  const qTrack = src.clip.tracks.find((t) => t.name.endsWith('.quaternion'));
  if (!qTrack) return new THREE.AnimationClip(src.clip.name, src.clip.duration, tracks);
  const times = qTrack.times;
  // Target bones in parent-first order with their bind orientations.
  const tgtRest = restOrientations(body.scene);
  const bones: { name: string; parent: string | null; src: THREE.Object3D | undefined }[] = [];
  body.scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    bones.push({ name: o.name, parent: (o.parent as THREE.Bone)?.isBone ? o.parent!.name : null, src: src.rig.getObjectByName(o.name) });
  });
  const topChar = new THREE.Quaternion();
  {
    const hips = body.scene.getObjectByName('Hips')!;
    for (let n: THREE.Object3D | null = hips.parent; n && n !== body.scene; n = n.parent) topChar.premultiply(n.quaternion);
  }
  const values = new Map(bones.map((b) => [b.name, new Float32Array(times.length * 4)]));
  const mixer = new THREE.AnimationMixer(src.rig);
  const action = mixer.clipAction(src.clip);
  action.play();
  const srcChar = new Map<string, THREE.Quaternion>();
  const tgtChar = new Map<string, THREE.Quaternion>();
  const d = new THREE.Quaternion(), loc = new THREE.Quaternion();
  for (let f = 0; f < times.length; f++) {
    mixer.setTime(times[f]);
    srcChar.clear();
    src.rig.traverse((o) => {
      if (!o.name) return;
      const q = new THREE.Quaternion();
      for (let n: THREE.Object3D | null = o; n && n !== src.rig; n = n.parent) q.premultiply(n.quaternion);
      srcChar.set(o.name, q);
    });
    for (const b of bones) {
      const tr = tgtRest.get(b.name)!;
      const sc = srcChar.get(b.name), sr = src.restChar.get(b.name);
      const tc = sc && sr ? d.copy(sc).multiply(sr.clone().invert()).multiply(tr).clone() : tr.clone();
      tgtChar.set(b.name, tc);
      const parentChar = b.parent ? tgtChar.get(b.parent)! : topChar;
      loc.copy(parentChar).invert().multiply(tc);
      values.get(b.name)!.set([loc.x, loc.y, loc.z, loc.w], f * 4);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(src.rig);
  for (const b of bones) if (b.src) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b.name)!));
  return new THREE.AnimationClip(src.clip.name, src.clip.duration, tracks);
}

// ---- Kit material -------------------------------------------------------------------------

/** Per-player look that changes during a match: mud, sweat and an open mouth (render/wear.ts). */
export interface PlayerLookUniforms {
  uMud: { value: number };
  uMudFront: { value: number };
  uSweat: { value: number };
  uMouth: { value: number };
  /** Expression: brows, smile, squint, gritted teeth (FaceExpr). */
  uExpr: { value: THREE.Vector4 };
  /** Cloth: time, ground speed and a per-player phase (shirts and shorts ripple more the faster he runs). */
  uCloth: { value: THREE.Vector3 };
}

/**
 * Each player's own copy of the body material (one shader program shared by all of them):
 * kit colours from the mask, collar/cuff trims, boots and gloves; their own skin tone and hair
 * colour on the shared body; warmer, softer skin with a little rim light; hair with strands and
 * sheen; and mud and sweat that build up over the match.
 */
function kitMaterial(body: Body, kit: Kit, keeper: boolean, boot = 0x15161a, person: { skin?: number; hair?: number; coat?: boolean } = {}): { material: THREE.MeshStandardMaterial; look: PlayerLookUniforms } {
  const m = body.material.clone();
  const top = keeper ? kit.keeper : kit.shirt;
  // Skin tone relative to the body's own scan, kept within a modest range so textures stay natural.
  const tone = new THREE.Color(person.skin ?? body.tone.getHex());
  const tint = new THREE.Vector3(...[tone.r / Math.max(0.05, body.tone.r), tone.g / Math.max(0.05, body.tone.g), tone.b / Math.max(0.05, body.tone.b)].map((v) => Math.max(0.78, Math.min(1.25, 1 + (v - 1) * 0.6))) as [number, number, number]);
  const look: PlayerLookUniforms = { uMud: { value: 0 }, uMudFront: { value: 0.5 }, uSweat: { value: 0 }, uMouth: { value: 0 }, uExpr: { value: new THREE.Vector4() }, uCloth: { value: new THREE.Vector3() } };
  // The club crest on the left chest (render/badgetex.ts), when the kit's club is known.
  const club = kitClub(kit);
  const uniforms = {
    kitMask: { value: body.kitMask },
    kitShirt: { value: new THREE.Color(top) },
    kitSleeves: { value: new THREE.Color(keeper ? kit.keeper : kit.sleeves) },
    kitShorts: { value: new THREE.Color(kit.shorts) },
    kitSocks: { value: new THREE.Color(kit.socks) },
    // Trim on collar, cuffs, shorts hems and sock tops: the number colour, or a readable one on a keeper's shirt.
    kitTrim: { value: new THREE.Color(keeper ? readableOn(kit.keeper, 0x111111) : readableOn(kit.shirt, kit.number)) },
    kitBoot: { value: new THREE.Color(boot) },
    kitGlove: { value: new THREE.Color(keeper ? readableOn(kit.keeper, 0xf2f2f2) : 0) },
    kitGloves: { value: keeper ? 1 : 0 },
    // Shirt design and sponsor (render/kitstyle.ts); keepers wear plain shirts with the sponsor.
    kitSecond: { value: new THREE.Color(kit.second ?? kit.number) },
    kitPat: { value: keeper ? 0 : patternIndex(kit.pattern) },
    kitSponsor: { value: kit.sponsor ? sponsorTexture(kit.sponsor) : noSponsor() },
    kitSponsorOn: { value: kit.sponsor ? 1 : 0 },
    kitBadge: { value: club ? badgeTexture(club) : noSponsor() },
    kitBadgeOn: { value: club ? 1 : 0 },
    // Managers: long sleeves and trousers over the bare arms and legs (render/managers.ts).
    kitCoat: { value: person.coat ? 1 : 0 },
    kitSponsorCol: { value: new THREE.Color(keeper ? readableOn(kit.keeper, 0x111111) : sponsorColour(kit)) },
    uSkinTint: { value: tint },
    uHairCol: { value: new THREE.Color(person.hair ?? 0x1c1410) },
    uHairLum: { value: Math.max(0.04, body.face.hairLum) },
    uHinge: { value: new THREE.Vector2(body.face.hingeY, body.face.hingeZ) },
    ...look,
  };
  const hasDetail = !!body.mesh.geometry.getAttribute('aKit');
  const hasFace = !!body.mesh.geometry.getAttribute('aFace');
  const hasExpr = !!body.mesh.geometry.getAttribute('aFace2');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${hasDetail ? 'attribute vec3 aKit;\nvarying vec3 vKit;' : ''}
${hasFace ? 'attribute vec3 aFace;' : ''}
${hasExpr ? 'attribute vec3 aFace2;' : ''}
varying vec3 vFace;
varying vec3 vExpr;
varying vec3 vBind;
varying float vMirror;
uniform float uMouth;
uniform vec4 uExpr;
uniform vec2 uHinge;
uniform vec3 uCloth;
uniform sampler2D kitMask;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${hasDetail ? 'vKit = aKit;' : ''}
vBind = transformed;
// Cloth: the shirt and shorts ripple as he runs (waves running down and back), the hem most.
if (uCloth.y > 0.05) {
  vec4 kmv = texture2D(kitMask, uv);
  float cloth = kmv.r + 0.55 * kmv.g + 0.75 * kmv.b;
  if (cloth > 0.01) {
    vec3 b0 = transformed;
    float t = uCloth.x * (7.0 + uCloth.y * 1.6) + uCloth.z;
    float hem = 0.35 + 0.65 * smoothstep(1.32, 1.0, b0.y) * step(0.8, b0.y) + 0.6 * kmv.b * smoothstep(0.62, 0.52, b0.y);
    float amp = (0.0025 + min(uCloth.y, 8.0) * 0.0011) * hem * cloth;
    float w = sin(b0.y * 31.0 - t + b0.x * 11.0) * 0.6 + sin(b0.y * 53.0 + b0.x * 27.0 - t * 1.7 + b0.z * 9.0) * 0.4;
    transformed += normal * amp * w;
    // The loose back of the shirt and the shorts stream back a little at speed.
    transformed.z -= min(uCloth.y, 8.0) * 0.0009 * hem * cloth * (0.6 + 0.4 * sin(t * 0.7 + b0.x * 5.0));
  }
}
// A mirrored body (left-footed kicks, saves to the left) keeps its sponsor and design the right way round.
vMirror = determinant(mat3(modelMatrix)) < 0.0 ? -1.0 : 1.0;
${hasFace ? `vFace = aFace;
// An open mouth: the chin and lower lip swing down about the jaw hinge (before skinning).
if (aFace.y > 0.001 && uMouth > 0.001) {
  float ang = uMouth * 0.16 * aFace.y;
  vec2 r = transformed.yz - uHinge;
  float c = cos(ang), s = sin(ang);
  transformed.yz = uHinge + vec2(r.x * c - r.y * s, r.x * s + r.y * c);
}` : 'vFace = vec3(0.0);'}
${hasExpr ? `vExpr = aFace2;
// Expression: brows up (joy) or knitted down and in (effort, frustration); mouth corners up in a
// grin or down in a frown, wider for gritted teeth; cheeks and lower lids up in a grin or squint.
if (dot(abs(uExpr), vec4(1.0)) > 0.01) {
  float knit = max(0.0, -uExpr.x);
  transformed.y += aFace2.x * (uExpr.x * 0.009 - knit * 0.0015);
  transformed.x -= aFace2.x * knit * 0.006 * sign(transformed.x) * (1.0 - smoothstep(0.015, 0.045, abs(transformed.x)));
  transformed.z += aFace2.x * knit * 0.002;
  float cy = abs(aFace2.y);
  transformed.y += cy * uExpr.y * 0.009;
  transformed.x += aFace2.y * (max(0.0, uExpr.y) * 0.006 + uExpr.w * 0.006);
  transformed.z -= cy * max(0.0, uExpr.y) * 0.0015;
  transformed.y += aFace2.z * (uExpr.z * 0.005 + max(0.0, uExpr.y) * 0.004);
  transformed.z += aFace2.z * (uExpr.z + max(0.0, uExpr.y)) * 0.0012;
}` : 'vExpr = vec3(0.0);'}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 kitShirt, kitSleeves, kitShorts, kitSocks, kitTrim, kitBoot, kitGlove, kitSecond, kitSponsorCol;
uniform float kitGloves, kitPat, kitSponsorOn, kitCoat;
uniform sampler2D kitMask, kitSponsor, kitBadge;
uniform float kitBadgeOn;
varying float vMirror;
${KIT_PATTERN_GLSL}
uniform vec3 uSkinTint, uHairCol;
uniform float uHairLum, uMud, uMudFront, uSweat, uMouth;
uniform vec4 uExpr;
${hasDetail ? 'varying vec3 vKit;' : ''}
varying vec3 vFace;
varying vec3 vExpr;
varying vec3 vBind;
float kHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float kNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kHash(i), kHash(i + vec3(1, 0, 0)), f.x), mix(kHash(i + vec3(0, 1, 0)), kHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(kHash(i + vec3(0, 0, 1)), kHash(i + vec3(1, 0, 1)), f.x), mix(kHash(i + vec3(0, 1, 1)), kHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float kitW, skinW, hairW, mudK, shirtW;
        {
          vec4 km = texture2D(kitMask, vMapUv);
          float kw = clamp(km.r + km.g + km.b + km.a, 0.0, 1.0);
          kitW = kw;
          shirtW = clamp(km.r + km.g, 0.0, 1.0);
          // The shirt's design, then the sponsor across the chest.
          vec3 shirtC = mix(kitShirt, kitSecond, kitPatternW(vBind, kitPat, vMirror));
          if (kitSponsorOn > 0.5 && vBind.z > 0.02) {
            vec2 su = vec2(vBind.x * vMirror / ${(2 * SPONSOR_BOX.x).toFixed(3)} + 0.5, (vBind.y - ${SPONSOR_BOX.y0.toFixed(3)}) / ${(SPONSOR_BOX.y1 - SPONSOR_BOX.y0).toFixed(3)});
            if (su.x > 0.0 && su.x < 1.0 && su.y > 0.0 && su.y < 1.0) shirtC = mix(shirtC, kitSponsorCol, texture2D(kitSponsor, su).a);
          }
          if (kitBadgeOn > 0.5 && vBind.z > 0.02) {
            vec2 bu = vec2((vBind.x * vMirror - ${BADGE_SPOT.x.toFixed(3)}) / ${BADGE_SPOT.size.toFixed(3)} + 0.5, (vBind.y - ${BADGE_SPOT.y.toFixed(3)}) / ${BADGE_SPOT.size.toFixed(3)} + 0.5);
            if (bu.x > 0.0 && bu.x < 1.0 && bu.y > 0.0 && bu.y < 1.0) { vec4 bc = texture2D(kitBadge, bu); shirtC = mix(shirtC, bc.rgb, bc.a); }
          }
          vec3 kc = (shirtC * km.r + kitSleeves * km.g + kitShorts * km.b + kitSocks * km.a) / max(km.r + km.g + km.b + km.a, 1e-3);
          vec3 tex = diffuseColor.rgb;
          float lum = dot(tex, vec3(0.299, 0.587, 0.114));
          ${hasDetail ? `kc = mix(kc, kitTrim, smoothstep(0.3, 0.85, vKit.x) * kw);` : ''}
          // Fine knit, faded out where it would shimmer.
          vec2 fq = vMapUv * 1800.0;
          float knit = 0.035 * sin(fq.x) * sin(fq.y) * (1.0 - clamp(fwidth(fq.x) * 0.35, 0.0, 1.0));
          diffuseColor.rgb = tex * mix(vec3(1.0), kc * (1.0 + knit), kw);
          float bare = 1.0 - kw;
          float gear = 0.0;
          ${hasDetail ? `diffuseColor.rgb = mix(diffuseColor.rgb, kitBoot * (0.3 + lum * 2.4), clamp(vKit.y, 0.0, 1.0) * bare);
          diffuseColor.rgb = mix(diffuseColor.rgb, kitGlove * (0.45 + lum * 1.6), clamp(vKit.z, 0.0, 1.0) * bare * kitGloves);
          gear = clamp(vKit.y + vKit.z * kitGloves, 0.0, 1.0);` : ''}
          // Hair (and beard, brows) takes the player's own colour; the rest of the bare body is skin.
          hairW = clamp(vFace.x, 0.0, 1.0) * bare * (1.0 - gear);
          skinW = bare * (1.0 - gear) * (1.0 - hairW);
          vec3 b = vBind;
          diffuseColor.rgb *= mix(vec3(1.0), uSkinTint * (1.0 + 0.07 * (kNoise(b * 90.0) - 0.5)), skinW);
          if (kitCoat > 0.5) {
            // A manager's coat sleeves (not the hands) and trousers down to the shoes.
            float hand = ${hasDetail ? 'clamp(vKit.z * 3.0, 0.0, 1.0)' : '0.0'};
            float arm = smoothstep(0.15, 0.18, abs(b.x)) * step(0.95, b.y) * (1.0 - hand);
            float leg = 1.0 - smoothstep(0.82, 0.88, b.y);
            float cover = clamp(arm + leg, 0.0, 1.0) * skinW;
            vec3 cc = mix(kitShorts, kitSleeves, step(0.95, b.y)) * (0.45 + lum * 1.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, cc, cover);
            skinW *= 1.0 - cover;
          }
          float strand = 0.5 + 0.5 * sin(b.y * 900.0 + kNoise(b * 40.0) * 6.0);
          float sfade = 1.0 - clamp(fwidth(b.y * 900.0) * 0.3, 0.0, 1.0);
          vec3 hc = uHairCol * clamp(lum / uHairLum, 0.35, 2.4) * (1.0 - 0.22 * strand * sfade);
          diffuseColor.rgb = mix(diffuseColor.rgb, hc, hairW * 0.9);
          // Open mouth: the stretched lips show the dark inside of the mouth.
          diffuseColor.rgb *= 1.0 - clamp(uMouth * vFace.z * 1.6, 0.0, 0.88);
          // A frown or a knitted brow creases the skin; a grin or a squint deepens the lines by the eyes.
          diffuseColor.rgb *= 1.0 - (max(0.0, -uExpr.x) * vExpr.x * 0.16 + abs(vExpr.y) * max(0.0, -uExpr.y) * 0.1 + vExpr.z * uExpr.z * 0.08) * skinW;
          // Sweat darkens the shirt down the chest, under the arms, at the collar and down the back.
          if (uSweat > 0.01) {
            float chest = exp(-(b.x * b.x / 0.005 + (b.y - 1.32) * (b.y - 1.32) / 0.009)) * step(0.0, b.z);
            float back = exp(-(b.x * b.x / 0.012 + (b.y - 1.22) * (b.y - 1.22) / 0.04)) * step(b.z, 0.0);
            float pits = exp(-((abs(b.x) - 0.16) * (abs(b.x) - 0.16) / 0.0018 + (b.y - 1.3) * (b.y - 1.3) / 0.004));
            float collar = exp(-(b.y - 1.46) * (b.y - 1.46) / 0.0012);
            float zone = clamp(chest + back * 1.15 + pits + collar * 0.6, 0.0, 1.0) * (0.75 + 0.5 * kNoise(b * 24.0));
            diffuseColor.rgb *= 1.0 - uSweat * zone * shirtW * 0.38;
          }
          // Mud: socks, shins and knees first; sides and seat of the shorts from slides; the front from dives.
          mudK = 0.0;
          if (uMud > 0.005) {
            float legs = 1.0 - smoothstep(0.3, 0.62, b.y);
            float hips = smoothstep(0.42, 0.6, b.y) * (1.0 - smoothstep(0.98, 1.12, b.y)) * mix(0.45, 1.0, step(b.z, 0.02) + step(0.09, abs(b.x)));
            float front = smoothstep(0.5, 0.65, b.y) * (1.0 - smoothstep(1.35, 1.5, b.y)) * smoothstep(-0.01, 0.04, b.z);
            float region = legs * 0.85 + hips * (1.0 - uMudFront) * 0.8 + front * uMudFront * 0.7;
            // At most about half of an area is covered, in streaks (slides drag mud along the leg) and splashes.
            float m = uMud * region * 0.55;
            float nz = kNoise(b * vec3(14.0, 6.0, 14.0)) * 0.55 + kNoise(b * 40.0) * 0.3 + kNoise(b * 110.0) * 0.15;
            mudK = smoothstep(0.98 - m, 1.06 - m, nz) * (1.0 - hairW) * (1.0 - 0.6 * skinW);
            vec3 mudCol = vec3(0.19, 0.135, 0.08) * (0.7 + 0.5 * kNoise(b * 70.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, mudCol, mudK * 0.85);
          }
        }`,
      )
      // Shirts and shorts have a soft synthetic sheen; skin is softer and glistens when sweating; hair has a sheen; mud is matte.
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.55, kitW * 0.8);
roughnessFactor = mix(roughnessFactor, 0.62 - 0.22 * uSweat, skinW);
roughnessFactor = mix(roughnessFactor, 0.5, hairW);
roughnessFactor = mix(roughnessFactor, 0.97, mudK);`)
      .replace('#include <opaque_fragment>', `{
  // Skin: a warm glow where light scatters under it (so shadowed skin isn't grey), and a soft rim.
  float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 3.0);
  outgoingLight += diffuseColor.rgb * vec3(0.11, 0.04, 0.025) * skinW;
  outgoingLight += vec3(1.0, 0.97, 0.92) * rim * (skinW * 0.05 + hairW * 0.035) * (0.4 + dot(outgoingLight, vec3(0.3, 0.59, 0.11)));
}
#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `elevens-kit3-${hasDetail}-${hasFace}`;
  m.roughness = 0.85;
  return { material: m, look };
}

// ---- Skeleton mapping for the procedural layer ---------------------------------------------

// Which procedural segment drives each bone (see RealPlayerModel.applyProcedural).
type Seg = 'hips' | 'spine' | 'neck' | 'armL' | 'foreL' | 'armR' | 'foreR' | 'thighL' | 'shinL' | 'thighR' | 'shinR';
const SEG: Record<string, Seg> = {
  Hips: 'hips', Spine: 'spine', Spine01: 'spine', Spine02: 'spine', LeftShoulder: 'spine', RightShoulder: 'spine',
  neck: 'neck', Head: 'neck',
  LeftArm: 'armL', LeftForeArm: 'foreL', LeftHand: 'foreL', RightArm: 'armR', RightForeArm: 'foreR', RightHand: 'foreR',
  LeftUpLeg: 'thighL', LeftLeg: 'shinL', LeftFoot: 'shinL', LeftToeBase: 'shinL',
  RightUpLeg: 'thighR', RightLeg: 'shinR', RightFoot: 'shinR', RightToeBase: 'shinR',
};

const LOWER: ReadonlySet<Seg> = new Set(['hips', 'thighL', 'shinL', 'thighR', 'shinR']);
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const rot = (out: THREE.Quaternion, x: number, z: number) => out.setFromEuler(_e.set(x, 0, z, 'XYZ'));
const lerpN = (a: number, b: number, k: number) => a + (b - a) * k;
const sm01 = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };

/** How a kick is struck, for variety on top of the one captured kick. */
export type KickStyle = 'normal' | 'power' | 'finesse' | 'chip' | 'volley' | 'pass' | 'lofted';

/**
 * Pick the style and foot for a kick that has just started: chips, placed (side-foot) finishes,
 * volleys for a ball off the ground, power shots for a full charge; side-foot passes and lofted
 * balls. The foot follows the simulation's weak-foot rule (ball on the left of the body, or a
 * kick across to the right, goes on the left foot for a right-footed player).
 */
export function kickStyleFor(p: ViewPlayer, ball: THREE.Vector3): { style: KickStyle; foot: 1 | -1; seed: number } {
  const a = p.action as ViewPlayer['action'] & { variant?: string; placed?: boolean; power?: number };
  const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
  const ballLeft = (ball.x - p.pos.x) * fz - (ball.z - p.pos.z) * fx;
  let dx = fx, dz = fz;
  if (a.target) { dx = a.target.x - p.pos.x; dz = a.target.z - p.pos.z; }
  const d = Math.max(1e-6, Math.hypot(dx, dz));
  const shotRight = -(dx * fz - dz * fx) / d;
  const leftScore = ballLeft * 3 + shotRight;
  const strong = footProfile(p.def).foot;
  const foot: 1 | -1 = strong === 1 ? (leftScore > 0.45 ? -1 : 1) : (leftScore < -0.45 ? 1 : -1);
  let style: KickStyle = 'normal';
  if (ball.y > 0.45) style = 'volley';
  else if (a.kind === 'shot') style = a.variant === 'chip' ? 'chip' : a.placed ? 'finesse' : (a.power ?? 0.6) > 0.78 ? 'power' : 'normal';
  else if (a.kind === 'pass' || a.kind === 'through') style = 'pass';
  else if (a.kind === 'lob' || a.kind === 'cross' || a.kind === 'clear') style = 'lofted';
  return { style, foot, seed: (p.id * 7 + Math.floor(ball.x * 13)) % 3 };
}

// Joints that must stay above the grass while diving, with roughly the flesh around them (m).
/**
 * Kinds of dive, by where the save is: 'collapse' for a ball close to the body (the legs fold away
 * and the keeper drops onto his side), 'low' along the grass, 'high' for the top corners (a leap
 * with the top hand reaching furthest), and 'full' for a full-stretch dive at mid height.
 */
export type DiveKind = 'collapse' | 'low' | 'full' | 'high';
export function diveKindFor(lat: number, ty: number): DiveKind {
  if (lat < 1.25 && ty < 1.3) return 'collapse';
  if (ty < 0.5) return 'low';
  if (ty > 1.6) return 'high';
  return 'full';
}
const DIVE_CONTACTS: [string, number][] = [
  ['Hips', 0.15], ['Spine01', 0.14], ['Spine02', 0.14], ['Head', 0.11], ['LeftArm', 0.07], ['RightArm', 0.07],
  ['LeftForeArm', 0.05], ['RightForeArm', 0.05], ['LeftHand', 0.04], ['RightHand', 0.04],
  ['LeftLeg', 0.06], ['RightLeg', 0.06], ['LeftFoot', 0.05], ['RightFoot', 0.05], ['LeftToeBase', 0.03], ['RightToeBase', 0.03],
];

interface BoneRig {
  bone: THREE.Bone;
  parent: number; // index in the rig list, -1 for the top
  seg: Seg;
  restChar: THREE.Quaternion; // bind orientation in character space
  restPos: THREE.Vector3;
  animChar: THREE.Quaternion;
  outChar: THREE.Quaternion;
}

/** Surname lettering for the back of the shirt. */
function nameTexture(label: string, colour: string): THREE.CanvasTexture {
  return canvasTex(384, 64, (g) => {
    g.clearRect(0, 0, 384, 64);
    g.fillStyle = colour;
    let size = 46;
    g.font = `800 ${size}px system-ui, Segoe UI, Arial, sans-serif`;
    while (g.measureText(label).width > 370 && size > 20) { size -= 2; g.font = `800 ${size}px system-ui, Segoe UI, Arial, sans-serif`; }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 192, 36);
  });
}

export function nearestBody(assets: PlayerAssets, skin: number) {
  const c = new THREE.Color(skin);
  let best = 0, bd = 1e9;
  assets.bodies.forEach((b, i) => {
    const d = (b.tone.r - c.r) ** 2 + (b.tone.g - c.g) ** 2 + (b.tone.b - c.b) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export class RealPlayerModel {
  root = new THREE.Group();
  private body = new THREE.Group();
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private actions: Partial<Record<ClipName, THREE.AnimationAction>> = {};
  private src: Partial<Record<ClipName, ClipSrc>>;
  private solver: PlayerModel;
  private rig: BoneRig[] = [];
  private top: THREE.Object3D;
  private phase = Math.random();
  private spd = 0; // smoothed ground speed for the locomotion blend
  private yaw: number | null = null; // smoothed facing drawn on screen
  private bank = 0; // lean into turns
  private idleT = Math.random() * 4;
  private procW = 0;
  private prevAction = 'none';
  private gettingUp = false;
  private keeperW = 0;
  // Current captured one-shot (null when none), how it maps simulation time to clip time,
  // whether it is mirrored (the keeper leap was captured to the right), and its blend weight.
  private shot: { name: ShotName; mirror: boolean; stage: 'act' | 'down' } | null = null;
  private lastShot: ShotName | null = null;
  private shotW = 0;
  private celebT = 0;
  // Keeper dive driven directly on the skeleton (see applyDive): where it started, which way,
  // the save point, and the pose weight. Stage 'out' holds the last pose while it blends away.
  private dive: { start: THREE.Vector3; facing: number; s: number; lat: number; target: THREE.Vector3; hips0: THREE.Vector3; stage: 'dive' | 'down' | 'out'; held: number; downDur: number; kind: DiveKind; parry: number; parryT: number; clock: number; downT: number } | null = null;
  private diveW = 0;
  private diveP = new Float32Array(32);
  private numMesh!: THREE.Mesh;
  private decals: THREE.Mesh[] = [];
  private scale: number;
  private alignL = new THREE.Quaternion();
  private alignR = new THREE.Quaternion();
  private alignFL = new THREE.Quaternion();
  /** How far below level the face looks in the bind pose (Head -> headfront), or null without those bones. */
  private faceRest: number | null = null;
  private alignFR = new THREE.Quaternion();
  meshes: THREE.Mesh[] = [];
  /** Set by the renderer each frame: holding the ball overhead for a throw-in. */
  holdThrow = false;
  /** Set by the renderer each frame: this player has the ball at his feet. */
  dribbling = false;
  /** Set by the renderer each frame: the ball's velocity (for headers). */
  ballVel = new THREE.Vector3();
  private dribW = 0;
  // How the current kick is struck (picked when it starts) and with which foot (-1: left, mirrored).
  private kickStyle: { style: KickStyle; foot: 1 | -1; seed: number } = { style: 'normal', foot: 1, seed: 0 };
  private lastP: ViewPlayer | null = null;
  private throwT = 0;
  /** Mud, sweat and mouth for this player's material (set by the renderer each frame). */
  look: PlayerLookUniforms;
  /** Mud and sweat, 0..1 (render/wear.ts KitWear); the mouth is worked out here from what the player is doing. */
  wear = { mud: 0, front: 0.5, sweat: 0 };
  private mouth = 0;
  private expr: FaceExpr = { brow: 0, smile: 0, squint: 0, grit: 0 };
  /** Force a mood (photo tests); null lets the match decide. */
  moodOverride: keyof typeof MOODS | null = null;
  /** The mood the face is showing now (tests). */
  mood: keyof typeof MOODS = 'calm';
  private headYaw = 0;
  private headPitch = 0;
  /** Heads follow the ball (the renderer turns it off for a cinematic that has its own look). */
  lookAtBall = true;
  /** Moving hair, for the players who wear it (null for short hair). */
  hair: Hair | null = null;
  // Movement detail (motion.ts): cuts, speeding up and braking, planted feet, shoulder checks.
  private gait = new GaitTracker();
  private feet: { side: 'Left' | 'Right'; lock: THREE.Vector3 | null; hold: THREE.Vector3; w: number; ankleY: number }[] = [];
  private ikOn = 1;
  private turnStep = 0;
  /** Set by the renderer each frame: 0 nothing, 1 his side has the ball nearby (scan now and then), 2 a pass is on its way to him. */
  scanCue = 0;
  private scan: { t: number; dur: number; side: number } | null = null;
  private scanCool = Math.random() * 2;
  /** Planted feet: on by default (the renderer turns it off for players far from the camera). */
  footIK = true;

  constructor(public id: number, assets: PlayerAssets, kit: Kit, keeper: boolean, skin: number, num: number, shadows: boolean, extra: { name?: string; boot?: number; captain?: boolean; hair?: number; coat?: boolean; hairStyle?: HairStyle; detail?: number } = {}) {
    const body = assets.bodies[nearestBody(assets, skin)];
    this.model = cloneSkinned(body.scene);
    this.root.add(this.body);
    this.body.add(this.model);
    const km = kitMaterial(body, kit, keeper, extra.boot, { skin, hair: extra.hair, coat: extra.coat });
    const mat = km.material;
    this.look = km.look;
    this.model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        sm.material = mat;
        sm.castShadow = shadows;
        sm.frustumCulled = false; // until a sphere that follows the player is set below
        this.meshes.push(sm);
      }
    });
    this.solver = new PlayerModel(id, null, keeper, skin, 0, num, false, true);
    this.src = assets.clips;
    this.scale = body.hipsRest.y / (assets.clips.idle!.hipsRest.y || body.hipsRest.y);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const name of [...LOCO, 'kick', 'slide', ...SHOTS] as ClipName[]) {
      const s = assets.clips[name];
      if (!s) continue;
      const a = this.mixer.clipAction(retarget(s, body, (SHOTS as readonly string[]).includes(name) ? 'xz' : name !== 'idle'));
      a.play();
      a.setEffectiveWeight(0);
      this.actions[name] = a;
    }
    // Bone list in parent-before-child order, with bind orientations in character space.
    this.top = this.model.getObjectByName('Hips')!.parent!;
    this.model.updateMatrixWorld(true);
    const charOf = (o: THREE.Object3D, out: THREE.Quaternion) => {
      out.identity();
      for (let n: THREE.Object3D | null = o; n && n !== this.model; n = n.parent) out.premultiply(n.quaternion);
      return out;
    };
    this.top.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone || !(b.name in SEG)) return;
      const parent = this.rig.findIndex((r) => r.bone === b.parent);
      this.rig.push({ bone: b, parent, seg: SEG[b.name], restChar: charOf(b, new THREE.Quaternion()), restPos: b.position.clone(), animChar: new THREE.Quaternion(), outChar: new THREE.Quaternion() });
    });
    // A-pose arms hang ~45 degrees out; the procedural poses assume arms straight down.
    for (const [side, align] of [['Left', this.alignL], ['Right', this.alignR]] as const) {
      const arm = this.model.getObjectByName(`${side}Arm`)!, fore = this.model.getObjectByName(`${side}ForeArm`)!;
      const a = arm.getWorldPosition(new THREE.Vector3()), f = fore.getWorldPosition(new THREE.Vector3());
      this.model.worldToLocal(a); this.model.worldToLocal(f);
      align.setFromUnitVectors(f.sub(a).normalize(), DOWN);
    }
    // The bind pose's forearms are not in line with the upper arms (elbows a little bent and
    // carried out), so poses that want a forearm in a given direction align it on its own.
    for (const [side, align] of [['Left', this.alignFL], ['Right', this.alignFR]] as const) {
      const fore = this.model.getObjectByName(`${side}ForeArm`)!, hand = this.model.getObjectByName(`${side}Hand`)!;
      const f = fore.getWorldPosition(new THREE.Vector3()), h = hand.getWorldPosition(new THREE.Vector3());
      this.model.worldToLocal(f); this.model.worldToLocal(h);
      align.setFromUnitVectors(h.sub(f).normalize(), DOWN);
    }
    {
      const hd = this.model.getObjectByName('Head'), hf = this.model.getObjectByName('headfront');
      if (hd && hf) {
        const a = this.model.worldToLocal(hd.getWorldPosition(new THREE.Vector3())), b = this.model.worldToLocal(hf.getWorldPosition(new THREE.Vector3()));
        this.faceRest = Math.atan2(a.y - b.y, b.z - a.z);
      }
    }
    // Standing ankle heights, for keeping planted feet on the grass.
    for (const side of ['Left', 'Right'] as const) {
      const f = this.model.getObjectByName(`${side}Foot`);
      this.feet.push({ side, lock: null, hold: new THREE.Vector3(), w: 0, ankleY: f ? f.getWorldPosition(new THREE.Vector3()).y : 0.09 });
    }
    // Back number, riding on the upper spine.
    const numMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ map: numberTexture(num, keeper ? '#111111' : '#' + kit.number.toString(16).padStart(6, '0')), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    numMesh.position.set(0, 1.34, body.backZ - 0.012);
    numMesh.rotation.y = Math.PI;
    this.model.add(numMesh);
    this.model.updateMatrixWorld(true);
    this.model.getObjectByName('Spine02')!.attach(numMesh);
    this.numMesh = numMesh;
    const numColour = keeper ? '#111111' : '#' + kit.number.toString(16).padStart(6, '0');
    // Surname above the number.
    if (extra.name) {
      const label = extra.name.toUpperCase();
      const nameMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.05), new THREE.MeshBasicMaterial({ map: nameTexture(label, numColour), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      nameMesh.position.set(0, 1.475, body.nameZ - 0.012);
      nameMesh.rotation.y = Math.PI;
      this.model.add(nameMesh);
      this.model.updateMatrixWorld(true);
      this.model.getObjectByName('Spine02')!.attach(nameMesh);
      this.decals.push(nameMesh);
    }
    // Small number on the front of the shorts.
    {
      const c = readableOn(kit.shorts, keeper ? 0x111111 : kit.number);
      const sm = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.075), new THREE.MeshBasicMaterial({ map: numberTexture(num, '#' + c.toString(16).padStart(6, '0')), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      sm.position.set(body.shorts.x, body.shorts.y, body.shorts.z + 0.008);
      this.model.add(sm);
      this.model.updateMatrixWorld(true);
      this.model.getObjectByName('LeftUpLeg')?.attach(sm);
      this.decals.push(sm);
    }
    // A manager wears no numbers.
    if (extra.coat) for (const d of [numMesh, ...this.decals]) d.visible = false;
    // Captain's armband.
    if (extra.captain && body.band) {
      const b = body.band;
      const colour = readableOn(kit.sleeves, 0xffd60a);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r, 0.05, 20, 1, true), new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, side: THREE.DoubleSide }));
      band.position.copy(b.pos);
      band.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.dir);
      band.castShadow = shadows;
      this.model.add(band);
      this.model.updateMatrixWorld(true);
      this.model.getObjectByName('LeftArm')?.attach(band);
    }
    // Ponytails, longer hair and buns that move (render/hair.ts).
    if (extra.hairStyle && extra.hairStyle !== 'short') {
      const head = this.model.getObjectByName('Head');
      if (head) {
        this.hair = new Hair(extra.hairStyle, extra.hair ?? 0x1c1410, this.model, head, shadows && (extra.detail ?? 2) >= 2, extra.detail ?? 2);
        if (this.hair.active) this.root.add(this.hair.group);
      }
    }
    // Skinned bounds don't follow the animation, so each body mesh is tested against a sphere round
    // the player (2 m, 3 m for a diving keeper) and players off screen are skipped when drawing.
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4(), sc = new THREE.Vector3();
    for (const sm of this.meshes as THREE.SkinnedMesh[]) {
      inv.copy(sm.matrixWorld).invert();
      sc.setFromMatrixScale(sm.matrixWorld);
      sm.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0).applyMatrix4(inv), (keeper ? 3 : 2) / Math.min(sc.x, sc.y, sc.z));
      sm.frustumCulled = true;
    }
  }

  setVisible(v: boolean) {
    this.root.visible = v;
  }

  update(p: ViewPlayer, dt: number, time: number, ballHeldByMe: boolean, ballPos: THREE.Vector3) {
    // A wall jump without the captured leap: lift the whole body.
    const jy = p.action.type === 'jump' && this.shot?.name !== 'header' ? PLAYER.wallJump * Math.sin(Math.PI * Math.min(1, Math.max(0, p.action.t / Math.max(0.01, p.action.dur)))) : 0;
    this.root.position.set(p.pos.x, jy, p.pos.z);
    // Turn smoothly on screen (the simulation can swing the facing a long way in one tick), but
    // follow it exactly during actions whose aim matters.
    const a0 = p.action.type;
    const exact = a0 === 'kick' || a0 === 'dive' || a0 === 'header' || a0 === 'throw' || a0 === 'slide' || this.yaw === null;
    let dyaw = 0;
    if (exact) this.yaw = p.facing;
    else {
      dyaw = Math.atan2(Math.sin(p.facing - this.yaw!), Math.cos(p.facing - this.yaw!));
      this.yaw! += dyaw * (1 - Math.exp(-dt * 16));
    }
    this.root.rotation.y = Math.PI / 2 - this.yaw!;
    // Lean into turns at speed, like a runner banking round a bend.
    const turnRate = dt > 0 ? (dyaw * (1 - Math.exp(-dt * 16))) / dt : 0;
    const want = Math.max(-0.22, Math.min(0.22, turnRate * Math.hypot(p.vel.x, p.vel.z) * 0.025));
    this.bank += (want - this.bank) * (1 - Math.exp(-dt * 8));
    // Procedural solver: action overlays, jockey stance, keeper stance.
    this.solver.holdThrow = this.holdThrow;
    this.solver.dribbling = this.dribbling;
    this.solver.ballFoe = this.ballFoe;
    this.solver.ballVel.copy(this.ballVel);
    this.solver.update(p, dt, time, ballHeldByMe, ballPos);
    this.lastP = p;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const a = p.action.type;
    const keeperIdle = p.role === 'GK' && speed < 0.25;
    this.keeperW += ((keeperIdle ? 1 : 0) - this.keeperW) * (1 - Math.exp(-dt * 6));
    // Slide tackle and the get-up after it play the motion-captured slide clip when it is loaded.
    if (a !== this.prevAction) {
      this.gettingUp = a === 'stumble' && this.prevAction === 'slide';
      this.startShot(p, a, ballPos);
      this.startDive(p, a);
      if (a === 'kick') {
        this.kickStyle = kickStyleFor(p, ballPos);
        const fl = this.solver.kickFlavour;
        if (fl.foot) this.kickStyle.foot = fl.foot;
      }
      this.prevAction = a;
    }
    if (this.dive) {
      const d = this.dive;
      if (d.stage === 'dive') {
        d.clock = a === 'dive' ? p.action.t : d.clock + dt;
        if (d.clock >= 0.75 && a !== 'dive') { d.stage = 'down'; d.downT = 0; }
      } else if (d.stage === 'down') {
        d.downT = a === 'down' ? p.action.t : d.downT + dt;
        if (a !== 'down' && d.downT >= d.downDur) d.stage = 'out';
      }
    }
    this.solver.inDive = !!this.dive && this.dive.stage !== 'out';
    this.diveW += ((this.dive && this.dive.stage !== 'out' ? 1 : 0) - this.diveW) * (1 - Math.exp(-dt * (this.dive?.stage === 'out' ? 7 : 30)));
    if (this.dive?.stage === 'out' && this.diveW < 0.01) this.dive = null;
    const sliding = !!this.actions.slide && (a === 'slide' || (a === 'stumble' && this.gettingUp));
    // A backheel has no captured clip: the procedural kick plays it.
    const backheel = a === 'kick' && this.solver.kickFlavour.flavour === 'backheel';
    const actP = (a !== 'none' || this.holdThrow || this.solver.gkLayer || this.solver.overlay) && (a !== 'kick' || backheel) && !sliding ? this.solver.actW : 0;
    // Captured one-shots ease in and out over about a tenth of a second.
    this.shotW += ((this.shot ? 1 : 0) - this.shotW) * (1 - Math.exp(-dt * 14));
    if (!this.shot && this.shotW < 0.01) this.lastShot = null;
    this.procW = Math.max(actP, this.solver.jockW, this.keeperW, ballHeldByMe ? 1 : 0) * (1 - this.shotW) * (1 - this.diveW);

    // Locomotion weights by a smoothed ground speed (the simulation's velocity steps every tick,
    // which made the clip weights flicker) between neighbouring clips. Each clip sits at the game
    // speed it represents, not the slower speed it was captured at.
    this.spd += (speed - this.spd) * (1 - Math.exp(-dt * 9));
    const gs = this.spd;
    this.gait.update(p.vel.x, p.vel.z, dt);
    // Turning on the spot: step round instead of swivelling on planted feet.
    const spin = Math.abs(turnRate);
    const stepWant = gs < 1.2 && a === 'none' ? Math.min(1, Math.max(0, (spin - 1.2) / 3)) : 0;
    this.turnStep += (stepWant - this.turnStep) * (1 - Math.exp(-dt * (stepWant > this.turnStep ? 14 : 5)));
    const anchors: [ClipName, number][] = [['idle', 0]];
    for (const n of ['walk', 'jog', 'sprint'] as const) {
      if (this.src[n]) anchors.push([n, Math.max(LOCO_SPEED[n], anchors[anchors.length - 1][1] + 0.5)]);
    }
    const w: Partial<Record<ClipName, number>> = {};
    if (gs >= anchors[anchors.length - 1][1]) w[anchors[anchors.length - 1][0]] = 1;
    else for (let i = 0; i < anchors.length - 1; i++) {
      const [n0, s0] = anchors[i], [n1, s1] = anchors[i + 1];
      if (gs >= s0 && gs < s1) { const t = (gs - s0) / (s1 - s0); const e = t * t * (3 - 2 * t); w[n0] = 1 - e; w[n1] = e; break; }
    }
    // Slow speeds step out of the idle sooner (short steps rather than gliding on the idle pose).
    if (this.src.walk && gs > 0.05 && gs < LOCO_SPEED.walk) {
      const e = sm01(gs / 0.75);
      w.walk = Math.max(w.walk ?? 0, e); w.idle = 1 - w.walk;
    }
    // Stepping round on the spot.
    if (this.src.walk && this.turnStep > 0.01) {
      const k = 0.6 * this.turnStep;
      if ((w.walk ?? 0) < k) { w.walk = k; w.idle = Math.max(0, 1 - k - (w.jog ?? 0) - (w.sprint ?? 0)); }
    }
    // Tired legs: a heavier, shorter jog (part of the walk clip mixed in).
    const tired = this.solver.tired;
    if (tired > 0.05 && this.src.walk && (w.jog ?? 0) > 0) {
      const mv = 0.3 * tired * (w.jog ?? 0) * Math.min(1, Math.max(0, (gs - 2) / 1.5));
      w.jog! -= mv; w.walk = (w.walk ?? 0) + mv;
    }
    // Shared gait phase, advanced by distance over the blended stride length. Played at game
    // speed, a clip's stride is stretched by the square root of the speed ratio and its cadence
    // takes the rest, so legs neither spin nor skate.
    let stride = 0, sw = 0;
    for (const n of ['walk', 'jog', 'sprint'] as const) {
      const s = this.src[n], k = w[n] ?? 0;
      if (s && k > 0) { stride += k * this.strideAt(n, s, Math.max(gs, LOCO_SPEED[n])); sw += k; }
    }
    if (sw > 0) {
      // A blend with the idle clip takes shorter steps, so the feet turn over at the speed the
      // body moves (otherwise slow walks glide). Hard braking and accelerating take quicker, shorter steps.
      const amp = Math.max(0.35, Math.min(1, sw));
      const acc = this.gait.acc;
      const choppy = 1 - 0.22 * Math.min(1, Math.max(0, (Math.abs(acc) - 2) / 6)) * Math.min(1, gs / 2);
      const strideLen = Math.max(0.3, (stride / sw) * amp * choppy);
      this.phase = (this.phase + (speed * dt) / strideLen + this.turnStep * dt * Math.min(1.6, spin / 3)) % 1;
    }
    this.idleT += dt;

    // Kick: warp the clip so the boot meets the ball at the simulation's release time.
    const kick = this.actions.kick, ks = this.src.kick;
    let kickW = 0;
    if (kick && ks && a === 'kick' && !backheel) {
      kickW = this.solver.actW;
      const wind = p.action.kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup;
      const t = p.action.t;
      // A chip is a short stab (little follow-through); a power shot follows right through.
      const toe = this.solver.kickFlavour.flavour === 'toe';
      const follow = this.kickStyle.style === 'chip' || toe ? 0.3 : this.kickStyle.style === 'power' ? 0.75 : 0.6;
      // A toe poke starts halfway through the backswing: a short stab.
      const back = toe ? ks.backswing + (ks.contact - ks.backswing) * 0.5 : ks.backswing;
      kick.time = t < wind ? back + (ks.contact - back) * (t / wind) : ks.contact + (t - wind) * ((ks.contact - ks.backswing) / wind) * follow;
      kick.time = Math.min(kick.time, ks.clip.duration);
    }
    // Slide: the take-off and the drop to the ground in the first 0.25 s, the glide for the rest
    // of the slide, then the clip's own get-up over the time the simulation keeps the player down.
    const slide = this.actions.slide, ss = this.src.slide;
    let slideW = 0;
    if (sliding && slide && ss) {
      slideW = this.solver.actW;
      const b = ss.slide, t = p.action.t;
      if (a === 'slide') {
        const k = 0.25;
        slide.time = t < k ? b.drop + (b.low - b.drop) * (t / k) : b.low + (b.rise - b.low) * Math.min(1, (t - k) / Math.max(0.01, p.action.dur - k));
      } else slide.time = b.rise + (b.end - b.rise) * Math.min(1, t / Math.max(0.01, p.action.dur));
    }
    const shotName = this.shot?.name ?? this.lastShot;
    const shotW = shotName ? this.shotW : 0;
    if (this.shot) this.shotTime(p, dt);
    // Mirrored for a captured save to the left, and for kicks struck with the left foot.
    this.body.scale.x = (shotW > 0 && this.shot?.mirror) || (kickW > 0.02 && this.kickStyle.foot < 0) ? -1 : 1;
    // Keep the shirt number readable when the body is mirrored.
    for (const d of [this.numMesh, ...this.decals]) d.scale.x = Math.abs(d.scale.x) * this.body.scale.x;
    const locoW = Math.max(0, 1 - kickW - slideW - shotW);
    for (const n of LOCO) {
      const act = this.actions[n];
      if (!act) continue;
      const s = this.src[n]!;
      act.time = n === 'idle' ? this.idleT % s.clip.duration : (s.phase0 + this.phase * s.cycle) % s.clip.duration;
      act.setEffectiveWeight((w[n] ?? 0) * locoW);
    }
    kick?.setEffectiveWeight(kickW);
    slide?.setEffectiveWeight(slideW);
    for (const n of SHOTS) this.actions[n]?.setEffectiveWeight(n === shotName ? Math.min(shotW, 1 - kickW - slideW) : 0);
    this.mixer.update(0);
    this.applyProcedural();
    // Running style layer over the motion-captured run (see applyRunLayer).
    const runW = Math.min(1, Math.max(0, (speed - 1.2) / 2)) * (1 - this.procW) * (1 - kickW) * (1 - slideW) * (1 - shotW);
    this.dribW += ((this.dribbling ? 1 : 0) - this.dribW) * (1 - Math.exp(-dt * 6));
    const dW = this.dribW * Math.min(1, speed / 0.6) * (1 - this.procW) * (1 - kickW) * (1 - slideW) * (1 - shotW);
    if (runW > 0.001) this.applyRunLayer(runW, speed);
    if (dW > 0.001) this.applyDribbleArms(dW, speed);
    // Walking: arms hang close to the body with a small, soft swing (see applyWalkArms).
    const wW = sm01((this.spd - 0.25) / 0.45) * (1 - sm01((this.spd - 2.1) / 1.2)) * (1 - this.procW) * (1 - kickW) * (1 - slideW) * (1 - shotW) * (1 - this.dribW);
    if (wW > 0.001) { this.applyWalkPosture(wW); this.applyWalkArms(wW, this.spd); }
    if (kickW > 0.001) { this.applyKickStyle(p, kickW); this.applyKickFlavour(p, kickW); }
    const free = (1 - this.procW) * (1 - kickW) * (1 - slideW) * (1 - shotW);
    // Gestures: first touches, dribbling touches, blocks (only the bones each one needs).
    const g = this.solver.gesture;
    if (g && this.solver.gestW > 0.001 && free > 0.001) this.applyGesture(g, this.solver.gestW * free, speed);
    // Resting: hands on knees or hips.
    if (this.solver.restW > 0.001 && free > 0.001) {
      const W = this.solver.restW * free;
      this.applyPoseOver(this.solver.restPose, W);
      this.body.position.y += this.solver.restPose[BY] * W;
    }
    // Speeding up and braking, planting a foot to cut, and tired running.
    this.applyGaitLean(p, speed, free, runW);
    if (shotW > 0.001 && this.shot?.name === 'header') this.applyHeaderStyle(p, shotW);
    if (slideW > 0.001 && slide && ss) this.groundSlide(slideW, slide.time, ss);
    if (a === 'throw' && p.role === 'GK') this.applyKeeperThrowTwist(p, this.procW);
    // Bank about the feet: turning right (facing increasing) leans right, towards local -X.
    if (Math.abs(this.bank) > 1e-3) this.body.rotation.z += this.bank * (1 - this.procW) * (1 - this.diveW) * (1 - shotW);
    // After the whistle: arms, head and back (and legs for a crouch) take the reaction pose.
    const rc = this.reaction;
    const reactW = rc && a === 'none' && !ballHeldByMe ? rc.w * (1 - shotW) * (1 - this.diveW) * (1 - kickW) : 0;
    if (rc && reactW > 0.001) {
      const legs = rc.full && speed < 0.8;
      this.reactPose.set(this.solver.pose);
      for (const c of rc.only ?? UPPER) this.reactPose[c] = rc.pose[c];
      if (legs) for (const c of LEGS) this.reactPose[c] = rc.pose[c];
      this.applyPoseOver(this.reactPose, reactW, !legs, rc.only ? RIGHT_ARM : undefined);
      if (legs) this.body.position.y += rc.pose[BY] * reactW * Math.max(0, 1 - speed / 0.8);
    }
    if (this.dive && this.diveW > 0.001) this.applyDive(p, ballHeldByMe, dt);
    // Eyes on the ball: the head (and a little of the neck) turns to follow it.
    const lookW = (this.lookAtBall ? 1 : 0) * (this.solver.falling ? 0.3 : 1) * (1 - this.diveW) * (1 - shotW) * (1 - slideW) * (1 - reactW) * (1 - 0.8 * kickW) * (1 - 0.6 * dW) * (a === 'celebrate' || a === 'throw' || this.holdThrow ? 0 : 1);
    this.updateScan(p, ballPos, dt, speed, ballHeldByMe);
    this.applyHeadLook(p, ballPos, dt, lookW);
    // Planted feet stay where they are on the grass.
    const ikWant = this.footIK && this.body.scale.x > 0 && this.root.position.y < 0.005 && !this.solver.falling ? (1 - this.diveW) * (1 - shotW) * (1 - slideW) : 0;
    this.ikOn += (ikWant - this.ikOn) * (1 - Math.exp(-dt * 12));
    this.plantFeet(dt, this.ikOn);
    // Face and kit: open mouth when shouting, celebrating or out of breath; mud and sweat.
    this.updateFace(p, dt, time, speed, rc && reactW > 0.05 ? rc.kind : null, shotW > 0.3 && !!this.shot && (CHEERS as readonly string[]).includes(this.shot.name));
    if (this.hair?.active && this.root.visible) this.hair.update(dt, this.root);
  }

  /** How tired the player looks (0..1), set by the renderer. */
  get tired() { return this.solver.tired; }
  set tired(v: number) { this.solver.tired = v; }
  /** A stoppage or play far away (a tired player rests), set by the renderer. */
  get resting() { return this.solver.resting; }
  set resting(v: boolean) { this.solver.resting = v; }
  /** The opposing ball carrier (tackle styles), set by the renderer. */
  get foe() { return this.solver.foe; }
  set foe(v: { x: number; z: number; vx: number; vz: number } | null) { this.solver.foe = v; }
  /** Where a kick that is starting is meant to go, set by the renderer. */
  get aimHint() { return this.solver.aimHint; }
  set aimHint(v: { x: number; z: number } | null) { this.solver.aimHint = v; }
  /** The foot swinging forward now (+1 right): the left foot is furthest forward at phase 0, so it swings through in the second half of the cycle. */
  get swingSide(): 1 | -1 { return this.phase >= 0.5 ? -1 : 1; }
  /** Play a gesture (first touch, dribbling touch, block, stagger). */
  play(g: Gesture) { this.solver.play(g); }
  /** Fouled by a player at `from`. */
  onFouled(from: { x: number; z: number }) { this.solver.onFouled(from); }
  /** Current gesture, scan and plant (tests and screenshot scripts). */
  get motionState() { return { gesture: this.solver.gesture?.kind ?? null, scanning: !!this.scan, plant: this.gait.plant, acc: this.gait.acc, rest: this.solver.restW, falling: this.solver.falling, tackle: this.solver.tackleStyle.style, flavour: this.solver.kickFlavour.flavour, locked: this.feet.map((f) => !!f.lock) }; }

  private gestP = new Float32Array(17);
  /** A gesture over the bones it needs: the touching leg while running, more of the body when slow. */
  private applyGesture(g: Gesture, W: number, speed: number) {
    const parts = gestureParts(g.kind, speed);
    const leg: Seg[] = g.side > 0 ? ['thighR', 'shinR'] : ['thighL', 'shinL'];
    const only = parts === 'leg' ? new Set<Seg>(leg) : parts === 'legArms' ? new Set<Seg>([...leg, 'armL', 'foreL', 'armR', 'foreR', 'spine', 'neck']) : undefined;
    this.gestP.set(this.solver.gestPose);
    this.applyPoseOver(this.gestP, W, parts === 'upper', only);
    if (parts === 'all') this.body.position.y += this.gestP[BY] * W;
    // The boot turns: out for a cushioned touch (inside of the foot), in and then out for a flick.
    const u = Math.min(1, g.t / g.dur);
    const up = `${g.side > 0 ? 'Right' : 'Left'}UpLeg`;
    if (g.kind === 'cushion' || g.kind === 'thigh') this.turnChar(up, AXIS_Y, -g.side * 0.55 * W);
    else if (g.kind === 'flick') this.turnChar(up, AXIS_Y, g.side * (0.5 - 0.9 * sm01((u - 0.2) / 0.3)) * W);
    else if (g.kind === 'block') this.turnChar(up, AXIS_Y, -g.side * 0.4 * W);
  }

  /** Toe pokes and outside-of-the-boot passes on top of the captured kick (right foot; the body mirrors for the left). */
  private applyKickFlavour(p: ViewPlayer, W: number) {
    const fl = this.solver.kickFlavour.flavour;
    if (!fl || fl === 'backheel') return;
    const wind = p.action.windup ?? (p.action.kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup);
    const t = p.action.t;
    const pre = sm01(t / wind), post = sm01((t - wind) / 0.22);
    const swing = pre * (1 - sm01((t - wind - 0.12) / 0.2));
    if (fl === 'toe') {
      // Reach in with a straight leg, toes down, chest over it.
      this.turnChar('Spine01', AXIS_X, 0.22 * pre * W);
      this.turnChar('RightUpLeg', AXIS_X, -0.18 * swing * W);
      this.turnChar('RightLeg', AXIS_X, -0.3 * swing * W);
      this.turnChar('RightFoot', AXIS_X, 0.45 * swing * W);
      this.turnChar('LeftArm', AXIS_Z, 0.35 * pre * W);
    } else {
      // Outside of the boot: toes turned in through the ball, the leg carrying on out to the side.
      this.turnChar('RightUpLeg', AXIS_Y, 0.6 * swing * W);
      this.turnChar('RightLeg', AXIS_Y, 0.25 * swing * W);
      this.turnChar('RightUpLeg', AXIS_Z, -0.4 * post * W);
      this.turnChar('Spine01', AXIS_Y, -0.14 * swing * W);
      this.turnChar('Spine01', AXIS_Z, 0.08 * post * W);
      this.turnChar('LeftArm', AXIS_Z, 0.3 * pre * W);
    }
  }

  private leanAcc = 0;
  /**
   * The body's lean from what the legs are doing: forward when driving off, back when braking,
   * down and into the turn on a planted foot when cutting, heavier and head down when tired.
   */
  private applyGaitLean(p: ViewPlayer, speed: number, free: number, runW: number) {
    if (free < 0.001) return;
    const acc = this.gait.acc;
    const moving = Math.min(1, Math.max(0, (Math.max(speed, this.spd) - 0.4) / 1.5));
    const want = (acc > 0 ? Math.min(0.2, acc * 0.028) : Math.max(-0.24, acc * 0.03)) * moving;
    this.leanAcc += (want - this.leanAcc) * 0.25;
    const lean = this.leanAcc * free;
    if (Math.abs(lean) > 1e-3) {
      // Lean from the ankles and the waist; braking also sits the hips down (the knees bend over planted feet).
      this.body.rotation.x += lean * 0.45;
      this.turnChar('Spine', AXIS_X, lean * 0.6);
      if (lean < 0) this.body.position.y += lean * 0.25;
      // Arms come forward a little when braking, drive harder when accelerating.
      if (lean < 0) { this.turnChar('LeftArm', AXIS_X, lean * 1.6); this.turnChar('RightArm', AXIS_X, lean * 1.6); }
    }
    const pl = this.gait.plant * free;
    const cut = this.gait.cut;
    if (pl > 0.001 && cut) {
      const s = cut.side; // +1 cutting to the player's left
      // Into the turn from the feet, hips down, chest over the knee.
      this.body.rotation.z += -s * 0.2 * pl;
      this.body.position.y -= 0.07 * pl;
      this.turnChar('Spine', AXIS_X, 0.14 * pl);
      // The outside foot plants wide and pushes; the outside arm swings out for balance, the inside one in.
      const out = s > 0 ? 'Right' : 'Left', inn = s > 0 ? 'Left' : 'Right';
      this.turnChar(`${out}UpLeg`, AXIS_Z, -s * 0.28 * pl);
      this.turnChar(`${inn}UpLeg`, AXIS_X, -0.25 * pl);
      this.turnChar(`${out}Arm`, AXIS_Z, -s * 0.45 * pl);
      this.turnChar(`${inn}Arm`, AXIS_Z, -s * 0.15 * pl);
      // Head and shoulders already looking down the new line.
      this.turnChar('Spine02', AXIS_Y, s * 0.18 * pl);
      this.turnChar('neck', AXIS_Y, s * 0.25 * pl);
    }
    const tired = this.solver.tired;
    if (tired > 0.01 && runW > 0.001 && p.role !== 'GK') {
      const k = tired * runW;
      this.turnChar('Spine02', AXIS_X, 0.07 * k);
      this.turnChar('neck', AXIS_X, 0.16 * k);
      this.turnChar('LeftArm', AXIS_Z, -0.06 * k);
      this.turnChar('RightArm', AXIS_Z, 0.06 * k);
    }
  }

  /** Shoulder checks: a look behind before a pass arrives, and every few seconds near the ball. */
  private updateScan(p: ViewPlayer, ballPos: THREE.Vector3, dt: number, speed: number, held: boolean) {
    this.scanCool -= dt;
    if (this.scan && (this.scan.t -= dt) <= 0) this.scan = null;
    const free = p.action.type === 'none' && !held && !this.dribbling && speed < 7 && !this.solver.falling;
    if (!free) { this.scan = null; return; }
    if (this.scan || this.scanCool > 0 || this.scanCue === 0) return;
    const go = this.scanCue === 2 || Math.random() < dt / 2.2;
    if (!go) return;
    // Look over the shoulder on the side away from the ball.
    const dx = ballPos.x - p.pos.x, dz = ballPos.z - p.pos.z;
    const rel = Math.atan2(Math.sin(Math.atan2(dz, dx) - (this.yaw ?? p.facing)), Math.cos(Math.atan2(dz, dx) - (this.yaw ?? p.facing)));
    const side = rel > 0 ? 1 : -1; // ball to the right (rel > 0): look back over the left shoulder (+yaw is to the left)
    const dur = this.scanCue === 2 ? 0.5 : 0.42;
    this.scan = { t: dur, dur, side };
    this.scanCool = this.scanCue === 2 ? 1.4 : 2.2 + Math.random() * 2.5;
  }

  private static readonly _ft = new THREE.Vector3();
  /**
   * Planted feet: a foot on the grass is held where it landed (two-bone leg solve) until it lifts or
   * the body has moved too far from it, so feet don't skate while turning, slowing or blending clips.
   * Feet the body has pushed into the ground (crouching, braking, planting) are lifted onto it.
   */
  private plantFeet(dt: number, W: number) {
    if (W < 0.01) { for (const f of this.feet) { f.lock = null; f.w = 0; } return; }
    this.root.updateMatrixWorld(true);
    const sy = this.root.scale.y;
    const pole = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    for (const f of this.feet) {
      const thigh = this.bone(`${f.side}UpLeg`), shin = this.bone(`${f.side}Leg`), foot = this.bone(`${f.side}Foot`);
      if (!thigh || !shin || !foot) continue;
      const A = foot.getWorldPosition(new THREE.Vector3());
      const ground = f.ankleY * sy;
      const stance = A.y < ground + 0.045 * sy;
      if (stance && !f.lock) f.lock = new THREE.Vector3(A.x, ground, A.z);
      else if (!stance) f.lock = null;
      if (f.lock && Math.hypot(f.lock.x - A.x, f.lock.z - A.z) > 0.32 * sy) f.lock = null;
      // Hold weight: in quickly when the foot lands, out over a few frames when it lets go.
      f.w += ((f.lock ? 1 : 0) - f.w) * (1 - Math.exp(-dt * (f.lock ? 30 : 18)));
      if (f.lock) f.hold.copy(f.lock);
      const T = RealPlayerModel._ft.copy(A);
      if (f.w > 0.001) { T.x += (f.hold.x - A.x) * f.w; T.z += (f.hold.z - A.z) * f.w; }
      T.y = Math.max(A.y, ground * 0.97);
      const k = W;
      T.lerpVectors(A, T, k);
      if (T.distanceToSquared(A) < 1e-8) continue;
      if (!solveLeg(thigh, shin, foot, T, pole)) f.lock = null;
    }
  }

  private bone(name: string) {
    let b = this.boneCache.get(name);
    if (b === undefined) { b = this.model.getObjectByName(name) ?? null; this.boneCache.set(name, b); }
    return b;
  }

  private headLook(p: ViewPlayer, ballPos: THREE.Vector3) {
    const dx = ballPos.x - p.pos.x, dz = ballPos.z - p.pos.z;
    const dist = Math.hypot(dx, dz);
    const ang = Math.atan2(Math.sin(Math.atan2(dz, dx) - (this.yaw ?? p.facing)), Math.cos(Math.atan2(dz, dx) - (this.yaw ?? p.facing)));
    // Ball behind: only a glance over the shoulder.
    const behind = Math.abs(ang) > 2.3 ? 0.35 : 1;
    const yaw = Math.max(-1.15, Math.min(1.15, -ang)) * behind * (dist < 0.4 ? 0 : 1);
    const elev = Math.atan2(ballPos.y - 1.6, Math.max(dist, 0.3));
    const pitch = Math.max(-0.45, Math.min(0.6, -elev));
    return { yaw, pitch };
  }

  /** Turn the head towards the ball (character space), smoothed so it never snaps. */
  private applyHeadLook(p: ViewPlayer, ballPos: THREE.Vector3, dt: number, W: number) {
    const t = this.headLook(p, ballPos);
    // A shoulder check: a quick look over the shoulder away from the ball, then back to it.
    let scanK = 0;
    if (this.scan) {
      const u = 1 - this.scan.t / this.scan.dur;
      scanK = Math.sin(Math.PI * Math.min(1, Math.max(0, u))) * W;
      t.yaw = t.yaw * (1 - scanK) + this.scan.side * 1.75 * scanK;
      t.pitch *= 1 - scanK;
    }
    const k = 1 - Math.exp(-dt * (this.scan ? 14 : 7));
    this.headYaw += (t.yaw * W - this.headYaw) * k;
    this.headPitch += (t.pitch * W - this.headPitch) * k;
    if (Math.abs(this.headYaw) + Math.abs(this.headPitch) < 1e-3) return;
    const yaw = this.headYaw * this.body.scale.x;
    // Past what the neck can turn, the shoulders come round too.
    const over = Math.sign(yaw) * Math.max(0, Math.abs(yaw) - 1.15);
    if (over) { this.turnChar('Spine01', AXIS_Y, over * 0.35); this.turnChar('Spine02', AXIS_Y, over * 0.45); }
    this.turnChar('neck', AXIS_X, this.headPitch * 0.35);
    this.turnChar('neck', AXIS_Y, yaw * 0.4);
    this.turnChar('Head', AXIS_X, this.headPitch * 0.5);
    this.turnChar('Head', AXIS_Y, yaw * 0.6);
  }

  /** How far the head is turned to follow the ball (yaw, pitch in radians), for tests. */
  /** A camera in front of his face, for close-up tests: where to stand and where to look. */
  faceView(dist = 0.7): { pos: [number, number, number]; look: [number, number, number] } | null {
    const sm = (this.meshes as THREE.SkinnedMesh[]).find((m) => m.isSkinnedMesh);
    const head = this.model.getObjectByName('Head');
    if (!sm || !head) return null;
    this.model.updateWorldMatrix(true, true);
    // Skinned like the face itself: the head bone's world matrix times its inverse bind times the bind matrix.
    const bi = sm.skeleton.bones.indexOf(head as THREE.Bone);
    if (bi < 0) return null;
    const m = new THREE.Matrix4().copy(head.matrixWorld).multiply(sm.skeleton.boneInverses[bi]).multiply(sm.bindMatrix);
    const nose = new THREE.Vector3(0, 1.66, 0.1).applyMatrix4(m);
    const f = new THREE.Vector3(0, 0, 1).transformDirection(m);
    const look = nose.clone().addScaledVector(f, -0.06);
    const pos = look.clone().addScaledVector(f, dist).add(new THREE.Vector3(0, 0.02, 0));
    return { pos: [pos.x, pos.y, pos.z], look: [look.x, look.y, look.z] };
  }

  get headTurn() {
    return { yaw: this.headYaw, pitch: this.headPitch };
  }

  /** Mouth (shouting, celebrating, breathing hard) and the kit's mud and sweat. */
  private updateFace(p: ViewPlayer, dt: number, time: number, speed: number, reaction: string | null, cheering: boolean) {
    const w = (f: number) => Math.abs(Math.sin(time * f + this.id * 1.7));
    let target = 0;
    if (cheering || p.action.type === 'celebrate') target = 0.75 + 0.25 * w(8);
    else if (reaction === 'protest' || reaction === 'appeal' || reaction === 'urge' || reaction === 'point') target = 0.25 + 0.6 * w(7);
    else if (reaction === 'armsUp' || reaction === 'fistPump' || reaction === 'kneeSlide') target = 0.85;
    else if (reaction === 'huddle') target = 0.45 + 0.4 * w(6);
    else if (reaction === 'badgeKiss') target = 0.05;
    else if (reaction === 'highFive' || reaction === 'clap') target = 0.25 + 0.3 * w(5);
    else if (reaction === 'headInHands' || reaction === 'crouch') target = 0.35;
    else if (speed > 5.5) target = 0.12 + 0.25 * (1 - Math.max(0, Math.min(1, p.stamina))) + 0.08 * w(5);
    // The rest of the face: joy when celebrating, effort when straining (a sprint on tired legs, a
    // shot, a tackle, a header), frustration after a miss or a decision against him.
    const a = p.action.type;
    let mood: keyof typeof MOODS = 'calm', amt = 1;
    if (cheering || a === 'celebrate' || reaction === 'armsUp' || reaction === 'fistPump' || reaction === 'kneeSlide' || reaction === 'huddle' || reaction === 'highFive' || reaction === 'clap' || reaction === 'badgeKiss' || reaction === 'lift') mood = 'joy';
    else if (reaction === 'protest' || reaction === 'appeal' || reaction === 'headInHands' || reaction === 'crouch' || reaction === 'dejected' || reaction === 'handsOnHips') { mood = 'anger'; amt = reaction === 'handsOnHips' ? 0.6 : 1; }
    else if (a === 'kick' || a === 'tackle' || a === 'slide' || a === 'header' || a === 'dive' || a === 'barge' || a === 'jump' || a === 'catch') mood = 'effort';
    else if (speed > 5.5) { mood = 'effort'; amt = Math.min(1, 0.25 + (speed - 5.5) * 0.25 + 0.5 * (1 - Math.max(0, Math.min(1, p.stamina)))); }
    else if (p.stamina < 0.35) { mood = 'effort'; amt = 0.35; }
    if (this.moodOverride) { mood = this.moodOverride; amt = 1; }
    this.mood = mood;
    const want = MOODS[mood], ek = this.moodOverride ? 1 : 1 - Math.exp(-dt * (mood === 'effort' ? 9 : 5));
    this.expr.brow += (want.brow * amt - this.expr.brow) * ek;
    this.expr.smile += (want.smile * amt - this.expr.smile) * ek;
    this.expr.squint += (want.squint * amt - this.expr.squint) * ek;
    this.expr.grit += (want.grit * amt - this.expr.grit) * ek;
    if (this.moodOverride) { target = mood === 'joy' ? 0.7 : mood === 'anger' ? 0.3 : 0; }
    // Gritted teeth keep the mouth nearly shut.
    if (mood === 'effort' && a !== 'none') target = Math.min(target, 0.12);
    this.mouth += (target - this.mouth) * (this.moodOverride ? 1 : 1 - Math.exp(-dt * 10));
    this.look.uMouth.value = this.mouth;
    this.look.uExpr.value.set(this.expr.brow, this.expr.smile, this.expr.squint, this.expr.grit);
    this.look.uCloth.value.set(time, this.spd, this.id * 1.37);
    this.look.uMud.value = this.wear.mud;
    this.look.uMudFront.value = this.wear.front;
    this.look.uSweat.value = this.wear.sweat;
  }

  /** After the whistle (render/reactions.ts): set each frame by the renderer, null when not reacting. */
  reaction: ReactionFrame | null = null;
  private reactPose = new Float32Array(17);

  /** Where a ball held by this player sits: between the gloves while diving or lying after a dive. */
  heldBallPos(out: THREE.Vector3): boolean {
    const p = this.lastP;
    const l = this.model.getObjectByName('LeftHand'), r = this.model.getObjectByName('RightHand');
    if (!l || !r) return false;
    this.root.updateMatrixWorld(true);
    // Throwing or rolling it out: in the right hand, in the palm.
    if (p?.role === 'GK' && p.action.type === 'throw') {
      out.copy(r.getWorldPosition(_v));
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
      out.addScaledVector(fwd, 0.04).y = Math.max(out.y + 0.02, 0.13);
      return true;
    }
    if ((!this.dive || this.diveW < 0.5) && p?.role !== 'GK') return false;
    out.copy(l.getWorldPosition(_v)).add(r.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    if (!this.dive || this.diveW < 0.5) {
      // Caught standing (or carried): between the gloves, in front of the hands' bones.
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.body.getWorldQuaternion(_q2));
      out.addScaledVector(fwd, 0.1);
    }
    out.y = Math.max(out.y, 0.13);
    return true;
  }

  /** Match 'parry' event: this keeper pushed the ball away. */
  onParry(ballY: number) {
    this.solver.onParry(ballY);
    if (this.dive && this.dive.stage === 'dive' && !this.dive.parry) { this.dive.parry = 1; this.dive.parryT = 0; }
  }
  /** Set by the renderer each frame: the ball is loose or in flight from an opponent (keepers' hands rise to it). */
  ballFoe = false;
  /** The catch the solver is playing (tests). */
  get catchStyle() { return this.solver.catchStyle; }
  /** The kind of the current dive (tests). */
  get diveKind() { return this.dive?.kind ?? null; }

  /** Track a keeper dive (and the time down after it) that the skeleton-driven dive will play. */
  private startDive(p: ViewPlayer, a: string) {
    if (a === 'dive' && p.action.target && this.shot?.name !== 'catch') {
      const T = p.action.target;
      const lat = (T.x - p.pos.x) * -Math.sin(p.facing) + (T.z - p.pos.z) * Math.cos(p.facing);
      // Standing hips in the root's frame, from the bind pose scaled like the clips.
      this.root.updateMatrixWorld(true);
      const hips = this.model.getObjectByName('Hips')!;
      const hw = hips.getWorldPosition(new THREE.Vector3());
      const hips0 = this.root.worldToLocal(hw.clone());
      hips0.x = 0; hips0.z = 0;
      hips0.y = Math.min(hips0.y, 1.05);
      this.dive = { start: new THREE.Vector3(p.pos.x, 0, p.pos.z), facing: p.facing, s: lat >= 0 ? -1 : 1, lat: Math.abs(lat), target: new THREE.Vector3(T.x, T.y, T.z), hips0, stage: 'dive', held: 0, downDur: 0.55, kind: diveKindFor(Math.abs(lat), T.y), parry: 0, parryT: 0, clock: 0, downT: 0 };
    } else if (a === 'down' && this.dive && this.dive.stage === 'dive') {
      this.dive.stage = 'down';
      this.dive.downDur = Math.max(0.2, p.action.dur);
      this.dive.downT = 0;
    } else if (this.dive && this.dive.stage !== 'out' && (a === 'catch' || (a === 'none' && this.dive.held > 0))) {
      // Caught in the dive: the simulation has the ball in his hands at once, but the dive plays on,
      // landing with the ball and getting up with it (cut short if he releases it first).
    } else if (this.dive && this.dive.stage !== 'out') {
      this.dive.stage = 'out';
    }
  }

  /**
   * Goalkeeper dive, posed on the skeleton rather than from a clip (the animation library has no
   * keeper dive). Built from real technique and GOALS' keepers: a short load and side step, a
   * push off the near leg with the far knee driving up, the body launched and rolled towards the
   * ball with both arms stretched overhead so the gloves arrive on the save point, then a landing
   * on the side (ball pulled into the chest when caught) and a roll back up to the feet.
   * The hips follow a planned path (start → contact → landing) and the whole body is shifted so
   * the gloves meet the ball at contact and nothing goes through the grass.
   */
  private applyDive(p: ViewPlayer, held: boolean, dt: number) {
    const d = this.dive!;
    const W = this.diveW;
    const s = d.s; // +1: dive to the keeper's left (local +X), -1: to his right
    const tc = 0.32;
    const sm = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
    const out = (x: number) => { const c = Math.min(1, Math.max(0, x)); return 1 - (1 - c) * (1 - c); };
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    if (held) d.held = Math.min(1, d.held + 0.08);
    const kind = d.kind;
    const collapse = kind === 'collapse' ? 1 : 0, high = kind === 'high' ? 1 : 0, low = kind === 'low' ? 1 : 0;
    // Plan: hips at contact so the stretched arms (hips to gloves ~1.15 m) reach the save point.
    const H0 = d.hips0;
    const span = 1.15 * this.root.scale.y;
    const ty = d.target.y;
    // A collapsing save never leaves the ground: the hips drop straight down to the side.
    const hy = collapse ? Math.min(0.42, Math.max(0.28, ty - 0.35)) : Math.min(high ? 1.4 : 1.3, Math.max(low ? 0.25 : 0.3, ty - (high ? 0.45 : 0.35)));
    const dz = ty - hy;
    let horiz = Math.sqrt(Math.max(0, span * span - dz * dz));
    horiz = Math.min(horiz, d.lat);
    const hl = Math.max(0, d.lat - horiz);
    const rollC = Math.atan2(horiz, Math.max(0.05, dz)); // body axis from vertical at contact
    const rollLand = Math.max(rollC, 1.42);
    // A collapse goes straight over onto the side rather than flying across.
    const rollCc = collapse ? Math.max(rollC, 1.15) : rollC;
    // Time through the move.
    const t = d.stage === 'dive' ? d.clock : 0.75;
    const u = d.stage === 'down' ? Math.min(1, d.downT / d.downDur) : d.stage === 'out' ? 1 : 0;
    const load = sm(t / 0.1);
    const launch = collapse ? sm((t - 0.03) / (tc - 0.03)) : out((t - 0.06) / (tc - 0.06));
    const fall = Math.min(1, Math.max(0, (t - tc) / (0.75 - tc)));
    const rise = sm((u - 0.35) / 0.65);
    // Hips path in the dive's start frame (x lateral towards the dive, y up, z forward).
    let lx = lerp(0, 0.12, load), ly = lerp(H0.y, H0.y - 0.16 - 0.1 * collapse, load), lz = lerp(0, 0.06, load);
    lx = lerp(lx, hl, launch); ly = lerp(ly, hy, launch); lz = lerp(lz, 0.18, launch);
    lx = lerp(lx, hl + 0.12, fall); ly = lerp(ly, 0.17, fall * fall); lz = lerp(lz, 0.25, fall);
    // Getting up: back over the simulated position, through a kneel, to the ready stance.
    const simLat = (p.pos.x - d.start.x) * -Math.sin(d.facing) + (p.pos.z - d.start.z) * Math.cos(d.facing);
    lx = lerp(lx, Math.abs(simLat), rise); ly = lerp(ly, H0.y - 0.12, rise); lz = lerp(lz, 0, rise);
    let roll = lerp(0, 0.1, load);
    roll = lerp(roll, rollCc, launch);
    roll = lerp(roll, rollLand, fall);
    roll = lerp(roll, 0, rise);
    // Limb pose (same conventions as player.ts).
    const P = this.diveP;
    P.fill(0);
    const near = s > 0 ? 'L' : 'R'; // push-off (bottom) leg on the side of the dive
    const reachK = launch * (1 - 0.5 * d.held) * (1 - rise);
    const tuck = d.held * (1 - rise);
    // Arms: from the ready stance up overhead towards the ball, tucked to the chest once caught.
    // After the save the arms come down to cushion the landing (or hug the ball when caught).
    const land = sm((t - 0.45) / 0.3) * (1 - rise);
    // A parry: the palms push the ball away, out towards the field (or up and over for a high one).
    if (d.parry > 0 && d.stage === 'dive') d.parryT += dt;
    const push = d.parry * Math.sin(Math.PI * Math.min(1, d.parryT / 0.22)) * (1 - rise);
    let armX = lerp(-0.6, -2.75, reachK);
    armX = lerp(armX, -2.1, land * (1 - d.held));
    armX = lerp(armX, -1.5, tuck * Math.max(fall, u > 0 ? 1 : 0));
    armX += push * (ty > 2.0 ? -0.4 : 0.55);
    const armXr = lerp(armX, -0.55, rise);
    P[SLX] = armXr; P[SRX] = armXr;
    P[SLZ] = lerp(0.45, s > 0 ? 0.32 : -0.12, reachK); P[SRZ] = lerp(-0.45, s > 0 ? 0.12 : -0.32, reachK);
    const el = lerp(lerp(lerp(-0.5, -0.12, reachK), -0.7, land * (1 - d.held)), -1.2, tuck) * (1 - push);
    P[ELX] = lerp(el, -0.5, rise); P[ERX] = P[ELX];
    // Top corners: the top hand (on the side away from the dive) stretches furthest; the bottom arm bends
    // underneath. Low dives: the bottom hand goes down behind the ball, the top hand over it.
    const top = s > 0 ? 'R' : 'L';
    const one = (high * (1 - d.held) + low * 0.6) * reachK * (1 - land);
    if (one > 0.001) {
      const [bx, be, tx] = top === 'R' ? [SLX, ELX, SRX] : [SRX, ERX, SLX];
      P[bx] = lerp(P[bx], high ? -1.9 : -2.35, one);
      P[be] = lerp(P[be], high ? -1.15 : -0.05, one);
      P[tx] = lerp(P[tx], high ? -2.95 : -2.7, one);
    }
    // Legs: push leg straightens through the launch; the far knee drives up then both fold.
    // Collapse: no spring, both knees fold and the near leg slides away; high: a bigger knee drive.
    const pushH = lerp(lerp(-0.35, collapse ? -0.6 : 0.12, launch), -0.55, fall), pushK = lerp(lerp(0.75, collapse ? 1.25 : 0.15, launch), 1.0, fall);
    const driveH = lerp(lerp(-0.35, collapse ? -0.75 : high ? -1.3 : -1.05, launch), -0.55, fall), driveK = lerp(lerp(0.65, collapse ? 1.2 : 1.35, launch), 0.9, fall);
    const [hN, kN, hF, kF] = [lerp(pushH, -0.35, rise), lerp(pushK, 0.65, rise), lerp(driveH, -0.35, rise), lerp(driveK, 0.65, rise)];
    if (near === 'L') { P[HLX] = hN; P[KLX] = kN; P[HRX] = hF; P[KRX] = kF; } else { P[HRX] = hN; P[KRX] = kN; P[HLX] = hF; P[KLX] = kF; }
    P[HLZ] = (0.08 + 0.12 * launch) * (1 - land) * (1 - rise) + 0.08 * rise; P[HRZ] = -P[HLZ];
    if (collapse) { const k = launch * (1 - rise) * 0.35; if (near === 'L') P[HLZ] += k; else P[HRZ] -= k; }
    P[SPX] = lerp(lerp(lerp(0.25, 0.08, launch), 0.3, fall * d.held), 0.25, rise);
    P[NKX] = lerp(-0.18 * launch, 0, rise);
    this.applyPoseOver(P, W);
    // Body roll about the forward axis, then place it so the hips follow the path.
    const rq = _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -s * roll);
    this.body.quaternion.slerp(rq, W);
    this.body.position.set(0, this.body.position.y * (1 - W), 0);
    this.root.updateMatrixWorld(true);
    const hipsBone = this.model.getObjectByName('Hips')!;
    const have = this.root.worldToLocal(hipsBone.getWorldPosition(new THREE.Vector3()));
    // Desired hips: start frame → world → this root's frame (the simulated keeper moves under us).
    const c = Math.cos(d.facing), sn = Math.sin(d.facing);
    // Forward (fx, fz) and the keeper's left (local +X) in world space.
    const fx = c, fz = sn, lxW = sn, lzW = -c;
    const want = new THREE.Vector3(
      d.start.x + lxW * s * lx + fx * lz,
      ly,
      d.start.z + lzW * s * lx + fz * lz,
    );
    const wantLocal = this.root.worldToLocal(want);
    this.body.position.addScaledVector(wantLocal.sub(have), W);
    this.root.updateMatrixWorld(true);
    // Gloves onto the ball around contact.
    if (d.stage === 'dive') {
      const k = Math.max(0, 1 - Math.abs(t - tc) / 0.22) * W;
      if (k > 0) {
        const lh = this.model.getObjectByName('LeftHand')!, rh = this.model.getObjectByName('RightHand')!;
        const mid = high && !d.held
          ? (top === 'R' ? rh : lh).getWorldPosition(new THREE.Vector3())
          : lh.getWorldPosition(new THREE.Vector3()).add(rh.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
        const fix = d.target.clone().sub(mid);
        if (fix.length() > 0.7) fix.setLength(0.7);
        const a0 = this.root.worldToLocal(mid.clone()), a1 = this.root.worldToLocal(mid.clone().addScaledVector(fix, k));
        this.body.position.add(a1.sub(a0));
        this.root.updateMatrixWorld(true);
      }
    }
    // Nothing through the grass: lift the body by the deepest overlap.
    let lift = 0;
    for (const [name, r] of DIVE_CONTACTS) {
      const o = this.model.getObjectByName(name);
      if (o) lift = Math.max(lift, r - o.getWorldPosition(_v).y);
    }
    if (lift > 0) {
      const base = this.root.getWorldPosition(new THREE.Vector3());
      const a0 = this.root.worldToLocal(base.clone()), a1 = this.root.worldToLocal(base.clone().setY(base.y + lift));
      this.body.position.add(a1.sub(a0));
    }
  }

  /**
   * Ball at the feet: the arms come down from the running pump and are carried a little out from
   * the body for balance, elbows soft, swinging less and in time with the legs; the arm on the
   * outside of a turn lifts as the player banks; chest over the ball, eyes down.
   */
  private applyDribbleArms(W: number, speed: number) {
    const P = this.dribP;
    P.set(this.solver.pose);
    const c = Math.cos(this.phase * Math.PI * 2); // +1 when the left foot is furthest forward
    const sn = Math.sin(this.phase * Math.PI * 2);
    const amp = 0.22 + 0.12 * Math.min(1, speed / 7);
    const lift = Math.max(-0.4, Math.min(0.4, this.bank * 2.4));
    P[SLX] = 0.05 + amp * c; P[SRX] = 0.05 - amp * c; // left arm back as the left leg goes forward
    P[SLZ] = 0.3 + 0.05 * sn + Math.max(0, lift); P[SRZ] = -0.3 + 0.05 * sn - Math.max(0, -lift);
    P[ELX] = -0.3 - 0.15 * Math.max(0, -c); P[ERX] = -0.3 - 0.15 * Math.max(0, c);
    P[SPX] = 0.1 + 0.04 * Math.min(1, speed / 6);
    P[NKX] = 0.16;
    this.applyPoseOver(P, W * 0.85, true);
  }
  private dribP = new Float32Array(17);

  /**
   * Walking (the tunnel walk-out, strolling back into position): the captured walk carries the
   * arms out from the body in a stiff A-shape with the elbows flared. Real players walking out
   * (EFL tunnel cam, Champions League walk-outs) let the arms hang by the thighs: upper arms
   * almost against the body, elbows soft and pointing back, a small swing opposite the legs
   * (the forward hand reaches the front of the thigh, the back one just behind the hip), the
   * forearm bending a little more on the forward swing, palms towards the thighs.
   */
  private applyWalkArms(W: number, speed: number) {
    const P = this.walkP;
    P.set(this.solver.pose);
    const c = Math.cos(this.phase * Math.PI * 2); // +1 when the left foot is furthest forward
    const amp = 0.17 + 0.08 * Math.min(1, Math.max(0, (speed - 1) / 1.5));
    // Left arm back as the left leg goes forward (positive X swings an arm back).
    P[SLX] = 0.04 + amp * c; P[SRX] = 0.04 - amp * c;
    // Clear of the hips and shorts. Closer in, the skinning pinches the shirt under the arms and
    // narrows the back (the bind pose has the arms 45 degrees out).
    P[SLZ] = WALK_ARM_OUT; P[SRZ] = -WALK_ARM_OUT;
    // Soft elbows, bending a little more as the arm swings forward.
    P[ELX] = -(0.16 + 0.22 * Math.max(0, -c)); P[ERX] = -(0.16 + 0.22 * Math.max(0, c));
    // Arms only: the captured walk keeps its own hips, legs, spine and head. The arm directions
    // are in character space, so they hang with gravity whatever the clip does with the chest.
    P[SPX] = 0;
    // Forearms lined up on their own (see alignFL) and turned about their length so the palms
    // face the thighs, thumbs forward; the bind pose leaves them facing forwards.
    this.walkFore[0].setFromAxisAngle(DOWN, WALK_FORE_TWIST).multiply(this.alignFL);
    this.walkFore[1].setFromAxisAngle(DOWN, -WALK_FORE_TWIST).multiply(this.alignFR);
    this.applyPoseOver(P, W, true, ARMS, this.walkFore);
  }
  /**
   * Walking posture. Retargeted onto our bodies, the captured walk tips the pelvis back (the
   * lower back bends to bring the chest up again, which creases the shirt across the back) and
   * pushes the head back over the neck with the chin tucked, so from behind the neck disappears
   * into the collar. Measured in character space each frame (so it suits every body), the
   * pelvis is levelled (thighs turned back so the legs and feet keep the clip's stride), the
   * chest stands almost upright, the head sits over the neck and the face looks ahead as in the
   * bind pose. The head still turns to follow the ball after this (applyHeadLook).
   */
  private applyWalkPosture(W: number) {
    const m = this.model;
    const at = (name: string, out: THREE.Vector3) => {
      let b = this.boneCache.get(name);
      if (b === undefined) { b = m.getObjectByName(name) ?? null; this.boneCache.set(name, b); }
      return b ? m.worldToLocal(b.getWorldPosition(out)) : null;
    };
    // Lean of the segment a -> b about the character's X axis (positive = top forward).
    const lean = (a: string, b: string) => {
      const p0 = at(a, _v), p1 = at(b, _v2);
      return p0 && p1 ? Math.atan2(p1.z - p0.z, p1.y - p0.y) : 0;
    };
    const lim = (x: number) => Math.max(-0.45, Math.min(0.45, x));
    m.updateMatrixWorld(true);
    const dh = lim(WALK_POSTURE.pelvis - lean('Hips', 'Spine02')) * W;
    if (Math.abs(dh) > 1e-3) { this.turnChar('Hips', AXIS_X, dh); this.turnChar('LeftUpLeg', AXIS_X, -dh); this.turnChar('RightUpLeg', AXIS_X, -dh); m.updateMatrixWorld(true); }
    const dc = lim(WALK_POSTURE.chest - lean('Spine02', 'neck')) * W;
    if (Math.abs(dc) > 1e-3) { this.turnChar('Spine02', AXIS_X, dc); m.updateMatrixWorld(true); }
    const dn = lim(WALK_POSTURE.neck - lean('neck', 'Head')) * W;
    if (Math.abs(dn) > 1e-3) { this.turnChar('neck', AXIS_X, dn); m.updateMatrixWorld(true); }
    if (this.faceRest !== null) {
      const h0 = at('Head', _v), h1 = at('headfront', _v2);
      if (h0 && h1) {
        const down = Math.atan2(h0.y - h1.y, h1.z - h0.z);
        const df = lim(this.faceRest + WALK_POSTURE.face - down) * W;
        if (Math.abs(df) > 1e-3) this.turnChar('Head', AXIS_X, df);
      }
    }
  }
  private walkFore = [new THREE.Quaternion(), new THREE.Quaternion()] as const;
  private walkP = new Float32Array(17);
  private boneCache = new Map<string, THREE.Object3D | null>();

  /** Rotate a bone about an axis given in character space (+X the player's left, +Y up, +Z forward); its children follow. */
  private turnChar(name: string, axis: THREE.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-4) return;
    let b = this.boneCache.get(name);
    if (b === undefined) { b = this.model.getObjectByName(name) ?? null; this.boneCache.set(name, b); }
    if (!b || !b.parent) return;
    const parentQ = new THREE.Quaternion();
    for (let n: THREE.Object3D | null = b.parent; n && n !== this.model; n = n.parent) parentQ.premultiply(n.quaternion);
    const charQ = parentQ.clone().multiply(b.quaternion);
    charQ.premultiply(_q.setFromAxisAngle(axis, angle));
    b.quaternion.copy(parentQ.invert().multiply(charQ));
  }

  /**
   * Kick variety layered on the captured kick (right foot; left-foot kicks mirror the body):
   * power shots lean over the ball and follow through off the ground, side-foot finishes and
   * passes open the hip so the inside of the foot meets the ball, chips lean back and stab,
   * volleys tip the body away and swing the leg round, lofted balls lean back.
   */
  private applyKickStyle(p: ViewPlayer, W: number) {
    const st = this.kickStyle.style;
    if (st === 'normal') return;
    const wind = p.action.kind === 'shot' ? PLAYER.shotWindup : PLAYER.kickWindup;
    const t = p.action.t;
    const pre = sm01(t / wind); // into the backswing and contact
    const post = sm01((t - wind) / 0.22); // follow-through
    const swing = pre * (1 - sm01((t - wind - 0.12) / 0.2)); // around contact
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    if (st === 'power') {
      this.turnChar('Spine01', X, 0.28 * pre * W);
      this.turnChar('Spine02', X, 0.12 * pre * W);
      this.turnChar('RightUpLeg', X, -0.6 * post * W);
      this.turnChar('LeftArm', Z, 0.5 * pre * W);
      this.turnChar('RightArm', X, -0.5 * post * W);
      // Follow through off the ground: a hop on the standing foot.
      this.body.position.y += 0.12 * Math.sin(Math.PI * Math.min(1, post)) * W;
    } else if (st === 'finesse' || st === 'pass') {
      const k = st === 'finesse' ? 1 : 0.75;
      this.turnChar('RightUpLeg', Y, -0.75 * k * swing * W);
      this.turnChar('RightLeg', Y, -0.25 * k * swing * W);
      this.turnChar('Spine01', Y, 0.18 * k * swing * W);
      this.turnChar('Spine01', X, 0.08 * pre * W);
      this.turnChar('LeftArm', Z, 0.3 * k * pre * W);
      if (st === 'finesse') this.turnChar('RightUpLeg', Z, -0.12 * post * W);
    } else if (st === 'chip') {
      this.turnChar('Spine01', X, -0.18 * pre * W);
      this.turnChar('RightUpLeg', X, 0.2 * post * W);
      this.turnChar('LeftArm', Z, 0.4 * pre * W);
      this.turnChar('RightArm', Z, -0.3 * pre * W);
    } else if (st === 'volley') {
      // Side volley: tip away from the ball, kicking leg swung round high.
      const tip = Math.sin(Math.PI * Math.min(1, t / (wind + 0.3)));
      this.body.rotation.z -= 0.45 * tip * W;
      this.turnChar('RightUpLeg', Z, -0.55 * tip * W);
      this.turnChar('Spine01', Z, 0.15 * tip * W);
      this.turnChar('LeftArm', Z, 0.55 * tip * W);
    } else if (st === 'lofted') {
      this.turnChar('Spine01', X, -0.14 * pre * W);
      this.turnChar('LeftArm', Z, 0.35 * pre * W);
      this.turnChar('RightUpLeg', X, -0.2 * post * W);
    }
  }

  /**
   * The keeper's one-handed throw turns the shoulders: the throwing side goes back as the arm is
   * drawn behind, then whips round through the release. The roll turns less and leans to the side.
   */
  private applyKeeperThrowTwist(p: ViewPlayer, W: number) {
    const w = p.action.windup ?? handWindup(p.action.variant);
    const t = p.action.t;
    const back = sm01(t / (w * 0.55)), through = sm01((t - w * 0.55) / (w * 0.45 + 0.12));
    const k = p.action.variant === 'roll' ? 0.5 : 1;
    const twist = (-0.5 * back + 0.85 * through) * k * W * (1 - sm01((t - w - 0.25) / 0.2));
    this.turnChar('Spine01', AXIS_Y, twist * 0.55);
    this.turnChar('Spine02', AXIS_Y, twist * 0.45);
    // Eyes stay on the target while the shoulders turn.
    this.turnChar('neck', AXIS_Y, -twist * 0.6);
  }

  /** Jumping headers: arch back for a flick-on, turn the neck and shoulders to glance one aside. */
  private applyHeaderStyle(p: ViewPlayer, W: number) {
    const hs = this.solver.header;
    const u = Math.min(1, p.action.t / Math.max(0.01, p.action.dur));
    const k = Math.sin(Math.PI * Math.min(1, u * 1.4)) * W;
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
    if (hs.flick > 0.01) { this.turnChar('Spine01', X, -0.35 * hs.flick * k); this.turnChar('neck', X, -0.4 * hs.flick * k); }
    if (Math.abs(hs.turn) > 0.01) { this.turnChar('Spine02', Y, -0.35 * hs.turn * k); this.turnChar('neck', Y, -0.45 * hs.turn * k); }
  }

  /** Where the ball sits while held overhead for a throw-in (and until it leaves the hands). */
  throwBallPos(out: THREE.Vector3, dt: number): boolean {
    const p = this.lastP;
    if (p && p.role === 'GK' && p.action.type === 'throw') {
      // Keeper's throw or roll: just after the release, ease from the hand onto the simulated flight.
      const w = p.action.windup ?? handWindup(p.action.variant);
      const k = Math.min(1, Math.max(0, (p.action.t - w) / 0.1));
      const rh = this.model.getObjectByName('RightHand');
      if (!rh || k >= 1) return false;
      this.root.updateMatrixWorld(true);
      out.lerpVectors(rh.getWorldPosition(_v), out.clone(), k);
      return true;
    }
    const throwing = !!p && p.action.type === 'throw' && p.role !== 'GK';
    if (!this.holdThrow && !throwing) { this.throwT = 0; return false; }
    const l = this.model.getObjectByName('LeftHand'), r = this.model.getObjectByName('RightHand');
    if (!l || !r) return false;
    this.root.updateMatrixWorld(true);
    const hands = l.getWorldPosition(new THREE.Vector3()).add(r.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    // Ball between the palms, a little in front of the hand bones.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    hands.addScaledVector(fwd, 0.05).y += 0.04;
    if (throwing) {
      // After the release, ease from the hands onto the simulated flight.
      this.throwT += dt;
      const k = Math.min(1, Math.max(0, (p!.action.t - PLAYER.kickWindup) / 0.12));
      out.lerpVectors(hands, out, k);
    } else out.copy(hands);
    return true;
  }

  /** Stride length (m per gait cycle) to play a locomotion clip at a given ground speed. */
  private strideAt(n: 'walk' | 'jog' | 'sprint', s: ClipSrc, v: number) {
    const own = Math.max(0.3, s.speed * this.scale);
    const ownStride = Math.max(0.4, own * s.cycle);
    if (s.speed < 0.3) return Math.max(0.4, v * s.cycle); // speed unknown: keep the clip's cadence
    return ownStride * Math.min(1.7, Math.max(0.75, Math.sqrt(v / own)));
  }

  /** Pick the captured clip (if any) for an action that has just started. */
  private startShot(p: ViewPlayer, a: string, ballPos: THREE.Vector3) {
    const has = (n: ShotName) => !!this.actions[n];
    const prev = this.shot;
    this.shot = null;
    if (a === 'dive' && p.action.target) {
      const T = p.action.target;
      // Sideways distance of the save from the keeper, to his right.
      const lat = (T.x - p.pos.x) * -Math.sin(p.facing) + (T.z - p.pos.z) * Math.cos(p.facing);
      if (has('catch') && T.y > 1.7 && Math.abs(lat) < 0.9) this.shot = { name: 'catch', mirror: false, stage: 'act' };
      // Every other save is the skeleton-driven dive (applyDive): the captured leap only jumped on the spot.
    } else if (a === 'down' && prev && (prev.name === 'dive' || prev.name === 'catch')) {
      this.shot = { ...prev, stage: 'down' };
    } else if (a === 'jump' && has('header')) {
      // Wall jump: the captured jumping header is a standing leap.
      this.shot = { name: 'header', mirror: false, stage: 'act' };
    } else if (a === 'header' && has('header') && ballPos.y > 1.9) {
      this.shot = { name: 'header', mirror: false, stage: 'act' };
    } else if (a === 'celebrate') {
      const cheers = CHEERS.filter(has);
      if (cheers.length) this.shot = { name: cheers[(this.id + Math.floor(Math.random() * 3)) % cheers.length], mirror: false, stage: 'act' };
      this.celebT = 0;
    }
    if (this.shot) this.lastShot = this.shot.name;
  }

  /** Map the simulation's action time onto the captured clip. */
  private shotTime(p: ViewPlayer, dt: number) {
    const sh = this.shot!, act = this.actions[sh.name]!, src = this.src[sh.name]!;
    const t = p.action.t, dur = Math.max(0.01, p.action.dur);
    const seg = (t0: number, t1: number, k: number) => t0 + (t1 - t0) * Math.min(1, Math.max(0, k));
    let time = 0;
    if (sh.name === 'dive' || sh.name === 'catch') {
      // Beats read from the captures' hip heights: take-off, top of the leap, landing, recovery.
      const [up, top, land, end] = sh.name === 'dive' ? [0.45, 0.87, 1.45, 2.3] : [1.1, 1.53, 2.3, 2.8];
      if (sh.stage === 'down') time = seg(land, end, t / dur);
      else time = t < 0.35 ? seg(up, top, t / 0.35) : seg(top, land, (t - 0.35) / Math.max(0.01, dur - 0.35));
    } else if (sh.name === 'header') {
      // The ball is met near the top of the jump.
      time = seg(0.6, 1.45, t / dur);
    } else {
      this.celebT += dt;
      time = sh.name === 'cheerb' ? Math.min(this.celebT * 1.1, src.clip.duration - 0.01) : this.celebT % src.clip.duration;
    }
    act.time = Math.min(time, src.clip.duration - 0.001);
  }

  /**
   * The bodies' legs are a little shorter, relative to the hips, than the rig the slide was
   * captured on, so the retargeted slide floats a few centimetres. Shift the body so the lower
   * toe sits as high above the grass as it does in the capture at this moment.
   */
  private groundSlide(w: number, time: number, ss: ClipSrc) {
    const n = ss.toeY.length - 1;
    const want = ss.toeY[Math.min(n, Math.max(0, Math.round((time / ss.clip.duration) * n)))];
    this.root.updateMatrixWorld(true);
    const lt = this.model.getObjectByName('LeftToeBase'), rt = this.model.getObjectByName('RightToeBase');
    if (!lt || !rt) return;
    const base = this.body.getWorldPosition(_v).y;
    const have = Math.min(lt.getWorldPosition(_v).y, rt.getWorldPosition(_v).y) - base;
    this.body.position.y -= Math.max(-0.2, Math.min(0.2, have - want)) * w;
  }

  /**
   * The generated run clips lean the body far forward and fling the arms out behind with open
   * hands, which reads as a cartoon dash rather than a footballer. This layer, synced to the
   * shared gait phase, stands the torso up a little and drives the arms in a compact pump:
   * elbows bent near 90 degrees, each arm swinging opposite its leg, wider when sprinting.
   * Legs and hips keep the mocap untouched, so foot contact stays exact.
   */
  private applyRunLayer(w: number, speed: number) {
    const sprintK = Math.min(1, Math.max(0, (speed - 6) / 2.5));
    // The run_fast captures are already upright: only a touch more drive when sprinting.
    const lean = (0.02 + 0.07 * sprintK) * w; // radians, positive = forward
    const amp = 0.7 + 0.3 * sprintK;
    const c = Math.cos(this.phase * Math.PI * 2); // +1 when the left foot is furthest forward
    const slx = -0.2 + amp * c, srx = -0.2 - amp * c; // left arm back as the left leg goes forward
    const elbow = -(1.45 + 0.15 * sprintK);
    const topQ = _q2.identity();
    for (let n: THREE.Object3D | null = this.top; n && n !== this.model; n = n.parent) topQ.premultiply(n.quaternion);
    const chestDelta = new THREE.Quaternion();
    const tmp = new THREE.Quaternion();
    // Twist each arm about its own length so the palms face the body instead of the sky
    // (the A-pose bind leaves them turned up once the elbow bends).
    const twistL = new THREE.Quaternion().setFromAxisAngle(DOWN, -1.3), twistR = new THREE.Quaternion().setFromAxisAngle(DOWN, 1.3);
    const armQ = (x: number, z: number, el: number | null, align: THREE.Quaternion, twist: THREE.Quaternion) => {
      const q = chestDelta.clone().multiply(rot(tmp, x, z)).multiply(twist);
      if (el !== null) q.multiply(rot(tmp, el, 0));
      return q.multiply(align);
    };
    for (const r of this.rig) {
      const parentOut = r.parent >= 0 ? this.rig[r.parent].outChar : topQ;
      const base = new THREE.Quaternion().copy(parentOut).multiply(r.bone.quaternion);
      let out = base;
      if (r.bone.name === 'Hips') {
        // The sprint capture swings the whole pelvis well round each stride (it reads as the
        // player turning his back); keep a fifth of the hip yaw, which is what a runner shows.
        const delta = base.clone().multiply(tmp.copy(r.restChar).invert());
        const tw = new THREE.Quaternion(0, delta.y, 0, delta.w).normalize();
        out = new THREE.Quaternion().slerp(tw.invert(), 0.8 * w).multiply(delta).multiply(r.restChar);
      } else if (r.bone.name === 'Spine') out = rot(new THREE.Quaternion(), lean, 0).multiply(base);
      else if (r.seg === 'armL' || r.seg === 'foreL' || r.seg === 'armR' || r.seg === 'foreR') {
        const left = r.seg === 'armL' || r.seg === 'foreL';
        const fore = r.seg === 'foreL' || r.seg === 'foreR';
        const t = armQ(left ? slx : srx, left ? 0.14 : -0.14, fore ? elbow : null, left ? this.alignL : this.alignR, left ? twistL : twistR).multiply(r.restChar);
        out = base.clone().slerp(t, w * ARM_PUMP);
      }
      if (r.bone.name === 'Spine02') chestDelta.copy(out).multiply(tmp.copy(r.restChar).invert());
      r.outChar.copy(out);
      r.bone.quaternion.copy(parentOut).invert().multiply(out);
    }
  }

  /** Blend the procedural pose (in character space) over the clip pose, bone by bone. */
  private applyProcedural() {
    const W = this.procW;
    const P = this.solver.pose;
    this.body.position.y = P[BY] * W;
    this.body.rotation.set(P[BRX] * W, 0, P[BRZ] * W);
    if (W < 0.001) return;
    this.applyPoseOver(P, W);
  }

  /** Blend a pose in the procedural solver's terms over the current bone pose (bones only). */
  private applyPoseOver(P: ArrayLike<number>, W: number, upperOnly = false, only?: ReadonlySet<Seg>, foreAlign?: readonly [THREE.Quaternion, THREE.Quaternion]) {
    const seg: Record<Seg, THREE.Quaternion> = {
      hips: new THREE.Quaternion(),
      spine: rot(new THREE.Quaternion(), P[SPX], 0),
      neck: new THREE.Quaternion(),
      armL: new THREE.Quaternion(), foreL: new THREE.Quaternion(), armR: new THREE.Quaternion(), foreR: new THREE.Quaternion(),
      thighL: rot(new THREE.Quaternion(), P[HLX], P[HLZ]),
      shinL: new THREE.Quaternion(),
      thighR: rot(new THREE.Quaternion(), P[HRX], P[HRZ]),
      shinR: new THREE.Quaternion(),
    };
    seg.neck.copy(seg.spine).multiply(rot(_q, P[NKX], 0));
    seg.armL.copy(seg.spine).multiply(rot(_q, P[SLX], P[SLZ])).multiply(this.alignL);
    seg.foreL.copy(seg.spine).multiply(rot(_q, P[SLX], P[SLZ])).multiply(rot(_q2, P[ELX], 0)).multiply(foreAlign?.[0] ?? this.alignL);
    seg.armR.copy(seg.spine).multiply(rot(_q, P[SRX], P[SRZ])).multiply(this.alignR);
    seg.foreR.copy(seg.spine).multiply(rot(_q, P[SRX], P[SRZ])).multiply(rot(_q2, P[ERX], 0)).multiply(foreAlign?.[1] ?? this.alignR);
    seg.shinL.copy(seg.thighL).multiply(rot(_q, P[KLX], 0));
    seg.shinR.copy(seg.thighR).multiply(rot(_q, P[KRX], 0));
    // Character-space orientation of the bones' common parent.
    const topQ = _q2.identity();
    for (let n: THREE.Object3D | null = this.top; n && n !== this.model; n = n.parent) topQ.premultiply(n.quaternion);
    for (const r of this.rig) {
      const parentAnim = r.parent >= 0 ? this.rig[r.parent].animChar : topQ;
      const parentOut = r.parent >= 0 ? this.rig[r.parent].outChar : topQ;
      r.animChar.copy(parentAnim).multiply(r.bone.quaternion);
      _q.copy(seg[r.seg]).multiply(r.restChar);
      // Upper-body blends leave the hips and legs as the clip has them.
      const w = (upperOnly && LOWER.has(r.seg)) || (only && !only.has(r.seg)) ? 0 : W;
      r.outChar.copy(r.animChar).slerp(_q, w);
      r.bone.quaternion.copy(parentOut).invert().multiply(r.outChar);
      if (r.seg === 'hips') r.bone.position.lerp(r.restPos, w);
    }
    void _v;
  }
}
