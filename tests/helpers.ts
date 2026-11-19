import { Match, defaultConfig } from '../src/shared/match';
import type { MatchConfig } from '../src/shared/types';

export function aiMatch(over: Partial<MatchConfig> = {}) {
  return new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 7, ...over }));
}

/** Step until open play has started (after the kick-off is taken). */
export function toOpenPlay(m: Match, max = 60 * 10) {
  for (let i = 0; i < max && m.phase !== 'play'; i++) m.step();
  if (m.phase !== 'play') throw new Error(`no open play (phase ${m.phase})`);
}

/** Park everyone far from (x, z) so nobody can touch a ball placed there. */
export function clearArea(m: Match, x: number, z: number, r = 20) {
  for (const p of m.players) {
    if (Math.hypot(p.pos.x - x, p.pos.z - z) < r) {
      p.pos = { x: x > 0 ? x - r - 5 : x + r + 5, z: 0 };
      p.vel = { x: 0, z: 0 };
    }
  }
}

/** Throw a free ball from (x, y, z) with velocity v, last touched by `team`. */
export function launch(m: Match, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, team: 0 | 1, flight: 'shot' | 'pass' = 'pass') {
  const b = m.ball;
  const toucher = m.teamPlayers(team).find((p) => p.role === 'RCM')!;
  b.pos = { ...pos };
  b.vel = { ...vel };
  b.spin = 0;
  b.state = 'flight';
  b.flight = flight;
  b.owner = -1;
  b.receiver = -1;
  b.lastTouch = toucher.id;
  b.lastTouchTeam = team;
  b.kicker = toucher.id;
  b.kickLock = 0;
}
