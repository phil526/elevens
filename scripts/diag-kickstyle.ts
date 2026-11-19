// How often each kick style (toe poke, outside of the boot, backheel) would show in AI matches.
import { Match, defaultConfig } from '../src/shared/match';
import { kickFlavourFor, relAngle } from '../src/client/render/motion';
import { footProfile } from '../src/shared/teams';
const n: Record<string, number> = {};
const R: Record<string, number[]> = {};
for (let seed = 1; seed <= 3; seed++) {
  const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
  const seen = new Set<object>();
  while (m.phase !== 'fulltime') {
    m.step(); if (m.phase === 'halftime') m.continueAfterHalftime(); m.events = [];
    for (const p of m.players) {
      const a = p.action as any;
      if (a.type !== 'kick' || seen.has(a)) continue;
      seen.add(a);
      const rc = a.receiver >= 0 ? m.players[a.receiver] : null;
      const aim = a.target ?? (rc ? rc.pos : a.dir && (a.dir.x || a.dir.z) ? { x: p.pos.x + a.dir.x * 10, z: p.pos.z + a.dir.z * 10 } : a.kind === 'shot' ? { x: m.attackDir(p.team) * 52.5, z: 0 } : null);
      const ang = aim ? relAngle(p.facing, aim.x - p.pos.x, aim.z - p.pos.z) : 0;
      const b = m.ball;
      const gx = Math.sign(p.pos.x || 1) * 52.5;
      const f = kickFlavourFor({ kind: a.kind, angle: ang, strong: footProfile(p.def).foot === 1 ? 1 : -1, reach: Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z), goalDist: Math.hypot(gx - p.pos.x, p.pos.z), ballY: b.pos.y, seed: (p.id * 7 + Math.floor(Math.abs(b.pos.x) * 13)) % 6 });
      const k = `${a.kind}:${f.flavour ?? "normal"}`; n[k] = (n[k] ?? 0) + 1;
      (R[a.kind] ??= []).push(Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z));
    }
  }
}
console.log(n);
for (const k in R) { const r = R[k].sort((a, b) => a - b); console.log(k, [0.25, 0.5, 0.75, 0.9, 0.97].map((q) => r[Math.floor(q * (r.length - 1))].toFixed(2)).join(" ")); }
