// Goals conceded vs keeper state: `npx tsx scripts/diag-keeper.ts [matches]`.
import { Match, defaultConfig } from '../src/shared/match';
for (let seed = 11; seed < 11 + Number(process.argv[2] ?? 6); seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  let shot: { x: number; z: number; v: number; t: number } | null = null;
  while (m.phase !== 'fulltime') {
    m.step(); if (m.phase === 'halftime') m.continueAfterHalftime();
    for (const e of m.drainEvents()) {
      if (e.type === 'kick' && e.text === 'shot') shot = { x: e.x!, z: e.z!, v: e.power!, t: m.time };
      if (e.type === 'goal') {
        const gk = m.keeper(1 - e.team!);
        const b = m.ball;
        console.log(`seed ${seed} goal: shot from (${shot?.x.toFixed(0)},${shot?.z.toFixed(0)}) v=${shot?.v.toFixed(1)} flight ${(m.time - (shot?.t ?? 0)).toFixed(2)}s; ball in at z=${b.pos.z.toFixed(2)} y=${b.pos.y.toFixed(2)}; gk at (${gk.pos.x.toFixed(1)},${gk.pos.z.toFixed(1)}) action=${gk.action.type} t=${gk.action.t.toFixed(2)} lastFlight=${b.flight}`);
      }
    }
  }
}
