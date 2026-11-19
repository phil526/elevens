// Dribbling responsiveness benchmark: a human-controlled striker on an empty pitch.
// Measures straight-line times with and without the ball, how quickly a cut or a turn
// takes the ball with it, how far the ball runs from the feet, and touches per second.
// Usage: npx tsx scripts/bench-dribble.ts
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

const DT = 1 / 60;
let seq = 1;
const ang = (x: number, z: number) => Math.atan2(z, x);
const diff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function setup(withBall: boolean) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed: 3 }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  p.pos = { x: -30, z: 0 }; p.vel = { x: 0, z: 0 }; p.facing = 0; p.stamina = 1; p.action = { type: 'none', t: 0, dur: 0 } as Player['action'];
  if (withBall) { m.takePossession(p, true); m.ball.pos = { x: p.pos.x + 0.45, y: 0.11, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 }; }
  else { m.ball.pos = { x: 50, y: 0.11, z: 30 }; m.ball.vel = { x: 0, y: 0, z: 0 }; m.ball.owner = -1; m.ball.state = 'free'; }
  return { m, p };
}
function park(m: Match, p: Player) {
  for (const q of m.players) if (q.id !== p.id) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; }
}
function step(m: Match, p: Player, mx: number, mz: number, sprint: boolean) {
  m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: false, ev: [] });
  park(m, p);
  m.step();
}

function straight(withBall: boolean, sprint: boolean, metres: number) {
  const { m, p } = setup(withBall);
  const x0 = p.pos.x;
  let t = 0, maxSep = 0, touches = 0;
  for (; t < 12 && p.pos.x - x0 < metres; t += DT) {
    step(m, p, 1, 0, sprint);
    for (const e of m.drainEvents()) if (e.type === 'kick' && e.text === 'touch') touches++;
    if (withBall) maxSep = Math.max(maxSep, Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z));
  }
  return { t: +t.toFixed(2), kept: !withBall || m.ball.owner === p.id, maxSep: +maxSep.toFixed(2), touchesPerSec: +(touches / t).toFixed(2) };
}

/** Run up to speed along +x, then turn the stick by `deg`; time until the player AND the ball travel the new way. */
function cut(deg: number, sprint: boolean) {
  const { m, p } = setup(true);
  for (let i = 0; i < 120; i++) step(m, p, 1, 0, sprint);
  const want = (deg * Math.PI) / 180;
  const wx = Math.cos(want), wz = Math.sin(want);
  let tBody = -1, tBall = -1, maxSep = 0;
  for (let t = 0; t < 4; t += DT) {
    step(m, p, wx, wz, sprint);
    const ps = Math.hypot(p.vel.x, p.vel.z), bs = Math.hypot(m.ball.vel.x, m.ball.vel.z);
    const sep = Math.hypot(m.ball.pos.x - p.pos.x, m.ball.pos.z - p.pos.z);
    maxSep = Math.max(maxSep, sep);
    if (tBody < 0 && ps > 1.5 && diff(ang(p.vel.x, p.vel.z), want) < 0.26) tBody = t;
    if (tBall < 0 && bs > 1.5 && diff(ang(m.ball.vel.x, m.ball.vel.z), want) < 0.35 && sep < 1.6) tBall = t;
    if (tBody >= 0 && tBall >= 0) break;
  }
  return { body: +tBody.toFixed(2), ball: +tBall.toFixed(2), kept: m.ball.owner === p.id, maxSep: +maxSep.toFixed(2) };
}

const out = {
  jog25: { noBall: straight(false, false, 25), ball: straight(true, false, 25) },
  sprint30: { noBall: straight(false, true, 30), ball: straight(true, true, 30) },
  cut45Jog: cut(45, false), cut90Jog: cut(90, false), turn180Jog: cut(180, false),
  cut45Sprint: cut(45, true), cut90Sprint: cut(90, true), turn180Sprint: cut(180, true),
};
console.log(JSON.stringify(out, null, 1));
