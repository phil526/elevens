// Phones (20 Nov 2026): no white noise while the recorded sounds download, realistic players on
// Low, and model downloads that survive a dropped request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameAudio, type AudioSettings } from '../src/client/audio/audio';
import { realisticPlayers } from '../src/client/render/renderer';
import { fetchRetry } from '../src/client/render/realplayer';

/** Just enough Web Audio to follow what reaches the speakers: gains, connections, started sources. */
class Param {
  value: number;
  inputs: Node[] = [];
  constructor(v = 1) { this.value = v; }
  setValueAtTime(v: number) { this.value = v; return this; }
  setTargetAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class Node {
  outs: (Node | Param)[] = [];
  gain = new Param(1);
  frequency = new Param(440);
  Q = new Param(1);
  pan = new Param(0);
  threshold = new Param(0);
  ratio = new Param(1);
  type = '';
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  constructor(public kind: string) {}
  connect<T extends Node | Param>(n: T): T { this.outs.push(n); if (n instanceof Param) n.inputs.push(this); return n; }
  disconnect() { this.outs = []; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class FakeCtx {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = new Node('destination');
  sources: Node[] = [];
  private make(kind: string) { const n = new Node(kind); if (kind === 'source' || kind === 'osc') this.sources.push(n); return n; }
  createGain() { return this.make('gain'); }
  createBiquadFilter() { return this.make('filter'); }
  createDynamicsCompressor() { return this.make('comp'); }
  createStereoPanner() { return this.make('pan'); }
  createOscillator() { return this.make('osc'); }
  createBufferSource() { return this.make('source'); }
  createMediaElementSource() { return this.make('media'); }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { length: len, duration: len / 8000, getChannelData: () => d }; }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  decodeAudioData() { return new Promise(() => {}); }
}

/** Loudest gain from a started, unstopped buffer source (noise) to the speakers, ignoring LFO wobble. */
function noiseLevel(ctx: FakeCtx): number {
  const reach = (n: Node, depth = 0): number => {
    if (n === ctx.destination) return 1;
    if (depth > 30) return 0;
    let best = 0;
    for (const o of n.outs) if (o instanceof Node) best = Math.max(best, reach(o, depth + 1));
    // A gain wobbled by an LFO can swing as far as its value plus the LFO's depth.
    const wobble = n.gain.inputs.reduce((d, i) => d + Math.abs(i.gain.value), 0);
    return best * (n.kind === 'gain' ? Math.abs(n.gain.value) + wobble : 1);
  };
  return Math.max(0, ...ctx.sources.filter((s) => s.kind === 'source' && s.started && !s.stopped).map((s) => reach(s)));
}

const SETTINGS: AudioSettings = { master: 0.8, effects: 0.9, crowd: 0.6, muted: false, music: 0.5, musicOn: false, menuSounds: true };

function makeAudio() {
  const ctx = new FakeCtx();
  vi.stubGlobal('window', { AudioContext: function () { return ctx; }, setTimeout: (f: () => void) => { f(); return 0; } });
  vi.stubGlobal('fetch', () => new Promise(() => {})); // the sound files are still downloading
  const audio = new GameAudio(SETTINGS);
  audio.unlock();
  return { audio, ctx };
}

describe('no white noise on phones', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the crowd stays silent while its recordings download, even once a match has started', () => {
    const { audio, ctx } = makeAudio();
    expect(noiseLevel(ctx)).toBe(0);
    audio.setCrowdIntensity(0.42); // match intro
    expect(noiseLevel(ctx)).toBe(0);
    audio.setCrowdIntensity(0.8);
    expect(noiseLevel(ctx)).toBe(0);
  });

  it('no burst of noise stands in for a crowd reaction that has not loaded yet', () => {
    const { audio, ctx } = makeAudio();
    audio.setCrowdIntensity(0.6);
    audio.react('ooh');
    audio.react('goal');
    audio.react('gasp');
    expect(noiseLevel(ctx)).toBe(0);
  });

  it('rain stops completely afterwards (no hiss left on the menus)', () => {
    const { audio, ctx } = makeAudio();
    audio.setRain(1);
    expect(noiseLevel(ctx)).toBeGreaterThan(0);
    audio.setRain(0);
    expect(noiseLevel(ctx)).toBe(0);
  });
});

describe('realistic players on phones', () => {
  it('Low quality shows the realistic players unless Players is Classic', () => {
    expect(realisticPlayers({ preset: 'low', renderScale: 1, shadows: false, players: 'realistic' })).toBe(true);
    expect(realisticPlayers({ preset: 'low', renderScale: 1, shadows: false, players: 'classic' })).toBe(false);
    expect(realisticPlayers({ preset: 'medium', renderScale: 1, shadows: false })).toBe(true);
  });

  it('a dropped model request is tried again', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; if (calls < 3) throw new Error('network'); return { ok: true, status: 200 } as Response; });
    const p = fetchRetry('models/body-a.glb');
    await vi.runAllTimersAsync();
    expect((await p).ok).toBe(true);
    expect(calls).toBe(3);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a missing file is not retried', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return { ok: false, status: 404 } as Response; });
    expect((await fetchRetry('models/body-a.glb')).status).toBe(404);
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('commentary on phones and tablets (20 Nov 2026)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const touch = (coarse: boolean, saved: unknown) => {
    const store: Record<string, string> = saved === undefined ? {} : { 'elevens.settings.v1': JSON.stringify(saved) };
    vi.stubGlobal('matchMedia', () => ({ matches: coarse }));
    vi.stubGlobal('screen', { width: 800, height: 360 });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  };

  it('is off by default on a touch screen, captions on a computer', async () => {
    const { defaultSettings } = await import('../src/client/settings');
    touch(true, undefined);
    expect(defaultSettings().commentator).toBe('off');
    touch(false, undefined);
    expect(defaultSettings().commentator).toBe('captions');
  });

  it('is turned off once on phones that saved settings before, then the choice is kept', async () => {
    const { loadSettings } = await import('../src/client/settings');
    touch(true, { commentator: 'captions' });
    const moved = loadSettings();
    expect(moved.commentator).toBe('off');
    touch(true, { ...moved, commentator: 'voice' });
    expect(loadSettings().commentator).toBe('voice');
    touch(false, { commentator: 'captions' });
    expect(loadSettings().commentator).toBe('captions');
  });
});
