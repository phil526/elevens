// Shirt designs (stripes, pinstripes, hoops, a sash, halves, quarters, a chevron) and the
// fictional shirt sponsors. The realistic players draw them in their kit shader from the
// body's bind-pose position (metres: chest at y 1.32, front +z, armpits at |x| 0.16), so a
// design follows the body as it moves; the classic players get a painted shirt texture.

import * as THREE from 'three';
import { KIT_PATTERNS, type Kit, type KitPattern } from '../../shared/teams';
import { readableOn } from './look';
import { drawBadge, kitClub } from './badgetex';
import { badgeFor } from '../../shared/teams';

export const patternIndex = (p?: KitPattern) => Math.max(0, KIT_PATTERNS.indexOf(p ?? 'plain'));

/** Where the sponsor sits on the realistic body's chest (bind pose, metres). */
export const SPONSOR_BOX = { x: 0.135, y0: 1.155, y1: 1.29 } as const;

/**
 * GLSL: how much of the second colour shows at bind-pose point b (0..1, anti-aliased).
 * pat is the KIT_PATTERNS index; mirror flips the sides when the body is mirrored.
 */
export const KIT_PATTERN_GLSL = /* glsl */ `
float kBand(float x, float w) {
  // 1 inside the first w of each unit cell, softened by the screen-space footprint.
  float f = fract(x);
  float aa = max(fwidth(x), 1e-4) * 0.75;
  return smoothstep(0.0, aa, f) * (1.0 - smoothstep(w - aa, w + aa, f)) + smoothstep(1.0 - aa, 1.0, f);
}
float kitPatternW(vec3 b, float pat, float mirror) {
  float x = b.x * mirror;
  if (pat < 0.5) return 0.0;
  if (pat < 1.5) return kBand(x / 0.092 + 0.25, 0.5);                    // stripes
  if (pat < 2.5) return kBand(x / 0.062 + 0.06, 0.13);                   // pinstripes
  if (pat < 3.5) return kBand((b.y - 1.02) / 0.118, 0.5);                // hoops
  if (pat < 4.5) {                                                        // sash: right shoulder to left hip, both sides
    float d = (b.z >= 0.0 ? x : -x) * 0.9 + (b.y - 1.25);
    float aa = max(fwidth(d), 1e-4);
    return 1.0 - smoothstep(0.055 - aa, 0.055 + aa, abs(d));
  }
  if (pat < 5.5) { float aa = max(fwidth(x), 1e-4); return smoothstep(-aa, aa, x); }  // halves
  if (pat < 6.5) {                                                        // quarters
    float aa = max(fwidth(x), 1e-4), ab = max(fwidth(b.y), 1e-4);
    float a = smoothstep(-aa, aa, x), c = smoothstep(1.25 - ab, 1.25 + ab, b.y);
    return abs(a - c);
  }
  // chevron: a V across the chest (front and back)
  float d = b.y - 1.36 + abs(x) * 0.62;
  float aa = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(0.034 - aa, 0.034 + aa, abs(d));
}
`;

const sponsorCache = new Map<string, THREE.CanvasTexture>();

/** The sponsor's name as a white-on-clear texture (the shader tints it). */
export function sponsorTexture(name: string): THREE.CanvasTexture {
  const hit = sponsorCache.get(name);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 512, 128);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const serif = /[a-z]/.test(name) && !/^[a-z]+$/.test(name);
  g.font = `${serif ? 'italic 800 76px Georgia, "Times New Roman", serif' : '900 84px "Arial Black", Arial, Helvetica, sans-serif'}`;
  g.fillText(name, 256, 68, 492);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  sponsorCache.set(name, t);
  return t;
}

/** A blank texture for kits without a sponsor. */
let blank: THREE.DataTexture | null = null;
export function noSponsor(): THREE.DataTexture {
  if (!blank) { blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); blank.needsUpdate = true; }
  return blank;
}

/** The sponsor's colour on this shirt: the number colour if it reads, else black or white. */
export function sponsorColour(kit: Kit): number {
  return readableOn(kit.shirt, kit.number);
}

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/**
 * Classic players: the shirt (torso capsule) as a painted texture. Capsule UVs run round the
 * body from the front (u 0, +z) through the left (0.25, +x), back (0.5) and right (0.75); v runs
 * from the bottom (0) to the top (1).
 */
export function classicShirtTexture(kit: Kit): THREE.CanvasTexture | null {
  const pat = kit.pattern ?? 'plain';
  const club = kitClub(kit);
  if (pat === 'plain' && !kit.sponsor && !club) return null;
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = hex(kit.shirt);
  g.fillRect(0, 0, W, H);
  g.fillStyle = hex(kit.second ?? kit.number);
  const s = kit.second ?? kit.number;
  const vline = (u: number, w: number) => { g.fillRect(u * W - w / 2, 0, w, H); g.fillRect(u * W - w / 2 + W, 0, w, H); g.fillRect(u * W - w / 2 - W, 0, w, H); };
  if (pat === 'stripes') for (let i = 0; i < 12; i += 2) vline(i / 12 + 1 / 24, W / 12);
  else if (pat === 'pinstripes') for (let i = 0; i < 18; i++) vline(i / 18, 3);
  else if (pat === 'hoops') for (let y = 0; y < H; y += 26) g.fillRect(0, y, W, 13);
  else if (pat === 'halves') g.fillRect(0, 0, W / 2, H);
  else if (pat === 'quarters') { g.fillRect(0, 0, W / 2, H / 2); g.fillRect(W / 2, H / 2, W / 2, H / 2); }
  else if (pat === 'sash' || pat === 'chevron') {
    g.strokeStyle = hex(s); g.lineWidth = 16;
    for (const u0 of [0, 0.5]) {
      g.beginPath();
      if (pat === 'sash') { g.moveTo((u0 - 0.2) * W, H * 0.1); g.lineTo((u0 + 0.2) * W, H * 0.95); }
      else { g.moveTo((u0 - 0.2) * W, H * 0.25); g.lineTo(u0 * W, H * 0.48); g.lineTo((u0 + 0.2) * W, H * 0.25); }
      g.stroke();
      // Wrap round the seam at u = 0.
      g.save(); g.translate(W, 0); g.stroke(); g.restore();
    }
  }
  if (kit.sponsor) {
    g.fillStyle = hex(sponsorColour(kit));
    g.font = '900 20px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // Front centre is u = 0: draw it split across the seam. Canvas y grows down, v up.
    for (const x of [0, W]) g.fillText(kit.sponsor, x, H * 0.48, W * 0.3);
  }
  if (club) {
    // The crest on the left chest (u 0.07 from the front centre towards the left side).
    g.save(); g.translate(0.07 * W - 9, H * 0.16); g.scale(0.18, 0.18); drawBadge(g, badgeFor(club), club.abbr); g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
