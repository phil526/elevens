// A scripted "human" (team 0, Assisted passing) against the AI, to measure how hard it is to
// pass and score as a player: `npx tsx scripts/bench-human.ts [firstSeed] [count] [difficulty]`.
// The bot plays like a casual pad player: stick roughly at a teammate (±20°) with a random charge,
// shots from inside ~22 m with the stick at a corner and a charge between 0.5 and 1.
import { Match, defaultConfig } from '../src/shared/match';
import type { Difficulty } from '../src/shared/config';
import { mulberry } from './bench-rng';
import { DIFFICULTY } from '../src/shared/config';
import { laneBlock } from '../src/shared/kick';
import { bcOff, g6Off } from '../src/shared/switches';
// BC_OFF=attr,heavy,... turns the 19 Nov 2026 ball-control features off to compare.
bcOff(process.env.BC_OFF);
// G6_OFF=momentum,keeper,... turns the 19 Nov 2026 gameplay features off to compare.
g6Off(process.env.G6_OFF);
// `nohelp` as a 4th argument measures without the human help (as before 18 Nov).
if (process.argv[5] === 'nohelp') for (const k of Object.keys(DIFFICULTY) as (keyof typeof DIFFICULTY)[]) DIFFICULTY[k].help = 0;

import { TEAMMATE_ON } from '../src/shared/ai/team';
// TM_OFF=cover,counter,overlap turns the teammate behaviours off to compare.
for (const k of (process.env.TM_OFF ?? '').split(',').filter(Boolean)) (TEAMMATE_ON as Record<string, boolean>)[k] = false;
const first = Number(process.argv[2] ?? 1), count = Number(process.argv[3] ?? 20);
const diff = (process.argv[4] ?? 'pro') as Difficulty;
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
for (let seed = first; seed < first + count; seed++) {
  const R = mulberry(seed * 7919);
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed, difficulty: ['pro', diff] }));
  let ownTeam = -1, lostAt = -99, lostX = 0, progDone = true;
  // Teammate behaviours (19 Nov, third set): runs started, keeper sweeps, block slides, second balls, set pieces.
  const runStart = new Map<number, number>();
  let sweeping = false, cornerAt = -99, secondAt = -99, prevOwnerB = -1, sweepAt = -99, sweepOpen = false;
  let lastSw = { from: -1, to: -1, t: -99 };
  let heldStick: { x: number; z: number } | null = null, heldFor = -1;
  let seq = 1, nextAct = 0, lastCmd = -1, lastKick: { kind: string; kicker: number; recv: number; from: { x: number; z: number }; t: number } | null = null, lastShotT = -9;
  while (m.phase !== 'fulltime') {
    if (m.phase === 'halftime') m.continueAfterHalftime();
    const c = m.ctrl[0];
    const me = m.players[c.pid];
    const ev: any[] = [];
    let mx = 0, mz = 0, sprint = false;
    const dir = m.attackDir(0);
    const b = m.ball;
    if (me && b.owner === me.id && b.state !== 'dead') {
      const gx = dir * 52.5;
      const dg = Math.hypot(gx - me.pos.x, me.pos.z);
      mx = gx - me.pos.x; mz = -me.pos.z * 0.5; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L;
      sprint = R() < 0.6;
      if (m.time >= nextAct && me.action.type === 'none') {
        if (dg < 22 && R() < 0.5) {
          const corner = (R() < 0.5 ? 1 : -1) * 3;
          const ax = gx - me.pos.x, az = corner - me.pos.z, l = Math.hypot(ax, az);
          mx = ax / l; mz = az / l;
          ev.push({ k: 'shoot', p: 0.5 + R() * 0.5 });
          nextAct = m.time + 1.5;
        } else if (R() < 0.6) {
          // pass to a random teammate ahead-ish
          const mates = m.teamPlayers(0).filter((t) => t.id !== me.id && t.role !== 'GK' && !t.off && (t.pos.x - me.pos.x) * dir > -8 && Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z) < 30);
          if (mates.length) {
            // Usually the most open teammate (as a player would look for), sometimes any.
            const opp = m.teamPlayers(1).filter((o) => !o.off);
            mates.sort((x, y) => laneBlock(me.pos, x.pos, opp) - laneBlock(me.pos, y.pos, opp));
            const t = R() < 0.7 ? mates[0] : mates[Math.floor(R() * mates.length)];
            const a = Math.atan2(t.pos.z - me.pos.z, t.pos.x - me.pos.x) + (R() - 0.5) * 0.5;
            mx = Math.cos(a); mz = Math.sin(a);
            ev.push({ k: R() < 0.85 ? 'pass' : 'through', p: R() }); lastCmd = me.id;
          }
          nextAct = m.time + 0.8 + R() * 1.2;
        } else nextAct = m.time + 0.5;
      }
    } else if (me && b.state !== 'dead' && m.possessionTeam() !== 0) {
      mx = b.pos.x - me.pos.x; mz = b.pos.z - me.pos.z; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; sprint = L > 4;
      if (L < 2 && R() < 0.05) ev.push({ k: 'pass', p: 0 });
    } else if (me && b.state === 'flight' && b.receiver === me.id && process.env.HOLD === '1' && heldStick) {
      // HOLD=1: like most pad players, the stick stays pushed the way the pass went while it travels.
      mx = heldStick.x; mz = heldStick.z;
    } else if (me && b.state !== 'dead') {
      mx = b.pos.x - me.pos.x; mz = b.pos.z - me.pos.z; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L;
    } else if (me && m.restart && m.restart.taker === me.id && m.restart.ready && m.time >= nextAct) {
      ev.push({ k: 'pass', p: 0.4 }); nextAct = m.time + 1;
    }
    if (ev.some((e) => e.k === 'pass' || e.k === 'through')) { heldStick = { x: mx, z: mz }; heldFor = me.id; }
    else if (b.owner >= 0 && b.owner !== heldFor) heldStick = null;
    // HOLD=1: the stick stays on the pass through the wind-up too.
    if (process.env.HOLD === '1' && heldStick && b.owner === heldFor && me && me.id === heldFor && !ev.length) { mx = heldStick.x; mz = heldStick.z; }
    // Forward options while the human has the ball: teammates 5 m+ ahead of it, onside, 4 m+ from
    // the nearest opponent and with a clear lane (sampled every 6 ticks).
    if (me && b.owner === me.id && b.state === 'dribble' && (m.tick % 6) === 0) {
      const opp = m.teamPlayers(1).filter((o) => !o.off);
      const line = Math.max(opp.map((o) => o.pos.x * dir).sort((x, y) => y - x)[1], b.pos.x * dir, 0);
      let n = 0, mv = 0;
      for (const t of m.teamPlayers(0)) {
        if (t.id === me.id || t.off || t.role === 'GK') continue;
        const ahead = (t.pos.x - b.pos.x) * dir;
        if (ahead < 5) continue;
        if (t.vel.x * dir > 3.5) mv++;
        if (t.pos.x * dir > line + 0.05) continue;
        let near = 99; for (const o of opp) near = Math.min(near, Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z));
        if (near >= 4 && laneBlock(me.pos, t.pos, opp) < 0.3) n++;
      }
      add('optSamples'); add('fwdOpen', n); add('fwdRunning', mv);
    }
    m.applyInput(0, { seq: seq++, mx, mz, sprint, jockey: false, contain: m.possessionTeam() === 1, ev });
    m.step();
    for (const p of m.teamPlayers(0)) {
      if (p.runLane && runStart.get(p.id) !== p.runStart && p.aiRunUntil > m.time) { add(`run${p.runLane}`); runStart.set(p.id, p.runStart); }
      if (p.action.type === 'slide' && p.action.block && p.action.t <= 1 / 60 + 1e-6) add('lunges');
    }
    const gk0 = m.keeper(0);
    if (gk0.aiIntent === 'sweep' && !sweeping && m.time - sweepAt > 3) { add('sweeps'); sweepAt = m.time; sweepOpen = true; }
    if (sweepOpen && m.ball.owner >= 0 && m.ball.owner !== prevOwnerB) { sweepOpen = false; const o = m.players[m.ball.owner]; add(o.id === gk0.id ? 'sweep_gk' : o.team === 0 ? 'sweep_mate' : 'sweep_them'); }
    if (m.ball.owner >= 0 && m.ball.owner !== prevOwnerB) {
      const o = m.players[m.ball.owner];
      if (o.team === 0 && o.runLane === 7 && o.aiRunUntil > m.time - 0.3) add('blindRecv');
      if (o.team === 0 && o.runLane === 6 && o.aiRunUntil > m.time - 0.3) add('run6Recv');
    }
    sweeping = gk0.aiIntent === 'sweep';
    if (m.ball.owner === gk0.id && prevOwnerB !== gk0.id && m.ball.state === 'dribble' && !m.inPenaltyArea(0, gk0.pos)) add('gkWonOutside');
    if (m.ball.owner >= 0 && m.ball.owner !== prevOwnerB && m.time - secondAt < 4 && (m.ball.state === 'dribble' || m.ball.state === 'held')) { add(m.players[m.ball.owner].team === 0 ? 'second_us' : 'second_them'); secondAt = -99; }
    if (prevOwnerB === gk0.id && m.ball.owner >= 0 && m.players[m.ball.owner].team === 1) add('gkLost');
    prevOwnerB = m.ball.owner;
    const own = m.ball.owner;
    // Turnovers and how quickly the human's team wins the ball back (counter-press).
    if (own >= 0 && m.players[own].team !== ownTeam && m.ball.state !== 'held') {
      const t = m.players[own].team;
      if (t === 1 && ownTeam === 0) { add('turnovers'); lostAt = m.time; lostX = m.ball.pos.x * m.attackDir(0); progDone = false; }
      if (t === 0 && ownTeam === 1 && m.time - lostAt < 5) add('wonBack5s');
      if (t === 0 && ownTeam === 1 && m.time - lostAt < 3) add('wonBack3s');
      ownTeam = t;
    }
    // How far the opponents carried it towards our goal in the 4 s after winning it.
    if (!progDone && m.time - lostAt > 4) { progDone = true; add('prog4s', Math.round(lostX - m.ball.pos.x * m.attackDir(0))); }
    if (own >= 0 && lastKick && own !== lastKick.kicker) {
      const ok = m.players[own].team === 0;
      add(`${lastKick.kind}_${ok ? 'ok' : 'lost'}`);
      if (ok) add('recvMs', Math.round((m.time - lastKick.t) * 1000));
      if (!ok) {
        const rc = lastKick.recv >= 0 ? m.players[lastKick.recv] : null;
        const dR = rc ? Math.hypot(rc.pos.x - m.ball.pos.x, rc.pos.z - m.ball.pos.z) : 99;
        const dK = Math.hypot(lastKick.from.x - m.ball.pos.x, lastKick.from.z - m.ball.pos.z);
        add(rc ? (dR < 2.5 ? 'lost_atReceiver' : dK < 4 ? 'lost_nearKicker' : 'lost_inLane') : 'lost_intoSpace');
      }
      lastKick = null;
    }
    for (const e of m.drainEvents()) {
      if (e.type === 'kick' && e.player !== undefined && m.players[e.player as number].team === 0 && lastCmd === e.player && (e.text === 'pass' || e.text === 'through')) { lastKick = { kind: 'hpass', kicker: e.player as number, recv: m.ball.receiver, from: { ...m.players[e.player as number].pos }, t: m.time }; lastCmd = -1; }
      if (e.type === 'kick' && e.text === 'shot' && m.players[e.player as number].team === 0) { add('hshots'); lastShotT = m.time; }
      if (e.type === 'kick' && e.text === 'shot' && m.players[e.player as number].team === 1 && m.time - lostAt < 10) add('aiShotAfterTurnover10s');
      if (e.type === 'goal') add(e.team === 0 ? 'hgoals' : 'aigoals');
      if (e.type === 'goal' && e.team === 1 && m.time - cornerAt < 10) add('aiGoalsSetPiece');
      if (e.type === 'block') add(e.team === 0 ? 'blocksH' : 'blocksAI');
      if (e.type === 'restart' && (e.text === 'corner' || e.text === 'freekick') && e.team === 1) cornerAt = m.time;
      if (e.type === 'kick' && (e.text === 'header' || e.text === 'clear')) secondAt = m.time;
      if (e.type === 'switch' && e.team === 0) {
        add('switches');
        if (e.player === lastSw.from && m.time - lastSw.t < 1.5) add('switchBack');
        lastSw = { from: lastSw.to, to: e.player as number, t: m.time };
      }
      if (e.type === 'kick' && e.text === 'shot' && m.players[e.player as number].team === 1 && m.time - sweepAt < 6) add('sweepShotAgainst');
      if (e.type === 'goal' && e.team === 1 && m.time - sweepAt < 8) add('sweepGoalAgainst');
      if (e.type === 'call' && e.team === 0 && e.text?.startsWith('link:')) add(e.text);
      if (e.type === 'kick' && e.text === 'shot' && m.players[e.player as number].team === 1) {
        const k = m.players[e.player as number];
        const dG = Math.hypot(k.pos.x - m.ownGoalX(0), k.pos.z);
        add(dG < 12 ? 'aiShots_lt12' : dG < 18 ? 'aiShots_12_18' : 'aiShots_far');
        if (m.time - cornerAt < 8) add('aiShotsSetPiece');
      }
      if (e.type === 'kick' && m.players[e.player as number]?.role === 'GK' && m.players[e.player as number].team === 0 && m.ball.state === 'flight') add(`gk_${e.text}`);
      if (e.type === 'kick' && e.player !== undefined && m.players[e.player as number].team === 0 && lastCmd === e.player && m.ball.receiver >= 0 && (m.players[m.ball.receiver].role === 'LB' || m.players[m.ball.receiver].role === 'RB') && (m.ball.pos.x * m.attackDir(0)) > 0) add('hpassToFBattHalf');
    }
  }
  add('matches');
  add('onTargetH', m.stats[0].onTarget); add('passesH', m.stats[0].passes); add('passesOkH', m.stats[0].passesCompleted);
  add('aiShots', m.stats[1].shots); add('aiPasses', m.stats[1].passes); add('aiPassesOk', m.stats[1].passesCompleted);
}
const r = (a: number, b: number) => +(100 * a / Math.max(1, b)).toFixed(1);
console.log(JSON.stringify({ ...out, advance4s: +((out.prog4s ?? 0) / Math.max(1, out.turnovers ?? 1)).toFixed(2), wonBack5Pct: r(out.wonBack5s ?? 0, out.turnovers ?? 0), myPassPct: r(out.hpass_ok ?? 0, (out.hpass_ok ?? 0) + (out.hpass_lost ?? 0)), teamPassPct: r(out.passesOkH, out.passesH), aiPassPct: r(out.aiPassesOk, out.aiPasses), onTargetPct: r(out.onTargetH, out.hshots), goalsPerShot: r(out.hgoals ?? 0, out.hshots), recvMsAvg: Math.round((out.recvMs ?? 0) / Math.max(1, out.hpass_ok ?? 1)), fwdOpenAvg: +((out.fwdOpen ?? 0) / Math.max(1, out.optSamples ?? 1)).toFixed(2), fwdRunningAvg: +((out.fwdRunning ?? 0) / Math.max(1, out.optSamples ?? 1)).toFixed(2) }));
