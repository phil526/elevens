// The street cage (5-a-side, 20 Nov 2026): boards and wire fence all round the small pitch, the
// goals set into the end boards, floodlight poles on the corners, a net roof line, and a
// low-detail city block around it (flats with lit windows, a car park, street lights). All
// generated; sized from PITCH, so it must be built while the street pitch is in use.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import { canvasTex } from './textures';

export interface Cage {
  group: THREE.Group;
  /** Floodlight lamp heads (world positions) for halos and flares of light. */
  lamps: THREE.Vector3[];
}

const BOARD_H = 1.1;
const FENCE_H = 4.6;

/** A wire-mesh texture (diamond chain link) for the fence above the boards. */
function wireTexture() {
  const t = canvasTex(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(205,212,220,0.95)';
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(0, 32); g.lineTo(32, 0); g.lineTo(64, 32); g.lineTo(32, 64); g.closePath();
    g.stroke();
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Board panels with simple street art tags and a club-coloured stripe. */
function boardTexture(home: number, away: number) {
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
  const t = canvasTex(512, 64, (g) => {
    g.fillStyle = '#1d2229';
    g.fillRect(0, 0, 512, 64);
    g.fillStyle = hex(home);
    g.fillRect(0, 50, 256, 8);
    g.fillStyle = hex(away);
    g.fillRect(256, 50, 256, 8);
    g.font = 'bold 26px sans-serif';
    g.textBaseline = 'middle';
    const words = ['STREET', 'FIVES', 'NO OFFSIDE', 'PLAY ON'];
    let x = 14;
    words.forEach((w, i) => {
      g.fillStyle = ['#f4d35e', '#5fd3c6', '#f95738', '#c3f73a'][i];
      g.fillText(w, x, 26);
      x += g.measureText(w).width + 22;
    });
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/** Windows of a block of flats: random lit and dark panes. */
function windowsTexture(seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t = canvasTex(128, 256, (g) => {
    g.fillStyle = '#2a2d33';
    g.fillRect(0, 0, 128, 256);
    for (let y = 8; y < 256; y += 16) for (let x = 6; x < 128; x += 15) {
      const lit = rnd() < 0.38;
      g.fillStyle = lit ? (rnd() < 0.5 ? '#ffd98a' : '#f6c26b') : '#171a1f';
      g.fillRect(x, y, 9, 10);
    }
  });
  return t;
}

export function buildCage(quality: number, homeColour: number, awayColour: number): Cage {
  const group = new THREE.Group();
  group.name = 'street-cage';
  const L = PITCH.halfLength, W = PITCH.halfWidth, GW = PITCH.goalHalfWidth, GH = PITCH.goalHeight;
  // Ground outside the cage: tarmac with a pavement band.
  const tarmac = new THREE.Mesh(new THREE.PlaneGeometry(260, 220), new THREE.MeshLambertMaterial({ color: 0x2b2e33 }));
  tarmac.rotation.x = -Math.PI / 2;
  tarmac.position.y = -0.03;
  group.add(tarmac);
  const pave = new THREE.Mesh(new THREE.PlaneGeometry(2 * L + 14, 2 * W + 14), new THREE.MeshLambertMaterial({ color: 0x5d6168 }));
  pave.rotation.x = -Math.PI / 2;
  pave.position.y = -0.025;
  group.add(pave);

  // Boards: four sides (the end boards leave the goal mouth open).
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(homeColour, awayColour), roughness: 0.7, metalness: 0.1 });
  boardMat.map!.repeat.set(3, 1);
  const plain = new THREE.MeshStandardMaterial({ color: 0x1d2229, roughness: 0.75 });
  const board = (len: number, x: number, z: number, rotY: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(len, BOARD_H, 0.08), [plain, plain, plain, plain, boardMat, boardMat]);
    m.position.set(x, BOARD_H / 2, z);
    m.rotation.y = rotY;
    m.receiveShadow = quality > 0;
    m.castShadow = quality > 1;
    group.add(m);
  };
  for (const s of [-1, 1]) board(2 * L + 0.16, 0, s * (W + 0.04), 0);
  const endLen = W - GW - PITCH.postRadius;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) board(endLen, sx * (L + 0.04), sz * (W - endLen / 2), Math.PI / 2);

  // Wire fence above the boards, on steel posts.
  const wire = wireTexture();
  const fenceMat = new THREE.MeshBasicMaterial({ map: wire, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.55 });
  const fence = (len: number, h: number, x: number, y: number, z: number, rotY: number) => {
    const tex = wire.clone();
    tex.needsUpdate = true;
    tex.repeat.set(len / 0.35, h / 0.35);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), fenceMat.clone());
    (m.material as THREE.MeshBasicMaterial).map = tex;
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.renderOrder = 2;
    group.add(m);
  };
  const fh = FENCE_H - BOARD_H;
  for (const s of [-1, 1]) fence(2 * L, fh, 0, BOARD_H + fh / 2, s * (W + 0.05), 0);
  // End fences: either side of the goal from the boards up, and above the crossbar across the goal.
  const sideW = W - GW;
  const aboveH = FENCE_H - GH - 0.08;
  for (const s of [-1, 1]) {
    for (const sz of [-1, 1]) fence(sideW, fh, s * (L + 0.05), BOARD_H + fh / 2, sz * (GW + sideW / 2), Math.PI / 2);
    fence(2 * GW, aboveH, s * (L + 0.05), GH + 0.08 + aboveH / 2, 0, Math.PI / 2);
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a939e, roughness: 0.45, metalness: 0.7 });
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, FENCE_H, 8);
  const post = (x: number, z: number) => { const p = new THREE.Mesh(postGeo, steel); p.position.set(x, FENCE_H / 2, z); group.add(p); };
  for (let x = -L; x <= L + 0.01; x += 4) { post(x, -W - 0.06); post(x, W + 0.06); }
  for (let z = -W + 4; z < W - 0.01; z += 4) { post(-L - 0.06, z); post(L + 0.06, z); }
  // Top rail.
  const rail = (len: number, x: number, z: number, rotY: number) => {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, len, 6), steel);
    r.rotation.z = Math.PI / 2;
    const o = new THREE.Group();
    o.add(r);
    o.position.set(x, FENCE_H, z);
    o.rotation.y = rotY;
    group.add(o);
  };
  for (const s of [-1, 1]) { rail(2 * L, 0, s * (W + 0.06), 0); rail(2 * W, s * (L + 0.06), 0, Math.PI / 2); }

  // Floodlights: a tall pole at each corner, lamp heads angled in.
  const lamps: THREE.Vector3[] = [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a616b, roughness: 0.5, metalness: 0.6 });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * (L + 2.5), pz = sz * (W + 2.5), h = 11;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, h, 10), poleMat);
    pole.position.set(px, h / 2, pz);
    pole.castShadow = quality > 1;
    group.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.25), headMat);
    head.position.set(px, h + 0.2, pz);
    head.lookAt(0, 0, 0);
    group.add(head);
    lamps.push(head.position.clone());
  }

  // The city around: blocks of flats with lit windows, set back behind a road, and street lights.
  const blocks = quality > 0 ? 14 : 8;
  for (let i = 0; i < blocks; i++) {
    const a = (i / blocks) * Math.PI * 2 + 0.2;
    const r = 62 + (i % 3) * 9;
    const w = 14 + (i * 7) % 10, d = 10, h = 14 + ((i * 13) % 5) * 6;
    const tex = windowsTexture(1000 + i * 37);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.round(w / 8), Math.round(h / 16));
    const side = new THREE.MeshLambertMaterial({ map: tex, emissive: 0x4a3a1c, emissiveMap: tex, emissiveIntensity: 0.9 });
    const roof = new THREE.MeshLambertMaterial({ color: 0x24272c });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, roof, roof, side, side]);
    b.position.set(Math.cos(a) * r * 1.25, h / 2, Math.sin(a) * r);
    b.lookAt(0, h / 2, 0);
    group.add(b);
  }
  const lampPost = new THREE.CylinderGeometry(0.07, 0.09, 6, 6);
  const glow = new THREE.MeshBasicMaterial({ color: 0xffc56b });
  for (let i = 0; i < 10; i++) {
    const x = -L - 10 + i * ((2 * L + 20) / 9);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(lampPost, poleMat);
      p.position.set(x, 3, s * (W + 11));
      group.add(p);
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), glow);
      g.position.set(x, 6.1, s * (W + 11));
      group.add(g);
    }
  }
  // A few benches and a kit bag by the cage door for scale.
  const bench = new THREE.Mesh(new THREE.BoxGeometry(3, 0.45, 0.5), new THREE.MeshLambertMaterial({ color: 0x6b4a2f }));
  bench.position.set(-6, 0.25, -W - 2.2);
  group.add(bench);
  const bench2 = bench.clone();
  bench2.position.x = 6;
  group.add(bench2);
  return { group, lamps };
}
