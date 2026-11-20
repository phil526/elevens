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

describe('a new player keeps their first settings (19 Nov 2026 bug hunt)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a first save of Tracking, ring On and announcer On survives the next visit', () => {
    const first = defaultSettings();
    first.camera.mode = 'tracking';
    first.playerRing = true;
    first.audio.announcer = true;
    stubStorage(JSON.parse(JSON.stringify(first)));
    const next = loadSettings();
    expect(next.camera.mode).toBe('tracking');
    expect(next.playerRing).toBe(true);
    expect(next.audio.announcer).toBe(true);
  });

  it('settings saved before the moves existed are still moved once', () => {
    stubStorage({ camera: { mode: 'tracking' }, playerRing: true, audio: { announcer: true } });
    const moved = loadSettings();
    expect(moved.camera.mode).toBe('broadcast');
    expect(moved.playerRing).toBe(false);
    expect(moved.audio.announcer).toBe(false);
  });
});

describe('recorded commentator setting (Philip, 20 Nov 2026: off by default, on in Settings)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default', () => {
    expect(defaultSettings().audio.commentary).toBe(false);
  });

  it('turns it off once for settings saved before, then keeps the choice to turn it on', () => {
    stubStorage({ audio: { commentary: true } });
    const migrated = loadSettings();
    expect(migrated.audio.commentary).toBe(false);
    expect(migrated.commentatorVoiceOff).toBe(true);
    stubStorage({ ...migrated, audio: { ...migrated.audio, commentary: true } });
    expect(loadSettings().audio.commentary).toBe(true);
  });
});
