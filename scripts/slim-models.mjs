// Makes the player models smaller to download (20 Nov 2026), in place, without changing how they
// look or how the game reads them:
//  - bodies: normals as 8-bit, texture coordinates as 16-bit and skin weights as 8-bit (normalised
//    integers, KHR_mesh_quantization), 16-bit indices, and the colour and normal maps re-encoded as
//    JPEG at a lower quality. Positions stay in metres (the game measures the bind pose).
//  - animations: redundant keyframes dropped and rotations stored as 16-bit.
// Safe to run twice (models already slimmed are skipped).
//
//   node scripts/slim-models.mjs [public/models]

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization, ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { resample, prune } from '@gltf-transform/functions';
import jpeg from 'jpeg-js';

const DIR = process.argv[2] ?? new URL('../public/models/', import.meta.url).pathname;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const MARK = 'elevens-slim-1';

function quantizeNormals(acc) {
  const src = acc.getArray();
  const out = new Int8Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[i] = Math.round((x / l) * 127); out[i + 1] = Math.round((y / l) * 127); out[i + 2] = Math.round((z / l) * 127);
  }
  acc.setArray(out).setNormalized(true);
}

function quantizeUnit(acc, Bits) {
  const src = acc.getArray();
  let lo = Infinity, hi = -Infinity;
  for (const v of src) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo < -1e-4 || hi > 1 + 1e-4) return false; // outside 0..1: leave it as floats
  const max = Bits === Uint16Array ? 65535 : 255;
  const out = new Bits(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, src[i])) * max);
  acc.setArray(out).setNormalized(true);
  return true;
}

function quantizeWeights(acc) {
  const src = acc.getArray();
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const w = [src[i], src[i + 1], src[i + 2], src[i + 3]];
    const s = w.reduce((a, b) => a + b, 0) || 1;
    const q = w.map((x) => Math.round((x / s) * 255));
    // Keep the sum at exactly 255 (put the rounding error on the largest weight).
    const big = q.indexOf(Math.max(...q));
    q[big] += 255 - q.reduce((a, b) => a + b, 0);
    out.set(q, i);
  }
  acc.setArray(out).setNormalized(true);
}

function reencode(tex, quality) {
  if (tex.getMimeType() !== 'image/jpeg') return 0;
  const before = tex.getImage().byteLength;
  const img = jpeg.decode(tex.getImage(), { useTArray: true, maxMemoryUsageInMB: 1024 });
  const out = jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality).data;
  if (out.byteLength < before) { tex.setImage(new Uint8Array(out)); return before - out.byteLength; }
  return 0;
}

let total = [0, 0];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.glb')).sort()) {
  const path = join(DIR, f);
  const before = statSync(path).size;
  const doc = await io.read(path);
  const root = doc.getRoot();
  if (root.getAsset().extras?.[MARK]) { console.log(`${f}: already slim`); continue; }
  if (f.startsWith('body-')) {
    let q = false;
    for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
      const n = prim.getAttribute('NORMAL');
      if (n && n.getComponentType() === 5126) { quantizeNormals(n); q = true; }
      const uv = prim.getAttribute('TEXCOORD_0');
      if (uv && uv.getComponentType() === 5126) quantizeUnit(uv, Uint16Array);
      const w = prim.getAttribute('WEIGHTS_0');
      if (w && w.getComponentType() === 5126) quantizeWeights(w);
      const idx = prim.getIndices();
      const count = prim.getAttribute('POSITION').getCount();
      if (idx && idx.getComponentType() === 5125 && count < 65535) idx.setArray(new Uint16Array(idx.getArray()));
    }
    if (q) doc.createExtension(KHRMeshQuantization).setRequired(true);
    for (const t of root.listTextures()) reencode(t, /normal/i.test(t.getName()) ? 82 : 86);
  } else if (f.startsWith('anim-')) {
    await doc.transform(resample({ tolerance: 1e-4 }), prune({ keepLeaves: true, keepAttributes: true }));
    for (const a of root.listAnimations()) for (const s of a.listSamplers()) {
      const out = s.getOutput();
      const ch = a.listChannels().find((c) => c.getSampler() === s);
      if (ch?.getTargetPath() === 'rotation' && out.getComponentType() === 5126) {
        const src = out.getArray();
        const q = new Int16Array(src.length);
        for (let i = 0; i < src.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, src[i])) * 32767);
        out.setArray(q).setNormalized(true);
      }
    }
  } else continue;
  root.getAsset().extras = { ...(root.getAsset().extras ?? {}), [MARK]: true };
  await io.write(path, doc);
  const after = statSync(path).size;
  total[0] += before; total[1] += after;
  console.log(`${f}: ${(before / 1024) | 0} KB -> ${(after / 1024) | 0} KB`);
}
console.log(`total ${(total[0] / 1024) | 0} KB -> ${(total[1] / 1024) | 0} KB`);
