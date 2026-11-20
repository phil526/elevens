// Standing tackles in AI v AI matches: attempts, clean wins, fouls from them, skips (20 Nov 2026).
// `P20_OFF=timing npx tsx scripts/diag-tackles.ts [firstSeed] [count]`
import { Match, defaultConfig } from '../src/shared/match';
import { p20Off } from '../src/shared/switches';
import { tackleTiming } from '../src/shared/contact';
p20Off(process.env.P20_OFF);
const first = Number(process.argv[2] ?? 1000), count = Number(process.argv[3] ?? 20);
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
const proto = Match.prototype as any;
const orig = proto.resolveTackle;
proto.resolveTackle = function (t: any) {
  const b = this.ball, owner = b.owner >= 0 ? this.players[b.owner] : null;
  const before = { owner: b.owner, fouls: this.stats[0].fouls + this.stats[1].fouls };
  let bin = '';
  if (owner && owner.team !== t.team) {
    add('attempts'); const tm = tackleTiming(t, owner, b.pos); add('timingSum', tm); bin = `tbin${Math.min(4, Math.floor(tm * 5))}`; add(bin);
    const dx = b.pos.x - t.pos.x, dz = b.pos.z - t.pos.z;
    if (Math.hypot(dx, dz) > 1.6) add('outOfReach');
    if (owner.shielding) add('shielding');
  }
  orig.call(this, t);
  if (owner && owner.team !== t.team) {
    if (t.action.missed === false) { add('won'); add(bin + 'won'); }
    if (this.stats[0].fouls + this.stats[1].fouls > before.fouls) add('fouls');
  }
};
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed, difficulty: ['pro', 'pro'] }));
  while (m.phase !== 'fulltime') { m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); }
}
out.avgTiming = Math.round((out.timingSum / out.attempts) * 1000) / 1000; delete out.timingSum;
out.winRate = Math.round((out.won / out.attempts) * 1000) / 1000;
console.log(JSON.stringify(out));
