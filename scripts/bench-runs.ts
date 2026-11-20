// Off-ball runs when the human has the ball: a human midfielder carries the ball up the
// pitch at a jog while every other player is computer-controlled. Measures how much of the
// time the wingers and striker spend running forward, how many separate runs they make,
// how often they stand in an offside position, and the space they have when they're ahead.
// Usage: npx tsx scripts/bench-runs.ts
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
const roles = ['RW', 'LW', 'ST'] as const;
const tot: Record<string, { fwd: number; runs: number; offside: number; n: number; free: number }> = {};
for (const r of roles) tot[r] = { fwd: 0, runs: 0, offside: 0, n: 0, free: 0 };
let trials = 0;
for (let seed = 1; seed <= 40; seed++) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const dir = m.attackDir(0);
  const p = m.teamPlayers(0).find((x) => x.role === 'RCM' || x.role === 'LCM')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  p.pos = { x: Number(process.env.START ?? -12) * dir, z: (seed % 5) * 3 - 6 }; p.vel = { x: 0, z: 0 }; p.facing = dir > 0 ? 0 : Math.PI;
  m.takePossession(p, true);
  m.ball.pos = { x: p.pos.x + 0.45 * dir, y: 0.11, z: p.pos.z }; m.ball.vel = { x: 0, y: 0, z: 0 };
  const wasFwd: Record<number, boolean> = {};
  let ok = true;
  for (let i = 0; i < 60 * 7; i++) {
    const z = Math.sin(i / 90) * 0.4;
    const mode = process.env.MODE ?? 'fwd';
    const sx = mode === 'still' ? 0 : mode === 'side' ? 0.15 * dir : dir;
    const sz = mode === 'still' ? 0 : mode === 'side' ? Math.sign(Math.sin(i / 120)) || 1 : z;
    m.applyInput(0, { seq: seq++, mx: sx, mz: sz, sprint: false, jockey: false, contain: false, ev: [] });
    m.step(); m.drainEvents();
    if (m.ball.owner !== p.id || m.phase !== 'play') { ok = false; break; }
    if (i % 6) continue;
    const opp = m.teamPlayers(1).map((o) => o.pos.x * dir).sort((a, b) => b - a);
    const line = Math.max(opp[1], m.ball.pos.x * dir, 0);
    for (const r of roles) {
      const q = m.teamPlayers(0).find((x) => x.role === r)!;
      const t = tot[r];
      t.n++;
      const fwd = q.vel.x * dir > 3.5;
      if (fwd) t.fwd++;
      if (fwd && !wasFwd[q.id]) t.runs++;
      wasFwd[q.id] = fwd;
      if (q.pos.x * dir > line + 0.05) t.offside++;
      let near = 99;
      for (const o of m.teamPlayers(1)) near = Math.min(near, Math.hypot(o.pos.x - q.pos.x, o.pos.z - q.pos.z));
      if (near > 5) t.free++;
    }
  }
  if (ok) trials++;
}
const out: Record<string, unknown> = {};
for (const r of roles) { const t = tot[r]; out[r] = { 'running fwd %': +(100 * t.fwd / t.n).toFixed(1), 'runs per 10 s': +(t.runs / (t.n / 10 * 0.1)).toFixed(2), 'offside pos %': +(100 * t.offside / t.n).toFixed(1), 'free >5m %': +(100 * t.free / t.n).toFixed(1) }; }
console.table(out);
console.log('trials kept ball whole time', trials, '/ 40');
