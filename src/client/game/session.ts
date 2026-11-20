import type { Tactics } from '../../shared/teams';
import type { GamePlan, Mentality } from '../../shared/config';
import type { MatchEvent } from '../../shared/types';
import type { ViewState } from '../view';

export interface ConnInfo {
  show: boolean;
  state: string;
  latency: number;
  colour: string;
  /** Signal strength 0-4 (online): from the round trip, how steady it is and missing updates. */
  bars?: number;
}

/** Signal bars for a connection: 4 is a quick, steady link; 1 is slow or patchy; 0 is no link. */
export function signalBars(latency: number, jitter: number, late: number): number {
  if (latency < 0) return 0;
  let b = latency < 70 ? 4 : latency < 120 ? 3 : latency < 200 ? 2 : 1;
  if (jitter > 30 || late > 0.15) b--;
  if (jitter > 60 || late > 0.35) b--;
  return Math.max(1, b);
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
