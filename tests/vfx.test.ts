import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NetPanel } from '../src/client/render/vfx';

function backNet() {
  // A 7.32 m x 1.83 m back net at x = -54.5 whose outward normal points away from the pitch (-x).
  return new NetPanel(new THREE.Vector3(-54.5, 0, -3.66), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0), 7.32, () => 1.83, 29, 7, new THREE.MeshBasicMaterial());
}
const maxBulge = (n: NetPanel, base: number) => {
  const a = (n.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  let m = 0;
  for (let i = 0; i < a.length; i += 3) m = Math.max(m, base - a[i]);
  return m;
};

describe('goal net cloth', () => {
  it('bulges outwards where a shot hits, then settles back flat', () => {
    const n = backNet();
    const ball = new THREE.Vector3(-54.39, 0.9, 1);
    n.touch(ball, new THREE.Vector3(7, 0, 0), new THREE.Vector3(-26, 0, 0), 0.11);
    let peak = 0;
    for (let i = 0; i < 20; i++) { n.step(1 / 60); peak = Math.max(peak, maxBulge(n, -54.5)); }
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThan(0.81);
    for (let i = 0; i < 600; i++) n.step(1 / 60);
    expect(maxBulge(n, -54.5)).toBeLessThan(0.005);
  });

  it('ignores a ball that is not touching it', () => {
    const n = backNet();
    n.touch(new THREE.Vector3(-45, 0.5, 0), new THREE.Vector3(7, 0, 0), new THREE.Vector3(-26, 0, 0), 0.11);
    for (let i = 0; i < 10; i++) n.step(1 / 60);
    expect(maxBulge(n, -54.5)).toBe(0);
  });
});
