import type { Difficulty, Mentality } from './config';
import type { V2, V3 } from './math';
import type { Attributes, PlayerDef, Role, Tactics } from './teams';

export type TeamIndex = 0 | 1;

/** Possession states (DESIGN §7). Ownership is the single `owner` field. */
export type BallState = 'free' | 'dribble' | 'flight' | 'held' | 'dead';
export type FlightKind = 'none' | 'pass' | 'through' | 'lob' | 'cross' | 'shot' | 'header' | 'clear' | 'throw' | 'deflect';

export interface BallPhys {
  pos: V3;
  vel: V3;
  spin: number; // lateral curve acceleration (m/s^2 at 20 m/s), +ve curves left of travel
  dip?: number; // topspin: extra downward acceleration (m/s^2 at 20 m/s) while airborne (a dipping free kick)
}

export interface Ball extends BallPhys {
  state: BallState;
  owner: number; // player id or -1
  lastTouch: number; // player id or -1
  lastTouchTeam: number; // -1 before kick-off
  flight: FlightKind;
  receiver: number; // intended receiver of a pass, -1 if none
  kicker: number; // last player who kicked (for touch lock)
  kickLock: number; // seconds during which `kicker` cannot retouch
  stillTime: number; // seconds the ball has been slow and untouched (stuck detection)
}

export type ActionType = 'none' | 'kick' | 'tackle' | 'stumble' | 'dive' | 'celebrate' | 'throw' | 'header' | 'catch' | 'down' | 'slide' | 'skill' | 'barge' | 'jump';
/** Movement modes. 'jockeyfast' is jockeying with sprint held: quicker, still side-on to the ball. */
export type MoveModeName = 'walk' | 'jog' | 'sprint' | 'jockey' | 'jockeyfast';
export type SkillMove = 'stepover' | 'dragback' | 'knockon' | 'roulette' | 'fakeshot'
  // With the modifier held (19 Nov 2026): a sole roll across the body, an elastico (out, then in), a drag-back that turns away.
  | 'ballroll' | 'elastico' | 'dragturn'
  // Ball control (19 Nov 2026): a chop and a cut-back while sprinting, a stop under the sole, a flick up,
  // a keepy-up while it is in the air, and a flick over a defender's head.
  | 'chop' | 'cutback' | 'solestop' | 'flickup' | 'juggle' | 'flickover'
  // Turns and feints (20 Nov 2026): a shoulder-drop body feint, a Berba spin and a McGeady spin.
  | 'bodyfeint' | 'berba' | 'mcgeady';
/** Alternative versions of a kick: driven ground pass, lofted through ball, chipped or low driven shot. */
export type KickVariant = 'driven' | 'lofted' | 'chip' | 'low'
  // Crosses: a high floated ball, a fast whipped cross into the gap between keeper and defence, a low driven cross.
  | 'floated' | 'whipped' | 'lowcross'
  // Keeper distribution from the hands: rolled out, thrown overarm (plain 'throw'), a flat drop-kick, a long punt.
  | 'roll' | 'dropkick' | 'punt'
  // Throw-ins: a short, flat throw to feet; a long, looping throw (into the box from the final third); down the line into space.
  | 'shortthrow' | 'longthrow' | 'linethrow'
  // Shots (19 Nov 2026): a curled finesse shot, a full-blooded power shot, a side-footed placed shot.
  | 'finesse' | 'power' | 'placed';

export type KickKind = 'pass' | 'through' | 'lob' | 'shot' | 'clear' | 'cross' | 'throw';

export interface PlayerAction {
  type: ActionType;
  t: number;
  dur: number;
  kind?: KickKind;
  power?: number;
  dir?: V2; // intended direction (input) at the time of the request
  placed?: boolean;
  receiver?: number; // AI-chosen receiver, or -1 for automatic selection
  target?: V3; // explicit target point (AI passes, keeper dives, restarts)
  released?: boolean;
  resolved?: boolean;
  jockeySet?: boolean; // tackle: started from a set jockey stance (better timing, quicker recovery if it misses)
  quickRecover?: boolean;
  start?: V2; // dive start position
  windup?: number; // kick/throw: seconds before the ball leaves (set when it differs from kickWindup, e.g. a keeper's throw)
  extra?: V2; // dive: body travel beyond the 1.1 m the keeper's reach is measured from
  exact?: boolean; // aimed set piece: play the ball to `target`, not ahead of a receiver
  skill?: SkillMove;
  side?: number; // step-over: +1/-1 direction of the break
  variant?: KickVariant;
  charged?: boolean; // human pass: power is how far to look for the receiver
  accuracy?: number; // set-piece timing: multiplies the kick's error (1 = normal)
  locked?: boolean; // human pass to a receiver locked on press: power sets the pace, not who
  assist?: 1 | 2; // semi or manual pass assistance (see InputEvent.a)
  missed?: boolean;
  block?: boolean; // slide: thrown in front of a shot (no tackle, a wider body to block with)
  curve?: number; // free-kick shot: bend chosen by the taker, -1..1 (+ curls left of travel)
  dip?: number; // free-kick shot: topspin chosen by the taker, 0..1
  knuckle?: boolean; // free-kick shot struck without spin (wobbles late)
  tactical?: boolean; // tackle: a deliberate pull-back (tactical foul)
  chain?: number; // step-over: how many step-overs came before this one in a chain
}

export interface Player {
  id: number;
  team: TeamIndex;
  slot: number;
  role: Role;
  def: PlayerDef;
  a: Attributes; // attributes normalised to 0..1
  pos: V2;
  vel: V2;
  facing: number;
  stamina: number; // 0..1
  fatigue: number; // 0..1 built up over the match: stamina can no longer recover above 1 - fatigue
  sprinting: boolean;
  jockeying: boolean;
  shielding: boolean; // on the ball with the jockey button held: back to the nearest opponent, harder to dispossess
  cards: number; // yellow cards this match (2 = sent off)
  off: boolean; // sent off: takes no further part
  burst: number; // seconds of sprint burst left
  beaten: number; // seconds of being wrong-footed by a skill move
  skillCd: number; // seconds until another skill move is possible
  jockeyT: number; // seconds spent jockeying without a break (a set, side-on defender times a standing tackle better)
  action: PlayerAction;
  touchCooldown: number;
  tackleCooldown: number;
  contestCooldown: number;
  /** A pass/shot pressed just before the ball arrives: played first time if possession comes within the window. */
  queued: { kind: KickKind; dir: V2; power: number; placed: boolean; variant?: KickVariant; charged?: boolean; assist?: 1 | 2; oneTwo?: number; until: number } | null;
  /** Movement intention for this tick, written by human input or AI, consumed by the movement step. */
  wish: { x: number; z: number; mode: MoveModeName; face: number | null };
  // AI bookkeeping (server-only; never trusted from clients)
  aiTarget: V2;
  aiIntent: string;
  aiNextDecision: number;
  aiRunUntil: number;
  aiHoldUntil: number;
  /** Timed off-ball run: 0 none, 1 outside down the line, 2 diagonal inside, 3 striker's channel, 4 third-man run in behind, 5 decoy run. */
  runLane: number;
  runStart: number;
  /** Third-man (runLane 4) and decoy (runLane 5) runs: where the run is heading (world coordinates). */
  runTo: V2 | null;
  /** Calling for the ball (arm up) until this time: a free teammate of a human (19 Nov). */
  callUntil: number;
  giveGoUntil: number; // pass and move: running on for the return pass (one-two) until this time
}

export type Phase = 'kickoff' | 'play' | 'restart' | 'goal' | 'halftime' | 'fulltime';

/** Penalty shootout: each team's kicks so far (true = scored), who kicks next and, once decided, the winner. */
export interface Shootout {
  kicks: [boolean[], boolean[]];
  team: TeamIndex;
  winner: -1 | TeamIndex;
}
export type RestartType = 'kickoff' | 'throwin' | 'goalkick' | 'corner' | 'freekick' | 'penalty' | 'dropball';

export interface Restart {
  type: RestartType;
  team: TeamIndex; // team taking the restart
  spot: V2;
  taker: number;
  t: number; // seconds since restart was awarded
  ready: boolean;
  readyT: number;
  indirect: boolean;
  aim: V2; // human taker's target point (moved with the stick)
  quick?: boolean; // taken quickly, before everyone was set
  routine?: number; // corner / free kick routine (index into ROUTINES), 0 = standard
  runup?: { req: import('./match').KickRequest; t: number; face?: number; check?: number; wait?: number; dummy?: number }; // taker running in to strike the ball
  /** Defensive wall at a free kick in range: how many stand in it and how far it is moved sideways (m, + = defenders' right). */
  wall?: { n: number; shift: number; creep?: number; lie?: boolean; warned?: number };
  /** Direct free kick: the run-up (0 standard, 1 long, 2 short, 3 straight on). */
  runStyle?: number;
  /** Two over the ball: a computer wall that jumped at the dummy. */
  wallFooled?: boolean;
  /** Free kick: bend (-1..1, + curls left as the taker sees it) and dip (0..1) set by a human taker with the modifier held. */
  curve?: number;
  dip?: number;
  /** Penalty: the taker checks in his run-up (a stutter); the keeper may go first. */
  stutter?: boolean;
  /** Pressure on the taker shown as a wobble in the timing ring (0 calm .. 0.8). */
  shake?: number;
  /** Penalty keeper duel: a human keeper's shuffle along the line (m), how much he has been dancing (0..1), and his early dive. */
  gk?: { shift: number; dance: number; commit?: { side: -1 | 0 | 1; t: number } };
}

export interface InputEvent {
  k: 'pass' | 'through' | 'lob' | 'shoot' | 'switch' | 'skill' | 'press' | 'trap' | 'plan' | 'keeper' | 'instr'; // plan: p = game plan index / 4; instr: p = (slot * 3 + instruction + 1) / 32
  p?: number; // shot charge 0..1
  m?: boolean; // modifier held: placed shot, driven pass, lofted through ball
  v?: 'chip' | 'low' | 'fake' | 'placed' | 'power' | 'flick'; // shot style chosen with a second button (lob = chip, through = low drive, switch = placed; modifier + sprint = power); on a skill event, 'fake' is a fake shot and 'flick' (close control held) flicks the ball up, juggles it or flicks it over a defender
  x?: number; // switch/skill: world-space direction (or a point on the pitch when `at` is set)
  z?: number;
  at?: boolean; // switch: x, z is a point on the pitch (mouse click) rather than a direction
  // switch with a direction and m set: the flick is measured from the ball rather than from the controlled player
  r?: number; // pass/through/lob: receiver locked when the button was pressed (Early receiver setting)
  a?: 1 | 2; // pass assistance: 1 semi (aim at a teammate, power sets the distance), 2 manual (stick and power only); on a shot, 2 = manual shooting (no aim help)
}

/** One 60 Hz frame of player intention. This is all a client may send. */
/**
 * Auto-switch styles (20 Nov 2026): 'off' never switches for you; 'air' only for high balls and
 * crosses; 'assisted' for high balls and when the ball has gone past your man; 'full' whenever a
 * clearly better-placed defender exists.
 */
export type SwitchStyle = 'off' | 'air' | 'assisted' | 'full';
export const SWITCH_STYLES: SwitchStyle[] = ['off', 'air', 'assisted', 'full'];
/** Auto-switch sensitivity: Calm waits for a clearer case, Eager moves you sooner. */
export type SwitchSens = 'calm' | 'normal' | 'eager';
export const SWITCH_SENS: SwitchSens[] = ['calm', 'normal', 'eager'];

export interface InputFrame {
  seq: number;
  mx: number; // movement, world axes, magnitude <= 1
  mz: number;
  sprint: boolean;
  jockey: boolean;
  contain?: boolean; // defending: the nearest teammate presses the ball carrier
  close?: boolean; // close control held: small, slow touches on the ball; let go of the stick to stop it under the sole
  ev: InputEvent[];
}

export interface MatchConfig {
  teams: [string, string];
  kits: ['home' | 'away', 'home' | 'away'];
  realMinutes: number;
  humans: [boolean, boolean];
  /** Local co-op: a second human on that side (it must also be in `humans`). */
  mates?: [boolean, boolean];
  difficulty: [Difficulty, Difficulty]; // decision quality of each team's AI
  mentality: [Mentality, Mentality];
  autoSwitch: [boolean, boolean];
  /** Auto-switch style per side (20 Nov 2026; default 'full'). 'off' is the same as autoSwitch false. */
  switchStyle?: [SwitchStyle, SwitchStyle];
  /** How readily the auto-switch moves you (default 'normal'). */
  switchSens?: [SwitchSens, SwitchSens];
  quickRestarts?: [boolean, boolean]; // humans may take throw-ins, corners and free kicks before everyone is set (default on)
  seed: number;
  /** Practice: no clock. 'free' is open play; 'freekick' and 'penalty' repeat that set piece for team 0. */
  practice?: 'free' | 'freekick' | 'penalty' | 'crosses' | 'crossbar' | 'targets' | 'control';
  /** Practice challenge: this many attempts, then the session ends with a score (0 or unset: endless). */
  challenge?: number;
  /** Formation and slider instructions per team (default 4-3-3, all sliders 0). */
  tactics?: [Tactics, Tactics];
  /** Adaptive difficulty: the level to start from (1 Pro .. 3 World class; default 2, Elite). */
  adaptiveStart?: number;
  /** Substitutions allowed per team (default 5; 0 turns them off). */
  maxSubs?: number;
  /** A draw at full time: stands (default), goes to extra time then penalties, or straight to penalties. */
  draw?: 'stand' | 'extra' | 'pens';
  /** Weather: rain or snow change how the ball runs and bounces, wind moves it in the air (default clear and still). */
  weather?: import('./weather').MatchWeather;
  /** Home crowd momentum: pressure builds a swing that the home crowd turns into a lift for the home side (default on). */
  momentum?: boolean;
  /** Be a Pro: the slot (0-10) each team's human controls all match, -1 for normal switching. */
  lock?: [number, number];
  /** Injuries from heavy fouls (offline matches): physios, stretchers and substitutions. 'more' makes them likelier. */
  injuries?: boolean | 'more';
  /** Daily scenarios: pick the match up part of the way through (half, clock in the half, score, who kicks off, players sent off). */
  startAt?: { half: 1 | 2; clock: number; score: [number, number]; kickoff: 0 | 1; offs: number[] };
  /** 5-a-side street (20 Nov 2026): a 40 x 24 m cage with walls, five a side, no offside, no subs. Offline only. */
  street?: boolean;
}

export type MatchEventType =
  | 'whistle' | 'kick' | 'goal' | 'save' | 'catch' | 'parry' | 'post' | 'bar' | 'net' | 'bounce' | 'out'
  | 'foul' | 'offside' | 'tackle' | 'block' | 'kickoff' | 'restart' | 'halftime' | 'fulltime' | 'recovery'
  | 'chance' | 'switch' | 'snap' | 'card' | 'advantage' | 'skill' | 'call' | 'rush' | 'addedtime' | 'pen' | 'sub' | 'injury';

export interface MatchEvent {
  id: number;
  type: MatchEventType;
  tick: number;
  team?: number;
  player?: number;
  power?: number;
  x?: number;
  z?: number;
  text?: string;
}

export interface TeamStats {
  shots: number;
  onTarget: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  fouls: number;
  corners: number;
  offsides: number;
  saves: number;
  yellows: number;
  reds: number;
  possessionTicks: number;
}

export interface GoalRecord {
  team: TeamIndex;
  player: number;
  minute: number;
  added?: number; // minute of added time (45+2' is minute 45, added 2)
  ownGoal: boolean;
}

export const emptyStats = (): TeamStats => ({
  shots: 0, onTarget: 0, passes: 0, passesCompleted: 0, tackles: 0, fouls: 0, corners: 0, offsides: 0, saves: 0, yellows: 0, reds: 0, possessionTicks: 0,
});

export type { V2, V3, Attributes };
