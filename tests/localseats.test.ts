import { describe, it, expect } from 'vitest';
import { defaultPicks, listDevices, localKind, moveToken, seatsFor, splitKeyMap } from '../src/client/game/local';

describe('local multiplayer seats', () => {
  const devs = listDevices([0, 1], true, false, false);
  it('lists controllers first, then the keyboard', () => {
    expect(devs.map((d) => d.id)).toEqual(['pad0', 'pad1', 'keys']);
    expect(listDevices([0], true, true, true).map((d) => d.id)).toEqual(['pad0', 'keysL', 'keysR', 'touch']);
  });
  it('defaults to P1 home v P2 away', () => {
    const seats = seatsFor(devs, defaultPicks(devs));
    expect(seats.map((s) => [s.device.id, s.player, s.team, s.slot])).toEqual([['pad0', 1, 0, 0], ['pad1', 2, 1, 0]]);
    expect(localKind(seats)).toBe('versus');
  });
  it('two on one side is co-op, numbered in device order', () => {
    let p = defaultPicks(devs);
    p = moveToken(p, 'pad1', -1); // away -> middle
    p = moveToken(p, 'pad1', -1); // middle -> home
    const seats = seatsFor(devs, p);
    expect(seats.map((s) => [s.player, s.team, s.slot])).toEqual([[1, 0, 0], [2, 0, 1]]);
    expect(localKind(seats)).toBe('coop');
  });
  it('a side takes at most two', () => {
    let p = { pad0: -1, pad1: -1, keys: 0 } as Record<string, -1 | 0 | 1>;
    p = moveToken(p, 'keys', -1);
    expect(p.keys).toBe(0);
  });
  it('split keyboard halves do not share keys and leave Esc free', () => {
    const l = splitKeyMap('left'), r = splitKeyMap('right');
    for (const k of Object.keys(l)) expect(r[k]).toBeUndefined();
    expect(l.Escape).toBeUndefined();
    expect(r.Escape).toBeUndefined();
    expect(l.KeyF).toBe('pass');
    expect(r.ArrowUp).toBe('up');
  });
});
