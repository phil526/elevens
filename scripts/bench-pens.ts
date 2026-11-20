// Penalty figures (20 Nov 2026): `npx tsx scripts/bench-pens.ts [count] [mode]`.
// mode: ai (computer v computer), commit-right / commit-wrong / commit-early / tall (a scripted
// human keeper), stutter / panenka / blast / placed (a scripted human taker against the computer keeper).
import { Match, defaultConfig } from '../src/shared/match';
import { PITCH } from '../src/shared/config';
import { SP_ON } from '../src/shared/setpieces';
import type { InputFrame, InputEvent } from '../src/shared/types';

const count = Number(process.argv[2] ?? 300);
const mode = process.argv[3] ?? 'ai';
if (process.env.SP_OFF) for (const k of process.env.SP_OFF.split(',')) (SP_ON as Record<string, boolean>)[k] = false;
const out: Record<string, number> = {};
const add = (k: string, n = 1) => { out[k] = (out[k] ?? 0) + n; };
const humanKeeper = mode.startsWith('commit') || mode === 'tall' || mode === 'dance';
const humanTaker = ['stutter', 'panenka', 'blast', 'placed', 'plain'].includes(mode);
let seq = 0;
const frame = (mz: number, ev: InputEvent[] = []): InputFrame => ({ seq: ++seq, mx: 0, mz, sprint: false, jockey: false, ev });
for (let i = 0; i < count; i++) {
  const m = new Match(defaultConfig({ humans: [humanTaker, humanKeeper], realMinutes: 6, seed: 5000 + i }));
  m.phase = 'play';
  const dir = m.attackDir(0);
  const any = m as unknown as { award: (t: string, team: number, spot: { x: number; z: number }) => void };
  any.award('penalty', 0, { x: dir * (PITCH.halfLength - PITCH.penaltySpot), z: 0 });
  const g0 = m.score[0];
  let struck = -1, committed = false, kicked = false;
  const aimSide = (i % 2) * 2 - 1;
  for (let t = 0; t < 60 * 14; t++) {
    const r = m.restart;
    if (humanTaker && r?.ready && !kicked) {
      // Aim, then shoot at the smallest ring.
      const ev: InputEvent[] = [];
      const want = aimSide * 2.3;
      const mz = mode === 'panenka' ? 0 : Math.abs(r.aim.z - want) > 0.2 ? Math.sign(want - r.aim.z) : 0;
      if (mode === 'stutter' && r.readyT > 0.2 && !r.stutter) ev.push({ k: 'skill' });
      const q = Math.abs(Math.cos((Math.PI * r.readyT) / 1.4));
      if (r.readyT > 0.8 && q < 0.08 && mz === 0) {
        ev.push(mode === 'panenka' ? { k: 'shoot', p: 0.5, v: 'chip' } : mode === 'blast' ? { k: 'shoot', p: 0.85, m: true, v: 'power' } : mode === 'placed' ? { k: 'shoot', p: 0.7, v: 'placed' } : { k: 'shoot', p: 0.75 });
        kicked = true;
      }
      m.applyInput(0, frame(mz, ev));
    }
    if (humanKeeper && r?.ready && !committed) {
      // Scripted keeper: commit when the taker is this far into his run-up.
      const runup = r.runup;
      const lead = mode === 'commit-early' ? 0.0 : 0.3;
      if (runup && runup.t > lead) {
        // commit-right: guess the side the computer taker aimed at; commit-wrong: the other side.
        const z = runup.req.target?.z ?? 0;
        const s = Math.sign(z) || 1;
        const side = mode === 'tall' ? 0 : mode === 'commit-wrong' ? -s : s;
        m.applyInput(1, frame(side, [{ k: 'shoot', p: 0.4 }]));
        committed = true;
      } else m.applyInput(1, frame(mode === 'dance' ? Math.sin(t * 0.3) : 0));
    }
    m.step();
    if (struck < 0 && m.penKickTime > 0) { struck = m.time; add(`tech_${m.penTech}`); if (m.restart?.stutter) add('stutter'); }
    if (struck >= 0 && (m.score[0] !== g0 || m.time - struck > 3 || (m.ball.state === 'held') || m.restart)) break;
  }
  add('pens');
  if (m.score[0] !== g0) { add('goals'); add(`goal_${m.penTech}`); }
}
out.rate = Math.round((1000 * (out.goals ?? 0)) / out.pens) / 10;
console.log(mode, JSON.stringify(out));
