// The Harbourside Arena: pitch, markings, goals and nets here; the bowl around it (stands,
// LED boards, roof, tunnel, dugouts, staff) lives in arena.ts. All geometry is generated.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import { canvasTex, grassTexture, netTexture } from './textures';
import { buildArena } from './arena';
import { grassMaterial, NetPanel } from './vfx';
import type { GroundStyle } from '../../shared/grounds';

const L = PITCH.halfLength;
const W = PITCH.halfWidth;
const LINE = 0.12;

/** Flat ribbon geometry builder for line markings (y-up, lying on the grass). */
class Ribbon {
  pos: number[] = [];
  quad(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) {
    const y = 0.012;
    // Keep every quad facing up (counter-clockwise seen from above).
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) [bx, bz, dx, dz] = [dx, dz, bx, bz];
    this.pos.push(ax, y, az, bx, y, bz, cx, y, cz, ax, y, az, cx, y, cz, dx, y, dz);
  }
  strip(x1: number, z1: number, x2: number, z2: number, w = LINE) {
    const l = Math.hypot(x2 - x1, z2 - z1);
    const nx = (-(z2 - z1) / l) * (w / 2), nz = ((x2 - x1) / l) * (w / 2);
    this.quad(x1 + nx, z1 + nz, x1 - nx, z1 - nz, x2 - nx, z2 - nz, x2 + nx, z2 + nz);
  }
  arc(cx: number, cz: number, r: number, a0: number, a1: number, w = LINE, seg = 64) {
    const n = Math.max(4, Math.ceil((seg * Math.abs(a1 - a0)) / (Math.PI * 2)));
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
      const ri = r - w / 2, ro = r + w / 2;
      this.quad(cx + Math.cos(t0) * ri, cz + Math.sin(t0) * ri, cx + Math.cos(t0) * ro, cz + Math.sin(t0) * ro, cx + Math.cos(t1) * ro, cz + Math.sin(t1) * ro, cx + Math.cos(t1) * ri, cz + Math.sin(t1) * ri);
    }
  }
  disc(cx: number, cz: number, r: number) {
    this.arc(cx, cz, r / 2, 0, Math.PI * 2, r, 16);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    // Flat markings: every normal points straight up.
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    return g;
  }
}

function pitchLines(): THREE.BufferGeometry {
  const r = new Ribbon();
  r.strip(-L, -W, L, -W);
  r.strip(-L, W, L, W);
  r.strip(-L, -W - LINE / 2, -L, W + LINE / 2);
  r.strip(L, -W - LINE / 2, L, W + LINE / 2);
  r.strip(0, -W, 0, W);
  r.arc(0, 0, PITCH.centreCircleRadius, 0, Math.PI * 2, LINE, 96);
  r.disc(0, 0, 0.3);
  for (const s of [-1, 1]) {
    const gx = s * L;
    const pa = gx - s * PITCH.penaltyAreaDepth;
    r.strip(gx, -PITCH.penaltyAreaHalfWidth, pa, -PITCH.penaltyAreaHalfWidth);
    r.strip(gx, PITCH.penaltyAreaHalfWidth, pa, PITCH.penaltyAreaHalfWidth);
    r.strip(pa, -PITCH.penaltyAreaHalfWidth - LINE / 2, pa, PITCH.penaltyAreaHalfWidth + LINE / 2);
    const ga = gx - s * PITCH.goalAreaDepth;
    r.strip(gx, -PITCH.goalAreaHalfWidth, ga, -PITCH.goalAreaHalfWidth);
    r.strip(gx, PITCH.goalAreaHalfWidth, ga, PITCH.goalAreaHalfWidth);
    r.strip(ga, -PITCH.goalAreaHalfWidth - LINE / 2, ga, PITCH.goalAreaHalfWidth + LINE / 2);
    const spot = gx - s * PITCH.penaltySpot;
    r.disc(spot, 0, 0.22);
    // Penalty arc: the part of the 9.15 m circle outside the area.
    const c = Math.acos((PITCH.penaltyAreaDepth - PITCH.penaltySpot) / PITCH.centreCircleRadius);
    if (s > 0) r.arc(spot, 0, PITCH.centreCircleRadius, Math.PI - c, Math.PI + c, LINE, 96);
    else r.arc(spot, 0, PITCH.centreCircleRadius, -c, c, LINE, 96);
    // Corner arcs.
    for (const zs of [-1, 1]) {
      const a0 = s > 0 ? (zs > 0 ? Math.PI : Math.PI / 2) : zs > 0 ? -Math.PI / 2 : 0;
      r.arc(gx, zs * W, PITCH.cornerArcRadius, a0, a0 + Math.PI / 2, LINE, 24);
    }
  }
  // Technical areas (far touchline, in front of the dugouts) and the halfway-line marks for the fourth official area.
  for (const s of [-1, 1]) {
    const x0 = s * 6, x1 = s * 18, z0 = -(W + 1), z1 = -(W + 4.2);
    r.strip(x0, z0, x0, z1, 0.08);
    r.strip(x1, z0, x1, z1, 0.08);
    r.strip(x0, z0, x1, z0, 0.08);
  }
  return r.geometry();
}

function goal(side: 1 | -1, quality: number): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 });
  const R = PITCH.postRadius;
  const GH = PITCH.goalHeight, GW = PITCH.goalHalfWidth, D = PITCH.goalDepth;
  const x = side * (L + R);
  const postGeo = new THREE.CylinderGeometry(R, R, GH + R, 16);
  for (const z of [-(GW + R), GW + R]) {
    const p = new THREE.Mesh(postGeo, white);
    p.position.set(x, (GH + R) / 2, z);
    p.castShadow = true;
    g.add(p);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 2 * (GW + R) + 2 * R, 16), white);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(x, GH + R, 0);
  bar.castShadow = true;
  g.add(bar);
  // Back frame (thin, grey).
  const grey = new THREE.MeshStandardMaterial({ color: 0xbfc5cc, roughness: 0.6 });
  const thin = new THREE.CylinderGeometry(0.025, 0.025, 1, 8);
  const addBar = (a: THREE.Vector3, b: THREE.Vector3) => {
    const m = new THREE.Mesh(thin, grey);
    m.position.copy(a).lerp(b, 0.5);
    m.scale.y = a.distanceTo(b);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(m);
  };
  const bx = side * (L + D);
  for (const z of [-GW, GW]) {
    addBar(new THREE.Vector3(x, GH, z), new THREE.Vector3(bx, GH * 0.75, z));
    addBar(new THREE.Vector3(bx, 0, z), new THREE.Vector3(bx, GH * 0.75, z));
    addBar(new THREE.Vector3(x, 0.02, z), new THREE.Vector3(bx, 0.02, z));
  }
  addBar(new THREE.Vector3(bx, GH * 0.75, -GW), new THREE.Vector3(bx, GH * 0.75, GW));
  // Net panels: cloth grids that bulge and ripple when the ball hits them (see NetPanel).
  const tex = netTexture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  const netMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: quality > 0 ? 0.9 : 0.7 });
  const res = quality > 0 ? 1 : 0.5;
  const n = (m: number) => Math.max(3, Math.round(m * 4 * res));
  const V3 = (a: number, b: number, c: number) => new THREE.Vector3(a, b, c);
  const BH = GH * 0.75;
  const nets: NetPanel[] = [];
  // Back: across the goal, from the ground to the back bar.
  nets.push(new NetPanel(V3(bx, 0, -GW), V3(0, 0, 1), V3(0, 1, 0), V3(side, 0, 0), 2 * GW, () => BH, n(2 * GW), n(BH), netMat));
  // Sides: from the post back to the rear frame; the top edge drops from the bar to the back bar.
  for (const z of [-GW, GW]) {
    nets.push(new NetPanel(V3(x, 0, z), V3(side, 0, 0), V3(0, 1, 0), V3(0, 0, Math.sign(z)), D - R, (u) => GH - (GH - BH) * u, n(D - R), n(GH), netMat));
  }
  // Roof: from the crossbar sloping down to the back bar.
  const roofLen = Math.hypot(D - R, GH - BH);
  const along = V3(side * (D - R), BH - GH, 0).normalize();
  const up = V3(side * (GH - BH), D - R, 0).normalize();
  nets.push(new NetPanel(V3(x, GH, -GW), along, V3(0, 0, 1), up, roofLen, () => 2 * GW, n(roofLen), n(2 * GW), netMat));
  for (const p of nets) g.add(p.mesh);
  g.userData.nets = nets;
  return g;
}

export interface StadiumOptions {
  quality: number; // 0 low, 1 medium, 2 high, 3 ultra
  homeColour: number;
  awayColour: number;
  homeName?: string;
  awayName?: string;
  homeShort?: string;
  awayShort?: string;
  /** The home club's ground (shared/grounds.ts). */
  ground?: GroundStyle;
}

export function buildStadium(opts: StadiumOptions): THREE.Group {
  const root = new THREE.Group();
  // Surround (track/concrete) and grass.
  const surround = new THREE.Mesh(new THREE.PlaneGeometry(220, 170), new THREE.MeshLambertMaterial({ color: 0x3d4a3a }));
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  root.add(surround);
  const gm = grassMaterial(grassTexture(18, opts.quality), opts.quality);
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(2 * L + 10, 2 * W + 12), gm.material);
  root.userData.grass = gm.uniforms;
  root.userData.grassMap = gm.material.map;
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = opts.quality > 0;
  root.add(grass);
  const lines = new THREE.Mesh(pitchLines(), new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
  lines.name = 'pitchLines';
  lines.receiveShadow = opts.quality > 0;
  root.add(lines);
  root.add(goal(1, opts.quality), goal(-1, opts.quality));

  // Corner flags: render/clubflags.ts (spring-mounted posts in the home club's colours).

  // The bowl around the pitch: stands, roof, LED boards, tunnel, dugouts, cameras, staff and
  // flares. Its update() runs every frame from the renderer.
  const arena = buildArena({
    quality: opts.quality,
    homeColour: opts.homeColour,
    awayColour: opts.awayColour,
    homeName: opts.homeName ?? 'Home',
    awayName: opts.awayName ?? 'Away',
    homeShort: opts.homeShort,
    awayShort: opts.awayShort,
    ground: opts.ground,
  });
  root.add(arena.group);
  root.userData.arena = arena;
  // Tunnel mouth (ground level, centre) for the walk-out camera: players walk out towards +z.
  // The covered walkway reaches z = -41.6, the touchline is at z = -34.
  root.userData.tunnel = { x: 0, z: -46.9, dir: 1 };
  return root;
}

export function skyDome(): THREE.Mesh {
  const tex = canvasTex(4, 256, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#0b1a33');
    grd.addColorStop(0.45, '#27486f');
    grd.addColorStop(0.62, '#e0a96d');
    grd.addColorStop(1, '#3a3f45');
    g.fillStyle = grd;
    g.fillRect(0, 0, 4, 256);
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 16), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false }));
  return m;
}
