import { describe, expect, it } from 'vitest';
import { cleanName, parseClientMsg } from '../src/shared/protocol';

describe('protocol validation', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMsg('{"t":"hello","v":1}')).toMatchObject({ t: 'hello', v: 1 });
    expect(parseClientMsg('{"t":"join","code":"abc23","name":"Sam"}')).toEqual({ t: 'join', code: 'ABC23', name: 'Sam' });
    expect(parseClientMsg('{"t":"in","f":[{"seq":4,"mx":0.5,"mz":-1,"sprint":true,"jockey":false,"ev":[{"k":"shoot","p":0.7}]}]}')).toMatchObject({ t: 'in' });
  });
  it('rejects malformed, oversized or out-of-range input', () => {
    for (const raw of [
      'not json', '[]', '{"t":"nope"}', '{"t":"in","f":[]}',
      '{"t":"in","f":[{"seq":1,"mx":3,"mz":0,"ev":[]}]}', // movement beyond unit range
      '{"t":"in","f":[{"seq":1,"mx":0,"mz":0,"ev":[{"k":"teleport"}]}]}',
      '{"t":"in","f":[{"seq":1,"mx":0,"mz":0,"ev":[{"k":"shoot","p":5}]}]}',
      '{"t":"in","f":[{"seq":1,"mx":0,"mz":0,"ev":[{"k":"pass"},{"k":"pass"},{"k":"pass"},{"k":"pass"},{"k":"pass"}]}]}',
      '{"t":"lobby","club":"FAKE"}', '{"t":"lobby","minutes":7}', '{"t":"rematch","want":"yes"}',
      '{"t":"ping","c":"x"}',
    ]) expect(parseClientMsg(raw), raw).toBeNull();
  });
  it('drops anything that is not an intention (no score, position or state fields survive)', () => {
    const m = parseClientMsg('{"t":"in","f":[{"seq":1,"mx":0,"mz":0,"ev":[],"score":[9,0],"pos":{"x":50}}],"score":[9,0]}');
    expect(JSON.stringify(m)).not.toContain('score');
    expect(JSON.stringify(m)).not.toContain('pos');
  });
  it('ignores malformed reconnect tokens', () => {
    expect(parseClientMsg('{"t":"hello","v":1,"token":"../../etc"}')).toMatchObject({ token: undefined });
  });
  it('sanitises display names', () => {
    expect(cleanName('<script>alert(1)</script>')).toBe('scriptalert1scri');
    expect(cleanName('')).toBe('Player');
    expect(cleanName('Zoë O’Neil')).toBe('Zoë ONeil');
  });
});
