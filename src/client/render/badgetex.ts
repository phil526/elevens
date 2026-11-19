// Club crests as textures, for the shirt badge (realistic and classic players), the club flags on
// the roof and the corner flags. Drawn on a canvas from the same shapes and emblems as the menus'
// SVG crests (ui/badge.ts), without going through an image (the artifact page blocks data: images).

import * as THREE from 'three';
import { badgeFor, type Badge, type Kit, type TeamDef } from '../../shared/teams';
import { EMBLEMS, SHAPES } from '../ui/badge';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** Draw a crest into a 100 x 100 box at the context's current transform. */
export function drawBadge(g: CanvasRenderingContext2D, b: Badge, abbr: string) {
  const shape = new Path2D(SHAPES[b.shape] ?? SHAPES.shield);
  g.fillStyle = hex(b.bg);
  g.fill(shape);
  g.lineWidth = 5;
  g.lineJoin = 'round';
  g.strokeStyle = hex(b.trim);
  g.stroke(shape);
  const fg = hex(b.fg);
  if (b.emblem === 'letters' || !(b.emblem in EMBLEMS)) {
    const t = abbr.replace(/[<&>"]/g, '');
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = `900 ${t.length > 2 ? 26 : 34}px system-ui, Arial, sans-serif`;
    g.fillText(t, 50, t.length > 2 ? 60 : 64, 76);
    return;
  }
  const svg = EMBLEMS[b.emblem as Exclude<typeof b.emblem, 'letters'>];
  for (const m of svg.matchAll(/<(path|circle|rect)([^>]*)\/>/g)) {
    const at: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) at[a[1]] = a[2];
    const p = new Path2D();
    if (m[1] === 'path') p.addPath(new Path2D(at.d));
    else if (m[1] === 'circle') p.arc(+at.cx, +at.cy, +at.r, 0, Math.PI * 2);
    else p.rect(+at.x, +at.y, +at.width, +at.height);
    const fill = at.fill === 'none' ? null : at.fill === '#0006' ? 'rgba(0,0,0,0.4)' : fg;
    if (fill) { g.fillStyle = fill; g.fill(p); }
    if (at['stroke-width']) { g.strokeStyle = fg; g.lineWidth = +at['stroke-width']; g.stroke(p); }
  }
}

const cache = new Map<string, THREE.CanvasTexture>();

/** A club's crest on a clear background (128 px, sRGB), cached per club. */
export function badgeTexture(team: TeamDef): THREE.CanvasTexture {
  const b = badgeFor(team);
  const key = `${team.id}|${b.shape}|${b.emblem}|${b.bg}|${b.fg}|${b.trim}|${team.abbr}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.scale(1.28, 1.28);
  drawBadge(g, b, team.abbr);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

/** Which club a kit belongs to (set by the renderer for the match's kits), so the shirt can wear its crest. */
const crestOf = new WeakMap<Kit, TeamDef>();
export function setKitClub(kit: Kit, team: TeamDef) { crestOf.set(kit, team); }
export function kitClub(kit: Kit): TeamDef | undefined { return crestOf.get(kit); }

/** Where the crest sits on the realistic body (bind pose, metres): the left chest, above the sponsor. */
export const BADGE_SPOT = { x: 0.088, y: 1.352, size: 0.072 } as const;

/**
 * A club flag: the club's colours with the crest in the middle (left half of the texture), and a
 * plainer one in bands of the two colours (right half). 512 x 160, sRGB.
 */
export function clubFlagTexture(team: TeamDef, kit: Kit): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d')!;
  const second = kit.second && kit.second !== kit.shirt ? kit.second : kit.sleeves !== kit.shirt ? kit.sleeves : kit.number;
  // Crest flag: the shirt colour with a band of the second colour along the hoist, crest centred.
  g.fillStyle = hex(kit.shirt); g.fillRect(0, 0, 256, 160);
  g.fillStyle = hex(second); g.fillRect(0, 0, 40, 160);
  g.save(); g.translate(98, 22); g.scale(1.16, 1.16); drawBadge(g, badgeFor(team), team.abbr); g.restore();
  // Band flag: three stripes.
  for (let i = 0; i < 3; i++) { g.fillStyle = hex(i === 1 ? second : kit.shirt); g.fillRect(256, (i * 160) / 3, 256, 160 / 3 + 1); }
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.font = '900 34px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = hex(readable(second));
  g.fillText(team.abbr, 384, 81);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function readable(bg: number) {
  const lum = 0.299 * ((bg >> 16) & 255) + 0.587 * ((bg >> 8) & 255) + 0.114 * (bg & 255);
  return lum > 150 ? 0x111111 : 0xffffff;
}
