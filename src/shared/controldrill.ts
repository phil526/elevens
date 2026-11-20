// Ball control drill (19 Nov 2026, Practice > Challenges): 60 seconds, a score to beat.
// Your striker and a coach in an empty half. Rounds alternate:
//   1. Dribble through a gate (two cones). 100 points, up to 60 more for speed, 40 for keeping
//      the ball within a metre as you go through (15 within 1.6 m).
//   2. Pass to the coach (+20). He plays it back, along the ground or in the air, and the next
//      gate appears at once: control it cleanly (+60 on the floor, +90 off the chest or thigh), +30
//      when the first touch already sets you off towards the gate. Then through the gate.
// Keepy-ups score 10 each. Losing the ball (out of play, or loose and far from you) costs 30 and
// the ball comes back to your feet. The points are kept in score[0] like the skill games.

import { BALL, PITCH } from './config';
import { solveGroundPass, solveLob } from './kick';
import { angleOf, clamp, dirOf, dist } from './math';
import type { Match } from './match';
import type { Player, V2 } from './types';

export const CONTROL_DRILL = { seconds: 60, gateHalf: 1.15, gateMin: 10, gateMax: 19, coachMin: 12, coachMax: 20, feedDelay: 0.7, judge: 0.6, lostFar: 7, lostTime: 1.6 } as const;

/** A gate: the middle, the line across it (unit) and its half-width. Dribble through between the cones. */
export interface DrillGate { x: number; z: number; ax: number; az: number; w: number }

export interface ControlDrillState {
  stage: 'gate' | 'pass' | 'feed' | 'receive' | 'judge' | 'done';
  round: number;
  timeLeft: number;
  gate: DrillGate | null;
  gateAt: number; // when the gate appeared
  coachSpot: V2;
  feedAt: number; // when the coach plays it back
  receivedAt: number;
  aerial: boolean; // the coach's ball this round is in the air
  lostT: number;
  player: number;
  coach: number;
  /** Ball position last tick (gate crossing). */
  prev: V2;
}

const W = (m: Match, x: number, z: number): V2 => ({ x: m.attackDir(0) * x, z });

/** The drill area: the attacking half, kept inside the lines. */
function inArea(p: V2, m: Match): V2 {
  const dir = m.attackDir(0);
  const fx = clamp(p.x * dir, 4, PITCH.halfLength - 18);
  return { x: fx * dir, z: clamp(p.z, -PITCH.halfWidth + 6, PITCH.halfWidth - 6) };
}

/** A new spot `lo`..`hi` metres from `from`, inside the area. */
function spotFrom(m: Match, from: V2, lo: number, hi: number): V2 {
  for (let i = 0; i < 12; i++) {
    const a = m.rng.next() * Math.PI * 2, d = lo + (hi - lo) * m.rng.next();
    const s = inArea({ x: from.x + Math.cos(a) * d, z: from.z + Math.sin(a) * d }, m);
    if (dist(s, from) >= lo * 0.8) return s;
  }
  return inArea({ x: from.x + m.attackDir(0) * lo, z: from.z }, m);
}

/** Set up the drill (called at the start, from nextDrill). */
export function setupControlDrill(m: Match): ControlDrillState {
  const st = m.players.find((p) => p.team === 0 && p.role === 'ST')!;
  const coach = m.players.find((p) => p.team === 0 && p.role === 'CDM')!;
  for (const p of m.players) {
    p.action = { type: 'none', t: 0, dur: 0 }; p.vel = { x: 0, z: 0 }; p.burst = 0; p.beaten = 0; p.queued = null;
    p.off = p !== st && p !== coach;
    if (p.off) p.pos = { x: 0, z: (p.team ? 1 : -1) * 60 };
  }
  st.pos = W(m, 18, 0); st.facing = angleOf(m.attackDir(0), 0); st.stamina = 1;
  coach.pos = W(m, 30, 8); coach.facing = angleOf(st.pos.x - coach.pos.x, st.pos.z - coach.pos.z);
  m.ctrl[0].pid = st.id; m.ctrl[0].lock = st.id; m.ctrl[0].autoSwitch = false;
  const d: ControlDrillState = {
    stage: 'gate', round: 0, timeLeft: CONTROL_DRILL.seconds, gate: null, gateAt: m.time, coachSpot: { ...coach.pos },
    feedAt: 0, receivedAt: 0, aerial: false, lostT: 0, player: st.id, coach: coach.id, prev: { ...st.pos },
  };
  giveBall(m, st);
  newGate(m, d);
  return d;
}

function giveBall(m: Match, p: Player) {
  const f = dirOf(p.facing);
  const b = m.ball;
  b.pos = { x: p.pos.x + f.x * 0.45, y: BALL.radius, z: p.pos.z + f.z * 0.45 };
  b.vel = { x: 0, y: 0, z: 0 }; b.spin = 0; b.dip = 0;
  b.state = 'dribble'; b.owner = p.id; b.flight = 'none'; b.receiver = -1;
  b.lastTouch = p.id; b.lastTouchTeam = 0; b.kicker = -1; b.kickLock = 0; b.stillTime = 0;
  m.phase = 'play'; m.phaseT = 0; m.restart = null;
}

function newGate(m: Match, d: ControlDrillState) {
  const p = m.players[d.player];
  const c = spotFrom(m, p.pos, CONTROL_DRILL.gateMin, CONTROL_DRILL.gateMax);
  // Square on to the way you come at it: the line across the gate is at right angles to it.
  const a = angleOf(c.x - p.pos.x, c.z - p.pos.z) + (m.rng.next() - 0.5) * 0.6;
  d.gate = { x: c.x, z: c.z, ax: -Math.sin(a), az: Math.cos(a), w: CONTROL_DRILL.gateHalf };
  d.gateAt = m.time;
}

function award(m: Match, pts: number, text: string) {
  const s = m.skill!;
  s.points = Math.max(0, s.points + pts);
  s.last = { text, pts, at: m.time };
  m.score[0] = s.points;
  m.emit('call', { team: 0, text: `skill:${pts}:${text}` });
}

/** Did the ball go between the cones this tick (segment prev -> now against the gate line)? */
function throughGate(g: DrillGate, a: V2, b: V2): boolean {
  // Signed distance from the gate line (normal = perpendicular to the cone line).
  const nx = g.az, nz = -g.ax;
  const sa = (a.x - g.x) * nx + (a.z - g.z) * nz, sb = (b.x - g.x) * nx + (b.z - g.z) * nz;
  if (sa === sb || sa * sb > 0) return false;
  const t = sa / (sa - sb);
  const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
  return Math.abs((cx - g.x) * g.ax + (cz - g.z) * g.az) <= g.w;
}

/** Each tick in open play: the coach's movement (after the AI), so he stands where the drill wants him. */
export function controlDrillWishes(m: Match, d: ControlDrillState) {
  const c = m.players[d.coach], p = m.players[d.player];
  c.aiNextDecision = m.time + 5;
  const face = angleOf(p.pos.x - c.pos.x, p.pos.z - c.pos.z);
  if (m.ball.owner === c.id) { c.wish = { x: 0, z: 0, mode: 'walk', face }; return; }
  // In the pass stage he goes to meet a pass played to him (wherever it is going), else to his spot.
  const b = m.ball;
  if (d.stage === 'pass' && b.owner < 0 && b.lastTouch === p.id && dist(b.pos, c.pos) < 30) {
    // Aim a little ahead of the ball along its path so a firm pass is cut out, not chased.
    const lead = Math.min(0.6, dist(b.pos, c.pos) / 12);
    m.arrive(c, { x: b.pos.x + b.vel.x * lead, z: b.pos.z + b.vel.z * lead }, 'sprint', null);
    return;
  }
  m.arrive(c, d.coachSpot, dist(c.pos, d.coachSpot) > 6 ? 'sprint' : 'jog', face);
}

/** Each tick (any phase): the clock, scoring and the coach's feeds. Returns true when the drill is over. */
export function stepControlDrill(m: Match, d: ControlDrillState, dt: number): boolean {
  if (d.stage === 'done') return true;
  const b = m.ball, p = m.players[d.player], c = m.players[d.coach];
  if (m.phase !== 'play') {
    // Anything that stopped play (the ball out) puts it back at your feet.
    if (m.phase === 'restart' || m.phase === 'kickoff') giveBall(m, p);
    d.prev = { x: b.pos.x, z: b.pos.z };
    return false;
  }
  d.timeLeft -= dt;
  if (d.timeLeft <= 0) { d.timeLeft = 0; d.stage = 'done'; d.gate = null; return true; }
  const now = { x: b.pos.x, z: b.pos.z };
  const mine = b.owner === p.id;
  // Through the gate with the ball.
  if (d.gate && mine && (d.stage === 'gate' || d.stage === 'judge') && throughGate(d.gate, d.prev, now)) {
    const t = m.time - d.gateAt;
    const near = dist(b.pos, p.pos);
    const speed = Math.round(Math.max(0, 60 - 6 * t));
    const close = near < 1.0 ? 40 : near < 1.6 ? 15 : 0;
    award(m, 100 + speed + close, close >= 40 ? 'Gate, close control' : 'Gate');
    d.gate = null;
    d.round++;
    d.stage = 'pass';
    d.coachSpot = spotFrom(m, p.pos, CONTROL_DRILL.coachMin, CONTROL_DRILL.coachMax);
  }
  // The coach has your pass.
  if (d.stage === 'pass' && b.owner === c.id) {
    award(m, 20, 'Pass');
    d.stage = 'feed';
    d.feedAt = m.time + CONTROL_DRILL.feedDelay;
    d.aerial = d.round % 2 === 0;
  }
  if (d.stage === 'feed' && b.owner === c.id && m.time >= d.feedAt) feed(m, d, c, p);
  // You have his ball back: judge the touch a moment later.
  if (d.stage === 'receive' && mine) { d.stage = 'judge'; d.receivedAt = m.time; }
  if (d.stage === 'judge' && d.receivedAt > 0 && m.time - d.receivedAt >= CONTROL_DRILL.judge) {
    d.receivedAt = 0;
    const clean = mine && dist(b.pos, p.pos) < 1.6;
    if (clean) {
      const g = d.gate;
      const bs = Math.hypot(b.vel.x, b.vel.z);
      const towards = !!g && bs > 0.8 && Math.abs(((angleOf(g.x - p.pos.x, g.z - p.pos.z) - angleOf(b.vel.x, b.vel.z) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < 0.9;
      award(m, (d.aerial ? 90 : 60) + (towards ? 30 : 0), `${d.aerial ? 'Brought it down' : 'Clean first touch'}${towards ? ', away to the gate' : ''}`);
    } else award(m, 0, 'Loose touch');
    d.stage = 'gate';
  }
  // Keepy-ups.
  // (counted from the events this tick by the caller, see controlDrillEvent)
  // Lost it: loose and far away for a while (not while a pass is travelling between you and the coach).
  const loose = b.owner < 0 && d.stage !== 'feed' && d.stage !== 'receive' && !(d.stage === 'pass' && b.lastTouch === p.id && dist(b.pos, c.pos) < 16);
  d.lostT = loose && dist(b.pos, p.pos) > CONTROL_DRILL.lostFar ? d.lostT + dt : 0;
  if (d.stage === 'receive' && m.time - d.feedAt > 4.5 && !mine) d.lostT = CONTROL_DRILL.lostTime;
  if (d.lostT >= CONTROL_DRILL.lostTime) lost(m, d, 'Lost it');
  d.prev = { x: b.pos.x, z: b.pos.z };
  return false;
}

/** The coach plays it back (along the ground or in the air), and the next gate goes up. */
function feed(m: Match, d: ControlDrillState, c: Player, p: Player) {
  const b = m.ball;
  newGate(m, d);
  const ctx = { kicker: c, ballPos: { ...b.pos }, pressure: 0, rng: m.rng };
  const target = { x: p.pos.x, z: p.pos.z };
  const res = d.aerial ? solveLob(ctx, target, 'lob') : solveGroundPass(ctx, target, 'pass');
  b.vel = res.vel; b.spin = res.spin; b.dip = 0;
  b.state = 'flight'; b.flight = d.aerial ? 'lob' : 'pass'; b.owner = -1; b.receiver = p.id;
  b.lastTouch = c.id; b.lastTouchTeam = 0; b.kicker = c.id; b.kickLock = 0.3; b.stillTime = 0;
  m.lastKickTime = m.time;
  c.action = { type: 'kick', t: 0.1, dur: 0.38, kind: d.aerial ? 'lob' : 'pass', power: 0.5, released: true };
  m.emit('kick', { player: c.id, team: 0, power: Math.hypot(b.vel.x, b.vel.y, b.vel.z), x: b.pos.x, z: b.pos.z, text: d.aerial ? 'lob' : 'pass' });
  d.stage = 'receive';
}

function lost(m: Match, d: ControlDrillState, text: string) {
  award(m, -30, text);
  const p = m.players[d.player];
  giveBall(m, p);
  d.lostT = 0;
  // The ball jumped back to your feet: that is not a run through the gate.
  d.prev = { x: m.ball.pos.x, z: m.ball.pos.z };
  // A pass round goes back to passing to the coach; otherwise the same gate.
  if (d.stage === 'feed' || d.stage === 'receive' || d.stage === 'judge') { d.stage = 'gate'; d.receivedAt = 0; }
  if (!d.gate && d.stage === 'gate') newGate(m, d);
}

/** Match events during the drill: keepy-ups score. */
export function controlDrillEvent(m: Match, d: ControlDrillState, type: string, text: string | undefined, player: number | undefined) {
  if (d.stage === 'done' || player !== d.player || type !== 'skill' || text !== 'juggle') return;
  award(m, 10, 'Keepy-up');
}

/** The ball went out of play in the drill: it comes back to your feet (costs 30). */
export function controlDrillOut(m: Match, d: ControlDrillState) {
  lost(m, d, 'Out of play');
}

/** What to do now (shown on screen). */
export function drillTask(d: ControlDrillState): string {
  switch (d.stage) {
    case 'gate': return 'Dribble through the gate';
    case 'pass': return 'Pass to the coach';
    case 'feed': return 'Get ready for his ball';
    case 'receive': return d.aerial ? 'Bring it down: hold the stick to take it into your stride' : 'First touch towards the gate';
    case 'judge': return 'Through the gate';
    default: return '';
  }
}
