import { describe, expect, it } from 'vitest';
import { isSoftwareRenderer, lowerGraphics, SlowGuard, softwareGraphics, type SlowSettings } from '../src/client/render/slowguard';

const settings = (): SlowSettings => ({ graphics: { preset: 'high', renderScale: 1, shadows: true }, menuBackdrop: true, matchIntro: true });

describe('slow graphics guard', () => {
  it('asks to lower graphics at about 1 frame a second, after the scene settles', () => {
    const g = new SlowGuard(); g.rearm(1);
    let t = 1, asked = -1;
    for (let i = 0; i < 20 && asked < 0; i++) { t += 1000; if (g.feed(1000, t)) asked = t; }
    expect(asked).toBeGreaterThan(4000);
    expect(asked).toBeLessThan(12000);
  });
  it('leaves a smooth game alone', () => {
    const g = new SlowGuard(); g.rearm(1);
    let t = 1;
    for (let i = 0; i < 2000; i++) { t += 16.7; expect(g.feed(16.7, t)).toBe(false); }
  });
  it('steps down in order and stops when nothing is left', () => {
    const s = settings();
    const steps: string[] = [];
    for (let i = 0; i < 10; i++) { const r = lowerGraphics(s); if (!r) break; steps.push(r); }
    expect(steps).toEqual(['Quality is now Medium', 'Quality is now Low', 'Resolution is now 70%', 'Resolution is now 50%', 'The live menu stadium and match intro are off']);
    expect(s.graphics.preset).toBe('low');
  });
  it('spots software drawing', () => {
    expect(isSoftwareRenderer('Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver')).toBe(true);
    expect(isSoftwareRenderer('Microsoft Basic Render Driver Direct3D11')).toBe(true);
    expect(isSoftwareRenderer('Intel, Intel(R) Iris(R) Plus Graphics Direct3D11, D3D11')).toBe(false);
    const s = settings(); softwareGraphics(s);
    expect(s).toEqual({ graphics: { preset: 'low', renderScale: 0.5, shadows: false }, menuBackdrop: false, matchIntro: false });
  });
});
