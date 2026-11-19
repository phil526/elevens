import type { Tactics } from '../../shared/teams';
import type { GamePlan, Mentality } from '../../shared/config';
import type { MatchEvent } from '../../shared/types';
import type { ViewState } from '../view';

export interface ConnInfo {
  show: boolean;
  state: string;
  latency: number;
  colour: string;
}

/** A running match, local or online, as seen by the app shell. */
export interface Session {
  kind: 'offline' | 'online';
  localTeams: number[];
  update(dt: number, now: number): void;
  view(): ViewState | null;
  drainEvents(): MatchEvent[];
  attacking(): boolean;
  setMentality(m: Mentality): void;
  setTactics(t: Tactics): void;
  /** Live tactics: the side's game plan, changed during the match. */
  setPlan(p: GamePlan): void;
  /** Player instructions for the local side, by slot: -1 stay back, 0 normal, 1 get forward. */
  setInstruction(slot: number, v: number): void;
  instructions(): number[];
  /** Ask for a substitution (made at the next stoppage). Offline returns whether it was accepted; online it is sent to the server. */
  requestSub(id: number, bench: number): boolean;
  conn(): ConnInfo | null;
  dispose(): void;
  debugText(): string;
}
