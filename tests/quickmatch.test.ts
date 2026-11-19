import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanChoice, loadChoice, loadMenuOpen, saveChoice, saveMenuOpen, type MatchChoice } from '../src/client/quickmatch';

const BASE: MatchChoice = { club: 'a', opp: 'b', kit: 'home', oppKit: 'home', difficulty: 'pro', mentality: 'balanced', minutes: 6, draw: 'stand' };

function stubStorage(store: Record<string, string> = {}) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  return store;
}

describe('quick match setup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts from the defaults when nothing is saved', () => {
    stubStorage();
    expect(loadChoice(BASE)).toEqual(BASE);
  });

  it('keeps the last setup between visits', () => {
    const store = stubStorage();
    const mine: MatchChoice = { club: 'c', opp: 'd', kit: 'away', oppKit: 'away', difficulty: 'elite', mentality: 'attacking', minutes: 4, draw: 'extra' };
    saveChoice(mine);
    expect(JSON.parse(store['elevens.quickmatch.v1'])).toEqual(mine);
    expect(loadChoice(BASE)).toEqual(mine);
  });

  it('replaces anything unknown or broken with the default, field by field', () => {
    const c = cleanChoice({ club: 7, opp: 'x', kit: 'third', difficulty: 'legend', mentality: 'balanced', minutes: 5, draw: 'pens' }, BASE);
    expect(c).toEqual({ ...BASE, opp: 'x', draw: 'pens' });
    stubStorage({ 'elevens.quickmatch.v1': '{not json' });
    expect(loadChoice(BASE)).toEqual(BASE);
  });

  it('drops clubs that no longer exist and never plays a club against itself', () => {
    expect(cleanChoice({ club: 'gone', opp: 'b' }, BASE, (id) => id !== 'gone').club).toBe('a');
    const same = cleanChoice({ club: 'b', opp: 'b' }, BASE);
    expect(same.club).not.toBe(same.opp);
  });

  it('works without storage (private browsing)', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadChoice(BASE)).toEqual(BASE);
    expect(() => saveChoice(BASE)).not.toThrow();
    expect(loadMenuOpen()).toEqual({ modes: false, options: false });
    expect(() => saveMenuOpen({ modes: true, options: false })).not.toThrow();
  });
});

describe('menu sections', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('More modes and More options start closed and stay as the player left them', () => {
    stubStorage();
    expect(loadMenuOpen()).toEqual({ modes: false, options: false });
    saveMenuOpen({ modes: true, options: false });
    expect(loadMenuOpen()).toEqual({ modes: true, options: false });
  });
});
