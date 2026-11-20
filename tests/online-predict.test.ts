import { describe, expect, it } from 'vitest';
import { Match, defaultConfig } from '../src/shared/match';
import { encodeSnapshot } from '../src/shared/snapshot';
import { SIM } from '../src/shared/config';
import { OnlineSession, interpTarget, INTERP_MIN_MS, INTERP_MAX_MS } from '../src/client/net/online';
import { signalBars } from '../src/client/game/session';
import type { InputEvent, InputFrame } from '../src/shared/types';

describe('online connection quality', () => {
  it('signal bars fall with a slower or less steady link', () => {
    expect(signalBars(-1, 0, 0)).toBe(0);
    expect(signalBars(30, 4, 0)).toBe(4);
    expect(signalBars(100, 4, 0)).toBe(3);
    expect(signalBars(150, 4, 0)).toBe(2);
    expect(signalBars(300, 4, 0)).toBe(1);
    expect(signalBars(30, 45, 0)).toBe(3);
    expect(signalBars(30, 80, 0.5)).toBe(2);
    expect(signalBars(300, 80, 0.5)).toBe(1);
  });
  it('the interpolation buffer shrinks on a steady link and grows on a patchy one', () => {
    expect(interpTarget(50, 3)).toBeLessThan(80);
    expect(interpTarget(50, 3)).toBeGreaterThanOrEqual(INTERP_MIN_MS);
    expect(interpTarget(55, 30)).toBeGreaterThan(130);
    expect(interpTarget(200, 100)).toBe(INTERP_MAX_MS);
  });
});

/** A session fed with snapshots from a real match, where the human dribbles and presses shoot. */
function setup() {
  const m = new Match(defaultConfig({ humans: [true, false], seed: 3 }));
  // Run until our side has the ball in play.
  for (let i = 0; i < 60 * 60 && !(m.phase === 'play' && m.ball.state === 'dribble' && m.players[m.ball.owner].team === 0); i++) {
    m.step();
    if (m.phase === 'kickoff' && m.phaseT > 1) m.applyInput(0, { seq: i, mx: 1, mz: 0, sprint: false, jockey: false, ev: [{ k: 'pass', p: 0.4 }] });
  }
  m.ctrl[0].pid = m.ball.owner;
  let ev: InputEvent[] = [];
  let seq = 1;
  const actions = { sample: (): InputFrame => { const f = { seq: seq++, mx: 0, mz: 0, sprint: false, jockey: false, ev }; ev = []; return f; }, clear() {} };
  const sent: unknown[] = [];
  const net = { latency: 40, jitter: 2, status: 'connected', send: (x: unknown) => sent.push(x) };
  const s = new OnlineSession({ side: 0, teams: m.cfg.teams, kits: m.cfg.kits, minutes: 6, mentality: ['balanced', 'balanced'] }, net as never, actions as never);
  let now = 1000;
  for (let i = 0; i < 6; i++) { s.push(encodeSnapshot(m, 0, [], false), now); now += 50; }
  s.update(0.2, now);
  return { m, s, press: (k: InputEvent['k']) => { ev = [{ k, p: 0.7 }]; }, now: () => (now += 16), net };
}

describe('online kick prediction', () => {
  it('draws the kick on the controlled player as soon as shoot is pressed', () => {
    const { m, s, press, now } = setup();
    const pid = m.ctrl[0].pid;
    expect(m.ball.owner).toBe(pid);
    expect(s.view()!.players[pid].action.type).toBe('none');
    press('shoot');
    s.update(SIM.dt, now());
    const a = s.view()!.players[pid].action;
    expect(a.type).toBe('kick');
    expect(a.kind).toBe('shot');
    // Never confirmed by the server: dropped again within the confirm window.
    for (let i = 0; i < 40; i++) s.update(SIM.dt, now());
    expect(s.view()!.players[pid].action.type).toBe('none');
  });
});
