// The trophy ceremony when you win a cup or a league: a gold trophy on a plinth by the centre
// circle, lifted by the captain while confetti pours down and fireworks go up over the stands.
// Everything is generated here. Confetti is one InstancedMesh (Low 300, Medium 900, High 1800
// pieces); fireworks are one Points cloud of bursts. The director (client/cine.ts) times it.

import * as THREE from 'three';
import type { ViewState } from '../view';

export const CEREMONY = {
  confetti: [300, 900, 1800, 1800],
  bursts: [4, 7, 10, 12],
  sparks: 90, // per burst
  /** The plinth's spot (in front of the halfway line, facing the near-side cameras). */
  spot: { x: 0, z: 6 },
} as const;

function trophyModel(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'trophy';
  const gold = new THREE.MeshStandardMaterial({ color: 0xe2b23c, metalness: 1, roughness: 0.22, emissive: 0x3a2a08, emissiveIntensity: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1f, metalness: 0.3, roughness: 0.5 });
  // Cup profile (metres, about 0.62 m tall).
  const pts = [
    [0.0, 0.0], [0.085, 0.0], [0.085, 0.02], [0.06, 0.035], [0.035, 0.06], [0.026, 0.14], [0.03, 0.2], [0.05, 0.24],
    [0.1, 0.3], [0.13, 0.38], [0.135, 0.44], [0.125, 0.47], [0.14, 0.48], [0.14, 0.495], [0.0, 0.495],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const cup = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), gold);
  cup.position.y = 0.12;
  g.add(cup);
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 20, Math.PI * 1.25), gold);
    h.position.set(s * 0.14, 0.53, 0);
    h.rotation.z = s > 0 ? -Math.PI * 0.62 : Math.PI * 0.37 + Math.PI;
    g.add(h);
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.12, 24), dark);
  base.position.y = 0.06;
  g.add(base);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.103, 0.103, 0.025, 24), gold);
  band.position.y = 0.09;
  g.add(band);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return g;
}

interface Burst { x: number; y: number; z: number; t: number; col: THREE.Color; seed: number }

export class Ceremony {
  readonly group = new THREE.Group();
  readonly trophy = trophyModel();
  private plinth: THREE.Mesh;
  private confetti: THREE.InstancedMesh;
  private conf: { p: THREE.Vector3; v: THREE.Vector3; spin: THREE.Vector3; r: THREE.Euler; alive: boolean }[] = [];
  private fire: THREE.Points;
  private bursts: Burst[] = [];
  private nextBurst = 0;
  private burstsLeft = 0;
  /** Fireworks launched so far (the director plays a bang for each). */
  launched = 0;
  private time = 0;
  active = false;
  /** 0 on the plinth, 1 in the captain's hands. */
  lifted = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private rnd: () => number;

  constructor(readonly quality: number, colours: [number, number] = [0xffffff, 0xd4af37]) {
    let seed = 4242;
    this.rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.group.name = 'ceremony';
    this.group.visible = false;
    this.plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 1.0, 24), new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.4, metalness: 0.2 }));
    this.plinth.position.set(CEREMONY.spot.x, 0.5, CEREMONY.spot.z);
    this.plinth.castShadow = true;
    this.group.add(this.plinth, this.trophy);
    // Confetti: small paper squares, gold, silver and the club's colours.
    const n = CEREMONY.confetti[quality] ?? 900;
    const geo = new THREE.PlaneGeometry(0.06, 0.04);
    this.confetti = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: true }), n);
    this.confetti.frustumCulled = false;
    const pal = [new THREE.Color(0xffd34d), new THREE.Color(0xe8e8f0), new THREE.Color(colours[0]), new THREE.Color(colours[1] ?? 0xffffff), new THREE.Color(0xffffff)];
    for (let i = 0; i < n; i++) {
      this.confetti.setColorAt(i, pal[i % pal.length].clone().multiplyScalar(1.1));
      this.conf.push({ p: new THREE.Vector3(0, -10, 0), v: new THREE.Vector3(), spin: new THREE.Vector3(), r: new THREE.Euler(), alive: false });
      this.confetti.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    }
    this.confetti.count = n;
    this.group.add(this.confetti);
    // Fireworks: every burst's sparks in one Points cloud (positions and colours rewritten each frame).
    const maxB = CEREMONY.bursts[quality] ?? 7;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxB * CEREMONY.sparks * 3), 3));
    fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxB * CEREMONY.sparks * 3), 3));
    // A soft round spark (a DataTexture, so it needs no canvas).
    const N = 32, px = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const r = Math.hypot(x - N / 2 + 0.5, y - N / 2 + 0.5) / (N / 2);
      const a = Math.max(0, 1 - r) ** 1.6;
      px.set([255, 255, 255, Math.round(a * 255)], (y * N + x) * 4);
    }
    const spark = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
    spark.needsUpdate = true;
    this.fire = new THREE.Points(fg, new THREE.PointsMaterial({ map: spark, size: 1.3, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
    this.fire.frustumCulled = false;
    this.group.add(this.fire);
  }

  /** Start: the trophy on its plinth, no confetti yet. */
  start() {
    this.active = true;
    this.group.visible = true;
    this.time = 0;
    this.lifted = 0;
    this.bursts = [];
    this.burstsLeft = 0;
    this.launched = 0;
    for (const c of this.conf) c.alive = false;
    this.trophy.position.set(CEREMONY.spot.x, 1.0, CEREMONY.spot.z);
    this.trophy.rotation.set(0, 0, 0);
  }

  stop() {
    this.active = false;
    this.group.visible = false;
  }

  /** The lift: confetti cannons either side and the fireworks start. */
  celebrate() {
    const n = this.conf.length;
    for (let i = 0; i < n; i++) {
      const c = this.conf[i];
      const side = i % 2 ? 1 : -1;
      // Half fired from cannons either side, half floating down from above.
      if (i % 3 === 0) {
        c.p.set(CEREMONY.spot.x + (this.rnd() - 0.5) * 14, 9 + this.rnd() * 7, CEREMONY.spot.z - 3 + (this.rnd() - 0.5) * 10);
        c.v.set((this.rnd() - 0.5) * 0.6, -0.5 - this.rnd() * 0.5, (this.rnd() - 0.5) * 0.6);
      } else {
        c.p.set(CEREMONY.spot.x + side * (5 + this.rnd()), 0.6, CEREMONY.spot.z - 2 + (this.rnd() - 0.5) * 2);
        c.v.set(-side * (1.5 + this.rnd() * 3), 9 + this.rnd() * 6, (this.rnd() - 0.5) * 3);
      }
      c.spin.set(this.rnd() * 9, this.rnd() * 9, this.rnd() * 9);
      c.r.set(this.rnd() * 6, this.rnd() * 6, this.rnd() * 6);
      c.alive = true;
    }
    this.burstsLeft = CEREMONY.bursts[this.quality] ?? 7;
    this.nextBurst = 0;
  }

  /** How many confetti pieces are in the air (tests). */
  get confettiLive() { return this.conf.filter((c) => c.alive).length; }
  get burstCount() { return this.bursts.length; }

  /**
   * hands: where the captain's hands are (world), or null to leave the trophy on the plinth.
   * lift 0..1 eases it from the plinth into the hands.
   */
  update(dt: number, hands: THREE.Vector3 | null, lift: number) {
    if (!this.active) return;
    this.time += dt;
    this.lifted = lift;
    const rest = new THREE.Vector3(CEREMONY.spot.x, 1.0, CEREMONY.spot.z);
    if (hands && lift > 0) this.trophy.position.lerpVectors(rest, hands.clone().add(new THREE.Vector3(0, 0.05, 0)), lift);
    else this.trophy.position.copy(rest);
    this.trophy.rotation.y = Math.sin(this.time * 1.3) * 0.15 * lift;
    // Confetti: tumbling paper with air drag and a flutter.
    const drag = Math.exp(-dt * 1.6);
    for (let i = 0; i < this.conf.length; i++) {
      const c = this.conf[i];
      if (!c.alive) continue;
      c.v.y -= 9.8 * dt * 0.35;
      c.v.multiplyScalar(drag);
      if (c.v.y < -1.1) c.v.y = -1.1;
      c.p.addScaledVector(c.v, dt);
      c.p.x += Math.sin(this.time * 3 + i) * dt * 0.35;
      c.r.x += c.spin.x * dt; c.r.y += c.spin.y * dt; c.r.z += c.spin.z * dt;
      if (c.p.y < 0.02) { c.p.y = 0.02; c.v.set(0, 0, 0); c.spin.set(0, 0, 0); c.r.x = -Math.PI / 2; }
      this.q.setFromEuler(c.r);
      this.confetti.setMatrixAt(i, this.m.compose(c.p, this.q, this.s));
    }
    this.confetti.instanceMatrix.needsUpdate = true;
    if (this.confetti.instanceColor) this.confetti.instanceColor.needsUpdate = false;
    // Fireworks: a new burst over the stands every 0.6-1.4 s.
    this.nextBurst -= dt;
    if (this.burstsLeft > 0 && this.nextBurst <= 0) {
      this.burstsLeft--;
      this.launched++;
      this.nextBurst = 0.6 + this.rnd() * 0.8;
      const a = (this.rnd() - 0.5) * Math.PI * 0.9;
      const hue = [0.13, 0.0, 0.58, 0.33, 0.8, 0.08][Math.floor(this.rnd() * 6)];
      const b: Burst = { x: Math.sin(a) * 60, y: 48 + this.rnd() * 18, z: -Math.cos(a) * 52 - 4, t: 0, col: new THREE.Color().setHSL(hue, 0.9, 0.62), seed: this.rnd() * 100 };
      const max = CEREMONY.bursts[this.quality] ?? 7;
      if (this.bursts.length >= max) this.bursts.shift();
      this.bursts.push(b);
    }
    const pos = this.fire.geometry.attributes.position.array as Float32Array;
    const col = this.fire.geometry.attributes.color.array as Float32Array;
    pos.fill(0); col.fill(0);
    this.bursts.forEach((b, bi) => {
      b.t += dt;
      const rise = 0.55; // rocket flight
      for (let i = 0; i < CEREMONY.sparks; i++) {
        const j = (bi * CEREMONY.sparks + i) * 3;
        if (b.t < rise) {
          // The rocket climbing (only a few points as its trail).
          if (i > 5) continue;
          const k = b.t / rise - i * 0.04;
          pos[j] = b.x; pos[j + 1] = b.y - 26 * (1 - Math.max(0, k)); pos[j + 2] = b.z;
          col[j] = col[j + 1] = 1 - i * 0.15; col[j + 2] = 0.6 - i * 0.1;
          continue;
        }
        const t = b.t - rise;
        // Even directions on a sphere (golden spiral), with a little variation in speed.
        const yy = 1 - (2 * (i + 0.5)) / CEREMONY.sparks, rr = Math.sqrt(1 - yy * yy), th = i * 2.39996 + b.seed;
        const sp = 11 * (0.85 + ((i * 37) % 7) / 20);
        const d = sp * (1 - Math.exp(-t * 2.2)) / 2.2;
        pos[j] = b.x + Math.cos(th) * rr * d;
        pos[j + 1] = b.y + yy * d - 2.2 * t * t;
        pos[j + 2] = b.z + Math.sin(th) * rr * d;
        const fade = Math.max(0, 1 - t / 2.2) * (0.75 + 0.25 * Math.sin(t * 40 + i));
        const hot = Math.max(0, 1 - t * 3);
        col[j] = (b.col.r + hot) * fade * 1.6; col[j + 1] = (b.col.g + hot) * fade * 1.6; col[j + 2] = (b.col.b + hot) * fade * 1.6;
      }
    });
    this.bursts = this.bursts.filter((b) => b.t < 3.2);
    this.fire.geometry.attributes.position.needsUpdate = true;
    this.fire.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) x.dispose();
    });
  }
}

// ---------- staging (pure, for client/cine.ts and tests) ----------


/** The ceremony's timeline (seconds): the lift, when the camera cranes up, and the end. */
export const TROPHY = { lift: 4.4, liftDur: 0.8, crane: 11, length: 17, fade: 0.6 } as const;

/**
 * The winners gathered behind the plinth: the captain at the front, the rest in two rows behind,
 * all facing the near-side cameras. The losers have left the pitch; the ball is out of sight.
 */
export function stageTrophy(live: ViewState, team: 0 | 1, captain: number): ViewState {
  const mates = live.players.filter((p) => p.team === team && !p.off && p.id !== captain).map((p) => p.id);
  const { x: sx, z: sz } = CEREMONY.spot;
  const spot = (id: number): { x: number; z: number } => {
    if (id === captain) return { x: sx, z: sz - 0.75 };
    const i = mates.indexOf(id);
    const row = i < 5 ? 0 : 1, n = row === 0 ? Math.min(5, mates.length) : mates.length - 5, k = row === 0 ? i : i - 5;
    const span = row === 0 ? 6.4 : 7.6;
    const x = sx + (n > 1 ? (k / (n - 1) - 0.5) * span : 0) + (row ? 0.5 : 0);
    return { x, z: sz - 2.0 - row * 1.35 - Math.abs(x - sx) * 0.12 };
  };
  const players = live.players.map((p) => {
    const base = { ...p, vel: { x: 0, z: 0 }, sprinting: false, jockeying: false, action: { type: 'none' as const, t: 0, dur: 0 } };
    if (p.team !== team || p.off) return { ...base, off: true };
    const at = spot(p.id);
    return { ...base, pos: at, facing: Math.atan2(sz + 14 - at.z, sx - at.x) };
  });
  return {
    ...live, players, humans: [false, false], restart: null,
    ball: { ...live.ball, pos: { x: 0, y: -3, z: -30 }, vel: { x: 0, y: 0, z: 0 }, state: 'dead', owner: -1 },
  };
}

const smooth = (a: number, b: number, t: number) => { const k = Math.min(1, Math.max(0, (t - a) / (b - a))); return k * k * (3 - 2 * k); };

/** The camera for second t of the ceremony: in towards the plinth, round the lift, then up to the fireworks. */
export function trophyShot(t: number): { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number }; fov: number; near: number } {
  const { x: sx, z: sz } = CEREMONY.spot;
  const c = new THREE.Vector3(sx, 0, sz - 1.4);
  // In: from wide and low towards the plinth.
  const a = smooth(0, TROPHY.lift + 0.6, t);
  const p0 = new THREE.Vector3(sx + 6 - 3.5 * a, 1.65, sz + 12 - 5 * a);
  const l0 = new THREE.Vector3(sx, 1.35 + 0.5 * a, sz - 0.8);
  // Round the lift.
  const o = smooth(TROPHY.lift, TROPHY.crane, t);
  const ang = 0.33 - 1.25 * o, rad = 7.6 + 1.5 * o;
  const p1 = new THREE.Vector3(c.x + Math.sin(ang) * rad, 1.7 + 1.6 * o, c.z + Math.cos(ang) * rad);
  const l1 = new THREE.Vector3(c.x, 2.0, c.z);
  // Up and back: the whole stadium and the fireworks.
  const u = smooth(TROPHY.crane, TROPHY.length - 1, t);
  const p2 = new THREE.Vector3(sx + 8, 3.5 + 24 * u, sz + 9 + 34 * u);
  const l2 = new THREE.Vector3(sx, 2 + 20 * u, sz - 2 - 40 * u);
  const k1 = smooth(TROPHY.lift - 0.4, TROPHY.lift + 1.2, t), k2 = smooth(TROPHY.crane - 0.6, TROPHY.crane + 1.8, t);
  const pos = p0.lerp(p1, k1).lerp(p2, k2), look = l0.lerp(l1, k1).lerp(l2, k2);
  return { pos: { x: pos.x, y: pos.y, z: pos.z }, look: { x: look.x, y: look.y, z: look.z }, fov: 40 + 14 * u, near: 0.1 };
}
