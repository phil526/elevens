// The match commentator (19 Nov 2026): lines from shared/commentary.ts for what happens in the
// match, spoken with the browser's speech voice and/or shown as captions along the bottom of the
// screen. Settings > Audio > Commentary chooses Voice and captions, Captions only, or Off.

import { PITCH } from '../shared/config';
import { Commentary, type CommentaryContext, type CommentaryLine } from '../shared/commentary';
import type { MatchEvent } from '../shared/types';
import { pickVoice } from './audio/announcer';
import type { ViewState } from './view';

export type CommentaryMode = 'voice' | 'captions' | 'off';

export function viewContext(v: ViewState, now: number): CommentaryContext {
  const b = v.ball;
  const owner = b.owner >= 0 ? v.players[b.owner] : null;
  return {
    teams: [v.teams[0].name, v.teams[1].name],
    name: (id) => v.players[id]?.def.short ?? '',
    team: (id) => v.players[id]?.team ?? -1,
    score: [v.score[0], v.score[1]],
    minute: Math.floor(v.clock / 60) + 1,
    half: v.half,
    phase: v.phase,
    possession: owner ? owner.team : -1,
    carrier: owner ? owner.id : -1,
    progress: owner ? (b.pos.x * v.attackDir[owner.team]) / PITCH.halfLength : 0,
    now,
    weather: v.weather?.kind,
    shootout: !!v.shootout,
    goalsBy: (id) => v.goals.filter((g) => g.player === id && !g.ownGoal).length,
  };
}

export class Commentator {
  private c = new Commentary((Math.random() * 2 ** 31) | 0);
  private el: HTMLElement;
  private hideAt = 0;
  private t = 0;
  private voice: SpeechSynthesisVoice | null = null;
  mode: CommentaryMode = 'captions';
  volume = 1;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'commentary-cap';
    this.el.setAttribute('aria-live', 'polite');
    host.appendChild(this.el);
    if (typeof speechSynthesis !== 'undefined') {
      const load = () => { this.voice = pickVoice(speechSynthesis.getVoices()); };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  /** A new match. */
  reset() {
    this.c = new Commentary((Math.random() * 2 ** 31) | 0);
    this.t = 0;
    this.hide();
    this.silence();
  }

  /** Per frame while a match is on screen; `live` false while a replay or menu covers it. */
  frame(v: ViewState, evs: MatchEvent[], dt: number, live: boolean) {
    this.t += dt;
    if (this.mode === 'off') { if (evs.length) this.c.feed(evs, viewContext(v, this.t)); return; }
    const lines = this.c.feed(evs, viewContext(v, this.t));
    if (live) for (const l of lines) this.say(l);
    if (this.hideAt && this.t > this.hideAt) this.hide();
  }

  private say(l: CommentaryLine) {
    if (!l.text) return;
    this.el.textContent = l.text;
    this.el.classList.add('show');
    this.hideAt = this.t + 1.8 + l.text.split(/\s+/).length / 2.6;
    if (this.mode !== 'voice' || typeof speechSynthesis === 'undefined') return;
    try {
      // A goal or a red card cuts in; anything else waits its turn (the pacing keeps that rare).
      if (l.priority >= 7) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(l.text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice?.lang ?? 'en-GB';
      u.rate = l.priority >= 9 ? 1.15 : 1.05;
      u.pitch = l.priority >= 9 ? 1.1 : 1;
      u.volume = Math.max(0, Math.min(1, this.volume));
      speechSynthesis.speak(u);
    } catch { /* no speech on this device */ }
  }

  hide() {
    this.el.classList.remove('show');
    this.hideAt = 0;
  }

  silence() {
    try { if (typeof speechSynthesis !== 'undefined' && this.mode === 'voice') speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}
