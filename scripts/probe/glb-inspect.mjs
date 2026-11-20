import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const r = doc.getRoot();
  const tex = r.listTextures().map((t) => `${t.getName() || '?'} ${t.getMimeType()} ${(t.getImage()?.byteLength ?? 0) / 1024 | 0}KB ${t.getSize()?.join('x')}`);
  let verts = 0, acc = 0;
  for (const m of r.listMeshes()) for (const p of m.listPrimitives()) verts += p.getAttribute('POSITION')?.getCount() ?? 0;
  for (const a of r.listAccessors()) acc += a.getByteLength();
  console.log(f, { meshes: r.listMeshes().length, verts, accessorKB: acc / 1024 | 0, tex, anims: r.listAnimations().length, skins: r.listSkins().length });
  for (const m of r.listMeshes()) for (const p of m.listPrimitives()) console.log('  attrs', p.listSemantics().map((s) => `${s}:${p.getAttribute(s).getComponentType()}x${p.getAttribute(s).getElementSize()}`).join(' '));
}
