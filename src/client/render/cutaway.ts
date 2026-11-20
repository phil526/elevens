// TV cutaways at stoppages (Settings > Camera "TV cutaways", default on; offline matches only).
//
// When play stops soon after a near miss, the woodwork, a big save, a booking or a bad foul, the
// picture cuts away for a few seconds the way a TV director does: a close-up of the player who
// missed (head in hands), was booked or made the save, then his manager on the touchline or the
// fans behind the goal. The match waits while it shows, and any button skips it. The reactions
// themselves are the ones render/reactions.ts and render/managers.ts already play.

import type { ViewState } from '../view';

/** Timing (seconds). `cooldown` is live play between cutaways; `window` how long after the moment play must stop. */
export const CUTAWAY = { delay: 0.7, window: 5, cooldown: 50, firstAfter: 25, shot: 1.75, fade: 0.22, pushIn: 0.35 } as const;

export type CutTrigger = 'miss' | 'woodwork' | 'save' | 'card' | 'foul';

/** How likely each moment is to get a cutaway (when the cooldown allows one). */
export const CUT_CHANCE: Record<CutTrigger, number> = { miss: 0.7, woodwork: 1, save: 0.55, card: 0.9, foul: 0.3 };

export type CutKind = 'player' | 'manager' | 'crowd';

export interface CutShot {
  kind: CutKind;
  /** Player id for a player shot. */
  id: number;
  /** Whose manager or supporters (and the player's team). */
  team: 0 | 1;
  /** Seconds. */
  len: number;
  /** Lower-third: the name, and a line under it. */
  name: string;
  line: string;
}

/**
 * The shots for a moment. `subject` is the player it is about (the shooter, the booked player, the
 * keeper who saved, the player who fouled); `rnd` 0..1 picks between the manager and the fans.
 */
export function planCutaway(trigger: CutTrigger, subject: number, view: Pick<ViewState, 'players' | 'teams'>, rnd: number): CutShot[] {
  const p = view.players[subject];
  if (!p || p.off) return [];
  const team = p.team;
  const club = view.teams[team]?.name ?? '';
  const other = (1 - team) as 0 | 1;
  const player = (line: string): CutShot => ({ kind: 'player', id: subject, team, len: CUTAWAY.shot, name: p.def.name, line });
  const manager = (t: 0 | 1, line: string): CutShot => ({ kind: 'manager', id: -1, team: t, len: CUTAWAY.shot, name: 'Manager', line: `${view.teams[t]?.name ?? ''} · ${line}` });
  const fans = (t: 0 | 1, line: string): CutShot => ({ kind: 'crowd', id: -1, team: t, len: CUTAWAY.shot, name: view.teams[t]?.name ?? '', line });
  switch (trigger) {
    case 'miss':
      return [player(`${club} · so close`), rnd < 0.55 ? manager(team, 'can’t believe it') : fans(team, 'the fans can’t believe it')];
    case 'woodwork':
      return [player(`${club} · off the woodwork`), rnd < 0.5 ? fans(team, 'so close') : manager(team, 'so close')];
    case 'save':
      return [player(`${club} · what a save`), manager(other, 'denied')];
    case 'card':
      return [player(`${club} · booked`), manager(team, 'not happy')];
    case 'foul':
      return [player(`${club} · gives away a free kick`)];
  }
}

/** Total length of a plan. */
export function cutawayLength(shots: CutShot[]): number {
  return shots.reduce((s, x) => s + x.len, 0);
}

/** The shot playing `t` seconds in, and how far into it (0..1). */
export function cutawayAt(shots: CutShot[], t: number): { shot: CutShot; i: number; k: number } | null {
  let at = 0;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (t < at + s.len) return { shot: s, i, k: (t - at) / s.len };
    at += s.len;
  }
  return null;
}

/**
 * Decides when a cutaway is due. Moments come in from the match events; a cutaway starts once
 * play has stopped (any restart) within the window after the moment, not too soon after the last.
 */
export class CutawayDirector {
  private pending: { trigger: CutTrigger; subject: number; at: number } | null = null;
  private last = -1e9;
  /** Random numbers (tests can replace it). */
  rand: () => number = Math.random;

  reset() {
    this.pending = null;
    this.last = -1e9;
  }

  /** A moment worth a cutaway happened at live time `now`. Stronger moments replace weaker pending ones. */
  note(trigger: CutTrigger, subject: number, now: number) {
    if (subject < 0) return;
    const rank: Record<CutTrigger, number> = { foul: 0, save: 1, miss: 2, card: 3, woodwork: 4 };
    if (this.pending && now - this.pending.at < CUTAWAY.window && rank[this.pending.trigger] > rank[trigger]) return;
    this.pending = { trigger, subject, at: now };
  }

  /** A goal: no cutaway for what came before it (the celebration and replay take over). */
  cancel() {
    this.pending = null;
  }

  /**
   * Called each frame with live time (seconds of play since kick-off) and whether play has
   * stopped. Returns the moment to show now, or null.
   */
  due(now: number, stopped: boolean): { trigger: CutTrigger; subject: number } | null {
    const p = this.pending;
    if (!p) return null;
    if (now - p.at > CUTAWAY.window) { this.pending = null; return null; }
    if (!stopped || now - p.at < CUTAWAY.delay) return null;
    this.pending = null;
    if (now < CUTAWAY.firstAfter || now - this.last < CUTAWAY.cooldown) return null;
    if (this.rand() >= CUT_CHANCE[p.trigger]) return null;
    this.last = now;
    return { trigger: p.trigger, subject: p.subject };
  }
}
