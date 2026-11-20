// Gameplay balance figures over many AI-v-AI matches:
// `npx tsx scripts/bench-features.ts [firstSeed] [count] [diffA] [diffB]`.
// Prints one JSON line: goals, shots by distance, passing, fouls, cards, advantages,
// slide tackles, skill moves, penalties and results by side (for difficulty checks).
import { Match, defaultConfig } from '../src/shared/match';
import type { Difficulty } from '../src/shared/config';
import { bcOff, g6Off } from '../src/shared/switches';
// BC_OFF=attr,heavy,... turns the 19 Nov 2026 ball-control features off to compare.
bcOff(process.env.BC_OFF);
import { CLUB_STYLES, type PlayStyle } from '../src/shared/playstyle';
g6Off(process.env.G6_OFF);
// STYLE_A / STYLE_B: play the two default clubs with another style (balance checks).
if (process.env.STYLE_A) CLUB_STYLES.redmoor = process.env.STYLE_A as PlayStyle;
if (process.env.STYLE_B) CLUB_STYLES.kestrel = process.env.STYLE_B as PlayStyle;

const first = Number(process.argv[2] ?? 11), count = Number(process.argv[3] ?? 10);
const dA = (process.argv[4] ?? 'pro') as Difficulty, dB = (process.argv[5] ?? 'pro') as Difficulty;
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
for (let seed = first; seed < first + count; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed, difficulty: [dA, dB] }));
  const slideSeen = new Set<number>();
  let lastShot: { team: number; k: string; t: number } | null = null;
  // Moves: spells of possession by one team; passes per move counts completed passes in each.
  let moveTeam = -1, moveStart = 0, prevOwner = -1;
  let lastKick: { team: number; kind: string; kicker: number } | null = null; // pass outcome by kind
  const closeMove = () => {
    if (moveTeam < 0) return;
    const n = m.stats[moveTeam].passesCompleted - moveStart;
    add('moves'); add('movePasses', n);
    if (n >= 5) add('moves5plus');
  };
  while (m.phase !== 'fulltime') {
    const fkBefore = m.restart?.type === 'freekick' && m.restart.ready;
    m.step();
    if (m.phase === 'halftime') m.continueAfterHalftime();
    const own = m.ball.owner;
    if (own >= 0 && lastKick && own !== lastKick.kicker) {
      add(`${m.players[own].team === lastKick.team ? 'ok' : 'lost'}_${lastKick.kind}`);
      lastKick = null;
    }
    if (own >= 0) {
      const t = m.players[own].team;
      if (prevOwner >= 0 && m.players[prevOwner].team !== t) add('dispossessed');
      if (t !== moveTeam) { closeMove(); moveTeam = t; moveStart = m.stats[t].passesCompleted; }
    }
    prevOwner = own;
    for (const p of m.players) {
      if (p.action.type === 'slide' && p.action.t < 0.02 && !slideSeen.has(m.tick * 100 + p.id)) { slideSeen.add(m.tick * 100 + p.id); add('slides'); }
    }
    for (const e of m.drainEvents()) {
      if (e.type === 'card') add(`card_${e.text}`);
      else if (e.type === 'restart' && (e.text === 'penalty' || e.text === 'freekick' || e.text === 'corner')) add(e.text);
      else if (e.type === 'foul' || e.type === 'advantage' || e.type === 'skill' || e.type === 'goal' || e.type === 'offside') add(e.type + (e.type === 'skill' ? `_${e.text}` : ''));
      if (e.type === 'kick' && (e.text === 'pass' || e.text === 'through' || e.text === 'lob' || e.text === 'cross')) {
        const k = m.players[e.player as number];
        lastKick = { team: k.team, kind: m.ball.flight === 'through' && e.text === 'pass' ? 'space' : e.text, kicker: k.id };
      }
      if (e.type === 'kick' && e.text === 'shot') {
        const p = m.players[e.player as number];
        const d = Math.hypot(p.pos.x - m.attackDir(p.team) * 52.5, p.pos.z);
        const k = d < 12 ? 'lt12' : d < 18 ? '12_18' : d < 24 ? '18_24' : '24p';
        add('shots_' + k);
        add('style_' + ((p.action as { variant?: string }).variant ?? (p.action.placed ? 'finesse' : 'normal')));
        lastShot = { team: p.team, k: fkBefore ? 'fk' : k, t: m.time };
        if (fkBefore) add('shots_fk');
      }
      if (e.type === 'goal' && lastShot && lastShot.team === e.team && m.time - lastShot.t < 4) add('goals_' + lastShot.k);
      // 19 Nov 2026 gameplay: strength battles, aerial duels, tactical fouls, deflections, scrambles, the offside trap, the crowd.
      if (e.type === 'call' && ['hold', 'muscle', 'aerial', 'tactical', 'deflection', 'scramble', 'trapped', 'crowd', 'trap'].includes(e.text ?? '')) add('call_' + e.text);
    }
  }
  closeMove();
  add('matches');
  add('goalsA', m.score[0]); add('goalsB', m.score[1]);
  add(m.score[0] > m.score[1] ? 'winA' : m.score[0] < m.score[1] ? 'winB' : 'draw');
  for (const s of m.stats) { add('passes', s.passes); add('passesOk', s.passesCompleted); add('shots', s.shots); add('onTarget', s.onTarget); }
  add('momentumEnd100', Math.round(Math.abs(m.momentum?.value ?? 0) * 100));
}
console.log(JSON.stringify(out));
