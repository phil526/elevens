import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { INTRO, INTRO_LENGTH, REPLAY, ReplayRecorder, goalSideOf, introFrame, netCamShot, stageIntro, stageReplay, tunnelOf, walkAlong } from '../src/client/render/cinematic';
import { MatchViewBuilder } from '../src/client/view';
import { aiMatch, launch } from './helpers';

const tunnel = { x: 0, z: -46.9, dir: 1 as const };

describe('match intro', () => {
  it('starts high above the stadium looking down, ends the fly-in low in the bowl, then cuts into the tunnel', () => {
    const a = introFrame(0.1, tunnel);
    expect(a.stage).toBe('fly');
    expect(a.shot.pos.y).toBeGreaterThan(120);
    expect(Math.hypot(a.shot.pos.x, a.shot.pos.z)).toBeLessThan(5); // straight overhead
    expect(a.fade).toBeGreaterThan(0.5); // fading in from black
    const b = introFrame(INTRO.fly - 0.6, tunnel);
    expect(b.shot.pos.y).toBeLessThan(40);
    expect(b.shot.pos.z).toBeGreaterThan(PITCH.halfWidth); // behind the near touchline, looking across
    const c = introFrame(INTRO.fly + 0.05, tunnel);
    expect(c.stage).toBe('tunnel');
    expect(c.fade).toBeGreaterThan(0.8); // the cut hides behind black
    expect(c.shot.pos.z).toBeLessThan(tunnel.z); // inside the tunnel
    expect(c.shot.look.z).toBeGreaterThan(c.shot.pos.z); // looking out towards the pitch
    expect(introFrame(INTRO_LENGTH + 0.1, tunnel).stage).toBe('done');
  });

  it('hides the teams during the fly-in and walks them out of the tunnel in two files', () => {
    const m = aiMatch();
    const live = new MatchViewBuilder(m).build(1);
    const fly = stageIntro(live, introFrame(2, tunnel), tunnel);
    expect(fly.players.every((p) => p.off)).toBe(true);
    expect(fly.humans).toEqual([false, false]);
    const t = INTRO.fly + 4;
    const walk = stageIntro(live, introFrame(t, tunnel), tunnel);
    const shown = walk.players.filter((p) => !p.off);
    expect(shown.length).toBeGreaterThan(8);
    for (const p of shown) {
      expect(Math.abs(Math.abs(p.pos.x - tunnel.x) - INTRO.file)).toBeLessThan(1e-6);
      expect(p.pos.z).toBeGreaterThan(tunnel.z - INTRO.corridor);
      expect(p.vel.z).toBeCloseTo(INTRO.walkSpeed);
    }
    // Home on one side, away on the other; leaders a step past the mouth at the end of the shot.
    expect(new Set(shown.filter((p) => p.team === 0).map((p) => Math.sign(p.pos.x)))).toEqual(new Set([1])); // on the left of a camera looking +z
    expect(walkAlong(0, INTRO.tunnel)).toBeGreaterThan(0);
    expect(walkAlong(0, INTRO.tunnel)).toBeLessThan(6);
    // The live view is untouched.
    expect(live.players.some((p) => !p.off)).toBe(true);
  });

  it('uses the stadium tunnel when it has one, else the far side', () => {
    const g = new THREE.Group();
    expect(tunnelOf(g)).toEqual({ x: 0, z: -(PITCH.halfWidth + 9), dir: 1 });
    g.userData.tunnel = { x: 3, z: 50, dir: -1 };
    expect(tunnelOf(g)).toEqual({ x: 3, z: 50, dir: -1 });
    const f = introFrame(INTRO.fly + 1, tunnelOf(g));
    expect(f.shot.pos.z).toBeGreaterThan(50);
    expect(f.shot.look.z).toBeLessThan(f.shot.pos.z);
  });
});

describe('goal replay', () => {
  it('records recent play and gives it back interpolated, dropping old frames', () => {
    const m = aiMatch();
    const b = new MatchViewBuilder(m);
    const rec = new ReplayRecorder(2, 1 / 40);
    for (let i = 0; i < 300; i++) {
      m.step();
      rec.push(b.build(1), i / 60);
    }
    expect(rec.first).toBeGreaterThan(rec.last - 2.1);
    const mid = rec.at(rec.last - 1)!;
    expect(mid.players).toHaveLength(m.players.length);
    expect(Number.isFinite(mid.ball.pos.x)).toBe(true);
    // Snapshots are copies, not references into the live match.
    const before = rec.at(rec.last)!.ball.pos.x;
    m.ball.pos.x += 10;
    expect(rec.at(rec.last)!.ball.pos.x).toBe(before);
  });

  it('shows a real goal from inside the net, looking out, with the live score', () => {
    const m = aiMatch();
    const b = new MatchViewBuilder(m);
    for (let i = 0; i < 200; i++) m.step();
    m.phase = 'play';
    m.restart = null;
    const d = m.attackDir(0);
    const gk = m.players.find((p) => p.role === 'GK' && p.team === 1)!;
    gk.pos.z = 30;
    launch(m, { x: 40 * d, y: 0.3, z: 1 }, { x: 32 * d, y: 1, z: 0 }, 0, 'shot');
    const rec = new ReplayRecorder(8);
    let tg = -1;
    for (let i = 0; i < 240 && tg < 0; i++) {
      m.step();
      const v = b.build(1);
      rec.push(v, i / 60);
      if (m.drainEvents().some((e) => e.type === 'goal')) tg = i / 60;
    }
    expect(tg).toBeGreaterThan(0);
    const g = rec.at(tg)!;
    const { side, z } = goalSideOf(g.ball.pos);
    expect(side).toBe(Math.sign(d));
    const look = new THREE.Vector3();
    for (let t = Math.max(rec.first, tg - REPLAY.before); t < tg; t += 1 / 30) {
      const s = rec.at(t)!;
      const shot = netCamShot(side, z, s.ball.pos, look, 1 / 30);
      expect(Math.abs(shot.pos.x)).toBeGreaterThan(PITCH.halfLength);
      expect(Math.abs(shot.pos.x)).toBeLessThan(PITCH.halfLength + 2); // inside the goal
      expect(Math.abs(shot.pos.z)).toBeLessThan(PITCH.goalHalfWidth);
      expect(shot.pos.y).toBeLessThan(2.44); // under the crossbar
      expect(side * shot.look.x).toBeLessThan(side * shot.pos.x - 2); // always looking out
    }
    const live = b.build(1);
    const staged = stageReplay(live, rec.at(tg - 0.5)!);
    expect(staged.score).toEqual(live.score);
    expect(staged.humans).toEqual([false, false]);
  });
});
