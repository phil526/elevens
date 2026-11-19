// Recorded sound effects: every file the audio code asks for is shipped, small, and credited.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/client/audio/audio';

describe('sound effect files', () => {
  const licences = readFileSync('public/third-party-licences.txt', 'utf8');
  const assets = readFileSync('docs/ASSETS.md', 'utf8');
  for (const file of Object.values(SAMPLES)) {
    it(`${file} is shipped, under 700 KB and credited`, () => {
      const path = `public/sfx/${file}`;
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeLessThan(700 * 1024);
      expect(licences).toContain(`${file}:`);
      expect(assets).toContain(`\`${file}\``);
    });
  }
  it('all the sounds together stay under 2 MB', () => {
    const total = Object.values(SAMPLES).reduce((n, f) => n + statSync(`public/sfx/${f}`).size, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});
