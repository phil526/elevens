import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';
import type { ViewState } from '../src/client/view';
import { ALL_CLUBS, type TeamDef } from '../src/shared/teams';
import { GROUNDS, groundFor, groundInSentence } from '../src/shared/grounds';
import { Hair, hairStyleFor } from '../src/client/render/hair';
import { NET } from '../src/client/render/vfx';
import { CELEB, CELEB_KINDS, celebKindFor, planCelebration, stageCelebration } from '../src/client/render/celebration';
import { PREMATCH, PREMATCH_LENGTH, lineSpot, photoSpot, preStage, stagePrematch } from '../src/client/render/prematch';
import { varInfo } from '../src/client/render/var';
import type { Snap } from '../src/client/render/cinematic';
import { bibColours } from '../src/client/render/touchline';
import { ReactionDirector, reactionPose } from '../src/client/render/reactions';
import { BY, KLX } from '../src/client/render/player';
import { aerialShot, AERIAL, AERIAL_LENGTH } from '../src/client/render/blimp';
import { PITCH } from '../src/shared/config';

function liveView(seed = 3, steps = 600): ViewState {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed }));
  const vb = new MatchViewBuilder(m);
  for (let i = 0; i < steps; i++) { m.step(); vb.capture(); }
  return vb.build(1);
}

describe('club grounds', () => {
  it('every club has its own ground, from compact grounds to super arenas', () => {
    const names = ALL_CLUBS.map((t) => groundFor(t).name);
    expect(new Set(names).size).toBe(ALL_CLUBS.length);
    const sizes = new Set(ALL_CLUBS.map((t) => groundFor(t).size));
    expect([...sizes].sort()).toEqual([0, 1, 2, 3]);
    for (const t of ALL_CLUBS) expect(GROUNDS[t.id]).toBeDefined();
    expect(groundFor(ALL_CLUBS[0]).name).toBe('The Harbourside Arena');
  });

  it('your own club gets a ground from its name, the same every time', () => {
    const mine: TeamDef = { ...ALL_CLUBS[3], id: 'custom-xyz', name: 'Wolverton Town' };
    const g = groundFor(mine);
    expect(g.name.startsWith('Wolverton ')).toBe(true);
    expect(groundFor(mine)).toEqual(g);
    expect(g.size).toBeLessThanOrEqual(2);
  });

  it('names read well mid-sentence', () => {
    expect(groundInSentence('The Crown Stadium')).toBe('the Crown Stadium');
    expect(groundInSentence('Foundry Lane')).toBe('Foundry Lane');
  });
});

describe('moving hair', () => {
  it('about one player in eight wears a ponytail and one in twelve a bun', () => {
    const all = ALL_CLUBS.flatMap((t) => t.players.map((p) => hairStyleFor(p.name)));
    const share = (s: string) => all.filter((x) => x === s).length / all.length;
    expect(share('ponytail')).toBeGreaterThan(0.06);
    expect(share('ponytail')).toBeLessThan(0.2);
    expect(share('bun')).toBeGreaterThan(0.03);
    expect(share('short')).toBeGreaterThan(0.65);
    expect(hairStyleFor('Bastian Kroll')).toBe(hairStyleFor('Bastian Kroll'));
  });

  it('a ponytail keeps its length, hangs down at rest and streams back at a sprint', () => {
    const root = new THREE.Group(), model = new THREE.Group();
    const head = new THREE.Bone(); head.name = 'Head'; head.position.set(0, 1.555, -0.038);
    const spine = new THREE.Bone(); spine.name = 'Spine02'; spine.position.set(0, 1.143, 0);
    model.add(spine, head); root.add(model);
    const hair = new Hair('ponytail', 0x332211, model, head, false, 2);
    root.add(hair.group);
    expect(hair.active).toBe(true);
    const tip = new THREE.Vector3();
    for (let i = 0; i < 120; i++) hair.update(1 / 60, root);
    hair.tip(tip);
    expect(tip.y).toBeLessThan(1.5); // hangs down the back
    expect(tip.z).toBeLessThan(0); // behind the head
    // Sprinting along +z (the way the body faces): the tail streams out behind, higher.
    const restY = tip.y;
    for (let i = 0; i < 90; i++) { root.position.z += 8 / 60; hair.update(1 / 60, root); }
    hair.tip(tip);
    expect(tip.z - root.position.z).toBeLessThan(-0.2);
    expect(tip.y).toBeGreaterThan(restY);
  });
});

describe('goal nets', () => {
  it('bulge further and wider than before, and still settle', () => {
    expect(NET.push).toBeGreaterThan(0.16);
    expect(NET.maxOut).toBeGreaterThan(0.8);
    expect(NET.damp).toBeGreaterThan(0);
  });
});

describe('goal celebrations', () => {
  it('every kind comes round, varied by scorer and goal', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 22; s++) for (let g = 0; g < 4; g++) seen.add(celebKindFor(s, g));
    expect(seen.size).toBe(CELEB_KINDS.length);
  });

  it('the scorer runs to the corner and slides on his knees; teammates join him', () => {
    const v = liveView();
    const scorer = 9;
    const plan = planCelebration(v, scorer, 0, 'kneeSlide');
    expect(plan.runEnd).toBeGreaterThanOrEqual(1);
    expect(plan.runEnd).toBeLessThanOrEqual(2.8);
    expect(Math.abs(plan.slideTo.x)).toBeLessThanOrEqual(PITCH.halfLength + 1);
    expect(Math.abs(plan.slideTo.z)).toBeLessThanOrEqual(PITCH.halfWidth + 1);
    expect(plan.mates.length).toBeGreaterThan(0);
    expect(plan.mates.every((m) => v.players[m.id].team === 0 && v.players[m.id].role !== 'GK')).toBe(true);
    const start = stageCelebration(v, plan, 0);
    expect(start.players[scorer].pos).toEqual(plan.from);
    // On his knees: no stride (zero velocity keeps the legs folded) while he skates on.
    const sliding = stageCelebration(v, plan, plan.runEnd + 0.4);
    expect(Math.hypot(sliding.players[scorer].vel.x, sliding.players[scorer].vel.z)).toBe(0);
    const end = stageCelebration(v, plan, CELEB.length);
    const sp = end.players[scorer].pos;
    expect(Math.hypot(sp.x - plan.slideTo.x, sp.z - plan.slideTo.z)).toBeLessThan(0.01);
    // The live view is untouched.
    expect(v.players[scorer].pos).toEqual(plan.from);
  });

  it('more variations: aeroplane curve stays on the pitch, a dance line, teammates bowing', () => {
    expect(CELEB_KINDS.length).toBeGreaterThanOrEqual(10);
    const v = liveView(5);
    const air = planCelebration(v, 9, 0, 'aeroplane');
    let bent = 0;
    for (let t = 0; t <= air.runEnd; t += 0.05) {
      const p = stageCelebration(v, air, t).players[9].pos;
      expect(Math.abs(p.z)).toBeLessThanOrEqual(PITCH.halfWidth + 1);
      const ax = air.to.x - air.from.x, az = air.to.z - air.from.z;
      bent = Math.max(bent, Math.abs((p.x - air.from.x) * az - (p.z - air.from.z) * ax) / Math.hypot(ax, az));
    }
    expect(bent).toBeGreaterThan(1); // a real curve, not a straight run
    const dance = planCelebration(v, 9, 0, 'dance');
    const line = dance.mates.filter((m) => m.kind === 'dance');
    expect(line.length).toBe(2);
    for (const m of line) {
      expect(m.face).toBeCloseTo(dance.face, 5);
      expect(Math.hypot(m.to.x - dance.centre.x, m.to.z - dance.centre.z)).toBeCloseTo(0.95, 2);
    }
    const bow = planCelebration(v, 9, 0, 'bow');
    expect(bow.mates.length).toBeGreaterThan(0);
    expect(bow.mates.every((m) => m.kind === 'bow')).toBe(true);
    const rd = new ReactionDirector(2);
    for (const k of ['aeroplane', 'kneelSky', 'cupEar', 'pointCrowd', 'dance', 'bow', 'armsWide'] as const) {
      const Q = new Float32Array(17);
      reactionPose(k, 0.9, 0.3, Q);
      expect(Q.every(Number.isFinite)).toBe(true);
      expect(Q.some((x) => x !== 0)).toBe(true);
    }
    rd.add(1, 'kneelSky', 3); rd.add(2, 'dance', 3); rd.add(3, 'aeroplane', 3);
    rd.update(0.5);
    expect(rd.frame(1)!.full).toBe(true);
    expect(rd.frame(2)!.full).toBe(true);
    expect(rd.frame(3)!.full).toBe(false);
  });

  it('a huddle forms a tight ring', () => {
    const v = liveView(8);
    const plan = planCelebration(v, 9, 0, 'huddle');
    for (const m of plan.mates) expect(Math.hypot(m.to.x - plan.centre.x, m.to.z - plan.centre.z)).toBeCloseTo(0.62, 2);
  });

  it('the new poses: knees bent and hips down for the slide; arm-only poses for the handshake', () => {
    const P = new Float32Array(17);
    reactionPose('kneeSlide', 1, 0.3, P);
    expect(P[BY]).toBeLessThan(-0.3);
    expect(P[KLX]).toBeGreaterThan(1.2);
    const rd = new ReactionDirector(1);
    rd.add(3, 'kneeSlide', 3); rd.add(4, 'shake', 3); rd.add(5, 'photoCrouch', 3);
    rd.update(0.5);
    expect(rd.frame(3)!.full).toBe(true);
    expect(rd.frame(4)!.only).toBeDefined();
    expect(rd.frame(5)!.full).toBe(true);
    for (const k of ['badgeKiss', 'huddle', 'holdHand', 'mascotHand', 'photoStand', 'board', 'stretch', 'armCircle'] as const) {
      const Q = new Float32Array(17);
      reactionPose(k, 0.7, 0.2, Q);
      expect(Q.every(Number.isFinite)).toBe(true);
      expect(Q.some((x) => x !== 0)).toBe(true);
    }
  });
});

describe('pre-match ceremony', () => {
  it('runs line-up, handshakes and photos in order', () => {
    expect(preStage(0).stage).toBe('line');
    expect(preStage(PREMATCH.line + 0.1).stage).toBe('shake');
    expect(preStage(PREMATCH_LENGTH - 0.1).stage).toBe('photo');
  });

  it('lines the teams up either side of halfway, then the away side files past the home line', () => {
    const v = liveView();
    const line = stagePrematch(v, 1);
    for (const p of line.players) {
      if (p.off) continue;
      expect(p.pos.z).toBe(PREMATCH.rowZ);
      expect(Math.sign(p.pos.x)).toBe(p.team === 0 ? -1 : 1);
      expect(p.facing).toBeCloseTo(Math.PI / 2);
    }
    const spots = line.players.filter((p) => !p.off).map((p) => `${p.pos.x.toFixed(2)}`);
    expect(new Set(spots).size).toBe(spots.length);
    const late = stagePrematch(v, PREMATCH.line + 4);
    const first = late.players.find((p) => p.team === 1 && !p.off)!;
    expect(first.pos.z).toBeCloseTo(PREMATCH.rowZ + PREMATCH.shakeZ, 3);
    expect(first.pos.x).toBeLessThan(lineSpot(1, 0).x);
  });

  it('team photos: one side at a time, six standing behind five crouching', () => {
    const v = liveView();
    const ph = stagePrematch(v, PREMATCH.line + PREMATCH.shake + 0.5);
    const shown = ph.players.filter((p) => !p.off);
    expect(shown.every((p) => p.team === 0)).toBe(true);
    const fronts = Array.from({ length: 11 }, (_, i) => photoSpot(0, i).front).filter(Boolean).length;
    expect(fronts).toBe(5);
  });
});

describe('offside checks', () => {
  it('draws the lines through the attacker and the second-last defender at the pass', () => {
    const players = Array.from({ length: 22 }, (_, id) => ({ pos: { x: id < 11 ? 10 : 20, z: 0 }, vel: { x: 0, z: 0 }, facing: 0, sprinting: false, jockeying: false, off: false, action: { type: 'none' as const, t: 0, dur: 0 } }));
    players[11].pos.x = 50; // keeper
    players[12].pos.x = 30; // second-last defender
    players[9].pos.x = 31.2; // attacker
    const snap = { t: 0, phase: 'play', players, ball: { pos: { x: 10, y: 0, z: 0 } } } as unknown as Snap;
    const info = varInfo(snap, 9, 0, 1, (id) => (id < 11 ? 0 : 1))!;
    expect(info.defender).toBe(12);
    expect(info.xd).toBe(30);
    expect(info.margin).toBeCloseTo(1.2, 5);
    // Attacking the other way.
    const flip = varInfo({ ...snap, players: players.map((p) => ({ ...p, pos: { x: -p.pos.x, z: 0 } })) } as Snap, 9, 0, -1, (id) => (id < 11 ? 0 : 1))!;
    expect(flip.margin).toBeCloseTo(1.2, 5);
  });
});

describe('touchline and sky', () => {
  it('bibs stand out from both kits', () => {
    const [a, b] = bibColours([ALL_CLUBS[0].home, ALL_CLUBS[1].home]);
    expect(a).not.toBe(b);
    for (const c of [a, b]) for (const k of [ALL_CLUBS[0].home, ALL_CLUBS[1].home]) expect(c).not.toBe(k.shirt);
  });

  it('the drone ends low inside the bowl, the blimp shot starts high above the roof', () => {
    const roof = 30;
    expect(aerialShot(0.1, null, roof).pos.y).toBeGreaterThan(roof + 20);
    const end = aerialShot(AERIAL_LENGTH - 0.01, null, roof);
    expect(end.pos.y).toBeLessThan(20);
    expect(Math.abs(end.pos.x)).toBeLessThan(PITCH.halfLength);
    expect(AERIAL.blimp).toBeGreaterThan(3);
  });
});
