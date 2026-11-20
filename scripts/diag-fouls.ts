// Where fouls come from in AI v AI matches (20 Nov 2026): `P20_OFF=... npx tsx scripts/diag-fouls.ts [firstSeed] [count]`
import { Match, defaultConfig } from '../src/shared/match';
import { p20Off } from '../src/shared/switches';
p20Off(process.env.P20_OFF);
const first = Number(process.argv[2] ?? 1000), count = Number(process.argv[3] ?? 20);
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
const proto = Match.prototype as any;
const orig = proto.foul;
proto.foul = function (o: any, v: any, how: any = {}) {
  const at = o.action?.type ?? 'none';
  add(`${at}${how.slide ? '_slide' : ''}${how.fromBehind ? '_behind' : ''}${how.tactical ? '_tactical' : ''}`);
  return orig.call(this, o, v, how);
};
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed, difficulty: ['pro', 'pro'] }));
  while (m.phase !== 'fulltime') { m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); }
}
console.log(JSON.stringify(out));
