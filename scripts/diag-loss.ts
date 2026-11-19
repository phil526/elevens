// How possession is lost: `npx tsx scripts/diag-loss.ts [seed]`.
import { Match, defaultConfig } from '../src/shared/match';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: Number(process.argv[2] ?? 3) }));
const why: Record<string, number> = {};
let team = -1, lastEv = '', spellStart = 0;
const spells: number[] = [];
while (m.phase !== 'fulltime') {
  m.step();
  if (m.phase === 'halftime') m.continueAfterHalftime();
  for (const e of m.drainEvents()) if (['tackle', 'foul', 'out', 'block', 'kick'].includes(e.type)) lastEv = e.type + (e.text ? ':' + e.text : '');
  if (m.phase !== 'play') continue;
  const pt = m.ball.owner >= 0 ? m.players[m.ball.owner].team : -1;
  if (pt >= 0 && pt !== team) {
    if (team >= 0) { why[lastEv] = (why[lastEv] ?? 0) + 1; spells.push((m.tick - spellStart) / 60); }
    team = pt; spellStart = m.tick;
  }
}
spells.sort((a, b) => a - b);
console.log(why, 'spells', spells.length, 'median s', spells[spells.length >> 1]?.toFixed(1));
