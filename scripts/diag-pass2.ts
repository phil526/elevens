// Pass outcomes over several matches, classified by where they fail:
// `npx tsx scripts/diag-pass2.ts [firstSeed] [count]`.
import { Match, defaultConfig } from '../src/shared/match';
const first = Number(process.argv[2] ?? 11), count = Number(process.argv[3] ?? 10);
const out: Record<string, number> = {};
const detail: string[] = [];
const add = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  type P = { team: number; kind: string; recv: number; t0: number; minR: number; d: number; lane: number };
  let cur: P | null = null;
  let lastKickTick = -1;
  const finish = (res: string) => {
    if (cur) {
      add(`${cur.kind}:${res}`);
      if (process.env.DETAIL && `${cur.kind}:${res}`.startsWith(process.env.DETAIL) && detail.length < 30) {
        const r = cur.recv >= 0 ? m.players[cur.recv] : null;
        detail.push(`seed ${seed} d=${cur.d.toFixed(1)} minR=${cur.minR.toFixed(2)} age=${((m.tick - cur.t0) / 60).toFixed(2)} ball(${m.ball.pos.x.toFixed(0)},${m.ball.pos.z.toFixed(0)}) recv ${r?.role}(${r?.pos.x.toFixed(0)},${r?.pos.z.toFixed(0)}) act=${r?.action.type} state=${r?.aiIntent}`);
      }
    }
    cur = null;
  };
  while (m.phase !== 'fulltime') {
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    for (const e of m.drainEvents()) {
      if (e.type !== 'kick' || !['pass', 'through', 'lob', 'cross'].includes(String(e.text))) continue;
      finish('replaced');
      const k = m.players[e.player as number];
      const r = m.ball.receiver >= 0 ? m.players[m.ball.receiver] : null;
      cur = { team: k.team, kind: String(e.text), recv: m.ball.receiver, t0: m.tick, minR: 99, d: r ? Math.hypot(r.pos.x - k.pos.x, r.pos.z - k.pos.z) : -1, lane: 0 };
      lastKickTick = m.tick;
    }
    const b = m.ball;
    if (cur && cur.recv >= 0) {
      const r = m.players[cur.recv];
      cur.minR = Math.min(cur.minR, Math.hypot(r.pos.x - b.pos.x, r.pos.z - b.pos.z));
    }
    if (!cur) continue;
    const age = (m.tick - cur.t0) / 60;
    if (m.phase !== 'play') { finish(m.restart?.team === cur.team ? 'dead-ours' : 'dead-theirs'); continue; }
    if (b.owner >= 0) {
      const o = m.players[b.owner];
      if (o.id === cur.recv && age < 0.05) continue;
      if (o.team === cur.team) finish(o.id === cur.recv ? 'ok' : 'ok-other');
      else finish(age < 0.4 ? 'opp-at-source' : cur.minR < 1.5 ? 'opp-receiver-reached' : 'opp-in-flight');
    } else if (b.state === 'free' && b.lastTouchTeam !== cur.team) {
      finish(age < 0.4 ? 'touched-at-source' : cur.minR < 1.5 ? 'touched-receiver-reached' : 'touched-in-flight');
    } else if (age > 5) finish('loose');
  }
  void lastKickTick;
}
const tot = Object.values(out).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(out).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(34), v, `${(100 * v / tot).toFixed(1)}%`);
if (detail.length) console.log(detail.join('\n'));
