import { describe, it, expect } from 'vitest';
import { aiMatch, toOpenPlay } from './helpers';
import { PITCH } from '../src/shared/config';
import type { Match } from '../src/shared/match';

type Award = { award: (type: string, team: number, spot: { x: number; z: number }) => void; goalKickSpot: (team: number, z: number) => { x: number; z: number } };

/** Opponents (of the goal-kick team) standing inside the goal-kick team's penalty area. */
function inBox(m: Match, team: number) {
  return m.teamPlayers(1 - team).filter((p) => !p.off && m.inPenaltyArea(team, p.pos));
}

describe('goal kicks', () => {
  for (const [humans, team] of [[[true, false], 0], [[false, false], 1], [[false, true], 1]] as const) {
    it(`opponents leave the penalty area before the kick (humans ${humans}, team ${team})`, () => {
      const m = aiMatch({ humans: [...humans] as [boolean, boolean] });
      toOpenPlay(m);
      const gx = m.ownGoalX(team);
      const dir = m.attackDir(team);
      // Park several opponents deep in the box, away from the kick spot.
      const opp = m.teamPlayers(1 - team).filter((p) => p.role !== 'GK').slice(0, 4);
      opp.forEach((p, i) => { p.pos = { x: gx + dir * (2 + i * 3), z: -8 + i * 1.5 }; p.vel = { x: 0, z: 0 }; });
      const a = m as unknown as Award;
      a.award('goalkick', team, a.goalKickSpot(team, 1));
      let checked = false;
      for (let i = 0; i < 60 * 12 && m.phase === 'restart'; i++) {
        m.step();
        if (m.restart?.ready && !checked) { checked = true; expect(inBox(m, team).map((p) => p.role)).toEqual([]); }
        if (m.restart?.ready) expect(inBox(m, team).length).toBe(0);
      }
      expect(checked).toBe(true);
    });
  }

  it('opponents leave the area while a keeper holds the ball after a save', () => {
    for (const team of [0, 1]) {
      const m = aiMatch({ humans: [team === 0, team === 1] });
      toOpenPlay(m);
      const gk = m.keeper(team);
      const gx = m.ownGoalX(team);
      const dir = m.attackDir(team);
      gk.pos = { x: gx + dir * 4, z: 0 };
      const opp = m.teamPlayers(1 - team).filter((p) => p.role !== 'GK' && !m.isHumanControlled(p)).slice(0, 4);
      opp.forEach((p, i) => { p.pos = { x: gx + dir * (6 + i * 2.5), z: -6 + i * 4 }; p.vel = { x: 0, z: 0 }; });
      for (const p of m.teamPlayers(team)) if (p !== gk) p.pos = { x: gx + dir * 40, z: p.pos.z };
      const b = m.ball;
      b.state = 'held'; b.owner = gk.id; b.lastTouch = gk.id; b.lastTouchTeam = team; b.vel = { x: 0, y: 0, z: 0 };
      (m as unknown as { holdT: number }).holdT = 0;
      // A human keeper holds it for up to 3.5 s before the computer releases it.
      for (let i = 0; i < 60 * 3 && b.state === 'held'; i++) m.step();
      expect(b.state).toBe('held');
      expect(inBox(m, team).map((p) => p.role)).toEqual([]);
    }
  });
});

