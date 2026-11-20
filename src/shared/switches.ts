// On/off switches for the 19 Nov 2026 gameplay features, so a benchmark can measure each one
// against the rest (`G6_OFF=styles,keeper npx tsx scripts/bench-features.ts ...`). All on in play.
export const G6 = { styles: true, keeper: true, deflect: true, duels: true, momentum: true, aiShots: true, aiFoul: true, aiTrap: true, aiSkills: true };
export type G6Key = keyof typeof G6;
/** Turn features off by name (comma-separated), e.g. from an environment variable in a script. */
export function g6Off(list: string | undefined) {
  for (const k of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (k in G6) G6[k as G6Key] = false;
}

// Ball control (19 Nov 2026): `BC_OFF=attr,heavy` in the benches. attr = better control turns tighter and
// keeps the ball closer (every player, AI too); heavy = heavy touches for weaker players (AI too). The others
// only change what a human does with the ball.
export const BC = { close: true, gentle: true, touch: true, sole: true, chops: true, attr: true, heavy: true, chest: true, flicks: true };
export type BCKey = keyof typeof BC;
export function bcOff(list: string | undefined) {
  for (const k of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (k in BC) BC[k as BCKey] = false;
}
