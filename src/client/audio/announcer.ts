// Stadium announcer: welcomes everyone during the match intro and reads the line-ups while
// the TV line-ups are on screen: the visitors briskly, then the home side one name at a time
// with the crowd cheering. Uses the browser's speech voices (an English voice, British if the
// device has one), so it needs no files and can say any club or player. Settings > Audio >
// Stadium announcer turns it off.
//
// Speech can't go through Web Audio, so the volume follows the master level here, and the
// first (silent) line is spoken from a tap or key press: iPad Safari only speaks after one.

export interface AnnounceTeam { name: string; players: { number: number; name: string; role: string }[]; captain?: string }

export type MatchTimeOfDay = 'day' | 'dusk' | 'night';

/** Voices that sound most like a PA announcer, best first (names differ per device). */
const PREFERRED = [/natural/i, /online/i, /google uk english male/i, /daniel/i, /arthur/i, /ryan/i, /george/i, /oliver/i, /thomas/i, /google uk english/i, /male/i];

export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang) || v.lang === 'en');
  const gb = en.filter((v) => /gb|uk/i.test(v.lang));
  for (const pool of [gb, en]) {
    for (const re of PREFERRED) {
      const v = pool.find((x) => re.test(x.name));
      if (v) return v;
    }
    if (pool.length) return pool.find((v) => v.localService) ?? pool[0];
  }
  return null;
}

/** "Good evening" for a night match, and so on. */
export function greeting(t: MatchTimeOfDay): string {
  return t === 'day' ? 'Good afternoon' : 'Good evening';
}

/** The welcome during the stadium fly-in. */
export function welcomeLines(home: string, away: string, venue: string, t: MatchTimeOfDay): string[] {
  return [`${greeting(t)}, ladies and gentlemen, and welcome to ${venue}.`, `${t === 'day' ? "This afternoon's" : "Tonight's"} match: ${home}, against ${away}.`];
}

/** The line-ups as the announcer reads them: [text, cheer after it?]. */
export function lineupLines(home: AnnounceTeam, away: AnnounceTeam): [string, boolean][] {
  const order = (t: AnnounceTeam) => t.players.slice(0, 11);
  const out: [string, boolean][] = [];
  const awayNames = order(away).map((p) => `${p.number}, ${p.name}`).join('. ');
  out.push([`The visitors, ${away.name}. ${awayNames}.`, false]);
  out.push([`And now, your ${home.name} team!`, true]);
  for (const p of order(home)) out.push([`Number ${p.number}${p.role === 'GK' ? ', in goal' : ''}${home.captain === p.name ? ', your captain' : ''}: ${p.name}!`, true]);
  return out;
}

/** Splits a long line at sentence ends into pieces of at most about 90 characters. */
export function splitLine(text: string, max = 90): string[] {
  if (text.length <= max) return [text];
  const parts = text.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length + p.length + 1 <= max) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

export class Announcer {
  enabled = true;
  /** 0..1, from the master volume (and mute). */
  volume = 0.8;
  /** Called as a line starts: `cheer` lines get a roar from the home end. */
  onLine: ((cheer: boolean) => void) | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private primed = false;
  private queue = 0;
  private synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

  constructor() {
    const s = this.synth;
    if (!s) return;
    const load = () => { this.voice = pickVoice(s.getVoices()); };
    load();
    s.addEventListener?.('voiceschanged', load);
  }

  get voiceName(): string {
    if (!this.voice && this.synth) this.voice = pickVoice(this.synth.getVoices());
    return this.voice?.name ?? 'default voice';
  }

  get available() {
    return !!this.synth;
  }

  /** Speech has been heard to start at least once (the device and page can speak). */
  works = false;
  /** Why the announcer is quiet, when we know (shown in Settings). */
  problem = '';
  /** When the last cancel happened: Safari and Chrome drop a line spoken straight after one. */
  private cancelledAt = -1e9;
  /** Utterances being spoken, kept referenced (Chrome stops firing their events if they are collected). */
  private live: SpeechSynthesisUtterance[] = [];

  /**
   * Call from a tap, click or key press (a touchend/click on iPad: a pointerdown doesn't count
   * as a gesture there). iOS only lets a page speak after it has spoken from a gesture, so a
   * silent line is spoken from each gesture until one is heard to start.
   */
  prime() {
    if (this.primed || !this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance('.');
      u.volume = 0;
      u.rate = 2;
      if (this.voice) u.voice = this.voice;
      u.onstart = () => { this.primed = true; this.works = true; };
      u.onend = () => { this.primed = true; this.live = this.live.filter((x) => x !== u); };
      this.live.push(u);
      this.synth.resume();
      this.synth.speak(u);
    } catch { /* no speech: the announcer stays quiet */ }
  }

  private utter(text: string, volume: number): SpeechSynthesisUtterance {
    const u = new SpeechSynthesisUtterance(text);
    if (!this.voice && this.synth) this.voice = pickVoice(this.synth.getVoices());
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-GB';
    u.rate = 0.98;
    u.pitch = 0.88;
    u.volume = Math.min(1, Math.max(0, volume));
    return u;
  }

  /** "Testing, testing": spoken straight from the Settings button (a gesture), so it also unlocks speech. */
  test(): Promise<boolean> {
    const s = this.synth;
    if (!s) { this.problem = 'This browser has no speech.'; return Promise.resolve(false); }
    this.stop();
    return new Promise((ok) => {
      const u = this.utter('Testing, testing. This is your stadium announcer.', Math.max(0.6, this.volume));
      let started = false;
      u.onstart = () => { started = true; this.works = true; this.primed = true; this.problem = ''; };
      u.onend = () => { this.live = this.live.filter((x) => x !== u); ok(started); };
      u.onerror = (e) => { this.problem = `Speech error: ${(e as SpeechSynthesisErrorEvent).error ?? 'unknown'}`; ok(false); };
      this.live.push(u);
      s.resume();
      s.speak(u);
      setTimeout(() => { if (!started) { this.problem = this.problem || 'The device did not start speaking.'; ok(false); } }, 4000);
    });
  }

  /**
   * Lines spoken one after another (a PA voice: a touch slower and lower than normal speech),
   * each started when the one before ends. Resolves when the last ends, or is stopped.
   */
  say(lines: (string | [string, boolean])[]): Promise<void> {
    const s = this.synth;
    if (!s || !this.enabled || this.volume <= 0.01 || !lines.length) return Promise.resolve();
    // Long lines are split (Chrome cuts off anything longer than about 15 seconds).
    const list: [string, boolean][] = [];
    for (const l of lines) {
      const [text, cheer] = typeof l === 'string' ? [l, false] : l;
      for (const part of splitLine(text)) list.push([part, cheer && part === splitLine(text)[0]]);
    }
    const run = ++this.queue;
    const wait = Math.max(0, 300 - (performance.now() - this.cancelledAt));
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (run !== this.queue || i >= list.length) { resolve(); return; }
        const [text, cheer] = list[i++];
        const u = this.utter(text, this.volume);
        let done = false;
        const fin = () => { if (done) return; done = true; this.live = this.live.filter((x) => x !== u); next(); };
        u.onstart = () => { this.works = true; this.problem = ''; if (run === this.queue) this.onLine?.(cheer); };
        u.onend = fin;
        u.onerror = (e) => { const err = (e as SpeechSynthesisErrorEvent).error; if (err && err !== 'interrupted' && err !== 'canceled') this.problem = `Speech error: ${err}`; fin(); };
        this.live.push(u);
        try { s.resume(); s.speak(u); } catch { fin(); return; }
        // Nothing heard at all (speech blocked here): don't hold the line-ups waiting for it.
        setTimeout(() => { if (!done && !s.speaking && !s.pending) { if (!this.works) this.problem = 'The device did not start speaking.'; fin(); } }, 2500 + text.length * 120);
      };
      setTimeout(next, wait);
    });
  }

  /** Stop talking (skipped, paused or the match is over). */
  stop() {
    this.queue++;
    const s = this.synth;
    if (!s || (!s.speaking && !s.pending)) return;
    try { s.cancel(); } catch { /* ignore */ }
    this.cancelledAt = performance.now();
  }

  get speaking() {
    return !!this.synth?.speaking;
  }
}
