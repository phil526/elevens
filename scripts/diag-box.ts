// Attacking-box diagnostics over many matches: `npx tsx scripts/diag-box.ts [firstSeed] [count]`.
// Reports how often a wide carrier in the final third has a teammate in the box, crosses and
// their outcome, and shots by distance from goal.
import { Match, defaultConfig } from '../src/shared/match';
import { setDecideTrace } from '../src/shared/ai/carrier';
const first = Number(process.argv[2] ?? 11), count = Number(process.argv[3] ?? 20);
let wide = 0, wideWithBox = 0, crosses = 0, crossOk = 0, goals = 0;
const shots: Record<string, number> = {};
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  setDecideTrace((p) => {
    const dir = m.attackDir(p.team);
    if (!(p.pos.x * dir > 26 && Math.abs(p.pos.z) > 14)) return;
    wide++;
    if (m.teamPlayers(p.team).some((t) => t.id !== p.id && t.pos.x * dir > 33 && Math.abs(t.pos.z) < 16)) wideWithBox++;
  });
  let cross: { team: number; t: number } | null = null;
  while (m.phase !== 'fulltime') {
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    for (const e of m.drainEvents()) {
      if (e.type === 'goal') goals++;
      if (e.type !== 'kick') continue;
      const p = m.players[e.player as number];
      if (e.text === 'shot') {
        const d = Math.hypot(p.pos.x - m.attackDir(p.team) * 52.5, p.pos.z);
        const k = d < 12 ? '<12' : d < 18 ? '12-18' : d < 24 ? '18-24' : '24+';
        shots[k] = (shots[k] ?? 0) + 1;
      }
      if (m.ball.flight === 'cross') { crosses++; cross = { team: p.team, t: m.time }; }
    }
    if (cross) {
      const b = m.ball;
      if (b.owner >= 0 || (b.lastTouch >= 0 && b.lastTouch !== -1 && m.time - cross.t > 0.2 && b.flight !== 'cross')) {
        const toucher = b.owner >= 0 ? m.players[b.owner] : m.players[b.lastTouch];
        if (toucher && toucher.team === cross.team && m.time - cross.t > 0.2) crossOk++;
        if (m.time - cross.t > 0.2) cross = null;
      } else if (m.phase !== 'play' || m.time - cross.t > 4) cross = null;
    }
  }
}
console.log(`goals ${goals} | wide decisions ${wide}, with a teammate in the box ${wideWithBox} (${(100 * wideWithBox / Math.max(1, wide)).toFixed(0)}%) | crosses ${crosses}, first touch ours ${crossOk} | shots`, shots);
