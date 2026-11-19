// Every club's home ground: its name, how big it is and how it looks. The home side's ground is
// built for each match (client/render/arena.ts reads the style). All of them are made up.
//
// Sizes: 0 a compact ground (one tier, floodlight pylons), 1 a traditional two-tier ground, 2 a
// modern bowl (the original Harbourside Arena), 3 a huge arena with a towering upper tier.

import type { TeamDef } from './teams';

export type GroundSize = 0 | 1 | 2 | 3;

export interface GroundStyle {
  name: string;
  size: GroundSize;
  /** Seat colours: lower tier, upper tier. */
  seats: number;
  seats2: number;
  /** Roof (top side) and the outside cladding. */
  roof: number;
  cladding: number;
  /** Floodlights on the roof's front edge, or on four corner pylons. */
  lights: 'roof' | 'pylons';
  /** How full it is (1 = a sell-out). */
  fill: number;
}

export const GROUND_SIZE_NAMES = ['Compact ground', 'Traditional ground', 'Modern bowl', 'Super arena'] as const;

const mute = (c: number, k: number, to = 0x1b1f27) => {
  const mix = (s: number) => Math.round(((c >> s) & 255) * (1 - k) + ((to >> s) & 255) * k);
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
};

type Row = [name: string, size: GroundSize, lights: 'roof' | 'pylons', roof: number, seatScheme: 'club' | 'two' | 'neutral', fill: number];

/** The built-in clubs' grounds. */
export const GROUNDS: Record<string, Row> = {
  redmoor: ['The Harbourside Arena', 2, 'roof', 0x9aa0aa, 'neutral', 1],
  kestrel: ['Skyline Park', 3, 'roof', 0xe8ecf2, 'two', 1],
  ironbridge: ['Foundry Lane', 1, 'pylons', 0x6d737d, 'club', 0.92],
  northgate: ['Northgate Stadium', 2, 'roof', 0xcfd5dd, 'club', 0.95],
  saltmarsh: ['The Saltings', 1, 'pylons', 0x8b8f96, 'two', 0.9],
  harrowfield: ['Harrow Road', 1, 'roof', 0x5a6068, 'club', 0.93],
  valeforge: ['Anvil Park', 1, 'pylons', 0x7c8088, 'club', 0.88],
  portcalder: ['Calder Quay', 0, 'pylons', 0x4c535c, 'club', 0.86],
  kingsmere: ['The Crown Stadium', 3, 'roof', 0xdfe3ea, 'club', 1],
  stormhollow: ['Stormhollow Arena', 2, 'roof', 0x3b4048, 'two', 0.96],
  copperfield: ['Copper Meadow', 1, 'roof', 0x8a5a3a, 'club', 0.9],
  brackenridge: ['Ridgeway Park', 1, 'pylons', 0x58615a, 'two', 0.88],
  gullhaven: ['The Seafront Ground', 0, 'pylons', 0xe6e8ea, 'club', 0.9],
  emberton: ['The Furnace', 2, 'roof', 0x2e2622, 'club', 0.97],
  wexley: ['Riverside Stadium', 2, 'roof', 0xbfc6cf, 'two', 0.94],
  duskmoor: ['Moorgate Park', 1, 'roof', 0x30333a, 'club', 0.9],
  silverpine: ['Pine Lane', 0, 'pylons', 0xb9bec4, 'club', 0.85],
  larkspur: ['Meadowbank', 0, 'pylons', 0x9a9fb0, 'two', 0.84],
  oakhurst: ['Oak Street', 0, 'pylons', 0x5e4636, 'club', 0.9],
  highmarsh: ['Marsh Lane', 0, 'roof', 0x707680, 'club', 0.92],
};

function hashId(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

const ENDINGS = ['Park', 'Road', 'Lane', 'Stadium', 'Ground', 'Arena'] as const;

/** A club's home ground (built-in clubs from the table; your own clubs get one from their name). */
export function groundFor(team: TeamDef): GroundStyle {
  const h = hashId(team.id);
  const row: Row = GROUNDS[team.id] ?? (() => {
    const word = (team.name.split(' ')[0] || team.name).replace(/[^A-Za-z'-]/g, '') || 'Home';
    const end = ENDINGS[h % ENDINGS.length];
    const size = ((h >>> 3) % 3) as GroundSize;
    return [`${word} ${end}`, size, (h >>> 6) % 2 ? 'roof' : 'pylons', [0x9aa0aa, 0x5a6068, 0xdfe3ea][(h >>> 8) % 3], (['club', 'two', 'club'] as const)[(h >>> 10) % 3], 0.9];
  })();
  const [name, size, lights, roof, scheme, fill] = row;
  const k = team.home;
  const second = k.second && k.second !== k.shirt ? k.second : k.sleeves !== k.shirt ? k.sleeves : k.shorts !== k.shirt ? k.shorts : 0x2a2d35;
  const seats = scheme === 'neutral' ? 0x24428e : mute(k.shirt, 0.18);
  const seats2 = scheme === 'two' ? mute(second, 0.22) : seats;
  return { name, size, lights, roof, seats, seats2, cladding: mute(k.shirt, 0.72, 0x23262d), fill };
}

/** Short form for captions ("The Harbourside Arena" -> "the Harbourside Arena" mid-sentence). */
export function groundInSentence(name: string): string {
  return name.startsWith('The ') ? 'the ' + name.slice(4) : name;
}
