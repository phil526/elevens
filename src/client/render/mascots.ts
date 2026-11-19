// Match-day mascots: a child in each club's kit walks out of the tunnel holding a player's hand,
// then stands in front of him for the line-up. Built for the intro only and thrown away after it.
// The children are the player bodies scaled down with a slightly bigger head (realistic bodies)
// or the classic figure scaled down.

import * as THREE from 'three';
import type { Kit } from '../../shared/teams';
import type { ViewPlayer, ViewState } from '../view';
import { kitMaterials, PlayerModel } from './player';
import { RealPlayerModel, type PlayerAssets } from './realplayer';
import { ReactionDirector } from './reactions';

export type MascotMode = 'hand' | 'front';

/** A mascot's size and where it walks: beside the player's right hand, or just in front of him. */
export const MASCOT = { scale: 0.6, head: 1.2, side: 0.74, front: 0.55 } as const;

const SKINS = [0xf1c7a5, 0xe0ac86, 0xc68a5f, 0x8d5a3b, 0xf3d2b8];
const HAIRS = [0x2a1d14, 0x6b4a2b, 0xc9a25a, 0x151515, 0x8a4b22];

interface Kid { model: PlayerModel | RealPlayerModel; p: ViewPlayer; of: number }

export class Mascots {
  readonly group = new THREE.Group();
  private kids: Kid[] = [];
  private react = new ReactionDirector(515);

  /** One child per player in `ids` (all 22 normally; fewer on Medium), in the player's team kit. */
  constructor(view: ViewState, kits: [Kit, Kit], ids: number[], assets: PlayerAssets | null, shadows: boolean) {
    this.group.name = 'mascots';
    for (const id of ids) {
      const pl = view.players[id];
      if (!pl) continue;
      const kit = kits[pl.team];
      const n = this.kids.length;
      const skin = SKINS[(id * 7 + 3) % SKINS.length], hair = HAIRS[(id * 5 + 1) % HAIRS.length];
      const mid = 100 + id;
      const model = assets
        ? new RealPlayerModel(mid, assets, kit, false, skin, 0, shadows, { hair, boot: 0x111111, hairStyle: n % 3 === 1 ? 'ponytail' : 'short', detail: 1 })
        : new PlayerModel(mid, kitMaterials(kit), false, skin, hair, 0, shadows);
      // No number on a mascot's back.
      model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.visible = false; });
      model.root.scale.setScalar(MASCOT.scale);
      // Children's heads are bigger for their size.
      const head = model.root.getObjectByName('Head');
      if (head) head.scale.setScalar(MASCOT.head);
      const p: ViewPlayer = { ...pl, id: mid, def: pl.def, pos: { ...pl.pos }, vel: { x: 0, z: 0 }, action: { type: 'none', t: 0, dur: 0 }, sprinting: false, jockeying: false, off: false };
      if (model instanceof RealPlayerModel) model.lookAtBall = false;
      this.group.add(model.root);
      this.kids.push({ model, p, of: id });
    }
  }

  get count() { return this.kids.length; }
  /** Which players have a mascot. */
  get players() { return this.kids.map((k) => k.of); }
  /** The models (tests and shadows). */
  get models() { return this.kids.map((k) => k.model); }

  /** Follow the players of the staged view: hand in hand on the walk-out, in front of them in the line-up. */
  update(view: ViewState, dt: number, time: number, mode: MascotMode, ball: THREE.Vector3) {
    this.react.update(dt);
    this.kids.forEach((k, i) => {
      const pl = view.players[k.of];
      const vis = !!pl && !pl.off;
      k.model.root.visible = vis;
      if (!vis) return;
      const f = pl.facing;
      const fx = Math.cos(f), fz = Math.sin(f);
      if (mode === 'hand') {
        // On his right: (-sin f, cos f).
        k.p.pos.x = pl.pos.x - fz * MASCOT.side;
        k.p.pos.z = pl.pos.z + fx * MASCOT.side;
        if (this.react.kindOf(i) !== 'mascotHand') this.react.cancel(i);
        this.react.hold(i, 'mascotHand', 0.5);
      } else {
        k.p.pos.x = pl.pos.x + fx * MASCOT.front;
        k.p.pos.z = pl.pos.z + fz * MASCOT.front;
        if (this.react.kindOf(i) !== 'lineUp') this.react.cancel(i);
        this.react.hold(i, 'lineUp', 0.6);
      }
      // Little legs take quicker strides: the walk is drawn at the player's pace scaled to the child.
      k.p.vel.x = pl.vel.x; k.p.vel.z = pl.vel.z;
      k.p.facing = f;
      k.model.reaction = this.react.frame(i);
      k.model.update(k.p, dt, time, false, ball);
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
    });
    this.kids = [];
  }
}
