// Hair that moves: some players wear a ponytail or a bun on top of the hair painted on the body.
// A ponytail is a short chain of points (Verlet) hanging from the back of the head: it swings with
// every stride, streams back at a sprint and bounces on landings, kept off the head, neck and back.
// Realistic players only (Medium and up).

import * as THREE from 'three';

export type HairStyle = 'short' | 'ponytail' | 'bun';

/** About one player in eight has a ponytail and one in twelve a bun. */
export function hairStyleFor(name: string): HairStyle {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const r = ((h >>> 0) >>> 11) % 100;
  return r < 12 ? 'ponytail' : r < 20 ? 'bun' : 'short';
}

export const HAIR = { gravity: 9.8, damping: 0.965, iterations: 3, step: 1 / 90 } as const;

interface Chain {
  anchor: THREE.Object3D; // rides on the head bone
  rest: THREE.Object3D; // where the chain hangs when nothing moves (also on the head)
  seg: number; // segment length (m)
  stiff: number; // pull back towards the rest line each step
  nodes: THREE.Vector3[];
  prev: THREE.Vector3[];
  meshes: THREE.Mesh[];
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3();
const DOWNY = new THREE.Vector3(0, -1, 0);

export class Hair {
  /** World-space pieces (the group cancels the player's own transform). */
  readonly group = new THREE.Group();
  private chains: Chain[] = [];
  private head: THREE.Object3D | null = null;
  private neck: THREE.Object3D | null = null;
  private back: THREE.Object3D | null = null;
  private acc = 0;
  private fresh = true;

  /**
   * `model` is the skinned body (bind pose, metres, +z forward); `headBone` its Head bone; the hair
   * hangs from points on the back of the head in that bind pose.
   */
  constructor(readonly style: HairStyle, colour: number, model: THREE.Object3D, headBone: THREE.Object3D, shadows: boolean, detail = 2, scale = 1) {
    this.group.matrixAutoUpdate = false;
    this.group.name = 'hair';
    if (style === 'short') return;
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colour).multiplyScalar(0.5), roughness: 0.62, metalness: 0 });
    const pin = (x: number, y: number, z: number, bone = headBone) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      model.add(o);
      model.updateMatrixWorld(true);
      bone.attach(o);
      return o;
    };
    this.head = pin(0, 1.66, -0.012);
    this.neck = pin(0, 1.5, -0.03);
    this.back = pin(0, 1.29, 0.005, model.getObjectByName('Spine02') ?? headBone);
    if (style === 'bun') {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.05 * scale, 12, 9), mat);
      bun.scale.set(1, 0.9, 0.85);
      bun.position.set(0, 1.748, -0.118);
      bun.castShadow = shadows;
      model.add(bun);
      model.updateMatrixWorld(true);
      headBone.attach(bun);
      return;
    }
    const make = (ax: number, ay: number, az: number, rx: number, ry: number, rz: number, n: number, seg: number, r0: number, r1: number, flat: number, stiff: number) => {
      const anchor = pin(ax, ay, az), rest = pin(rx, ry, rz);
      const meshes: THREE.Mesh[] = [];
      for (let i = 0; i < n; i++) {
        const k0 = i / n, k1 = (i + 1) / n;
        const g = new THREE.CylinderGeometry(r0 + (r1 - r0) * k0, r0 + (r1 - r0) * k1, 1, 7, 1).translate(0, -0.5, 0);
        const m = new THREE.Mesh(g, mat);
        m.scale.set(flat, seg, 1);
        m.castShadow = shadows;
        meshes.push(m);
        this.group.add(m);
      }
      this.chains.push({ anchor, rest, seg: seg * scale, stiff, nodes: Array.from({ length: n + 1 }, () => new THREE.Vector3()), prev: Array.from({ length: n + 1 }, () => new THREE.Vector3()), meshes });
    };
    // Gathered at the back of the crown, then a tail of five segments to the shoulder blades.
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), mat);
    knot.position.set(0, 1.705, -0.112);
    model.add(knot);
    model.updateMatrixWorld(true);
    headBone.attach(knot);
    make(0, 1.7, -0.13, 0, 1.4, -0.17, detail >= 2 ? 5 : 4, detail >= 2 ? 0.07 : 0.0875, 0.024, 0.009, 1, 0.007);
  }

  get active() { return this.chains.length > 0; }

  /** Tip of the first chain in world space (tests). */
  tip(out: THREE.Vector3) {
    const c = this.chains[0];
    return c ? out.copy(c.nodes[c.nodes.length - 1]) : null;
  }

  /** After the body is posed: step the chains and place the pieces. `root` is the player's root group. */
  update(dt: number, root: THREE.Object3D) {
    if (!this.chains.length) return;
    root.updateMatrixWorld(true);
    this.group.matrix.copy(root.matrixWorld).invert();
    this.group.matrixWorldNeedsUpdate = true;
    const head = this.head!.getWorldPosition(_c);
    const k = root.scale.y;
    const headR = 0.105 * k, neckR = 0.07 * k, backR = 0.135 * k;
    const neck = this.neck!.getWorldPosition(_e);
    const back = this.back!.getWorldPosition(_f);
    for (const ch of this.chains) {
      const a = ch.anchor.getWorldPosition(_a);
      const restDir = ch.rest.getWorldPosition(_b).sub(a).normalize();
      // Restarts move players in one go: start the chain again from rest.
      if (this.fresh || ch.nodes[0].distanceTo(a) > 0.8) {
        for (let i = 0; i < ch.nodes.length; i++) { ch.nodes[i].copy(a).addScaledVector(restDir, ch.seg * k * i); ch.prev[i].copy(ch.nodes[i]); }
      }
    }
    this.fresh = false;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= HAIR.step) {
      this.acc -= HAIR.step;
      const h = HAIR.step;
      for (const ch of this.chains) {
        const a = ch.anchor.getWorldPosition(_a);
        const restDir = ch.rest.getWorldPosition(_b).sub(a).normalize();
        ch.nodes[0].copy(a); ch.prev[0].copy(a);
        for (let i = 1; i < ch.nodes.length; i++) {
          const p = ch.nodes[i], q = ch.prev[i];
          _d.subVectors(p, q).multiplyScalar(HAIR.damping);
          q.copy(p);
          p.add(_d);
          p.y -= HAIR.gravity * h * h;
          // A little springiness: hair falls back into its shape.
          p.lerp(_d.copy(a).addScaledVector(restDir, ch.seg * k * i), ch.stiff);
        }
        for (let it = 0; it < HAIR.iterations; it++) {
          for (let i = 1; i < ch.nodes.length; i++) {
            const p = ch.nodes[i], up = ch.nodes[i - 1];
            _d.subVectors(p, up);
            const len = _d.length() || 1e-6;
            p.copy(up).addScaledVector(_d, (ch.seg * k) / len);
            // Off the head and the back of the neck.
            _d.subVectors(p, head);
            const dh = _d.length();
            if (dh < headR) p.copy(head).addScaledVector(_d, headR / Math.max(dh, 1e-6));
            _d.subVectors(p, neck);
            const dn = _d.length();
            if (dn < neckR) p.copy(neck).addScaledVector(_d, neckR / Math.max(dn, 1e-6));
            _d.subVectors(p, back);
            const db = _d.length();
            if (db < backR) p.copy(back).addScaledVector(_d, backR / Math.max(db, 1e-6));
          }
        }
      }
    }
    for (const ch of this.chains) {
      for (let i = 0; i < ch.meshes.length; i++) {
        const m = ch.meshes[i], p0 = ch.nodes[i], p1 = ch.nodes[i + 1];
        m.position.copy(p0);
        _d.subVectors(p1, p0);
        const len = _d.length() || 1e-6;
        m.quaternion.setFromUnitVectors(DOWNY, _d.multiplyScalar(1 / len));
        m.scale.y = len;
        m.updateMatrix();
      }
    }
  }
}
