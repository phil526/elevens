// How fast players move while backpedalling (moving backwards relative to their facing) in AI v AI
// matches: `npx tsx scripts/diag-backpedal.ts [seed] [count]`. Used to pick the speed range for the
// captured backwards-walk clip (20 Nov 2026).
import { Match, defaultConfig } from '../src/shared/match';
import { moveDirFor } from '../src/client/render/moves7';
const first = Number(process.argv[2] ?? 11), count = Number(process.argv[3] ?? 2);
const bins = new Array(9).fill(0);
let total = 0;
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  while (m.phase !== 'fulltime') {
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    for (const p of m.players) {
      if (p.action.type !== 'none' || p.jockeying) continue;
      const md = moveDirFor(p.facing, p.vel.x, p.vel.z);
      if (md.back < 0.5 || md.back < md.side) continue;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      bins[Math.min(8, Math.floor(sp))]++; total++;
    }
  }
}
console.log('backpedal ticks', total, 'by m/s:', bins.map((b, i) => `${i}-${i + 1}: ${((100 * b) / Math.max(1, total)).toFixed(1)}%`).join('  '));
