import { describe, expect, it } from 'vitest';
import { applySave, collectSave, describeSave, isBundle, packSave, unpackSave, TRANSFER_CODE_RE, cleanCode, transferUrl } from '../src/client/transfer';
import { TransferStore } from '../src/server/transfer';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('moving saves between devices', () => {
  const pc = () => mem({
    'elevens.profiles.v1': JSON.stringify({ active: 0, slots: [{ name: 'Phil', stats: { played: 41 } }, null, null] }),
    'elevens.modes.v1.0': JSON.stringify({ v: 1, career: { club: 'x' } }),
    'elevens.settings.v1': JSON.stringify({ graphics: { preset: 'ultra' }, controls: { k: 'pc' }, name: 'Phil' }),
    'elevens.token': 'seat', 'elevens.glsafe.v1': '{}', 'elevens.menuopen.v1': '{}', 'other.app': 'x',
  });

  it('collects only the keys that travel', () => {
    const b = collectSave(pc());
    expect(Object.keys(b.data).sort()).toEqual(['elevens.modes.v1.0', 'elevens.profiles.v1', 'elevens.settings.v1']);
    expect(isBundle(b)).toBe(true);
    expect(describeSave(b)).toContain('profile Phil');
    expect(describeSave(b)).toContain('41 matches');
    expect(describeSave(b)).toContain('a career');
  });

  it('packs and unpacks (compressed) without losing anything', async () => {
    const b = collectSave(pc());
    const text = await packSave(b);
    expect(text.startsWith('EV1Z.') || text.startsWith('EV1J.')).toBe(true);
    expect(text).toMatch(/^EV1[ZJ]\.[A-Za-z0-9_-]+$/);
    expect(await unpackSave(text)).toEqual(b);
    expect(await unpackSave(JSON.stringify(b))).toEqual(b);
    await expect(unpackSave('hello')).rejects.toThrow();
  });

  it('loads into another device but keeps that device graphics and its own device keys', () => {
    const b = collectSave(pc());
    const phone = mem({
      'elevens.settings.v1': JSON.stringify({ graphics: { preset: 'low' }, controls: { k: 'phone' }, tabletMedium: true }),
      'elevens.modes.v1.2': '{"old":true}', 'elevens.glsafe.v1': 'phone-gl',
    });
    applySave(b, phone);
    const s = JSON.parse(phone.getItem('elevens.settings.v1')!);
    expect(s.graphics.preset).toBe('low');
    expect(s.controls.k).toBe('pc');
    expect(s.tabletMedium).toBe(true);
    expect(phone.getItem('elevens.modes.v1.2')).toBeNull();
    expect(phone.getItem('elevens.glsafe.v1')).toBe('phone-gl');
    expect(JSON.parse(phone.getItem('elevens.profiles.v1')!).slots[0].name).toBe('Phil');
  });

  it('codes are six unambiguous characters and the server keeps them for a while', () => {
    let t = 0;
    const store = new TransferStore(() => t);
    const code = store.put('EV1J.abc')!;
    expect(TRANSFER_CODE_RE.test(code)).toBe(true);
    expect(store.get(code)).toBe('EV1J.abc');
    t += 29 * 60_000;
    expect(store.get(code)).toBe('EV1J.abc');
    t += 2 * 60_000;
    expect(store.get(code)).toBeNull();
    expect(cleanCode(' k7q-2mx ')).toBe('K7Q2MX');
    expect(transferUrl('wss://a.b/ws', 'K7Q2MX')).toBe('https://a.b/transfer/K7Q2MX');
  });
});
