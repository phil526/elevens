// The human's through balls to running teammates (19 Nov 2026, "passing to my team mates running
// forward rarely connects"): `npx tsx scripts/bench-through.ts [firstSeed] [count] [difficulty] [recv]`.
// A scripted pad player (team 0, Assisted passing, Late receiver) plays like bench-human, but when a
// teammate ahead is running forward it points the stick at him (±12°) and plays a through ball with a
// random charge. After the pass, control is on the receiver: recv=release lets go of the stick
// (receive assist), recv=hold keeps running the way he was going until the ball is close, then steers
// to it (the default, like a person still holding the stick). Counts what happened to each through ball.
import { Match, defaultConfig } from '../src/shared/match';
import type { Difficulty } from '../src/shared/config';
import { mulberry } from './bench-rng';
import * as kick from '../src/shared/kick';
const { laneBlock } = kick;
for (const kv of (process.env.STRIDE ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); ((kick as any).STRIDE)[k] = Number(v); }

const rc0 = () => m0!.ball.receiver >= 0;
let m0: Match | null = null;
const first = Number(process.argv[2] ?? 1), count = Number(process.argv[3] ?? 20);
const diff = (process.argv[4] ?? 'casual') as Difficulty;
const recvMode = process.argv[5] ?? 'hold';
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
for (let seed = first; seed < first + count; seed++) {
  const R = mulberry(seed * 7919 + 13);
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, difficulty: ['pro', diff] }));
  m0 = m;
  let seq = 1, nextAct = 0, lastCmd = -1, lastKick: { kind: string; kicker: number; recv: number; from: { x: number; z: number } } | null = null;
  // The through ball being followed: who it was aimed at and the run direction at the time.
  let tb: { aimed: number; picked: number; runX: number; runZ: number; t: number; kicker: number } | null = null;
  const settle = (k: string) => {
    const pl = tb && (tb as any).info?.st?.plan;
    if (pl && tb!.picked === tb!.aimed) { const kk = k.startsWith('ok') ? 'ok' : k; add(`T${Math.min(4, Math.floor(pl.t))}_${kk}`); add(`M${pl.margin < 0 ? 'neg' : pl.margin < 0.5 ? 'lo' : 'hi'}_${kk}`); add(`V${Math.min(8, Math.floor(pl.arrive / 2) * 2)}_${kk}`); }
    if (process.env.DEBUG && k === process.env.DEBUG && tb && (tb as any).info) {
      const i = (tb as any).info, rp = tb.picked >= 0 ? m.players[tb.picked] : null; const f = (v: any) => v ? `${v.x.toFixed(1)},${v.z.toFixed(1)}` : '-';
      if ((tb as any).tr) console.log((tb as any).tr.join('\n'));
      if (i.st?.plan) console.log(`  plan t ${i.st.plan.t.toFixed(1)} va ${i.st.plan.arrive.toFixed(1)} margin ${i.st.plan.margin.toFixed(2)} recvAtT ${f((tb as any).atT)}`);
      console.log(`dt ${(m.time - i.t).toFixed(1)} dir ${m.attackDir(0)} rpos ${f(i.rpos)} rvel ${f(i.rvel)} ball ${f(i.bpos)} bvel ${f(i.bvel)} plan ${f(i.st?.point)} -> ball now ${f(m.ball.pos)} recv now ${f(rp?.pos)} aimed ${tb.picked === tb.aimed}`);
    } add(`tb_${k}`); if (tb && tb.picked >= 0) add(`tb_${k}_${tb.picked === tb.aimed ? 'A' : 'O'}${(tb as any).plan ? 'p' : 'n'}`); tb = null; };
  while (m.phase !== 'fulltime') {
    if (m.phase === 'halftime') m.continueAfterHalftime();
    const c = m.ctrl[0];
    const me = m.players[c.pid];
    const ev: any[] = [];
    let mx = 0, mz = 0, sprint = false;
    const dir = m.attackDir(0);
    const b = m.ball;
    if (tb && me && me.id === tb.picked && b.state === 'flight' && b.owner < 0) {
      // Receiving the through ball.
      const db = Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z);
      // run: keeps running his line until the ball is close. hold: runs his line for a moment, then
      // steers for where the ball is going (half a second ahead of it), as a person watching it would.
      if (recvMode === 'run' && db > 6) { mx = tb.runX; mz = tb.runZ; sprint = true; }
      else if (recvMode === 'hold' && m.time - tb.t < 0.6) { mx = tb.runX; mz = tb.runZ; sprint = true; }
      else if (recvMode === 'hold' || recvMode === 'run') { const lead = recvMode === 'hold' ? 0.5 : 0; mx = b.pos.x + b.vel.x * lead - me.pos.x; mz = b.pos.z + b.vel.z * lead - me.pos.z; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; sprint = true; }
    } else if (me && b.owner === me.id && b.state !== 'dead') {
      const gx = dir * 52.5;
      const dg = Math.hypot(gx - me.pos.x, me.pos.z);
      mx = gx - me.pos.x; mz = -me.pos.z * 0.5; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L;
      sprint = R() < 0.6;
      if (m.time >= nextAct && me.action.type === 'none') {
        const runners = m.teamPlayers(0).filter((t) => t.id !== me.id && t.role !== 'GK' && !t.off && t.vel.x * dir > 3.5 && (t.pos.x - me.pos.x) * dir > 2 && Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z) < 32);
        if (dg < 20 && R() < 0.5) {
          const corner = (R() < 0.5 ? 1 : -1) * 3;
          const ax = gx - me.pos.x, az = corner - me.pos.z, l = Math.hypot(ax, az);
          mx = ax / l; mz = az / l;
          ev.push({ k: 'shoot', p: 0.5 + R() * 0.5 });
          nextAct = m.time + 1.5;
        } else if (runners.length && R() < 0.7) {
          const t = runners[Math.floor(R() * runners.length)];
          const a = Math.atan2(t.pos.z - me.pos.z, t.pos.x - me.pos.x) + (R() - 0.5) * 0.42;
          mx = Math.cos(a); mz = Math.sin(a);
          ev.push({ k: 'through', p: 0.05 + R() * 0.9 }); lastCmd = me.id;
          const sp = Math.hypot(t.vel.x, t.vel.z) || 1;
          tb = { aimed: t.id, picked: -1, runX: t.vel.x / sp, runZ: t.vel.z / sp, t: m.time, kicker: me.id };
          nextAct = m.time + 1.2;
        } else if (R() < 0.6) {
          const mates = m.teamPlayers(0).filter((t) => t.id !== me.id && t.role !== 'GK' && !t.off && (t.pos.x - me.pos.x) * dir > -8 && Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z) < 30);
          if (mates.length) {
            const opp = m.teamPlayers(1).filter((o) => !o.off);
            mates.sort((x, y) => laneBlock(me.pos, x.pos, opp) - laneBlock(me.pos, y.pos, opp));
            const t = R() < 0.7 ? mates[0] : mates[Math.floor(R() * mates.length)];
            const a = Math.atan2(t.pos.z - me.pos.z, t.pos.x - me.pos.x) + (R() - 0.5) * 0.5;
            mx = Math.cos(a); mz = Math.sin(a);
            ev.push({ k: 'pass', p: R() }); lastCmd = me.id;
          }
          nextAct = m.time + 0.8 + R() * 1.2;
        } else nextAct = m.time + 0.5;
      }
    } else if (me && b.state !== 'dead' && m.possessionTeam() !== 0) {
      mx = b.pos.x - me.pos.x; mz = b.pos.z - me.pos.z; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; sprint = L > 4;
      if (L < 2 && R() < 0.05) ev.push({ k: 'pass', p: 0 });
    } else if (me && b.state !== 'dead') {
      mx = b.pos.x - me.pos.x; mz = b.pos.z - me.pos.z; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L;
    } else if (me && m.restart && m.restart.taker === me.id && m.restart.ready && m.time >= nextAct) {
      ev.push({ k: 'pass', p: 0.4 }); nextAct = m.time + 1;
    }
    m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: m.possessionTeam() === 1, ev });
    m.step();
    for (const e of m.drainEvents()) {
      if (e.type === 'kick' && tb && tb.picked < 0 && e.player === tb.kicker) {
        if (e.text !== 'through') { tb = null; continue; }
        tb.picked = m.ball.receiver;
        if (tb.picked >= 0) { const pr = m.players[tb.picked]; const ps = Math.hypot(pr.vel.x, pr.vel.z); if (ps > 2) { tb.runX = pr.vel.x / ps; tb.runZ = pr.vel.z / ps; } else { const bx = m.ball.pos.x - pr.pos.x, bz = m.ball.pos.z - pr.pos.z, bl = Math.hypot(bx, bz) || 1; tb.runX = bx / bl; tb.runZ = bz / bl; } }
        (tb as any).plan = !!(m as any).stride?.plan;
        if (tb.picked >= 0) add((m as any).stride?.plan ? 'tb_withPlan' : 'tb_noPlan');
        if (rc0()) (tb as any).info = { rpos: { ...m.players[m.ball.receiver].pos }, rvel: { ...m.players[m.ball.receiver].vel }, bpos: { ...m.ball.pos }, bvel: { ...m.ball.vel }, opp: m.teamPlayers(1).map((o) => ({ id: o.id, pos: { ...o.pos } })), st: (m as any).stride && { ...(m as any).stride }, t: m.time };
        add('tb');
        add(tb.picked === tb.aimed ? 'tb_pickedAimed' : tb.picked < 0 ? 'tb_pickedSpace' : 'tb_pickedOther');
        const rc = tb.picked >= 0 ? m.players[tb.picked] : null;
        if (rc) add('tb_lenSum', Math.round(Math.hypot(rc.pos.x - m.ball.pos.x, rc.pos.z - m.ball.pos.z)));
      } else if (tb && tb.picked !== -2 && e.type === 'offside' && e.team === 0) settle('offside');
      else if (tb && (e.type === 'out' || e.type === 'restart')) settle('out');
      else if (tb && e.type === 'kick' && e.player !== tb.kicker && tb.picked >= -1 && m.time - tb.t > 0.2 && m.players[e.player as number].team === 1) settle('lostKick');
    }
    if (tb && (tb as any).info?.st?.plan && !(tb as any).atT && m.time - (tb as any).info.t >= (tb as any).info.st.plan.t) (tb as any).atT = { ...m.players[tb.picked].pos };
    if (process.env.TRACE && tb && tb.picked >= 0 && (tb as any).info?.st?.plan && Math.round(m.time * 60) % 15 === 0) {
      const rp = m.players[tb.picked]; const aim = (m as any).strideAim?.(rp); const c = m.ctrl[0];
      ((tb as any).tr ??= []).push(`  tr ${(m.time - (tb as any).info.t).toFixed(2)} R ${rp.pos.x.toFixed(1)},${rp.pos.z.toFixed(1)} v ${Math.hypot(rp.vel.x, rp.vel.z).toFixed(1)} wish ${rp.wish.mode} ${rp.wish.x.toFixed(2)},${rp.wish.z.toFixed(2)} aim ${aim ? aim.x.toFixed(1) + ',' + aim.z.toFixed(1) : '-'} ctl ${c.pid === rp.id} st ${rp.stamina.toFixed(2)} act ${rp.action.type} ball ${m.ball.pos.x.toFixed(1)},${m.ball.pos.z.toFixed(1)} bv ${Math.hypot(m.ball.vel.x, m.ball.vel.z).toFixed(1)} fl ${m.ball.flight} rc ${m.ball.receiver}`);
    }
    if (tb && tb.picked === -1 && m.time - tb.t > 1.5) tb = null; // the kick never came (tackled while winding up)
    const own = m.ball.owner;
    if (tb && own >= 0 && own !== tb.kicker && (tb.picked >= 0 || m.time - tb.t > 0.3)) {
      const p = m.players[own];
      if (p.team === 0) {
        if (own === tb.picked) { add('tb_okPicked'); add('tb_okSpeedSum', +Math.hypot(p.vel.x, p.vel.z).toFixed(1)); if (own === tb.aimed) add('tb_okAimed'); }
        settle(own === tb.picked ? 'okRecv' : 'okOther');
      } else {
        if (process.env.DEBUG === 'lostDef' && tb && (tb as any).info?.st?.plan) { const i = (tb as any).info; const f = (v: any) => v ? `${v.x.toFixed(1)},${v.z.toFixed(1)}` : '-'; const rp = m.players[tb.picked]; const d0 = (i.opp as any[]).find((o) => o.id === own);
          console.log(`LD dt ${(m.time - i.t).toFixed(1)} plan t ${i.st.plan.t.toFixed(1)} va ${i.st.plan.arrive.toFixed(1)} mg ${i.st.plan.margin.toFixed(2)} ball0 ${f(i.bpos)} C ${f(i.st.point)} R0 ${f(i.rpos)} Rnow ${f(rp.pos)} at ${f(m.ball.pos)} def0 ${f(d0?.pos)} ${p.role} aimed ${tb.picked === tb.aimed}`); }
        settle(p.role === 'GK' ? 'lostGK' : 'lostDef');
      }
    }
    if (tb && m.ball.state === 'held' && m.players[m.ball.owner]?.team === 1) settle('lostGK');
    if (tb && m.time - tb.t > 8) settle('timeout');
  }
  add('matches');
  add('passesH', m.stats[0].passes); add('passesOkH', m.stats[0].passesCompleted);
  add('aiPasses', m.stats[1].passes); add('aiPassesOk', m.stats[1].passesCompleted);
  add('hgoals', m.score[0]); add('aigoals', m.score[1]);
}
const r = (a: number, b: number) => +(100 * (a ?? 0) / Math.max(1, b ?? 0)).toFixed(1);
const n = out.tb ?? 0;
console.log(JSON.stringify({
  ...out,
  tbConnectPct: r(out.tb_okRecv ?? 0, n), aimedGotPct: r(out.tb_okAimed ?? 0, n), tbKeptPct: r((out.tb_okRecv ?? 0) + (out.tb_okOther ?? 0), n),
  aimedPickedPct: r(out.tb_pickedAimed ?? 0, n), offsidePct: r(out.tb_offside ?? 0, n),
  gkPct: r(out.tb_lostGK ?? 0, n), defPct: r((out.tb_lostDef ?? 0) + (out.tb_lostKick ?? 0), n), outPct: r(out.tb_out ?? 0, n),
  recvSpeed: +((out.tb_okSpeedSum ?? 0) / Math.max(1, out.tb_okPicked ?? 0)).toFixed(2),
  teamPassPct: r(out.passesOkH, out.passesH), aiPassPct: r(out.aiPassesOk, out.aiPasses),
}));
