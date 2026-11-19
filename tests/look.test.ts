import { describe, expect, it } from 'vitest';
import { bootColour, captainIndex, playerBuild, readableOn } from '../src/client/render/look';
import { TEAMS } from '../src/shared/teams';

describe('player looks', () => {
  it('gives every player a stable build in a believable range, keepers and centre-backs tallest', () => {
    const all = TEAMS.flatMap((t) => t.players);
    for (const p of all) {
      const b = playerBuild(p);
      expect(b).toEqual(playerBuild(p));
      expect(b.h).toBeGreaterThan(0.92); expect(b.h).toBeLessThan(1.08);
      expect(b.w).toBeGreaterThan(0.9); expect(b.w).toBeLessThan(1.12);
    }
    const avg = (roles: string[]) => { const s = all.filter((p) => roles.includes(p.role)).map((p) => playerBuild(p).h); return s.reduce((a, b) => a + b, 0) / s.length; };
    expect(avg(['GK', 'RCB', 'LCB'])).toBeGreaterThan(avg(['RW', 'LW']) + 0.05);
    expect(new Set(all.map((p) => playerBuild(p).h)).size).toBeGreaterThan(all.length * 0.8);
  });

  it('picks one outfield captain per team and a boot colour per player', () => {
    for (const t of TEAMS) {
      const c = captainIndex(t);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(t.players[c].role).not.toBe('GK');
      for (const p of t.players) expect(bootColour(p)).toBe(bootColour(p));
    }
  });

  it('keeps lettering readable on the shirt colour', () => {
    expect(readableOn(0xffffff, 0xf4f4f4)).toBe(0x141414);
    expect(readableOn(0x111111, 0x151515)).toBe(0xf6f6f6);
    expect(readableOn(0xc8102e, 0xffffff)).toBe(0xffffff);
  });
});
