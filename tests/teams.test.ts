import { describe, expect, it } from 'vitest';
import { FORMATION_433, ROLES, TEAMS } from '../src/shared/teams';

describe('teams', () => {
  it('has exactly two fictional clubs of eleven', () => {
    expect(TEAMS).toHaveLength(2);
    for (const t of TEAMS) {
      expect(t.players).toHaveLength(11);
      expect(t.players.filter((p) => p.role === 'GK')).toHaveLength(1);
      expect(new Set(t.players.map((p) => p.number)).size).toBe(11);
      expect(new Set(t.players.map((p) => p.role))).toEqual(new Set(ROLES));
    }
  });
  it('keeps attributes in range', () => {
    for (const t of TEAMS) for (const p of t.players) for (const v of Object.values(p.attrs)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(99); }
  });
  it('places the 4-3-3 inside its own half at kick-off', () => {
    for (const r of ROLES) expect(FORMATION_433[r].x).toBeLessThanOrEqual(0);
  });
});
