// Writes each .glb in a folder as embedded glTF JSON (<name>.json, buffers and images as data
// URIs) for static hosts that refuse to serve .glb. The game falls back to these automatically.
// Usage: node scripts/glb-to-json.mjs <folder>
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const dir = process.argv[2];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of readdirSync(dir).filter((f) => f.endsWith('.glb'))) {
  const doc = await io.read(join(dir, f));
  const { json, resources } = await io.writeJSON(doc, { format: 'gltf' });
  const uri = (name, mime) => `data:${mime};base64,${Buffer.from(resources[name]).toString('base64')}`;
  for (const b of json.buffers ?? []) if (b.uri) b.uri = uri(b.uri, 'application/octet-stream');
  for (const im of json.images ?? []) if (im.uri) { im.uri = uri(im.uri, im.mimeType ?? (im.uri.endsWith('.png') ? 'image/png' : 'image/jpeg')); }
  writeFileSync(join(dir, f.replace(/\.glb$/, '.json')), JSON.stringify(json));
  console.log(f, '->', f.replace(/\.glb$/, '.json'));
}
