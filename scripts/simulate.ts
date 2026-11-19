// Headless AI-vs-AI exhibition: `npm run sim -- [matches] [realMinutes] [seed]`.
// Runs the shared simulation as fast as possible and prints results, stats and
// any recovery/debug log lines. Used for balancing and in verification.
import { Match, defaultConfig, fmtClock } from '../src/shared/match';

const n = Number(process.argv[2] ?? 1);
const minutes = Number(process.argv[3] ?? 6);
const seed0 = Number(process.argv[4] ?? 1);
let totals = [0, 0];
for (let i = 0; i < n; i++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: minutes, seed: seed0 + i, difficulty: ['pro', 'pro'] }));
  const t0 = performance.now();
  const counts: Record<string, number> = {};
  let ticks = 0;
  let maxRestart = 0;
  while (m.phase !== 'fulltime' && ticks < 60 * 60 * 30) {
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    if (m.restart) maxRestart = Math.max(maxRestart, m.restart.t);
    for (const e of m.drainEvents()) counts[e.type] = (counts[e.type] ?? 0) + 1;
    ticks++;
  }
  const ms = performance.now() - t0;
  totals[0] += m.score[0]; totals[1] += m.score[1];
  console.log(`match ${i + 1} seed ${seed0 + i}: ${m.teams[0].abbr} ${m.score[0]}-${m.score[1]} ${m.teams[1].abbr}  phase=${m.phase} clock=${fmtClock(m.displayClock)} ticks=${ticks} (${(ms / ticks).toFixed(3)} ms/tick) maxRestartSetup=${maxRestart.toFixed(1)}s`);
  console.log('  goals:', m.goals.map((g) => `${g.minute}' ${m.players[g.player]?.def.short}${g.ownGoal ? ' (og)' : ''}`).join(', ') || 'none');
  console.log('  stats:', JSON.stringify(m.stats.map((s) => ({ ...s, possession: Math.round((100 * s.possessionTicks) / Math.max(1, m.stats[0].possessionTicks + m.stats[1].possessionTicks)) }))));
  console.log('  events:', JSON.stringify(counts));
  if (m.log.length) console.log('  log:\n   ' + m.log.slice(-15).join('\n   '));
}
console.log('totals', totals);
