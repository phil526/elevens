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

// Auto-switching (20 Nov 2026), human control only: `SW_OFF=carry,guard` in the benches and tests.
// carry = after a switch the stick held for the old player is ignored (he closes down the ball) until
// moved or let go; guard = no auto-switch just after a challenge or while holding jockey/contain or
// sprinting at the ball; steady = a better defender must stay better for a moment; cycle = quick
// second switch press goes on to the next-best; setpiece = start on a box defender at their set
// pieces; read = the marker reads the pass being wound up; onscreen = prefer players near the ball
// (on screen); crosses = switch early to the defender under a cross.
export const SW = { carry: true, guard: true, steady: true, cycle: true, setpiece: true, read: true, onscreen: true, crosses: true };
export type SWKey = keyof typeof SW;
export function swOff(list: string | undefined) {
  for (const k of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (k in SW) SW[k as SWKey] = false;
}

/** Tuning for the auto-switch (seconds unless stated). */
export const SWITCH = {
  /** Longest the stick held before a switch is ignored (the new man closes down the ball meanwhile). */
  carryMax: 1.4,
  /** No auto-switch for this long after you press tackle, slide or contain. */
  guardAfter: 0.8,
  /** Extra margin while jockey or contain is held. */
  guardHold: 0.8,
  /** Extra margin while sprinting at the ball. */
  sprintChase: 0.5,
  /** A better defender must stay better this long before control moves (beaten / crosses: shorter). */
  steady: 0.25,
  steadyQuick: 0.05,
  /** The next-switch marker stays on its man unless another is this much (s) better. */
  nextKeep: 0.2,
  /** Presses closer together than this cycle on to the next-best player. */
  cycleWindow: 0.8,
  /** Players further than this (m, along the pitch) from the ball are probably off screen. */
  offscreen: 30,
  offscreenCost: 0.5,
  /** Crosses and long balls dropping near your goal: margin and cool-down. */
  crossThr: 0.45,
  crossCool: 0.3,
  crossRange: 26,
  /** Margin and cool-down multipliers for Calm, Normal and Eager. */
  sens: { calm: 1.45, normal: 1, eager: 0.7 } as Record<'calm' | 'normal' | 'eager', number>,
};

// On-pitch play (20 Nov 2026 evening): `P20_OFF=bodies,timing,habits` in the benches and tests.
// bodies = solid bodies (players can't run through each other: heavier, stronger and planted
// players give less ground and a runner loses the speed he carries into someone); timing = a
// standing tackle is won by timing it as the dribbler's touch goes out, not by a dice roll;
// habits = a computer side learns how a human team attacks over the match and adapts.
export const P20 = { bodies: true, timing: true, habits: true };
export type P20Key = keyof typeof P20;
export function p20Off(list: string | undefined) {
  for (const k of (list ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (k in P20) P20[k as P20Key] = false;
}
