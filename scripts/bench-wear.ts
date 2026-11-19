// Plays an AI match headless and feeds every view into the pitch and kit wear, then reports how
// worn the pitch is and how muddy/sweaty kits got, and writes the wear map as a PNG.
// Usage: npx tsx scripts/bench-wear.ts [seed] [wet 0..1] [out.png]
import { writeFileSync } from 'node:fs';
// @ts-ignore pngjs has no type declarations here
import { PNG } from 'pngjs';
import { Match, defaultConfig } from '../src/shared/match';
import { MatchViewBuilder } from '../src/client/view';
import { KitWear, PitchWear, WEAR_H, WEAR_W } from '../src/client/render/wear';
import { SIM } from '../src/shared/config';

const seed = Number(process.argv[2] ?? 3), wet = Number(process.argv[3] ?? 0), out = process.argv[4] ?? 'scripts/out/wear-map.png';
const m = new Match(defaultConfig({ humans: [false, false], realMinutes: 6, seed }));
const vb = new MatchViewBuilder(m);
const pw = new PitchWear(), kw = new KitWear();
let steps = 0;
while (m.phase !== 'fulltime' && steps < 60 * 60 * 9) {
  if (m.phase === 'halftime') m.continueAfterHalftime();
  m.step();
  vb.capture();
  const v = vb.build(1);
  pw.update(v, SIM.dt, wet);
  kw.update(v, SIM.dt, wet, pw);
  steps++;
}
const acc = (pw as unknown as { acc: Float32Array }).acc;
let sum = 0, over = [0, 0, 0], mud = 0;
for (let i = 0; i < WEAR_W * WEAR_H; i++) { const w = acc[i * 2]; sum += w; if (w > 0.1) over[0]++; if (w > 0.3) over[1]++; if (w > 0.6) over[2]++; mud += acc[i * 2 + 1]; }
const cells = WEAR_W * WEAR_H;
console.log(`steps ${steps} mean wear ${(sum / cells).toFixed(3)}  >0.1 ${(100 * over[0] / cells).toFixed(1)}%  >0.3 ${(100 * over[1] / cells).toFixed(1)}%  >0.6 ${(100 * over[2] / cells).toFixed(1)}%  mean mud ${(mud / cells).toFixed(3)}`);
const st = kw.state.map((s, i) => `${i}:${s.mud.toFixed(2)}/${s.sweat.toFixed(2)}`);
console.log('kits mud/sweat', st.join(' '));
const png = new PNG({ width: WEAR_W, height: WEAR_H });
for (let i = 0; i < cells; i++) { png.data[i * 4] = Math.round(acc[i * 2] * 255); png.data[i * 4 + 1] = Math.round(acc[i * 2 + 1] * 255); png.data[i * 4 + 2] = 40; png.data[i * 4 + 3] = 255; }
writeFileSync(out, PNG.sync.write(png));
