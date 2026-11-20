// Marks players leave on the pitch: footprints and slide tracks pressed into snow (and mud), torn
// turf where a slide tackle gouges the grass, and divots of turf thrown up by the slide.
// The marks are drawn on the GPU into a pitch-sized render target that is never cleared during a
// match (render/vfx.ts grass shader reads it): R = pressed (snow trodden down by boots, a body or
// the ball), G = torn (turf ripped up, or snow scraped right down to the grass).
// Purely visual: driven by the ViewState each frame, so it behaves the same online and offline.

import * as THREE from 'three';
import { WEAR_AREA } from './wear';
import type { ViewState } from '../view';

/** Pixels per metre of the marks map for each quality (Low has none: no footprints or gouges). */
export const MARKS_RES = [0, 9, 16, 18] as const;
/** Most stamps drawn in one frame (more wait for the next). */
const MAX_STAMPS = 96;
/** Turf chunks kept on the pitch at once (the oldest are recycled). */
export const MAX_DIVOTS = [0, 24, 48, 64] as const;

export const StampKind = { FootL: 0, FootR: 1, Gouge: 2, Hole: 3, Body: 4, Roll: 5 } as const;
export type StampKind = (typeof StampKind)[keyof typeof StampKind];

export interface Stamp { x: number; z: number; dx: number; dz: number; len: number; wid: number; kind: StampKind; amt: number }

/** Length of one stride (metres between alternate footprints) at a given running speed. */
export function strideFor(speed: number): number {
  return Math.max(0.45, Math.min(1.15, 0.42 + speed * 0.095));
}

const VS = /* glsl */ `
attribute vec4 iA; // centre x, z (metres), direction x, z
attribute vec4 iB; // half length, half width, kind, amount
varying vec2 vQ;
varying float vKind, vAmt, vSeed;
uniform vec2 uHalf;
void main() {
  vQ = position.xy;
  vKind = iB.z; vAmt = iB.w;
  vSeed = fract(iA.x * 0.731 + iA.y * 1.37);
  vec2 d = normalize(iA.zw + vec2(1e-5, 0.0));
  vec2 s = vec2(-d.y, d.x);
  vec2 w = iA.xy + d * position.y * iB.x + s * position.x * iB.y;
  gl_Position = vec4(w / uHalf, 0.0, 1.0);
}`;

const FS = /* glsl */ `
varying vec2 vQ;
varying float vKind, vAmt, vSeed;
float h1(float x) { return fract(sin(x * 91.7 + vSeed * 13.1) * 43758.55); }
float n1(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h1(i), h1(i + 1.0), f); }
void main() {
  vec2 q = vQ; // x across (-1..1), y along (-1 heel / start .. 1 toe / end)
  float r = 0.0, g = 0.0;
  if (vKind < 1.5) {
    // A boot sole: wide at the toe, a waist, a round heel; stud holes pressed deeper.
    float side = vKind < 0.5 ? -1.0 : 1.0;
    float yy = q.y;
    float halfW = yy > 0.0 ? 0.95 - 0.55 * yy * yy * yy : (yy > -0.45 ? 0.62 : 0.8 * sqrt(max(0.0, 1.0 - pow((yy + 0.45) / 0.55, 2.0))));
    float x = q.x * side + 0.12 * yy;
    float inside = smoothstep(0.0, 0.18, halfW - abs(x)) * smoothstep(1.0, 0.86, abs(yy));
    float studs = smoothstep(0.35, 0.0, length(fract(q * vec2(1.6, 2.4)) - 0.5));
    r = inside * (0.8 + 0.2 * studs);
  } else if (vKind < 2.5) {
    // A slide's gouge: ragged edges, torn deepest in the middle, a lip of turf at the end.
    float edge = 0.62 + 0.38 * n1(q.y * 7.0) - 0.15 * n1(q.y * 23.0 + 4.0);
    float across = smoothstep(edge, edge * 0.55, abs(q.x));
    float along = smoothstep(1.0, 0.78, abs(q.y));
    float rip = 0.55 + 0.45 * n1(q.y * 13.0 + q.x * 3.0);
    r = across * along;
    g = across * along * rip;
  } else if (vKind < 3.5) {
    // A divot hole: an irregular torn patch.
    float a = atan(q.y, q.x);
    float rad = 0.7 + 0.3 * n1(a * 2.3 + 7.0);
    g = smoothstep(rad, rad * 0.6, length(q));
    r = g;
  } else if (vKind < 4.5) {
    // A body landing (a dive, a fall): a soft, wide press.
    r = smoothstep(1.0, 0.45, length(q)) * (0.75 + 0.25 * n1(q.y * 6.0 + q.x * 4.0));
    g = r * 0.25;
  } else {
    // The ball rolling: a thin line.
    r = smoothstep(1.0, 0.2, abs(q.x)) * smoothstep(1.0, 0.9, abs(q.y));
  }
  gl_FragColor = vec4(r * vAmt, g * vAmt, 0.0, 1.0);
}`;

interface Divot { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; rz: number; spin: number; s: number; rest: boolean }

/**
 * The marks map and the divots. Feed it each live frame with `update`; `flush` draws the new
 * stamps into the map (call it before the scene is rendered).
 */
export class PitchMarks {
  target: THREE.WebGLRenderTarget | null = null;
  readonly divots: THREE.InstancedMesh;
  private quality = -1;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  private mesh: THREE.InstancedMesh;
  private a: THREE.InstancedBufferAttribute;
  private b: THREE.InstancedBufferAttribute;
  private queue: Stamp[] = [];
  private needsClear = true;
  private walk = new Map<number, { x: number; z: number; acc: number; foot: number; a: string; sx: number; sz: number }>();
  private ballPrev: { x: number; z: number } | null = null;
  private pieces: Divot[] = [];
  private nextPiece = 0;
  private snow = false;
  /** Stamps drawn so far this match (tests). */
  stamped = 0;
  /** A footstep landed (splashes in the rain, powder in the snow). */
  onStep: ((x: number, z: number, speed: number) => void) | null = null;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
    this.b = new THREE.InstancedBufferAttribute(new Float32Array(MAX_STAMPS * 4), 4);
    this.a.setUsage(THREE.DynamicDrawUsage); this.b.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.a);
    g.setAttribute('iB', this.b);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: { uHalf: { value: new THREE.Vector2(WEAR_AREA.halfX, WEAR_AREA.halfZ) } },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, MAX_STAMPS);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    // Divots: a lumpy slab of turf, grass on top and soil underneath.
    const dg = new THREE.IcosahedronGeometry(1, 0);
    dg.scale(0.13, 0.045, 0.09);
    const pos = dg.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const top = pos.getY(i) > 0.005;
      col.set(top ? [0.2, 0.36, 0.1] : [0.28, 0.2, 0.12], i * 3);
    }
    dg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.divots = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), MAX_DIVOTS[3]);
    this.divots.count = 0;
    this.divots.frustumCulled = false;
    this.divots.castShadow = false;
  }

  /** The map's texture (a 1 x 1 blank before the first match on Medium and up). */
  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  /** Make (or remake) the map for a quality level; Low has none. */
  setQuality(q: number) {
    if (q === this.quality) return;
    this.quality = q;
    this.target?.dispose();
    this.target = null;
    const res = MARKS_RES[Math.max(0, Math.min(3, q))];
    if (res > 0) {
      const w = Math.round(WEAR_AREA.halfX * 2 * res), h = Math.round(WEAR_AREA.halfZ * 2 * res);
      this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
      this.target.texture.anisotropy = 4;
    }
    this.needsClear = true;
    this.reset(this.snow);
  }

  /** A new match: a clean pitch. Snow changes the divots to clumps of snow. */
  reset(snow: boolean) {
    this.snow = snow;
    this.queue.length = 0;
    this.walk.clear();
    this.ballPrev = null;
    this.pieces.length = 0;
    this.nextPiece = 0;
    this.divots.count = 0;
    this.needsClear = true;
    this.stamped = 0;
    // In the snow the slide throws up clumps of snow instead of turf.
    const mat = this.divots.material as THREE.MeshStandardMaterial;
    if (mat.vertexColors === snow) {
      mat.vertexColors = !snow;
      mat.flatShading = !snow;
      mat.color.setHex(snow ? 0xdfe5ee : 0xffffff);
      mat.needsUpdate = true;
    }
  }

  add(s: Stamp) {
    if (this.target && this.queue.length < MAX_STAMPS * 3) this.queue.push(s);
  }

  /**
   * One frame of live play (dt 0 while paused or in a replay): footprints every stride, slide
   * tracks along the slide, body prints for dives and falls, and the ball's line in the snow.
   */
  update(view: ViewState, dt: number, live = true) {
    this.stepDivots(dt);
    if (!this.target || dt <= 0 || !live) return;
    const ph = view.phase;
    if (ph !== 'play' && ph !== 'restart' && ph !== 'kickoff' && ph !== 'goal') return;
    for (const p of view.players) {
      if (p.off) continue;
      let w = this.walk.get(p.id);
      if (!w) { w = { x: p.pos.x, z: p.pos.z, acc: 0, foot: p.id & 1, a: p.action.type, sx: 0, sz: 0 }; this.walk.set(p.id, w); continue; }
      const dx = p.pos.x - w.x, dz = p.pos.z - w.z, d = Math.hypot(dx, dz);
      const a = p.action.type;
      if (d > 6) { w.x = p.pos.x; w.z = p.pos.z; w.a = a; continue; } // placed for a restart
      if (a === 'slide') {
        if (w.a !== 'slide') { w.sx = p.pos.x; w.sz = p.pos.z; this.slideStart(p.pos.x, p.pos.z, p.vel.x || Math.cos(p.facing), p.vel.z || Math.sin(p.facing)); }
        if (d > 0.02) this.add({ x: (p.pos.x + w.x) / 2, z: (p.pos.z + w.z) / 2, dx, dz, len: d / 2 + 0.22, wid: 0.3, kind: StampKind.Gouge, amt: 0.9 });
      } else if ((a === 'dive' || a === 'down') && w.a !== a) {
        this.add({ x: p.pos.x, z: p.pos.z, dx: -Math.sin(p.facing), dz: Math.cos(p.facing), len: 0.95, wid: 0.42, kind: StampKind.Body, amt: 0.9 });
      } else if (a === 'tackle' && w.a !== a) {
        this.add({ x: p.pos.x + Math.cos(p.facing) * 0.4, z: p.pos.z + Math.sin(p.facing) * 0.4, dx: Math.cos(p.facing), dz: Math.sin(p.facing), len: 0.32, wid: 0.12, kind: StampKind.Gouge, amt: 0.6 });
      }
      w.acc += d;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const stride = strideFor(sp);
      if (w.acc >= stride && a !== 'slide' && a !== 'dive' && a !== 'down') {
        w.acc %= stride;
        w.foot ^= 1;
        const ux = d > 1e-4 ? dx / d : Math.cos(p.facing), uz = d > 1e-4 ? dz / d : Math.sin(p.facing);
        const side = w.foot ? 1 : -1;
        // A footprint a little to the side of the line of running, pointing along it.
        this.add({ x: p.pos.x - uz * side * 0.11, z: p.pos.z + ux * side * 0.11, dx: ux, dz: uz, len: 0.16, wid: 0.065, kind: w.foot ? StampKind.FootR : StampKind.FootL, amt: sp > 6 ? 0.62 : 0.5 });
        this.onStep?.(p.pos.x - uz * side * 0.11, p.pos.z + ux * side * 0.11, sp);
      }
      w.x = p.pos.x; w.z = p.pos.z; w.a = a;
    }
    // The ball rolling along the ground leaves a thin line (only shows in snow and mud).
    const b = view.ball;
    if (b.pos.y < 0.2 && (b.state === 'free' || b.state === 'dribble') && this.ballPrev) {
      const dx = b.pos.x - this.ballPrev.x, dz = b.pos.z - this.ballPrev.z, d = Math.hypot(dx, dz);
      if (d > 0.15 && d < 3) {
        this.add({ x: (b.pos.x + this.ballPrev.x) / 2, z: (b.pos.z + this.ballPrev.z) / 2, dx, dz, len: d / 2 + 0.05, wid: 0.07, kind: StampKind.Roll, amt: 0.35 });
        this.ballPrev = { x: b.pos.x, z: b.pos.z };
      }
    } else this.ballPrev = { x: b.pos.x, z: b.pos.z };
  }

  /** A slide tackle starts: a divot or two of turf (or clumps of snow) flies up ahead of it. */
  private slideStart(x: number, z: number, vx: number, vz: number) {
    const max = MAX_DIVOTS[Math.max(0, Math.min(3, this.quality))];
    if (!max) return;
    const n = Math.hypot(vx, vz) || 1, ux = vx / n, uz = vz / n;
    const count = this.snow ? 4 : 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const sp = 2.5 + Math.random() * 3.5;
      const a = (Math.random() - 0.5) * 0.9;
      const c = Math.cos(a), s = Math.sin(a);
      const d: Divot = {
        x: x + ux * 0.6, y: 0.05, z: z + uz * 0.6,
        vx: (ux * c - uz * s) * sp, vy: 1.6 + Math.random() * 2.2, vz: (uz * c + ux * s) * sp,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, spin: 6 + Math.random() * 10,
        s: 0.7 + Math.random() * 0.6, rest: false,
      };
      if (this.pieces.length < max) this.pieces.push(d);
      else { this.pieces[this.nextPiece % max] = d; this.nextPiece++; }
      if (!this.snow) this.add({ x: x + ux * (0.5 + i * 0.3), z: z + uz * (0.5 + i * 0.3), dx: ux, dz: uz, len: 0.14, wid: 0.1, kind: StampKind.Hole, amt: 1 });
    }
  }

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();

  private stepDivots(dt: number) {
    const ps = this.pieces;
    if (!ps.length) return;
    let moved = false;
    for (let i = 0; i < ps.length; i++) {
      const d = ps[i];
      if (!d.rest && dt > 0) {
        d.vy -= 9.8 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.spin * dt; d.rz += d.spin * 0.6 * dt;
        if (d.y < 0.03) {
          // Bounce once or twice, then lie flat (grass side up, mostly).
          d.y = 0.03; d.vy *= -0.25; d.vx *= 0.45; d.vz *= 0.45; d.spin *= 0.4;
          if (Math.abs(d.vy) < 0.6) { d.rest = true; d.rx = Math.random() < 0.8 ? 0 : Math.PI; d.rz = (Math.random() - 0.5) * 0.3; d.y = 0.025; }
        }
        moved = true;
      }
      if (moved || this.divots.count !== ps.length) {
        this.e.set(d.rx, d.ry, d.rz);
        this.m.compose(this.v.set(d.x, d.y, d.z), this.q.setFromEuler(this.e), this.snow ? this.sc.set(d.s * 0.7, d.s * 1.5, d.s * 0.8) : this.sc.setScalar(d.s));
        this.divots.setMatrixAt(i, this.m);
      }
    }
    if (moved || this.divots.count !== ps.length) {
      this.divots.count = ps.length;
      this.divots.instanceMatrix.needsUpdate = true;
    }
  }

  /** Draw the stamps queued since the last frame into the marks map. */
  flush(renderer: THREE.WebGLRenderer) {
    if (!this.target) return;
    if (!this.needsClear && !this.queue.length) return;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    if (this.needsClear) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      this.needsClear = false;
    }
    const n = Math.min(MAX_STAMPS, this.queue.length);
    if (n) {
      const A = this.a.array as Float32Array, B = this.b.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const s = this.queue[i];
        A[i * 4] = s.x; A[i * 4 + 1] = s.z; A[i * 4 + 2] = s.dx; A[i * 4 + 3] = s.dz;
        B[i * 4] = s.len; B[i * 4 + 1] = s.wid; B[i * 4 + 2] = s.kind; B[i * 4 + 3] = s.amt;
      }
      this.queue.splice(0, n);
      this.a.needsUpdate = this.b.needsUpdate = true;
      this.mesh.count = n;
      renderer.autoClear = false;
      renderer.render(this.scene, this.cam);
      this.stamped += n;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAuto;
    renderer.setClearColor(prevColor, prevAlpha);
  }

  dispose() {
    this.target?.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.divots.geometry.dispose();
    (this.divots.material as THREE.Material).dispose();
  }
}
