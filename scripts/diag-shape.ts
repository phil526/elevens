// Team shapes while one side has the ball in the opponent half: `npx tsx scripts/diag-shape.ts [seed]`.
import { Match, defaultConfig } from '../src/shared/match';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: Number(process.argv[2] ?? 3) }));
let shown = 0, cool = 0;
while (m.phase !== 'fulltime' && shown < 5) {
  m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); m.drainEvents();
  if (--cool > 0 || m.phase !== 'play' || m.ball.owner < 0) continue;
  const c = m.players[m.ball.owner]; const dir = m.attackDir(c.team);
  if (c.pos.x * dir < 8) continue;
  cool = 600; shown++;
  const f = (p: typeof c) => `${p.role}(${(p.pos.x * dir).toFixed(0)},${(p.pos.z * dir).toFixed(0)})`;
  console.log(`carrier ${f(c)} intent=${c.aiIntent}`);
  console.log(' att:', m.teamPlayers(c.team).filter((p) => p !== c).map(f).join(' '));
  console.log(' def:', m.teamPlayers(1 - c.team).map(f).join(' '));
}
