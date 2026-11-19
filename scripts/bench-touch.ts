// Close-control benchmark for a human player: receiving passes of different pace with different
// stick/sprint inputs, with one defender closing in, then dribbling on. Counts how often the
// ball is still under control 1.5 s after it arrives, and how far it ran from the feet.
// Usage: npx tsx scripts/bench-touch.ts
import { Match, defaultConfig } from '../src/shared/match';
import type { Player } from '../src/shared/types';

let seq = 1;
type In = { mx: number; mz: number; sprint: boolean };
function trial(seed: number, speed: number, input: In, defender: boolean) {
  const m = new Match(defaultConfig({ humans: [true, false], realMinutes: 6, seed }));
  for (let i = 0; i < 600 && m.phase !== 'play'; i++) m.step();
  const p = m.teamPlayers(0).find((x) => x.role === 'ST')!;
  const mate = m.teamPlayers(0).find((x) => x.role !== 'ST' && x.role !== 'GK')!;
  const def = m.teamPlayers(1).find((x) => x.role === 'RCB' || x.role === 'LCB')!;
  m.ctrl[0].pid = p.id; m.ctrl[0].autoSwitch = false;
  const reset = (q: Player, x: number, z: number) => { q.pos = { x, z }; q.vel = { x: 0, z: 0 }; q.action = { type: 'none', t: 0, dur: 0 } as Player['action']; q.queued = null; q.touchCooldown = 0; };
  reset(p, 10, 0); p.facing = Math.PI; p.stamina = 1;
  reset(mate, -10, 0);
  reset(def, 17 + (seed % 3), (seed % 5) - 2);
  const b = m.ball;
  b.pos = { x: -8, y: 0.11, z: 0 }; b.vel = { x: speed, y: 0, z: 0 }; b.spin = 0;
  b.state = 'flight'; b.flight = 'pass'; b.owner = -1; b.receiver = p.id; b.kicker = mate.id; b.lastTouch = mate.id; b.lastTouchTeam = 0; b.kickLock = 0;
  const park = () => { for (const q of m.players) if (q !== p && (!defender || q !== def)) { q.pos = { x: q.team ? 48 : -48, z: (q.id % 11) * 6 - 30 }; q.vel = { x: 0, z: 0 }; } };
  let tArr = -1, maxSep = 0, firstSep = 0, lost = false;
  for (let i = 0; i < 60 * 5; i++) {
    // Hands off until the ball is close, then the stick/sprint as the touch is taken and after.
    const live = tArr >= 0 || Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z) < 2.5;
    m.applyInput(0, { seq: seq++, mx: live ? input.mx : 0, mz: live ? input.mz : 0, sprint: live && input.sprint, jockey: false, contain: false, ev: [] });
    park(); m.step(); m.drainEvents();
    if (tArr < 0 && b.owner === p.id) tArr = m.time;
    if (tArr >= 0) {
      const sep = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      maxSep = Math.max(maxSep, sep);
      if (m.time - tArr < 0.6) firstSep = Math.max(firstSep, sep);
      if (b.owner !== p.id && !((b.state as string) === 'free' && b.kicker === p.id && sep < 2.5)) lost = true;
      if (m.time - tArr > 1.5) break;
    }
  }
  if (tArr < 0) lost = true;
  return { arrived: tArr >= 0, kept: tArr >= 0 && !lost, maxSep, firstSep };
}

const inputs: Record<string, In> = {
  none: { mx: 0, mz: 0, sprint: false },
  onward: { mx: 1, mz: 0, sprint: false },
  side: { mx: 0, mz: 1, sprint: false },
  back: { mx: -1, mz: 0, sprint: false },
  onwardSprint: { mx: 1, mz: 0, sprint: true },
  sideSprint: { mx: 0.7, mz: 0.7, sprint: true },
};
const out: Record<string, unknown> = {};
let allK = 0, allN = 0;
for (const def of [false, true]) for (const [name, inp] of Object.entries(inputs)) for (const sp of [10, 14, 18]) {
  let k = 0, n = 0, ms = 0, fs = 0;
  for (let s = 1; s <= 30; s++) { const r = trial(s, sp, inp, def); n++; if (r.kept) k++; ms += r.maxSep; fs += r.firstSep; }
  allK += k; allN += n;
  out[`${def ? 'pressed' : 'free'} ${name} ${sp}`] = { kept: `${Math.round((100 * k) / n)}%`, firstSep: +(fs / n).toFixed(2), maxSep: +(ms / n).toFixed(2) };
}
console.table(out);
console.log('overall kept', ((100 * allK) / allN).toFixed(1) + '%');
