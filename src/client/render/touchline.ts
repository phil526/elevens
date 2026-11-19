// The far touchline between the dugouts: the fourth official, who walks to the halfway line and
// holds up the electronic board for each substitution (red number off, green number on) and for
// added time, and each side's substitutes warming up in bibs beyond the technical areas: jogging up
// and down, side-stepping, stretching and swinging their arms. When one of them comes on he leaves
// the warm-up. Purely visual (render only).

import * as THREE from 'three';
import { benchFor, type Kit, type PlayerDef, type TeamDef } from '../../shared/teams';
import type { MatchEvent } from '../../shared/types';
import type { ViewPlayer, ViewState } from '../view';
import { kitMaterials, PlayerModel } from './player';
import { RealPlayerModel, type PlayerAssets } from './realplayer';
import { ReactionDirector } from './reactions';
import { hairStyleFor } from './hair';

/** Where things happen (metres; the far touchline is z = -34, the boards at z = -40.2). */
export const TOUCH = {
  official: { x: 2.6, z: -37.3 },
  showAt: { x: 0.8, z: -34.9 },
  boardShow: 6.5,
  warm: { x0: 27, x1: 46, z: -37.3 },
} as const;

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const BIBS = [0xff6a13, 0xd4f20f, 0x19a7ff, 0xff2e88, 0xf5f5f5];

const dist = (a: number, b: number) => {
  const d = (s: number) => ((a >> s) & 255) - ((b >> s) & 255);
  return Math.hypot(d(16), d(8), d(0));
};

/** A bib colour for each side that stands out from both kits and from each other. */
export function bibColours(kits: [Kit, Kit]): [number, number] {
  const score = (c: number) => Math.min(...kits.flatMap((k) => [dist(c, k.shirt), dist(c, k.sleeves)]));
  const order = [...BIBS].sort((a, b) => score(b) - score(a));
  return [order[0], order[1]];
}

/** The board's face: two LED numbers (red off, green on) or one added-time figure. */
function boardTexture(): { tex: THREE.CanvasTexture; draw: (top: string, bottom: string | null) => void } {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 192;
  const g = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = (top: string, bottom: string | null) => {
    g.fillStyle = '#050506'; g.fillRect(0, 0, 256, 192);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const led = (text: string, y: number, size: number, col: string) => {
      g.font = `900 ${size}px "Arial Black", Arial, sans-serif`;
      g.shadowColor = col; g.shadowBlur = 14;
      g.fillStyle = col; g.fillText(text, 128, y, 230);
      g.shadowBlur = 0;
    };
    if (bottom === null) led(top, 100, 128, '#3dff6e');
    else { led(top, 50, 84, '#ff2b2b'); led(bottom, 144, 84, '#3dff6e'); }
    // The dot matrix.
    g.fillStyle = 'rgba(0,0,0,0.55)';
    for (let x = 0; x < 256; x += 6) g.fillRect(x, 0, 2, 192);
    for (let y = 0; y < 192; y += 6) g.fillRect(0, y, 256, 2);
    g.strokeStyle = '#1d1f24'; g.lineWidth = 10; g.strokeRect(0, 0, 256, 192);
    tex.needsUpdate = true;
  };
  draw('', '');
  return { tex, draw };
}

type Mode = 'jog' | 'shuffle' | 'stretch' | 'circle' | 'stand';
interface Sub { model: PlayerModel | RealPlayerModel; p: ViewPlayer; def: PlayerDef; team: 0 | 1; mode: Mode; until: number; tx: number; gone: boolean; slot: number }

const stubPlayer = (id: number, team: 0 | 1, def: PlayerDef, x: number, z: number, facing: number): ViewPlayer => ({
  id, team, role: def.role, def, pos: { x, z }, vel: { x: 0, z: 0 }, facing,
  stamina: 1, sprinting: false, jockeying: false, cards: 0, off: false, action: { type: 'none', t: 0, dur: 0 },
});

export class Touchline {
  readonly group = new THREE.Group();
  private official: { model: PlayerModel | RealPlayerModel; p: ViewPlayer };
  private board: THREE.Group;
  private face: ReturnType<typeof boardTexture>;
  /** Boards waiting to be shown (a double substitution shows twice). */
  private queue: { top: string; bottom: string | null }[] = [];
  private state: 'idle' | 'out' | 'show' = 'idle';
  private showT = 0;
  private subs: Sub[] = [];
  private react = new ReactionDirector(733);
  private numbers: number[] = [];
  private time = 0;
  private ballV = new THREE.Vector3();
  private rnd: () => number;

  constructor(teams: [TeamDef, TeamDef], kits: [Kit, Kit], assets: PlayerAssets | null, shadows: boolean, quality: number) {
    this.group.name = 'touchline';
    let seed = 4111;
    this.rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // The fourth official, in black.
    const black: Kit = { shirt: 0x141518, sleeves: 0x141518, shorts: 0x101114, socks: 0x101114, number: 0xe8ff1a, keeper: 0x141518, pattern: 'plain' };
    const om = assets
      ? new RealPlayerModel(92, assets, black, false, 0xd9a47e, 0, shadows, { boot: 0x0c0c0c, hair: 0x2a2a2a, coat: true })
      : new PlayerModel(92, kitMaterials(black), false, 0xd9a47e, 0x2a2a2a, 0, shadows);
    if (!assets) om.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.visible = false; });
    const def = teams[0].players[0];
    this.official = { model: om, p: stubPlayer(92, 0, def, TOUCH.official.x, TOUCH.official.z, Math.PI / 2) };
    om.root.position.set(TOUCH.official.x, 0, TOUCH.official.z);
    this.group.add(om.root);
    // The board: a dark frame with an LED face both sides and two handles, carried over the head.
    this.face = boardTexture();
    const board = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.52, 0.06), new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.5, metalness: 0.3 }));
    const ledMat = new THREE.MeshBasicMaterial({ map: this.face.tex, toneMapped: false });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.46), ledMat);
    front.position.z = 0.032;
    const back = front.clone();
    back.position.z = -0.032; back.rotation.y = Math.PI;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.04), frame.material);
    const h1 = handle.clone(); h1.position.set(-0.2, -0.32, 0);
    const h2 = handle.clone(); h2.position.set(0.2, -0.32, 0);
    board.add(frame, front, back, h1, h2);
    board.visible = false;
    frame.castShadow = shadows;
    this.group.add(board);
    this.board = board;
    // Substitutes warming up: two a side on Medium, three on High and up, none on Low.
    const per = quality >= 2 ? 3 : quality >= 1 ? 2 : 0;
    const bibs = bibColours(kits);
    teams.forEach((team, t) => {
      const side = t as 0 | 1;
      const bench = benchFor(team).filter((d) => d.role !== 'GK');
      for (let i = 0; i < Math.min(per, bench.length); i++) {
        const d = bench[i];
        const k = kits[t];
        const kit: Kit = { ...k, shirt: bibs[t], sleeves: k.sleeves, pattern: 'plain' };
        const id = 93 + t * 3 + i;
        const model = assets
          ? new RealPlayerModel(id, assets, kit, false, d.skin, 0, shadows && quality >= 2, { hair: d.hair, boot: 0x15161a, hairStyle: hairStyleFor(d.name), detail: quality })
          : new PlayerModel(id, kitMaterials(kit), false, d.skin, d.hair, 0, false);
        if (!assets) model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.visible = false; });
        const sx = side === 0 ? -1 : 1;
        const x = sx * (TOUCH.warm.x0 + 3 + i * 5), z = TOUCH.warm.z + (i % 2 ? 0.7 : -0.4);
        const s: Sub = { model, p: stubPlayer(id, side, d, x, z, sx > 0 ? 0 : Math.PI), def: d, team: side, mode: 'stand', until: 1 + i * 1.7, tx: x, gone: false, slot: i };
        model.root.position.set(x, 0, z);
        this.group.add(model.root);
        this.subs.push(s);
      }
    });
  }

  /** Everyone drawn here (shadows and tests). */
  get models() { return [this.official.model, ...this.subs.filter((s) => !s.gone).map((s) => s.model)]; }

  /** The board as shown now (tests): null when it is down. */
  get boardShowing(): boolean { return this.board.visible; }
  get warmingUp() { return this.subs.filter((s) => !s.gone).length; }

  onEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      if (e.type === 'sub' && e.player !== undefined && e.player >= 0) {
        const inn = view.players[e.player]?.def;
        const out = this.numbers[e.player];
        if (inn) {
          this.queue.push({ top: String(out ?? '?'), bottom: String(inn.number) });
          // He was warming up: off he goes.
          for (const s of this.subs) if (!s.gone && s.def.name === inn.name) { s.gone = true; s.model.root.visible = false; }
        }
      } else if (e.type === 'addedtime' && (e.power ?? 0) > 0) {
        this.queue.push({ top: `+${Math.round(e.power!)}`, bottom: null });
      }
    }
  }

  update(view: ViewState, dt: number, time: number) {
    this.time = time;
    this.react.update(dt);
    const b = view.ball.pos;
    this.ballV.set(b.x, b.y, b.z);
    // The fourth official: out to halfway with the board, back to his spot when it's done.
    const o = this.official;
    if (this.state === 'idle' && this.queue.length) {
      const q = this.queue.shift()!;
      this.face.draw(q.top, q.bottom);
      this.state = 'out';
    }
    const busy = this.state !== 'idle';
    const target = busy ? TOUCH.showAt : TOUCH.official;
    const dx = target.x - o.p.pos.x, dz = target.z - o.p.pos.z, d = Math.hypot(dx, dz);
    const arrived = d < 0.3;
    if (this.state === 'out' && arrived) {
      this.state = 'show';
      this.showT = TOUCH.boardShow;
      this.board.visible = true;
      this.board.scale.setScalar(0.4);
      this.react.add(0, 'board', TOUCH.boardShow + 0.3, 0);
    }
    if (this.state === 'show') {
      this.showT -= dt;
      this.board.scale.setScalar(Math.min(1, this.board.scale.x + dt * 3));
      if (this.showT <= 0) { this.board.visible = false; this.state = 'idle'; }
    }
    const v = d > 0.2 ? Math.min(busy ? 2.4 : 1.3, d * 1.2) : 0;
    o.p.vel.x += ((d > 0.01 ? (dx / d) * v : 0) - o.p.vel.x) * Math.min(1, dt * 5);
    o.p.vel.z += ((d > 0.01 ? (dz / d) * v : 0) - o.p.vel.z) * Math.min(1, dt * 5);
    o.p.pos.x += o.p.vel.x * dt;
    o.p.pos.z += o.p.vel.z * dt;
    const look = this.state === 'show' ? Math.PI / 2 : v > 0.3 ? Math.atan2(o.p.vel.z, o.p.vel.x) : Math.atan2(b.z - o.p.pos.z, b.x - o.p.pos.x);
    o.p.facing += Math.atan2(Math.sin(look - o.p.facing), Math.cos(look - o.p.facing)) * Math.min(1, dt * 3);
    o.model.reaction = this.react.frame(0);
    o.model.update(o.p, dt, time, false, this.ballV);
    if (this.board.visible) {
      // In his hands (between the hand bones; over the head on classic figures), facing the pitch.
      const root = o.model.root;
      root.updateMatrixWorld(true);
      const l = root.getObjectByName('LeftHand'), r = root.getObjectByName('RightHand');
      if (l && r) this.board.position.copy(l.getWorldPosition(_v)).add(r.getWorldPosition(_w)).multiplyScalar(0.5).add(_w.set(0, 0.24, 0)).addScaledVector(_w.set(0, 0, 1).applyQuaternion(root.quaternion), 0.04);
      else this.board.position.set(0, 2.3, 0.08).applyMatrix4(root.matrixWorld);
      this.board.quaternion.copy(root.quaternion);
    }
    // The substitutes.
    for (const s of this.subs) {
      if (s.gone) continue;
      const sx = s.team === 0 ? -1 : 1;
      const lo = TOUCH.warm.x0, hi = TOUCH.warm.x1;
      if (time > s.until) {
        const r = this.rnd();
        s.mode = r < 0.45 ? 'jog' : r < 0.62 ? 'shuffle' : r < 0.8 ? 'stretch' : r < 0.92 ? 'circle' : 'stand';
        const ax = Math.abs(s.p.pos.x);
        if (s.mode === 'jog' || s.mode === 'shuffle') s.tx = sx * (ax < (lo + hi) / 2 ? hi - 1 - this.rnd() * 3 : lo + 1 + this.rnd() * 3);
        else s.tx = s.p.pos.x;
        s.until = time + (s.mode === 'jog' ? 12 : s.mode === 'shuffle' ? 9 : s.mode === 'stretch' ? 4.4 : 3);
        const id = 1 + this.subs.indexOf(s);
        if (s.mode === 'stretch') this.react.add(id, 'stretch', 4.4);
        else if (s.mode === 'circle') this.react.add(id, 'armCircle', 3);
      }
      const dxs = s.tx - s.p.pos.x;
      const moving = (s.mode === 'jog' || s.mode === 'shuffle') && Math.abs(dxs) > 0.3;
      if (!moving && (s.mode === 'jog' || s.mode === 'shuffle')) s.until = Math.min(s.until, time + 0.6);
      const speed = moving ? (s.mode === 'jog' ? 3.1 : 1.7) : 0;
      const vx = moving ? Math.sign(dxs) * speed : 0;
      const zWant = TOUCH.warm.z + (s.slot % 2 ? 0.7 : -0.4);
      s.p.vel.x += (vx - s.p.vel.x) * Math.min(1, dt * 4);
      s.p.vel.z = (zWant - s.p.pos.z) * 1.5;
      s.p.pos.x += s.p.vel.x * dt;
      s.p.pos.z += s.p.vel.z * dt;
      s.p.jockeying = s.mode === 'shuffle' && moving;
      const face = s.mode === 'shuffle' ? Math.PI / 2 : moving ? (vx > 0 ? 0 : Math.PI) : Math.atan2(b.z - s.p.pos.z, b.x - s.p.pos.x);
      s.p.facing += Math.atan2(Math.sin(face - s.p.facing), Math.cos(face - s.p.facing)) * Math.min(1, dt * 4);
      s.model.reaction = this.react.frame(1 + this.subs.indexOf(s));
      s.model.update(s.p, dt, time, false, this.ballV);
    }
    for (let i = 0; i < view.players.length; i++) this.numbers[i] = view.players[i].def.number;
  }
}
