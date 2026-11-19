// Turns the raw Higgsfield (Meshy) player GLBs into game-ready assets in public/models/.
//
//   node scripts/build-players.mjs <raw dir> [--anims-only]
//
// Raw dir layout: body-a.glb, body-b.glb, body-c.glb (textured, rigged, with an Idle clip)
// and anim-<name>.glb (the same rig carrying one clip each).
//
// For each body: drops emissive, metallic-roughness and tangents, halves the textures to
// 1024 px, and splits the chroma-key kit (shirt #00FF00, sleeves #00FFFF, shorts #0000FF,
// socks #FF00FF) out of the colour texture: kit pixels become neutral grey shading and a
// separate RGBA mask (R shirt, G sleeves, B shorts, A socks) lets the game tint them per
// club. Animation files keep only the skeleton and the clip.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const RAW = process.argv[2];
if (!RAW) throw new Error('usage: node scripts/build-players.mjs <raw dir>');
const OUT = new URL('../public/models/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const io = new NodeIO();

function decode(img, mime) {
  if (mime === 'image/png') {
    const p = PNG.sync.read(Buffer.from(img));
    return { width: p.width, height: p.height, data: p.data };
  }
  return jpeg.decode(img, { useTArray: true, maxMemoryUsageInMB: 1024 });
}

function half(src) {
  const w = src.width >> 1, h = src.height >> 1, d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        const i = (sy, sx) => src.data[((sy) * src.width + sx) * 4 + c];
        d[(y * w + x) * 4 + c] = (i(2 * y, 2 * x) + i(2 * y, 2 * x + 1) + i(2 * y + 1, 2 * x) + i(2 * y + 1, 2 * x + 1) + 2) >> 2;
      }
  return { width: w, height: h, data: d };
}

const KEYS = [120, 180, 240, 300]; // hue of shirt, sleeves, shorts, socks

function splitKit(img) {
  const n = img.width * img.height;
  const mask = new Uint8Array(n * 4);
  const weight = new Float32Array(n);
  const val = new Float32Array(n);
  const slot = new Int8Array(n).fill(-1);
  const vals = [[], [], [], []];
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4] / 255, g = img.data[i * 4 + 1] / 255, b = img.data[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    const s = mx > 0 ? c / mx : 0;
    if (s < 0.3 || mx < 0.12) continue;
    let h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
    h = (h * 60 + 360) % 360;
    let best = -1, bd = 1e9;
    KEYS.forEach((k, j) => {
      const d = Math.min(Math.abs(h - k), 360 - Math.abs(h - k));
      if (d < bd) { bd = d; best = j; }
    });
    // Full weight within 25 degrees of a key, fading out by 40; saturation ramps it in too.
    const w = Math.min(1, Math.max(0, (40 - bd) / 15)) * Math.min(1, (s - 0.3) / 0.25);
    if (w <= 0) continue;
    weight[i] = w; slot[i] = best; val[i] = mx;
    if (w > 0.9) vals[best].push(mx);
  }
  const ref = vals.map((v) => { v.sort((a, b) => a - b); return v.length ? v[Math.floor(v.length * 0.9)] : 1; });
  for (let i = 0; i < n; i++) {
    if (slot[i] < 0) continue;
    const w = weight[i];
    mask[i * 4 + slot[i]] = Math.round(w * 255);
    // Kit shading as grey: bright cloth near 0.92 so a white kit still reads as white.
    const grey = Math.min(1, (val[i] / ref[slot[i]]) * 0.92);
    for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.round(img.data[i * 4 + c] * (1 - w) + grey * 255 * w);
  }
  return { mask, counts: vals.map((v) => v.length) };
}

async function buildBody(file, name) {
  const doc = await io.read(join(RAW, file));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) a.dispose(); // the game drives every clip itself
  const mat = root.listMaterials()[0];
  const base = mat.getBaseColorTexture();
  const normal = mat.getNormalTexture();
  for (const t of [mat.getEmissiveTexture(), mat.getMetallicRoughnessTexture()]) if (t && t !== base && t !== normal) t.dispose();
  mat.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]).setMetallicRoughnessTexture(null).setMetallicFactor(0).setRoughnessFactor(0.85).setDoubleSided(false);
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const t = p.getAttribute('TANGENT');
    if (t) { p.setAttribute('TANGENT', null); t.dispose(); }
  }
  // Colour: halve, split kit, re-encode.
  const col = half(decode(base.getImage(), base.getMimeType()));
  const { mask, counts } = splitKit(col);
  base.setImage(new Uint8Array(jpeg.encode({ ...col, data: Buffer.from(col.data) }, 86).data)).setMimeType('image/jpeg');
  const png = new PNG({ width: col.width, height: col.height });
  png.data = Buffer.from(mask);
  writeFileSync(join(OUT, `${name}-kit.png`), PNG.sync.write(png));
  const nrm = half(decode(normal.getImage(), normal.getMimeType()));
  normal.setImage(new Uint8Array(jpeg.encode({ ...nrm, data: Buffer.from(nrm.data) }, 90).data)).setMimeType('image/jpeg');
  for (const t of root.listTextures()) if (t !== base && t !== normal) t.dispose();
  await doc.transform(prune());
  await io.write(join(OUT, `${name}.glb`), doc);
  console.log(name, 'kit pixels (shirt, sleeves, shorts, socks):', counts.join(', '));
}

async function buildAnim(file, name) {
  const doc = await io.read(join(RAW, file));
  const root = doc.getRoot();
  for (const s of root.listScenes()) for (const n of s.listChildren()) n.traverse((o) => { if (o.getMesh()) { o.getMesh().dispose(); o.setMesh(null); } if (o.getSkin()) { o.getSkin().dispose(); o.setSkin(null); } });
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  for (const m of root.listMeshes()) m.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  const clip = root.listAnimations()[0];
  clip.setName(name);
  await io.write(join(OUT, `anim-${name}.glb`), doc);
  console.log('anim', name, 'channels', clip.listChannels().length);
}

// --anims-only rebuilds just the clips (when only new anim-*.glb files were added).
const animsOnly = process.argv.includes('--anims-only');
for (const f of readdirSync(RAW).sort()) {
  if (/^body-[a-z]\.glb$/.test(f) && !animsOnly) await buildBody(f, f.replace('.glb', ''));
  else if (/^anim-[a-z]+\.glb$/.test(f)) await buildAnim(f, f.slice(5, -4));
}
// The bodies' own Idle clip is the idle animation (all three rigs share joint names).
if (!animsOnly) await buildAnim('body-a.glb', 'idle');
