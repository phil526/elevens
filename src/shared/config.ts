// Shared tuning constants. All distances are metres, times seconds, speeds m/s.

export const PITCH = {
  length: 105,
  width: 68,
  halfLength: 52.5,
  halfWidth: 34,
  goalWidth: 7.32,
  goalHalfWidth: 3.66,
  goalHeight: 2.44,
  goalDepth: 2.0,
  postRadius: 0.06,
  penaltyAreaDepth: 16.5,
  penaltyAreaHalfWidth: 20.16,
  goalAreaDepth: 5.5,
  goalAreaHalfWidth: 9.16,
  penaltySpot: 11,
  centreCircleRadius: 9.15,
  cornerArcRadius: 1,
} as const;

export const BALL = {
  radius: 0.11,
  gravity: 9.81,
  airDrag: 0.011, // quadratic drag coefficient per metre
  rollDecel: 2.2, // constant rolling friction deceleration on grass
  restitution: 0.55,
  bounceFriction: 0.86, // horizontal speed kept on each bounce
  restVy: 1.1, // below this vertical speed a bounce settles into rolling
  postRestitution: 0.62,
  netAbsorb: 0.18,
  spinDecay: 0.6,
  maxSubstep: 0.05, // never move the ball more than 5 cm in one sub-step
  maxSpeed: 38,
} as const;

export const SIM = {
  tickRate: 60,
  dt: 1 / 60,
  snapshotRate: 20,
  inputSendRate: 30,
} as const;

export const PLAYER = {
  radius: 0.36, // body circle used for player-player separation
  bodyHeight: 1.82,
  controlReach: 0.85, // horizontal distance at which a free ball can be controlled
  controlHeight: 1.0, // max ball height for a foot/chest control
  headerHeight: 2.45, // max ball height (centre) a jump header can reach
  touchCooldownBase: 0.34,
  kickWindup: 0.1, // pass wind-up before the ball leaves the boot
  shotWindup: 0.15,
  runupSpeed: 5.2, // set-piece run-up top speed (m/s); passes 82% of it
  runupAccel: 7,
  tackleReach: 1.6,
  tackleConeDeg: 70,
  tackleDuration: 0.42,
  tackleContactTime: 0.16,
  tackleRecovery: 0.9,
  stumbleTime: 0.65,
  // Shoulder barge: a standing tackle from alongside the carrier becomes a shoulder-to-shoulder challenge.
  bargeReach: 1.9, // carrier within this distance, level with the challenger
  bargeDuration: 0.4,
  bargeContactTime: 0.14,
  bargeRecovery: 0.8,
  shotChargeMax: 1.0,
  passChargeMax: 0.9, // seconds to fully charge a pass (a tap picks the near teammate, full the far one)
  jockeySpeed: 3.2,
  jockeyFastSpeed: 5.4, // jockey + sprint: shuffling quickly, still side-on
  jockeySetTime: 0.3, // seconds of jockeying before a standing tackle counts as well timed
  containStandoff: 2.1, // jockey with no stick: hold this far goal-side of the carrier

  walkSpeed: 1.8,
  // Slide tackle: a long, committed lunge along the facing direction.
  slideDuration: 0.7,
  slideContactFrom: 0.1,
  slideContactTo: 0.42,
  slideReach: 1.1, // ball or legs within this distance of the sliding boots
  slideSpeed: 7.5,
  slideDown: 0.9, // on the ground afterwards
  slideRecovery: 2.2,
  // Sprint burst and skill moves.
  burstTime: 0.7,
  burstCost: 0.045,
  burstMinStamina: 0.25,
  skillCooldown: 0.9,
  skillCost: 0.03,
  rouletteTime: 0.62,
  beatenTime: 0.55,
  // Free-kick wall: standing it covers the ball up to head height; a jump lifts the whole band.
  wallTop: 1.9,
  wallJump: 0.5, // height gained at the top of the jump (m)
  wallJumpTime: 0.62, // seconds in the air
  wallReach: 0.4, // ball centre within this distance of a body blocks it
} as const;

export const MATCH = {
  footballSecondsPerHalf: 45 * 60,
  defaultRealMinutes: 6 as number,
  allowedRealMinutes: [2, 4, 6, 8, 10] as readonly number[],
  goalCelebration: 3.2,
  teamPressTime: 5, // seconds the whole team presses after the call
  teamPressCooldown: 14,
  offsideTrapTime: 1.6, // seconds the back four step up
  offsideTrapCooldown: 8,
  kickoffSetup: 1.6,
  restartSetupMax: 3.0,
  humanRestartTimeout: 8,
  halftimePauseOnline: 10,
  halfEndGrace: 3,
  stuckBallSeconds: 10,
  keeperHoldMax: 6,
  freeKickDistance: 9.15,
  throwInDistance: 2,
  advantageTime: 2.5, // seconds the referee waits to see whether an advantage materialises
  timingPeriod: 1.4, // seconds for the set-piece timing ring to shrink and grow again
  calledRunTime: 2.6, // seconds a called run lasts
  oneTwoRunTime: 2.4, // seconds a passer runs on for the return ball of a one-two
  keeperRushTime: 2.5, // seconds a manual keeper rush lasts
  aimSpeed: 24, // m/s the set-piece target moves at full stick
  penaltyAimSpeed: 6,
  wallShiftSpeed: 3, // m/s the wall slides sideways at full stick
  wallShiftMax: 3.5,
  wallMin: 2,
  wallMax: 5,
  wallActive: 1.6, // seconds after the kick that the wall can still jump and block as a wall
} as const;

export const NET = {
  inputFramesPerMessage: 2,
  interpDelayMs: 100,
  reconnectGraceMs: 30_000,
  totalGraceMsPerMatch: 60_000,
  lobbyIdleMs: 10 * 60_000,
  resultsIdleMs: 5 * 60_000,
  maxMessageBytes: 4096,
  rateBurst: 120,
  ratePerSecond: 60,
  maxViolations: 20,
  idleInputNeutralMs: 250,
} as const;

export type Mentality = 'defensive' | 'balanced' | 'attacking';
export type Difficulty = 'casual' | 'pro' | 'elite' | 'adaptive';

export interface MentalityParams {
  lineOffset: number;
  pressers: number;
  pressRadius: number;
  supportDistance: number;
  runChance: number; // forward-run likelihood per decision
  fullbackOverlap: boolean;
  /** Game plans (live tactics): out of possession, forwards drop this far (midfielders half as far). */
  dropBack?: number;
  /** Out of possession the forwards stay up near halfway, ready to break. */
  stayHigh?: boolean;
  /** Out of possession the team squeezes this much narrower (0..1). */
  narrow?: number;
}

/**
 * Live tactics a side can switch between during a match. Park the bus: everyone behind the ball,
 * deep and narrow. Counter-attack: sit off, but leave the forwards up to break. High press: a high
 * line and three or four hunting the ball. All-out attack: everyone forward, full-backs overlapping.
 */
export type GamePlan = 'bus' | 'counter' | 'balanced' | 'press' | 'attack';
export const GAME_PLANS: GamePlan[] = ['bus', 'counter', 'balanced', 'press', 'attack'];
export const GAME_PLAN_NAMES: Record<GamePlan, string> = { bus: 'Park the bus', counter: 'Counter-attack', balanced: 'Balanced', press: 'High press', attack: 'All-out attack' };

/** A game plan applied on top of the team's mentality and sliders. */
export function applyGamePlan(m: MentalityParams, plan: GamePlan): MentalityParams {
  switch (plan) {
    case 'bus': return { ...m, lineOffset: m.lineOffset - 10, pressers: 1, pressRadius: Math.max(5, m.pressRadius * 0.6), supportDistance: m.supportDistance + 2, runChance: m.runChance * 0.35, fullbackOverlap: false, dropBack: 14, narrow: 0.18 };
    case 'counter': return { ...m, lineOffset: m.lineOffset - 6, pressers: Math.max(1, m.pressers - 1), pressRadius: Math.max(6, m.pressRadius - 3), runChance: Math.min(0.7, m.runChance + 0.2), fullbackOverlap: false, stayHigh: true, dropBack: 4, narrow: 0.08 };
    case 'press': return { ...m, lineOffset: m.lineOffset + 6, pressers: Math.min(4, m.pressers + 2), pressRadius: m.pressRadius + 8, supportDistance: m.supportDistance - 1 };
    case 'attack': return { ...m, lineOffset: m.lineOffset + 10, pressers: Math.min(4, m.pressers + 1), pressRadius: m.pressRadius + 4, supportDistance: m.supportDistance - 2, runChance: Math.min(0.75, m.runChance + 0.25), fullbackOverlap: true };
    default: return m;
  }
}

export const MENTALITY: Record<Mentality, MentalityParams> = {
  defensive: { lineOffset: -8, pressers: 1, pressRadius: 9, supportDistance: 14, runChance: 0.12, fullbackOverlap: false },
  balanced: { lineOffset: 0, pressers: 2, pressRadius: 13, supportDistance: 11, runChance: 0.25, fullbackOverlap: false },
  attacking: { lineOffset: 8, pressers: 3, pressRadius: 17, supportDistance: 9, runChance: 0.4, fullbackOverlap: true },
};

export interface DifficultyParams {
  decisionInterval: number;
  noise: number; // random score noise added to AI options
  reaction: number; // delay before reacting to a new ball event
  keeperReaction: number;
  tackleEagerness: number; // 0..1 chance per opportunity window
  interceptAwareness: number; // 0..1 how readily players attack pass lanes
  skill: number; // 0..1 chance a pressed ball carrier tries a skill move
  slide: number; // slide tackles per second while a carrier is escaping within range
  /**
   * Help a human playing against this level gets with their own kicks, 0..1 (see humanHelp in kick.ts):
   * tighter passes and shots, firmer passes, the open teammate preferred, and AI defenders and
   * keepers a touch slower to read them. Never applies to the AI's own kicks.
   */
  help: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyParams> = {
  casual: { decisionInterval: 0.5, noise: 0.35, reaction: 0.32, keeperReaction: 0.3, tackleEagerness: 0.35, interceptAwareness: 0.45, skill: 0.05, slide: 0.4, help: 1 },
  pro: { decisionInterval: 0.3, noise: 0.16, reaction: 0.2, keeperReaction: 0.22, tackleEagerness: 0.6, interceptAwareness: 0.75, skill: 0.15, slide: 0.8, help: 0.8 },
  elite: { decisionInterval: 0.18, noise: 0.06, reaction: 0.12, keeperReaction: 0.16, tackleEagerness: 0.8, interceptAwareness: 0.95, skill: 0.25, slide: 1.1, help: 0.55 },
  // Adaptive: starts here, then moves between Pro and World class with how the match is going (see adaptiveParams).
  adaptive: { decisionInterval: 0.18, noise: 0.06, reaction: 0.12, keeperReaction: 0.16, tackleEagerness: 0.8, interceptAwareness: 0.95, skill: 0.25, slide: 1.1, help: 0.55 },
};

/** Beyond Elite: what the Adaptive level reaches against a player who keeps winning. */
const WORLD_CLASS: DifficultyParams = { decisionInterval: 0.13, noise: 0.025, reaction: 0.085, keeperReaction: 0.13, tackleEagerness: 0.9, interceptAwareness: 1, skill: 0.32, slide: 1.25, help: 0.35 };
/** Adaptive level scale: 1 = Pro, 2 = Elite, 3 = World class. */
export const ADAPTIVE = { min: 1, max: 3, start: 2, step: 0.15, everyMinutes: 5 } as const;
export function adaptiveParams(level: number): DifficultyParams {
  const L = Math.max(ADAPTIVE.min, Math.min(ADAPTIVE.max, level));
  const [a, b, t] = L <= 2 ? [DIFFICULTY.pro, DIFFICULTY.elite, L - 1] : [DIFFICULTY.elite, WORLD_CLASS, L - 2];
  const out = {} as DifficultyParams;
  for (const k of Object.keys(a) as (keyof DifficultyParams)[]) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

export type Half = 1 | 2 | 3 | 4; // 3 and 4 are the two halves of extra time
/** Football seconds in a half: 45 minutes, or 15 in extra time. */
export const halfLength = (h: number) => (h <= 2 ? 45 * 60 : 15 * 60);
/** Football seconds on the clock when half h starts (0, 45:00, 90:00, 105:00). */
export const halfStart = (h: number) => (h <= 2 ? (h - 1) * 45 * 60 : 90 * 60 + (h - 3) * 15 * 60);
