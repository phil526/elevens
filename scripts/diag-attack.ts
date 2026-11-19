// Where carriers are and what they choose: `npx tsx scripts/diag-attack.ts [seed]`.
import { Match, defaultConfig } from '../src/shared/match';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed: Number(process.argv[2] ?? 3) }));
const zone: Record<string, number> = {};
const intent: Record<string, number> = {};
let last = -1;
while (m.phase !== 'fulltime') {
  m.step();
  if (m.phase === 'halftime') m.continueAfterHalftime();
  m.drainEvents();
  if (m.phase !== 'play' || m.ball.owner < 0) continue;
  const p = m.players[m.ball.owner];
  const fx = p.pos.x * m.attackDir(p.team);
  const z = fx > 36 ? 'box-ish' : fx > 20 ? 'final' : fx > 0 ? 'opphalf' : fx > -25 ? 'ownhalf' : 'deep';
  zone[z] = (zone[z] ?? 0) + 1;
  if (fx > 15 && p.id !== last) { last = p.id; }
  if (fx > 15) intent[`${z}:${p.aiIntent}`] = (intent[`${z}:${p.aiIntent}`] ?? 0) + 1;
}
console.log(zone, intent, m.stats.map((s) => s.shots));
