// The two managers in their technical areas in front of the dugouts: they pace with play,
// watch the ball, wave their team forward, point and shout instructions, protest at fouls,
// put their hands on their heads at a miss and celebrate (or not) a goal. Each is a full player
// model (realistic when loaded) dressed in a coat or club tracksuit, with long sleeves and
// trousers; the gestures are reaction poses (render/reactions.ts) and the mouth opens to shout.

import * as THREE from 'three';
import type { Kit, TeamDef } from '../../shared/teams';
import type { MatchEvent } from '../../shared/types';
import type { ViewPlayer, ViewState } from '../view';
import { kitMaterials, PlayerModel } from './player';
import { RealPlayerModel, type PlayerAssets } from './realplayer';
import { ReactionDirector, type ReactionKind } from './reactions';
import { setKitClub } from './badgetex';

/** The technical areas (painted in stadium.ts: x 6..18 either side of halfway, z -35..-38.2). */
export const TECH = { x0: 7, x1: 17, z0: -37.6, z1: -35.5, walk: 1.25 } as const;

/** What each manager wears: home in a dark coat, away in a dark version of the club colour. */
export function managerKit(team: TeamDef, kit: Kit, side: 0 | 1): Kit {
  const club = new THREE.Color(kit.shirt);
  const coat = side === 0 ? new THREE.Color(0x1c2230) : club.clone().multiplyScalar(0.42).lerp(new THREE.Color(0x15171c), 0.35);
  const trousers = side === 0 ? 0x24262c : 0x1d1f25;
  return { shirt: coat.getHex(), sleeves: coat.getHex(), shorts: trousers, socks: trousers, number: kit.shirt, keeper: coat.getHex(), pattern: 'plain' };
}

const SKINS = [0xe0ac86, 0xc68a5f, 0xf1c7a5, 0x9c6a43];
const HAIRS = [0x8a8a8a, 0x2a2a2a, 0x5a4026, 0xb7b7b7];

interface Gaffer { model: PlayerModel | RealPlayerModel; p: ViewPlayer; side: 0 | 1; next: number; tx: number; tz: number }

export class Managers {
  readonly group = new THREE.Group();
  private list: Gaffer[] = [];
  private react = new ReactionDirector(311);
  private time = 0;
  private ballV = new THREE.Vector3();

  constructor(teams: [TeamDef, TeamDef], kits: ['home' | 'away', 'home' | 'away'], assets: PlayerAssets | null, shadows: boolean) {
    this.group.name = 'managers';
    teams.forEach((team, t) => {
      const side = t as 0 | 1;
      const kit = managerKit(team, team[kits[t]], side);
      setKitClub(kit, team);
      const h = Math.abs(hashStr(team.id));
      const skin = SKINS[h % SKINS.length], hair = HAIRS[(h >> 3) % HAIRS.length];
      const id = 90 + t;
      const model = assets
        ? new RealPlayerModel(id, assets, kit, false, skin, 0, shadows, { boot: 0x111111, hair, coat: true })
        : new PlayerModel(id, kitMaterials(kit), false, skin, hair, 0, shadows);
      // Classic models wear their number on the back: not a manager.
      if (!assets) model.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && (m.material as THREE.MeshBasicMaterial).isMeshBasicMaterial) m.visible = false; });
      const sx = t === 0 ? -1 : 1;
      const x = sx * 12, z = -36.4;
      const p: ViewPlayer = {
        id, team: side, role: 'CDM', def: team.players[5] ?? team.players[0], pos: { x, z }, vel: { x: 0, z: 0 }, facing: Math.PI / 2,
        stamina: 1, sprinting: false, jockeying: false, cards: 0, off: false, action: { type: 'none', t: 0, dur: 0 },
      };
      model.root.position.set(x, 0, z);
      this.group.add(model.root);
      this.list.push({ model, p, side, next: 3 + t * 2.5, tx: x, tz: z });
    });
  }

  /** The models (for shadows and tests). */
  get models() { return this.list.map((g) => g.model); }

  /** Where each manager's mouth is, for breath on cold nights. */
  mouths(): { x: number; y: number; z: number; facing: number; rate: number }[] {
    return this.list.map((g) => ({ x: g.p.pos.x, y: 1.66, z: g.p.pos.z, facing: g.p.facing, rate: this.react.kindOf(g.p.id - 90) ? 0.7 : 1.3 }));
  }

  /** Reacting to the match: goals, misses, saves, fouls and cards, the final whistle. */
  onEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      const team = e.team ?? -1;
      for (const g of this.list) {
        const i = g.side;
        const ours = team === g.side;
        const go = (kind: ReactionKind, dur: number, delay = 0.15) => this.react.add(i, kind, dur, delay);
        if (e.type === 'goal' && team >= 0) {
          const own = e.text === 'og' ? !ours : ours;
          if (own) { go('armsUp', 2.2, 0.1); go('fistPump', 2.6, 2.3); }
          else { go('headInHands', 2.4, 0.4); go('handsOnHips', 4, 2.9); }
        } else if ((e.type === 'chance' || e.type === 'post' || e.type === 'bar') && team >= 0) {
          const t = e.type === 'chance' ? team : view.ball.lastTouchTeam;
          if (t === g.side) go('headInHands', 2.2, 0.25);
          else if (Math.random() < 0.5) go('point', 1.8, 0.4);
        } else if (e.type === 'save' && team === g.side) go('clap', 1.6, 0.3);
        else if (e.type === 'foul' && team >= 0 && team !== g.side) go(Math.random() < 0.6 ? 'protest' : 'appeal', 2.2, 0.3);
        else if (e.type === 'card' && ours) go('protest', 2.5, 0.2);
        else if (e.type === 'fulltime') {
          const d = view.score[g.side] - view.score[1 - g.side];
          go(d > 0 ? 'clap' : d < 0 ? 'dejected' : 'handsOnHips', 5, 0.6);
        }
      }
    }
  }

  update(view: ViewState, dt: number, time: number) {
    this.time = time;
    this.react.update(dt);
    const b = view.ball.pos;
    this.ballV.set(b.x, b.y, b.z);
    const owner = view.ball.owner >= 0 ? view.players[view.ball.owner].team : view.ball.lastTouchTeam;
    const live = view.phase === 'play';
    for (const g of this.list) {
      const sx = g.side === 0 ? -1 : 1;
      const id = g.side;
      // Pace along the technical area with play, never leaving it.
      const lo = Math.min(sx * TECH.x0, sx * TECH.x1), hi = Math.max(sx * TECH.x0, sx * TECH.x1);
      g.tx = THREE.MathUtils.clamp(sx * 12 + (b.x - sx * 12) * 0.16, lo, hi);
      g.tz = THREE.MathUtils.clamp(-36.4 + Math.sin(time * 0.11 + g.side * 2) * 0.7 + (live && Math.abs(b.z + 34) < 14 ? 0.6 : 0), TECH.z0, TECH.z1);
      const dx = g.tx - g.p.pos.x, dz = g.tz - g.p.pos.z, d = Math.hypot(dx, dz);
      const v = d > 0.6 ? Math.min(TECH.walk, d * 0.9) : 0;
      g.p.vel.x += ((d > 0.01 ? (dx / d) * v : 0) - g.p.vel.x) * Math.min(1, dt * 4);
      g.p.vel.z += ((d > 0.01 ? (dz / d) * v : 0) - g.p.vel.z) * Math.min(1, dt * 4);
      g.p.pos.x += g.p.vel.x * dt;
      g.p.pos.z += g.p.vel.z * dt;
      // Watch the ball (turning the body; the head follows it too).
      const want = Math.atan2(b.z - g.p.pos.z, b.x - g.p.pos.x);
      g.p.facing += Math.atan2(Math.sin(want - g.p.facing), Math.cos(want - g.p.facing)) * Math.min(1, dt * 2.2);
      // Instructions now and then: wave them forward in attack, point and shout in defence.
      if (live && time > g.next && !this.react.kindOf(id)) {
        g.next = time + 5 + Math.random() * 8;
        const attacking = owner === g.side;
        const deep = (b.x * view.attackDir[g.side]) > 10;
        const r = Math.random();
        if (attacking && deep) this.react.add(id, r < 0.6 ? 'urge' : 'point', 2.2 + Math.random());
        else if (!attacking) this.react.add(id, r < 0.55 ? 'point' : r < 0.8 ? 'appeal' : 'urge', 1.8 + Math.random());
        else if (r < 0.35) this.react.add(id, 'clap', 1.4);
      }
      g.model.reaction = this.react.frame(id);
      g.model.update(g.p, dt, time, false, this.ballV);
    }
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}
