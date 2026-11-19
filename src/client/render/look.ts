// Per-player looks that are fixed for a player and identical on every machine: height and
// build by position, boot colour, and which player wears the captain's armband.

import type { PlayerDef, Role, TeamDef } from '../../shared/teams';

/** Stable 0..1 value from a string (FNV-1a). */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

/**
 * Height and breadth multipliers (1 = the 1.8 m model). Keepers and centre-backs are tall and
 * broad, wingers slighter, everyone else spread around the middle. Roughly 1.67 m to 1.93 m.
 */
export function playerBuild(def: Pick<PlayerDef, 'name' | 'role'>): { h: number; w: number } {
  const u = hash01(def.name, 1), v = hash01(def.name, 2);
  const r: Role = def.role;
  const [h0, hs, w0, ws] =
    r === 'GK' ? [1.03, 0.04, 1.02, 0.04]
    : r === 'RCB' || r === 'LCB' ? [1.01, 0.05, 1.03, 0.05]
    : r === 'ST' ? [0.98, 0.06, 1.0, 0.06]
    : r === 'RW' || r === 'LW' ? [0.93, 0.05, 0.94, 0.04]
    : [0.95, 0.07, 0.96, 0.06];
  const h = h0 + hs * u;
  // Breadth follows height a little, plus its own spread.
  const w = w0 + ws * v + (h - 1) * 0.3;
  return { h: Math.round(h * 1000) / 1000, w: Math.round(w * 1000) / 1000 };
}

/** Boot colours footballers actually wear. */
export const BOOTS = [0x15161a, 0xf4f4f2, 0xe8f23a, 0xff5a1f, 0x2b6cf0, 0xd8193a, 0x15161a, 0xf4f4f2];

export function bootColour(def: Pick<PlayerDef, 'name'>): number {
  return BOOTS[Math.floor(hash01(def.name, 3) * BOOTS.length)];
}

/** The captain: the starting outfielder with the best all-round attributes. */
export function captainIndex(team: TeamDef): number {
  let best = -1, score = -1;
  team.players.forEach((p, i) => {
    if (p.role === 'GK' || i > 10) return;
    const a = p.attrs;
    const s = a.pace + a.acceleration + a.stamina + a.control + a.passing + a.shooting + a.tackling;
    if (s > score) { score = s; best = i; }
  });
  return best;
}

/** Relative luminance of a 0xRRGGBB colour (0..1). */
export function luma(c: number): number {
  return (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
}

/** A colour that reads on `bg`: the preferred one if it contrasts enough, else near-black or white. */
export function readableOn(bg: number, preferred: number): number {
  if (Math.abs(luma(bg) - luma(preferred)) > 0.3) return preferred;
  return luma(bg) > 0.5 ? 0x141414 : 0xf6f6f6;
}
