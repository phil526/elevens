// Offside checks shown again, VAR style: the moment the pass was played is frozen and two lines
// are drawn across the pitch, red through the attacker and blue through the second-last
// defender, with the gap between them shaded. Full screen as a short cinematic (offline) and as
// a diagram on the big screens. Presentation only: the offside itself was given by the match.

import * as THREE from 'three';
import { PITCH } from '../../shared/config';
import type { Snap } from './cinematic';
import type { CineShot } from './cinematic';

export const VAR = { length: 5.4, fade: 0.35, draw: 1.0, verdict: 2.8, wait: 0.6, screen: 9, recent: 6 } as const;

export interface VarInfo {
  /** The moment of the pass. */
  snap: Snap;
  attacker: number;
  defender: number;
  /** Attacking team and its direction (+1 attacks +x). */
  team: number;
  dir: number;
  /** x of the attacker and of the second-last defender at the pass; how far offside (m). */
  xa: number;
  xd: number;
  margin: number;
}

/**
 * Work out the lines from the frozen moment. `teams` gives each player's side (the snapshot has
 * only positions). Null if nobody can be drawn (sent off, or the attacker was not past the line).
 */
export function varInfo(snap: Snap, attacker: number, team: number, dir: number, teamOf: (id: number) => number): VarInfo | null {
  const a = snap.players[attacker];
  if (!a || a.off) return null;
  const opp = snap.players.map((p, id) => ({ p, id })).filter(({ p, id }) => !p.off && teamOf(id) !== team).sort((m, n) => n.p.pos.x * dir - m.p.pos.x * dir);
  const d = opp[1];
  if (!d) return null;
  const xa = a.pos.x, xd = d.p.pos.x;
  return { snap, attacker, defender: d.id, team, dir, xa, xd, margin: Math.max(0, (xa - xd) * dir) };
}

/** The two lines and the shading between them, laid on the grass and standing up as thin sheets. */
export class VarLines {
  readonly group = new THREE.Group();
  private red: THREE.Mesh;
  private blue: THREE.Mesh;
  private band: THREE.Mesh;
  private sheet: THREE.Mesh;

  constructor() {
    this.group.name = 'var-lines';
    this.group.visible = false;
    const W = PITCH.width + 2;
    const line = (c: number) => new THREE.Mesh(new THREE.PlaneGeometry(0.12, W), new THREE.MeshBasicMaterial({ color: c, toneMapped: false, transparent: true, depthWrite: false }));
    this.red = line(0xff2a3a);
    this.blue = line(0x2ad1ff);
    for (const m of [this.red, this.blue]) { m.rotation.x = -Math.PI / 2; m.position.y = 0.035; m.renderOrder = 5; }
    this.band = new THREE.Mesh(new THREE.PlaneGeometry(1, W), new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }));
    this.band.rotation.x = -Math.PI / 2;
    this.band.position.y = 0.03;
    this.band.renderOrder = 4;
    // A see-through wall standing on the attacker's line, as on TV.
    this.sheet = new THREE.Mesh(new THREE.PlaneGeometry(W, 2.6), new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.sheet.rotation.y = Math.PI / 2;
    this.sheet.position.y = 1.3;
    this.group.add(this.band, this.red, this.blue, this.sheet);
  }

  /** Show the lines for `info`, drawn in over k = 0..1 (null hides them). */
  show(info: VarInfo | null, k = 1) {
    this.group.visible = !!info && k > 0;
    if (!info) return;
    const e = Math.min(1, Math.max(0, k));
    this.blue.position.x = info.xd;
    this.red.position.x = info.xa;
    this.sheet.position.x = info.xa;
    this.blue.scale.y = this.red.scale.y = e;
    (this.red.material as THREE.MeshBasicMaterial).opacity = e;
    (this.blue.material as THREE.MeshBasicMaterial).opacity = e;
    this.band.position.x = (info.xa + info.xd) / 2;
    this.band.scale.x = Math.max(0.02, Math.abs(info.xa - info.xd));
    this.band.visible = e >= 1;
    this.sheet.visible = e >= 1;
  }
}

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** The camera: high on the near touchline, square on to the lines so they read straight, easing in. */
export function varShot(info: VarInfo, t: number): CineShot {
  const a = info.snap.players[info.attacker].pos;
  const x = (info.xa + info.xd) / 2;
  const k = smooth(t / VAR.length);
  // Kept over the grass, inside the touchline, so the stands never get between camera and lines.
  const z = Math.max(-20, Math.min(14, a.z));
  return { pos: { x, y: 15 - 4 * k, z: Math.min(PITCH.halfWidth - 2, z + 20 - 5 * k) }, look: { x, y: 0.4, z: z - 3 }, fov: 40 };
}

/** The big screens' diagram: the pitch round the lines from above, players as dots, the two lines. */
export function drawVarPage(g: CanvasRenderingContext2D, info: VarInfo, colours: [number, number], teamOf: (id: number) => number, blink: boolean) {
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
  const W = 512, H = 256, top = 46;
  g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
  // Header.
  g.fillStyle = '#12161f'; g.fillRect(0, 0, W, top - 4);
  g.fillStyle = '#ffd23f'; g.fillRect(12, 9, 96, 26);
  g.font = '900 20px "Arial Black", Arial'; g.textBaseline = 'middle'; g.textAlign = 'center';
  g.fillStyle = '#111'; g.fillText('VAR', 60, 23);
  g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText('OFFSIDE CHECK', 122, 23);
  g.textAlign = 'right'; g.fillStyle = blink ? '#ff4a5a' : '#ff8a94';
  g.fillText(info.margin < 0.05 ? 'LEVEL - OFFSIDE' : `OFFSIDE +${info.margin.toFixed(2)} m`, W - 14, 23);
  // Pitch window: 7 px a metre round the lines.
  const s = 7, cx = (info.xa + info.xd) / 2;
  const a = info.snap.players[info.attacker].pos;
  const cz = Math.max(-PITCH.halfWidth + 14, Math.min(PITCH.halfWidth - 14, a.z));
  const X = (x: number) => W / 2 + (x - cx) * s, Z = (z: number) => top + (H - top) / 2 + (z - cz) * s;
  g.save();
  g.beginPath(); g.rect(0, top, W, H - top); g.clip();
  for (let i = -20; i < 20; i++) { g.fillStyle = i % 2 ? '#2f8f3c' : '#36a044'; g.fillRect(X(i * 5.25), top, 5.25 * s + 1, H - top); }
  g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2;
  g.strokeRect(X(-PITCH.halfLength), Z(-PITCH.halfWidth), PITCH.length * s, PITCH.width * s);
  g.beginPath(); g.moveTo(X(0), Z(-PITCH.halfWidth)); g.lineTo(X(0), Z(PITCH.halfWidth)); g.stroke();
  for (const side of [-1, 1]) g.strokeRect(side > 0 ? X(PITCH.halfLength - 16.5) : X(-PITCH.halfLength), Z(-20.16), 16.5 * s, 40.32 * s);
  // Shading and the two lines.
  g.fillStyle = 'rgba(255,42,58,0.35)';
  g.fillRect(Math.min(X(info.xa), X(info.xd)), top, Math.max(2, Math.abs(X(info.xa) - X(info.xd))), H - top);
  g.fillStyle = '#2ad1ff'; g.fillRect(X(info.xd) - 1.5, top, 3, H - top);
  g.fillStyle = '#ff2a3a'; g.fillRect(X(info.xa) - 1.5, top, 3, H - top);
  // Players.
  info.snap.players.forEach((p, id) => {
    if (p.off) return;
    const r = id === info.attacker || id === info.defender ? 7 : 5;
    g.beginPath(); g.arc(X(p.pos.x), Z(p.pos.z), r, 0, Math.PI * 2);
    g.fillStyle = hex(colours[teamOf(id)] ?? 0xffffff); g.fill();
    g.lineWidth = id === info.attacker ? 3 : 1.5; g.strokeStyle = id === info.attacker ? '#ff2a3a' : id === info.defender ? '#2ad1ff' : '#000'; g.stroke();
  });
  g.restore();
}
