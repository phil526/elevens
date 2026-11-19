// Shot decisions near goal: `npx tsx scripts/diag-shoot.ts [seed]`.
import { setDecideTrace } from '../src/shared/ai/carrier';
import { Match, defaultConfig } from '../src/shared/match';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: Number(process.argv[2] ?? 3) }));
const rows: string[] = [];
setDecideTrace((p, opts) => {
  const sh = opts.find((o) => o.label === 'shoot');
  if (!sh) return;
  const d = Math.hypot(p.pos.x - m.attackDir(p.team) * 52.5, p.pos.z);
  rows.push(`d=${d.toFixed(1)} z=${p.pos.z.toFixed(0)} shoot=${sh.score.toFixed(2)} best=${opts[0].label}:${opts[0].score.toFixed(2)}`);
});
while (m.phase !== 'fulltime') { m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); m.drainEvents(); }
console.log(rows.length, rows.filter((r) => r.includes('best=shoot')).length);
console.log(rows.slice(0, 40).join('\n'));
