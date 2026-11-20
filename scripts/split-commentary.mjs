// Cuts the recorded commentator batches into one file per line (20 Nov 2026).
// Each Higgsfield text-to-speech request read about five lines from src/client/audio/commentary.ts;
// pauses inside a line ("Off the bar! So close!") can be as long as the gaps between lines, so the
// cut points are the set of pauses whose pieces best match how long each line should take to say
// (syllables), with longer pauses preferred. Prints each piece's length against its expected length.
// Usage: node scripts/split-commentary.mjs <folder with c0.mp3 ... c10.mp3>
//        (writes public/sfx/cm/<kind>-<n>.mp3; batches are listed in scripts/commentary-batches.json)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/split-commentary.mjs <folder>'); process.exit(1); }
const batches = JSON.parse(readFileSync(new URL('./commentary-batches.json', import.meta.url), 'utf8'));
const OUT = 'public/sfx/cm';
mkdirSync(OUT, { recursive: true });

const syllables = (t) => t.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  .reduce((n, w) => n + Math.max(1, (w.replace(/e$/, '').match(/[aeiouy]+/g) ?? []).length), 0);
// Sentence breaks inside a line take time too.
const weight = (t) => syllables(t) + 1.5 * ((t.match(/[.!?,]\s/g) ?? []).length);

const run = (args) => execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

function* combos(n, k, start = 0, pick = []) {
  if (pick.length === k) { yield pick; return; }
  for (let i = start; i <= n - (k - pick.length); i++) yield* combos(n, k, i + 1, [...pick, i]);
}

let worst = 0;
for (const b of batches) {
  const file = join(dir, `c${b.n}.mp3`);
  const dur = duration(file);
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-40dB:d=0.1', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const sil = [];
  for (const m of log.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)) sil.push({ s: Number(m[1]) - Number(m[2]), e: Number(m[1]) });
  // A trailing silence with no end line runs to the end of the file.
  const head = sil.length && sil[0].s < 0.05 ? sil.shift().e : 0;
  const lastStart = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])).pop();
  const tail = lastStart !== undefined && lastStart > (sil.at(-1)?.e ?? 0) ? lastStart : dur;
  const inner = sil.filter((x) => x.s > head && x.e < tail);
  const w = b.lines.map((l) => weight(l.t));
  const need = b.lines.length - 1;
  if (inner.length < need) throw new Error(`c${b.n}: only ${inner.length} pauses for ${b.lines.length} lines`);
  let best = null;
  for (const pick of combos(inner.length, need)) {
    const cuts = pick.map((i) => inner[i]);
    const segs = [];
    let from = head;
    for (const c of cuts) { segs.push(c.s - from); from = c.e; }
    segs.push(tail - from);
    const rate = segs.reduce((a, x) => a + x, 0) / w.reduce((a, x) => a + x, 0);
    const fit = segs.reduce((a, x, i) => a + ((x - rate * w[i]) / (rate * w[i])) ** 2, 0);
    const pause = cuts.reduce((a, c) => a + (c.e - c.s), 0) / need;
    const cost = fit - 0.6 * pause;
    if (!best || cost < best.cost) best = { cost, cuts, segs, rate };
  }
  let from = head;
  const bounds = [...best.cuts.map((c) => [c.s, c.e]), [tail, tail]];
  b.lines.forEach((l, i) => {
    const a = Math.max(0, from - 0.04), z = Math.min(dur, bounds[i][0] + 0.12);
    const out = join(OUT, `${l.k}-${l.i + 1}.mp3`);
    run(['-y', '-hide_banner', '-ss', a.toFixed(3), '-t', (z - a).toFixed(3), '-i', file, '-af', `afade=t=in:d=0.02,afade=t=out:st=${(z - a - 0.06).toFixed(3)}:d=0.06`, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '4', out]);
    const want = best.rate * w[i];
    const off = Math.abs(best.segs[i] - want) / want;
    worst = Math.max(worst, off);
    console.log(`c${b.n} ${`${l.k}-${l.i + 1}`.padEnd(12)} ${best.segs[i].toFixed(2)}s (expected ${want.toFixed(2)}s${off > 0.35 ? ', CHECK' : ''})  ${l.t}`);
    from = bounds[i][1];
  });
}
console.log(`\nworst length mismatch ${(worst * 100).toFixed(0)}%`);
