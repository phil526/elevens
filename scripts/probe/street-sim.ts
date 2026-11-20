// AI v AI street matches: goals, shots, passes, fouls, stuck time.  npx tsx scripts/probe/street-sim.ts [count] [street=1]
import { Match, defaultConfig } from '../../src/shared/match';
import { PITCH } from '../../src/shared/config';
const n = Number(process.argv[2] ?? 10), street = process.argv[3] !== '0';
const tot = { goals: 0, shots: 0, passes: 0, comp: 0, fouls: 0, saves: 0, frees: 0, pens: 0, drops: 0, outside: 0, ticks: 0, restarts: {} as Record<string, number> };
for (let i = 0; i < n; i++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 4, seed: 5000 + i, street }));
  let guard = 0, lastR: unknown = null;
  while (m.phase !== 'fulltime' && guard++ < 60 * 60 * 8) {
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    if (m.restart && m.restart !== lastR) { tot.restarts[m.restart.type] = (tot.restarts[m.restart.type] ?? 0) + 1; }
    lastR = m.restart;
    for (const p of m.players) if (!p.off && (Math.abs(p.pos.x) > PITCH.halfLength + 0.01 || Math.abs(p.pos.z) > PITCH.halfWidth + 0.01)) { if (tot.outside++ < 6) console.log("outside", p.role, p.pos, m.phase, p.action.type, m.restart?.type); }
    m.drainEvents();
  }
  tot.ticks += guard;
  for (const t of [0, 1]) { const s = m.stats[t]; tot.goals += m.score[t]; tot.shots += s.shots; tot.passes += s.passes; tot.comp += s.passesCompleted ?? 0; tot.fouls += s.fouls; }
  console.log(`match ${i}: ${m.score[0]}-${m.score[1]} shots ${m.stats[0].shots}/${m.stats[1].shots} passes ${m.stats[0].passes}/${m.stats[1].passes}`);
}
console.log(JSON.stringify(tot));
