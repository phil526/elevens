// On/off switches for the 19 Nov 2026 gameplay features, so a benchmark can measure each one
// against the rest (`G6_OFF=styles,keeper npx tsx scripts/bench-features.ts ...`). All on in play.
export const G6 = { styles: true, keeper: true, deflect: true, duels: true, momentum: true, aiShots: true, aiFoul: true, aiTrap: true, aiSkills: true };
export type G6Key = keyof typeof G6;
/** Turn features off by name (comma-separated), e.g. from an environment variable in a script. */
export function g6Off(list: string | undefined) {
  for (const k of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (k in G6) G6[k as G6Key] = false;
}
