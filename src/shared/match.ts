// The authoritative match simulation. Runs unchanged offline in the browser,
// on the multiplayer server and in headless tests. Clients only ever feed it
// InputFrames (intentions); everything else is decided here.

import { ADAPTIVE, BALL, BALLCTL, DIFFICULTY, FULL_PITCH, GAME_PLANS, MATCH, PITCH, PLAYER, SIM, STREET_PITCH, setPitch, adaptiveParams, halfLength, halfStart, type DifficultyParams, type GamePlan, type Half, type PitchSpec } from './config';
import { predictGoalLine, setBallEnv, stepBall, type BallEnv } from './ball';
import { cleanWeather, weatherEnv, weatherPlay, type MatchWeather, type WeatherPlay } from './weather';
import type { Crossing } from './ball';
import { aimFromInput, clampToPitch, throughPlan, STRIDE, kickWindup, handWindup, HAND_FOLLOW, pressureOn, selectReceiver, wantedDistance, SEMI_PASS_ANGLE, solveGroundPass, solveLob, solveShot, leadTarget, timingAccuracy, timingRing, solveCross, crossTarget, inCrossZone } from './kick';
import { humanHelp, type KickContext, type StridePlan } from './kick';
import { angleOf, clamp, dist, dirOf, norm, turnTowards, wrapAngle } from './math';
import { carrierMove, jogSpeed, stepMovement } from './movement';
import { Rng } from './rng';
import { benchFor, footProfile, STREET_ROLES, teamById, TEAMS } from './teams';
import type { PlayerDef, TeamDef } from './teams';
import type {
  Ball, GoalRecord, InputEvent, InputFrame, SwitchStyle, SwitchSens, KickKind, KickVariant, MatchConfig, MatchEvent, MatchEventType, Phase, Player, Restart,
  RestartType, Shootout, SkillMove, TeamIndex, TeamStats, V2, V3,
} from './types';
import { emptyStats } from './types';
import { newPlayerStats, rateMatch, type PlayerStats, type Rated } from './ratings';
import { updateAI, planTeams, restartTargets, chooseRestartKick, ROUTINES, routineAim, levelOf, receivePoint, thirdManRun, humanPassAndMove, LONG_THROW_FX, longThrower, throwRange, wallFor, wallSize, secondTaker, dummySpot } from './ai/team';
import type { TeamPlan } from './ai/team';
import { keeperSaveCheck, manualDive, smother } from './ai/keeper';
import { gameState, restartUrgency } from './ai/gamestate';
import { LINK, armSetPiece, linkKey, linkLevel, shotBlockLunges } from './ai/mates3';
import { TEAMMATE_ON } from './ai/team';
import { landingPoint } from './ball';
import { callForBall } from './pro';
import { newSkillState, skillCrossing, skillSpot, skillWoodwork, type SkillGame, type SkillState } from './skillgames';
import { controlDrillEvent, controlDrillOut, controlDrillWishes, setupControlDrill, stepControlDrill, type ControlDrillState } from './controldrill';
import { maybeInjure, stepInjury, type Injury } from './injury';
import { chooseDistribution, distributionFor, distributionRequest, pickDistribution, type Distribution } from './ai/distribution';
import { aerialWin, holdOffChance, strengthOf, DUEL } from './physical';
import { Momentum, MOMENTUM } from './momentum';
import { habitStreak, SETPIECE, SP_ON, bestBy, ratingError, chosenTaker, danceError, directFreeKick, matchPressure, nerveError, readEarlyKeeper, ringShake, setPieceRatings, shakyRing, shootoutWinnerOf, variantTech, type PenTech } from './setpieces';
import { manualShotAim } from './kick';
import { BC, G6, SW, SWITCH } from './switches';
import { closeDribble, heavyChance, humanCarrierInput, isJuggle, placeBallForSkill, startFlick, stepBallSkill, touchAway } from './ballcontrol';

export interface Control {
  human: boolean; // false => the whole team is AI (offline AI side, or a disconnected online player)
  pid: number; // controlled player id
  input: InputFrame;
  next: number; // next-switch candidate (for the marker)
  autoSwitch: boolean;
  quickRestarts: boolean;
  lastAutoSwitch: number;
  lastSeq: number;
  prevSprint: boolean;
  /** Be a Pro: the one player this human controls all match (player id), or -1. */
  lock?: number;
  /**
   * Stick direction carried over from a pass (radians), or undefined. Control jumps to the receiver
   * as the ball is played, while the stick is usually still pushed the way the pass went: until it
   * is let go or pushed a new way, the receiver ignores it and attacks the ball (20 Nov 2026).
   */
  carry?: number;
  /**
   * What the carried stick came from: 'pass' (the receiver of your pass attacks the ball) or
   * 'switch' (any other switch while defending: the new man closes down the ball, for at most
   * `carryUntil`). Undefined is 'pass' (20 Nov 2026).
   */
  carryKind?: 'pass' | 'switch';
  carryUntil?: number;
  /** Auto-switch style and sensitivity (20 Nov 2026; default 'full' / 'normal'). */
  style?: SwitchStyle;
  sens?: SwitchSens;
  /** When a challenge (tackle, slide, contain) was last pressed while defending. */
  lastChallenge?: number;
  /** Steadier switching: the defender who has been clearly better, and since when. */
  pend?: { id: number; since: number };
  /** Quick repeated switch presses: the players this run of presses has visited, and the last press. */
  chain?: number[];
  lastManual?: number;
}

/** How far (radians) the stick can move from the carried-over pass direction and still be ignored. */
export const CARRY_ANGLE = 0.7;

/** How far back from the ball the taker waits before running in (0: taken standing). */
export function runupDistance(type: RestartType): number {
  return type === 'freekick' ? 3.0 : type === 'penalty' ? 3.4 : type === 'goalkick' ? 4.6 : type === 'corner' ? 1.7 : 0;
}

/**
 * Where a run-up starts: behind the kicking position, angled off to the left of the line through
 * the ball so a right-footed taker comes in on a curve, like a real free-kick taker.
 */
export function runupStart(kickPos: V2, spot: V2, d: number, foot: number = 1): V2 {
  const u = norm(spot.x - kickPos.x, spot.z - kickPos.z);
  const a = 0.5 * foot; // a left-footed taker comes in from the right
  const lx = u.z, lz = -u.x;
  return { x: kickPos.x - u.x * d * Math.cos(a) + lx * d * Math.sin(a), z: kickPos.z - u.z * d * Math.cos(a) + lz * d * Math.sin(a) };
}

export interface KickRequest {
  kind: KickKind;
  dir?: V2;
  power?: number;
  placed?: boolean;
  variant?: KickVariant;
  charged?: boolean; // human pass: power picks a near or far receiver
  accuracy?: number; // set-piece timing multiplier on the kick's error
  receiver?: number; // -1 => choose from dir
  target?: V3;
  exact?: boolean; // play the ball to `target` itself (aimed set pieces)
  locked?: boolean; // receiver locked on press (Early receiver): power is the pace of the pass
  assist?: 1 | 2; // semi or manual pass assistance (on a shot, 2 = manual shooting)
  curve?: number; // free-kick shot: bend chosen by the taker (-1..1)
  dip?: number; // free-kick shot: topspin chosen by the taker (0..1)
  stutter?: boolean; // penalty: a computer taker's stutter run-up
  knuckle?: boolean; // free kick: struck without spin, so it wobbles and drops late
}

/** A foul the referee is waiting on before deciding whether to play advantage. */
export interface Advantage {
  team: TeamIndex; // fouled team
  spot: V2;
  until: number;
  offender: number;
  card: 0 | 1 | 2;
}

export const defaultConfig = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  teams: [TEAMS[0].id, TEAMS[1].id],
  kits: ['home', 'home'],
  realMinutes: MATCH.defaultRealMinutes,
  humans: [true, false],
  difficulty: ['pro', 'pro'],
  mentality: ['balanced', 'balanced'],
  autoSwitch: [true, true],
  seed: 12345,
  ...over,
});

const isLocked = (c: Control) => (c.lock ?? -1) >= 0;

const emptyInput = (): InputFrame => ({ seq: 0, mx: 0, mz: 0, sprint: false, jockey: false, close: false, ev: [] });

const KICK_STATES: KickKind[] = ['pass', 'through', 'lob', 'cross', 'throw'];

/** Shot types (19 Nov 2026): extra back-lift for a power shot, a quicker side-foot for a placed one (s). */
export const SHOT_TYPES = { powerWindup: 0.1, placedQuicker: 0.04 } as const;

/**
 * Goalmouth scrambles and deflections (19 Nov 2026): how long a scramble lasts after a block, parry
 * or deflection in a penalty area, how much it spoils a first touch, how often a loose ball cannons
 * off a body, how often a shot glances off a player near its path, and how much a bounce bobbles.
 */
export const SCRAMBLE = { time: 2.6, control: 0.25, ricochet: 0.5, ricochetReach: 0.55, glance: 0.32, glanceFrom: 0.5, glanceTo: 1.0, bobble: 0.07, bobbleBox: 0.05, hop: 0.0022 } as const;

/** The modifier skill moves (19 Nov 2026): durations (s) and when an elastico snaps back in. */
export const SKILL6 = { rollTime: 0.5, elasticoTime: 0.46, elasticoSnap: 0.17, turnTime: 0.6 } as const;

/** Where the ball sits relative to the player during a ball roll, elastico or drag-back turn. */
export function skill6Ball(p: Player, a: Player['action']): V2 {
  const f = a.dir ?? dirOf(p.facing);
  const s = a.side ?? 1;
  const u = clamp(a.t / a.dur, 0, 1);
  const sx = -f.z * s, sz = f.x * s;
  if (a.skill === 'ballroll') {
    const k = -0.12 + 0.5 * Math.min(1, u / 0.75);
    return { x: f.x * 0.28 + sx * k, z: f.z * 0.28 + sz * k };
  }
  if (a.skill === 'elastico') {
    const snap = SKILL6.elasticoSnap / a.dur;
    const k = u < snap ? 0.38 * (u / snap) : 0.38 - 0.72 * Math.min(1, (u - snap) / 0.25);
    return { x: f.x * 0.42 + sx * k, z: f.z * 0.42 + sz * k };
  }
  const g = dirOf(p.facing);
  return { x: g.x * 0.36, z: g.z * 0.36 };
}

/**
 * Overhead kicks and diving headers (20 Nov 2026), both from a shot pressed by a human as the ball arrives.
 * Overhead: ball 1.6-2.25 m up and the player's facing pointing back towards his own goal (x
 * component against the attack under backToGoal); error x overheadError on top of a volley's.
 * Diving header: a low cross (diveLow-diveHigh m) met at diveSpeed m/s or more within diveRange m of the goal line.
 */
export const AERIAL7 = { overhead: true, overheadMax: 2.25, backToGoal: -0.25, overheadError: 1.3, divingHeader: true, diveLow: 0.45, diveHigh: 1.15, diveSpeed: 3.4, diveRange: 22, diveTime: 0.7 } as const;

/** Body feint, Berba spin and McGeady spin (20 Nov 2026): durations (s), the share of a feint spent selling it, and how fast a carrier must be going to drop the shoulder. */
export const SKILL7 = { time: { bodyfeint: 0.36, berba: 0.62, mcgeady: 0.56 } as Record<'bodyfeint' | 'berba' | 'mcgeady', number>, feintSell: 0.42, feintSpeed: 4.6 } as const;

/** Free kicks with bend and dip (19 Nov 2026): how fast the stick changes them (per second at full stick). */
export const FREEKICK = { bendRate: 1.5 } as const;

/** Tactical fouls (19 Nov 2026): reach of a pull-back and how often the referee books one that stops an attack. */
export const TACTICAL = { reach: 2.3, contact: 0.18, yellowAttack: 0.92, yellowOther: 0.55 } as const;

export class Match {
  cfg: MatchConfig;
  teams: [TeamDef, TeamDef];
  players: Player[] = [];
  ball: Ball;
  phase: Phase = 'kickoff';
  phaseT = 0;
  half: Half = 1;
  /** Penalty shootout after a draw (when the match settings ask for one), else null. */
  shootout: Shootout | null = null;
  private soRestart: Restart | null = null;
  /** Adaptive difficulty: the current level (1 Pro .. 3 World class) and its parameters. */
  adaptiveLevel: number = ADAPTIVE.start;
  adaptiveLevelParams: DifficultyParams = adaptiveParams(ADAPTIVE.start);
  private adaptNextAt = ADAPTIVE.everyMinutes * 60;
  /** Each team's substitutes (unused ones), substitutions made, and changes waiting for the next stoppage. */
  bench: [PlayerDef[], PlayerDef[]] = [[], []];
  /** Substitutions made: [team, slot, bench index] in order (sent to online clients so they can swap names and models). */
  subsLog: [number, number, number][] = [];
  private pendingSubs: { team: TeamIndex; id: number; bench: number }[] = [];
  /** When the last penalty was struck: keepers must guess a side rather than read the shot. */
  penKickTime = -10;
  /** The penalty just struck: technique, and a keeper's decision made before it (stutter, early dive, standing tall). */
  penTech: PenTech = 'normal';
  /** Each side's penalties so far: -1 / 1 by goal-line side, 0 down the middle (keepers learn from it). */
  penHistory: [number[], number[]] = [[], []];
  penGuess: { team: TeamIndex; side: -1 | 0 | 1; t: number; early?: boolean; waited?: boolean } | null = null;
  /** A human given his keeper for a penalty gets an outfield player back once it is over. */
  private penKeeperBack: { team: TeamIndex; at: number } | null = null;
  /** A penalty saved by a keeper who left his line too early is retaken. */
  private penRetake: { team: TeamIndex; taker: number; spot: V2; until: number; due: number } | null = null;
  /** A knuckleball in the air: its wobble. */
  private knuckle: { kicker: number; t0: number; amp: number; freq: number; phase: number } | null = null;
  /** A keeper whose view of a free kick was blocked (attackers in the wall) or who was fooled by a dummy: slower to react. */
  keeperBlind: { team: number; until: number; extra: number } | null = null;
  private soT = 0;
  private soWait = -1;
  clock = 0; // football seconds elapsed in the current half
  time = 0; // simulation seconds since construction
  tick = 0;
  score: [number, number] = [0, 0];
  goals: GoalRecord[] = [];
  stats: [TeamStats, TeamStats] = [emptyStats(), emptyStats()];
  /** Each player's match stats, by player id; lines of players substituted off move to statsOff. */
  pstats: PlayerStats[] = [];
  statsOff: PlayerStats[] = [];
  /** The last completed pass, for assists and chances created. */
  private lastPass: { passer: number; receiver: number; team: number; time: number } | null = null;
  restart: Restart | null = null;
  events: MatchEvent[] = [];
  /** A steered first touch in progress: the dribble leaves the ball alone until `until`. */
  firstTouch = { pid: -1, until: 0 };
  /** Ball control (19 Nov 2026): human carriers holding close control this tick. */
  closeIds = new Set<number>();
  /** After a sole stop: until when pushing the stick sets off with a burst, by player id. */
  soleGo = new Map<number, number>();
  /** When each player may chop again (sim time), by player id. */
  chopCd = new Map<number, number>();
  /** A ball flicked over a defender: the flicker leaves it until it drops below waist height (or `until`). */
  flickOver = { pid: -1, until: 0 };
  ctrl: [Control, Control];
  /**
   * Co-op (local multiplayer): a second human on a team, or null. While its input is handled it is
   * swapped into `ctrl[team]` (see asMate), so every rule written for a team's human applies to it too.
   */
  mates: [Control | null, Control | null] = [null, null];
  rng: Rng;
  firstKickoff: TeamIndex;
  plans: [TeamPlan | null, TeamPlan | null] = [null, null];
  /** Offside: players flagged at the last teammate pass, and their team. */
  offside = { team: -1, flagged: new Set<number>() };
  /** Set by an indirect free kick until someone other than the taker touches the ball. */
  indirectTaker = -1;
  lastKickTime = -10;
  /** Human help (0..1) on the last kick, so AI defenders and keepers read a human's pass or shot a touch later. */
  lastKickHelp = 0;
  /** A human's through ball into a runner's stride: where they meet, his line, and until when (see throughPlan). */
  stride: { receiver: number; point: V2; until: number; plan?: StridePlan } | null = null;
  lastShot: { team: number; player: number; onTarget: boolean; time: number } | null = null;
  halfEndGrace = 0;
  holdT = 0; // keeper hold timer
  possessionStart = 0;
  advantage: Advantage | null = null;
  /** A corner or wide free kick against a human's side was just delivered: who marks whom, who holds which zone. */
  setPieceDef: { team: number; until: number; marks: Map<number, number>; zones: Map<number, V2> } | null = null;
  /** Partnerships (human sides): points per pair of teammates (key linkKey), from passes they complete to each other. */
  links: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
  /** Teammate pressing the ball carrier because the human holds contain (-1: none). */
  contain: [number, number] = [-1, -1];
  /** A run in behind called by the human: who, and until when. */
  calledRun: [{ pid: number; until: number }, { pid: number; until: number }] = [{ pid: -1, until: 0 }, { pid: -1, until: 0 }];
  /** Each side's game plan (live tactics), switched during the match. */
  plan: [GamePlan, GamePlan] = ['balanced', 'balanced'];
  /** Manual keeper rush (sim time it ends) for each team. */
  keeperRush: [number, number] = [0, 0];
  /** Home crowd momentum (19 Nov 2026): -1 away side on top .. 1 home side on top; the home crowd lifts the home side. */
  momentum: Momentum;
  private crowdLifting = false;
  /** When each team last won the ball from the other (counter-attacks, club styles). */
  wonBallAt: [number, number] = [-99, -99];
  /** Goalmouth scramble: a loose ball bouncing around a penalty area after a block, parry or deflection, until this time. */
  scrambleUntil = 0;
  /** Players a shot has already glanced off (each body deflects a shot at most once). */
  private glanced = new Set<number>();
  /** Strength battles: the carrier's current challenger and when the next check is due. */
  private battles = new Map<number, { opp: number; next: number; told: boolean }>();
  log: string[] = [];
  private eventId = 0;
  private pendingEvents: [InputEvent[], InputEvent[]] = [[], []];
  private matePending: [InputEvent[], InputEvent[]] = [[], []];

  /** A player being treated (play waits), and every injury this match (career mode keeps them out). */
  injury: Injury | null = null;
  injuries: { pid: number; team: number; short: string; name: string; severity: number; matches: number }[] = [];
  /** Skill games (crossbar challenge, target practice): points and targets. */
  skill: SkillState | null = null;

  /** This match's weather, what it does to the ball (set before every step) and to the players. */
  weather: MatchWeather;
  env: BallEnv;
  wplay: WeatherPlay;

  /** The pitch this match is played on (a street cage or a full pitch); set before every step. */
  readonly pitch: Readonly<PitchSpec>;

  constructor(cfg: MatchConfig) {
    this.cfg = { ...cfg };
    this.pitch = cfg.street ? STREET_PITCH : FULL_PITCH;
    setPitch(this.pitch);
    this.weather = cleanWeather(cfg.weather);
    this.env = weatherEnv(this.weather);
    this.wplay = weatherPlay(this.weather);
    setBallEnv(this.env);
    this.momentum = new Momentum(cfg.momentum !== false && !cfg.practice && G6.momentum);
    if (!MATCH.allowedRealMinutes.includes(this.cfg.realMinutes)) this.cfg.realMinutes = MATCH.defaultRealMinutes;
    this.rng = new Rng(cfg.seed);
    this.teams = [teamById(cfg.teams[0]), teamById(cfg.teams[1])];
    for (let t = 0 as TeamIndex; t < 2; t = (t + 1) as TeamIndex) {
      this.teams[t].players.forEach((def, slot) => {
        const a = def.attrs;
        this.players.push({
          id: t * 11 + slot, team: t, slot, role: def.role, def,
          a: { pace: a.pace / 100, acceleration: a.acceleration / 100, stamina: a.stamina / 100, control: a.control / 100, passing: a.passing / 100, shooting: a.shooting / 100, tackling: a.tackling / 100, goalkeeping: a.goalkeeping / 100 },
          pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, facing: 0, stamina: 1, fatigue: 0, sprinting: false, jockeying: false, shielding: false, cards: 0, off: false, burst: 0, beaten: 0, skillCd: 0, jockeyT: 0,
          action: { type: 'none', t: 0, dur: 0 }, touchCooldown: 0, tackleCooldown: 0, contestCooldown: 0,
          queued: null, wish: { x: 0, z: 0, mode: 'jog', face: null },
          aiTarget: { x: 0, z: 0 }, aiIntent: '', aiNextDecision: 0, aiRunUntil: 0, aiHoldUntil: 0, runLane: 0, runStart: 0, runTo: null, giveGoUntil: 0, callUntil: 0,
        });
      });
    }
    // 5-a-side street: keeper, two at the back, one in midfield and the striker; the rest sit out.
    if (cfg.street) for (const p of this.players) if (!STREET_ROLES.includes(p.role)) { p.off = true; p.pos = { x: 0, z: (p.team ? 1 : -1) * 60 }; }
    this.pstats = this.players.map((p) => newPlayerStats(p.id, p.team, p.def, p.role));
    this.ball = {
      pos: { x: 0, y: BALL.radius, z: 0 }, vel: { x: 0, y: 0, z: 0 }, spin: 0,
      state: 'dead', owner: -1, lastTouch: -1, lastTouchTeam: -1, flight: 'none', receiver: -1, kicker: -1, kickLock: 0, stillTime: 0,
    };
    this.ctrl = [0, 1].map((t) => ({
      human: cfg.humans[t], pid: t * 11 + 9, input: emptyInput(), next: -1, autoSwitch: cfg.autoSwitch[t] && cfg.switchStyle?.[t] !== 'off', quickRestarts: cfg.quickRestarts?.[t] ?? true, lastAutoSwitch: -10, lastSeq: 0, prevSprint: false,
      style: cfg.switchStyle?.[t] ?? 'full', sens: cfg.switchSens?.[t] ?? 'normal',
      lock: cfg.lock && cfg.lock[t] >= 0 && cfg.lock[t] < 11 && cfg.humans[t] ? t * 11 + cfg.lock[t] : -1,
    })) as [Control, Control];
    this.mates = [0, 1].map((t) => (cfg.mates?.[t] && cfg.humans[t] ? {
      human: true, pid: t * 11 + 10, input: emptyInput(), next: -1, autoSwitch: cfg.autoSwitch[t] && cfg.switchStyle?.[t] !== 'off', style: cfg.switchStyle?.[t] ?? 'full', sens: cfg.switchSens?.[t] ?? 'normal', quickRestarts: cfg.quickRestarts?.[t] ?? true, lastAutoSwitch: -10, lastSeq: 0, prevSprint: false,
    } : null)) as [Control | null, Control | null];
    this.bench = [benchFor(this.teams[0]), benchFor(this.teams[1])];
    if (cfg.practice === 'crossbar' || cfg.practice === 'targets' || cfg.practice === 'control') this.skill = newSkillState(cfg.practice);
    this.setAdaptive(cfg.adaptiveStart ?? ADAPTIVE.start);
    this.firstKickoff = this.rng.chance(0.5) ? 0 : 1;
    this.startKickoff(this.firstKickoff);
    const sa = cfg.startAt;
    if (sa) this.startFrom(sa.half, sa.clock, sa.score, sa.kickoff, sa.offs);
  }

  // ---------------------------------------------------------------- helpers

  /** Help for a kick by p: the opposing level's help when p is the human-controlled player (or a human's restart taker), else 0. */
  helpFor(p: Player, restartTaker = false): number {
    if (!this.controlOf(p) && !(restartTaker && this.ctrl[p.team].human)) return 0;
    return levelOf(this, 1 - p.team).help;
  }

  /** +1 if the team attacks towards +x in the current half. Teams change ends at half-time. */
  attackDir(team: number): 1 | -1 {
    const first = team === 0 ? 1 : -1;
    // Shootout: whoever is kicking attacks the same end, so the other side's keeper is in that goal.
    if (this.shootout) return (team === this.shootout.team ? 1 : -1) as 1 | -1;
    return (this.half % 2 === 1 ? first : -first) as 1 | -1;
  }
  ownGoalX(team: number) {
    return -this.attackDir(team) * PITCH.halfLength;
  }
  /** Players of a team still on the pitch (sent-off players are left out). */
  teamPlayers(team: number) {
    return this.players.filter((p) => p.team === team && !p.off);
  }
  keeper(team: number) {
    return this.players[team * 11];
  }
  get dt() {
    return SIM.dt;
  }
  /** Real-time to football-time factor (default 6 real minutes => 90 football minutes => 15x). */
  get clockRate() {
    return MATCH.footballSecondsPerHalf / ((this.cfg.realMinutes * 60) / 2);
  }
  /** Displayed match clock in football seconds; runs past 45:00 / 90:00 into added time. */
  get displayClock() {
    return halfStart(this.half) + Math.min(this.clock, halfLength(this.half) + this.addedTime * 60);
  }
  /** Added time for this half in whole minutes, shown on the fourth official's board (0 until announced). */
  addedTime = 0;
  /** Football seconds lost to stoppages this half (goals, fouls, cards, substitutions). */
  stoppage = 0;
  isHumanControlled(p: Player) {
    return !!this.controlOf(p);
  }

  /** The human control steering p (either human in co-op), or null. */
  controlOf(p: Player): Control | null {
    const c = this.ctrl[p.team];
    if (c.human && c.pid === p.id) return c;
    const m = this.mates[p.team];
    return m && m.human && m.pid === p.id ? m : null;
  }

  /** Co-op: the other human's player on this team (a switch never takes it), or -1. */
  otherHuman(team: number): number {
    const m = this.mates[team];
    return m && m.human ? m.pid : -1;
  }

  /** Runs fn with the team's co-op mate swapped in as ctrl[team] (with its own queued events). */
  asMate<T>(team: TeamIndex, fn: () => T): T | undefined {
    if (!this.mates[team]) return undefined;
    this.swapMate(team);
    try { return fn(); } finally { this.swapMate(team); }
  }

  private swapMate(team: TeamIndex) {
    const m = this.mates[team]!;
    this.mates[team] = this.ctrl[team];
    this.ctrl[team] = m;
    const pe = this.pendingEvents[team];
    this.pendingEvents[team] = this.matePending[team];
    this.matePending[team] = pe;
  }

  /**
   * Which human takes over `to` when the ball goes to them: the only human; in co-op nobody if one
   * of them already has that player, else the one who played the ball, else the one nearer.
   */
  private receivingControl(team: number, from: number, to: number): Control | null {
    const hs = [this.ctrl[team], this.mates[team]].filter((x): x is Control => !!x && x.human && !(isLocked(x) && x.lock !== to));
    if (hs.length <= 1) return hs[0] ?? null;
    if (hs.some((h) => h.pid === to)) return null;
    const own = hs.find((h) => h.pid === from);
    if (own) return own;
    const d = (h: Control) => dist(this.players[h.pid].pos, this.players[to].pos);
    return d(hs[0]) <= d(hs[1]) ? hs[0] : hs[1];
  }

  /** Co-op: a teammate for the second human to start on (the nearest outfield player to `pid`). */
  private partnerFor(team: number, pid: number): number {
    const at = this.players[pid].pos;
    let best = -1, bd = Infinity;
    for (const p of this.teamPlayers(team)) {
      if (p.id === pid || p.role === 'GK') continue;
      const d = dist(p.pos, at);
      if (d < bd) { bd = d; best = p.id; }
    }
    return best >= 0 ? best : pid;
  }
  possessionTeam(): number {
    const b = this.ball;
    if (b.owner >= 0) return this.players[b.owner].team;
    if (b.state === 'flight' && b.lastTouchTeam >= 0 && b.flight !== 'deflect') return b.lastTouchTeam;
    return -1;
  }
  inPenaltyArea(team: number, pos: V2, margin = 0) {
    const gx = this.ownGoalX(team);
    return Math.abs(pos.x - gx) <= PITCH.penaltyAreaDepth + margin && Math.abs(pos.z) <= PITCH.penaltyAreaHalfWidth + margin;
  }
  emit(type: MatchEventType, data: Partial<MatchEvent> = {}) {
    this.events.push({ id: ++this.eventId, type, tick: this.tick, ...data });
    if (type === 'save' && this.penRetake && this.time < this.penRetake.until && data.team !== this.penRetake.team) this.penRetake.due = this.time + 0.9;
    this.momentumFrom(type, data);
    if (this.ctlDrill) controlDrillEvent(this, this.ctlDrill, type, data.text, data.player);
  }

  /** Momentum: shots, saves, corners, goals, tackles and the woodwork swing it towards the side on top. */
  private momentumFrom(type: MatchEventType, d: Partial<MatchEvent>) {
    const mo = this.momentum;
    if (!mo?.on || this.shootout) return;
    const t = d.team ?? -1;
    switch (type) {
      case 'kick': if (d.text === 'shot') mo.push(t, MOMENTUM.shot); break;
      case 'save': mo.push(1 - t, MOMENTUM.onTarget); break;
      case 'goal': mo.push(t, MOMENTUM.goal); break;
      case 'tackle': mo.push(t, MOMENTUM.tackle); break;
      case 'post': case 'bar': mo.push(this.ball.lastTouchTeam, MOMENTUM.woodwork); break;
      case 'restart': if (d.text === 'corner') mo.push(t, MOMENTUM.corner); break;
    }
  }

  /** Per tick in open play: time on the ball near the opponents' goal builds momentum; it fades back otherwise. */
  private stepMomentum(dt: number) {
    const mo = this.momentum;
    if (!mo.on) return;
    mo.step(dt);
    if (this.phase === 'play' && !this.shootout) {
      const pt = this.possessionTeam();
      if (pt >= 0) {
        const fx = this.ball.pos.x * this.attackDir(pt as TeamIndex);
        if (fx > PITCH.halfLength - PITCH.penaltyAreaDepth && Math.abs(this.ball.pos.z) < PITCH.penaltyAreaHalfWidth) mo.push(pt, MOMENTUM.box * dt);
        else if (fx > 17.5) mo.push(pt, MOMENTUM.finalThird * dt);
      }
    }
    // The home crowd gets behind their side: once when the lift starts (eased off again well below it).
    const lift = mo.lift();
    if (!this.crowdLifting && lift > 0.15) { this.crowdLifting = true; this.emit('call', { team: 0, text: 'crowd' }); }
    else if (this.crowdLifting && mo.value < MOMENTUM.liftFrom * 0.6) this.crowdLifting = false;
  }
  /** Take (and clear) events produced since the last call. */
  drainEvents(): MatchEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
  debugLog(msg: string) {
    const line = `[t=${this.time.toFixed(2)} ${this.half}H ${fmtClock(this.displayClock)}] ${msg}`;
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
  }

  // ---------------------------------------------------------------- input

  setHuman(team: TeamIndex, human: boolean) {
    const c = this.ctrl[team];
    c.human = human;
    c.input = emptyInput();
    this.pendingEvents[team] = [];
    for (const p of this.teamPlayers(team)) p.queued = null;
  }

  /** Apply one input frame for a team. Validated and clamped; events are queued in order. */
  applyInput(team: TeamIndex, f: InputFrame, slot: 0 | 1 = 0) {
    if (slot === 1) { this.asMate(team, () => this.applyInput(team, f)); return; }
    const c = this.ctrl[team];
    if (!c.human) return;
    const m = Math.hypot(f.mx, f.mz);
    const k = m > 1 ? 1 / m : 1;
    c.input = { seq: f.seq, mx: (f.mx || 0) * k, mz: (f.mz || 0) * k, sprint: !!f.sprint, jockey: !!f.jockey, contain: !!f.contain, close: !!f.close, ev: [] };
    c.lastSeq = f.seq;
    for (const e of f.ev.slice(0, 4)) {
      // A game plan change applies at once, whatever is happening (restarts included).
      if (e.k === 'plan') { this.setPlan(team, GAME_PLANS[clamp(Math.round((Number(e.p) || 0) * 4), 0, 4)]); continue; }
      if (e.k === 'instr') { const n = clamp(Math.round((Number(e.p) || 0) * 32), 0, 32); this.setInstruction(team, Math.floor(n / 3), (n % 3) - 1); continue; }
      const ev: InputEvent = { k: e.k, p: clamp(Number(e.p) || 0, 0, 1), m: !!e.m };
      // Shot styles (placed and power were dropped here until 19 Nov 2026, so they played as normal and finesse shots).
      if (e.k === 'shoot' && (e.v === 'chip' || e.v === 'low' || e.v === 'placed' || e.v === 'power')) ev.v = e.v;
      if (e.k === 'shoot' && e.a === 2) ev.a = 2;
      if (e.k === 'skill' && (e.v === 'fake' || e.v === 'flick')) ev.v = e.v;
      if ((e.k === 'pass' || e.k === 'through' || e.k === 'lob') && Number.isInteger(e.r) && e.r! >= 0 && e.r! < this.players.length) ev.r = e.r;
      if ((e.k === 'pass' || e.k === 'through' || e.k === 'lob') && (e.a === 1 || e.a === 2)) ev.a = e.a;
      if (Number.isFinite(e.x) && Number.isFinite(e.z)) { ev.x = clamp(e.x!, -80, 80); ev.z = clamp(e.z!, -80, 80); ev.at = !!e.at; }
      this.pendingEvents[team].push(ev);
    }
  }

  /** Neutralise a team's input (focus loss, disconnect, stale input). */
  clearInput(team: TeamIndex, slot: 0 | 1 = 0) {
    if (slot === 1) { this.asMate(team, () => this.clearInput(team)); return; }
    const c = this.ctrl[team];
    c.input = { ...emptyInput(), seq: c.input.seq };
    this.pendingEvents[team] = [];
  }

  // ---------------------------------------------------------------- flow

  continueAfterHalftime() {
    if (this.phase !== 'halftime') return;
    this.half = (this.half + 1) as Half;
    this.clock = 0;
    this.addedTime = 0;
    this.stoppage = 0;
    const rest = this.half === 2 ? 0.35 : this.half === 3 ? 0.15 : 0.05;
    for (const p of this.players) p.stamina = Math.min(1, p.stamina + rest);
    this.startKickoff((this.half % 2 === 0 ? 1 - this.firstKickoff : this.firstKickoff) as TeamIndex);
  }

  private startKickoff(team: TeamIndex) {
    this.phase = 'kickoff';
    this.phaseT = 0;
    this.endAdvantage();
    this.giveBookings();
    const st = this.kickoffTaker(team);
    this.restart = { type: 'kickoff', team, spot: { x: 0, z: 0 }, taker: st.id, t: 0, ready: false, readyT: 0, indirect: false, aim: { x: 0, z: 0 } };
    this.resetBall({ x: 0, z: 0 });
    this.offside.flagged.clear();
    this.indirectTaker = -1;
    const targets = restartTargets(this, this.restart);
    for (const p of this.players) {
      if (p.off) continue;
      p.pos = { ...targets[p.id] };
      p.vel = { x: 0, z: 0 };
      p.facing = this.attackDir(p.team) > 0 ? 0 : Math.PI;
      p.action = { type: 'none', t: 0, dur: 0 };
      p.queued = null;
      p.burst = 0;
      p.beaten = 0;
    }
    for (const t of [0, 1] as TeamIndex[]) {
      const c = this.ctrl[t];
      c.pid = t === team ? st.id : this.kickoffTaker(t).id;
      if (isLocked(c)) c.pid = c.lock!;
      const mt = this.mates[t];
      if (mt) mt.pid = this.partnerFor(t, c.pid);
    }
    this.emit('kickoff', { team });
  }

  /** A human side's restart: the taker goes to its human (co-op: whichever is nearer, unless one already has him). */
  private giveTaker(team: TeamIndex, taker: number) {
    const c = this.ctrl[team], m = this.mates[team];
    if (isLocked(c)) return; // Be a Pro: a teammate takes it (or you, if you are the taker)
    if (m && m.human) {
      if (c.pid === taker || m.pid === taker) return;
      if (dist(this.players[m.pid].pos, this.players[taker].pos) < dist(this.players[c.pid].pos, this.players[taker].pos)) { m.pid = taker; return; }
    }
    c.pid = taker;
  }

  /** The striker takes kick-offs; if they have been sent off, another forward or midfielder does. */
  private kickoffTaker(team: number): Player {
    const squad = this.teamPlayers(team);
    const order = ['ST', 'RW', 'LW', 'RCM', 'LCM', 'CDM'];
    for (const r of order) { const p = squad.find((q) => q.role === r); if (p) return p; }
    return squad.find((q) => q.role !== 'GK') ?? squad[0];
  }

  private resetBall(at: V2) {
    const b = this.ball;
    b.pos = { x: at.x, y: BALL.radius, z: at.z };
    b.vel = { x: 0, y: 0, z: 0 };
    b.spin = 0;
    b.state = 'dead';
    b.owner = -1;
    b.flight = 'none';
    b.receiver = -1;
    b.stillTime = 0;
  }

  private award(type: RestartType, team: TeamIndex, spot: V2, indirect = false, taker?: number) {
    this.phase = 'restart';
    this.phaseT = 0;
    const b = this.ball;
    b.state = 'dead';
    b.owner = -1;
    b.receiver = -1;
    b.flight = 'none';
    this.offside.flagged.clear();
    this.indirectTaker = -1;
    this.endAdvantage();
    this.giveBookings();
    const tk = taker ?? this.pickTaker(type, team, spot);
    this.restart = { type, team, spot: { ...spot }, taker: tk, t: 0, ready: false, readyT: 0, indirect, aim: { ...spot } };
    // In the final third the computer sometimes sends its long-throw specialist over to launch it into the box.
    if (type === 'throwin' && !this.ctrl[team].human && taker === undefined && this.longThrowOn(this.restart) && this.rng.chance(0.4)) {
      this.restart.routine = 1;
      this.restart.taker = longThrower(this, team).id;
    }
    for (const p of this.players) p.queued = null;
    // The computer sometimes puts two over the ball or attackers in the wall at a direct free kick;
    // a computer wall sometimes has a man lying down behind it.
    if (type === 'freekick' && SP_ON.routines && directFreeKick(spot, this.attackDir(team)) && wallFor(this, this.restart)) {
      if (!this.ctrl[team].human && this.rng.chance(0.3)) this.restart.routine = this.rng.chance(0.5) ? 3 : 4;
      if (!this.ctrl[1 - team].human && SP_ON.wall && this.rng.chance(0.3)) this.restart.wall = { n: wallSize(dist(spot, { x: this.ownGoalX((1 - team) as TeamIndex), z: 0 })), shift: 0, lie: true };
    }
    if (this.ctrl[team].human) this.giveTaker(team, this.restart.taker);
    // Penalty keeper duel: a human facing a penalty takes his keeper (not in Be a Pro).
    this.penGuess = null;
    if (type === 'penalty' && SP_ON.duel) {
      const dt = (1 - team) as TeamIndex;
      const c = this.ctrl[dt];
      const gk = this.keeper(dt);
      if (c.human && !isLocked(c) && !gk.off && c.pid !== gk.id && this.otherHuman(dt) !== gk.id) {
        c.pid = gk.id;
        c.lastAutoSwitch = this.time;
        gk.queued = null;
        this.penKeeperBack = { team: dt, at: Infinity };
        this.emit('switch', { team: dt, player: gk.id, text: 'keeper' });
      }
      this.restart.gk = { shift: 0, dance: 0 };
      // A human who keeps going the same way is told the keeper has noticed.
      const hs = habitStreak(this.penHistory[team]);
      if (this.ctrl[team].human && hs.n >= 3 && SP_ON.habits) this.emit('call', { team, text: 'habit', power: hs.n });
    }
    this.emit('restart', { team, x: spot.x, z: spot.z, text: type });
  }

  /** A throw-in far enough up the pitch to be thrown into the box. */
  longThrowOn(r: Restart): boolean {
    return r.type === 'throwin' && r.spot.x * this.attackDir(r.team) > LONG_THROW_FX;
  }

  private pickTaker(type: RestartType, team: TeamIndex, spot: V2): number {
    const squad = this.teamPlayers(team);
    if (type === 'goalkick') return squad[0].id;
    // Chosen takers (Tactics) first, then the best penalty taker / free-kick specialist (20 Nov 2026).
    const takers = this.cfg.tactics?.[team]?.takers;
    if (type === 'penalty') {
      const ch = chosenTaker(squad, takers, 'pen');
      if (ch) return ch.id;
      return SP_ON.ratings ? bestBy(squad, 'pen')!.id : squad.filter((p) => p.role !== 'GK').sort((a, b) => b.a.shooting - a.a.shooting)[0].id;
    }
    if (type === 'freekick' && directFreeKick(spot, this.attackDir(team))) {
      const ch = chosenTaker(squad, takers, 'fk');
      if (ch && ch.role !== 'GK') return ch.id;
      if (SP_ON.ratings) return bestBy(squad, 'fk')!.id;
    }
    if (type === 'corner') {
      const ch = chosenTaker(squad, takers, 'corner');
      if (ch && ch.role !== 'GK') return ch.id;
    }
    let pool = squad.filter((p) => p.role !== 'GK');
    if (type === 'corner') pool = pool.filter((p) => ['RW', 'LW', 'RB', 'LB', 'RCM', 'LCM'].includes(p.role));
    let best = pool[0], bd = Infinity;
    for (const p of pool) {
      const d = dist(p.pos, spot) - (type === 'freekick' ? p.a.passing * 6 : 0);
      if (d < bd) { bd = d; best = p; }
    }
    return best.id;
  }

  private endHalf() {
    this.endAdvantage();
    this.giveBookings();
    const level = this.score[0] === this.score[1];
    const mode = this.cfg.practice ? 'stand' : this.cfg.draw ?? 'stand';
    const next = this.half === 1 || this.half === 3 ? 'break' : level && mode === 'extra' && this.half === 2 ? 'extra' : level && mode !== 'stand' ? 'pens' : 'end';
    this.emit('whistle', { power: 3, text: next === 'break' ? 'halftime' : 'fulltime' });
    this.restart = null;
    this.ball.state = 'dead';
    this.ball.owner = -1;
    this.phaseT = 0;
    this.halfEndGrace = 0;
    if (next === 'break' || next === 'extra') {
      this.phase = 'halftime';
      this.emit('halftime', { text: next === 'extra' ? 'extra' : this.half === 3 ? 'et' : '' });
    } else if (next === 'pens') {
      this.startShootout();
    } else {
      this.phase = 'fulltime';
      this.emit('fulltime');
    }
    for (const p of this.players) { p.action = { type: 'none', t: 0, dur: 0 }; p.queued = null; }
  }

  // ---------------------------------------------------------------- step

  step() {
    const dt = SIM.dt;
    setPitch(this.pitch);
    setBallEnv(this.env);
    this.tick++;
    this.time += dt;
    this.phaseT += dt;
    for (const p of this.players) {
      p.touchCooldown = Math.max(0, p.touchCooldown - dt);
      p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);
      p.contestCooldown = Math.max(0, p.contestCooldown - dt);
      p.burst = Math.max(0, p.burst - dt);
      p.beaten = Math.max(0, p.beaten - dt);
      p.skillCd = Math.max(0, p.skillCd - dt);
      p.jockeyT = p.jockeying && p.action.type === 'none' ? p.jockeyT + dt : 0;
      if (p.queued && p.queued.until < this.time) p.queued = null;
      if (p.shielding && (this.ball.owner !== p.id || !this.controlOf(p))) p.shielding = false;
    }
    this.ball.kickLock = Math.max(0, this.ball.kickLock - dt);

    const live = (this.phase === 'play' || this.phase === 'restart') && !this.cfg.practice && !this.shootout;
    if (live) {
      this.clock += dt * this.clockRate;
      if (this.displayClock >= this.adaptNextAt) { this.adaptNextAt += ADAPTIVE.everyMinutes * 60; this.adapt(); }
      // Fatigue builds over the match (faster for low-stamina players and while sprinting) and caps how far stamina recovers.
      const mins = (dt * this.clockRate) / 60;
      for (const p of this.players) {
        if (p.off) continue;
        p.fatigue = Math.min(0.6, p.fatigue + mins * (0.0016 + 0.0034 * (1 - p.a.stamina)) * (p.sprinting ? 2.5 : 1) * (p.role === 'GK' ? 0.3 : 1));
        if (p.stamina > 1 - p.fatigue) p.stamina = 1 - p.fatigue;
      }
      // The fourth official holds up the board a minute before the end of the half.
      if (this.addedTime === 0 && this.clock >= halfLength(this.half) - 60) {
        this.addedTime = clamp(Math.round(1 + this.stoppage / 60), 1, 6);
        this.emit('addedtime', { power: this.addedTime });
      }
      if (this.clock >= halfLength(this.half) + this.addedTime * 60) {
        this.halfEndGrace += dt;
        const danger = this.phase === 'play' && (this.ball.flight === 'shot' || Math.abs(this.ball.pos.x) > PITCH.halfLength - 25);
        if (!danger || this.halfEndGrace > MATCH.halfEndGrace || this.phase === 'restart') {
          this.endHalf();
          return;
        }
      }
    }

    switch (this.phase) {
      case 'kickoff':
      case 'restart': {
        // Co-op: when the second human takes it, the restart runs with their control swapped in.
        // An injured player is treated (and perhaps carried off) before the restart is taken.
        if (this.injury && stepInjury(this, dt)) { this.moveAll(dt); break; }
        const r = this.restart, mt = r ? this.mates[r.team] : null;
        if (r && mt && mt.human && mt.pid === r.taker) {
          this.asMate(r.team, () => this.stepRestart(dt));
          this.pendingEvents[r.team] = [];
        } else this.stepRestart(dt);
        // The other human's presses during a restart are dropped (they are not taking it).
        this.matePending = [[], []];
        break;
      }
      case 'play':
        this.stepPlay(dt);
        break;
      case 'goal':
        if (this.shootout) { this.stepIdle(dt); break; }
        this.stepCelebration(dt);
        if (this.drill && this.phaseT > MATCH.goalCelebration * 0.6) {
          this.nextDrill();
          break;
        }
        if (this.phaseT > MATCH.goalCelebration) {
          const scorerTeam = this.goals[this.goals.length - 1].team;
          this.startKickoff((1 - scorerTeam) as TeamIndex);
        }
        break;
      case 'halftime':
      case 'fulltime':
        this.stepIdle(dt);
        break;
    }
    if (this.drill) this.stepDrill(dt);
    if (this.shootout) this.stepShootout(dt);
    if (this.phase !== 'play' && !this.shootout && (this.pendingSubs.length || this.phase === 'restart')) this.stepSubs();
    // Fatigue caps how far stamina recovers, after this step's movement too.
    for (const p of this.players) if (p.stamina > 1 - p.fatigue) p.stamina = 1 - p.fatigue;
    this.stepPenKeeperBack();
    this.keepLocks();
  }

  /**
   * Daily scenarios: pick the match up part of the way through: this half and clock (football
   * seconds into the half), this score, these players already sent off, and a kick-off.
   */
  startFrom(half: Half, clock: number, score: [number, number], kickoff: TeamIndex, offs: number[] = []) {
    this.half = half;
    this.clock = clock;
    this.score = [score[0], score[1]];
    this.addedTime = 0;
    this.stoppage = 0;
    this.adaptNextAt = halfStart(half) + clock + ADAPTIVE.everyMinutes * 60;
    // The goals so far, spread through the time played (scored by each side's striker).
    const played = Math.max(1, Math.floor((halfStart(half) + clock) / 60) - 1);
    this.goals = [];
    for (const t of [0, 1] as TeamIndex[]) for (let i = 0; i < score[t]; i++) {
      const st = this.players.find((p) => p.team === t && p.role === 'ST')!;
      this.goals.push({ team: t, player: st.id, minute: Math.max(1, Math.round(((i + 1) * played) / (score[t] + 1)) + t * 3), ownGoal: false });
      this.pstats[st.id].goals++;
    }
    this.goals.sort((a, b) => a.minute - b.minute);
    for (const id of offs) {
      const p = this.players[id];
      if (!p || p.role === 'GK') continue;
      p.off = true; p.cards = 2; this.stats[p.team].reds++; this.pstats[id].red++;
    }
    // Legs are heavier late in the game.
    const k = (halfStart(half) + clock) / 5400;
    for (const p of this.players) { p.fatigue = Math.min(0.3, 0.3 * k); p.stamina = Math.min(p.stamina, 1 - p.fatigue); }
    this.startKickoff(kickoff);
  }

  /** Be a Pro: control always comes back to your player (unless he has been sent off). */
  private keepLocks() {
    for (const c of this.ctrl) {
      if (!isLocked(c)) continue;
      if (this.players[c.lock!].off) { c.lock = -1; continue; }
      if (c.pid !== c.lock) c.pid = c.lock!;
    }
  }

  // ---------------------------------------------------------------- adaptive difficulty

  setAdaptive(level: number) {
    this.adaptiveLevel = clamp(level, ADAPTIVE.min, ADAPTIVE.max);
    this.adaptiveLevelParams = adaptiveParams(this.adaptiveLevel);
  }

  /**
   * Every few minutes an Adaptive computer side looks at the game: if the human side is ahead on goals
   * or creating more, it sharpens up (towards World class); if it is running away with it, it eases off a little.
   */
  private adapt() {
    for (const team of [0, 1] as TeamIndex[]) {
      if (this.cfg.difficulty[team] !== 'adaptive' || this.ctrl[team].human) continue;
      const opp = (1 - team) as TeamIndex;
      const gd = this.score[opp] - this.score[team];
      const sd = (this.stats[opp].onTarget - this.stats[team].onTarget) / 3;
      const perf = clamp(gd + sd, -2, 2);
      if (Math.abs(perf) < 0.3) continue;
      const prev = this.adaptiveLevel;
      this.setAdaptive(prev + ADAPTIVE.step * perf);
      if (Math.abs(this.adaptiveLevel - prev) > 0.01) this.debugLog(`adaptive: level ${prev.toFixed(2)} -> ${this.adaptiveLevel.toFixed(2)}`);
    }
  }

  // ---------------------------------------------------------------- substitutions

  get maxSubs() { return this.cfg.practice || this.cfg.street ? 0 : this.cfg.maxSubs ?? 5; }
  subsUsed(team: number) { return this.subsLog.filter((s) => s[0] === team).length; }
  /** Bench players still available (index into bench[team]). */
  benchFree(team: number) { return this.bench[team].map((_, i) => i).filter((i) => !this.subsLog.some((s) => s[0] === team && s[2] === i)); }

  /**
   * Ask for a substitution: `id` comes off for bench player `bench`. It is made at the next stoppage
   * (straight away if the ball is already dead). Keepers are replaced only by the bench keeper and
   * outfield players only by outfield substitutes. Returns false if it is not allowed.
   */
  requestSub(team: TeamIndex, id: number, bench: number): boolean {
    const p = this.players[id];
    if (!p || p.team !== team || p.off || this.shootout) return false;
    if (this.subsUsed(team) + this.pendingSubs.filter((s) => s.team === team).length >= this.maxSubs) return false;
    if (!this.benchFree(team).includes(bench) || this.pendingSubs.some((s) => (s.team === team && s.bench === bench) || s.id === id)) return false;
    if ((p.role === 'GK') !== (this.bench[team][bench].role === 'GK')) return false;
    this.pendingSubs.push({ team, id, bench });
    if (this.phase !== 'play') this.stepSubs();
    return true;
  }

  private stepSubs() {
    for (const s of this.pendingSubs.splice(0)) this.makeSub(s.team, s.id, s.bench);
    // The computer manages its own team: from the hour mark, tired players come off at stoppages (up to three changes).
    if (this.phase !== 'restart' || this.half < 2 || this.clock < 15 * 60 || this.cfg.practice) return;
    for (const team of [0, 1] as TeamIndex[]) {
      if (this.ctrl[team].human || this.subsUsed(team) >= Math.min(3, this.maxSubs)) continue;
      if (this.restart && this.restart.taker >= 0 && this.players[this.restart.taker].team === team && this.subsUsed(team) > 0 && this.rng.chance(0.5)) continue;
      const tired = this.teamPlayers(team).filter((p) => p.role !== 'GK' && p.fatigue > 0.28 && p.id !== this.restart?.taker).sort((a, b) => b.fatigue - a.fatigue)[0];
      if (!tired) continue;
      const free = this.benchFree(team).filter((i) => this.bench[team][i].role !== 'GK');
      if (!free.length) continue;
      const group = (r: string) => (r === 'GK' ? 0 : ['RB', 'RCB', 'LCB', 'LB'].includes(r) ? 1 : ['CDM', 'RCM', 'LCM'].includes(r) ? 2 : r === 'ST' ? 4 : 3);
      const pick = free.find((i) => group(this.bench[team][i].role) === group(tired.role)) ?? free[0];
      this.makeSub(team, tired.id, pick);
    }
  }

  private makeSub(team: TeamIndex, id: number, bench: number) {
    const p = this.players[id];
    if (p.off || !this.benchFree(team).includes(bench)) return;
    const out = p.def;
    const def = { ...this.bench[team][bench], role: p.role };
    const minute = Math.floor(this.displayClock / 60);
    this.statsOff.push({ ...this.pstats[id], to: minute });
    this.pstats[id] = newPlayerStats(id, team, def, p.role, minute);
    const a = def.attrs;
    p.def = def;
    p.a = { pace: a.pace / 100, acceleration: a.acceleration / 100, stamina: a.stamina / 100, control: a.control / 100, passing: a.passing / 100, shooting: a.shooting / 100, tackling: a.tackling / 100, goalkeeping: a.goalkeeping / 100 };
    p.stamina = 1;
    p.fatigue = 0;
    p.cards = 0;
    p.burst = 0;
    this.subsLog.push([team, p.slot, bench]);
    this.stoppage += 20;
    this.emit('sub', { team, player: id, text: `${out.short}>${def.short}` });
  }

  // ---------------------------------------------------------------- penalty shootout

  private startShootout() {
    this.shootout = { kicks: [[], []], team: this.firstKickoff, winner: -1 };
    this.emit('pen', { text: 'start' });
    this.nextPenalty();
  }

  /** Penalty takers in order: best finishers first, then round the team again (keepers last). */
  private penTaker(team: TeamIndex, n: number) {
    // The chosen penalty taker goes first, then the best penalty takers (keepers last).
    const ch = chosenTaker(this.teamPlayers(team), this.cfg.tactics?.[team]?.takers, 'pen');
    const score = (p: Player) => (ch && p.id === ch.id ? 1000 : 0) + (SP_ON.ratings ? setPieceRatings(p.def).pen : p.a.shooting * 99);
    const squad = this.teamPlayers(team).filter((p) => !p.off).sort((a, b) => (a.role === 'GK' && a !== ch ? 1 : 0) - (b.role === 'GK' && b !== ch ? 1 : 0) || score(b) - score(a));
    return squad[n % squad.length].id;
  }

  private nextPenalty() {
    const so = this.shootout!;
    const t = so.team;
    for (const p of this.players) { p.action = { type: 'none', t: 0, dur: 0 }; p.vel = { x: 0, z: 0 }; p.burst = 0; p.beaten = 0; p.queued = null; }
    const spot = { x: PITCH.halfLength - PITCH.penaltySpot, z: 0 };
    this.award('penalty', t, spot, false, this.penTaker(t, so.kicks[t].length));
    const r = this.restart!;
    const targets = restartTargets(this, r);
    this.shootoutSpots(r, targets);
    for (const p of this.players) if (!p.off) { p.pos = { ...targets[p.id] }; p.facing = angleOf(r.spot.x - p.pos.x, r.spot.z - p.pos.z); }
    // The taker walks up on his own from the group on the halfway line (20 Nov 2026).
    const tk = this.players[r.taker];
    if (SP_ON.shootout) { tk.pos = { x: 18, z: 0.5 }; tk.facing = 0; }
    else this.players[r.taker].facing = 0;
    this.resetBall(r.spot);
    this.soRestart = r;
    this.soT = 0;
    this.soWait = -1;
  }

  /** Decided when one side cannot catch up within five kicks each, or after an equal number of sudden-death kicks. */
  private shootoutWinner(): -1 | TeamIndex {
    return shootoutWinnerOf(this.shootout!.kicks);
  }

  private penResult(scored: boolean) {
    const so = this.shootout!;
    if (this.soWait >= 0) return;
    if (!scored && this.penRetake && this.penRetake.due > 0) {
      this.penRetake = null;
      this.emit('call', { team: so.team, text: 'retake' });
      this.emit('whistle', { power: 1, text: 'foul' });
      this.nextPenalty();
      return;
    }
    this.penRetake = null;
    const b = this.ball;
    so.kicks[so.team].push(scored);
    this.emit('pen', { team: so.team, player: this.soRestart?.taker ?? -1, text: scored ? 'scored' : 'missed' });
    if (scored) { this.emit('goal', { team: so.team, player: b.lastTouch, text: 'pen' }); this.emit('whistle', { power: 1, text: 'goal' }); }
    b.state = 'dead';
    b.owner = -1;
    this.restart = null;
    this.phase = 'goal';
    this.phaseT = 0;
    this.soWait = 0;
  }

  private stepShootout(dt: number) {
    const so = this.shootout!;
    if (so.winner >= 0) return;
    if (this.soWait >= 0) {
      this.soWait += dt;
      if (this.soWait < 1.8) return;
      so.winner = this.shootoutWinner();
      if (so.winner >= 0) {
        this.phase = 'fulltime';
        this.phaseT = 0;
        this.emit('whistle', { power: 3, text: 'fulltime' });
        this.emit('fulltime', { team: so.winner, text: 'pens' });
        return;
      }
      so.team = (1 - so.team) as TeamIndex;
      this.nextPenalty();
      return;
    }
    if (this.phase === 'kickoff') { this.nextPenalty(); return; }
    if (this.phase !== 'play') return;
    this.soT += dt;
    const b = this.ball;
    const taker = this.soRestart?.taker ?? -1;
    const keeperHas = b.owner >= 0 && this.players[b.owner].team !== so.team;
    const touchedByOther = b.lastTouch >= 0 && b.lastTouch !== taker && this.players[b.lastTouch].team !== so.team;
    const slow = this.soT > 1.2 && Math.hypot(b.vel.x, b.vel.z) < 2;
    // Over once the keeper holds it, it has been saved and is not going in, it stops, or after a few seconds.
    if (keeperHas || (touchedByOther && this.soT > 1.6) || slow || this.soT > 4) this.penResult(false);
  }

  // ---------------------------------------------------------------- practice drills

  private drillRestart: Restart | null = null;
  private drillT = 0;
  /** Practice: the set piece on repeat (or the ball control drill), or null for open play and normal matches. */
  get drill(): 'freekick' | 'penalty' | 'crosses' | 'crossbar' | 'targets' | 'control' | null {
    const p = this.cfg.practice;
    return p === 'freekick' || p === 'penalty' || p === 'crosses' || p === 'crossbar' || p === 'targets' || p === 'control' ? p : null;
  }
  /** The ball control drill in progress (Practice > Ball control drill), or null. */
  ctlDrill: ControlDrillState | null = null;
  /** Attempts started in this practice session (a challenge ends after cfg.challenge of them). */
  drillAttempts = 0;

  /** Crossing drill: a winger whips the ball in for your striker to head or volley, against two defenders and the keeper. */
  private setupCross() {
    const dir = this.attackDir(0);
    const side = this.rng.chance(0.5) ? 1 : -1;
    const keep = new Set<string>(['0:ST', `0:${side > 0 ? 'RW' : 'LW'}`, '0:LCM', '1:GK', '1:RCB', '1:LCB']);
    for (const p of this.players) {
      p.action = { type: 'none', t: 0, dur: 0 }; p.vel = { x: 0, z: 0 }; p.burst = 0; p.beaten = 0; p.queued = null;
      p.off = !keep.has(`${p.team}:${p.role}`);
      if (p.off) p.pos = { x: 0, z: (p.team ? 1 : -1) * 60 };
    }
    const at = (team: number, role: string) => this.players.find((p) => p.team === team && p.role === role)!;
    const W = (x: number, z: number) => ({ x: dir * x, z });
    const st = at(0, 'ST'), cm = at(0, 'LCM'), wing = at(0, side > 0 ? 'RW' : 'LW');
    st.pos = W(this.rng.range(34, 38), -side * this.rng.range(1, 6));
    cm.pos = W(30, side * 3);
    wing.pos = W(46, side * 27);
    at(1, 'RCB').pos = W(this.rng.range(44, 47), this.rng.range(-1, 3));
    at(1, 'LCB').pos = W(this.rng.range(44, 47), this.rng.range(-4, 0));
    const gk = this.keeper(1);
    gk.pos = W(51.5, side * 1.5);
    for (const p of [st, cm]) p.facing = angleOf(dir, 0);
    gk.facing = angleOf(-dir, 0);
    // The cross: aimed between the penalty spot and the six-yard box, with the usual error.
    const b = this.ball;
    this.resetBall(W(46.5, side * 26.2));
    const target = W(this.rng.range(41, 46), -side * this.rng.range(-1, 4));
    const res = solveLob({ kicker: wing, ballPos: { ...b.pos }, pressure: 0, rng: this.rng }, target, 'cross');
    b.vel = res.vel; b.spin = res.spin; b.state = 'flight'; b.flight = 'cross'; b.owner = -1; b.receiver = st.id;
    b.lastTouch = wing.id; b.lastTouchTeam = 0; b.kicker = wing.id; b.kickLock = 0.3; b.stillTime = 0;
    this.lastKickTime = this.time;
    this.lastKickHelp = 0;
    this.offside.flagged.clear();
    this.restart = null;
    this.phase = 'play';
    this.phaseT = 0;
    this.ctrl[0].pid = st.id;
    this.emit('kick', { player: wing.id, team: 0, power: Math.hypot(b.vel.x, b.vel.y, b.vel.z), x: b.pos.x, z: b.pos.z, text: 'cross' });
  }

  /** Set up the next attempt: everyone placed at once, the ball on a new spot (free kicks vary). */
  nextDrill() {
    if (this.drill === 'control') {
      // One continuous 60-second drill: set it up once.
      if (!this.ctlDrill) { this.drillAttempts = 1; this.ctlDrill = setupControlDrill(this); }
      return;
    }
    if (this.cfg.challenge && this.drillAttempts >= this.cfg.challenge) {
      // Challenge over: the score is the goals from the attempts.
      if ((this.phase as string) === 'fulltime') return;
      this.restart = null;
      this.ball.state = 'dead';
      this.ball.owner = -1;
      this.phase = 'fulltime';
      this.phaseT = 0;
      this.emit('whistle', { power: 3, text: 'fulltime' });
      this.emit('fulltime', { team: 0, power: this.score[0], text: 'challenge' });
      return;
    }
    this.drillAttempts++;
    this.drillT = 0;
    this.drillRestart = null;
    if (this.drill === 'crosses') { this.setupCross(); return; }
    const dir = this.attackDir(0);
    let spot: V2;
    if (this.skill) {
      // Skill games: the striker alone with the goal (and no keeper).
      this.skill.done = false;
      spot = skillSpot(this.skill.game as SkillGame, dir, () => this.rng.next());
      for (const p of this.players) { p.off = !(p.team === 0 && p.role === 'ST'); if (p.off) p.pos = { x: 0, z: (p.team ? 1 : -1) * 60 }; }
    } else if (this.drill === 'penalty') spot = { x: dir * (PITCH.halfLength - PITCH.penaltySpot), z: 0 };
    else spot = { x: dir * (PITCH.halfLength - this.rng.range(17, 30)), z: this.rng.range(-17, 17) };
    for (const p of this.players) { p.action = { type: 'none', t: 0, dur: 0 }; p.vel = { x: 0, z: 0 }; p.burst = 0; p.beaten = 0; }
    this.award(this.drill === 'penalty' ? 'penalty' : 'freekick', 0, spot);
    const r = this.restart!;
    const targets = restartTargets(this, r);
    for (const p of this.players) if (!p.off) { p.pos = { ...targets[p.id] }; p.facing = angleOf(r.spot.x - p.pos.x, r.spot.z - p.pos.z); }
    this.players[r.taker].facing = angleOf(dir * PITCH.halfLength - r.spot.x, -r.spot.z);
    this.resetBall(r.spot);
    this.drillRestart = r;
    this.drillT = 0;
  }

  /** The attempt is over once it is saved and held, out of play, or has run for a few seconds. */
  private stepDrill(dt: number) {
    if (this.phase === 'kickoff' && !this.ctlDrill) { this.nextDrill(); return; }
    if (this.ctlDrill) {
      if ((this.phase as string) === 'fulltime') return;
      if (stepControlDrill(this, this.ctlDrill, dt)) {
        // Time up: the points are the score.
        this.ball.state = 'dead'; this.ball.owner = -1;
        this.phase = 'fulltime'; this.phaseT = 0;
        this.emit('whistle', { power: 3, text: 'fulltime' });
        this.emit('fulltime', { team: 0, power: this.score[0], text: 'challenge' });
      }
      return;
    }
    if (this.phase === 'restart') {
      if (this.restart !== this.drillRestart && this.phaseT > 1.2) this.nextDrill();
      return;
    }
    if (this.phase !== 'play') return;
    this.drillT += dt;
    const b = this.ball;
    const kept = b.state === 'held' && b.owner >= 0 && this.players[b.owner].team === 1;
    const cleared = b.owner >= 0 && this.players[b.owner].team === 1 && this.drillT > 2.5;
    if (this.drillT > (this.drill === 'crosses' ? 5.5 : 7) || (kept && this.drillT > 1.5) || cleared) this.nextDrill();
  }

  // ---------------------------------------------------------------- restart

  private stepRestart(dt: number) {
    const r = this.restart!;
    r.t += dt;
    this.stepWallJumps(dt);
    this.stepBodyActions(dt, this.restart?.taker ?? -1);
    if (r.type === 'freekick') this.humanWall(r, dt);
    // Their set piece: the switch button cycles your defender (a free-kick wall uses it for its size).
    const dteam = (1 - r.team) as TeamIndex;
    if (SW.setpiece && this.phase === 'restart' && this.ctrl[dteam].human && this.pendingEvents[dteam].some((e) => e.k === 'switch' && e.x === undefined)) {
      this.pendingEvents[dteam] = this.pendingEvents[dteam].filter((e) => !(e.k === 'switch' && e.x === undefined));
      this.defendSetPiece(r, true);
    }
    if (r.type === 'penalty') this.humanPenaltyKeeper(r, dt);
    const targets = restartTargets(this, r);
    if (r.type === 'penalty') this.penaltyKeeperSpot(r, targets);
    if (this.shootout && r.type === 'penalty') this.shootoutSpots(r, targets);
    // Set pieces are struck after a run-up: the taker sets up a few strides back from the ball.
    const kickPos = { ...targets[r.taker] };
    const rs = r.type === 'freekick' ? r.runStyle ?? 0 : 0;
    const runD = this.phase === 'kickoff' ? 0 : r.type === 'freekick' && rs ? [3.0, 4.6, 1.8, 3.2][rs] : runupDistance(r.type);
    if (runD > 0) targets[r.taker] = runupStart(kickPos, r.spot, runD, rs === 3 ? 0 : footProfile(this.players[r.taker].def).foot);
    if (runD > 0 && PITCH.walls) targets[r.taker] = clampToPitch(targets[r.taker], 0.4); // the run-up starts inside the cage
    if (r.type === 'freekick') this.freeKickExtras(r, targets, dt);
    // Ball is retrieved to the spot after a short pause (instantly for kick-offs).
    if (r.t > 0.6 || this.phase === 'kickoff') {
      if (this.ball.pos.x !== r.spot.x || this.ball.pos.z !== r.spot.z) this.resetBall(r.spot);
      if (r.type === 'throwin') this.ball.pos.y = 2.0;
    } else {
      stepBall(this.ball, dt, false);
    }

    if (!r.ready && this.quickRestart(r, targets)) {
      // Taken quickly: the kick below goes before everyone is set.
    } else if (!r.ready) {
      let allIn = true;
      for (const p of this.players) {
        if (p.off) continue;
        const T = targets[p.id];
        // Opponents caught inside the area at a goal kick hurry out of it.
        const clearing = r.type === 'goalkick' && p.team !== r.team && this.inPenaltyArea(r.team, p.pos, 1);
        this.arrive(p, T, this.shootout && p.id === r.taker ? 'jog' : p.id === r.taker || clearing ? 'sprint' : 'jog');
        if (dist(p.pos, T) > 1.2 && (!this.shootout || p.id === r.taker)) allIn = false;
      }
      this.moveAll(dt);
      // Shootouts: the taker walks up from the halfway line (a kick button hurries a human taker up).
      if (this.shootout && SP_ON.shootout && r.type === 'penalty' && !allIn && r.t < 7.5) {
        const tc = this.ctrl[r.team];
        if (tc.human && tc.pid === r.taker && this.pendingEvents[r.team].some(isKickEvent)) { this.pendingEvents[r.team] = []; this.players[r.taker].pos = { ...targets[r.taker] }; }
        return;
      }
      if (allIn || r.t > MATCH.restartSetupMax || this.phase === 'kickoff') {
        let snapped = 0;
        // Kick-offs line everyone up. Otherwise stragglers keep running into position after the
        // whistle; only the taker, and opponents still inside the required distance, are placed.
        const minDist = r.type === 'throwin' ? 2 : r.type === 'dropball' ? 0 : PITCH.restartDistance;
        for (const p of this.players) {
          if (p.off || dist(p.pos, targets[p.id]) <= 1.2) continue;
          // Goal kicks: opponents must also be outside the penalty area until the ball is in play.
          const mustPlace = this.phase === 'kickoff' || p.id === r.taker || (p.team !== r.team && (dist(p.pos, r.spot) < minDist || (r.type === 'goalkick' && this.inPenaltyArea(r.team, p.pos, 0.5))));
          if (mustPlace) { snapped++; p.pos = { ...targets[p.id] }; p.vel = { x: 0, z: 0 }; }
        }
        if (snapped > 0 && this.phase !== 'kickoff') this.debugLog(`restart ${r.type}: placed ${snapped} player(s) directly after setup timeout`);
        r.ready = true;
        r.readyT = 0;
        // Pressure on the taker: a wobble in the timing ring for a nervous one (penalties and free kicks).
        if (r.type === 'penalty' || r.type === 'freekick') r.shake = ringShake(matchPressure(this, r.team), setPieceRatings(this.players[r.taker].def).comp);
        // The computer varies its corners.
        if (r.type === 'corner' && !this.ctrl[r.team].human) r.routine = Math.floor(this.rng.next() * ROUTINES.corner.length);
        r.aim = this.defaultAim(r);
        // Their set piece near your goal: you start on the defender nearest the danger.
        if (this.phase === 'restart') this.defendSetPiece(r, false);
        // The referee whistles for kick-offs, free kicks, penalties and corners to be taken.
        if (r.type !== 'throwin' && r.type !== 'goalkick' && r.type !== 'dropball') this.emit('whistle', { power: 1, text: this.phase === 'kickoff' ? 'kickoff' : r.type === 'penalty' ? 'penalty' : 'restart' });
      }
      return;
    }

    r.readyT += dt;
    const taker = this.players[r.taker];
    // Everyone holds position; the taker faces the aim direction.
    for (const p of this.players) {
      if (p.id === r.taker || p.off) continue;
      const clearing = r.type === 'goalkick' && p.team !== r.team && this.inPenaltyArea(r.team, p.pos, 1);
      this.arrive(p, targets[p.id], clearing || dist(p.pos, targets[p.id]) > 10 ? 'sprint' : 'jog');
    }
    const c = this.ctrl[taker.team];
    const humanTaker = c.human && c.pid === taker.id;
    taker.wish = { x: 0, z: 0, mode: 'walk', face: null };
    if (humanTaker) {
      // The stick moves a target: on the pitch for free kicks, corners and throw-ins, along the goal line for penalties.
      if (Math.hypot(c.input.mx, c.input.mz) > 0.15) {
        // Free kick with the modifier held: the stick bends the shot (across the line) and adds dip (towards goal).
        if (r.type === 'freekick' && !r.quick && c.input.jockey) this.bendFreeKick(r, taker, c.input, dt);
        else if (r.type === 'penalty') r.aim.z = clamp(r.aim.z + c.input.mz * MATCH.penaltyAimSpeed * dt, -PITCH.goalHalfWidth + 0.2, PITCH.goalHalfWidth - 0.2);
        else r.aim = clampToPitch({ x: r.aim.x + c.input.mx * MATCH.aimSpeed * dt, z: r.aim.z + c.input.mz * MATCH.aimSpeed * dt }, 0.5);
      }
      if (dist(r.aim, taker.pos) > 0.5) taker.facing = angleOf(r.aim.x - taker.pos.x, r.aim.z - taker.pos.z);
    }
    this.moveAll(dt);
    // The taker waits a few strides back from the ball (run-up) and runs in to strike it.
    const standPos = targets[taker.id];
    if (r.runup && taker.action.type !== 'kick' && taker.action.type !== 'throw') {
      const ru = r.runup;
      if (taker.action.type !== 'none') taker.action = { type: 'none', t: 0, dur: 0 };
      if (ru.wait !== undefined && ru.wait > 0) { this.stepDummyRun(r, ru, dt); return; }
      ru.t += dt;
      const to = { x: kickPos.x - taker.pos.x, z: kickPos.z - taker.pos.z };
      const left = Math.hypot(to.x, to.z);
      const vmax = ru.req.kind === 'shot' || r.type === 'goalkick' ? PLAYER.runupSpeed : PLAYER.runupSpeed * 0.82;
      let v = Math.min(vmax, 1.2 + PLAYER.runupAccel * ru.t, left / dt);
      // Stutter (penalties): a check part of the way in, then on again; the keeper may go first.
      if (r.type === 'penalty' && r.stutter && left < SETPIECE.stutterAt) {
        ru.check ??= 0;
        if (ru.check === 0) this.penStutter(r);
        if (ru.check < SETPIECE.stutterTime) { ru.check += dt; v = 0.35; ru.t = Math.min(ru.t, 0.25); }
      }
      if (left < 0.05 || ru.t > 2 + (ru.check ?? 0)) {
        taker.pos = { ...kickPos };
        taker.vel = { x: (to.x / Math.max(left, 1e-6)) * v * 0.6, z: (to.z / Math.max(left, 1e-6)) * v * 0.6 };
        if (ru.face !== undefined) taker.facing = ru.face;
        const req = ru.req;
        r.runup = undefined;
        // A human taker can still change his mind about the corner during the run-up (seeing the keeper go).
        if (r.type === 'penalty' && humanTaker && req.target && req.kind === 'shot') {
          req.target = { ...req.target, z: clamp(r.aim.z, -PITCH.goalHalfWidth + 0.15, PITCH.goalHalfWidth - 0.15) };
          taker.facing = angleOf(req.target.x - taker.pos.x, req.target.z - taker.pos.z);
        }
        this.startKick(taker, req, false);
      } else {
        taker.vel = { x: (to.x / left) * v, z: (to.z / left) * v };
        taker.pos = { x: taker.pos.x + taker.vel.x * dt, z: taker.pos.z + taker.vel.z * dt };
        // Square up to the kick over the last stride.
        const runF = angleOf(to.x, to.z);
        const k = ru.face === undefined ? 0 : clamp(1 - left / 1.4, 0, 1);
        taker.facing = ru.face === undefined ? runF : wrapAngle(runF + wrapAngle(ru.face - runF) * k);
      }
      return;
    }
    if (taker.action.type === 'kick' || taker.action.type === 'throw') {
      taker.pos = { ...kickPos };
      taker.vel = { x: taker.vel.x * Math.max(0, 1 - dt * 6), z: taker.vel.z * Math.max(0, 1 - dt * 6) };
      this.stepActions(dt);
      return;
    }
    // A taker still down from a dive or a fall gets up before the restart is taken.
    const at = taker.action.type;
    if (at === 'dive' || at === 'down' || at === 'stumble' || at === 'slide') return;
    taker.pos = { ...standPos };
    taker.vel = { x: 0, z: 0 };
    if (!humanTaker && runD > 0) taker.facing = angleOf(r.spot.x - taker.pos.x, r.spot.z - taker.pos.z);
    let req: KickRequest | null = null;
    if (humanTaker) {
      const evs = this.pendingEvents[taker.team];
      this.pendingEvents[taker.team] = [];
      // The switch button cycles the corner or free-kick routine; teammates move into position for it.
      if ((r.type === 'corner' || r.type === 'freekick' || this.longThrowOn(r)) && !r.quick && evs.some((x) => x.k === 'switch' && x.x === undefined)) {
        const list = ROUTINES[r.type as 'corner' | 'freekick' | 'throwin'];
        r.routine = ((r.routine ?? 0) + 1) % list.length;
        if (r.type === 'throwin') {
          // The long-throw specialist comes over to take it (or the nearest player again for a short one).
          const tk = r.routine === 1 ? longThrower(this, r.team).id : this.pickTaker('throwin', r.team, r.spot);
          if (tk !== r.taker) { r.taker = tk; c.pid = tk; r.ready = false; r.t = Math.min(r.t, 0.7); this.emit('switch', { team: r.team, player: tk }); }
        }
        r.aim = this.defaultAim(r);
        r.readyT = Math.min(r.readyT, 0.5);
        this.emit('call', { team: taker.team, text: `routine:${r.type}`, power: r.routine });
        if (!r.ready) return;
      }
      // Direct free kick: the skill button goes through the run-ups (standard, long, short, straight on).
      if (r.type === 'freekick' && !r.quick && SP_ON.knuckle && wallFor(this, r) && evs.some((x) => x.k === 'skill')) {
        r.runStyle = ((r.runStyle ?? 0) + 1) % 4;
        r.readyT = Math.min(r.readyT, 0.5);
        this.emit('call', { team: taker.team, player: taker.id, text: 'runup', power: r.runStyle });
      }
      // Penalty: the skill button (or a fake shot) switches a stutter run-up on and off.
      if (r.type === 'penalty' && SP_ON.techniques && evs.some((x) => x.k === 'skill')) {
        r.stutter = !r.stutter;
        this.emit('call', { team: taker.team, player: taker.id, text: 'stutter', power: r.stutter ? 1 : 0 });
      }
      const e = evs.find(isKickEvent);
      if (e) req = r.quick ? this.quickRestartKick(r, taker, e, c.input) : this.aimedRestartKick(r, taker, e);
      // Free kicks and penalties: the timing ring at the moment of the kick sets its accuracy.
      if (req && e && (r.type === 'freekick' || r.type === 'penalty') && !r.quick) req.accuracy = timingAccuracy(shakyRing(r.readyT, r.shake ?? 0));
      if (r.type === 'kickoff' && req?.kind === 'shot') req = { ...req, kind: 'pass', target: { x: r.aim.x, y: 0, z: r.aim.z } };
      if (!req && r.readyT > MATCH.humanRestartTimeout) req = chooseRestartKick(this, r, true);
    } else if (r.readyT > 0.8 + levelOf(this, taker.team).reaction + restartUrgency(gameState(this, taker.team), r.type) - Math.min(0.6, runD * 0.16) + (r.type === 'freekick' && this.ctrl[1 - r.team].human && wallFor(this, r) ? 1.6 : 0)) {
      // (A human setting their wall gets a little longer before a computer free kick.)
      // (The computer starts its run-up a little earlier, so set pieces don't take longer than before.)
      req = chooseRestartKick(this, r);
    }
    if (req) {
      if (r.type === 'throwin') this.throwRequest(req, taker);
      if (r.type === 'penalty' && !humanTaker && req.stutter) r.stutter = true;
      if (runD > 0) {
        // Face the way the kick goes once at the ball: the aim (human) or the target (computer).
        const aimAt = humanTaker ? r.aim : req.target ? { x: req.target.x, z: req.target.z } : req.dir ? { x: kickPos.x + req.dir.x, z: kickPos.z + req.dir.z } : r.spot;
        const face = dist(aimAt, kickPos) > 0.3 ? angleOf(aimAt.x - kickPos.x, aimAt.z - kickPos.z) : undefined;
        r.runup = { req, t: 0, face };
        // Two over the ball: the other specialist runs over it first.
        if (r.type === 'freekick' && r.routine === 3 && SP_ON.routines && req.kind === 'shot' && wallFor(this, r)) {
          const d = secondTaker(this, r);
          if (d >= 0) { r.runup.wait = 0.65; r.runup.dummy = d; }
        }
      } else this.startKick(taker, req, r.type === 'throwin');
    }
  }

  /**
   * Quick restart: a human taking a throw-in, corner or free kick may play it as soon as the
   * taker is at the ball, before the others are set (opponents are not pushed back). Returns
   * true when the restart has just been made ready this way.
   */
  private quickRestart(r: Restart, targets: V2[]): boolean {
    if (this.phase !== 'restart' || (r.type !== 'throwin' && r.type !== 'corner' && r.type !== 'freekick')) return false;
    const taker = this.players[r.taker];
    const c = this.ctrl[taker.team];
    if (!c.human || !c.quickRestarts || c.pid !== taker.id) return false;
    const evs = this.pendingEvents[taker.team];
    const keepOthers = () => { this.pendingEvents[taker.team] = evs.filter((x) => !isKickEvent(x)); };
    if (r.t < 0.7) { keepOthers(); return false; }
    // Presses while the ball is still being fetched are dropped; after that a press is played
    // as soon as the taker reaches the ball.
    const kick = evs.some(isKickEvent);
    if (!kick) return false;
    if (dist(taker.pos, targets[taker.id]) > 1.5) return false; // taken the moment the taker reaches the ball
    taker.pos = { ...targets[taker.id] };
    taker.vel = { x: 0, z: 0 };
    r.ready = true;
    r.readyT = 0;
    r.quick = true;
    r.aim = this.defaultAim(r);
    return true;
  }

  /** A quick restart is played like open play: the stick picks the teammate, the charge the distance. */
  private quickRestartKick(r: Restart, taker: Player, e: InputEvent, input: InputFrame): KickRequest {
    const dir = this.attackDir(taker.team);
    let kind: KickKind = e.k === 'shoot' ? 'shot' : (e.k as KickKind);
    if (kind === 'shot' && r.type !== 'freekick') kind = 'pass';
    if (r.type === 'corner' && kind === 'lob') kind = 'cross';
    const m = Math.hypot(input.mx, input.mz);
    const d = m > 0.3 ? { x: input.mx / m, z: input.mz / m } : { x: Math.cos(taker.facing), z: Math.sin(taker.facing) };
    if (kind === 'shot') return { kind, power: e.p ?? 0.5, receiver: -1, dir: d, ...kickStyle(e), target: { x: dir * PITCH.halfLength, y: 0, z: aimFromInput(taker, dir, d.x, d.z) } };
    return { kind, power: e.p ?? 0.5, receiver: -1, dir: d, ...kickStyle(e) };
  }

  /**
   * Called run: the teammate best placed to go in behind (the way the stick points, if it does)
   * sprints past the defensive line. Pass soon, or they will be offside.
   */
  callRun(team: TeamIndex, carrier: Player) {
    const dir = this.attackDir(team);
    const c = this.ctrl[team];
    const m = Math.hypot(c.input.mx, c.input.mz);
    const u = m > 0.3 ? { x: c.input.mx / m, z: c.input.mz / m } : null;
    let best = -1, bs = -Infinity;
    for (const t of this.teamPlayers(team)) {
      if (t.id === carrier.id || t.role === 'GK' || t.action.type !== 'none') continue;
      const ahead = (t.pos.x - carrier.pos.x) * dir;
      if (ahead < -8) continue;
      let s = (t.pos.x * dir) / 20 + (t.role === 'ST' ? 1.2 : t.role === 'RW' || t.role === 'LW' ? 0.9 : t.role.endsWith('CM') ? 0.3 : 0) - dist(t.pos, carrier.pos) / 40;
      if (u) {
        const v = norm(t.pos.x - carrier.pos.x, t.pos.z - carrier.pos.z);
        s += 2.2 * (v.x * u.x + v.z * u.z);
      }
      if (s > bs) { bs = s; best = t.id; }
    }
    if (best < 0) return;
    this.calledRun[team] = { pid: best, until: this.time + MATCH.calledRunTime };
    const t = this.players[best];
    t.aiRunUntil = this.time + MATCH.calledRunTime;
    t.aiHoldUntil = this.time + MATCH.calledRunTime + 1.5;
    this.emit('call', { team, player: best });
  }

  /** Take control of your goalkeeper (the stick then moves him; shoot dives, pass comes for the ball). */
  takeKeeper(team: TeamIndex) {
    const c = this.ctrl[team];
    const gk = this.keeper(team);
    if (!c.human || gk.off || c.pid === gk.id || this.otherHuman(team) === gk.id || isLocked(c)) return;
    const cur = this.players[c.pid];
    if (this.ball.owner === cur.id) return;
    c.pid = gk.id;
    c.lastAutoSwitch = this.time;
    gk.queued = null;
    this.emit('switch', { team, player: gk.id, text: 'keeper' });
  }

  /** Hand the keeper back to the computer and take the best-placed outfield player. */
  leaveKeeper(team: TeamIndex) {
    const c = this.ctrl[team];
    const gk = this.players[c.pid];
    if (gk.role !== 'GK' || this.ball.owner === gk.id || isLocked(c)) return;
    const next = this.bestSwitchCandidate(team, gk.id);
    if (next < 0) return;
    c.pid = next;
    c.lastAutoSwitch = this.time;
    this.players[next].queued = null;
    this.carryOver(c, team);
    this.emit('switch', { team, player: next, text: 'auto' });
  }

  /** Manual keeper rush: the keeper comes off the line to the ball for a couple of seconds. */
  startKeeperRush(team: TeamIndex) {
    const gk = this.keeper(team);
    if (gk.off || (this.ball.owner === gk.id)) return;
    this.keeperRush[team] = this.time + MATCH.keeperRushTime;
    this.emit('rush', { team, player: gk.id });
  }

  /** Where the target starts when a human takes a restart: the AI's own choice, or the goal for shots. */
  private defaultAim(r: Restart): V2 {
    const dir = this.attackDir(r.team);
    if (r.type === 'penalty') return { x: dir * PITCH.halfLength, z: 0 };
    const ra = routineAim(this, r);
    if (ra) return clampToPitch(ra, 0.5);
    if (r.type === 'throwin' && r.routine === 1) return { x: dir * (PITCH.halfLength - 9), z: Math.sign(r.spot.z) * 3 };
    if (!this.ctrl[r.team].human) return { ...r.spot };
    if (r.type === 'corner') return { x: dir * (PITCH.halfLength - 7), z: 0 };
    const req = chooseRestartKick(this, r);
    const t = req.target ?? { x: r.spot.x + dir * 15, y: 0, z: r.spot.z };
    return clampToPitch({ x: t.x, z: t.z }, 0.5);
  }

  /** A human restart kick towards the target: passes go to the target, shots aim at its side of the goal. */
  private aimedRestartKick(r: Restart, taker: Player, e: InputEvent): KickRequest {
    const dir = this.attackDir(taker.team);
    let kind: KickKind = e.k === 'shoot' ? 'shot' : (e.k as KickKind);
    if (kind === 'shot') {
      const st = kickStyle(e);
      // Panenka: a soft chip down the middle, whatever the charge (a little higher with more of it).
      if (r.type === 'penalty' && st.variant === 'chip' && SP_ON.techniques) {
        return { kind: 'shot', power: clamp(SETPIECE.panenkaPower + 0.3 * ((e.p ?? 0.5) - 0.5), 0.15, 0.5), placed: false, variant: 'chip', target: { x: dir * PITCH.halfLength, y: 0, z: clamp(r.aim.z, -PITCH.goalHalfWidth + 0.15, PITCH.goalHalfWidth - 0.15) } };
      }
      // Knuckleball (20 Nov 2026): a direct free kick hit with the power-shot buttons goes without spin.
      if (r.type === 'freekick' && st.variant === 'power' && SP_ON.knuckle && wallFor(this, r)) {
        return { kind: 'shot', power: e.p ?? 0.7, placed: false, knuckle: true, target: { x: dir * PITCH.halfLength, y: 0, z: clamp(r.aim.z, -PITCH.goalHalfWidth + 0.15, PITCH.goalHalfWidth - 0.15) } };
      }
      const bend = r.type === 'freekick' && (r.curve !== undefined || r.dip !== undefined);
      return { kind: 'shot', power: e.p ?? 0.5, placed: false, variant: bend ? undefined : st.variant, target: { x: dir * PITCH.halfLength, y: 0, z: clamp(r.aim.z, -PITCH.goalHalfWidth + 0.15, PITCH.goalHalfWidth - 0.15) }, curve: bend ? r.curve ?? 0 : undefined, dip: bend ? r.dip ?? 0 : undefined };
    }
    if (r.type === 'corner' && kind === 'lob') kind = 'cross';
    let recv = -1, rd = 6;
    for (const t of this.teamPlayers(taker.team)) {
      if (t.id === taker.id || t.role === 'GK') continue;
      const d = dist(t.pos, r.aim);
      if (d < rd) { rd = d; recv = t.id; }
    }
    return { kind, receiver: recv, target: { x: r.aim.x, y: 0, z: r.aim.z }, exact: true, dir: { x: r.aim.x - taker.pos.x, z: r.aim.z - taker.pos.z } };
  }

  /**
   * Free-kick bend and dip (19 Nov 2026): with the modifier held, the part of the stick across the
   * line to the target bends the shot that way, and the part along it adds dip (pull back for less).
   */
  private bendFreeKick(r: Restart, taker: Player, input: InputFrame, dt: number) {
    const u = norm(r.aim.x - taker.pos.x, r.aim.z - taker.pos.z);
    const ux = u.x || this.attackDir(r.team), uz = u.z;
    const across = input.mx * -uz + input.mz * ux;
    const along = input.mx * ux + input.mz * uz;
    if (Math.abs(across) > 0.2) r.curve = clamp((r.curve ?? 0) + across * FREEKICK.bendRate * dt, -1, 1);
    if (Math.abs(along) > 0.2) r.dip = clamp((r.dip ?? 0) + along * FREEKICK.bendRate * dt, 0, 1);
  }

  /**
   * Turn a restart request into a throw: pass is a short throw to feet, lob a long looping throw,
   * through ball (or a shot button) down the line into space. Kept within the thrower's range.
   */
  private throwRequest(req: KickRequest, taker: Player) {
    if (req.kind !== 'throw') req.variant = req.kind === 'lob' || req.kind === 'cross' ? 'longthrow' : req.kind === 'through' || req.kind === 'shot' ? 'linethrow' : 'shortthrow';
    else if (!req.variant) req.variant = 'shortthrow';
    req.kind = 'throw';
    // Down the line: into space ahead of whoever is making the run up the touchline.
    if (req.variant === 'linethrow' && req.exact) { req.exact = undefined; req.target = undefined; req.receiver = undefined; req.dir = { x: this.attackDir(taker.team) * 0.96, z: -Math.sign(taker.pos.z) * 0.28 }; }
    if (req.target) {
      const max = req.variant === 'shortthrow' ? Math.min(18, throwRange(taker)) : throwRange(taker);
      const d = dist(taker.pos, req.target);
      if (d > max) {
        const k = max / d;
        req.target = { x: taker.pos.x + (req.target.x - taker.pos.x) * k, y: 0, z: taker.pos.z + (req.target.z - taker.pos.z) * k };
      }
    }
  }

  /**
   * While play is stopped (restarts, half-time, full-time) dives, falls, tackles and other body
   * actions still play out and end. They used to freeze until play restarted, so a keeper who dived
   * for a shot that went behind lay frozen mid-dive until the corner was taken. Nothing is resolved
   * or released here (a kick cut off by the whistle just ends); celebrations and wall jumps are
   * stepped elsewhere, and the restart taker's kick or throw is left to stepRestart (a taker who
   * dived, such as a keeper before his goal kick, still gets up first).
   */
  private stepBodyActions(dt: number, skip = -1) {
    for (const p of this.players) {
      const a = p.action;
      if (a.type === 'none' || a.type === 'jump' || a.type === 'celebrate') continue;
      if (p.id === skip && (a.type === 'kick' || a.type === 'throw')) continue; // the taker's restart kick
      a.t += dt;
      if (a.type === 'kick' || a.type === 'throw') a.released = true;
      if (a.t < a.dur) continue;
      if (a.type === 'dive') p.action = { type: 'down', t: 0, dur: 0.55 };
      else if (a.type === 'slide') p.action = { type: 'stumble', t: 0, dur: a.block ? PLAYER.slideDown * 0.55 : PLAYER.slideDown };
      else p.action = { type: 'none', t: 0, dur: 0 };
    }
  }

  /** Free-kick wall jumps advance here while play is stopped (stepActions runs them in open play). */
  private stepWallJumps(dt: number) {
    for (const p of this.players) {
      if (p.action.type !== 'jump') continue;
      p.action.t += dt;
      if (p.action.t >= p.action.dur) p.action = { type: 'none', t: 0, dur: 0 };
    }
  }

  /**
   * A human defending a free kick in range sets the wall: the stick slides it across, the switch
   * button changes how many stand in it (2 to 5), and the shoot button makes it jump.
   */
  private humanWall(r: Restart, dt: number) {
    const team = (1 - r.team) as TeamIndex;
    const c = this.ctrl[team];
    if (!c.human || r.quick) return;
    const w = wallFor(this, r);
    if (!w) return;
    if (!r.wall) r.wall = { n: wallSize(dist(r.spot, { x: this.ownGoalX(team), z: 0 })), shift: 0 };
    const along = c.input.mx * w.perp.x + c.input.mz * w.perp.z;
    if (Math.abs(along) > 0.2) r.wall.shift = clamp(r.wall.shift + along * MATCH.wallShiftSpeed * dt, -MATCH.wallShiftMax, MATCH.wallShiftMax);
    const evs = this.pendingEvents[team];
    this.pendingEvents[team] = [];
    for (const e of evs) {
      if (e.k === 'switch' && e.x === undefined) {
        r.wall.n = r.wall.n >= MATCH.wallMax ? MATCH.wallMin : r.wall.n + 1;
        this.emit('call', { team, text: 'wall', power: r.wall.n });
      } else if (e.k === 'shoot') this.wallJump(w.ids);
      else if (e.k === 'pass' && SP_ON.wall) {
        r.wall.lie = !r.wall.lie;
        this.emit('call', { team, text: 'lie', power: r.wall.lie ? 1 : 0 });
      }
    }
  }

  /**
   * Penalty keeper duel (20 Nov 2026): a human facing a penalty moves his keeper along the line with
   * the stick (dancing about puts the taker off) and dives with the shoot button: pointed left or
   * right he goes that way as the ball is struck, centred he stands tall. Going too early lets the
   * taker see it and put it the other way.
   */
  private humanPenaltyKeeper(r: Restart, dt: number) {
    const team = (1 - r.team) as TeamIndex;
    const c = this.ctrl[team];
    const gk = this.keeper(team);
    const g = r.gk;
    if (!g || !c.human || c.pid !== gk.id) return;
    const evs = this.pendingEvents[team];
    this.pendingEvents[team] = [];
    if (!r.ready) return;
    if (!g.commit && Math.abs(c.input.mz) > 0.2) {
      const before = g.shift;
      g.shift = clamp(g.shift + c.input.mz * SETPIECE.gkShiftSpeed * dt, -SETPIECE.gkShiftMax, SETPIECE.gkShiftMax);
      g.dance = clamp(g.dance + Math.abs(g.shift - before) * 0.9, 0, 1);
    }
    g.dance = Math.max(0, g.dance - dt * 0.22);
    for (const e of evs) {
      if (e.k !== 'shoot' || g.commit) continue;
      const side = Math.abs(c.input.mz) > 0.3 ? (Math.sign(c.input.mz) as -1 | 1) : 0;
      g.commit = { side, t: this.time };
      this.emit('call', { team, player: gk.id, text: 'gkcommit', power: side });
    }
  }

  /** Where the keeper facing a penalty stands: where a human has moved him, leaning the way he has gone early. */
  private penaltyKeeperSpot(r: Restart, targets: V2[]) {
    const team = (1 - r.team) as TeamIndex;
    const gk = this.keeper(team);
    const T = targets[gk.id];
    if (!T || gk.off) return;
    const pg = this.penGuess && this.penGuess.team === team && this.penGuess.early ? this.penGuess.side : 0;
    const lean = r.gk?.commit ? r.gk.commit.side : pg;
    targets[gk.id] = { x: T.x, z: clamp((r.gk?.shift ?? 0) + lean * 0.45, -1.4, 1.4) };
  }

  /**
   * Shootout positions: everyone but the taker and the keeper in goal stands arm in arm on the
   * halfway line (each side together), the other keeper waits by the edge of the area.
   */
  private shootoutSpots(r: Restart, targets: V2[]) {
    if (!SP_ON.shootout) return;
    const gkIn = this.keeper(1 - r.team);
    for (const t of [0, 1] as TeamIndex[]) {
      const squad = this.teamPlayers(t).filter((p) => p.id !== r.taker && p.id !== gkIn.id);
      let i = 0;
      for (const p of squad) {
        if (p.role === 'GK') { targets[p.id] = { x: PITCH.halfLength - 17, z: -19 }; continue; }
        targets[p.id] = { x: 0.6, z: (t === 0 ? -1 : 1) * (0.9 + i * 0.62) };
        i++;
      }
    }
  }

  /** The taker checks in his run-up: a computer keeper may go first (a good one waits). */
  private penStutter(r: Restart) {
    const team = (1 - r.team) as TeamIndex;
    const gk = this.keeper(team);
    this.emit('call', { team: r.team, player: r.taker, text: 'check' });
    if (r.gk?.commit || this.controlOf(gk)) return; // a human keeper decides for himself
    if (this.rng.chance(0.25 + 0.35 * gk.a.goalkeeping)) { this.penGuess = { team, side: 0, t: this.time, waited: true }; return; }
    this.penGuess = { team, side: this.rng.chance(0.5) ? 1 : -1, t: this.time, early: true };
  }

  /**
   * A computer taker at the moment of the kick: a keeper seen going early (or leaning after a
   * stutter) gets it put the other way, more surely by a composed taker.
   */
  private aiPenaltyRead(r: Restart, comp: number, aimZ: number): number {
    const g = r.gk?.commit;
    let side = 0, chance = 0;
    if (g && g.side !== 0) { side = g.side; chance = readEarlyKeeper(this.time - g.t, comp); }
    else if (this.penGuess?.early && this.penGuess.side !== 0) { side = this.penGuess.side; chance = 0.55 + 0.4 * (comp / 99); }
    if (side && Math.sign(aimZ) !== -side && this.rng.chance(chance)) return -side * this.rng.range(1.5, 2.4);
    // A keeper standing off-centre leaves more of the goal on one side.
    const sh = r.gk?.shift ?? 0;
    if (!side && Math.abs(sh) > 0.35 && Math.sign(aimZ) === Math.sign(sh) && this.rng.chance(Math.abs(sh) * 0.5)) return -Math.sign(sh) * this.rng.range(1.6, 2.5);
    return aimZ;
  }

  /** The penalty is struck: a human keeper who went early dives now; standing tall is remembered for his read. */
  private penaltyStruck(r: Restart) {
    const team = (1 - r.team) as TeamIndex;
    const gk = this.keeper(team);
    const g = r.gk?.commit;
    if (g && !gk.off) {
      if (g.side === 0) this.penGuess = { team, side: 0, t: g.t };
      else manualDive(this, gk, 0, g.side);
      // Off his line well before the kick: if he saves it, the referee orders a retake.
      if (g.side !== 0 && SP_ON.referee && this.time - g.t > SETPIECE.offLine) this.penRetake = { team: r.team, taker: r.taker, spot: { ...r.spot }, until: this.time + 2.5, due: -1 };
    }
    if (this.penKeeperBack?.team === team) this.penKeeperBack.at = this.time + 1.4;
  }

  /** After a penalty the human who was given his keeper gets an outfield player back (once the keeper has let go of the ball). */
  private stepPenKeeperBack() {
    const pk = this.penKeeperBack;
    if (!pk || this.time < pk.at) return;
    const c = this.ctrl[pk.team];
    const gk = this.keeper(pk.team);
    if (c.pid !== gk.id || this.shootout) { this.penKeeperBack = null; return; }
    if (this.phase !== 'play' && this.phase !== 'restart') return;
    if (this.ball.owner === gk.id || gk.action.type === 'dive' || gk.action.type === 'down' || (this.restart?.type === 'penalty')) return;
    this.penKeeperBack = null;
    this.leaveKeeper(pk.team);
  }

  /**
   * Free-kick extras before the kick (20 Nov 2026): the man lying behind the wall gets down, and a
   * computer wall facing a human taker creeps in until the referee pushes it back (a second time
   * earns a booking).
   */
  private freeKickExtras(r: Restart, targets: V2[], dt: number) {
    const w = wallFor(this, r);
    if (!w) return;
    if (w.lier >= 0 && w.lieSpot) {
      const l = this.players[w.lier];
      if (r.ready && l.action.type === 'none' && dist(l.pos, w.lieSpot) < 0.8) {
        l.pos = { ...w.lieSpot };
        l.vel = { x: 0, z: 0 };
        l.facing = angleOf(w.perp.x, w.perp.z);
        l.action = { type: 'down', t: 0, dur: 60 };
      }
      if (l.action.type === 'down') { l.pos = { ...w.lieSpot }; l.vel = { x: 0, z: 0 }; }
    }
    // Two over the ball: the dummy's run past the ball.
    if (r.runup?.dummy !== undefined && r.runup.wait !== undefined && r.runup.wait > 0) targets[r.runup.dummy] = { ...this.players[r.runup.dummy].pos };
    if (!SP_ON.referee || !r.ready || r.quick || r.runup) return;
    const c = this.ctrl[r.team];
    if (!c.human || this.ctrl[w.team].human || c.pid !== r.taker) return;
    r.wall ??= { n: w.ids.length, shift: 0 };
    if (r.readyT < 1.2) return;
    r.wall.creep = Math.min(1.2, (r.wall.creep ?? 0) + dt * 0.3);
    if (r.wall.creep > 0.9) {
      r.wall.creep = 0;
      r.wall.warned = (r.wall.warned ?? 0) + 1;
      this.emit('call', { team: w.team, text: 'wallback', power: r.wall.warned });
      if (r.wall.warned >= 2) {
        const p = this.players[w.ids[Math.floor(w.ids.length / 2)]];
        if (p && !p.off && p.cards === 0) this.giveCard(p, 1);
      }
    }
  }

  /** Two over the ball: the dummy runs over it (a computer wall may jump at him), then the taker goes. */
  private stepDummyRun(r: Restart, ru: NonNullable<Restart['runup']>, dt: number) {
    const before = ru.wait!;
    ru.wait = before - dt;
    const d = this.players[ru.dummy ?? -1];
    if (!d) return;
    const from = dummySpot(this, r);
    const over = { x: r.spot.x + (r.spot.x - from.x) * 1.2, z: r.spot.z + (r.spot.z - from.z) * 1.2 };
    const k = clamp(1 - ru.wait / 0.65, 0, 1);
    const np = { x: from.x + (over.x - from.x) * k, z: from.z + (over.z - from.z) * k };
    d.vel = { x: (np.x - d.pos.x) / Math.max(dt, 1e-3), z: (np.z - d.pos.z) / Math.max(dt, 1e-3) };
    d.pos = np;
    d.facing = angleOf(over.x - from.x, over.z - from.z);
    // As he reaches the ball a computer wall may jump for it, and come down before the real shot.
    if (before > 0.32 && ru.wait <= 0.32) {
      const w = wallFor(this, r);
      if (w && !this.ctrl[w.team].human && this.rng.chance(0.45)) { this.wallJump(w.ids); r.wallFooled = true; }
      this.emit('call', { team: r.team, player: d.id, text: 'dummy2' });
    }
  }

  /** A knuckleball wobbles from side to side once it is on its way, until someone touches it. */
  private stepKnuckle() {
    const k = this.knuckle;
    if (!k) return;
    const b = this.ball;
    if (b.lastTouch !== k.kicker || b.state !== 'flight' || this.time - k.t0 > 2.5) { this.knuckle = null; return; }
    const t = this.time - k.t0;
    b.spin = k.amp * Math.sin(k.phase + t * k.freq) * clamp((t - 0.12) / 0.25, 0, 1);
  }

  /** The wall jumps together (anyone already in the air carries on). */
  wallJump(ids: number[]) {
    let any = false;
    for (const id of ids) {
      const p = this.players[id];
      if (p.off || p.action.type !== 'none') continue;
      p.action = { type: 'jump', t: 0, dur: PLAYER.wallJumpTime };
      any = true;
    }
    if (any) this.emit('call', { team: this.players[ids[0]].team, text: 'jump' });
  }

  /** How high a wall player's feet are off the ground right now. */
  jumpHeight(p: Player): number {
    const a = p.action;
    return a.type === 'jump' ? PLAYER.wallJump * Math.sin(Math.PI * clamp(a.t / a.dur, 0, 1)) : 0;
  }

  /** The wall at the last free kick, while it still counts as a wall: who, the taker, until when, and a computer jump to come. */
  fkWall: { team: number; ids: number[]; taker: number; until: number; jumpAt: number; lier?: number } | null = null;

  /** Called when a restart kick leaves the taker: back to open play. */
  private restartTaken(taker: Player) {
    const r = this.restart!;
    armSetPiece(this, r);
    this.phase = 'play';
    this.phaseT = 0;
    if (r.indirect) this.indirectTaker = taker.id;
    this.restart = null;
  }

  // ---------------------------------------------------------------- open play

  private stepPlay(dt: number) {
    const fw = this.fkWall;
    if (fw && this.time > fw.until) this.fkWall = null;
    else if (fw && fw.jumpAt > 0 && this.time >= fw.jumpAt) { fw.jumpAt = -1; this.wallJump(fw.ids); }
    this.stepKnuckle();
    if (this.penRetake && this.penRetake.due > 0 && this.time >= this.penRetake.due) {
      const pr = this.penRetake;
      this.penRetake = null;
      this.emit('call', { team: pr.team, text: 'retake' });
      this.emit('whistle', { power: 1, text: 'foul' });
      this.award('penalty', pr.team, pr.spot, false, pr.taker);
      return;
    } else if (this.penRetake && this.time > this.penRetake.until && this.penRetake.due < 0) this.penRetake = null;
    this.processHumanInput();
    this.updateContain();
    updateAI(this, dt);
    if (this.ctlDrill) controlDrillWishes(this, this.ctlDrill);
    this.stepActions(dt);
    this.moveAll(dt);
    if (this.phase !== 'play') return; // a foul during actions may have stopped play
    if (G6.duels) this.stepBattles();
    this.stepMomentum(dt);
    if (this.phase !== 'play') return;
    this.stepBallInPlay(dt);
    if (this.phase !== 'play') return;
    this.checkAdvantage();
    if (this.phase !== 'play') return;
    this.updateSwitchCandidates();
    const pt = this.possessionTeam();
    if (pt >= 0) this.stats[pt].possessionTicks++;
  }

  private processHumanInput() {
    this.closeIds.clear();
    for (const team of [0, 1] as TeamIndex[]) {
      if (this.ctrl[team].human) this.processHumanFor(team);
      // Co-op: the second human on the team, handled with their control swapped in.
      if (this.mates[team]?.human) this.asMate(team, () => this.processHumanFor(team));
    }
  }

  private processHumanFor(team: TeamIndex) {
    const c = this.ctrl[team];
    const evs = this.pendingEvents[team];
    this.pendingEvents[team] = [];
    let p = this.players[c.pid];
    for (const e of evs) {
      // Just after a free kick against you, the shoot button still makes the wall jump.
      if (e.k === 'shoot' && this.fkWall && this.fkWall.team === team && this.ball.kicker === this.fkWall.taker && this.ball.state === 'flight') {
        this.wallJump(this.fkWall.ids);
        continue;
      }
      if (e.k === 'switch' && e.x === undefined && this.ball.owner === p.id && this.ball.state === 'dribble') {
        // With the ball, the switch button calls a teammate to run in behind.
        this.callRun(team, p);
        continue;
      }
      if (e.k === 'press') { this.startTeamPress(team); continue; }
      if (e.k === 'keeper') { if (p.role === 'GK') this.leaveKeeper(team); else this.takeKeeper(team); p = this.players[c.pid]; continue; }
      if (e.k === 'trap') { this.startOffsideTrap(team); continue; }
      if (e.k === 'switch') {
        if (e.x !== undefined && e.z !== undefined) this.switchTowards(team, e.x, e.z, !!e.at, !!e.m);
        else this.switchPlayer(team, true);
        p = this.players[c.pid];
        continue;
      }
      // A challenge pressed while defending (tackle, slide, contain): no auto-switch for a moment.
      if ((e.k === 'pass' || e.k === 'lob' || e.k === 'through') && this.ball.owner !== p.id && this.possessionTeam() !== team) c.lastChallenge = this.time;
      this.humanAction(p, e, c);
    }
    // Movement intention.
    let inp = c.input;
    if (c.carry !== undefined) {
      const b = this.ball;
      const m0 = Math.hypot(inp.mx, inp.mz);
      const moved = m0 < 0.25 || Math.abs(wrapAngle(angleOf(inp.mx, inp.mz) - c.carry)) > CARRY_ANGLE;
      if (c.carryKind === 'switch') {
        // The stick held for the player you had is not a request to run that way: the new man closes
        // down the ball until you let go of the stick or push it a new way (20 Nov 2026).
        if (moved || this.time > (c.carryUntil ?? 0) || this.possessionTeam() === team || b.owner === p.id || p.role === 'GK') c.carry = undefined;
        else {
          const S = this.engageSpot(team, this.engagePoint(team));
          const dx = S.x - p.pos.x, dz = S.z - p.pos.z, d = Math.hypot(dx, dz);
          inp = d > 0.8 ? { ...inp, mx: dx / d, mz: dz / d } : { ...inp, mx: 0, mz: 0 };
        }
      } else {
        // The stick still held from the pass is not a request to run that way: attack the ball.
        const toMe = b.state === 'flight' && b.receiver === p.id && b.owner < 0;
        if (!toMe || moved) c.carry = undefined;
        else inp = { ...inp, mx: 0, mz: 0 };
      }
    }
    const m = Math.hypot(inp.mx, inp.mz);
    const ownsBall = this.ball.owner === p.id;
    // Pressing sprint from below jogging pace gives a short burst of acceleration.
    if (inp.sprint && !c.prevSprint && m > 0.3) this.tryBurst(p);
    c.prevSprint = inp.sprint;
    let face = inp.jockey && !ownsBall ? angleOf(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z) : null;
    let mode: Player['wish']['mode'] = inp.sprint ? 'sprint' : 'jog';
    // Jockeying: side-on and facing the ball; with sprint held, a quicker shuffle that still stays side-on.
    if (inp.jockey && !ownsBall) mode = inp.sprint ? 'jockeyfast' : 'jockey';
    // Jockey with no stick: hold a goal-side position in front of the carrier and mirror them.
    if (inp.jockey && !ownsBall && m < 0.25) {
      const spot = this.containSpot(p);
      if (spot) {
        const dx = spot.x - p.pos.x, dz = spot.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        const k = d < 0.15 ? 0 : Math.min(1, d / 1.2) / d;
        p.wish = { x: dx * k, z: dz * k, mode: d > 3 || inp.sprint ? 'jockeyfast' : 'jockey', face };
        return;
      }
    }
    // Shielding: the jockey button on the ball turns your back on the nearest opponent.
    p.shielding = ownsBall && inp.jockey && this.ball.state === 'dribble';
    if (p.shielding) {
      mode = 'jockey';
      const o = this.nearestOpponent(p, 4.5);
      if (o) face = angleOf(p.pos.x - o.pos.x, p.pos.z - o.pos.z);
    }
    // Close control (19 Nov 2026): small, slow touches with the ball glued to the boot.
    const close = BC.close && ownsBall && !!inp.close && this.ball.state === 'dribble' && !p.shielding && p.role !== 'GK';
    if (close) { this.closeIds.add(p.id); mode = 'jog'; }
    p.wish = { x: inp.mx, z: inp.mz, mode, face };
    if (ownsBall && this.ball.state === 'dribble') humanCarrierInput(this, p, inp, m, close);
    // Dummy: holding shield as a teammate's pass arrives lets it run on to the next teammate behind.
    if (inp.jockey && !p.queued && this.ball.state === 'flight' && this.ball.receiver === p.id && this.ball.lastTouchTeam === team && this.ball.kicker !== p.id) {
      const q = this.dummyTarget(p);
      if (q) {
        this.ball.receiver = q.id;
        this.dummy = { pid: p.id, until: this.time + 0.8 };
        c.pid = q.id;
        this.emit('switch', { team, player: q.id, text: 'pass' });
        this.emit('call', { team, player: p.id, text: 'dummy' });
        return;
      }
    }
    // Running onto a through ball: with the stick let go, or pushed roughly the way he is going, he
    // keeps sprinting to where the ball meets him and takes it in his stride.
    const onto = this.strideAim(p);
    if (onto && (m < 0.25 || Math.abs(wrapAngle(angleOf(inp.mx, inp.mz) - angleOf(onto.x - p.pos.x, onto.z - p.pos.z))) < 1.0)) {
      const dx = onto.x - p.pos.x, dz = onto.z - p.pos.z, d = Math.hypot(dx, dz) || 1;
      p.wish = { x: dx / d, z: dz / d, mode: 'sprint', face: null };
      return;
    }
    // Receive assist: an intended receiver with no stick input comes to meet the ball.
    if (m < 0.25 && this.ball.state === 'flight' && this.ball.receiver === p.id) {
      const meet = receivePoint(this, p, true);
      if (meet) this.arrive(p, meet, dist(p.pos, meet) > 2 ? 'sprint' : 'jog', angleOf(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z));
    }
  }

  /** Where the receiver of a human's through ball runs to take it in his stride (see throughPlan), or null. */
  strideAim(p: Player): V2 | null {
    const s = this.stride, b = this.ball;
    if (!s || s.receiver !== p.id || b.receiver !== p.id || b.state !== 'flight' || (b.flight !== 'through' && b.flight !== 'pass') || b.owner >= 0 || this.time > s.until) return null;
    if (p.action.type !== 'none') return null;
    // Steer for where the ball will be a moment from now: he closes on it at full speed without
    // stopping to wait for it (kept on the pitch, so he never chases it over a line).
    const lead = dist(p.pos, b.pos) < 3.5 ? 0.12 : STRIDE.pursuit;
    return clampToPitch({ x: b.pos.x + b.vel.x * lead, z: b.pos.z + b.vel.z * lead }, 0.5);
  }

  /** A receiver letting the ball run through their legs (see processHumanInput); they ignore it until `until`. */
  dummy = { pid: -1, until: 0 };

  /** The next teammate along the line of the ball beyond `p`, who a dummy leaves the pass to. */
  private dummyTarget(p: Player): Player | null {
    const b = this.ball;
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (sp < 2 || b.pos.y > 0.6) return null;
    const ux = b.vel.x / sp, uz = b.vel.z / sp;
    const along = (q: Player) => (q.pos.x - b.pos.x) * ux + (q.pos.z - b.pos.z) * uz;
    const ap = along(p);
    let best: Player | null = null, bd = Infinity;
    for (const q of this.teamPlayers(p.team)) {
      if (q.id === p.id || q.role === 'GK') continue;
      const a = along(q) - ap;
      if (a < 3 || a > 26) continue;
      const perp = Math.abs(-(q.pos.x - b.pos.x) * uz + (q.pos.z - b.pos.z) * ux);
      if (perp > 2.5 + 0.15 * a) continue;
      if (a < bd) { bd = a; best = q; }
    }
    return best;
  }

  /** Player instructions by slot: -1 stay back, 0 normal, 1 get forward (teammates of a human). */
  instr: [number[], number[]] = [new Array(11).fill(0), new Array(11).fill(0)];
  setInstruction(team: TeamIndex, slot: number, v: number) {
    if (slot < 0 || slot > 10) return;
    this.instr[team][slot] = clamp(Math.round(v), -1, 1);
  }

  /** Change a side's game plan (live tactics). Takes effect at the next plan update (a tenth of a second). */
  setPlan(team: TeamIndex, plan: GamePlan) {
    if (this.plan[team] === plan) return;
    this.plan[team] = plan;
    this.emit('call', { team, text: `plan:${plan}` });
  }

  /** Team press: for a few seconds the three players nearest the ball all hunt it and the block pushes up. */
  teamPress: [number, number] = [0, 0];
  offsideTrap: [number, number] = [0, 0];
  private tacticCd: [[number, number], [number, number]] = [[0, 0], [0, 0]]; // [team][press, trap] ready again at
  startTeamPress(team: TeamIndex): boolean {
    if (this.possessionTeam() === team || this.time < this.tacticCd[team][0]) return false;
    this.teamPress[team] = this.time + MATCH.teamPressTime;
    this.tacticCd[team][0] = this.time + MATCH.teamPressCooldown;
    this.emit('call', { team, text: 'press' });
    return true;
  }
  /** Offside trap: the back four step up together for a moment, catching runners behind them. */
  startOffsideTrap(team: TeamIndex): boolean {
    if (this.possessionTeam() === team || this.time < this.tacticCd[team][1]) return false;
    this.offsideTrap[team] = this.time + MATCH.offsideTrapTime;
    this.tacticCd[team][1] = this.time + MATCH.offsideTrapCooldown;
    this.emit('call', { team, text: 'trap' });
    return true;
  }

  /**
   * Where a jockeying defender holds position: on the line from the opposing ball carrier to the
   * middle of their own goal, a couple of metres off (a little more against a carrier at speed).
   * Null when no opponent has the ball close enough to contain.
   */
  containSpot(p: Player): V2 | null {
    const b = this.ball;
    if (b.owner < 0) return null;
    const c = this.players[b.owner];
    if (c.team === p.team || dist(c.pos, p.pos) > 14) return null;
    const goal = { x: this.ownGoalX(p.team), z: 0 };
    const gx = goal.x - c.pos.x, gz = goal.z - c.pos.z;
    const gl = Math.hypot(gx, gz);
    if (gl < 1) return null;
    const sp = Math.hypot(c.vel.x, c.vel.z);
    const off = Math.min(gl - 0.5, PLAYER.containStandoff + 0.12 * sp);
    // Lead the carrier slightly so the defender mirrors rather than follows.
    return { x: c.pos.x + c.vel.x * 0.2 + (gx / gl) * off, z: c.pos.z + c.vel.z * 0.2 + (gz / gl) * off };
  }

  /**
   * Strength battles (19 Nov 2026): an opponent tight behind or alongside the ball carrier is in a
   * running shoulder-to-shoulder battle. Every few tenths of a second the stronger one gets the
   * better of it: the carrier holds the challenger off (they're bumped back half a stride), or is
   * knocked off balance and slowed, and occasionally loses the ball to a much stronger challenger.
   */
  private stepBattles() {
    const b = this.ball;
    if (b.state !== 'dribble' || b.owner < 0) { this.battles.clear(); return; }
    const c = this.players[b.owner];
    if (c.role === 'GK' || c.action.type !== 'none') return;
    let opp: Player | null = null, od: number = DUEL.holdRange;
    for (const o of this.players) {
      if (o.team === c.team || o.off || o.role === 'GK' || o.action.type !== 'none' || o.beaten > 0) continue;
      const d = dist(o.pos, c.pos);
      if (d > od) continue;
      // Behind or alongside the carrier (a defender squarely in front is a tackle, not a battle).
      const rel = Math.abs(wrapAngle(angleOf(o.pos.x - c.pos.x, o.pos.z - c.pos.z) - c.facing));
      if (rel < (55 * Math.PI) / 180) continue;
      od = d; opp = o;
    }
    const cur = this.battles.get(c.id);
    if (!opp) { if (cur) this.battles.delete(c.id); return; }
    if (!cur || cur.opp !== opp.id) { this.battles.clear(); this.battles.set(c.id, { opp: opp.id, next: this.time + DUEL.holdEvery, told: false }); return; }
    if (this.time < cur.next) return;
    cur.next = this.time + DUEL.holdEvery;
    const n = norm(opp.pos.x - c.pos.x, opp.pos.z - c.pos.z); // carrier -> challenger
    if (this.rng.chance(holdOffChance(c, opp))) {
      // Held off: the challenger is bumped back and loses a little ground.
      opp.vel.x = opp.vel.x * 0.72 + n.x * 1.4; opp.vel.z = opp.vel.z * 0.72 + n.z * 1.4;
      opp.contestCooldown = Math.max(opp.contestCooldown, 0.18);
      if (!cur.told) { cur.told = true; this.emit('call', { team: c.team, player: c.id, text: 'hold' }); }
    } else {
      // Muscled off balance: the carrier is slowed and pushed aside.
      c.vel.x = c.vel.x * 0.8 - n.x * 0.9; c.vel.z = c.vel.z * 0.8 - n.z * 0.9;
      this.emit('call', { team: opp.team, player: opp.id, text: 'muscle', power: c.id });
      const edge = strengthOf(opp) - strengthOf(c);
      if (edge > 0.12 && this.rng.chance(clamp(edge * 0.9, 0, 0.35)) && dist(opp.pos, b.pos) < 1.4) {
        this.stats[opp.team].tackles++;
        this.pstats[opp.id].tackles++;
        this.emit('tackle', { player: opp.id, team: opp.team });
        c.action = { type: 'stumble', t: 0, dur: 0.3 };
        this.pokeBall(opp, 2.5 + this.rng.next() * 2);
        this.battles.delete(c.id);
      }
    }
  }

  /** A loose ball bouncing around a penalty area after a block, parry or deflection: a goalmouth scramble. */
  startScramble() {
    const b = this.ball;
    if (!G6.deflect) return;
    if (Math.abs(b.pos.x) < PITCH.halfLength - PITCH.penaltyAreaDepth - 1 || Math.abs(b.pos.z) > PITCH.penaltyAreaHalfWidth + 1) return;
    if (this.scrambleUntil < this.time) this.emit('call', { team: b.pos.x > 0 ? 1 : 0, text: 'scramble', x: b.pos.x, z: b.pos.z });
    this.scrambleUntil = this.time + SCRAMBLE.time;
  }
  /** True while a scramble is on and the ball is still in that penalty area. */
  inScramble(): boolean {
    const b = this.ball;
    return this.scrambleUntil > this.time && Math.abs(b.pos.x) > PITCH.halfLength - PITCH.penaltyAreaDepth - 2 && Math.abs(b.pos.z) < PITCH.penaltyAreaHalfWidth + 2;
  }

  private nearestOpponent(p: Player, within: number): Player | null {
    let best: Player | null = null, bd = within;
    for (const o of this.players) {
      if (o.team === p.team || o.off) continue;
      const d = dist(o.pos, p.pos);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** How well a shielding carrier keeps the ball from a challenger: 0 (not shielding) to about 0.6. */
  shieldBonus(owner: Player, challenger: Player): number {
    // A roulette spins the body between the ball and the challenger, so it shields like holding the button.
    if (!owner.shielding && !(owner.action.type === 'skill' && owner.action.skill === 'roulette')) return 0;
    const behind = Math.abs(wrapAngle(angleOf(challenger.pos.x - owner.pos.x, challenger.pos.z - owner.pos.z) - owner.facing)) > (100 * Math.PI) / 180;
    // Strength battle (19 Nov 2026): a stronger carrier holds a defender off better, a weaker one less.
    const own = strengthOf(owner);
    return clamp((behind ? 0.35 : 0.15) + 0.25 * own + DUEL.shieldEdge * (own - strengthOf(challenger)), 0.05, 0.75);
  }

  /** Contain: while the human holds it and the opponents have the ball, the nearest teammate presses the carrier. */
  private updateContain() {
    for (const team of [0, 1] as TeamIndex[]) {
      // Either human holding contain (co-op); the presser is never the other human's player.
      const c = [this.ctrl[team], this.mates[team]].find((x): x is Control => !!x && x.human && !!x.input.contain);
      const other = c && c === this.ctrl[team] ? this.otherHuman(team) : this.ctrl[team].pid;
      const b = this.ball;
      const carrier = b.owner >= 0 ? this.players[b.owner] : null;
      if (!c || !carrier || carrier.team === team) { this.contain[team] = -1; continue; }
      const keep = this.contain[team];
      if (keep >= 0 && keep !== c.pid && keep !== other && !this.players[keep].off) continue;
      let best = -1, bd = Infinity;
      for (const p of this.teamPlayers(team)) {
        if (p.id === c.pid || p.id === other || p.role === 'GK') continue;
        const d = dist(p.pos, carrier.pos);
        if (d < bd) { bd = d; best = p.id; }
      }
      this.contain[team] = best;
    }
  }

  private humanAction(p: Player, e: InputEvent, c: Control) {
    const dir = { x: c.input.mx, z: c.input.mz };
    // Be a Pro: pass or through ball without the ball asks the teammate on it to find you.
    if (isLocked(c) && this.ball.owner !== p.id && callForBall(this, p, e)) return;
    if (e.k === 'skill') {
      if (this.ball.owner === p.id && this.ball.state === 'dribble') {
        const sx = e.x ?? dir.x, sz = e.z ?? dir.z;
        this.startSkill(p, sx, sz, e.v === 'fake', !!e.m, e.v === 'flick');
      } else if (p.role === 'GK') this.leaveKeeper(p.team);
      else if (this.possessionTeam() !== p.team || this.ball.state === 'held') this.takeKeeper(p.team);
      return;
    }
    // Controlling the keeper (without the ball): shoot dives, pass comes off the line for the ball
    // (or smothers it at a forward's feet), lob and through ball claim it too.
    if (p.role === 'GK' && this.ball.owner !== p.id) {
      if (e.k === 'shoot') manualDive(this, p, dir.x, dir.z);
      else if (e.k === 'pass' || e.k === 'lob' || e.k === 'through') {
        const b = this.ball;
        const carrier = b.owner >= 0 && b.state === 'dribble' ? this.players[b.owner] : null;
        if (carrier && carrier.team !== p.team && dist(p.pos, b.pos) < 2.2 && p.tackleCooldown <= 0 && this.inPenaltyArea(p.team, p.pos)) smother(this, p, carrier);
        else this.startKeeperRush(p.team);
      }
      return;
    }
    const kind: KickKind = e.k === 'shoot' ? 'shot' : (e.k as KickKind);
    const gk = this.keeper(p.team);
    if (this.ball.state === 'held' && this.ball.owner === gk.id) {
      // Human directs the goalkeeper's distribution: roll out (pass), throw (lob), drop-kick (through) or punt (shoot), aimed with the stick.
      if (gk.action.type === 'none') {
        const rq = distributionRequest(distributionFor(e.k as 'pass' | 'through' | 'lob' | 'shoot'));
        this.startKick(gk, { kind: rq.kind, variant: rq.variant, dir, power: e.p, charged: e.p !== undefined, receiver: -1 }, rq.hands);
      }
      return;
    }
    const style = kickStyle(e);
    if (this.ball.owner === p.id && isJuggle(p.action)) {
      // Juggling: shoot volleys it from the air; a pass, through ball or lob is played off the bounce.
      const b = this.ball;
      if (kind === 'shot' && b.pos.y > 0.3) {
        p.queued = { kind, dir: { ...dir }, power: e.p ?? 0.5, ...style, until: this.time + 0.3 };
        this.volley(p, b.pos.y);
        return;
      }
      p.action = { type: 'none', t: 0, dur: 0 };
    }
    if (this.ball.owner === p.id) {
      // Early receiver: the teammate picked when the button went down (still on the pitch).
      const lr = e.r !== undefined ? this.players[e.r] : null;
      const locked = !!lr && lr.team === p.team && lr.id !== p.id && !lr.off;
      if (p.action.type === 'none') this.startKick(p, { kind, dir, power: e.p ?? 0.5, receiver: locked ? lr!.id : -1, ...style, locked: locked || undefined });
      return;
    }
    const pt = this.possessionTeam();
    const ballNear = dist(p.pos, this.ball.pos) < 4.5;
    if (pt !== p.team && pt >= 0 && (e.k === 'pass' || e.k === 'shoot') && this.ball.state === 'dribble') {
      this.startTackle(p);
      return;
    }
    // The lob button with the modifier held is a tactical foul: a deliberate pull-back on the carrier.
    if (pt !== p.team && pt >= 0 && e.k === 'lob' && e.m && this.ball.state === 'dribble') {
      this.startTacticalFoul(p);
      return;
    }
    // The lob button without the ball is a slide tackle.
    if (pt !== p.team && pt >= 0 && e.k === 'lob' && this.ball.state === 'dribble') {
      this.startSlide(p);
      return;
    }
    if (ballNear || (this.ball.state === 'flight' && this.ball.receiver === p.id)) {
      // First-time pass/shot/header if the ball arrives within the window.
      p.queued = { kind, dir: { ...dir }, power: e.p ?? 0.5, ...style, until: this.time + 0.45 };
      // One-two: pressing pass again as your own pass arrives sends the passer on, to be found first time.
      const k = this.ball.kicker >= 0 ? this.players[this.ball.kicker] : null;
      if (kind === 'pass' && this.ball.state === 'flight' && this.ball.receiver === p.id && k && k.team === p.team && k.id !== p.id && k.role !== 'GK' && !k.off && this.time - this.lastKickTime < 1.6) {
        k.giveGoUntil = this.time + MATCH.oneTwoRunTime;
        p.queued.oneTwo = k.id;
        p.queued.until = this.time + 1.2;
        this.emit('call', { team: p.team, player: k.id, text: 'onetwo' });
      }
      return;
    }
    if (e.k === 'pass' || e.k === 'shoot') this.startTackle(p);
  }

  // ---------------------------------------------------------------- actions

  startKick(p: Player, req: KickRequest, fromHands = false) {
    // A keeper throwing or rolling the ball out from his hands takes a proper wind-up.
    const keeperHands = p.role === 'GK' && req.kind === 'throw' && this.ball.state === 'held' && this.ball.owner === p.id;
    const windup = keeperHands ? handWindup(req.variant) : kickWindup(req.kind);
    // A power shot takes a bigger back-lift; a side-footed placed shot is quick.
    const shotWindup = req.kind === 'shot' && req.variant === 'power' ? windup + SHOT_TYPES.powerWindup : req.kind === 'shot' && req.variant === 'placed' ? windup - SHOT_TYPES.placedQuicker : undefined;
    p.action = {
      type: fromHands || req.kind === 'throw' ? 'throw' : 'kick',
      t: 0, dur: (shotWindup ?? windup) + (keeperHands ? HAND_FOLLOW : 0.28), windup: keeperHands ? windup : shotWindup, kind: req.kind, power: req.power ?? 0.6, dir: req.dir ? { ...req.dir } : undefined,
      placed: req.placed, receiver: req.receiver ?? -1, target: req.target ? { ...req.target } : undefined, released: false, exact: req.exact,
      variant: req.variant, charged: req.charged, accuracy: req.accuracy, locked: req.locked, assist: req.assist, curve: req.curve, dip: req.dip, knuckle: req.knuckle,
    };
    p.queued = null;
  }

  /**
   * Tactical foul: a deliberate tug on the carrier's shirt to stop a counter-attack. Always a foul
   * when it reaches the carrier (no advantage), usually a booking, a red card when it denies an
   * obvious goal-scoring chance, a penalty in the box. Works from behind or alongside, where a
   * tackle can't reach the ball. Returns false when the carrier is out of reach.
   */
  startTacticalFoul(p: Player): boolean {
    const b = this.ball;
    if (p.tackleCooldown > 0 || p.action.type !== 'none' || p.role === 'GK' || b.owner < 0 || b.state !== 'dribble') return false;
    const c = this.players[b.owner];
    if (c.team === p.team || dist(p.pos, c.pos) > TACTICAL.reach) return false;
    p.action = { type: 'tackle', t: 0, dur: PLAYER.tackleDuration, tactical: true, dir: { x: c.pos.x - p.pos.x, z: c.pos.z - p.pos.z } };
    p.tackleCooldown = PLAYER.tackleRecovery;
    p.facing = angleOf(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
    return true;
  }

  /** The pull-back connects (or the carrier has got away). */
  private resolveTacticalFoul(t: Player) {
    const b = this.ball;
    const c = b.owner >= 0 ? this.players[b.owner] : null;
    if (!c || c.team === t.team || b.state !== 'dribble' || dist(t.pos, c.pos) > TACTICAL.reach + 0.4) { t.action.missed = true; return; }
    t.action.missed = false;
    this.emit('call', { team: t.team, player: t.id, text: 'tactical' });
    this.foul(t, c, { tactical: true });
  }

  startTackle(p: Player) {
    if (p.tackleCooldown > 0 || p.action.type !== 'none') return;
    if (this.startBarge(p)) return;
    p.action = { type: 'tackle', t: 0, dur: PLAYER.tackleDuration, jockeySet: p.jockeying && p.jockeyT > PLAYER.jockeySetTime };
    p.tackleCooldown = PLAYER.tackleRecovery;
  }

  /**
   * Shoulder barge: when the carrier is level with the challenger (alongside, both running the
   * same way), the tackle button leans into the carrier shoulder to shoulder instead of lunging.
   * Returns false when the geometry doesn't fit, so the normal standing tackle is used.
   */
  startBarge(p: Player): boolean {
    const b = this.ball;
    if (p.role === 'GK' || b.state !== 'dribble' || b.owner < 0) return false;
    const c = this.players[b.owner];
    if (c.team === p.team) return false;
    const d = dist(p.pos, c.pos);
    if (d > PLAYER.bargeReach || d < 0.3) return false;
    const cHead = Math.hypot(c.vel.x, c.vel.z) > 1 ? angleOf(c.vel.x, c.vel.z) : c.facing;
    // Level with the carrier: off to the side of the carrier's run, not in front or behind.
    const rel = Math.abs(wrapAngle(angleOf(p.pos.x - c.pos.x, p.pos.z - c.pos.z) - cHead));
    if (rel < (50 * Math.PI) / 180 || rel > (130 * Math.PI) / 180) return false;
    // Running the same way (by velocity when moving, else facing).
    const pHead = Math.hypot(p.vel.x, p.vel.z) > 1 ? angleOf(p.vel.x, p.vel.z) : p.facing;
    if (Math.abs(wrapAngle(pHead - cHead)) > (65 * Math.PI) / 180) return false;
    // side: +1 when the carrier is to the challenger's left of the shared heading.
    const toC = { x: c.pos.x - p.pos.x, z: c.pos.z - p.pos.z };
    const h = dirOf(cHead);
    const side = h.x * toC.z - h.z * toC.x > 0 ? 1 : -1;
    p.action = { type: 'barge', t: 0, dur: PLAYER.bargeDuration, side, start: { x: h.x, z: h.z } };
    p.tackleCooldown = PLAYER.bargeRecovery;
    p.facing = cHead;
    return true;
  }

  /** Barge contact: shoulder strength (tackling, stamina, speed) against the carrier's balance on the ball. */
  private resolveBarge(t: Player) {
    const a = t.action;
    a.resolved = true;
    const b = this.ball;
    const c = b.owner >= 0 ? this.players[b.owner] : null;
    if (!c || c.team === t.team || dist(t.pos, c.pos) > 1.45 || b.state !== 'dribble') { a.missed = true; return; }
    this.stats[t.team].tackles++;
    const side = a.side ?? 1;
    const h = a.start ?? dirOf(t.facing);
    const n = { x: -h.z * side, z: h.x * side }; // from the challenger towards the carrier
    const strength = (q: Player) => strengthOf(q);
    const speedEdge = clamp((Math.hypot(t.vel.x, t.vel.z) - Math.hypot(c.vel.x, c.vel.z)) * 0.06, -0.12, 0.12);
    // A clumsy barge (late, or a weak challenger) is occasionally given as a foul.
    if (this.rng.chance(clamp(0.1 - 0.08 * t.a.tackling, 0.02, 0.1))) { this.foul(t, c); return; }
    const pWin = clamp(0.42 + 0.6 * (strength(t) - strength(c)) - 0.18 * c.a.control + speedEdge - 0.5 * this.shieldBonus(c, t), 0.1, 0.8);
    if (this.rng.chance(pWin)) {
      a.missed = false;
      this.emit('tackle', { player: t.id, team: t.team });
      this.pstats[t.id].tackles++;
      // The carrier is knocked off their line and loses the ball, which runs on.
      c.vel.x = c.vel.x * 0.6 + n.x * 2.6; c.vel.z = c.vel.z * 0.6 + n.z * 2.6;
      c.action = { type: 'stumble', t: 0, dur: 0.35 };
      if (this.rng.chance(0.45 + 0.35 * t.a.tackling)) this.takePossession(t, true);
      else {
        const sp = Math.max(3, Math.hypot(c.vel.x, c.vel.z) * 0.9);
        this.pokeBall(t, sp);
        b.vel.x = h.x * sp + n.x * 1.2; b.vel.z = h.z * sp + n.z * 1.2; b.vel.y = 0.2;
        b.kickLock = 0.12;
      }
      return;
    }
    // The carrier holds firm: the challenger bounces off and loses a stride.
    a.missed = true;
    t.vel.x = t.vel.x * 0.5 - n.x * 1.8; t.vel.z = t.vel.z * 0.5 - n.z * 1.8;
    c.vel.x *= 0.88; c.vel.z *= 0.88;
  }

  /** Slide tackle: a long, committed lunge. Wins the ball from further away, but a miss leaves you on the ground. */
  startSlide(p: Player) {
    if (p.tackleCooldown > 0 || p.action.type !== 'none' || p.role === 'GK') return;
    p.action = { type: 'slide', t: 0, dur: PLAYER.slideDuration };
    p.tackleCooldown = PLAYER.slideRecovery;
    p.stamina = Math.max(0, p.stamina - 0.03);
    // Commit along the line to the ball if it is roughly in front, otherwise straight ahead.
    const b = this.ball;
    const toBall = angleOf(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    if (Math.abs(wrapAngle(toBall - p.facing)) < 0.9) p.facing = toBall;
  }

  /** Short acceleration burst when a sprint starts from a standstill or a jog. */
  tryBurst(p: Player) {
    if (p.burst > 0 || p.stamina < PLAYER.burstMinStamina || p.action.type !== 'none') return;
    if (Math.hypot(p.vel.x, p.vel.z) > jogSpeed(p.a) * 1.02) return;
    p.burst = PLAYER.burstTime;
    p.stamina -= PLAYER.burstCost;
  }

  /**
   * Skill moves, chosen by the direction relative to the way the player faces:
   * forward knocks the ball on and sprints after it, straight back drags it back and turns,
   * diagonally back is a roulette (a 360° spin that rolls round a defender to that side),
   * sideways (or no direction) is a step-over that can wrong-foot a defender in front.
   * `fake` is a fake shot: the shooting leg swings, then cuts across the ball instead.
   * With the modifier held (`mod`, 19 Nov 2026): forward is an elastico (out, then cut back in),
   * back a drag-back that turns away, and sideways a ball roll under the sole across the body.
   * Pressing skill again late in a step-over chains a second one the other way.
   */
  startSkill(p: Player, dx: number, dz: number, fake = false, mod = false, flick = false): SkillMove | null {
    const b = this.ball;
    if (b.owner !== p.id || b.state !== 'dribble') return null;
    // Close control + skill: flick it up, juggle it, or flick it over a defender (ballcontrol.ts).
    if (flick || isJuggle(p.action)) return startFlick(this, p, dx, dz);
    const cur = p.action;
    const chain = cur.type === 'skill' && cur.skill === 'stepover' && !fake && !mod && cur.t > 0.2 && (cur.chain ?? 0) < 2;
    if (!chain && (p.action.type !== 'none' || p.skillCd > 0)) return null;
    const f = dirOf(p.facing);
    const m = Math.hypot(dx, dz);
    const d = m > 0.3 ? { x: dx / m, z: dz / m } : null;
    const along = d ? d.x * f.x + d.z * f.z : 0;
    let move: SkillMove = 'stepover';
    let side = 1;
    if (fake) move = 'fakeshot';
    else if (chain) move = 'stepover';
    else if (mod && d && along > 0.85) move = 'elastico';
    else if (mod && d && along > 0.2) move = 'berba';
    else if (mod && d && along < -0.85) move = 'dragturn';
    else if (mod && d && along < -0.2) move = 'mcgeady';
    else if (mod) move = 'ballroll';
    else if (d && along > 0.55) move = 'knockon';
    else if (d && along < -0.82) move = 'dragback';
    else if (d && along < -0.25) move = 'roulette';
    // Sideways at full speed, a human carrier drops the shoulder instead: a quicker body feint (20 Nov 2026).
    else if (d && Math.abs(along) < 0.55 && Math.hypot(p.vel.x, p.vel.z) > SKILL7.feintSpeed && this.isHumanCarrier(p)) move = 'bodyfeint';
    if (d && Math.abs(f.x * d.z - f.z * d.x) > 0.2) side = f.x * d.z - f.z * d.x >= 0 ? 1 : -1;
    else {
      // No sideways direction: break away from the nearest opponent.
      let near: Player | null = null, nd = Infinity;
      for (const o of this.teamPlayers(1 - p.team)) { const od = dist(o.pos, p.pos); if (od < nd) { nd = od; near = o; } }
      if (near) side = f.x * (near.pos.z - p.pos.z) - f.z * (near.pos.x - p.pos.x) >= 0 ? -1 : 1;
    }
    if (chain) {
      // A second (and third) step-over, the other way: each one sells the feint a little harder.
      const n = (cur.chain ?? 0) + 1;
      p.vel.x *= 0.6; p.vel.z *= 0.6;
      p.action = { type: 'skill', t: 0, dur: 0.46, skill: 'stepover', side: -(cur.side ?? 1), chain: n };
      p.skillCd = PLAYER.skillCooldown;
      this.emit('skill', { player: p.id, team: p.team, text: 'stepover' });
      return 'stepover';
    }
    p.skillCd = PLAYER.skillCooldown;
    p.stamina = Math.max(0, p.stamina - PLAYER.skillCost);
    if (move === 'ballroll') {
      // Sole on the ball and roll it across the body, side-stepping with it.
      p.vel.x *= 0.5; p.vel.z *= 0.5;
      p.action = { type: 'skill', t: 0, dur: SKILL6.rollTime, skill: move, side, dir: { x: f.x, z: f.z } };
    } else if (move === 'elastico') {
      // Outside of the foot pushes it one way, then snaps it back the other: break the other way.
      p.vel.x *= 0.7; p.vel.z *= 0.7;
      p.action = { type: 'skill', t: 0, dur: SKILL6.elasticoTime, skill: move, side, dir: { x: f.x, z: f.z } };
    } else if (move === 'dragturn') {
      // Drag it back under the sole and turn right round with it, away from pressure.
      p.vel.x *= 0.3; p.vel.z *= 0.3;
      p.action = { type: 'skill', t: 0, dur: SKILL6.turnTime, skill: move, side, dir: { x: f.x, z: f.z } };
    } else if (move === 'bodyfeint' || move === 'berba' || move === 'mcgeady') {
      // Shoulder drop one way and away the other; or a spin on the ball (20 Nov 2026, see stepSkill7).
      const keep = move === 'bodyfeint' ? 0.85 : move === 'berba' ? 0.5 : 0.35;
      p.vel.x *= keep; p.vel.z *= keep;
      p.action = { type: 'skill', t: 0, dur: SKILL7.time[move], skill: move, side, dir: { x: f.x, z: f.z } };
    } else if (move === 'knockon') {
      const k = d ?? f;
      const sp = Math.hypot(p.vel.x, p.vel.z) + 5.5 + 1.5 * p.a.pace;
      b.vel = { x: k.x * sp, y: 0.3, z: k.z * sp };
      b.state = 'free';
      b.flight = 'none';
      b.owner = -1;
      b.kicker = p.id;
      b.kickLock = 0.3;
      b.stillTime = 0;
      p.burst = PLAYER.burstTime;
      p.action = { type: 'skill', t: 0, dur: 0.45, skill: move, dir: { ...k } };
      this.emit('kick', { player: p.id, team: p.team, power: sp * 0.4, text: 'touch' });
    } else if (move === 'dragback') {
      b.pos.x = p.pos.x - f.x * 0.25;
      b.pos.z = p.pos.z - f.z * 0.25;
      b.vel = { x: 0, y: 0, z: 0 };
      p.vel.x *= 0.25; p.vel.z *= 0.25;
      p.action = { type: 'skill', t: 0, dur: 0.42, skill: move, dir: { x: -f.x, z: -f.z } };
    } else if (move === 'roulette') {
      // Foot on the ball and spin: the body stays between the ball and the defender while rolling round to the side.
      p.vel.x *= 0.4; p.vel.z *= 0.4;
      p.action = { type: 'skill', t: 0, dur: PLAYER.rouletteTime, skill: move, side, dir: { x: f.x, z: f.z } };
    } else if (move === 'fakeshot') {
      // Shooting leg swings back as for a shot, then drags the ball across instead.
      p.vel.x *= 0.6; p.vel.z *= 0.6;
      p.action = { type: 'skill', t: 0, dur: 0.55, skill: move, side, dir: { x: f.x, z: f.z } };
    } else {
      p.vel.x *= 0.5; p.vel.z *= 0.5;
      p.action = { type: 'skill', t: 0, dur: 0.5, skill: move, side };
    }
    this.emit('skill', { player: p.id, team: p.team, text: move });
    return move;
  }

  /**
   * A step-over, roulette or fake shot can wrong-foot opponents in front: they lose their footing for a moment.
   * A set, jockeying defender is much harder to fool; one charging in (or sliding in to block a fake shot) bites.
   */
  stepoverFeint(p: Player, move: SkillMove = 'stepover') {
    const range = move === 'fakeshot' ? 5.5 : move === 'roulette' ? 2.6 : move === 'elastico' ? 3.2 : move === 'ballroll' ? 2.8 : move === 'dragturn' ? 2.4 : move === 'flickover' ? 3.8 : move === 'bodyfeint' ? 3.4 : move === 'berba' ? 2.8 : move === 'mcgeady' ? 2.5 : 3.5;
    const cone = move === 'roulette' || move === 'dragturn' || move === 'berba' || move === 'mcgeady' ? 1.7 : 1.2;
    for (const o of this.teamPlayers(1 - p.team)) {
      if (o.role === 'GK' || o.action.type !== 'none') continue;
      const d = dist(o.pos, p.pos);
      if (d > range) continue;
      const ang = Math.abs(wrapAngle(angleOf(o.pos.x - p.pos.x, o.pos.z - p.pos.z) - p.facing));
      if (ang > cone) continue;
      // Closing in fast (towards the carrier) makes a defender easier to beat.
      const closing = ((p.pos.x - o.pos.x) * o.vel.x + (p.pos.z - o.pos.z) * o.vel.z) / Math.max(0.5, d);
      const chained = move === 'stepover' && (p.action.chain ?? 0) > 0 ? 0.06 * (p.action.chain ?? 0) : 0;
      const base = (move === 'fakeshot' ? 0.25 : move === 'roulette' ? 0.28 : move === 'elastico' ? 0.36 : move === 'ballroll' ? 0.3 : move === 'dragturn' ? 0.24 : move === 'flickover' ? 0.42 : move === 'bodyfeint' ? 0.32 : move === 'berba' ? 0.33 : move === 'mcgeady' ? 0.27 : 0.3) + chained;
      const set = o.jockeying && o.jockeyT > PLAYER.jockeySetTime;
      const pBeat = clamp(base + 0.5 * p.a.control - 0.3 * o.a.tackling + (set ? -0.25 : o.jockeying ? -0.12 : 0.1) + 0.05 * clamp(closing - 2, 0, 4), 0.06, 0.85);
      if (this.rng.chance(pBeat)) {
        o.beaten = PLAYER.beatenTime;
        o.contestCooldown = Math.max(o.contestCooldown, PLAYER.beatenTime);
        o.tackleCooldown = Math.max(o.tackleCooldown, PLAYER.beatenTime);
      }
    }
  }

  /**
   * Roulette: a full turn on the ball over PLAYER.rouletteTime, drifting about 1.3 m to the side.
   * The ball stays at the feet (on the far side from the defender) and the move comes out facing
   * the original way with a short burst.
   */
  private stepRoulette(p: Player, a: Player['action']) {
    const f = a.dir!;
    const s = a.side ?? 1;
    const u = clamp(a.t / a.dur, 0, 1);
    const side = { x: -f.z * s, z: f.x * s };
    const drift = u < 0.85 ? 0.75 : 0.3;
    p.wish = { x: side.x * drift + f.x * 0.25, z: side.z * drift + f.z * 0.25, mode: 'walk', face: null };
    if (!a.resolved && u >= 0.5) { a.resolved = true; this.stepoverFeint(p, 'roulette'); }
    if (u >= 0.98) p.burst = Math.max(p.burst, 0.4);
  }

  /** A set, jockeying opponent squared up within 2.6 m in front of the carrier (delaying them), or null. */
  jockeyedBy(c: Player): Player | null {
    for (const o of this.players) {
      if (o.team === c.team || o.off || !o.jockeying || o.jockeyT < PLAYER.jockeySetTime || o.beaten > 0) continue;
      const d = dist(o.pos, c.pos);
      if (d > 2.6) continue;
      const ang = Math.abs(wrapAngle(angleOf(o.pos.x - c.pos.x, o.pos.z - c.pos.z) - c.facing));
      if (ang < 0.9) return o;
    }
    return null;
  }

  /**
   * The three modifier skill moves, scripted over their duration. Ball roll: a side-step with the
   * ball rolled across under the sole, then away diagonally. Elastico: a feint out with the
   * outside of the foot, snapped back in and away the other way (a heavy first touch can lose it
   * for a player without the control). Drag-back turn: the ball pulled back as the body turns
   * right round, then away from the pressure.
   */
  private stepSkill6(p: Player, a: Player['action']) {
    const f = a.dir!;
    const s = a.side ?? 1;
    const u = clamp(a.t / a.dur, 0, 1);
    const side = { x: -f.z * s, z: f.x * s };
    const fa = angleOf(f.x, f.z);
    if (a.skill === 'ballroll') {
      p.wish = u < 0.75 ? { x: side.x * 0.62 + f.x * 0.08, z: side.z * 0.62 + f.z * 0.08, mode: 'walk', face: fa } : { x: f.x * 0.7 + side.x * 0.5, z: f.z * 0.7 + side.z * 0.5, mode: 'sprint', face: null };
      if (!a.resolved && u >= 0.55) { a.resolved = true; this.stepoverFeint(p, 'ballroll'); p.burst = Math.max(p.burst, 0.4); }
    } else if (a.skill === 'elastico') {
      const snap = SKILL6.elasticoSnap / a.dur;
      if (u < snap) p.wish = { x: f.x * 0.3 + side.x * 0.25, z: f.z * 0.3 + side.z * 0.25, mode: 'walk', face: fa };
      else {
        if (!a.resolved) {
          a.resolved = true;
          this.stepoverFeint(p, 'elastico');
          p.burst = Math.max(p.burst, 0.55);
          // Without the touch for it, the snap back goes astray.
          if (this.ball.owner === p.id && this.rng.chance(clamp(0.45 - 0.55 * p.a.control, 0.03, 0.3))) {
            const b = this.ball, k = dirOf(fa - s * 0.9);
            this.pokeBall(p, 3.5);
            b.vel.x = k.x * 3.5 + p.vel.x * 0.5; b.vel.z = k.z * 3.5 + p.vel.z * 0.5;
            b.lastTouchTeam = p.team;
          }
        }
        const br = dirOf(fa - s * 0.95);
        p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null };
      }
    } else {
      // Drag-back turn: face swings right round over the first 70% of the move.
      const k = Math.min(1, u / 0.7);
      const face = wrapAngle(fa + s * Math.PI * k);
      p.wish = u < 0.7 ? { x: -f.x * 0.15, z: -f.z * 0.15, mode: 'walk', face } : { x: -f.x, z: -f.z, mode: 'sprint', face: null };
      if (u < 0.7) p.facing = face;
      if (!a.resolved && u >= 0.55) { a.resolved = true; this.stepoverFeint(p, 'dragturn'); p.burst = Math.max(p.burst, 0.45); }
    }
  }

  /**
   * Body feint, Berba spin and McGeady spin (20 Nov 2026), scripted over their duration.
   * Body feint: a shoulder drop and lean the other way for a beat, then away on the stick's side.
   * Berba spin: the ball is rolled across the body with one foot and the player spins round it,
   * coming out diagonally forward on the other side. McGeady spin: the sole drags the ball back as
   * the player spins half a turn, then away at a right angle to where he was going.
   */
  private stepSkill7(p: Player, a: Player['action']) {
    const f = a.dir!;
    const s = a.side ?? 1;
    const u = clamp(a.t / a.dur, 0, 1);
    const fa = angleOf(f.x, f.z);
    if (a.skill === 'bodyfeint') {
      if (u < SKILL7.feintSell) {
        const o = dirOf(fa - s * 0.5);
        p.wish = { x: o.x * 0.75, z: o.z * 0.75, mode: 'jog', face: fa };
      } else {
        if (!a.resolved) { a.resolved = true; this.stepoverFeint(p, 'bodyfeint'); p.burst = Math.max(p.burst, 0.5); }
        const br = dirOf(fa + s * 0.8);
        p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null };
      }
      return;
    }
    if (a.skill === 'berba') {
      // A full turn, away from the side the ball goes, while drifting diagonally forward to that side.
      const k = Math.min(1, u / 0.75);
      const face = wrapAngle(fa - s * 2 * Math.PI * k);
      const o = dirOf(fa + s * 0.9);
      if (u < 0.75) { p.wish = { x: o.x * 0.55, z: o.z * 0.55, mode: 'walk', face }; p.facing = face; }
      else { const br = dirOf(fa + s * 0.55); p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null }; }
      if (!a.resolved && u >= 0.5) { a.resolved = true; this.stepoverFeint(p, 'berba'); p.burst = Math.max(p.burst, 0.45); }
      return;
    }
    // McGeady: half a turn towards the break side, the ball pulled back under the sole, then away sideways.
    const k = Math.min(1, u / 0.6);
    const face = wrapAngle(fa + s * Math.PI * 0.5 * k);
    if (u < 0.6) { p.wish = { x: -f.x * 0.15, z: -f.z * 0.15, mode: 'walk', face }; p.facing = face; }
    else { const br = dirOf(fa + s * Math.PI * 0.5); p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null }; }
    if (!a.resolved && u >= 0.5) { a.resolved = true; this.stepoverFeint(p, 'mcgeady'); p.burst = Math.max(p.burst, 0.45); }
  }

  /** Scripted facing through a roulette: a full turn, spinning away from the side it rolls to. */
  rouletteFacing(a: Player['action']): number {
    const f = a.dir!;
    const u = clamp(a.t / a.dur, 0, 1);
    return wrapAngle(angleOf(f.x, f.z) - (a.side ?? 1) * 2 * Math.PI * Math.min(1, u / 0.85));
  }

  private stepActions(dt: number) {
    for (const p of this.players) {
      const a = p.action;
      if (a.type === 'none' || (a.type === 'jump' && this.phase !== 'play')) continue;
      a.t += dt;
      if ((a.type === 'kick' || a.type === 'throw') && !a.released && a.t >= (a.windup ?? kickWindup(a.kind!))) {
        a.released = true;
        this.releaseKick(p);
        if (this.phase !== 'play' && this.phase !== 'restart') return;
      }
      if (a.type === 'tackle' && a.tactical) {
        // Reaching out for the shirt: chase the carrier for a stride.
        const b = this.ball, c = b.owner >= 0 ? this.players[b.owner] : null;
        const to = c ? norm(c.pos.x - p.pos.x, c.pos.z - p.pos.z) : dirOf(p.facing);
        p.wish = a.t < TACTICAL.contact ? { x: to.x, z: to.z, mode: 'sprint', face: angleOf(to.x, to.z) } : { x: 0, z: 0, mode: 'walk', face: p.facing };
      } else if (a.type === 'tackle') {
        if (a.t < 0.22) {
          // Lunge: commit forward along the facing direction.
          const f = dirOf(p.facing);
          p.wish = { x: f.x, z: f.z, mode: 'sprint', face: p.facing };
        } else p.wish = { x: 0, z: 0, mode: 'walk', face: p.facing };
      }
      if (a.type === 'tackle' && !a.resolved && a.t >= (a.tactical ? TACTICAL.contact : PLAYER.tackleContactTime)) {
        a.resolved = true;
        if (a.tactical) this.resolveTacticalFoul(p);
        else this.resolveTackle(p);
        if (this.phase !== 'play') return;
      }
      if (a.type === 'barge') {
        // Run alongside, leaning in towards the carrier until contact.
        const h = a.start ?? dirOf(p.facing);
        const s = a.side ?? 1;
        const lean = a.t < PLAYER.bargeContactTime ? 0.55 : 0.1;
        p.wish = { x: h.x - h.z * s * lean, z: h.z + h.x * s * lean, mode: 'sprint', face: angleOf(h.x, h.z) };
        if (!a.resolved && a.t >= PLAYER.bargeContactTime) {
          this.resolveBarge(p);
          if (this.phase !== 'play') return;
        }
      }
      if (a.type === 'slide') {
        p.wish = { x: 0, z: 0, mode: 'walk', face: p.facing };
        if (!a.resolved && !a.block && a.t >= PLAYER.slideContactFrom && a.t <= PLAYER.slideContactTo) {
          this.resolveSlide(p);
          if (this.phase !== 'play') return;
        }
      }
      if (a.type === 'skill' && stepBallSkill(p, dt)) {
        // Ball-control moves (ballcontrol.ts).
      } else if (a.type === 'skill') {
        if (a.skill === 'stepover') {
          const f = dirOf(p.facing);
          if (a.t < 0.22) p.wish = { x: f.x * 0.25, z: f.z * 0.25, mode: 'walk', face: p.facing };
          else {
            if (!a.resolved) { a.resolved = true; this.stepoverFeint(p, 'stepover'); p.burst = Math.max(p.burst, 0.45); }
            const br = dirOf(p.facing + (a.side ?? 1) * 0.85);
            p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null };
          }
        } else if (a.skill === 'dragback') {
          p.wish = { x: 0, z: 0, mode: 'walk', face: angleOf(a.dir!.x, a.dir!.z) };
        } else if (a.skill === 'ballroll' || a.skill === 'elastico' || a.skill === 'dragturn') {
          this.stepSkill6(p, a);
        } else if (a.skill === 'bodyfeint' || a.skill === 'berba' || a.skill === 'mcgeady') {
          this.stepSkill7(p, a);
        } else if (a.skill === 'roulette') {
          this.stepRoulette(p, a);
        } else if (a.skill === 'fakeshot') {
          const f = a.dir!;
          if (a.t < 0.3) p.wish = { x: f.x * 0.2, z: f.z * 0.2, mode: 'walk', face: angleOf(f.x, f.z) };
          else {
            if (!a.resolved) {
              a.resolved = true;
              this.stepoverFeint(p, 'fakeshot');
              // The ball is dragged across the body to the chosen side.
              const s = a.side ?? 1;
              if (this.ball.owner === p.id && this.ball.state === 'dribble') {
                const cx = f.x * 0.35 - f.z * s * 0.45, cz = f.z * 0.35 + f.x * s * 0.45;
                this.ball.pos.x = p.pos.x + cx; this.ball.pos.z = p.pos.z + cz;
                this.ball.vel = { x: p.vel.x, y: 0, z: p.vel.z };
              }
              p.burst = Math.max(p.burst, 0.5);
            }
            const br = dirOf(angleOf(f.x, f.z) + (a.side ?? 1) * 1.1);
            p.wish = { x: br.x, z: br.z, mode: 'sprint', face: null };
          }
        } else if (a.dir) {
          p.wish = { x: a.dir.x, z: a.dir.z, mode: 'sprint', face: null };
        }
      }
      if (a.type === 'stumble' || a.type === 'down' || a.type === 'jump') p.wish = { x: 0, z: 0, mode: 'walk', face: a.type === 'jump' ? p.facing : null };
      if (a.t >= a.dur) {
        if (a.type === 'barge' && a.missed) {
          p.action = { type: 'stumble', t: 0, dur: 0.25 };
        } else if (a.type === 'tackle' && a.resolved && a.missed) {
          p.action = { type: 'stumble', t: 0, dur: a.quickRecover ? PLAYER.stumbleTime * 0.45 : PLAYER.stumbleTime };
        } else if (a.type === 'dive') {
          p.action = { type: 'down', t: 0, dur: 0.55 };
        } else if (a.type === 'slide') {
          p.action = { type: 'stumble', t: 0, dur: a.block ? PLAYER.slideDown * 0.55 : PLAYER.slideDown };
        } else p.action = { type: 'none', t: 0, dur: 0 };
      }
    }
  }

  /**
   * Kicks with their own solvers: the keeper's distribution from the hands (roll, throw, drop-kick,
   * punt) and the three crosses (floated, whipped, low driven). Null for everything else.
   */
  private specialKick(p: Player, ctx: KickContext, isHolder: boolean, isRestartTaker: boolean): { res: { vel: V3; spin: number }; flight: Ball['flight']; receiver: number; y?: number } | null {
    const a = p.action;
    const kind = a.kind!;
    const dir = this.attackDir(p.team);
    const inDir = a.dir ?? { x: 0, z: 0 };
    let receiver = a.receiver ?? -1;
    let target: V2 | null = a.target ? { x: a.target.x, z: a.target.z } : null;
    if (isHolder) {
      const d: Distribution = a.variant === 'roll' ? 'roll' : a.variant === 'dropkick' ? 'dropkick' : a.variant === 'punt' ? 'punt' : kind === 'throw' ? 'throw' : 'punt';
      if (!target) {
        const pick = pickDistribution(this.players, p, inDir.x, inDir.z, d, dir, a.charged ? a.power : undefined);
        receiver = pick.receiver;
        target = pick.target;
      }
      if (d === 'roll') {
        // Rolled out along the ground from the keeper's hand: slower and very accurate.
        const c = { ...ctx, ballPos: { ...ctx.ballPos, y: 0.12 }, accuracy: (ctx.accuracy ?? 1) * 0.55 };
        const r = solveGroundPass(c, target, 'pass');
        const sp = Math.hypot(r.vel.x, r.vel.z);
        if (sp > 19) { r.vel.x *= 19 / sp; r.vel.z *= 19 / sp; }
        return { res: r, flight: 'pass', receiver, y: 0.12 };
      }
      if (d === 'throw') return { res: solveLob({ ...ctx, ballPos: { ...ctx.ballPos, y: 2.0 } }, target, 'throw'), flight: 'throw', receiver, y: 2.0 };
      const c = { ...ctx, ballPos: { ...ctx.ballPos, y: 0.6 }, accuracy: (ctx.accuracy ?? 1) * (d === 'punt' ? 1.35 : 1.1) };
      return { res: solveLob(c, target, d), flight: 'lob', receiver, y: 0.6 };
    }
    if (isRestartTaker) return null;
    // Crosses: the AI asks for a style; a human lob from wide is floated, or whipped with the
    // modifier (also early, from deeper); a driven pass from wide into the box is a low cross.
    let style: 'floated' | 'whipped' | 'lowcross' | null = a.variant === 'floated' || a.variant === 'whipped' || a.variant === 'lowcross' ? a.variant : null;
    if (style === 'whipped' && kind === 'lob' && !inCrossZone(p.pos, dir, true)) style = null; // a plain lob from elsewhere
    if (!style && kind === 'lob' && !a.assist && inCrossZone(p.pos, dir)) style = 'floated';
    if (!style && kind === 'pass' && a.variant === 'driven' && !a.assist && inCrossZone(p.pos, dir)) style = 'lowcross';
    if (!style && kind === 'cross') style = 'floated';
    if (!style) return null;
    if (!target || (receiver >= 0 && !a.exact)) {
      if (receiver < 0) {
        // Human: the teammate nearest the stick among those attacking the box (any teammate if none).
        const sel = selectReceiver(this.players, p, inDir.x, inDir.z, style === 'lowcross' ? 'pass' : 'lob', dir, { power: a.charged ? a.power : undefined, driven: style === 'lowcross', lofted: style !== 'lowcross', help: ctx.help });
        receiver = sel.receiver;
        target = sel.target;
      }
      if (receiver >= 0) {
        const r = this.players[receiver];
        const inBox = Math.abs(r.pos.x - dir * PITCH.halfLength) < 22 && Math.abs(r.pos.z) < 20;
        target = inBox || style === 'floated' ? crossTarget(p, r, style, dir) : leadTarget(p, r, 'lob', dir);
      }
    }
    if (style === 'lowcross') {
      const r = solveGroundPass(ctx, target!, 'pass', true);
      return { res: r, flight: 'pass', receiver };
    }
    return { res: solveCross(ctx, target!, style, dir), flight: 'cross', receiver };
  }

  /**
   * A throw-in. Short: a flat throw to a teammate's feet. Long: a high, looping throw (a strong
   * thrower reaches the penalty spot from the touchline). Down the line: ahead of a teammate, into
   * space. Without a target, the stick picks the teammate as for a pass.
   */
  private throwIn(p: Player, ctx: KickContext, a: Player['action'], dir: 1 | -1): { res: { vel: V3; spin: number }; receiver: number } {
    const style = a.variant === 'longthrow' || a.variant === 'linethrow' ? a.variant : 'shortthrow';
    let receiver = a.receiver ?? -1;
    let target: V2 | null = a.target ? { x: a.target.x, z: a.target.z } : null;
    // Down the line with the stick left alone: straight up the touchline.
    const inDir = style === 'linethrow' && (!a.dir || Math.hypot(a.dir.x, a.dir.z) < 0.2) ? { x: dir * 0.96, z: -Math.sign(p.pos.z) * 0.28 } : a.dir ?? { x: 0, z: 0 };
    if (!target || (receiver >= 0 && !a.exact)) {
      if (receiver < 0) {
        const sel = selectReceiver(this.players, p, inDir.x, inDir.z, style === 'linethrow' ? 'through' : style === 'longthrow' ? 'lob' : 'pass', dir, { help: ctx.help });
        receiver = sel.receiver;
        target = sel.target;
      }
      if (receiver >= 0) target = style === 'linethrow' ? leadTarget(p, this.players[receiver], 'through', dir) : { ...this.players[receiver].pos };
    }
    if (!target) target = { x: p.pos.x + dir * 10, z: p.pos.z * 0.8 };
    // Within the thrower's range (a short throw stays short).
    const max = style === 'shortthrow' ? Math.min(18, throwRange(p)) : throwRange(p);
    const d = dist(ctx.ballPos, target);
    if (d > max) target = { x: ctx.ballPos.x + (target.x - ctx.ballPos.x) * (max / d), z: ctx.ballPos.z + (target.z - ctx.ballPos.z) * (max / d) };
    const res = solveLob(ctx, target, style === 'longthrow' ? 'longthrow' : style === 'linethrow' ? 'linethrow' : 'shortthrow');
    return { res, receiver };
  }

  /** The kick leaves the boot at the contact frame of the animation. */
  private releaseKick(p: Player) {
    const a = p.action;
    const b = this.ball;
    const r = this.restart;
    const isRestartTaker = r && r.ready && r.taker === p.id;
    const isHolder = b.state === 'held' && b.owner === p.id;
    const reach = dist(p.pos, b.pos);
    const canKick = isRestartTaker || isHolder || (b.owner === p.id && reach < 1.8) || (b.state !== 'dead' && b.state !== 'held' && reach < 1.3 && b.pos.y < 1.2 && b.owner < 0);
    if (!canKick) return; // whiffed: the ball moved away during the wind-up
    const kind = a.kind!;
    const team = p.team;
    const dir = this.attackDir(team);
    const firstTime = !isRestartTaker && !isHolder && b.owner === p.id && this.time - this.possessionStart < 0.3;
    const ctx: KickContext = { kicker: p, ballPos: { ...b.pos }, pressure: isRestartTaker ? 0 : pressureOn(p, this.players), rng: this.rng, accuracy: a.accuracy, firstTime, help: this.helpFor(p, !!isRestartTaker) };
    // Manual passing and shooting are for experts: no help with the aim or the weight.
    if (a.assist === 2) ctx.help = 0;
    // The home crowd's lift: cleaner strikes for the home side, a touch of nerves for the visitors (not penalties).
    const mk = this.momentum.kickError(team);
    if (mk !== 1 && !(isRestartTaker && r!.type === 'penalty')) ctx.accuracy = (ctx.accuracy ?? 1) * mk;
    if (isHolder || kind === 'throw') ctx.ballPos.y = Math.max(ctx.ballPos.y, isHolder ? 1.4 : 2.0);
    let receiver = a.receiver ?? -1;
    let target: V2 | null = a.target ? { x: a.target.x, z: a.target.z } : null;
    const inDir = a.dir ?? { x: 0, z: 0 };

    let res: { vel: V3; spin: number; dip?: number };
    let flight: Ball['flight'] = kind === 'shot' ? 'shot' : kind;
    let special: ReturnType<Match['specialKick']> = null;
    let penTech: PenTech = 'normal';
    if (kind === 'shot') {
      let aimZ = a.target ? a.target.z : a.assist === 2 ? manualShotAim(p, dir, inDir.x, inDir.z) : aimFromInput(p, dir, inDir.x, inDir.z);
      // A free kick within range has a wall 9.15 m away: the shot is lofted to clear it if it can be.
      const wall = isRestartTaker && r!.type === 'freekick' && dist(p.pos, { x: dir * PITCH.halfLength, z: 0 }) < 30;
      const v = a.variant;
      const style = v === 'chip' || v === 'low' || v === 'power' || v === 'placed' || v === 'finesse' ? v : a.placed ? 'finesse' : undefined;
      // Penalties and direct free kicks (20 Nov 2026): the taker's rating, nerves (computer takers; a
      // human's ring wobbles instead), a keeper dancing on his line, a stutter.
      const human = !!this.controlOf(p);
      if (isRestartTaker && r!.type === 'penalty') {
        const rt = setPieceRatings(p.def);
        penTech = variantTech(v);
        ctx.accuracy = (ctx.accuracy ?? 1) * ratingError(rt.pen) * (human ? 1 : nerveError(matchPressure(this, team), rt.comp)) * danceError(r!.gk?.dance ?? 0, rt.comp) * (r!.stutter ? SETPIECE.stutterError : 1);
        if (!human && penTech !== 'panenka' && SP_ON.duel) aimZ = this.aiPenaltyRead(r!, rt.comp, aimZ);
      } else if (wall) {
        const rt = setPieceRatings(p.def);
        ctx.accuracy = (ctx.accuracy ?? 1) * ratingError(rt.fk) * (human ? 1 : nerveError(matchPressure(this, team), rt.comp));
      }
      // Free-kick run-ups: a long one adds pace and a little error, a short one is tidier and softer, straight on curls less.
      const rs = wall ? r!.runStyle ?? 0 : 0;
      let power = a.power ?? 0.6;
      if (rs === 1) { power = Math.min(1, power * 1.07); ctx.accuracy = (ctx.accuracy ?? 1) * 1.08; }
      if (rs === 2) { power *= 0.93; ctx.accuracy = (ctx.accuracy ?? 1) * 0.9; }
      const curve = rs === 3 && a.curve !== undefined ? a.curve * 0.6 : a.curve;
      // A low drive is kept under the wall's jump rather than lifted over it.
      // A knuckleball still has to get over the wall: it is solved with its late dip and no curl.
      const knuckle = !!a.knuckle && !!wall;
      const clear = wall && style !== 'low' ? { d: PITCH.restartDistance + 0.4 - (r!.wall?.creep ?? 0), h: 2.3 } : undefined;
      res = solveShot(ctx, { side: dir, aimZ, power, placed: style === 'finesse', style, clear, curve: knuckle ? 0 : curve, dip: knuckle ? 3.5 / 9 : a.dip });
      if (knuckle) {
        res = { ...res, spin: 0, dip: 3.5 };
        this.knuckle = { kicker: p.id, t0: this.time, amp: this.rng.range(6, 10) * (rs === 3 ? 1.3 : 1), freq: this.rng.range(8, 11), phase: this.rng.range(0, Math.PI * 2) };
        this.emit('call', { team, player: p.id, text: 'knuckle' });
      }
    } else if (kind === 'throw' && !isHolder) {
      const t = this.throwIn(p, ctx, a, dir);
      res = t.res;
      receiver = t.receiver;
    } else if ((special = this.specialKick(p, ctx, isHolder, !!isRestartTaker))) {
      res = special.res;
      flight = special.flight;
      receiver = special.receiver;
    } else {
      const driven = kind === 'pass' && a.variant === 'driven';
      const lofted = kind === 'through' && a.variant === 'lofted';
      if (!target && a.locked && receiver >= 0 && !this.players[receiver].off) {
        target = leadTarget(p, this.players[receiver], kind === 'throw' ? 'pass' : kind, dir);
      } else if (!target && a.assist && kind !== 'throw') {
        // Semi: the stick picks a teammate in a narrow cone, but the charge alone sets how far the ball goes.
        // Manual: no teammate is picked; the ball goes where the stick points, as far as the charge says.
        const selKind = kind === 'through' ? 'through' : kind === 'pass' ? 'pass' : 'lob';
        const far = wantedDistance(selKind, a.power ?? 0.5, driven) * (lofted ? 1.15 : 1);
        let u = norm(inDir.x, inDir.z);
        if (u.x === 0 && u.z === 0) u = dirOf(p.facing);
        receiver = -1;
        if (a.assist === 1) {
          const sel = selectReceiver(this.players, p, u.x, u.z, selKind, dir, { power: a.power, driven, lofted, cone: SEMI_PASS_ANGLE });
          if (sel.receiver >= 0) { receiver = sel.receiver; u = norm(sel.target.x - p.pos.x, sel.target.z - p.pos.z); }
        }
        target = clampToPitch({ x: p.pos.x + u.x * far, z: p.pos.z + u.z * far });
      } else if (!target) {
        const selKind = kind === 'through' ? 'through' : kind === 'pass' || kind === 'throw' ? 'pass' : 'lob';
        const sel = selectReceiver(this.players, p, inDir.x, inDir.z, selKind, dir, { power: a.charged ? a.power : undefined, driven, lofted, help: ctx.help, runner: !!this.controlOf(p) && !isRestartTaker });
        receiver = sel.receiver;
        target = sel.target;
      } else if (receiver >= 0 && !a.exact) {
        target = leadTarget(p, this.players[receiver], kind, dir);
      }
      // Partnerships: a pass between two teammates with an understanding is a little more accurate.
      const lk = receiver >= 0 ? linkLevel(this, p.id, receiver) : 0;
      if (lk > 0) ctx.accuracy = (ctx.accuracy ?? 1) * (1 - LINK.accuracy * lk);
      // Pass into space: holding sprint as you pass plays it ahead of the teammate, into their stride.
      const c0 = this.controlOf(p);
      const intoSpace = kind === 'pass' && !driven && !a.assist && !a.exact && receiver >= 0 && !!c0 && c0.input.sprint && !isRestartTaker;
      // A human's through ball (or pass into space) to a teammate goes where he and the ball meet in his stride.
      const plan = c0 && !isRestartTaker && !a.exact && a.assist !== 2 && receiver >= 0 && this.players[receiver].role !== 'GK' && ((kind === 'through' && !a.assist) || intoSpace)
        ? throughPlan(this.players, p, this.players[receiver], b.pos, dir) : null;
      this.stride = plan ? { receiver, point: plan.point, until: this.time + plan.t + 1.2, plan } : null;
      const noRoom = !plan && !lofted && c0 && kind === 'through' && !a.assist && !a.exact && receiver >= 0 && !isRestartTaker;
      if (noRoom) {
        // No room to play it into his stride (he is near the line, or level with the passer): to his feet instead.
        target = leadTarget(p, this.players[receiver], 'pass', dir);
        res = solveGroundPass(ctx, target, 'pass');
        flight = 'pass';
        this.stride = { receiver, point: target, until: this.time + 3 };
      } else if (plan && !lofted) {
        target = plan.point;
        res = solveGroundPass(ctx, target, 'through', false, plan.arrive);
        flight = 'through';
      } else if (intoSpace) {
        target = leadTarget(p, this.players[receiver], 'through', dir);
        res = solveGroundPass(ctx, target, 'through');
        flight = 'through';
      } else if (lofted) {
        // Lofted through ball: over the defence, dropping into the runner's path (a few metres short, as it bounces on).
        if (plan) { const u = norm(plan.point.x - b.pos.x, plan.point.z - b.pos.z); target = { x: plan.point.x - u.x * 3, z: plan.point.z - u.z * 3 }; }
        res = solveLob(ctx, target, 'lob');
        flight = 'lob';
      } else if (kind === 'pass' || kind === 'through') {
        res = solveGroundPass(ctx, target, kind, driven);
        // Early receiver: the held charge weighs the pass, from a soft one to a firm one.
        if (a.locked) { const k = 0.88 + 0.3 * (a.power ?? 0.4); res.vel.x *= k; res.vel.z *= k; }
        else if (a.assist) {
          // Semi/Manual: weighted to roll about as far as the charge asked for, with the kicker's usual error.
          const sp = Math.hypot(res.vel.x, res.vel.z), d = dist(b.pos, target);
          const want = Math.sqrt((driven ? 6 : 2.5) ** 2 + 2 * BALL.rollDecel * d) * (1 + this.rng.gauss() * (0.03 + 0.06 * (1 - p.a.passing)));
          res.vel.x *= want / sp; res.vel.z *= want / sp;
        }
      }
      else if (kind === 'throw' && dist(p.pos, target) < 18 && !isHolder) res = solveLob(ctx, target, 'throw');
      else if (kind === 'throw') res = isHolder ? solveLob(ctx, target, 'throw') : solveLob(ctx, target, 'throw');
      else res = solveLob(ctx, target, kind === 'cross' ? 'cross' : kind === 'clear' ? 'clear' : 'lob');
      if (kind === 'lob' && Math.abs(p.pos.x - dir * PITCH.halfLength) < 30 && Math.abs(p.pos.z) > 14) flight = 'cross';
    }
    if (isHolder || kind === 'throw') b.pos.y = special?.y ?? ctx.ballPos.y;
    if (isHolder) {
      // Release from the hands slightly in front of the keeper.
      const f = dirOf(p.facing);
      b.pos.x = p.pos.x + f.x * 0.5;
      b.pos.z = p.pos.z + f.z * 0.5;
    }
    b.vel = res.vel;
    b.spin = res.spin;
    b.dip = res.dip ?? 0;
    b.state = 'flight';
    b.flight = flight;
    b.owner = -1;
    b.receiver = receiver;
    this.glanced.clear();
    b.lastTouch = p.id;
    b.lastTouchTeam = team;
    b.kicker = p.id;
    b.kickLock = 0.3;
    b.stillTime = 0;
    this.lastKickTime = this.time;
    this.lastKickHelp = ctx.help ?? 0;
    if (this.indirectTaker >= 0 && this.indirectTaker !== p.id) this.indirectTaker = -1;
    const power = Math.hypot(res.vel.x, res.vel.y, res.vel.z);
    this.emit('kick', { player: p.id, team, power, x: b.pos.x, z: b.pos.z, text: kind });
    // A human's teammates near the shot's path throw themselves in front of it.
    if (kind === 'shot') shotBlockLunges(this, p);
    // Third-man run: a forward pass to a teammate can set another attacker off in behind.
    if (!isRestartTaker && !isHolder && receiver >= 0 && (flight === 'pass' || flight === 'through') && kind !== 'shot') thirdManRun(this, p, this.players[receiver]);
    // Pass and move: a human's passer runs on for the next ball (decided before control moves to the receiver).
    if (!isRestartTaker && !isHolder && receiver >= 0 && (flight === 'pass' || flight === 'through') && kind !== 'shot' && this.controlOf(p)) humanPassAndMove(this, p, this.players[receiver]);

    if (kind === 'shot') {
      this.stats[team].shots++;
      const cross = predictGoalLine(b, dir, 3);
      const onTarget = !!cross && Math.abs(cross.z) < PITCH.goalHalfWidth && cross.y < PITCH.goalHeight;
      if (onTarget) this.stats[team].onTarget++;
      this.lastShot = { team, player: p.id, onTarget, time: this.time };
      this.countShot(p, onTarget);
    } else if (KICK_STATES.includes(kind) || kind === 'clear') {
      this.stats[team].passes++;
      this.pstats[p.id].passes++;
    }

    // Offside is judged at the moment a teammate plays the ball (not from throw-ins, goal kicks or corners).
    const exempt = !!isRestartTaker && (r!.type === 'throwin' || r!.type === 'goalkick' || r!.type === 'corner');
    this.evaluateOffside(p, exempt);

    if (isRestartTaker && r!.type === 'freekick') {
      const w = wallFor(this, r!);
      this.fkWall = null;
      if (w) {
        // A computer wall jumps for a shot most of the time, a moment after it is struck (a human jumps it themselves).
        const lvl = levelOf(this, w.team);
        const human = this.ctrl[w.team].human;
        const jump = !human && kind === 'shot' && !r!.wallFooled && this.rng.chance(0.35 + 0.35 * lvl.tackleEagerness);
        this.fkWall = { team: w.team, ids: w.ids, taker: p.id, until: this.time + MATCH.wallActive, jumpAt: jump ? this.time + this.rng.range(0.02, 0.16) : -1, lier: w.lier };
        // The man lying behind the wall gets up once it has gone.
        if (w.lier >= 0) { const l = this.players[w.lier]; if (l.action.type === 'down') l.action.dur = l.action.t + 1.1; }
        // Attackers in the wall block the keeper's view; a dummy run has him guessing.
        if (kind === 'shot' && (r!.routine === 4 || r!.routine === 3) && SP_ON.routines) this.keeperBlind = { team: w.team, until: this.time + 2, extra: r!.routine === 4 ? 0.12 : 0.08 };
      }
    }
    if (isRestartTaker && r!.type === 'penalty') {
      this.penKickTime = this.time;
      this.penTech = penTech;
      const pc = predictGoalLine(b, dir, 3);
      if (pc) this.penHistory[team].push(Math.abs(pc.z) < 0.7 ? 0 : Math.sign(pc.z));
      if (penTech !== 'normal') this.emit('call', { team, player: p.id, text: `pen:${penTech}` });
      this.penaltyStruck(r!);
    }
    if (isRestartTaker) this.restartTaken(p);
    if (isHolder) this.holdT = 0;

    // Control passes to the intended receiver straight away so they can move to the ball.
    const c = receiver >= 0 && this.players[receiver].role !== 'GK' ? this.receivingControl(team, p.id, receiver) : null;
    if (c) this.handToReceiver(c, team, receiver);
  }

  /** Control follows a pass to its receiver; the stick held for the pass is carried over (see Control.carry). */
  private handToReceiver(c: Control, team: number, receiver: number) {
    c.pid = receiver;
    const m = Math.hypot(c.input.mx, c.input.mz);
    c.carry = m > 0.3 ? angleOf(c.input.mx, c.input.mz) : undefined;
    c.carryKind = 'pass';
    c.pend = undefined;
    this.emit('switch', { team, player: receiver, text: 'pass' });
  }

  private evaluateOffside(passer: Player, exempt: boolean) {
    this.offside.flagged.clear();
    this.offside.team = passer.team;
    if (exempt || this.cfg.street) return; // no offside in the street
    const dir = this.attackDir(passer.team);
    const fx = (p: { x: number }) => p.x * dir;
    const opp = this.players.filter((o) => o.team !== passer.team && !o.off).map((o) => fx(o.pos)).sort((a, b) => b - a);
    const secondLast = opp[1];
    const ballFx = fx(this.ball.pos);
    for (const t of this.players) {
      if (t.team !== passer.team || t.id === passer.id || t.off) continue;
      const x = fx(t.pos);
      if (x > 0 && x > ballFx + 0.05 && x > secondLast + 0.05) this.offside.flagged.add(t.id);
    }
  }

  private resolveTackle(t: Player) {
    const b = this.ball;
    const a = t.action;
    const owner = b.owner >= 0 ? this.players[b.owner] : null;
    const toBall = { x: b.pos.x - t.pos.x, z: b.pos.z - t.pos.z };
    const ballDist = Math.hypot(toBall.x, toBall.z);
    const facingOk = Math.abs(wrapAngle(angleOf(toBall.x, toBall.z) - t.facing)) <= (PLAYER.tackleConeDeg * Math.PI) / 180;
    const ballReachable = ballDist <= PLAYER.tackleReach && facingOk && b.pos.y < 0.8 && b.state !== 'held' && b.state !== 'dead';
    if (owner && owner.team === t.team) { a.missed = false; return; }
    if (!owner) {
      // Loose ball: a tackle that reaches it simply pokes it away.
      if (ballReachable) {
        this.pokeBall(t, 5);
        a.missed = false;
      } else a.missed = true;
      return;
    }
    const carrierDist = dist(t.pos, owner.pos);
    const fromBehind = Math.abs(wrapAngle(angleOf(t.pos.x - owner.pos.x, t.pos.z - owner.pos.z) - owner.facing)) > (110 * Math.PI) / 180;
    this.stats[t.team].tackles++;
    if (ballReachable) {
      const separated = dist(owner.pos, b.pos) > 0.6 ? 0.2 : 0;
      // A standing tackle from a set jockey stance (side-on, already matching the carrier) is better timed.
      const set = a.jockeySet ? 0.12 : 0;
      const pClean = clamp(0.45 + 0.45 * t.a.tackling - 0.25 * owner.a.control + separated + set - (fromBehind ? 0.25 : 0) - 0.6 * this.shieldBonus(owner, t), 0.08, 0.92);
      if (this.rng.chance(pClean)) {
        a.missed = false;
        this.emit('tackle', { player: t.id, team: t.team });
      this.pstats[t.id].tackles++;
        owner.action = { type: 'stumble', t: 0, dur: 0.3 };
        if (this.rng.chance(0.35 + 0.4 * t.a.tackling)) this.takePossession(t, true);
        else this.pokeBall(t, 4 + this.rng.next() * 3);
        return;
      }
      if (fromBehind && carrierDist < 1.3) { this.foul(t, owner, { fromBehind: true }); return; }
      a.missed = true; // failed tackle from the front: carrier keeps the ball, tackler stumbles
      if (a.jockeySet) a.quickRecover = true; // a poke from the jockey stance doesn't commit the body
      return;
    }
    if (carrierDist < 1.1) { this.foul(t, owner, { fromBehind }); return; }
    a.missed = true;
  }

  /** Each tick of a slide's contact window: the boots reach the ball (clean) or the carrier's legs (foul). */
  private resolveSlide(t: Player) {
    const b = this.ball;
    const a = t.action;
    const f = dirOf(t.facing);
    const boots = { x: t.pos.x + f.x * 0.9, z: t.pos.z + f.z * 0.9 };
    const owner = b.owner >= 0 ? this.players[b.owner] : null;
    if (owner && owner.team === t.team) return;
    const ballHit = dist(boots, b.pos) < PLAYER.slideReach && b.pos.y < 0.5 && b.state !== 'held' && b.state !== 'dead';
    const legs = owner ? Math.min(dist(boots, owner.pos), dist(t.pos, owner.pos)) < 0.9 : false;
    if (!ballHit && !legs) return;
    a.resolved = true;
    if (owner) this.stats[t.team].tackles++;
    const fromBehind = !!owner && Math.abs(wrapAngle(angleOf(t.pos.x - owner.pos.x, t.pos.z - owner.pos.z) - owner.facing)) > (110 * Math.PI) / 180;
    if (owner && (!ballHit || (fromBehind && legs))) {
      this.foul(t, owner, { slide: true, fromBehind });
      return;
    }
    // Clean: the ball is knocked away to one side of the slide (not back into the carrier); the carrier goes over.
    if (owner) {
      owner.action = { type: 'stumble', t: 0, dur: 0.5 };
      this.emit('tackle', { player: t.id, team: t.team });
      this.pstats[t.id].tackles++;
    }
    const side = this.rng.chance(0.5) ? 1 : -1;
    const ang = t.facing + side * this.rng.range(0.7, 1.3);
    const sp = 5 + this.rng.next() * 4;
    this.pokeBall(t, sp);
    this.ball.vel.x = Math.cos(ang) * sp;
    this.ball.vel.z = Math.sin(ang) * sp;
  }

  private pokeBall(p: Player, speed: number) {
    const b = this.ball;
    const f = dirOf(p.facing + this.rng.gauss() * 0.5);
    b.vel = { x: f.x * speed, y: 0.5, z: f.z * speed };
    b.state = 'free';
    b.flight = 'deflect';
    b.owner = -1;
    b.receiver = -1;
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.kicker = p.id;
    b.kickLock = 0.25;
    b.stillTime = 0;
    this.offside.flagged.clear();
  }

  /**
   * A foul. The referee may book the offender (yellow), send them off (red: denying an obvious
   * goal-scoring chance, a reckless slide, or a second yellow), and plays advantage when the
   * fouled side keeps the ball in a promising position.
   */
  private foul(offender: Player, victim: Player, how: { slide?: boolean; fromBehind?: boolean; tactical?: boolean } = {}) {
    this.stats[offender.team].fouls++;
    this.pstats[offender.id].fouls++;
    this.stoppage += 12;
    if (offender.action.type !== 'slide') offender.action = { type: 'none', t: 0, dur: 0 };
    this.emit('foul', { player: offender.id, team: offender.team, x: victim.pos.x, z: victim.pos.z });
    const team = victim.team;
    const inBox = this.inPenaltyArea(offender.team, victim.pos);
    const card = this.cardFor(offender, victim, how, inBox);
    const spot = { x: clamp(victim.pos.x, -PITCH.halfLength + 1, PITCH.halfLength - 1), z: clamp(victim.pos.z, -PITCH.halfWidth + 1, PITCH.halfWidth - 1) };
    // Advantage: outside the area and away from the fouled side's own third, when the fouled player
    // rides the challenge and keeps the ball, or a teammate is right there to pick it up. Never for
    // a straight red. Further forward the referee is more willing to let play go on.
    const fx = victim.pos.x * this.attackDir(team);
    if (!inBox && card < 2 && fx > -18 && !this.advantage && this.phase === 'play' && !how.tactical) {
      const forward = clamp((fx + 18) / 50, 0, 1);
      const keepsBall = this.ball.owner === victim.id && this.rng.chance(0.3 + 0.35 * victim.a.control + 0.15 * forward);
      const mate = keepsBall ? null : this.advantageMate(victim);
      if (keepsBall || (mate && this.rng.chance(0.4 + 0.3 * forward))) {
        if (keepsBall) { victim.vel.x *= 0.5; victim.vel.z *= 0.5; }
        this.advantage = { team, spot, until: this.time + MATCH.advantageTime, offender: offender.id, card };
        this.emit('advantage', { team, x: spot.x, z: spot.z, player: victim.id, power: card });
        return;
      }
    }
    victim.action = { type: 'stumble', t: 0, dur: 0.9 };
    this.emit('whistle', { power: 2, text: 'foul' });
    if (inBox) {
      const pen = { x: this.ownGoalX(offender.team) + this.attackDir(offender.team) * PITCH.penaltySpot, z: 0 };
      this.award('penalty', team, pen);
    } else this.award('freekick', team, spot);
    this.giveCard(offender, card);
    maybeInjure(this, victim, how, card);
  }

  /** 0 no card, 1 yellow, 2 straight red. */
  private cardFor(offender: Player, victim: Player, how: { slide?: boolean; fromBehind?: boolean; tactical?: boolean }, inBox: boolean): 0 | 1 | 2 {
    // Denying an obvious goal-scoring opportunity: the fouled player was through on goal with no defender left to cover.
    const dir = this.attackDir(victim.team);
    const goal = { x: dir * PITCH.halfLength, z: 0 };
    const vGoal = dist(victim.pos, goal);
    const hadBall = this.ball.owner === victim.id;
    let cover = 0;
    for (const o of this.teamPlayers(offender.team)) {
      if (o.role === 'GK' || o.id === offender.id) continue;
      if (dist(o.pos, goal) < vGoal && Math.abs(o.pos.z) < 22) cover++;
    }
    if (hadBall && vGoal < 30 && Math.abs(victim.pos.z) < 18 && cover === 0 && offender.role !== 'GK') {
      // In the area a genuine attempt at the ball is a penalty and a yellow (only a slide from behind stays red).
      if (!inBox || (how.slide && how.fromBehind)) return 2;
      return 1;
    }
    let pRed = 0, pYellow = 0.1;
    // A deliberate pull-back that stops a promising attack (a counter, or the carrier heading for goal) is a booking.
    if (how.tactical) pYellow = this.time - this.wonBallAt[victim.team] < 8 || vGoal < 45 ? TACTICAL.yellowAttack : TACTICAL.yellowOther;
    if (how.slide) { pYellow = 0.4; pRed = how.fromBehind ? 0.25 : 0.03; }
    if (how.fromBehind) pYellow += 0.3;
    const roll = this.rng.next();
    if (roll < pRed) return 2;
    if (roll < pRed + pYellow) return 1;
    return 0;
  }

  private giveCard(p: Player, card: 0 | 1 | 2) {
    if (card === 0 || p.off) return;
    if (card === 1) {
      p.cards++;
      if (p.cards >= 2) this.pstats[p.id].red++; else this.pstats[p.id].yellow++;
      this.stats[p.team].yellows++;
      if (p.cards >= 2) {
        this.stats[p.team].reds++;
        { this.emit('card', { player: p.id, team: p.team, text: 'second' }); this.stoppage += 20; }
        this.sendOff(p);
      } else { this.emit('card', { player: p.id, team: p.team, text: 'yellow' }); this.stoppage += 20; }
      return;
    }
    p.cards = 2;
    this.pstats[p.id].red++;
    this.stats[p.team].reds++;
    { this.emit('card', { player: p.id, team: p.team, text: 'red' }); this.stoppage += 20; }
    this.sendOff(p);
  }

  /** The player leaves the pitch for the rest of the match; the team plays on with ten. */
  private sendOff(p: Player) {
    p.off = true;
    p.action = { type: 'none', t: 0, dur: 0 };
    p.queued = null;
    p.vel = { x: 0, z: 0 };
    p.pos = { x: -6 + p.team * 12, z: PITCH.halfWidth + 9 };
    if (this.ball.owner === p.id) { this.ball.owner = -1; this.ball.state = 'free'; }
    for (const c of [this.ctrl[p.team], this.mates[p.team]]) {
      if (!c || c.pid !== p.id) continue;
      const next = this.bestSwitchCandidate(p.team, p.id);
      if (next >= 0) { c.pid = next; this.emit('switch', { team: p.team, player: next }); }
    }
    if (this.restart && this.restart.taker === p.id) this.restart.taker = this.pickTaker(this.restart.type, this.restart.team, this.restart.spot);
  }

  /**
   * A teammate of the fouled player close enough to the loose ball to pick it up straight away
   * (nearer to it than any opponent), or null.
   */
  private advantageMate(victim: Player): Player | null {
    const b = this.ball;
    if (b.owner >= 0 || b.pos.y > 1.2) return null;
    let mate: Player | null = null, md = 4, od = Infinity;
    for (const p of this.players) {
      if (p.off || p.id === victim.id) continue;
      const d = dist(p.pos, b.pos);
      if (p.team === victim.team) { if (d < md) { md = d; mate = p; } }
      else od = Math.min(od, d);
    }
    return mate && md < od - 0.5 ? mate : null;
  }

  /** Bookings held back while advantage was played: shown at the next stoppage, as a referee would. */
  pendingBookings: { offender: number; card: 0 | 1 | 2 }[] = [];

  /** Resolve a pending advantage. A booking waits for the next stoppage (or is given now when play has stopped). */
  private endAdvantage(over = false) {
    const adv = this.advantage;
    if (!adv) return;
    this.advantage = null;
    if (adv.card > 0) this.pendingBookings.push({ offender: adv.offender, card: adv.card });
    if (over) this.emit('advantage', { team: adv.team, text: 'over' });
    if (this.phase !== 'play') this.giveBookings();
  }

  /** Give the bookings held back during advantage (called whenever play stops). */
  private giveBookings() {
    const list = this.pendingBookings;
    this.pendingBookings = [];
    for (const k of list) this.giveCard(this.players[k.offender], k.card);
  }

  /** While advantage is being played: call the free kick back if the fouled side loses the ball. */
  private checkAdvantage() {
    const adv = this.advantage;
    if (!adv) return;
    const b = this.ball;
    const lost = b.owner >= 0 && this.players[b.owner].team !== adv.team;
    if (lost) {
      this.emit('whistle', { power: 2, text: 'foul' });
      this.debugLog('advantage did not materialise: free kick brought back');
      this.advantage = null;
      if (adv.card > 0) this.pendingBookings.push({ offender: adv.offender, card: adv.card });
      this.award('freekick', adv.team, adv.spot);
      return;
    }
    if (this.time > adv.until) this.endAdvantage(true);
  }

  // ---------------------------------------------------------------- movement

  /** Set a player's wish to arrive at T (slowing on approach). */
  arrive(p: Player, T: V2, mode: Player['wish']['mode'] = 'jog', face: number | null = null) {
    const dx = T.x - p.pos.x, dz = T.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3) { p.wish = { x: 0, z: 0, mode: 'walk', face }; return; }
    const speedWanted = Math.min(1, d / 3.5);
    let m = mode;
    if (mode === 'sprint' && d < 4) m = 'jog';
    if (mode === 'jog' && d < 1.5) m = 'walk';
    p.wish = { x: (dx / d) * speedWanted, z: (dz / d) * speedWanted, mode: m, face };
  }

  private moveAll(dt: number) {
    for (const p of this.players) {
      if (p.off) continue;
      const w = p.wish;
      const busy = p.action.type === 'stumble' || p.action.type === 'down' || p.action.type === 'dive';
      if (p.action.type === 'dive') continue; // keeper dive motion is scripted in keeper.ts
      if (p.action.type === 'slide') {
        // Scripted slide: fast along the facing direction, then friction on the grass.
        const f = dirOf(p.facing);
        const sp = Math.max(PLAYER.slideSpeed * this.wplay.slide * clamp(1 - p.action.t / 0.5, 0, 1), 0);
        p.vel = { x: f.x * sp, z: f.z * sp };
        // Run-off around a pitch; a street cage's walls stop players at the boards.
        const ox = PITCH.walls ? -0.35 : 4, oz = PITCH.walls ? -0.35 : 3;
        p.pos.x = clamp(p.pos.x + p.vel.x * dt, -PITCH.halfLength - ox, PITCH.halfLength + ox);
        p.pos.z = clamp(p.pos.z + p.vel.z * dt, -PITCH.halfWidth - oz, PITCH.halfWidth + oz);
        continue;
      }
      // An AI ball carrier starting a sprint gets the same burst a human gets by pressing sprint.
      if (w.mode === 'sprint' && !p.sprinting && this.ball.owner === p.id && !this.isHumanControlled(p)) this.tryBurst(p);
      let scale = busy ? 0.15 : this.ball.owner === p.id ? 0.95 : (p.action.type === 'kick' || p.action.type === 'throw') ? 0.55 : 1;
      let accel = 1;
      if (p.burst > 0 && !busy) { scale *= 1.06; accel = 1.9; }
      if (p.beaten > 0) { scale *= 0.35; accel = 0.5; }
      // A carrier running at a set, goal-side jockeying defender has to check their stride.
      if (this.ball.owner === p.id && this.ball.state === 'dribble' && this.jockeyedBy(p)) scale *= 0.88;
      // On the ball, turns are tighter, more so for better control and tightest with close control.
      let mode = w.mode, turn = this.wplay.turn;
      if (this.ball.owner === p.id) {
        const cm = carrierMove(p.a, w.mode, this.closeIds.has(p.id));
        mode = cm.mode; scale *= cm.speed; accel *= cm.accel; turn *= cm.turn;
      }
      const st0 = p.stamina;
      stepMovement(p, w.x, w.z, mode, dt, w.face, scale * this.wplay.speed, accel * this.wplay.accel, turn);
      // The home crowd's lift: the home side's running costs them a little less.
      if (p.stamina < st0) { const k = this.momentum.staminaDrain(p.team); if (k < 1) p.stamina = st0 - (st0 - p.stamina) * k; }
      if (p.action.type === 'skill' && p.action.skill === 'roulette') p.facing = this.rouletteFacing(p.action);
    }
    // Player-player separation and simple contact reactions.
    const n = this.players.length;
    const minD = PLAYER.radius * 2;
    for (let i = 0; i < n; i++) {
      const a = this.players[i];
      if (a.off) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.players[j];
        if (b.off) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * push; a.pos.z -= nz * push;
        b.pos.x += nx * push; b.pos.z += nz * push;
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel < -2.5 && a.team !== b.team) {
          // Shoulder contact: both lose a little momentum.
          a.vel.x *= 0.82; a.vel.z *= 0.82;
          b.vel.x *= 0.82; b.vel.z *= 0.82;
        }
      }
    }
  }

  // ---------------------------------------------------------------- ball

  private stepBallInPlay(dt: number) {
    const b = this.ball;
    if (b.state === 'held') {
      const gk = this.players[b.owner];
      const f = dirOf(gk.facing);
      b.pos = { x: gk.pos.x + f.x * 0.35, y: 1.15, z: gk.pos.z + f.z * 0.35 };
      b.vel = { x: gk.vel.x, y: 0, z: gk.vel.z };
      this.holdT += dt;
      if (this.holdT > MATCH.keeperHoldMax && gk.action.type === 'none') {
        this.debugLog('keeper hold limit reached: forcing distribution');
        const req = chooseDistribution(this, gk).req;
        this.startKick(gk, req, req.kind === 'throw');
      }
      return;
    }
    const prev = { ...b.pos };
    const res = stepBall(b, dt, true);
    if (res.hitPost || res.hitBar) {
      if (this.skill) skillWoodwork(this, this.skill, res.hitBar && !res.hitPost);
      this.emit(res.hitPost ? 'post' : 'bar', { x: b.pos.x, z: b.pos.z, power: Math.hypot(b.vel.x, b.vel.z) });
      this.emit('chance', { team: b.lastTouchTeam });
      b.dip = 0;
      this.startScramble();
    }
    if (res.bounced > 2) this.emit('bounce', { power: res.bounced, x: b.pos.x, z: b.pos.z });
    if (b.state !== 'dribble' && G6.deflect) this.bobble(res.bounced);
    if (res.crossing) {
      this.handleCrossing(res.crossing);
      return;
    }
    if (b.state === 'flight' && Math.hypot(b.vel.x, b.vel.z) < 3 && b.pos.y < 0.3) {
      b.state = 'free';
      b.flight = 'none';
    }
    // Goalkeepers first (hands), then everybody else.
    for (const t of [0, 1]) {
      if (keeperSaveCheck(this, this.keeper(t), prev)) return;
    }
    this.playerBallInteraction(prev);
    if (this.phase !== 'play') return;
    if (b.state === 'dribble') this.dribble(dt);

    const slow = Math.hypot(b.vel.x, b.vel.z) < 0.3 && b.state !== 'dribble';
    b.stillTime = slow ? b.stillTime + dt : 0;
    if (b.stillTime > MATCH.stuckBallSeconds) {
      // Conservative recovery: drop ball to the nearest player's team at the ball's spot.
      let best = this.players[1], bd = Infinity;
      for (const p of this.players) {
        if (p.role === 'GK') continue;
        const d = dist(p.pos, b.pos);
        if (d < bd) { bd = d; best = p; }
      }
      this.debugLog(`stuck ball recovery at (${b.pos.x.toFixed(1)}, ${b.pos.z.toFixed(1)}): drop ball to team ${best.team}`);
      this.emit('recovery', { x: b.pos.x, z: b.pos.z });
      this.emit('whistle', { power: 1, text: 'stop' });
      this.award('dropball', best.team, { x: clamp(b.pos.x, -50, 50), z: clamp(b.pos.z, -32, 32) });
    }
  }

  /** Swept ball/player checks: control, first touches, headers, blocks and steals. */
  private playerBallInteraction(prev: V3) {
    const b = this.ball;
    const owner = b.owner >= 0 ? this.players[b.owner] : null;
    const bSpeed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    // A free kick meets the wall: each body covers the ball from its feet to head height (lifted by a jump).
    const fw = this.fkWall;
    const wall = fw && this.time < fw.until && b.state === 'flight' && b.kicker === fw.taker ? fw : null;
    if (wall) {
      for (const id of wall.ids) {
        const p = this.players[id];
        if (p.off) continue;
        const sx = b.pos.x - prev.x, sz = b.pos.z - prev.z;
        const l2 = sx * sx + sz * sz;
        const tt = l2 > 1e-9 ? clamp(((p.pos.x - prev.x) * sx + (p.pos.z - prev.z) * sz) / l2, 0, 1) : 1;
        const cx = prev.x + sx * tt, cz = prev.z + sz * tt, cy = prev.y + (b.pos.y - prev.y) * tt;
        const h = this.jumpHeight(p);
        if (Math.hypot(p.pos.x - cx, p.pos.z - cz) < PLAYER.wallReach && cy > h - 0.05 && cy < PLAYER.wallTop + h) {
          this.fkWall = null;
          this.deflect(p, 0.3, true);
          return;
        }
      }
      // The man lying behind the wall stops a shot skidded under it.
      if (wall.lier !== undefined && wall.lier >= 0) {
        const l = this.players[wall.lier];
        const g = norm(b.vel.x, b.vel.z);
        const a = { x: l.pos.x - g.z * 0.9, z: l.pos.z + g.x * 0.9 }, c = { x: l.pos.x + g.z * 0.9, z: l.pos.z - g.x * 0.9 };
        if (!l.off && sweptBodyHit(prev, b.pos, a, c, 0.22, 0.4)) {
          this.fkWall = null;
          this.deflect(l, 0.3, true);
          this.emit('call', { team: l.team, player: l.id, text: 'lieblock' });
          return;
        }
      }
    }
    // A body thrown in front of a shot (a block slide): legs and body along the slide, up to knee height or so.
    if (b.state === 'flight' || b.state === 'free') {
      for (const p of this.players) {
        const a = p.action;
        if (a.type !== 'slide' || !a.block || a.resolved || p.off || a.t < 0.02 || a.t > 0.6) continue;
        if (b.lastTouchTeam === p.team) continue;
        const f = dirOf(p.facing);
        const hit = sweptBodyHit(prev, b.pos, p.pos, { x: p.pos.x + f.x * 1.05, z: p.pos.z + f.z * 1.05 }, 0.38, 1.0);
        if (hit) {
          a.resolved = true;
          this.deflect(p, 0.32, true);
          return;
        }
      }
    }
    // A shot clipping a body near its path: a glancing deflection that changes its line (and wrong-foots the keeper).
    if (G6.deflect && b.state === 'flight' && b.flight === 'shot' && bSpeed > 12 && this.glanceCheck(prev)) return;
    // In a goalmouth scramble a loose ball cannons off whoever is in its way.
    if (b.state === 'free' && bSpeed > 4 && b.pos.y < 1.1 && this.inScramble() && this.ricochetCheck(prev)) return;
    let best: Player | null = null, bestScore = Infinity, bestY = 0;
    for (const p of this.players) {
      if (p === owner || p.off) continue;
      if (wall && wall.ids.includes(p.id)) continue; // the wall either blocks it (above) or it has gone past them
      if (p.touchCooldown > 0 || p.contestCooldown > 0) continue;
      if (b.kickLock > 0 && b.kicker === p.id) continue;
      if (this.dummy.pid === p.id && this.time < this.dummy.until && b.state === 'flight') continue;
      // A ball flicked over a defender: the flicker lets it drop before he takes it again.
      if (this.flickOver.pid === p.id && (this.time > this.flickOver.until || b.owner >= 0)) this.flickOver.pid = -1;
      if (this.flickOver.pid === p.id && b.pos.y > 1.05) continue;
      const at = p.action.type;
      if (at === 'stumble' || at === 'down' || at === 'dive' || at === 'tackle' || at === 'celebrate' || at === 'slide' || at === 'barge') continue;
      if (owner && owner.team === p.team) continue;
      // Closest approach of the ball path this tick to the player's vertical axis.
      const sx = b.pos.x - prev.x, sz = b.pos.z - prev.z;
      const l2 = sx * sx + sz * sz;
      let tt = l2 > 1e-9 ? ((p.pos.x - prev.x) * sx + (p.pos.z - prev.z) * sz) / l2 : 1;
      tt = clamp(tt, 0, 1);
      const cx = prev.x + sx * tt, cz = prev.z + sz * tt, cy = prev.y + (b.pos.y - prev.y) * tt;
      const d = Math.hypot(p.pos.x - cx, p.pos.z - cz);
      let reach = cy > PLAYER.controlHeight ? 0.7 : PLAYER.controlReach;
      // The intended receiver stretches for a pass played to them (a step and a reaching touch).
      // A human's pass (with help) is harder for an opponent to get a foot to.
      const kickedHelp = b.state === 'flight' && b.flight !== 'shot' && b.kicker >= 0 ? this.lastKickHelp : 0;
      if (b.receiver === p.id && b.state === 'flight' && cy <= PLAYER.controlHeight) reach += 0.5 + 0.3 * p.a.control + LINK.reach * linkLevel(this, b.kicker, p.id);
      // Anyone else has less time to react to a firmly struck ball in flight.
      else if (b.state === 'flight' && b.receiver >= 0 && cy <= PLAYER.controlHeight) reach *= clamp(1.25 - bSpeed / 20, 0.55, 1) * (this.players[b.kicker]?.team !== p.team ? 1 - 0.25 * kickedHelp : 1);
      // Just after a kick, only a body right in the ball's path can block it.
      if (b.kickLock > 0 && b.kicker >= 0 && this.players[b.kicker].team !== p.team) reach = Math.min(reach, 0.45);
      if (d > reach || cy > PLAYER.headerHeight) continue;
      if (owner && dist(p.pos, b.pos) > dist(owner.pos, b.pos) + 0.1) continue; // must be nearer than the dribbler
      const score = d - 0.25 * p.a.control + this.rng.next() * 0.2 - (b.receiver === p.id ? 0.15 : 0);
      if (score < bestScore) { bestScore = score; best = p; bestY = cy; }
    }
    if (!best) return;
    const p = best;

    if (owner) {
      // Attempt to steal the dribbled ball between touches.
      p.contestCooldown = 0.4;
      const sep = dist(owner.pos, b.pos) > (this.isHumanCarrier(owner) ? 1.1 : 0.8) ? 0.3 : 0;
      // A jockeying defender is set to nick the ball off a carrier who dribbles into them.
      const jk = p.jockeying ? (p.jockeyT > PLAYER.jockeySetTime ? 0.1 : 0.05) : 0;
      // Close control keeps it out of reach; a ball juggled in the air is hard to nick without fouling (19 Nov 2026).
      const bc = (this.closeIds.has(owner.id) ? BALLCTL.closeSteal : 1) * (isJuggle(owner.action) && b.pos.y > 0.45 ? 0.5 : 1);
      const pSteal = clamp((0.05 + 0.3 * p.a.tackling - 0.3 * owner.a.control + sep + jk) * (1 - this.shieldBonus(owner, p)) * bc, 0.02, 0.6);
      if (this.rng.chance(pSteal)) {
        this.emit('tackle', { player: p.id, team: p.team });
        if (this.rng.chance(0.5)) this.takePossession(p, false);
        else this.pokeBall(p, 3 + this.rng.next() * 3);
      }
      return;
    }

    const fastShot = b.flight === 'shot' && bSpeed > 17;
    // Intended receivers take a dropping ball on the chest; anyone else heads it.
    // A human holding close control chests a dropping ball down too, rather than heading it (19 Nov 2026).
    const chest = (b.receiver === p.id || (BC.chest && this.closeHeld(p))) && bestY < 1.9 && b.vel.y <= 0.5;
    if (bestY > 1.6 && !chest) {
      // Overhead kick (20 Nov 2026): shoot pressed as a high ball arrives with the player's back to goal.
      if (AERIAL7.overhead && p.queued?.kind === 'shot' && p.role !== 'GK' && bestY <= AERIAL7.overheadMax && !fastShot && dirOf(p.facing).x * this.attackDir(p.team) < AERIAL7.backToGoal) {
        if (this.checkOffsideInvolvement(p)) return;
        this.volley(p, bestY, true);
        return;
      }
      // Aerial duel: an opponent going up for the same ball can win it instead.
      this.header(G6.duels ? this.aerialDuel(p, prev) : p);
      return;
    }
    // Diving header (20 Nov 2026): shoot pressed at full tilt as a low cross arrives, near goal.
    if (AERIAL7.divingHeader && p.queued?.kind === 'shot' && p.role !== 'GK' && !fastShot && b.flight === 'cross' && bestY >= AERIAL7.diveLow && bestY <= AERIAL7.diveHigh
      && Math.hypot(p.vel.x, p.vel.z) >= AERIAL7.diveSpeed && Math.abs(this.attackDir(p.team) * PITCH.halfLength - p.pos.x) < AERIAL7.diveRange) {
      this.header(p, true);
      return;
    }
    // A shot pressed as the ball drops to knee-to-chest height: struck on the volley.
    if (p.queued?.kind === 'shot' && bestY > 0.35 && p.role !== 'GK' && !fastShot) {
      if (this.checkOffsideInvolvement(p)) return;
      this.volley(p, bestY);
      return;
    }
    if (fastShot && p.role !== 'GK') {
      this.deflect(p, 0.3, true);
      return;
    }
    const rel = Math.hypot(b.vel.x - p.vel.x, b.vel.y, b.vel.z - p.vel.z);
    const capacity = 7 + 9 * p.a.control + (this.isHumanCarrier(p) ? 3 : 0);
    const scramble = this.inScramble() ? SCRAMBLE.control : 0;
    // A human's own man brings a high ball down more surely, the more so with better control (19 Nov 2026).
    const high = bestY > PLAYER.controlHeight ? (BC.chest && this.isHumanCarrier(p) ? 0.25 - 0.2 * p.a.control : 0.25) : 0;
    const pClean = clamp(1.15 - Math.max(0, rel - capacity) / 12 - high - this.wplay.control - scramble, 0.2, 1);
    if (this.rng.chance(pClean)) this.takePossession(p, false);
    else this.deflect(p, 0.35, false);
  }

  /** Closest approach of this tick's ball path to a player's axis: horizontal distance and ball height there. */
  private pathGap(prev: V3, p: Player): { d: number; y: number } {
    const b = this.ball;
    const sx = b.pos.x - prev.x, sz = b.pos.z - prev.z;
    const l2 = sx * sx + sz * sz;
    const tt = l2 > 1e-9 ? clamp(((p.pos.x - prev.x) * sx + (p.pos.z - prev.z) * sz) / l2, 0, 1) : 1;
    return { d: Math.hypot(p.pos.x - (prev.x + sx * tt), p.pos.z - (prev.z + sz * tt)), y: prev.y + (b.pos.y - prev.y) * tt };
  }

  /**
   * Glancing deflection: a shot passing just wide of an outfield player's body (beyond where they
   * could block or control it) sometimes clips them. The line changes by a few degrees, the ball
   * loses some pace and the keeper has to read it again. The shooter keeps the credit.
   */
  private glanceCheck(prev: V3): boolean {
    const b = this.ball;
    for (const p of this.players) {
      if (p.off || p.role === 'GK' || p.id === b.kicker || this.glanced.has(p.id)) continue;
      if (b.kickLock > 0 && this.players[b.kicker]?.team === p.team) continue;
      const g = this.pathGap(prev, p);
      if (g.y > PLAYER.bodyHeight || g.d < SCRAMBLE.glanceFrom || g.d > SCRAMBLE.glanceTo) continue;
      this.glanced.add(p.id);
      if (!this.rng.chance(SCRAMBLE.glance * (1 - (g.d - SCRAMBLE.glanceFrom) / (SCRAMBLE.glanceTo - SCRAMBLE.glanceFrom) * 0.6))) continue;
      const sp = Math.hypot(b.vel.x, b.vel.z);
      // Clipped on the near side: knocked away from the body.
      const awaySide = Math.sign((p.pos.x - b.pos.x) * b.vel.z - (p.pos.z - b.pos.z) * b.vel.x) || 1;
      const ang = angleOf(b.vel.x, b.vel.z) + awaySide * (0.05 + Math.abs(this.rng.gauss()) * 0.14);
      const k = this.rng.range(0.8, 0.94);
      b.vel = { x: Math.cos(ang) * sp * k, y: b.vel.y * this.rng.range(0.6, 1.25) + this.rng.gauss() * 0.8, z: Math.sin(ang) * sp * k };
      b.spin = this.rng.gauss() * 2;
      b.dip = 0;
      this.lastKickTime = this.time; // the keeper reads the new line from here (after his reaction time)
      this.emit('call', { team: p.team, player: p.id, text: 'deflection', x: b.pos.x, z: b.pos.z });
      this.startScramble();
      return true;
    }
    return false;
  }

  /** Scramble: the loose ball hits a body in its way (not the player best placed to control it) and cannons off. */
  private ricochetCheck(prev: V3): boolean {
    const b = this.ball;
    for (const p of this.players) {
      if (p.off || p.role === 'GK' || (b.kickLock > 0 && b.kicker === p.id)) continue;
      const at = p.action.type;
      if (at === 'dive' || at === 'down' || at === 'celebrate') continue;
      const g = this.pathGap(prev, p);
      if (g.d > SCRAMBLE.ricochetReach || g.y > 1.1) continue;
      if (!this.rng.chance(SCRAMBLE.ricochet * (1 - 0.5 * p.a.control))) return false;
      this.deflect(p, 0.55, false);
      return true;
    }
    return false;
  }

  /**
   * Aerial duel (19 Nov 2026): the player best placed for a high ball against the nearest opponent
   * also going up for it. Height, spring and strength decide it, with who is better placed; a
   * human who pressed a kick button just before it arrived times the jump better. The loser is
   * bumped off balance. Returns who wins the header.
   */
  private aerialDuel(p: Player, prev: V3): Player {
    let rival: Player | null = null, rd = Infinity, ry = 0;
    for (const o of this.players) {
      if (o.team === p.team || o.off || o.role === 'GK' || o.touchCooldown > 0 || o.contestCooldown > 0) continue;
      const at = o.action.type;
      if (at !== 'none' && at !== 'skill') continue;
      const g = this.pathGap(prev, o);
      if (g.d > DUEL.aerialRange || g.y > PLAYER.headerHeight + 0.15 || g.y < 1.3) continue;
      if (g.d < rd) { rd = g.d; rival = o; ry = g.y; }
    }
    if (!rival) return p;
    void ry;
    const dp = this.pathGap(prev, p).d;
    const timed = (q: Player) => (this.controlOf(q) && q.queued ? DUEL.timedJump : 0);
    const win = this.rng.chance(aerialWin(p, rival, dp, rd, timed(p), timed(rival)));
    const [w, l] = win ? [p, rival] : [rival, p];
    l.action = { type: 'stumble', t: 0, dur: 0.32 };
    l.contestCooldown = Math.max(l.contestCooldown, 0.4);
    this.emit('call', { team: w.team, player: w.id, text: 'aerial' });
    return w;
  }

  /**
   * Awkward bounces: every bounce bobbles a little off line (more in a crowded penalty area, on a
   * wet or snowy pitch), and a ball skidding fast along the turf now and then pops up.
   */
  private bobble(bounced: number) {
    const b = this.ball;
    const inBox = Math.abs(b.pos.x) > PITCH.halfLength - PITCH.penaltyAreaDepth && Math.abs(b.pos.z) < PITCH.penaltyAreaHalfWidth;
    const wet = this.weather.kind === 'rain' || this.weather.kind === 'snow' ? 1 : 0;
    if (bounced > 1.5) {
      const k = SCRAMBLE.bobble + (inBox ? SCRAMBLE.bobbleBox : 0) + 0.04 * wet;
      const a = this.rng.gauss() * k;
      const c = Math.cos(a), s = Math.sin(a);
      const vx = b.vel.x;
      b.vel.x = vx * c - b.vel.z * s;
      b.vel.z = vx * s + b.vel.z * c;
      b.vel.y *= 1 + this.rng.gauss() * 0.12;
      b.dip = 0;
      return;
    }
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (b.pos.y < BALL.radius + 0.01 && sp > 7 && this.rng.chance(SCRAMBLE.hop * (1 + wet) * (inBox ? 1.5 : 1))) {
      b.vel.y = this.rng.range(0.8, 1.8);
      b.pos.y = BALL.radius + 0.01;
      this.emit('bounce', { power: 1, x: b.pos.x, z: b.pos.z, text: 'bobble' });
    }
  }

  private deflect(p: Player, keep: number, block: boolean) {
    const b = this.ball;
    if (block) {
      this.emit('block', { player: p.id, team: p.team, x: b.pos.x, z: b.pos.z });
      this.emit('chance', { team: b.lastTouchTeam });
    }
    // Heavy touch / block: the ball rebounds unpredictably with some energy lost.
    b.dip = 0;
    this.startScramble();
    const sp = Math.hypot(b.vel.x, b.vel.z) * keep;
    const ang = angleOf(-b.vel.x, -b.vel.z) + this.rng.gauss() * 0.55;
    b.vel = { x: Math.cos(ang) * sp + p.vel.x * 0.5, y: Math.abs(b.vel.y) * 0.3 + this.rng.next() * 2, z: Math.sin(ang) * sp + p.vel.z * 0.5 };
    b.state = 'free';
    b.flight = 'deflect';
    b.owner = -1;
    b.receiver = -1;
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.kicker = p.id;
    b.kickLock = 0.2;
    b.stillTime = 0;
    p.touchCooldown = 0.35;
    if (this.checkOffsideInvolvement(p)) return;
    this.offside.flagged.clear();
    if (this.indirectTaker >= 0 && this.indirectTaker !== p.id) this.indirectTaker = -1;
  }

  /**
   * Aimed header pass: a pass button pressed as a high ball arrives nods it to the teammate the stick points at
   * (or, with Manual assistance, just where it points). Short and looping; the harder the charge, the further.
   */
  private headerPass(p: Player, q: NonNullable<Player['queued']>, ctx: KickContext): boolean {
    const b = this.ball;
    const dir = this.attackDir(p.team);
    let u = norm(q.dir.x, q.dir.z);
    if (u.x === 0 && u.z === 0) u = dirOf(p.facing);
    const kind = q.kind === 'through' ? 'through' : q.kind === 'lob' ? 'lob' : 'pass';
    let receiver = -1;
    let target: V2;
    if (q.assist === 2) target = clampToPitch({ x: p.pos.x + u.x * (6 + 14 * q.power), z: p.pos.z + u.z * (6 + 14 * q.power) });
    else {
      const sel = selectReceiver(this.players, p, u.x, u.z, kind, dir, { power: q.power, cone: q.assist === 1 ? SEMI_PASS_ANGLE : undefined, help: q.assist ? 0 : ctx.help });
      if (sel.receiver >= 0 && dist(p.pos, sel.target) < 26) { receiver = sel.receiver; target = sel.target; }
      else target = clampToPitch({ x: p.pos.x + u.x * (6 + 12 * q.power), z: p.pos.z + u.z * (6 + 12 * q.power) });
    }
    const dx = target.x - b.pos.x, dz = target.z - b.pos.z;
    const d = Math.max(2, Math.hypot(dx, dz));
    // A header has a fraction of a foot's control: wider spread, less pace.
    const sigma = (0.06 + 0.12 * (1 - p.a.passing)) * (1 + 0.8 * ctx.pressure) * (1 + d / 30) * humanHelp.passError(ctx.help);
    const ang = angleOf(dx, dz) + this.rng.gauss() * sigma;
    // Looping flight that lands near the target: time aloft grows with distance.
    const T = clamp(0.45 + d * 0.035, 0.5, 1.2);
    const vy = (b.pos.y > 1 ? 0.5 * 9.81 * T - (b.pos.y - 0.11) / T : 2.5);
    const vh = (d / T) * 0.85 * (1 + this.rng.gauss() * (0.05 + 0.08 * (1 - p.a.passing)));
    b.vel = { x: Math.cos(ang) * vh, y: clamp(vy, 0.5, 6), z: Math.sin(ang) * vh };
    b.spin = 0;
    b.state = 'flight';
    b.flight = 'header';
    b.owner = -1;
    b.receiver = receiver;
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.kicker = p.id;
    b.kickLock = 0.3;
    b.stillTime = 0;
    p.queued = null;
    p.action = { type: 'header', t: 0, dur: 0.45 };
    this.stats[p.team].passes++;
    this.pstats[p.id].passes++;
    this.evaluateOffside(p, false);
    this.emit('kick', { player: p.id, team: p.team, power: Math.hypot(b.vel.x, b.vel.y, b.vel.z) * 0.6, text: 'header' });
    const c = receiver >= 0 ? this.receivingControl(p.team, p.id, receiver) : null;
    if (c) this.handToReceiver(c, p.team, receiver);
    return true;
  }

  /**
   * Volley: a shot pressed as a ball arrives between knee and chest height is struck first time, in the air.
   * The incoming pace adds power; a higher or faster ball is harder to keep down and on target.
   */
  private volley(p: Player, height: number, overhead = false): void {
    const b = this.ball;
    this.creditFirstTime(p);
    const q = p.queued!;
    const dir = this.attackDir(p.team);
    const inSpeed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    const difficulty = (1.3 + clamp((height - 0.35) / 0.65, 0, 1) * 0.9 + clamp(inSpeed / 25, 0, 1) * 0.6) * (overhead ? AERIAL7.overheadError : 1);
    const ctx: KickContext = { kicker: p, ballPos: { ...b.pos }, pressure: pressureOn(p, this.players), rng: this.rng, accuracy: difficulty, help: this.helpFor(p) };
    const aimZ = aimFromInput(p, dir, q.dir.x, q.dir.z);
    const res = solveShot(ctx, { side: dir, aimZ, power: clamp(q.power + 0.15, 0, 1), placed: q.placed && !q.variant });
    // Pace on the ball carries into the strike.
    const boost = 1 + clamp(inSpeed / 60, 0, 0.25);
    // Struck from above head height upside down, an overhead kick is aimed down at the goal.
    b.vel = { x: res.vel.x * boost, y: overhead ? res.vel.y - 0.8 : res.vel.y + (height - 0.5) * 1.5, z: res.vel.z * boost };
    b.spin = res.spin;
    b.dip = 0;
    b.state = 'flight';
    b.flight = 'shot';
    b.owner = -1;
    this.glanced.clear();
    b.receiver = -1;
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.kicker = p.id;
    b.kickLock = 0.3;
    b.stillTime = 0;
    this.lastKickTime = this.time;
    this.lastKickHelp = ctx.help ?? 0;
    p.queued = null;
    const w = kickWindup('shot');
    p.action = { type: 'kick', t: w, dur: w + 0.28, kind: 'shot', power: q.power, released: true };
    this.stats[p.team].shots++;
    const cross = predictGoalLine(b, dir, 3);
    const onTarget = !!cross && Math.abs(cross.z) < PITCH.goalHalfWidth && cross.y < PITCH.goalHeight;
    if (onTarget) this.stats[p.team].onTarget++;
    this.lastShot = { team: p.team, player: p.id, onTarget, time: this.time };
    this.countShot(p, onTarget);
    this.emit('kick', { player: p.id, team: p.team, power: Math.hypot(b.vel.x, b.vel.y, b.vel.z), x: b.pos.x, z: b.pos.z, text: overhead ? 'overhead' : 'volley' });
    this.offside.flagged.clear();
    if (this.indirectTaker >= 0 && this.indirectTaker !== p.id) this.indirectTaker = -1;
  }

  private header(p: Player, diving = false) {
    const b = this.ball;
    if (this.checkOffsideInvolvement(p)) return;
    this.creditFirstTime(p);
    const dir = this.attackDir(p.team);
    const c = this.controlOf(p) ?? this.ctrl[p.team];
    const human = !!this.controlOf(p);
    const q = p.queued;
    const goalDist = Math.abs(dir * PITCH.halfLength - p.pos.x);
    const inBox = goalDist < 18 && Math.abs(p.pos.z) < 20;
    const ctx: KickContext = { kicker: p, ballPos: { ...b.pos }, pressure: pressureOn(p, this.players), rng: this.rng, help: this.helpFor(p) };
    let res: { vel: V3; spin: number };
    let flight: Ball['flight'] = 'header';
    if (human && q && q.kind !== 'shot' && this.headerPass(p, q, ctx)) return;
    if ((human && q?.kind === 'shot') || (!human && inBox)) {
      const aimZ = human ? aimFromInput(p, dir, q!.dir.x, q!.dir.z) : (this.rng.chance(0.5) ? 1 : -1) * this.rng.range(1.2, 3.2);
      res = solveShot(ctx, { side: dir, aimZ, power: human ? q!.power : 0.7, placed: false, header: true });
      flight = 'shot';
      this.stats[p.team].shots++;
      const cr = predictGoalLine({ pos: b.pos, vel: res.vel, spin: 0 }, dir, 2);
      const on = !!cr && Math.abs(cr.z) < PITCH.goalHalfWidth && cr.y < PITCH.goalHeight;
      if (on) this.stats[p.team].onTarget++;
      this.lastShot = { team: p.team, player: p.id, onTarget: on, time: this.time };
      this.countShot(p, on);
    } else {
      // Defensive or directed header: away from danger / towards the input direction.
      let d = human && q ? norm(q.dir.x, q.dir.z) : { x: dir, z: 0 };
      if (human && !q) d = norm(c.input.mx || dir, c.input.mz);
      if (d.x === 0 && d.z === 0) d = { x: dir, z: 0 };
      const sp = 9 + 4 * this.rng.next();
      const ang = angleOf(d.x, d.z) + this.rng.gauss() * 0.25;
      res = { vel: { x: Math.cos(ang) * sp, y: 3 + this.rng.next() * 2, z: Math.sin(ang) * sp }, spin: 0 };
    }
    b.vel = res.vel;
    b.spin = res.spin;
    b.dip = 0;
    b.state = 'flight';
    b.flight = flight;
    b.owner = -1;
    b.receiver = -1;
    this.glanced.clear();
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.kicker = p.id;
    b.kickLock = 0.3;
    b.stillTime = 0;
    p.queued = null;
    p.action = { type: 'header', t: 0, dur: diving ? AERIAL7.diveTime : 0.45 };
    p.touchCooldown = diving ? AERIAL7.diveTime : 0.3;
    this.emit('kick', { player: p.id, team: p.team, power: Math.hypot(res.vel.x, res.vel.y, res.vel.z) * 0.6, text: 'header' });
    this.evaluateOffside(p, false);
    if (this.indirectTaker >= 0 && this.indirectTaker !== p.id) this.indirectTaker = -1;
  }

  /** True if p is in an offside position from the last teammate pass: awards the free kick. */
  private checkOffsideInvolvement(p: Player): boolean {
    if (this.offside.team === p.team && this.offside.flagged.has(p.id)) {
      const opp = (1 - p.team) as TeamIndex;
      this.stats[p.team].offsides++;
      this.emit('offside', { player: p.id, team: p.team, x: p.pos.x, z: p.pos.z });
      // Caught by the offside trap (sprung in the last few seconds).
      if (this.offsideTrap[opp] > this.time - 3) this.emit('call', { team: opp, text: 'trapped' });
      this.emit('whistle', { power: 2, text: 'offside' });
      this.award('freekick', opp, { x: clamp(p.pos.x, -51, 51), z: clamp(p.pos.z, -33, 33) }, true);
      return true;
    }
    return false;
  }

  /** A shot for the player's line; a shot soon after a teammate's pass to them is a chance created for the passer. */
  private countShot(p: Player, onTarget: boolean) {
    const s = this.pstats[p.id];
    s.shots++;
    if (onTarget) s.onTarget++;
    const lp = this.lastPass;
    if (lp && lp.receiver === p.id && lp.team === p.team && lp.passer !== p.id && this.time - lp.time < 6) this.pstats[lp.passer].keyPasses++;
  }

  /** A header or volley straight from a teammate's ball counts as receiving their pass. */
  private creditFirstTime(p: Player) {
    const b = this.ball;
    if (b.state === 'flight' && b.lastTouchTeam === p.team && b.kicker >= 0 && b.kicker !== p.id && b.flight !== 'deflect') {
      this.pstats[b.kicker].completed++;
      this.lastPass = { passer: b.kicker, receiver: p.id, team: p.team, time: this.time };
    }
  }

  /** Every player who took part (including those substituted off), rated, with the Man of the Match marked. */
  ratings(): Rated[] {
    return rateMatch([...this.pstats, ...this.statsOff], this.goals, this.score, Math.max(90, Math.floor(this.displayClock / 60)));
  }

  takePossession(p: Player, viaTackle: boolean) {
    const b = this.ball;
    if (!viaTackle && this.checkOffsideInvolvement(p)) return;
    const wasPass = b.state === 'flight' && b.lastTouchTeam === p.team && b.kicker !== p.id && ['pass', 'through', 'lob', 'cross', 'throw', 'clear'].includes(b.flight);
    if (wasPass) this.stats[p.team].passesCompleted++;
    if (!wasPass && b.state === 'flight' && b.flight === 'header' && b.lastTouchTeam === p.team && b.kicker >= 0 && b.kicker !== p.id) this.pstats[b.kicker].completed++;
    if (wasPass && b.kicker >= 0) {
      this.pstats[b.kicker].completed++;
      // Partnerships: a completed pass builds the pair's understanding (a one-two counts double).
      const lp0 = this.lastPass;
      this.addLink(p.team, b.kicker, p.id, lp0 && lp0.passer === p.id && lp0.receiver === b.kicker && this.time - lp0.time < 4 ? 2 : 1);
      this.lastPass = { passer: b.kicker, receiver: p.id, team: p.team, time: this.time };
    }
    else if (!viaTackle && b.state === 'flight' && b.lastTouchTeam >= 0 && b.lastTouchTeam !== p.team && ['pass', 'through', 'lob', 'cross', 'throw'].includes(b.flight)) this.pstats[p.id].interceptions++;
    if (this.lastPass && this.lastPass.team !== p.team) this.lastPass = null;
    // Goalkeeper in own area may take the ball in hands (not from a deliberate teammate pass).
    const gkHands = p.role === 'GK' && this.inPenaltyArea(p.team, p.pos) && (b.lastTouchTeam !== p.team || b.flight === 'deflect' || b.lastTouch === -1);
    if (b.owner !== p.id) this.possessionStart = this.time;
    if (b.lastTouchTeam !== p.team) this.wonBallAt[p.team] = this.time;
    b.dip = 0;
    const inVel = { ...b.vel };
    const inY = b.pos.y;
    // A first touch, not re-collecting their own push (a ball flicked over a defender is taken in stride like a pass).
    const reFlick = this.flickOver.pid === p.id;
    const fromElsewhere = b.lastTouch !== p.id || reFlick;
    if (reFlick) this.flickOver.pid = -1;
    b.owner = p.id;
    b.state = gkHands ? 'held' : 'dribble';
    b.flight = 'none';
    b.receiver = -1;
    b.lastTouch = p.id;
    b.lastTouchTeam = p.team;
    b.stillTime = 0;
    b.spin = 0;
    if (gkHands) {
      this.holdT = 0;
      p.action = { type: 'catch', t: 0, dur: 0.35 };
      this.emit('catch', { player: p.id, team: p.team });
    } else if (!fromElsewhere || !this.steerFirstTouch(p, inVel, inY)) {
      // Cushion the ball: settle it just ahead of the receiver.
      const f = dirOf(p.facing);
      b.vel = { x: p.vel.x * 0.9 + f.x * 0.4, y: 0, z: p.vel.z * 0.9 + f.z * 0.4 };
      b.pos.y = BALL.radius;
      p.touchCooldown = 0.18;
      // A heavy first touch (19 Nov 2026): weaker players under pressure, off a fast ball or on a wet pitch.
      if (fromElsewhere && !viaTackle && !p.queued) this.heavyFirstTouch(p, inVel, f);
    }
    this.offside.flagged.clear();
    if (this.indirectTaker >= 0 && this.indirectTaker !== p.id) this.indirectTaker = -1;
    const c = p.role !== 'GK' ? this.receivingControl(p.team, b.kicker, p.id) : null;
    if (c && c.pid !== p.id) {
      c.pid = p.id;
      c.carry = undefined;
      this.emit('switch', { team: p.team, player: p.id, text: 'ball' });
    }
    // First-time action pressed just before the ball arrived.
    if (p.queued && !gkHands) {
      const q = p.queued;
      const k = q.oneTwo !== undefined ? this.players[q.oneTwo] : null;
      const toward = k && (Math.hypot(q.dir.x, q.dir.z) < 0.3 || Math.abs(wrapAngle(angleOf(q.dir.x, q.dir.z) - angleOf(k.pos.x - p.pos.x, k.pos.z - p.pos.z))) < 1.3);
      if (k && toward && !k.off && k.giveGoUntil > this.time) {
        // The return ball of a one-two: first time, into the passer's run.
        const T = leadTarget(p, k, 'through', this.attackDir(p.team));
        this.startKick(p, { kind: 'through', receiver: k.id, target: { x: T.x, y: 0, z: T.z } });
      } else this.startKick(p, { kind: q.kind, dir: q.dir, power: q.power, placed: q.placed, variant: q.variant, charged: q.charged, assist: q.assist, receiver: -1 });
    }
  }

  /**
   * Human first touch, steered by the stick as the ball arrives. No direction kills the ball
   * dead at the feet; a direction plays it a stride that way; sprint as well pushes it well
   * ahead to run onto (the ball is loose until they reach it). Turning the ball back against
   * a fast pass is harder, and worse touch means a less accurate direction. Returns false when
   * the default cushion applies (computer players, or a first-time kick is queued).
   */
  private steerFirstTouch(p: Player, inVel: V3, inY: number = BALL.radius): boolean {
    const c = this.controlOf(p) ?? this.receivingControl(p.team, this.ball.kicker, p.id);
    if (!c || !c.human || p.role === 'GK' || p.queued) return false;
    const b = this.ball;
    const ctl = p.a.control;
    const m = Math.hypot(c.input.mx, c.input.mz);
    const close = BC.close && !!c.input.close;
    const inSp = Math.hypot(inVel.x, inVel.z);
    const pSp = Math.hypot(p.vel.x, p.vel.z);
    b.pos.y = BALL.radius;
    // Chest or thigh (19 Nov 2026): a dropping ball is brought down a stride ahead, into the run.
    if (BC.chest && inY > 0.5) return this.aerialTouch(p, c, inVel, inY, m);
    if (m < 0.3) {
      // Kill it dead: the ball stays at the feet (closer still with close control held).
      const f = dirOf(p.facing);
      const r = close ? BALLCTL.closeFoot : 0.45;
      b.pos.x = p.pos.x + f.x * r;
      b.pos.z = p.pos.z + f.z * r;
      b.vel = { x: p.vel.x * 0.5, y: 0, z: p.vel.z * 0.5 };
      p.touchCooldown = 0.18;
      this.firstTouch = { pid: p.id, until: this.time + 0.2 };
      if (!close) this.heavyFirstTouch(p, inVel, f);
      return true;
    }
    const u = { x: c.input.mx / m, z: c.input.mz / m };
    const against = inSp > 1 ? Math.max(0, -(inVel.x * u.x + inVel.z * u.z) / inSp) : 0;
    const err = this.rng.gauss() * (0.03 + 0.14 * (1 - ctl)) * (1 + inSp / 16) * (1 + 0.6 * against);
    const ang = angleOf(u.x, u.z) + err;
    const dir = { x: Math.cos(ang), z: Math.sin(ang) };
    // A gentle push of the stick takes a softer touch (19 Nov 2026), and so does close control.
    const soft = BC.gentle ? clamp((m - 0.3) / 0.45, 0, 1) * (close ? 0.5 : 1) : 1;
    // Start from where the ball meets the foot.
    b.pos.x = p.pos.x + dir.x * 0.35;
    b.pos.z = p.pos.z + dir.z * 0.35;
    if (c.input.sprint && !close) {
      // Push touch into space: a longer touch to run onto, still the receiver's ball (the
      // dribble picks it up again once they catch it). Heavier with worse touch or a faster ball.
      const sp = Math.max(pSp, 2) + 2.6 + 0.8 * (1 - ctl) + inSp * 0.04 + this.rng.next() * 0.4;
      b.vel = { x: dir.x * sp, y: 0, z: dir.z * sp };
      this.firstTouch = { pid: p.id, until: this.time + 0.3 };
      p.burst = Math.max(p.burst, 0.3);
      this.emit('kick', { player: p.id, team: p.team, power: sp * 0.4, text: 'touch' });
    } else {
      // Set it a stride to the side the stick points, ready for the next touch.
      const sp = Math.max(pSp, 1) * (BC.gentle ? 0.6 + 0.4 * soft : 1) + (BC.gentle ? 0.45 + 0.45 * soft : 0.9) + 0.4 * (1 - ctl) + inSp * 0.02;
      b.vel = { x: dir.x * sp, y: 0, z: dir.z * sp };
      this.firstTouch = { pid: p.id, until: this.time + 0.2 };
      this.emit('kick', { player: p.id, team: p.team, power: sp * 0.3, text: 'touch' });
    }
    // The body opens up and turns with the touch; a defender on the other side is turned (19 Nov 2026).
    if (BC.touch) {
      p.facing = turnTowards(p.facing, ang, 0.9);
      touchAway(this, p, dir);
    }
    p.touchCooldown = 0.25;
    return true;
  }

  /**
   * A human's chest or thigh control (19 Nov 2026). With the stick held the ball drops a stride ahead
   * the way it points and he carries on running onto it; without, it drops at his feet. Close control
   * cushions it dead. The ball bounces once before the dribble picks it up again.
   */
  private aerialTouch(p: Player, c: Control, inVel: V3, inY: number, m: number): boolean {
    const b = this.ball;
    const ctl = p.a.control;
    const chest = inY > 1.12;
    const close = BC.close && !!c.input.close;
    const pSp = Math.hypot(p.vel.x, p.vel.z);
    const inSp = Math.hypot(inVel.x, inVel.y, inVel.z);
    const stick = m >= 0.3 && !close;
    const base = stick ? angleOf(c.input.mx, c.input.mz) : p.facing;
    const err = this.rng.gauss() * (0.04 + 0.2 * (1 - ctl)) * (1 + inSp / 20);
    const dir = dirOf(base + err);
    // Into the stride: about the runner's pace plus a little, so the ball is just ahead when it lands.
    const sp = stick ? Math.max(pSp, 1.5) + 0.8 + 0.6 * (1 - ctl) + (c.input.sprint ? 1.2 : 0) : 0.4 + 0.5 * (1 - ctl);
    b.pos.x = p.pos.x + dir.x * 0.3;
    b.pos.z = p.pos.z + dir.z * 0.3;
    b.pos.y = chest ? 1.05 : 0.55;
    b.vel = { x: dir.x * sp + (stick ? 0 : p.vel.x * 0.5), y: chest ? 0.3 : 1.3, z: dir.z * sp + (stick ? 0 : p.vel.z * 0.5) };
    this.firstTouch = { pid: p.id, until: this.time + (chest ? 0.45 : 0.36) };
    p.touchCooldown = 0.3;
    if (stick) p.facing = turnTowards(p.facing, angleOf(dir.x, dir.z), 0.8);
    if (!close) this.heavyFirstTouch(p, inVel, dir);
    return true;
  }

  /**
   * Heavy first touch: a weaker player (control under BALLCTL.heavyFrom) under pressure, taking a fast
   * ball or on a wet pitch sometimes lets it bounce off him, a couple of metres away.
   */
  private heavyFirstTouch(p: Player, inVel: V3, f: V2) {
    const hc = heavyChance(this, p, { first: true, inSpeed: Math.hypot(inVel.x, inVel.y, inVel.z) });
    if (hc <= 0 || !this.rng.chance(hc)) return;
    const b = this.ball;
    const a = angleOf(f.x, f.z) + this.rng.gauss() * 0.5;
    const sp = 2.6 + 2.4 * this.rng.next();
    b.vel = { x: Math.cos(a) * sp + p.vel.x * 0.5, y: 0, z: Math.sin(a) * sp + p.vel.z * 0.5 };
    this.firstTouch = { pid: p.id, until: this.time + 0.3 };
    p.touchCooldown = Math.max(p.touchCooldown, 0.3);
    this.emit('kick', { player: p.id, team: p.team, power: sp * 0.3, text: 'touch' });
    this.emit('call', { team: p.team, player: p.id, text: 'heavy' });
  }

  /**
   * Assisted dribbling: a series of real touches that push the ball ahead. When the carrier
   * changes direction the ball comes with them: a cut gets a quick, shorter redirecting touch,
   * and a sharp turn cushions the ball at the feet while they brake (better control = more
   * reach and quicker touches). Without this the ball ran straight on and was lost on a turn.
   */
  /** A human's own player with close control held (whether or not he has the ball). */
  closeHeld(p: Player): boolean {
    const c = this.controlOf(p);
    return !!c && !!c.input.close && p.role !== 'GK';
  }

  /** The player a human is controlling (their own man, not a computer teammate). */
  private isHumanCarrier(p: Player): boolean {
    return !!this.controlOf(p) && p.role !== 'GK';
  }

  private dribble(_dt: number) {
    const b = this.ball;
    const p = this.players[b.owner];
    // Ball-control moves place the ball themselves (flicked up, juggled, under the sole).
    if (p.action.type === 'skill' && placeBallForSkill(this, p)) return;
    const d = dist(p.pos, b.pos);
    if (d > 2.6 || p.action.type === 'stumble' || p.action.type === 'down' || b.pos.y > 1.2) {
      b.state = 'free';
      b.owner = -1;
      return;
    }
    if (p.action.type === 'kick' || p.action.type === 'throw') return;
    const sk = p.action.type === 'skill' ? p.action : null;
    if (sk && (sk.skill === 'ballroll' || sk.skill === 'elastico' || sk.skill === 'dragturn' || sk.skill === 'bodyfeint' || sk.skill === 'berba' || sk.skill === 'mcgeady')) {
      const o = skill6Ball(p, sk);
      b.pos.x = p.pos.x + o.x; b.pos.z = p.pos.z + o.z;
      b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
      return;
    }
    if (sk && (sk.skill === 'roulette' || (sk.skill === 'fakeshot' && !sk.resolved))) {
      // Scripted: the sole rolls the ball round during a roulette; a fake shot keeps it at the planted foot.
      const s = sk.side ?? 1;
      const o = sk.skill === 'roulette' ? dirOf(p.facing - s * 0.6) : dirOf(p.facing);
      const r = sk.skill === 'roulette' ? 0.32 : 0.4;
      b.pos.x = p.pos.x + o.x * r; b.pos.z = p.pos.z + o.z * r;
      b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
      return;
    }
    // A steered first touch runs its course before the dribble takes over again.
    if (this.firstTouch.pid === p.id && this.time < this.firstTouch.until) return;
    // Close control: the ball glued to the boot with little touches.
    if (this.closeIds.has(p.id) && closeDribble(this, p)) return;
    const c = p.a.control;
    const human = this.isHumanCarrier(p);
    const f = dirOf(p.facing);
    const foot = { x: p.pos.x + f.x * 0.45, z: p.pos.z + f.z * 0.45 };
    const footDist = Math.hypot(b.pos.x - foot.x, b.pos.z - foot.z);
    const sp = Math.hypot(p.vel.x, p.vel.z);
    const glue = (k: number) => {
      b.pos.x += (foot.x - b.pos.x) * k;
      b.pos.z += (foot.z - b.pos.z) * k;
      b.vel.x = p.vel.x;
      b.vel.z = p.vel.z;
      b.vel.y = 0;
    };
    if (sp < 0.8) {
      // Standing or turning slowly: keep the ball close at the feet.
      if (footDist < 1.0 + 0.3 * c + (human ? 0.3 : 0)) glue(human ? 0.35 : 0.25);
      return;
    }
    const md = norm(p.vel.x, p.vel.z);
    // Where the carrier wants to go (stick or AI wish), falling back to where they are going.
    const wl = Math.hypot(p.wish.x, p.wish.z);
    const wantDir = wl > 0.3 ? { x: p.wish.x / wl, z: p.wish.z / wl } : md;
    const bs = Math.hypot(b.vel.x, b.vel.z);
    const ballDir = bs > 0.5 ? { x: b.vel.x / bs, z: b.vel.z / bs } : md;
    const turn = Math.acos(clamp(ballDir.x * wantDir.x + ballDir.z * wantDir.z, -1, 1));
    const reach = 1.0 + 0.45 * c + (human ? 0.25 : 0);
    // Jogging keeps the ball close with more frequent, softer touches; sprinting knocks it further ahead.
    // The player's own man gets tighter close control, so the ball stays playable between touches.
    // Better control keeps it closer still, with quicker touches (19 Nov 2026; the average player is unchanged).
    const sprinting = p.sprinting || p.wish.mode === 'sprint';
    // Gentle stick pressure (a human's own man): a slow jog with shorter, more frequent touches.
    const gentle = BC.gentle && human && !sprinting && wl > 0.25 && wl < BALLCTL.gentle;
    const full = PLAYER.touchCooldownBase * (BC.attr ? 1.4 - 0.75 * c : 1.3 - 0.6 * c) * (sprinting ? 1.25 : 0.85) * (human ? 0.8 : 1) * (gentle ? BALLCTL.gentleCd : 1);
    const lead = (sprinting ? 2.0 : 0.85) * (BC.attr ? 1.35 - 0.65 * c : 1.25 - 0.5 * c) * (human ? (sprinting ? 0.7 : 0.6) : 1) * (gentle ? BALLCTL.gentleLead : 1);
    if (turn > 1.5 && d < reach) {
      // Sharp turn or stop: cushion the ball at the feet while braking, then set off with it.
      glue(0.3);
      p.touchCooldown = Math.max(p.touchCooldown, 0.1);
      return;
    }
    if (turn > 0.3 && d < reach && full - p.touchCooldown > 0.07) {
      // Cut: a quick redirecting touch along the new line, shorter than a running touch.
      let dir = norm(md.x + wantDir.x, md.z + wantDir.z);
      let ts = sp + lead * Math.max(0.25, 1 - turn / 1.2) * 0.7;
      const hc = heavyChance(this, p, { sprinting });
      if (hc > 0 && this.rng.chance(hc)) ({ dir, ts } = this.heavy(p, dir, ts, lead));
      b.pos.x += (foot.x - b.pos.x) * 0.5;
      b.pos.z += (foot.z - b.pos.z) * 0.5;
      b.vel = { x: dir.x * ts, y: 0, z: dir.z * ts };
      p.touchCooldown = full * 0.75;
      this.emit('kick', { player: p.id, team: p.team, power: ts * 0.2, text: 'touch' });
      return;
    }
    if (p.touchCooldown > 0 || footDist > 0.9 + 0.2 * c + (human ? 0.25 : 0)) return;
    let ts = sp + lead, dir = md;
    const hc = heavyChance(this, p, { sprinting });
      if (hc > 0 && this.rng.chance(hc)) ({ dir, ts } = this.heavy(p, dir, ts, lead));
    b.pos.x += (foot.x - b.pos.x) * 0.5;
    b.pos.z += (foot.z - b.pos.z) * 0.5;
    b.vel = { x: dir.x * ts, y: 0, z: dir.z * ts };
    p.touchCooldown = full;
    this.emit('kick', { player: p.id, team: p.team, power: ts * 0.25, text: 'touch' });
  }

  /** A heavy dribbling touch (19 Nov 2026): the ball runs on further than meant and a little off the line. */
  private heavy(p: Player, dir: V2, ts: number, lead: number): { dir: V2; ts: number } {
    const a = angleOf(dir.x, dir.z) + this.rng.gauss() * 0.16;
    this.emit('call', { team: p.team, player: p.id, text: 'heavy' });
    return { dir: dirOf(a), ts: ts + lead * (0.9 + 0.8 * this.rng.next()) + 1.2 };
  }

  private handleCrossing(c: Crossing) {
    const b = this.ball;
    if (this.ctlDrill) { controlDrillOut(this, this.ctlDrill); return; }
    if (this.skill && this.drill) {
      // Skill games: score the attempt; the ball stops where it went out and the next one follows.
      skillCrossing(this, this.skill, c);
      const side = c.kind === 'touch' ? 0 : c.side;
      b.vel = { x: 0, y: 0, z: 0 }; b.spin = 0; b.state = 'free'; b.flight = 'none'; b.owner = -1;
      if (side) b.pos = { x: side * (PITCH.halfLength + 1.2), y: BALL.radius, z: c.kind === 'touch' ? b.pos.z : c.z };
      else b.pos.y = BALL.radius;
      this.drillT = Math.max(this.drillT, 5.6);
      return;
    }
    const lt = b.lastTouchTeam >= 0 ? b.lastTouchTeam : 0;
    if (c.kind === 'goal') {
      // The team attacking that end scores.
      const scoring = (this.attackDir(0) === c.side ? 0 : 1) as TeamIndex;
      const defending = (1 - scoring) as TeamIndex;
      if (this.indirectTaker >= 0 && this.indirectTaker === b.lastTouch) {
        // Indirect free kick straight in: no goal, goal kick.
        this.debugLog('indirect free kick entered the goal without another touch: goal kick');
        this.emit('out', { x: b.pos.x, z: b.pos.z });
        this.emit('whistle', { power: 1, text: 'out' });
        this.award('goalkick', defending, this.goalKickSpot(defending, c.z));
        return;
      }
      if (this.shootout) { this.penResult(true); return; }
      this.endAdvantage();
      this.score[scoring]++;
      const scorer = b.lastTouch;
      const own = lt !== scoring;
      const end = halfStart(this.half) + halfLength(this.half), dc = this.displayClock;
      const minute = dc >= end ? end / 60 : Math.floor(dc / 60) + 1;
      const added = dc >= end ? Math.floor((dc - end) / 60) + 1 : undefined;
      this.goals.push({ team: scoring, player: scorer, minute, ownGoal: own, ...(added ? { added } : {}) });
      if (scorer >= 0) {
        if (own) this.pstats[scorer].ownGoals++;
        else {
          this.pstats[scorer].goals++;
          const lp = this.lastPass;
          if (lp && lp.team === scoring && lp.receiver === scorer && lp.passer !== scorer && this.time - lp.time < 20) { this.pstats[lp.passer].assists++; this.addLink(scoring, lp.passer, scorer, 2); }
        }
      }
      this.lastPass = null;
      this.stoppage += 35;
      if (this.lastShot && this.lastShot.team === scoring) this.lastShot = null;
      this.phase = 'goal';
      this.phaseT = 0;
      b.state = 'dead';
      b.owner = -1;
      this.restart = null;
      this.emit('goal', { team: scoring, player: scorer, text: own ? 'og' : '' });
      this.emit('whistle', { power: 1, text: 'goal' });
      for (const p of this.players) { p.queued = null; if (p.team === scoring && p.id === scorer) p.action = { type: 'celebrate', t: 0, dur: MATCH.goalCelebration }; }
      return;
    }
    if (this.shootout) { this.penResult(false); return; }
    this.emit('out', { x: b.pos.x, z: b.pos.z });
    // Out of play: a short blast (a throw-in, goal kick or corner follows).
    this.emit('whistle', { power: 1, text: 'out' });
    if (c.kind === 'touch') {
      const team = (1 - lt) as TeamIndex;
      this.award('throwin', team, { x: clamp(c.x, -PITCH.halfLength + 0.5, PITCH.halfLength - 0.5), z: c.side * (PITCH.halfWidth + 0.15) });
      return;
    }
    // Over the goal line: who defends this end?
    const defending = (this.attackDir(0) === c.side ? 1 : 0) as TeamIndex;
    const attacking = (1 - defending) as TeamIndex;
    if (this.lastShot && this.lastShot.team === attacking && this.time - this.lastShot.time < 3 && Math.abs(c.z) < PITCH.goalHalfWidth + 2.5) this.emit('chance', { team: attacking });
    if (lt === attacking) this.award('goalkick', defending, this.goalKickSpot(defending, c.z));
    else {
      this.stats[attacking].corners++;
      this.award('corner', attacking, { x: c.side * (PITCH.halfLength - 0.4), z: Math.sign(c.z || 1) * (PITCH.halfWidth - 0.4) });
    }
  }

  private goalKickSpot(team: number, z: number): V2 {
    return { x: this.ownGoalX(team) + this.attackDir(team) * PITCH.goalAreaDepth, z: Math.sign(z || 1) * 4.5 };
  }

  // ---------------------------------------------------------------- partnerships

  /** Builds a pair's understanding (human sides only); says so when it reaches a new level. */
  addLink(team: number, a: number, b: number, n: number) {
    if (!this.ctrl[team].human || !TEAMMATE_ON.links || a === b || a < 0 || b < 0) return;
    const k = linkKey(a, b);
    const before = this.links[team].get(k) ?? 0;
    const after = before + n;
    this.links[team].set(k, after);
    const step = LINK.steps.findIndex((t) => before < t && after >= t);
    if (step >= 0) this.emit('call', { team, player: a, power: b, text: `link:${step + 1}` });
  }

  // ---------------------------------------------------------------- switching

  /**
   * The opponents' pass being wound up right now (20 Nov 2026): the passer and the teammate it is
   * meant for, before the ball is struck. Null when nobody is about to pass.
   */
  passWindup(team: number): { passer: Player; receiver: Player } | null {
    const b = this.ball;
    if (b.owner < 0 || b.state !== 'dribble') return null;
    const c = this.players[b.owner];
    const a = c.action;
    if (c.team === team || a.type !== 'kick' || a.released || a.receiver === undefined || a.receiver < 0) return null;
    if (a.kind !== 'pass' && a.kind !== 'through' && a.kind !== 'lob' && a.kind !== 'cross') return null;
    const r = this.players[a.receiver];
    return r && r.team === c.team && r.id !== c.id && !r.off ? { passer: c, receiver: r } : null;
  }

  /** A cross or long ball coming down near this team's goal (20 Nov 2026). */
  crossOnUs(team: number, E: V2): boolean {
    const b = this.ball;
    if (b.state !== 'flight' || b.lastTouchTeam === team || b.lastTouchTeam < 0) return false;
    if (b.flight !== 'cross' && b.flight !== 'lob' && b.flight !== 'clear') return false;
    return dist(E, { x: this.ownGoalX(team), z: 0 }) < SWITCH.crossRange;
  }

  /**
   * Where the human's defender will have to engage the ball next: a dribbler a stride ahead, the
   * receiver of the opponents' pass where he meets it, or where a high ball comes down. While a pass
   * is being wound up, its receiver (20 Nov 2026).
   */
  engagePoint(team: number): V2 {
    const b = this.ball;
    if (b.owner >= 0 && b.state === 'dribble') {
      const w = SW.read ? this.passWindup(team) : null;
      if (w) return { x: w.receiver.pos.x + w.receiver.vel.x * 0.5, z: w.receiver.pos.z + w.receiver.vel.z * 0.5 };
      const c = this.players[b.owner];
      return { x: c.pos.x + c.vel.x * 0.6, z: c.pos.z + c.vel.z * 0.6 };
    }
    if (b.state === 'flight' && b.receiver >= 0 && this.players[b.receiver].team !== team) {
      const r = this.players[b.receiver];
      // A cross is met in the air (head height), not where it would roll to.
      const high = SW.crosses && (b.flight === 'cross' || b.flight === 'lob');
      return this.meetPoint(r, 3, high ? 2.6 : 1.5) ?? { ...r.pos };
    }
    if ((b.state === 'flight' || b.state === 'free') && (b.pos.y > 1 || b.vel.y > 2)) {
      const L = landingPoint(b.pos, b.vel, b.spin);
      if (L.t < 3) return { x: L.x, z: L.z };
    }
    return { x: b.pos.x + b.vel.x * 0.5, z: b.pos.z + b.vel.z * 0.5 };
  }

  /** The spot just goal-side of an engagement point, where a defender wants to be. */
  engageSpot(team: number, E: V2): V2 {
    const goal = { x: this.ownGoalX(team), z: 0 };
    const g = norm(goal.x - E.x, goal.z - E.z);
    return { x: E.x + g.x * 1.2, z: E.z + g.z * 1.2 };
  }

  /**
   * How long `p` needs to engage at E (seconds at jog speed): to a spot just goal-side of it. A
   * player the ball has already gone past (E between him and our goal) has to get back round it.
   */
  engageTime(p: Player, E: V2): number {
    const goal = { x: this.ownGoalX(p.team), z: 0 };
    const S = this.engageSpot(p.team, E);
    let t = dist(p.pos, S) / jogSpeed(p.a);
    const behind = dist(p.pos, goal) - dist(E, goal);
    if (behind > 2) t += 0.5 + behind / 10;
    if (p.action.type !== 'none' || p.beaten > 0) t += 0.6; // on the floor or wrong-footed
    return t;
  }

  /** Pick the outfield player best placed to influence the ball. */
  bestSwitchCandidate(team: number, exclude: number, inputX = 0, inputZ = 0, keep = -1): number {
    const b = this.ball;
    if (this.ctrl[team].human && TEAMMATE_ON.switching && !this.mates[team]) return this.bestEngager(team, exclude, inputX, inputZ, keep);
    const fut = { x: b.pos.x + b.vel.x * 0.5, z: b.pos.z + b.vel.z * 0.5 };
    const cur = this.players[exclude];
    const ownGoal = { x: this.ownGoalX(team), z: 0 };
    let best = -1, bs = Infinity;
    const hasInput = Math.hypot(inputX, inputZ) > 0.4;
    const other = this.otherHuman(team);
    for (const p of this.teamPlayers(team)) {
      if (p.id === exclude || p.id === other || p.role === 'GK') continue;
      let t = dist(p.pos, fut) / jogSpeed(p.a);
      // Goal-side players can defend; prefer them.
      if (dist(p.pos, ownGoal) < dist(fut, ownGoal)) t -= 0.35;
      if (hasInput && cur) {
        const v = norm(p.pos.x - cur.pos.x, p.pos.z - cur.pos.z);
        const m = norm(inputX, inputZ);
        if (v.x * m.x + v.z * m.z > 0.5) t -= 0.5;
      }
      if (t < bs) { bs = t; best = p.id; }
    }
    return best;
  }

  /** The stick to bias a switch with: none while it is still the stick carried over from before a switch. */
  private switchStick(c: Control): [number, number] {
    return c.carry !== undefined ? [0, 0] : [c.input.mx, c.input.mz];
  }

  switchPlayer(team: TeamIndex, manual: boolean) {
    const c = this.ctrl[team];
    if (isLocked(c)) return;
    const cur = this.players[c.pid];
    if (this.ball.owner === cur.id) return; // never switch away from the ball carrier
    // Not during a committed action (but a beaten man on the floor can be switched away from).
    if (!manual && cur.action.type !== 'none' && !(cur.action.type === 'stumble' && this.ctrl[team].human && TEAMMATE_ON.switching)) return;
    const [sx, sz] = this.switchStick(c);
    let next: number;
    if (manual && c.human && TEAMMATE_ON.switching && !this.mates[team]) {
      // Quick presses cycle on through the next-best players instead of flicking back (20 Nov 2026);
      // a single press takes the man under the next-switch marker.
      const quick = SW.cycle && c.lastManual !== undefined && this.time - c.lastManual < SWITCH.cycleWindow;
      c.chain = quick ? [...(c.chain ?? []), c.pid] : [c.pid];
      c.lastManual = this.time;
      if (quick) {
        next = this.bestEngager(team, c.pid, sx, sz, -1, c.chain);
        if (next < 0) { c.chain = [c.pid]; next = this.bestEngager(team, c.pid, sx, sz); }
      } else {
        next = c.next >= 0 && c.next !== c.pid && !this.players[c.next].off && this.players[c.next].role !== 'GK' && c.next !== this.otherHuman(team) ? c.next : this.bestEngager(team, c.pid, sx, sz);
      }
    } else next = this.bestSwitchCandidate(team, c.pid, sx, sz);
    if (next < 0) return;
    c.pid = next;
    c.lastAutoSwitch = this.time;
    c.pend = undefined;
    this.players[next].queued = null;
    this.carryOver(c, team);
    this.emit('switch', { team, player: next, text: manual ? 'manual' : 'auto' });
  }

  /**
   * After a switch while defending, the stick held for the old player is carried over: the new man
   * closes down the ball until it is let go or pushed a new way (SWITCH.carryMax at most).
   */
  private carryOver(c: Control, team: number) {
    if (!SW.carry || !c.human || this.possessionTeam() === team) { if (c.carryKind === 'switch') c.carry = undefined; return; }
    const m = Math.hypot(c.input.mx, c.input.mz);
    c.carry = m > 0.3 ? angleOf(c.input.mx, c.input.mz) : undefined;
    c.carryKind = 'switch';
    c.carryUntil = this.time + SWITCH.carryMax;
  }

  /**
   * Manual switch: to the teammate in a direction from the controlled player (right stick),
   * or to the teammate nearest a point on the pitch (mouse click).
   */
  switchTowards(team: TeamIndex, x: number, z: number, at: boolean, fromBall = false) {
    const c = this.ctrl[team];
    if (isLocked(c)) return;
    const cur = this.players[c.pid];
    if (this.ball.owner === cur.id) return;
    const best = at ? this.nearestTeammateTo(team, cur.id, { x, z }, 9) : this.flickTarget(team, cur.id, fromBall ? this.ball.pos : cur.pos, x, z);
    if (best < 0) return;
    c.pid = best;
    c.lastAutoSwitch = this.time;
    c.pend = undefined;
    this.players[best].queued = null;
    // A mouse click points the new man by itself; a right-stick flick leaves the left stick to carry over.
    if (!at) this.carryOver(c, team);
    else if (c.carryKind === 'switch') c.carry = undefined;
    this.emit('switch', { team, player: best, text: 'manual' });
  }

  /** Outfield teammate (not `exclude`) nearest a point, within `within` metres, or -1. */
  private nearestTeammateTo(team: number, exclude: number, at: V2, within: number): number {
    let best = -1, bs = within;
    const other = this.otherHuman(team);
    for (const p of this.teamPlayers(team)) {
      if (p.id === exclude || p.id === other || p.role === 'GK') continue;
      const d = dist(p.pos, at);
      if (d < bs) { bs = d; best = p.id; }
    }
    return best;
  }

  /**
   * The teammate a right-stick flick points at, measured from `from` (the controlled player, or the
   * ball): the nearest one close to the line of the flick, preferring players nearer the ball. If
   * nobody is within about 50 degrees, the cone widens to about 75 degrees. -1 when nobody fits.
   */
  flickTarget(team: number, exclude: number, from: V2, x: number, z: number): number {
    const u = norm(x, z);
    for (const minCos of [0.64, 0.26]) {
      let best = -1, bs = Infinity;
      for (const p of this.teamPlayers(team)) {
        if (p.id === exclude || p.id === this.otherHuman(team) || p.role === 'GK') continue;
        const vx = p.pos.x - from.x, vz = p.pos.z - from.z;
        const d = Math.hypot(vx, vz);
        if (d < 1) continue;
        const cos = (vx * u.x + vz * u.z) / d;
        if (cos < minCos) continue;
        const s = d * (1.6 - cos) + 0.08 * dist(p.pos, this.ball.pos);
        if (s < bs) { bs = s; best = p.id; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Smarter auto-switching (19 Nov): the defender who will get to the next engagement first, goal-side.
   * 20 Nov 2026: players far from the ball (likely off screen) count as a little slower; `keep` (the
   * marked man) stays the pick unless another is clearly better; `skip` leaves out players already
   * visited by a run of quick switch presses.
   */
  private bestEngager(team: number, exclude: number, inputX: number, inputZ: number, keep = -1, skip?: number[]): number {
    const E = this.engagePoint(team);
    const cur = this.players[exclude];
    const other = this.otherHuman(team);
    const hasInput = Math.hypot(inputX, inputZ) > 0.4;
    const bx = this.ball.pos.x;
    let best = -1, bs = Infinity, ks = Infinity;
    for (const p of this.teamPlayers(team)) {
      if (p.id === exclude || p.id === other || p.role === 'GK' || p.off) continue;
      if (skip && skip.includes(p.id)) continue;
      let t = this.engageTime(p, E);
      if (hasInput && cur) {
        const v = norm(p.pos.x - cur.pos.x, p.pos.z - cur.pos.z);
        const mv = norm(inputX, inputZ);
        if (v.x * mv.x + v.z * mv.z > 0.5) t -= 0.4;
      }
      if (SW.onscreen && Math.abs(p.pos.x - bx) > SWITCH.offscreen) t += SWITCH.offscreenCost;
      if (p.id === keep) ks = t;
      if (t < bs) { bs = t; best = p.id; }
    }
    if (SW.steady && keep >= 0 && keep !== best && ks < bs + SWITCH.nextKeep) return keep;
    return best;
  }

  private updateSwitchCandidates() {
    for (const team of [0, 1] as TeamIndex[]) {
      if (this.ctrl[team].human) this.autoSwitchFor(team);
      if (this.mates[team]?.human) this.asMate(team, () => this.autoSwitchFor(team));
    }
  }

  private autoSwitchFor(team: TeamIndex) {
    const c = this.ctrl[team];
    if (isLocked(c)) { c.next = -1; return; }
    const [sx, sz] = this.switchStick(c);
    c.next = this.bestSwitchCandidate(team, c.pid, sx, sz, c.next);
    if (!c.autoSwitch || c.style === 'off') return;
    const pt = this.possessionTeam();
    const cur = this.players[c.pid];
    // On the keeper: stay there while the danger lasts; once the ball is well away, back to an outfield player.
    if (cur.role === 'GK') {
      if (this.ball.owner !== cur.id && dist(this.ball.pos, { x: this.ownGoalX(team), z: 0 }) > 40 && this.time - c.lastAutoSwitch > 1) this.leaveKeeper(team);
      return;
    }
    if (pt === team) { c.pend = undefined; return; }
    // Two humans on one side (local co-op) keep the calmer classic auto-switch.
    if (TEAMMATE_ON.switching && !this.mates[team]) { this.smartAutoSwitch(team); return; }
    if (this.time - c.lastAutoSwitch < 1.5) return;
    if (cur.action.type !== 'none') return;
    // Auto-switch only when a clearly better-placed defender exists.
    const b = this.ball;
    const fut = { x: b.pos.x + b.vel.x * 0.5, z: b.pos.z + b.vel.z * 0.5 };
    const tc = dist(cur.pos, fut) / jogSpeed(cur.a);
    const cand = this.players[c.next];
    if (!cand) return;
    const tn = dist(cand.pos, fut) / jogSpeed(cand.a);
    const airborne = b.pos.y > 1.5 && b.state === 'flight';
    if (c.style === 'air' && !airborne) return;
    if (tc - tn > (airborne ? 0.8 : 1.6) * SWITCH.sens[c.sens ?? 'normal']) this.switchPlayer(team, false);
  }

  /**
   * Auto-switch when defending (19 Nov): switch as soon as a clearly better-placed defender exists
   * for the next engagement (their pass's receiver, where a high ball drops, the dribbler's next
   * stride). Quicker when the ball has gone past the human's man; slower while he is in the duel
   * or chasing it down with the stick, so a switch never steals a challenge.
   * 20 Nov 2026: style (off / high balls / assisted / full) and sensitivity; no switch just after a
   * challenge or while holding jockey or contain; a better man must stay better for a moment; crosses
   * near goal switch early to the man under them; never while you are on the passer as he winds up.
   */
  private smartAutoSwitch(team: TeamIndex) {
    const c = this.ctrl[team];
    const cur = this.players[c.pid];
    const b = this.ball;
    const k = SWITCH.sens[c.sens ?? 'normal'];
    const E = this.engagePoint(team);
    const cross = SW.crosses && this.crossOnUs(team, E);
    const newPass = b.state === 'flight' && b.receiver >= 0 && this.players[b.receiver].team !== team && this.time - this.lastKickTime < 0.4;
    if (this.time - c.lastAutoSwitch < (cross ? SWITCH.crossCool : newPass ? 0.6 : 1.0) * k) { c.pend = undefined; return; }
    if (cur.action.type !== 'none' && cur.action.type !== 'stumble') { c.pend = undefined; return; }
    if (SW.guard && c.lastChallenge !== undefined && this.time - c.lastChallenge < SWITCH.guardAfter) { c.pend = undefined; return; }
    const cand = this.players[c.next];
    if (!cand) return;
    const tc = this.engageTime(cur, E), tn = this.engageTime(cand, E);
    const goal = { x: this.ownGoalX(team), z: 0 };
    const beaten = dist(cur.pos, goal) > dist(E, goal) + 2;
    const dE = dist(cur.pos, E);
    const mv = Math.hypot(c.input.mx, c.input.mz);
    const chasing = c.carry === undefined && mv > 0.4 && ((E.x - cur.pos.x) * c.input.mx + (E.z - cur.pos.z) * c.input.mz) / (Math.max(0.5, dE) * mv) > 0.8 && dE < 14;
    const airborne = (b.pos.y > 1.5 && b.state === 'flight') || cross;
    const style = c.style ?? 'full';
    if ((style === 'air' && !airborne) || (style === 'assisted' && !airborne && !beaten)) { c.pend = undefined; return; }
    // Pressing the passer as he winds up: the marker reads the pass, but control stays with you.
    const w = SW.read ? this.passWindup(team) : null;
    if (w && dist(cur.pos, w.passer.pos) < 6) { c.pend = undefined; return; }
    let thr = airborne ? 0.8 : 1.1;
    if (beaten) thr = 0.5;
    else if (dE < 5) thr += 1.0; // in the duel
    else if (chasing) thr += 0.5 + (SW.guard && c.input.sprint ? SWITCH.sprintChase : 0);
    if (cross) thr = Math.min(thr, dE < 5 ? thr : SWITCH.crossThr);
    if (SW.guard && !beaten && !cross && (c.input.jockey || c.input.contain)) thr += SWITCH.guardHold;
    // Don't flick straight back to the man we just left.
    if (cand.id === this.switchedFrom[team] && this.time - c.lastAutoSwitch < 2.5) thr += 0.6;
    thr *= k;
    if (tc - tn > thr) {
      if (SW.steady) {
        // A better man must stay better for a moment, so close calls don't flick control about.
        // (Not for a pass just played: the marker read it while it was wound up.)
        const hold = newPass ? 0 : beaten || cross ? SWITCH.steadyQuick : SWITCH.steady;
        if (hold > 0) {
          if (!c.pend || c.pend.id !== cand.id) { c.pend = { id: cand.id, since: this.time }; return; }
          if (this.time - c.pend.since < hold - 1e-6) return;
        }
      }
      const from = c.pid;
      this.switchPlayer(team, false);
      if (c.pid !== from) this.switchedFrom[team] = from;
    } else c.pend = undefined;
  }
  private switchedFrom: [number, number] = [-1, -1];

  /**
   * Their set piece near your goal (20 Nov 2026): the defender to start on, nearest the danger (the
   * six-yard box at a corner, the edge of the area at a free kick, the thrower's short options at a
   * throw-in), not in the wall; `skip` cycles on. -1 when it doesn't apply.
   */
  setPieceDefender(r: Restart, skip: number[] = []): number {
    const team = 1 - r.team;
    const gx = this.ownGoalX(team), sg = Math.sign(gx);
    const goal = { x: gx, z: 0 };
    let danger: V2 | null = null;
    if (r.type === 'corner') danger = { x: gx - sg * 6.5, z: Math.sign(r.spot.z) * 1.5 };
    else if (r.type === 'freekick' && dist(r.spot, goal) < 38) danger = { x: gx - sg * 11, z: r.spot.z * 0.3 };
    else if (r.type === 'throwin' && Math.abs(r.spot.x - gx) < 35) danger = { x: r.spot.x - sg * 3, z: r.spot.z * 0.75 };
    if (!danger) return -1;
    const wall = r.type === 'freekick' ? wallFor(this, r) : null;
    const other = this.otherHuman(team);
    let best = -1, bd = Infinity;
    for (const p of this.teamPlayers(team)) {
      if (p.off || p.role === 'GK' || p.id === other || skip.includes(p.id) || wall?.ids.includes(p.id)) continue;
      const d = dist(p.pos, danger);
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }

  /** At their set piece: put the defending human on the right man once everyone is set; the switch button cycles. */
  private defendSetPiece(r: Restart, cycle: boolean) {
    const team = (1 - r.team) as TeamIndex;
    const c = this.ctrl[team];
    if (!SW.setpiece || !c.human || isLocked(c) || this.players[c.pid].role === 'GK') return;
    if (!cycle && (!c.autoSwitch || c.style === 'off')) return;
    const quick = cycle && c.lastManual !== undefined && this.time - c.lastManual < 6;
    const skip = cycle ? (quick ? [...(c.chain ?? []), c.pid] : [c.pid]) : [];
    let next = this.setPieceDefender(r, skip);
    if (next < 0 && cycle) next = this.setPieceDefender(r, [c.pid]);
    if (next < 0 || next === c.pid) return;
    if (cycle) { c.chain = skip; c.lastManual = this.time; }
    c.pid = next;
    c.lastAutoSwitch = this.time;
    c.carry = undefined;
    this.emit('switch', { team, player: next, text: cycle ? 'manual' : 'setpiece' });
  }

  /** Where a player can meet the moving ball (used by receivers and interceptors). */
  meetPoint(p: Player, maxT = 2.5, maxY = 1.5): V2 | null {
    const b = this.ball;
    let pos = { ...b.pos }, vel = { ...b.vel };
    const step = 1 / 20;
    const sp = jogSpeed(p.a) * 1.15;
    let last: V2 | null = null;
    for (let t = step; t <= maxT; t += step) {
      // Cheap kinematic prediction (rolling or flying) without frame collisions.
      if (pos.y > BALL.radius + 0.01 || vel.y > 0) {
        vel.y -= BALL.gravity * step;
        pos = { x: pos.x + vel.x * step, y: Math.max(BALL.radius, pos.y + vel.y * step), z: pos.z + vel.z * step };
        if (pos.y <= BALL.radius) { vel.y = Math.abs(vel.y) > BALL.restVy ? -vel.y * BALL.restitution : 0; }
      } else {
        const vh = Math.hypot(vel.x, vel.z);
        const k = vh > 0 ? Math.max(0, vh - BALL.rollDecel * step) / vh : 0;
        vel = { x: vel.x * k, y: 0, z: vel.z * k };
        pos = { x: pos.x + vel.x * step, y: BALL.radius, z: pos.z + vel.z * step };
      }
      last = { x: pos.x, z: pos.z };
      if (pos.y < maxY && dist(p.pos, last) / sp <= t + 0.05) return last;
    }
    return last;
  }

  // ---------------------------------------------------------------- dead-ball phases

  private stepCelebration(dt: number) {
    const b = this.ball;
    stepBall(b, dt, false);
    const g = this.goals[this.goals.length - 1];
    const scorer = g ? this.players[g.player] : null;
    const corner = { x: this.attackDir(g.team) * 44, z: 28 };
    for (const p of this.players) {
      if (scorer && p.id === scorer.id && !g.ownGoal) this.arrive(p, corner, 'sprint');
      else if (scorer && p.team === g.team && dist(p.pos, scorer.pos) < 25 && p.role !== 'GK') this.arrive(p, scorer.pos, 'jog');
      else p.wish = { x: 0, z: 0, mode: 'walk', face: null };
      if (p.action.type !== 'celebrate' && p.action.type !== 'none' && p.action.t >= p.action.dur) p.action = { type: 'none', t: 0, dur: 0 };
      if (p.action.type !== 'none' && p.action.type !== 'celebrate') p.action.t += dt;
    }
    this.moveAll(dt);
  }

  private stepIdle(dt: number) {
    this.stepBodyActions(dt);
    for (const p of this.players) {
      const home = { x: this.ownGoalX(p.team) * 0.25, z: (p.slot - 5) * 2.2 };
      this.arrive(p, this.phase === 'halftime' ? home : p.pos, 'walk');
    }
    this.moveAll(dt);
    stepBall(this.ball, dt, false);
  }

  /** Called by AI after deciding plans (kept for debug overlays). */
  setPlans(p: [TeamPlan | null, TeamPlan | null]) {
    this.plans = p;
  }

  refreshPlans() {
    planTeams(this);
  }
}

export function fmtClock(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * How a human input event shapes a kick. The modifier (jockey button) gives a placed shot,
 * a driven ground pass or a lofted through ball; a second button held with shoot gives a
 * chip or a low drive. A pass carrying its charge picks a near or far receiver.
 */
export function kickStyle(e: InputEvent): { placed: boolean; variant?: KickVariant; charged?: boolean; assist?: 1 | 2 } {
  if (e.k === 'shoot') {
    // Shot types (19 Nov 2026): modifier = finesse (curled), modifier + sprint = power, a second button = chip / low / placed.
    const assist = e.a === 2 ? 2 : undefined;
    if (e.v === 'chip' || e.v === 'low' || e.v === 'placed' || e.v === 'power') return { placed: false, variant: e.v, assist };
    return e.m ? { placed: false, variant: 'finesse', assist } : { placed: false, assist };
  }
  const charged = e.p !== undefined && (e.k === 'pass' || e.k === 'through' || e.k === 'lob') ? true : undefined;
  const assist = e.a === 1 || e.a === 2 ? e.a : undefined;
  if (e.k === 'pass') return { placed: false, variant: e.m ? 'driven' : undefined, charged, assist };
  if (e.k === 'through') return { placed: false, variant: e.m ? 'lofted' : undefined, charged, assist };
  return { placed: false, variant: e.m ? 'whipped' : undefined, charged, assist }; // lob: whipped cross with the modifier
}

/** Kick buttons (as opposed to switching, skill moves and team calls). */
export function isKickEvent(e: InputEvent): boolean {
  return e.k === 'pass' || e.k === 'through' || e.k === 'lob' || e.k === 'shoot';
}

/**
 * Does the ball's path this tick (prev -> cur) pass within `r` (+ ball radius) of a body lying along
 * the ground from `a` to `b`, below height `top`? Used for block slides.
 */
function sweptBodyHit(prev: V3, cur: V3, a: V2, b: V2, r: number, top: number): boolean {
  // Closest approach between the two segments, in the ground plane, by sampling the ball's path.
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const x = prev.x + (cur.x - prev.x) * t, y = prev.y + (cur.y - prev.y) * t, z = prev.z + (cur.z - prev.z) * t;
    if (y > top) continue;
    const ux = b.x - a.x, uz = b.z - a.z;
    const l2 = ux * ux + uz * uz;
    const k = l2 > 1e-9 ? clamp(((x - a.x) * ux + (z - a.z) * uz) / l2, 0, 1) : 0;
    if (Math.hypot(x - (a.x + ux * k), z - (a.z + uz * k)) < r + BALL.radius) return true;
  }
  return false;
}
