// Menu sounds, made in Web Audio (no files): a soft tick when the highlight moves, a two-note
// confirm with a little thump when something is chosen, a falling pair for Back, a click for
// an option toggle, and an airy whoosh for big screen changes (into and out of a match).

export type MenuSound = 'move' | 'select' | 'back' | 'toggle' | 'whoosh';

/** Shortest gap between two of the same sound (holding the stick down repeats moves). */
const GAP: Record<MenuSound, number> = { move: 0.045, select: 0.06, back: 0.06, toggle: 0.04, whoosh: 0.35 };

export class MenuSfx {
  private lastAt: Partial<Record<MenuSound, number>> = {};

  constructor(private ctx: AudioContext, private out: AudioNode, private noise: AudioBuffer) {}

  play(kind: MenuSound) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - (this.lastAt[kind] ?? -1) < GAP[kind]) return;
    this.lastAt[kind] = now;
    switch (kind) {
      case 'move': {
        this.tone(now, 1650, 1320, 0.035, 0.05, 'sine');
        this.tick(now, 4200, 0.018, 0.035);
        break;
      }
      case 'select': {
        this.thump(now, 150, 0.09, 0.16);
        this.tone(now, 784, 784, 0.07, 0.075, 'triangle');
        this.tone(now + 0.055, 1175, 1175, 0.1, 0.07, 'triangle');
        this.tick(now, 3000, 0.02, 0.05);
        break;
      }
      case 'back': {
        this.tone(now, 988, 988, 0.06, 0.06, 'triangle');
        this.tone(now + 0.05, 659, 620, 0.09, 0.06, 'triangle');
        break;
      }
      case 'toggle': {
        this.tone(now, 1240, 1100, 0.04, 0.06, 'square', 2600);
        this.tick(now, 5000, 0.012, 0.04);
        break;
      }
      case 'whoosh': {
        const n = ctx.createBufferSource();
        n.buffer = this.noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.4;
        bp.frequency.setValueAtTime(320, now);
        bp.frequency.exponentialRampToValueAtTime(2600, now + 0.22);
        bp.frequency.exponentialRampToValueAtTime(900, now + 0.42);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.11, now + 0.16);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (pan) { pan.pan.setValueAtTime(-0.5, now); pan.pan.linearRampToValueAtTime(0.5, now + 0.42); }
        n.connect(bp).connect(g);
        if (pan) g.connect(pan).connect(this.out); else g.connect(this.out);
        n.start(now, Math.random());
        n.stop(now + 0.5);
        break;
      }
    }
  }

  /** A short pitched blip (gliding from f0 to f1). */
  private tone(t: number, f0: number, f1: number, len: number, gain: number, type: OscillatorType, lowpass = 5000) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + len);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(lp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  /** A tiny noise click: the "physical" edge of a button. */
  private tick(t: number, hp: number, len: number, gain: number) {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(f).connect(g).connect(this.out);
    n.start(t, Math.random());
    n.stop(t + len + 0.01);
  }

  /** A soft low thump under a confirm. */
  private thump(t: number, f: number, len: number, gain: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.45, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + len + 0.02);
  }
}
