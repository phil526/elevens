// Match highlights: the big moments of a match (goals, the woodwork, saves and near misses)
// are kept as short clips of recorded play while the match runs, then shown as a reel at
// half-time and full-time (offline). This file keeps the moments and picks the reel; the
// CineDirector (cine.ts) plays it.

import type { ReplayRecorder } from './render/cinematic';

export type MomentKind = 'goal' | 'woodwork' | 'save' | 'chance';

/** What a moment is worth when the reel is too long: goals always make it. */
export const MOMENT_RANK: Record<MomentKind, number> = { goal: 4, woodwork: 3, save: 2, chance: 1 };

export const HIGHLIGHTS = {
  before: 4.6, // seconds of build-up before the moment
  after: 1.8, // and after it
  goalAfter: 2.4, // a goal keeps a little of the celebration
  merge: 4.5, // moments this close together are one clip (a save, then the rebound goal)
  maxClip: 11, // longest clip, seconds
  halfMax: 6, // clips in a half-time reel
  fullMax: 10, // clips in a full-time reel
};

/** What the director is told when something happens. */
export interface MomentInfo {
  kind: MomentKind;
  team: number; // the attacking team
  who: string; // the scorer / shooter, or the keeper for a save
  minute: string; // as shown on the clock, e.g. 23' or 45+1'
  half: number;
}

export interface Highlight extends MomentInfo {
  /** Recorder time of the moment itself. */
  t: number;
  clip: ReplayRecorder;
}

interface Pending extends MomentInfo { t: number; t0: number }

/** Collects moments as they happen and cuts them out of the live recording once they are over. */
export class HighlightBook {
  list: Highlight[] = [];
  private pending: Pending[] = [];

  clear() {
    this.list = [];
    this.pending = [];
  }

  /** Something happened at recorder time t. Close moments merge into one clip (the bigger one names it). */
  add(m: MomentInfo, t: number) {
    const p = this.pending.find((x) => t - x.t < HIGHLIGHTS.merge);
    if (p) {
      if (MOMENT_RANK[m.kind] >= MOMENT_RANK[p.kind]) Object.assign(p, m, { t });
      return;
    }
    // Already cut, but a bigger moment followed straight after (the rebound goes in): replace it.
    const last = this.list[this.list.length - 1];
    if (last && last.half === m.half && t - last.t < HIGHLIGHTS.merge) {
      if (MOMENT_RANK[m.kind] <= MOMENT_RANK[last.kind]) return;
      this.list.pop();
      this.pending.push({ ...m, t, t0: Math.max(last.clip.first, t - HIGHLIGHTS.maxClip + HIGHLIGHTS.goalAfter) });
      return;
    }
    this.pending.push({ ...m, t, t0: t - HIGHLIGHTS.before });
  }

  /** Cut every moment that is over by recorder time `now` (or all of them, at a break). */
  capture(rec: ReplayRecorder, now: number, all = false) {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      const end = p.t + (p.kind === 'goal' ? HIGHLIGHTS.goalAfter : HIGHLIGHTS.after);
      if (!all && now < end) continue;
      this.pending.splice(i--, 1);
      const t0 = Math.max(p.t0, end - HIGHLIGHTS.maxClip);
      const clip = rec.slice(t0, end);
      if (clip.length < 10) continue; // nothing recorded (skipped straight to the break)
      const { t: _t, t0: _t0, ...info } = p;
      this.list.push({ ...info, t: p.t, clip });
    }
  }

  /** The reel: the half's moments at half-time, the whole match at full time. */
  reel(scope: 'half' | 'match', half: number): Highlight[] {
    return pickReel(scope === 'half' ? this.list.filter((h) => h.half === half) : this.list, scope === 'half' ? HIGHLIGHTS.halfMax : HIGHLIGHTS.fullMax);
  }
}

/** Every goal, then the best of the rest (later ones first on a tie), shown in match order. */
export function pickReel<T extends { kind: MomentKind; t: number }>(all: T[], max: number): T[] {
  const goals = all.filter((h) => h.kind === 'goal');
  const rest = all.filter((h) => h.kind !== 'goal').sort((a, b) => MOMENT_RANK[b.kind] - MOMENT_RANK[a.kind] || b.t - a.t);
  return [...goals, ...rest.slice(0, Math.max(0, max - goals.length))].sort((a, b) => a.t - b.t);
}

export const MOMENT_TITLE: Record<MomentKind, string> = { goal: 'Goal', woodwork: 'Off the woodwork', save: 'Saved', chance: 'Chance' };
