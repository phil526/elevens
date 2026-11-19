// The 19 Nov visual pass: sky, ball spin, mowing, kit designs, TV grade, breath, the trophy
// ceremony and the big screens (whatever can be checked without a GPU).
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';
import { ALL_CLUBS, KIT_PATTERNS, KIT_STYLES, SHIRT_SPONSORS } from '../src/shared/teams';
import { BallSpin } from '../src/client/render/ball';
import { MOW_GLSL, MOW_NAMES, MOW_PATTERNS } from '../src/client/render/vfx';
import { coldFor, breathInterval } from '../src/client/render/breath';
import { skySun, CLOUD_COVER, OVERCAST } from '../src/client/render/sky';
import { toneMappingFor } from '../src/client/render/tvgrade';
import { CEREMONY, Ceremony, TROPHY, stageTrophy, trophyShot } from '../src/client/render/ceremony';
import { FEED } from '../src/client/render/bigscreen';
import { TECH, managerKit } from '../src/client/render/managers';

const view = () => {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 3 }));
  const vb = new MatchViewBuilder(m);
  m.step(); vb.capture();
  return vb.build(1);
};

describe('ball spin', () => {
  const fly = (bend: number) => {
    const s = new BallSpin(), q = new THREE.Quaternion();
    // Travelling along +x and bending towards -z (left of travel is -z when +x is forward and +y up).
    const v = new THREE.Vector3(24, 6, 0);
    for (let i = 0; i < 40; i++) {
      v.z += bend * (1 / 60);
      s.step(q, { x: i * 0.4, y: 2, z: 0 }, v, true, 1 / 60, 0.14);
    }
    return s.side;
  };
  it('turns one way for a ball curling left and the other for one curling right', () => {
    const a = fly(-8), b = fly(8);
    expect(Math.sign(a)).toBe(-Math.sign(b));
    expect(Math.abs(a)).toBeGreaterThan(5);
  });
  it('has no side spin on a straight ball', () => {
    expect(Math.abs(fly(0))).toBeLessThan(0.01);
  });
});

describe('mowing patterns', () => {
  it('every pattern has a name and a shader branch', () => {
    expect(MOW_PATTERNS.length).toBe(6);
    for (const p of MOW_PATTERNS) expect(MOW_NAMES[p]).toBeTruthy();
    expect(MOW_GLSL).toContain('mowGrain');
  });
});

describe('kit designs and sponsors', () => {
  it('every club has a valid home and away design and a fictional sponsor', () => {
    for (const c of ALL_CLUBS) {
      const st = KIT_STYLES[c.id];
      expect(st, c.id).toBeTruthy();
      expect(KIT_PATTERNS).toContain(c.home.pattern ?? 'plain');
      expect(KIT_PATTERNS).toContain(c.away.pattern ?? 'plain');
      expect(SHIRT_SPONSORS as readonly string[]).toContain(c.home.sponsor);
    }
  });
  it('uses no real brand names', () => {
    const real = ['emirates', 'fly emirates', 'etihad', 'nike', 'adidas', 'puma', 'samsung', 'chevrolet', 'standard chartered', 'qatar', 'jeep', 'heineken', 'coca', 'pepsi', 'vodafone', 'carlsberg', 'barclays', 'spotify', 'rakuten', 'betway', 'teamviewer', 'audi', 'volkswagen'];
    for (const s of SHIRT_SPONSORS) for (const r of real) expect(s.toLowerCase().includes(r), s).toBe(false);
  });
  it('varies the designs across the clubs', () => {
    const used = new Set(ALL_CLUBS.flatMap((c) => [c.home.pattern, c.away.pattern]));
    expect(used.size).toBeGreaterThanOrEqual(6);
  });
});

describe('sky, grade and breath', () => {
  it('puts the sun high by day, low at dusk (setting as the match goes on) and below the horizon at night', () => {
    const p: [number, number, number] = [60, 80, 40];
    expect(skySun('day', p).y).toBeGreaterThan(0.6);
    expect(skySun('dusk', p, 0).y).toBeGreaterThan(0);
    expect(skySun('dusk', p, 1).y).toBeLessThan(skySun('dusk', p, 0).y);
    expect(skySun('night', p).y).toBeLessThan(0);
    expect(OVERCAST.rain).toBeGreaterThan(CLOUD_COVER.day);
  });
  it('installs the TV grade into three’s tone mapping hook', () => {
    expect(toneMappingFor(true)).toBe(THREE.CustomToneMapping);
    expect(toneMappingFor(false)).toBe(THREE.ACESFilmicToneMapping);
    expect(THREE.ShaderChunk.tonemapping_pars_fragment).toContain('ACESFilmicToneMapping( color )');
  });
  it('shows breath in the snow and at night only, faster when sprinting or tired', () => {
    expect(coldFor('night', 'clear')).toBe(true);
    expect(coldFor('day', 'snow')).toBe(true);
    expect(coldFor('day', 'clear')).toBe(false);
    expect(coldFor('dusk', 'rain')).toBe(false);
    expect(breathInterval(8, true, 1)).toBeLessThan(breathInterval(0, false, 1));
    expect(breathInterval(0, false, 0.2)).toBeLessThan(breathInterval(0, false, 1));
  });
});

describe('managers', () => {
  it('dress in a coat, the away one in a dark version of the club colour', () => {
    const t = ALL_CLUBS[0];
    const home = managerKit(t, t.home, 0), away = managerKit(t, t.home, 1);
    expect(home.pattern).toBe('plain');
    expect(home.shirt).not.toBe(t.home.shirt);
    expect(away.shirt).not.toBe(home.shirt);
    expect(TECH.x1).toBeGreaterThan(TECH.x0);
  });
});

describe('trophy ceremony', () => {
  it('gathers the winners behind the plinth with the captain at the front and sends the losers off', () => {
    const v = view();
    const st = stageTrophy(v, 0, 9);
    const cap = st.players[9];
    expect(cap.off).toBe(false);
    expect(Math.abs(cap.pos.x - CEREMONY.spot.x)).toBeLessThan(0.01);
    for (const p of st.players) {
      if (p.team === 1) expect(p.off).toBe(true);
      else if (p.id !== 9) expect(p.pos.z).toBeLessThan(cap.pos.z - 1);
    }
    // Nobody stands on top of anyone else.
    const on = st.players.filter((p) => !p.off);
    for (const a of on) for (const b of on) if (a !== b) expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThan(0.6);
    expect(st.ball.pos.y).toBeLessThan(0);
  });
  it('moves the camera smoothly from start to finish', () => {
    let prev = trophyShot(0).pos;
    for (let t = 0.05; t <= TROPHY.length; t += 0.05) {
      const p = trophyShot(t).pos;
      expect(Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z)).toBeLessThan(1.2);
      prev = p;
    }
    expect(trophyShot(TROPHY.length).pos.y).toBeGreaterThan(15);
  });
  it('fires confetti at the lift and sends up fireworks', () => {
    const c = new Ceremony(1);
    c.start();
    expect(c.confettiLive).toBe(0);
    c.celebrate();
    expect(c.confettiLive).toBe(CEREMONY.confetti[1]);
    const hands = new THREE.Vector3(0, 2.3, 5.3);
    for (let i = 0; i < 60 * 8; i++) c.update(1 / 60, hands, 1);
    expect(c.launched).toBe(CEREMONY.bursts[1]);
    expect(c.trophy.position.distanceTo(hands)).toBeLessThan(0.2);
    // The confetti has come down to the grass by now.
    c.dispose();
  });
});

describe('big screens', () => {
  it('keeps a few seconds of pictures for the goal replay at each quality', () => {
    expect(FEED.fps[0]).toBe(0);
    for (const q of [1, 2, 3]) {
      expect(FEED.fps[q]).toBeGreaterThanOrEqual(8);
      expect(Math.ceil(FEED.keep * FEED.fps[q])).toBeLessThanOrEqual(60);
    }
  });
});
