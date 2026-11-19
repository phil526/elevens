import { describe, expect, it } from 'vitest';
import { ReplayRecorder } from '../src/client/render/cinematic';
import { MatchViewBuilder } from '../src/client/view';
import { HIGHLIGHTS, HighlightBook, pickReel, type MomentKind } from '../src/client/highlights';
import { aiMatch } from './helpers';

/** 30 seconds of recorded AI play at 60 fps. */
function recording() {
  const m = aiMatch();
  const b = new MatchViewBuilder(m);
  const rec = new ReplayRecorder(40, 1 / 40);
  for (let i = 0; i < 30 * 60; i++) {
    m.step();
    rec.push(b.build(1), i / 60);
  }
  return rec;
}

const info = (kind: MomentKind, half = 1) => ({ kind, team: 0, who: 'Test', minute: "12'", half });

describe('highlights', () => {
  it('cuts a clip around each moment once its last seconds have been played', () => {
    const rec = recording();
    const book = new HighlightBook();
    book.add(info('save'), 10);
    book.capture(rec, 10 + HIGHLIGHTS.after - 0.1);
    expect(book.list).toHaveLength(0); // still waiting for the follow-up
    book.capture(rec, 10 + HIGHLIGHTS.after);
    expect(book.list).toHaveLength(1);
    const c = book.list[0].clip;
    expect(c.first).toBeGreaterThanOrEqual(10 - HIGHLIGHTS.before - 0.03);
    expect(c.last).toBeLessThanOrEqual(10 + HIGHLIGHTS.after + 0.03);
    expect(c.at(10)!.players.length).toBeGreaterThan(10);
  });

  it('merges a save and the rebound goal into one goal clip', () => {
    const rec = recording();
    const book = new HighlightBook();
    book.add(info('save'), 8);
    book.add(info('chance'), 9); // smaller moment straight after: ignored
    book.capture(rec, 8 + HIGHLIGHTS.after); // the save is cut...
    book.add(info('goal'), 11); // ...then the rebound goes in
    book.capture(rec, 11 + HIGHLIGHTS.goalAfter);
    expect(book.list.map((h) => h.kind)).toEqual(['goal']);
    expect(book.list[0].clip.first).toBeLessThan(8 - HIGHLIGHTS.before + 0.1); // keeps the build-up to the save
    expect(book.list[0].clip.last - book.list[0].clip.first).toBeLessThanOrEqual(HIGHLIGHTS.maxClip + 0.05);
  });

  it('cuts waiting moments at the break and keeps each half apart', () => {
    const rec = recording();
    const book = new HighlightBook();
    book.add(info('goal', 1), 6);
    book.add(info('woodwork', 2), 20);
    book.capture(rec, 20.5, true);
    expect(book.reel('half', 1).map((h) => h.kind)).toEqual(['goal']);
    expect(book.reel('half', 2).map((h) => h.kind)).toEqual(['woodwork']);
    expect(book.reel('match', 2)).toHaveLength(2);
  });

  it('keeps every goal and the best other moments, in match order', () => {
    const all = [
      { kind: 'chance' as const, t: 1 }, { kind: 'goal' as const, t: 2 }, { kind: 'save' as const, t: 3 },
      { kind: 'chance' as const, t: 4 }, { kind: 'woodwork' as const, t: 5 }, { kind: 'goal' as const, t: 6 },
    ];
    expect(pickReel(all, 4).map((h) => h.t)).toEqual([2, 3, 5, 6]);
    expect(pickReel(all, 1).map((h) => h.t)).toEqual([2, 6]); // goals are never dropped
  });
});
