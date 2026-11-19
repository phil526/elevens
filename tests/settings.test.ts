import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, loadSettings } from '../src/client/settings';

function stubStorage(saved: unknown) {
  const store: Record<string, string> = { 'elevens.settings.v1': JSON.stringify(saved) };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
}

describe('player ring setting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default', () => {
    expect(defaultSettings().playerRing).toBe(false);
  });

  it('turns the ring off once for settings saved before it existed, then keeps the choice', () => {
    stubStorage({ showNextMarker: true });
    const migrated = loadSettings();
    expect(migrated.playerRing).toBe(false);
    expect(migrated.ringOffDefault).toBe(true);
    stubStorage({ ...migrated, playerRing: true });
    expect(loadSettings().playerRing).toBe(true);
  });
});

describe('button hints setting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is on by default, also for settings saved before it existed', () => {
    expect(defaultSettings().controlHints).toBe(true);
    stubStorage({ showNextMarker: true });
    expect(loadSettings().controlHints).toBe(true);
  });

  it('keeps the choice to hide the hints', () => {
    stubStorage({ controlHints: false });
    expect(loadSettings().controlHints).toBe(false);
  });
});
