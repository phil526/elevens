// Pass outcome diagnostic: `npx tsx scripts/diag-pass.ts [seed]`.
import { Match, defaultConfig } from '../src/shared/match';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: Number(process.argv[2] ?? 3) }));
type P = { team: number; kind: string; d: number; recv: number; t0: number; fx: number; spd: number; minR: number; pspd: number; tMin: number };
let cur: P | null = null;
const out: Record<string, number> = {};
const lost: string[] = [];
const byDist: Record<string, [number, number]> = {};
let prevFlightKicker = -1, prevFlightTick = -1;
const finish = (res: string, extra = '') => {
  if (!cur) return;
  const key = `${cur.kind}:${res}`;
  out[key] = (out[key] ?? 0) + 1;
  const b = `${cur.kind}<${Math.ceil(cur.d / 10) * 10}`;
  byDist[b] ??= [0, 0];
  byDist[b][1]++;
  if (res === 'ok') byDist[b][0]++;
  if (res === 'opp' && lost.length < 40) lost.push(`${cur.kind} d=${cur.d.toFixed(1)} v0=${cur.spd.toFixed(1)} after ${((m.tick - cur.t0) / 60).toFixed(2)}s recvClosest=${cur.minR.toFixed(2)}@${cur.tMin.toFixed(2)}s ballspd=${cur.pspd.toFixed(1)} ${extra}`);
  cur = null;
};
while (m.phase !== 'fulltime') {
  m.step();
  if (m.phase === 'halftime') m.continueAfterHalftime();
  m.drainEvents();
  const b = m.ball;
  if (b.state === 'flight' && ['pass', 'through', 'lob', 'cross'].includes(b.flight) && (b.kicker !== prevFlightKicker || m.tick - prevFlightTick > 2) && (!cur || cur.t0 !== m.tick)) {
    if (!cur || b.kicker !== prevFlightKicker) {
      finish('replaced');
      const k = m.players[b.kicker];
      const r = b.receiver >= 0 ? m.players[b.receiver] : null;
      cur = { team: k.team, kind: b.flight, d: r ? Math.hypot(r.pos.x - k.pos.x, r.pos.z - k.pos.z) : -1, recv: b.receiver, t0: m.tick, fx: k.pos.x, spd: Math.hypot(b.vel.x, b.vel.z), minR: 99, pspd: 0, tMin: 0 };
    }
  }
  if (b.state === 'flight') { prevFlightKicker = b.kicker; prevFlightTick = m.tick; }
  if (cur && cur.recv >= 0) {
    const r = m.players[cur.recv];
    const dr = Math.hypot(r.pos.x - b.pos.x, r.pos.z - b.pos.z);
    if (dr < cur.minR) { cur.minR = dr; cur.tMin = (m.tick - cur.t0) / 60; cur.pspd = Math.hypot(b.vel.x, b.vel.z); }
  }
  if (cur) {
    if (m.phase !== 'play') finish('dead');
    else if (b.owner >= 0) {
      const o = m.players[b.owner];
      if (o.team === cur.team) finish(o.id === cur.recv ? 'ok' : 'ok-other');
      else finish('opp', `by ${o.role} ball(${b.pos.x.toFixed(0)},${b.pos.z.toFixed(0)}) h=${b.pos.y.toFixed(2)} spd=${Math.hypot(b.vel.x, b.vel.z).toFixed(1)}`);
    } else if (b.state === 'free' && b.lastTouchTeam !== cur.team) finish('opp-touch', `last ${m.players[b.lastTouch]?.role}`);
    else if (b.state === 'free' && m.tick - cur.t0 > 240) finish('loose');
  }
}
console.log(out);
console.log(byDist);
console.log(lost.join('\n'));
console.log(m.stats.map((s) => `${s.passesCompleted}/${s.passes} shots ${s.shots}`));
