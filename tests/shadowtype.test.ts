import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// three r186 removed PCFSoftShadowMap; using it left materials sampling the shadow map with the wrong
// sampler type, which Chrome on Windows (Direct3D) rejects: the whole match was drawn black (20 Nov 2026).
describe('shadow map type', () => {
  it('never asks three.js for the removed PCFSoftShadowMap', () => {
    const src = readFileSync(new URL('../src/client/render/renderer.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/=\s*[^;]*THREE\.PCFSoftShadowMap/);
    expect(src).toMatch(/shadowMap\.type = THREE\.PCFShadowMap/);
  });
});
