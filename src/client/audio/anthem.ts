// National anthems for the World tournament (20 Nov 2026), made in Web Audio: each nation gets
// its own short, stately tune (about eight seconds) from its id, played by a soft brass section
// over a held chord and a timpani roll at the end. No recordings and no real anthems.

/** Major scale degrees in semitones. */
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];

/** The tune for a nation: [scale degree, beats] pairs, always ending on the home note. */
export function anthemTune(id: string): { root: number; notes: [number, number][]; bpm: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const r = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };
  const root = 48 + Math.floor(r() * 7); // C3..F#3
  const notes: [number, number][] = [[0, 1], [r() < 0.5 ? 2 : 4, 1]];
  let deg = notes[1][0];
  for (let i = 0; i < 9; i++) {
    const step = [-2, -1, 1, 2, 3, -3][Math.floor(r() * 6)];
    deg = Math.max(0, Math.min(9, deg + step));
    notes.push([deg, r() < 0.3 ? 2 : r() < 0.15 ? 0.5 : 1]);
  }
  notes.push([4, 1], [2, 1], [7, 3]);
  return { root, notes, bpm: 84 + Math.floor(r() * 16) };
}

const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Plays the anthem into `out` from `at` (seconds, context time); returns when it ends. */
export function playAnthem(ctx: AudioContext, out: AudioNode, id: string, at = ctx.currentTime + 0.1, gain = 0.22): number {
  const { root, notes, bpm } = anthemTune(id);
  const beat = 60 / bpm;
  const bus = ctx.createGain();
  bus.gain.value = gain;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1900;
  lp.Q.value = 0.6;
  bus.connect(lp).connect(out);
  let t = at;
  const brass = (midi: number, start: number, dur: number, level: number) => {
    for (const [type, det, lv] of [['sawtooth', -6, 0.5], ['sawtooth', 5, 0.5], ['triangle', 0, 0.6]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq(midi);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(level * lv, start + 0.06);
      g.gain.setTargetAtTime(level * lv * 0.75, start + 0.08, 0.2);
      g.gain.setTargetAtTime(0, start + dur * 0.92, 0.06);
      o.connect(g).connect(bus);
      o.start(start);
      o.stop(start + dur + 0.4);
    }
  };
  for (const [deg, beats] of notes) {
    const d = beats * beat;
    brass(root + 12 + SCALE[deg], t, d, 0.5);
    t += d;
  }
  // Held chords under the tune: I for the first half, V, then I.
  const end = t;
  const mid = at + (end - at) * 0.55;
  for (const [s, e, chord] of [[at, mid, [0, 4, 7]], [mid, end - 3 * beat, [7, 11, 14]], [end - 3 * beat, end, [0, 4, 7]]] as [number, number, number[]][]) {
    for (const n of chord) brass(root + n, s, e - s, 0.18);
  }
  // Timpani roll into the last note.
  for (let k = 0; k < 10; k++) {
    const s = end - 3 * beat - 0.6 + k * 0.06;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq(root - 12) * 1.02, s);
    o.frequency.exponentialRampToValueAtTime(freq(root - 12), s + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.25 + k * 0.03, s + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.5);
    o.connect(g).connect(bus);
    o.start(s);
    o.stop(s + 0.6);
  }
  return end + 0.6;
}
