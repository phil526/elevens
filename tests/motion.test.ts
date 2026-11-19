// Movement detail (render/motion.ts, 19 Nov 2026): gestures, tackle/fall/kick style choices,
// tiredness, cut detection and the planted-foot leg solver.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as P from '../src/client/render/player';
import {
  FALL, FALL_TOTAL, GaitTracker, GESTURE_DUR, MC, fallDirFor, fallPose, firstTouchFor, gestureParts, gesturePose, kickFlavourFor,
  makeGesture, relAngle, restPose, solveLeg, tacklePose, tackleStyleFor, tirednessFor,
} from '../src/client/render/motion';

describe('motion channels', () => {
  it('match the pose solver', () => {
    for (const [k, v] of Object.entries(MC)) expect((P as Record<string, unknown>)[k]).toBe(v);
  });
});

describe('first touches', () => {
  it('chest for a dropping ball, thigh at waist height, flick or cushion on the ground', () => {
    expect(firstTouchFor(1.4, 0)).toBe('chest');
    expect(firstTouchFor(0.8, 0)).toBe('thigh');
    expect(firstTouchFor(0.11, 1.2)).toBe('flick');
    expect(firstTouchFor(0.11, 0.2)).toBe('cushion');
  });
  it('gestures rise and fall over their length and lift the touching leg', () => {
    for (const kind of Object.keys(GESTURE_DUR) as (keyof typeof GESTURE_DUR)[]) {
      const g = makeGesture(kind, 1);
      const X = new Float32Array(17);
      g.t = 0; expect(gesturePose(X, g)).toBeLessThan(0.05);
      g.t = g.dur * 0.45; expect(gesturePose(X.fill(0), g)).toBeGreaterThan(0.4);
      g.t = g.dur; expect(gesturePose(X.fill(0), g)).toBeLessThan(0.05);
    }
    const X = new Float32Array(17);
    const thigh = makeGesture('thigh', 1); thigh.t = 0.2; gesturePose(X, thigh);
    expect(X[MC.HRX]).toBeLessThan(-0.9); // right thigh up
    const left = makeGesture('thigh', -1); left.t = 0.2; gesturePose(X.fill(0), left);
    expect(X[MC.HLX]).toBeLessThan(-0.9);
  });
  it('running touches move only the touching leg; standing control can use the whole body', () => {
    expect(gestureParts('touch', 6)).toBe('leg');
    expect(gestureParts('cushion', 0.5)).toBe('legArms');
    expect(gestureParts('chest', 0.5)).toBe('all');
    expect(gestureParts('chest', 4)).toBe('upper');
  });
});

describe('tackles', () => {
  const me = { x: 0, z: 0 };
  it('carrier alongside going the same way: shoulder to shoulder, on his side', () => {
    const r = tackleStyleFor(0, me, { x: 0.6, z: 0.6 }, { x: 0.2, z: 0.7, vx: 6, vz: 0 });
    expect(r.style).toBe('shoulder');
    expect(r.side).toBe(1); // +z is the right of a player facing +x
  });
  it('ball out of reach: a toe poke; close and head-on: a block', () => {
    expect(tackleStyleFor(0, me, { x: 1.5, z: 0.1 }, { x: 1.9, z: 0.1, vx: -3, vz: 0 }).style).toBe('poke');
    expect(tackleStyleFor(0, me, { x: 0.7, z: 0.05 }, { x: 1.1, z: 0, vx: -4, vz: 0 }).style).toBe('block');
  });
  it('a poke stretches the tackling leg and drops the body', () => {
    const X = new Float32Array(17);
    tacklePose(X, 'poke', 1, 0.22, 0.42);
    expect(X[MC.HRX]).toBeLessThan(-1);
    expect(X[MC.BY]).toBeLessThan(-0.15);
  });
});

describe('falls', () => {
  it('goes down away from the offender: forward from behind, onto the side from the side', () => {
    expect(fallDirFor(0, { x: 0, z: 0 }, { x: -1, z: 0 })).toBe('forward');
    expect(fallDirFor(0, { x: 0, z: 0 }, { x: 0, z: -1 })).toBe('right'); // pushed towards +z, his right
    expect(fallDirFor(0, { x: 0, z: 0 }, { x: 0, z: 1 })).toBe('left');
    expect(fallDirFor(0, { x: 0, z: 0 }, null)).toBe('forward');
  });
  it('lies on the grass, then stands back up', () => {
    const X = new Float32Array(17);
    fallPose(X, 'forward', FALL.stagger + FALL.drop + FALL.lie * 0.5);
    expect(X[MC.BRX]).toBeGreaterThan(1.2);
    fallPose(X, 'left', FALL.stagger + FALL.drop + FALL.lie * 0.5);
    expect(Math.abs(X[MC.BRZ])).toBeGreaterThan(1.2);
    fallPose(X, 'forward', FALL_TOTAL);
    expect(Math.abs(X[MC.BRX])).toBeLessThan(0.05);
    expect(Math.abs(X[MC.BY])).toBeLessThan(0.05);
    // Getting up passes through a kneel.
    fallPose(X, 'forward', FALL_TOTAL - FALL.rise * 0.5);
    expect(X[MC.BY]).toBeLessThan(-0.3);
  });
});

describe('kick styles', () => {
  const base = { strong: 1 as const, reach: 0.5, ballY: 0.11, seed: 0 };
  it('a pass behind the kicker is a backheel', () => {
    expect(kickFlavourFor({ ...base, kind: 'pass', angle: Math.PI * 0.9 }).flavour).toBe('backheel');
    expect(kickFlavourFor({ ...base, kind: 'lob', angle: Math.PI * 0.9 }).flavour).toBe(null);
    // Never a backheeled shot from distance.
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: Math.PI * 0.9, goalDist: 25 }).flavour).toBe(null);
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: Math.PI * 0.9, goalDist: 8 }).flavour).toBe('backheel');
  });
  it('a right-footer passing off to the right uses the outside of the boot', () => {
    const r = kickFlavourFor({ ...base, kind: 'pass', angle: -1.1 });
    expect(r.flavour).toBe('outside');
    expect(r.foot).toBe(1);
    expect(kickFlavourFor({ ...base, kind: 'pass', angle: 1.1 }).flavour).toBe(null); // to the left: inside of the right foot
  });
  it('a stretched or close-range shot can be a toe poke; volleys never are', () => {
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: 0, reach: 2.0 }).flavour).toBe('toe');
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: 0, goalDist: 7, seed: 3 }).flavour).toBe('toe');
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: 0, goalDist: 20 }).flavour).toBe(null);
    expect(kickFlavourFor({ ...base, kind: 'pass', angle: 0, reach: 1.5 }).flavour).toBe(null); // the usual stride ahead
    expect(kickFlavourFor({ ...base, kind: 'shot', angle: 0, reach: 2.0, ballY: 0.8 }).flavour).toBe(null);
  });
  it('relAngle is positive to the left (facing +x, +z is the right)', () => {
    expect(relAngle(0, 0, -1)).toBeCloseTo(Math.PI / 2);
    expect(relAngle(0, 0, 1)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('tiredness', () => {
  it('fresh players look fresh, a drained one exhausted', () => {
    expect(tirednessFor(1)).toBe(0);
    expect(tirednessFor(0.9)).toBeLessThan(0.05);
    expect(tirednessFor(0.4)).toBeGreaterThan(0.95);
  });
  it('hands on knees bends right over with the arms down to the knees; breathing hard stays upright', () => {
    const X = new Float32Array(17);
    restPose(X, 'knees', 0, 1);
    expect(X[MC.SPX]).toBeGreaterThan(0.9);
    expect(X[MC.SLX]).toBeLessThan(-1);
    restPose(X, 'breathe', 0, 1);
    expect(X[MC.SPX]).toBeLessThan(0.35);
  });
});

describe('gait tracker', () => {
  it('a sharp cut at speed plants a foot, on the side of the turn', () => {
    const g = new GaitTracker();
    for (let i = 0; i < 30; i++) g.update(6, 0, 1 / 60);
    expect(g.cut).toBe(null);
    // Turn 70 degrees to the right (+z) in a tenth of a second.
    let seen: number | null = null;
    for (let i = 0; i < 12; i++) { const a = Math.min(1.2, (i + 1) * 0.2); g.update(6 * Math.cos(a), 6 * Math.sin(a), 1 / 60); if (g.cut && seen === null) seen = g.cut.side; }
    expect(seen).toBe(-1); // to the right
    expect(g.plant).toBeGreaterThan(0);
  });
  it('gentle curves do not', () => {
    const g = new GaitTracker();
    for (let i = 0; i < 120; i++) { const a = i * 0.01; g.update(6 * Math.cos(a), 6 * Math.sin(a), 1 / 60); }
    expect(g.cut).toBe(null);
  });
  it('measures braking', () => {
    const g = new GaitTracker();
    for (let i = 0; i < 30; i++) g.update(8, 0, 1 / 60);
    for (let i = 0; i < 30; i++) g.update(Math.max(0, 8 - (i + 1) * 0.2), 0, 1 / 60);
    expect(g.acc).toBeLessThan(-6);
  });
});

describe('leg solver', () => {
  const chain = () => {
    const root = new THREE.Object3D();
    const thigh = new THREE.Object3D(); thigh.position.set(0, 0.95, 0); root.add(thigh);
    const shin = new THREE.Object3D(); shin.position.set(0, -0.45, 0.02); thigh.add(shin);
    const foot = new THREE.Object3D(); foot.position.set(0, -0.42, -0.02); shin.add(foot);
    foot.rotation.x = 0.3;
    root.updateMatrixWorld(true);
    return { root, thigh, shin, foot };
  };
  it('puts the ankle on the target and keeps the boot as it was', () => {
    const { thigh, shin, foot } = chain();
    const q0 = foot.getWorldQuaternion(new THREE.Quaternion());
    const T = new THREE.Vector3(0.1, 0.2, 0.25);
    expect(solveLeg(thigh, shin, foot, T, new THREE.Vector3(1, 0, 0))).toBe(true);
    expect(foot.getWorldPosition(new THREE.Vector3()).distanceTo(T)).toBeLessThan(1e-3);
    expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(q0)).toBeLessThan(1e-3);
  });
  it('refuses a target out of reach', () => {
    const { thigh, shin, foot } = chain();
    expect(solveLeg(thigh, shin, foot, new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0))).toBe(false);
  });
});
