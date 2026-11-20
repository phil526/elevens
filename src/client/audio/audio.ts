// Match audio (Web Audio): recorded crowd and ball sounds from public/sfx when they are
// present (see third-party-licences.txt), with synthesised sounds for anything missing.
// Title and menu music (Philip's "Stadium Drop", public/music/menu.mp3) loops on the menus and
// fades out when a match starts. A few commentary lines for shots and goals (Settings > Audio > Commentary). Starts only after a user gesture; master/effects/crowd/music buses;
// a compressor prevents spikes; voice limits stop overlapping kicks piling up.
// The crowd is silent until a match runs, so menus stay quiet. No synthesised noise plays while
// the recorded sounds are still loading (slow phone connections used to hear a hiss of white noise
// for the first seconds of a match): the noise fallbacks only take over if the files failed to load.

import { playAnthem } from './anthem';
import { MenuSfx, type MenuSound } from './menusfx';
import { COMMENTARY, COMMENT_KINDS, COMMENT_PRIORITY, commentFile, type CommentKind } from './commentary';

export type WhistleKind = 'out' | 'restart' | 'kickoff' | 'penalty' | 'foul' | 'offside' | 'stop' | 'goal' | 'halftime' | 'fulltime';

/** Blasts per whistle: [length s, loudness, gap after s]. */
export const WHISTLES: Record<WhistleKind, [number, number, number][]> = {
  out: [[0.16, 0.7, 0]],
  restart: [[0.32, 0.85, 0]],
  kickoff: [[0.45, 1, 0]],
  penalty: [[0.5, 1, 0]],
  foul: [[0.38, 1.15, 0]],
  offside: [[0.28, 1, 0]],
  stop: [[0.26, 0.9, 0]],
  goal: [[0.85, 1.1, 0]],
  halftime: [[0.6, 1, 0.22], [0.75, 1, 0]],
  fulltime: [[0.28, 1, 0.16], [0.28, 1, 0.16], [1.1, 1.1, 0]],
};

/** Recorded sounds and their files under public/sfx (any that are missing fall back to synthesis). */
export const SAMPLES = {
  crowdA: 'crowd-a.mp3', // looping stadium bed
  crowdB: 'crowd-b.mp3', // second bed with distant singing, crossfaded with the first
  chant: 'chant.mp3', // a chant now and then during play
  chant2: 'chant-2.mp3',
  goal: 'goal.mp3', // roar for a goal
  ooh: 'ooh.mp3', // near miss: post, bar, shot just wide
  ooh2: 'ooh-2.mp3', // a second take, so repeated near misses do not sound identical
  gasp: 'gasp.mp3', // big save or chance
  boo: 'boo.mp3', // fouls and cards
  applause: 'applause.mp3', // kick-off, half time, full time
  kick1: 'kick-1.mp3',
  kick2: 'kick-2.mp3',
  net: 'net.mp3', // ball into the net
  stomp: 'stomp.mp3', // the stands stamping and clapping in rhythm, now and then and after goals
  callShot: 'call-shot.mp3', // commentator: "What an amazing shot" (saves, woodwork)
  callStrike: 'call-strike.mp3', // commentator: "Oh, what a sweet strike" (goals)
  callIncredible: 'call-incredible.mp3', // commentator: "That is nothing but incredible" (goals)
} as const;
export type SampleName = keyof typeof SAMPLES;

export interface AudioSettings {
  master: number;
  effects: number;
  crowd: number;
  muted: boolean;
  /** Title and menu music level, and whether it plays at all. */
  music: number;
  musicOn: boolean;
  /** Commentary lines on shots and goals. */
  commentary?: boolean;
  /** Menu sounds: highlight ticks, confirm and back (audio/menusfx.ts). */
  menuSounds?: boolean;
  /** Stadium announcer: welcome and line-ups before kick-off (audio/announcer.ts). */
  announcer?: boolean;
}

/** Shortest gap between two commentary lines, in seconds, so the commentator never talks over himself. */
export const CALL_GAP = 9;

/** Level of the recorded crowd bed relative to the crowd intensity. */
const BED_GAIN = 1.6;

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private crowdBus!: GainNode;
  private crowdLevel!: GainNode;
  private noise!: AudioBuffer;
  private lastKick = 0;
  private activeKicks = 0;
  private settings: AudioSettings;
  private crowdTarget = 0; // silent until a match is running
  private samples: Partial<Record<SampleName, AudioBuffer>> = {};
  /** Every recorded sound has been tried (loaded or failed). */
  loaded = false;
  /** How the recorded sounds got on (Settings > Audio shows it). */
  sampleStatus = { loaded: 0, failed: 0, total: Object.keys(SAMPLES).length, error: '' };
  private bed: GainNode | null = null;
  private surge: GainNode | null = null; // lifts the crowd bed as a shot goes in, under the reaction
  private nextChant = 0;
  private chantTimer: number | null = null;
  /** Base URL of the sound files (next to index.html). */
  sfxBase = 'sfx/';
  /** Title and menu music, streamed (a decoded 3-minute track would take ~60 MB). */
  musicUrl = 'music/menu.mp3';
  private musicBus!: GainNode;
  private voiceBus!: GainNode;
  private lastCall = -99;
  private lastLine: SampleName | null = null;
  /** Recorded commentator lines (audio/commentary.ts), loaded once commentary is wanted. */
  private lines = new Map<string, AudioBuffer>();
  private linesLoading = false;
  /** The line playing now: when it ends, its priority, and its source (a goal may cut in). */
  private speaking: { until: number; prio: number; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private lastSaid = new Map<CommentKind, number>();
  /** Lines loaded and the total (Settings > Audio). */
  commentaryStatus = { loaded: 0, total: COMMENT_KINDS.reduce((n, k) => n + COMMENTARY[k].length, 0) };
  private nextStomp = 0;
  private musicFade: GainNode | null = null;
  musicEl: HTMLAudioElement | null = null;
  private musicWanted = false;
  private musicStop: number | null = null;

  constructor(s: AudioSettings) {
    this.settings = s;
  }

  /** Must be called from a user gesture (click / key / touch). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      // iPhone/iPad: a press (pointerdown) is not a gesture there, so music that failed to start
      // then starts on the tap's touchend or click.
      if (this.musicWanted && this.musicEl?.paused && this.musicStop === null) void this.musicEl.play().catch(() => {});
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(comp);
    this.fx = ctx.createGain();
    this.fx.connect(this.master);
    this.crowdBus = ctx.createGain();
    this.crowdBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.voiceBus = ctx.createGain();
    this.voiceBus.connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.apply(this.settings);
    this.startCrowd();
    if (this.rainWanted > 0) this.setRain(this.rainWanted);
    void this.loadSamples();
    if (this.musicWanted) this.setMusic(true);
  }

  /** True while the menu music should be heard (menus) rather than not (a match). */
  get musicPlaying() { return this.musicWanted && !!this.musicEl && !this.musicEl.paused; }

  /**
   * Menu music on or off: fades in over about a second, or fades out and pauses. Safe to call
   * before the first gesture: it starts as soon as audio is unlocked.
   */
  setMusic(on: boolean) {
    this.musicWanted = on;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.musicStop !== null) { clearTimeout(this.musicStop); this.musicStop = null; }
    if (on) {
      if (!this.musicEl) {
        const el = new Audio(this.musicUrl);
        el.loop = true;
        el.preload = 'auto';
        el.setAttribute('playsinline', '');
        this.musicEl = el;
        this.musicFade = ctx.createGain();
        this.musicFade.gain.value = 0;
        this.musicFade.connect(this.musicBus);
        try { ctx.createMediaElementSource(el).connect(this.musicFade); } catch { el.volume = 0.5; /* no Web Audio routing: play it directly */ }
      }
      this.musicFade!.gain.cancelScheduledValues(t);
      this.musicFade!.gain.setTargetAtTime(1, t, 0.4);
      if (this.musicEl.paused) void this.musicEl.play().catch(() => { /* blocked until a gesture: unlock() retries */ });
    } else if (this.musicEl && this.musicFade) {
      this.musicFade.gain.cancelScheduledValues(t);
      this.musicFade.gain.setTargetAtTime(0, t, 0.35);
      const el = this.musicEl;
      this.musicStop = window.setTimeout(() => { if (!this.musicWanted) el.pause(); this.musicStop = null; }, 1600);
    }
  }

  /** Loads every recorded sound that exists; a missing or broken file just keeps the synthesised one. */
  private async loadSamples() {
    const ctx = this.ctx!;
    const st = this.sampleStatus;
    const load = async (k: SampleName) => {
      const url = this.sfxBase + SAMPLES[k];
      for (let i = 0; i < 3 && !this.samples[k]; i++) {
        if (i) await new Promise((ok) => setTimeout(ok, 700 * i * i));
        try {
          const r = await fetch(url);
          if (!r.ok) { st.error = `${SAMPLES[k]}: HTTP ${r.status}`; if (r.status === 404) break; continue; }
          const buf = await r.arrayBuffer();
          this.samples[k] = await decode(ctx, buf);
        } catch (e) { st.error = `${SAMPLES[k]}: ${String((e as Error)?.message ?? e).slice(0, 80)}`; }
      }
      if (this.samples[k]) st.loaded++; else st.failed++;
    };
    // The stadium beds first, so the crowd is there as early as possible on a slow connection.
    await Promise.all((['crowdA', 'crowdB'] as SampleName[]).map(load));
    this.startBed();
    await Promise.all((Object.keys(SAMPLES) as SampleName[]).filter((k) => k !== 'crowdA' && k !== 'crowdB').map(load));
    this.loaded = true;
    if (st.failed) console.warn(`[audio] ${st.failed} of ${st.total} sounds could not load (${st.error})`);
  }

  /** Fetch the recorded commentator lines in the background (a few at a time; missing ones are skipped). */
  loadCommentary() {
    const ctx = this.ctx;
    if (!ctx || this.linesLoading || this.settings.commentary === false) return;
    this.linesLoading = true;
    const todo: string[] = [];
    for (const k of COMMENT_KINDS) COMMENTARY[k].forEach((_, i) => todo.push(commentFile(k, i)));
    const worker = async () => {
      for (let f = todo.shift(); f; f = todo.shift()) {
        try {
          const r = await fetch(this.sfxBase + f);
          if (!r.ok) continue;
          this.lines.set(f, await decode(ctx, await r.arrayBuffer()));
          this.commentaryStatus.loaded++;
        } catch { /* skipped: the line just isn't said */ }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  }

  /**
   * Say a commentary line of this kind. Lines never talk over each other: a big moment (goal,
   * red card, penalty) may cut a smaller line short; otherwise the line is skipped if one is
   * playing or one ended too recently (the gap depends on how big the moment is). The same line
   * is not repeated twice running. Returns true when a line plays.
   */
  say(kind: CommentKind, delay = 0.3): boolean {
    const ctx = this.ctx;
    if (!ctx || this.settings.commentary === false) return false;
    const files = COMMENTARY[kind].map((_, i) => commentFile(kind, i)).filter((f) => this.lines.has(f));
    if (!files.length) {
      // No recorded pack (yet): the older calls cover goals, saves and the woodwork.
      if (kind === 'goal' || kind === 'equaliser' || kind === 'header' || kind === 'pengoal') return !!this.call('goal', delay);
      if (kind === 'save' || kind === 'woodwork' || kind === 'pensave') return !!this.call('shot', delay);
      return false;
    }
    const prio = COMMENT_PRIORITY[kind];
    const now = ctx.currentTime;
    const sp = this.speaking;
    if (sp && now < sp.until) {
      if (prio < 3 || sp.prio >= 3) return false;
      sp.gain.gain.setTargetAtTime(0.0001, now, 0.05);
      try { sp.src.stop(now + 0.2); } catch { /* already stopped */ }
    } else if (sp && now - sp.until < [0, 9, 4, 1.5][prio]) return false;
    const last = this.lastSaid.get(kind) ?? -1;
    const pool = files.length > 1 ? files.filter((_, i) => i !== last) : files;
    const f = pool[Math.floor(Math.random() * pool.length)];
    this.lastSaid.set(kind, files.indexOf(f));
    const buf = this.lines.get(f)!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 1;
    src.connect(g).connect(this.voiceBus);
    src.start(now + delay);
    this.speaking = { until: now + delay + buf.duration, prio, src, gain: g };
    this.lastCall = now + delay + buf.duration;
    return true;
  }

  /** True once a recorded sound has loaded (tests and the settings screen use it). */
  has(k: SampleName) { return !!this.samples[k]; }

  /** Recorded stadium bed: two loops crossfading slowly, under the crowd level. */
  private startBed() {
    const ctx = this.ctx!;
    const beds = (['crowdA', 'crowdB'] as const).map((k) => this.samples[k]).filter((b): b is AudioBuffer => !!b);
    if (!beds.length) return;
    this.bed = ctx.createGain();
    this.bed.gain.value = 0;
    this.surge = ctx.createGain();
    this.bed.connect(this.surge).connect(this.crowdBus);
    this.bed.gain.setTargetAtTime(this.crowdTarget * BED_GAIN, ctx.currentTime, 0.8);
    beds.forEach((buf, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = beds.length > 1 ? 0.5 : 1;
      if (beds.length > 1) {
        // Slow swell between the two beds so the loop points are never obvious.
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 1 / (37 + i * 11);
        const lg = ctx.createGain();
        lg.gain.value = i ? -0.3 : 0.3;
        lfo.connect(lg).connect(g.gain);
        lfo.start();
      }
      src.connect(g).connect(this.bed!);
      src.start(0, Math.random() * buf.duration);
    });
  }

  /** Plays a recorded sound on a bus. Returns false if it is not loaded. */
  private play(k: SampleName, bus: AudioNode, gain: number, opts: { rate?: number; x?: number; offset?: number; dur?: number; fade?: number } = {}): boolean {
    const ctx = this.ctx;
    const buf = this.samples[k];
    if (!ctx || !buf) return false;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    const dur = Math.min(opts.dur ?? buf.duration, buf.duration - (opts.offset ?? 0));
    if (opts.fade) g.gain.setTargetAtTime(0.0001, now + Math.max(0, dur - opts.fade * 2), opts.fade);
    let out: AudioNode = g;
    if (opts.x !== undefined) out = g.connect(this.pan(opts.x));
    out.connect(bus);
    src.connect(g);
    src.start(now, opts.offset ?? 0, dur + 0.05);
    return true;
  }

  apply(s: AudioSettings) {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.fx.gain.setTargetAtTime(s.effects, t, 0.05);
    this.crowdBus.gain.setTargetAtTime(s.crowd * this.venueK, t, 0.05);
    this.musicBus.gain.setTargetAtTime(s.musicOn === false ? 0 : (s.music ?? 0.5), t, 0.05);
    this.voiceBus.gain.setTargetAtTime(s.commentary === false ? 0 : 0.95, t, 0.05);
  }

  private startCrowd() {
    const ctx = this.ctx!;
    // The crowd is the recordings only (startBed). There used to be a synthesised murmur of filtered
    // noise as well, and on phones it was heard as a white-noise hiss; if the recordings can't load
    // the match is simply quieter. crowdLevel stays as the level the bed and chants follow.
    this.crowdLevel = ctx.createGain();
    this.crowdLevel.gain.value = 0;
    this.crowdLevel.gain.setTargetAtTime(this.crowdTarget, ctx.currentTime, 1.5);
  }

  /** How loud the crowd is for the venue: a full stadium, or a few onlookers at a street cage. */
  private venueK = 1;
  setVenue(street: boolean) {
    this.venueK = street ? 0.16 : 1;
    if (this.settings) this.apply(this.settings);
  }

  /** Fade the crowd out (back to menus / lobby). */
  crowdOff() { this.setCrowdIntensity(0); }

  setCrowdIntensity(level: number) {
    this.crowdTarget = level;
    if (!this.ctx || !this.crowdLevel) return;
    const t = this.ctx.currentTime;
    this.crowdLevel.gain.setTargetAtTime(level, t, 0.8);
    if (this.bed) this.bed.gain.setTargetAtTime(level * BED_GAIN, t, 0.8);
    this.maybeChant();
  }

  /** Now and then during a match, a chant rises out of the crowd. */
  private maybeChant() {
    const ctx = this.ctx!;
    if (this.crowdTarget <= 0.05 || !this.samples.chant || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.nextChant === 0) { this.nextChant = now + 20 + Math.random() * 25; return; }
    if (now < this.nextChant) return;
    this.nextChant = now + 45 + Math.random() * 60;
    // About one time in four the stands stamp and clap instead of singing.
    if (this.samples.stomp && now > this.nextStomp && Math.random() < 0.25) { this.stomp(0.5 + 0.3 * this.crowdTarget); this.onCrowd('stomp'); return; }
    const k: SampleName = this.samples.chant2 && Math.random() < 0.5 ? 'chant2' : 'chant';
    this.play(k, this.crowdBus, 0.32 + 0.25 * this.crowdTarget, { fade: 0.6 });
    this.onCrowd('chant');
  }

  /** Told when the crowd starts a chant or stamps and claps (the stands show it: scarves up, clapping). */
  onCrowd: (kind: 'chant' | 'stomp') => void = () => {};

  private rain: GainNode | null = null;
  private rainWanted = 0;
  private rainNodes: AudioScheduledSourceNode[] = [];
  /** Rain on the stadium roof and the pitch: 0 off .. 1 a steady downpour. On the crowd volume. */
  setRain(level: number) {
    this.rainWanted = level;
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    if (!this.rain && level > 0) {
      // Hiss of rain: noise with the rumble and the harshest top taken out, slowly breathing.
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 6500;
      // The slow breathing (1 +- 0.2) goes on its own gain, before the level: on the level itself it
      // kept a faint hiss going after the rain stopped (back on the menus after a wet match).
      const breathe = ctx.createGain();
      breathe.gain.value = 1;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lg = ctx.createGain();
      lg.gain.value = 0.2;
      lfo.connect(lg).connect(breathe.gain);
      this.rain = ctx.createGain();
      this.rain.gain.value = 0;
      src.connect(hp).connect(lp).connect(breathe).connect(this.rain).connect(this.crowdBus);
      src.start();
      lfo.start();
      this.rainNodes = [src, lfo];
    }
    if (!this.rain) return;
    this.rain.gain.setTargetAtTime(level * 0.06, ctx.currentTime, 1.2);
    if (level <= 0) {
      // Fade out, then stop the noise source altogether.
      const r = this.rain, nodes = this.rainNodes;
      this.rain = null;
      this.rainNodes = [];
      window.setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } } r.disconnect(); }, 6000);
    }
  }

  /** The stands stamp their feet and clap in rhythm. */
  stomp(gain = 0.7, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || !this.samples.stomp) return false;
    this.nextStomp = ctx.currentTime + delay + 30;
    const go = () => this.play('stomp', this.crowdBus, gain, { fade: 0.5, rate: 0.97 + Math.random() * 0.06 });
    if (delay > 0) window.setTimeout(go, delay * 1000); else go();
    return true;
  }

  /**
   * A commentary line. 'shot' is for a great strike that is saved or hits the woodwork, 'goal'
   * for a goal (not own goals). Lines are spaced out, and the same line never plays twice running.
   * Returns the line chosen, or null when nothing plays.
   */
  call(kind: 'shot' | 'goal', delay = 0.35): SampleName | null {
    const ctx = this.ctx;
    if (!ctx || this.settings.commentary === false) return null;
    const now = ctx.currentTime;
    if (now - this.lastCall < CALL_GAP) return null;
    const options: SampleName[] = (kind === 'goal' ? ['callStrike', 'callIncredible'] as SampleName[] : ['callShot'] as SampleName[]).filter((k) => this.samples[k]);
    const fresh = options.filter((k) => k !== this.lastLine);
    const pick = (fresh.length ? fresh : options)[Math.floor(Math.random() * (fresh.length || options.length))];
    if (!pick || (kind === 'shot' && pick === this.lastLine && now - this.lastCall < 40)) return null;
    this.lastCall = now;
    this.lastLine = pick;
    window.setTimeout(() => this.play(pick, this.voiceBus, 1, { fade: 0.15 }), delay * 1000);
    return pick;
  }

  private pan(x: number) {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, x / 60));
    return p;
  }

  kick(power: number, x = 0, kind = '') {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastKick < 0.04 || this.activeKicks > 4) return;
    this.lastKick = now;
    if (kind !== 'touch' && (this.samples.kick1 || this.samples.kick2)) {
      // Recorded strike: firmer kicks louder and a touch lower; the two takes alternate at random.
      const k: SampleName = this.samples.kick2 && (!this.samples.kick1 || Math.random() < 0.5) ? 'kick2' : 'kick1';
      const strong = kind === 'shot' || power > 22;
      const vol = Math.min(1.1, 0.3 + power / 26);
      if (this.play(k, this.fx, vol, { x, rate: (strong ? 0.9 : 1.05) * (0.95 + Math.random() * 0.1), dur: 0.6, fade: 0.08 })) return;
    }
    this.activeKicks++;
    const strong = kind === 'shot' || power > 22;
    const vol = Math.min(1, 0.15 + power / 30) * (kind === 'touch' ? 0.35 : 1);
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.pan(x)).connect(this.fx);
    // Low thump.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime((strong ? 120 : 160) * (0.9 + Math.random() * 0.2), now);
    o.frequency.exponentialRampToValueAtTime(50, now + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * (strong ? 1.0 : 0.7), now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    o.connect(og).connect(out);
    // Leather slap.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = strong ? 2600 : 1600 + Math.random() * 500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(vol * 0.6, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + (strong ? 0.09 : 0.05));
    n.connect(lp).connect(ng).connect(out);
    out.gain.setValueAtTime(1, now);
    o.start(now); o.stop(now + 0.2);
    n.start(now, Math.random()); n.stop(now + 0.12);
    o.onended = () => { this.activeKicks--; };
  }

  post(x = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.pan(x)).connect(this.fx);
    for (const [f, d] of [[880, 0.6], [1320, 0.4], [2210, 0.25]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + d);
      o.connect(g).connect(out);
      o.start(now);
      o.stop(now + d);
    }
  }

  /**
   * Referee's whistle. Each call is one of the patterns real referees use:
   * - out: a light short pip (ball out of play: throw-in, goal kick or corner)
   * - restart / kickoff / penalty: one clear blast for the kick to be taken
   * - foul: one sharp, loud blast; offside and stopping play a firm short one
   * - goal: one long blast
   * - halftime: two long blasts; fulltime: two short and a long final blast
   */
  whistle(kind: WhistleKind | number = 'restart') {
    const ctx = this.ctx;
    if (!ctx) return;
    const k: WhistleKind = typeof kind === 'number' ? (kind >= 3 ? 'fulltime' : kind === 2 ? 'foul' : 'restart') : kind;
    let t = ctx.currentTime + 0.02;
    for (const [len, level, gap] of WHISTLES[k]) {
      this.blast(t, len, level);
      t += len + gap;
    }
  }

  /**
   * The home end tries to put an away penalty taker off (20 Nov 2026): a boo with dozens of fans
   * whistling through their fingers, scattered across the stand behind the goal.
   */
  penaltyWhistles(level = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.react('boo');
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < 14; i++) {
      const t = t0 + Math.random() * 1.6;
      const len = 0.35 + Math.random() * 0.7;
      const o = ctx.createOscillator();
      const f = 1900 + Math.random() * 1300;
      o.frequency.setValueAtTime(f * 0.92, t);
      o.frequency.linearRampToValueAtTime(f, t + 0.08);
      o.frequency.setValueAtTime(f, t + len * 0.6);
      o.frequency.linearRampToValueAtTime(f * (Math.random() < 0.5 ? 0.85 : 1.06), t + len);
      const g = ctx.createGain();
      const peak = 0.012 * level * (0.5 + Math.random());
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.05);
      g.gain.setValueAtTime(peak, t + len - 0.08);
      g.gain.linearRampToValueAtTime(0, t + len);
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      o.connect(g).connect(pan).connect(this.crowdBus);
      o.start(t); o.stop(t + len + 0.02);
    }
  }

  /** One blast of a pea whistle: two close tones, a fast rattle from the pea, a sharp attack. */
  private blast(t: number, len: number, level: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const peak = 0.13 * level;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.015);
    g.gain.setValueAtTime(peak, t + Math.max(0.03, len - 0.06));
    g.gain.linearRampToValueAtTime(0, t + len);
    const trem = ctx.createOscillator();
    trem.frequency.value = 34 + Math.random() * 6;
    const tg = ctx.createGain();
    tg.gain.value = peak * 0.6;
    trem.connect(tg).connect(g.gain);
    // The pea also wobbles the pitch slightly.
    const vib = ctx.createOscillator();
    vib.frequency.value = trem.frequency.value;
    const vg = ctx.createGain();
    vg.gain.value = 45;
    vib.connect(vg);
    const pitch = 2850 + Math.random() * 120;
    const tones: OscillatorNode[] = [];
    for (const f of [pitch, pitch * 1.085]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      vg.connect(o.frequency);
      o.connect(g);
      tones.push(o);
    }
    // A breathy edge on the attack.
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3000;
    hp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(peak * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    n.connect(hp).connect(ng).connect(this.fx);
    n.start(t, Math.random()); n.stop(t + 0.08);
    g.connect(this.fx);
    for (const x of [...tones, trem, vib]) { x.start(t); x.stop(t + len + 0.02); }
  }

  /**
   * A shot is struck: the whole crowd draws breath and rises for a second, so the reaction that
   * follows (roar, ooh or gasp) grows out of the stadium rather than starting from nothing.
   */
  anticipate() {
    const ctx = this.ctx;
    if (!ctx || !this.surge) return;
    const t = ctx.currentTime;
    this.surge.gain.cancelScheduledValues(t);
    this.surge.gain.setTargetAtTime(1.9, t, 0.18);
    this.surge.gain.setTargetAtTime(1, t + 1.1, 0.7);
  }

  /** Ball into the net: the rustle and thud of the net, then the roar. */
  net(x = 0) {
    if (this.play('net', this.fx, 0.9, { x, dur: 2.5, fade: 0.25 })) return;
    this.kick(14, x, 'touch');
  }

  /** Two bodies bumping (solid bodies, 20 Nov 2026): a soft, low thud, louder for a harder hit (k 0..1). */
  bump(x = 0, k = 0.5) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.pan(x)).connect(this.fx);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, now);
    o.frequency.exponentialRampToValueAtTime(55, now + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.08 + 0.14 * Math.min(1, k), now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    o.connect(og).connect(out);
    o.start(now); o.stop(now + 0.17);
  }

  /** Two players colliding in a tackle: a dull thud and a scuff of studs on grass. */
  tackle(x = 0, hard = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.pan(x)).connect(this.fx);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(hard ? 95 : 120, now);
    o.frequency.exponentialRampToValueAtTime(45, now + 0.14);
    const og = ctx.createGain();
    og.gain.setValueAtTime(hard ? 0.5 : 0.3, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    o.connect(og).connect(out);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.linearRampToValueAtTime(hard ? 0.22 : 0.12, now + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.001, now + (hard ? 0.35 : 0.2));
    n.connect(bp).connect(ng).connect(out);
    o.start(now); o.stop(now + 0.2);
    n.start(now, Math.random()); n.stop(now + 0.4);
  }

  /**
   * Crowd reaction: 'ooh' for near misses, 'gasp' for big saves and chances, a roar for goals,
   * boos for fouls and cards, applause at kick-off and the breaks. Recorded where available.
   */
  react(kind: 'ooh' | 'gasp' | 'goal' | 'groan' | 'boo' | 'applause') {
    const ctx = this.ctx;
    if (!ctx) return;
    const lvl = 0.75 + 0.5 * Math.min(1, Math.max(0.3, this.crowdTarget));
    switch (kind) {
      case 'goal': if (this.play('goal', this.crowdBus, 1.0 * lvl, { dur: 9, fade: 1.2 })) return; break;
      case 'ooh': case 'groan': {
        const k: SampleName = this.samples.ooh2 && Math.random() < 0.5 ? 'ooh2' : 'ooh';
        if (this.play(k, this.crowdBus, 0.9 * lvl, { fade: 0.3, rate: 0.96 + Math.random() * 0.08 })) return;
        break;
      }
      case 'gasp': if (this.play('gasp', this.crowdBus, 0.85 * lvl, { fade: 0.3, rate: 0.96 + Math.random() * 0.08 }) || this.play('ooh', this.crowdBus, 0.7 * lvl, { fade: 0.3 })) return; break;
      case 'boo': if (this.play('boo', this.crowdBus, 0.55 * lvl, { dur: 3, fade: 0.4 })) return; return; // no synthesised boo
      case 'applause': if (this.play('applause', this.crowdBus, 0.6 * lvl, { offset: Math.random() * 14, dur: 7, fade: 0.8 })) return; return;
    }
    // Not loaded (yet): stay quiet. A synthesised burst of noise in its place sounded like white noise on phones.
  }

  click() {
    this.ui('select');
  }

  /**
   * A firework: the whoosh of the rocket, then a bang with crackle (synthesised, on the effects
   * level, far away so it sits behind the crowd). delay in seconds.
   */
  firework(delay = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.pan((Math.random() - 0.5) * 30)).connect(this.fx);
    // Whoosh up.
    const w = ctx.createBufferSource(); w.buffer = this.noise;
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 3;
    wf.frequency.setValueAtTime(900, t0); wf.frequency.exponentialRampToValueAtTime(3200, t0 + 0.5);
    const wg = ctx.createGain(); wg.gain.setValueAtTime(0.0001, t0); wg.gain.linearRampToValueAtTime(0.12, t0 + 0.35); wg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
    w.connect(wf).connect(wg).connect(out); w.start(t0, Math.random()); w.stop(t0 + 0.6);
    // Bang.
    const tb = t0 + 0.55;
    const b = ctx.createBufferSource(); b.buffer = this.noise;
    const bf = ctx.createBiquadFilter(); bf.type = 'lowpass'; bf.frequency.setValueAtTime(1600, tb); bf.frequency.exponentialRampToValueAtTime(180, tb + 0.5);
    const bg = ctx.createGain(); bg.gain.setValueAtTime(0.0001, tb); bg.gain.linearRampToValueAtTime(0.7, tb + 0.01); bg.gain.exponentialRampToValueAtTime(0.001, tb + 0.9);
    b.connect(bf).connect(bg).connect(out); b.start(tb, Math.random()); b.stop(tb + 1);
    // Crackle: short ticks as the sparks burn out.
    for (let i = 0; i < 14; i++) {
      const tc = tb + 0.25 + Math.random() * 1.3;
      const c = ctx.createBufferSource(); c.buffer = this.noise;
      const cf = ctx.createBiquadFilter(); cf.type = 'highpass'; cf.frequency.value = 2500;
      const cg = ctx.createGain(); cg.gain.setValueAtTime(0.0001, tc); cg.gain.linearRampToValueAtTime(0.09, tc + 0.004); cg.gain.exponentialRampToValueAtTime(0.001, tc + 0.05);
      c.connect(cf).connect(cg).connect(out); c.start(tc, Math.random()); c.stop(tc + 0.06);
    }
  }

  /** A short cheer from the stands (the announcer naming a home player). */
  cheer(gain = 0.5) {
    this.play('applause', this.crowdBus, gain, { offset: Math.random() * 14, dur: 2.6, fade: 0.5, rate: 0.97 + Math.random() * 0.06 });
  }

  private menuSfx: MenuSfx | null = null;
  /** A menu sound (Settings > Audio > Menu sounds), on the effects level. */
  /** Both nations' anthems, one after the other (World tournament, before kick-off). */
  anthems(ids: string[]) {
    if (!this.ctx || !this.fx) return;
    let at = this.ctx.currentTime + 0.4;
    for (const id of ids) at = playAnthem(this.ctx, this.fx, id, at) + 0.8;
  }

  ui(kind: MenuSound) {
    const ctx = this.ctx;
    if (!ctx || this.settings.menuSounds === false) return;
    this.menuSfx ??= new MenuSfx(ctx, this.fx, this.noise);
    this.menuSfx.play(kind);
  }

  /** Control switched to another of your players (Settings > Switch flash and sound), on the effects level. */
  switchCue(manual: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.menuSfx ??= new MenuSfx(ctx, this.fx, this.noise);
    this.menuSfx.switchCue(manual);
  }

  /** A floodlight bank switching on (match intro), panned towards it. */
  floodlight(pan = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.menuSfx ??= new MenuSfx(ctx, this.fx, this.noise);
    this.menuSfx.clunk(pan);
  }

  suspend() {
    void this.ctx?.suspend();
    this.musicEl?.pause();
  }
  resume() {
    void this.ctx?.resume();
    if (this.musicWanted && this.musicEl?.paused) void this.musicEl.play().catch(() => {});
  }
}

/** decodeAudioData with the callback form too (older Safari returns no promise from it). */
function decode(ctx: AudioContext, buf: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((ok, fail) => {
    const p = ctx.decodeAudioData(buf, ok, fail) as Promise<AudioBuffer> | undefined;
    p?.catch?.(fail);
  });
}
