import { Match, defaultConfig } from '../../src/shared/match';
import { MatchViewBuilder } from '../../src/client/view';
import { MatchAnalysis } from '../../src/client/analysis';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 2, seed: 1003 }));
const b = new MatchViewBuilder(m); const a = new MatchAnalysis(); a.reset(true);
let g = 0; const kinds: Record<string, number> = {};
while (m.phase !== 'fulltime' && g++ < 60 * 60 * 8) { b.capture(); m.step(); const ev = m.drainEvents(); for (const e of ev) if (e.type === 'kick') kinds[e.text ?? '?'] = (kinds[e.text ?? '?'] ?? 0) + 1; a.frame(b.build(1), ev); if (g % 3600 === 0) console.log(m.phase, m.half, m.displayClock); }
console.log(g, m.phase, kinds, a.shots.length, a.passes.length, m.stats);
