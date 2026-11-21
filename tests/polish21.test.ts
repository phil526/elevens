// Polish pass (21 Nov 2026): sound levelling, hit-stop, settings reset, one-time tips, button
// icons, clips per save slot and the local calendar date.
import { describe, expect, it } from 'vitest';
import { LEVEL_TARGET, LINE_TARGET, MIX, levelOf, levelTrim } from '../src/client/audio/audio';
import { HIT_STOP, SLOW_MO, SlowMo } from '../src/client/slowmo';
import { SETTING_DESC, SETTING_SECTIONS, resetSection } from '../src/client/ui/settingsmeta';
import { defaultSettings } from '../src/client/settings';
import { TIPS } from '../src/client/ui/tips';
import { keyCap, padGlyphKind, padKey } from '../src/client/ui/glyphs';
import { clipsOfSlot, type GoalClip } from '../src/client/modes/clips';
import { localDay } from '../src/client/profile';
import { MatchViewBuilder } from '../src/client/view';
import { PITCH } from '../src/shared/config';
import { aiMatch } from './helpers';

describe('sound mix', () => {
  it('measures loudness from the busy part of a recording, ignoring a quiet tail', () => {
    const sr = 1000, d = new Float32Array(4000);
    for (let i = 0; i < 1000; i++) d[i] = Math.sin(i) * 0.5; // a loud first second, then silence
    const l = levelOf(d, sr);
    expect(l).toBeGreaterThan(0.3);
    expect(levelOf(new Float32Array(4000).fill(0.1), sr)).toBeCloseTo(0.1, 3);
  });
  it('trims within about ±3 dB towards the target', () => {
    expect(levelTrim(0.1, 0.2)).toBeCloseTo(1.45);
    expect(levelTrim(0.4, 0.2)).toBeCloseTo(0.7);
    expect(levelTrim(0.2, 0.2)).toBe(1);
    expect(levelTrim(0, 0.2)).toBe(1);
  });
  it('levels the pairs of takes and the commentator lines to one loudness', () => {
    expect(LEVEL_TARGET.ooh).toBe(LEVEL_TARGET.ooh2);
    expect(LEVEL_TARGET.kick1).toBe(LEVEL_TARGET.kick2);
    expect(LEVEL_TARGET.crowdA).toBe(LEVEL_TARGET.crowdB);
    expect(LINE_TARGET).toBeGreaterThan(0.2);
  });
  it('ducks the crowd more under the commentator than under a whistle, and muffles it on pause', () => {
    expect(MIX.duckVoice).toBeLessThan(MIX.duckWhistle);
    expect(MIX.pauseCrowd).toBeLessThan(1);
    expect(MIX.pauseCutoff).toBeLessThan(2000);
  });
});

describe('hit-stop', () => {
  it('all but freezes play for a split second, then returns to full speed', () => {
    for (const shape of Object.values(HIT_STOP)) {
      const s = new SlowMo();
      s.start(shape);
      expect(s.scale(0.016)).toBeLessThan(0.2);
      let t = 0, k = 0;
      while (t < 0.5) { k = s.scale(0.016); t += 0.016; }
      expect(k).toBe(1);
      expect(shape.hold + shape.ease).toBeLessThan(0.2);
    }
  });
  it('is far shorter than the slow motion after a goal', () => {
    expect(HIT_STOP.strike.hold).toBeLessThan(SLOW_MO.goal.hold / 10);
  });
});

describe('settings tidy-up', () => {
  it('every option shown in Settings has a one-line explanation', () => {
    for (const [k, v] of Object.entries(SETTING_DESC)) { expect(v.length).toBeGreaterThan(8); expect(v.length).toBeLessThan(80); expect(k).toBeTruthy(); }
    expect(Object.keys(SETTING_DESC).length).toBeGreaterThan(55);
  });
  it('Reset puts one section back to the defaults and leaves the others alone', () => {
    const d = defaultSettings();
    const s = defaultSettings();
    s.audio.master = 0.2; s.audio.muted = true; s.graphics.preset = 'low'; s.graphics.sharpen = false; s.camera.mode = 'wide'; s.passAssist = 'manual'; s.tips = false;
    resetSection(s, d, 'audio');
    expect(s.audio.master).toBe(d.audio.master);
    expect(s.audio.muted).toBe(false);
    expect(s.graphics.preset).toBe('low');
    resetSection(s, d, 'graphics');
    expect(s.graphics.preset).toBe(d.graphics.preset);
    expect('sharpen' in s.graphics).toBe(false); // missing from the defaults: its own default (on) applies
    expect(s.camera.mode).toBe('wide');
    resetSection(s, d, 'camera');
    expect(s.camera.mode).toBe(d.camera.mode);
    resetSection(s, d, 'gameplay');
    expect(s.passAssist).toBe('assisted');
    expect(s.tips).toBeUndefined();
  });
  it('the sections cover Audio, Graphics, Camera, Gameplay and App', () => {
    expect(SETTING_SECTIONS.map((x) => x.id)).toEqual(['audio', 'graphics', 'camera', 'gameplay', 'app']);
  });
});

describe('one-time tips', () => {
  const view = () => {
    const b = new MatchViewBuilder(aiMatch());
    const v = b.view;
    v.humans = [true, false];
    v.phase = 'play';
    v.clock = 60;
    return v;
  };
  const tip = (id: string) => TIPS.find((t) => t.id === id)!;
  it('each tip has a title, text and unique id', () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
    for (const t of TIPS) { expect(t.title).toBeTruthy(); expect(t.text.length).toBeGreaterThan(30); }
  });
  it('the corner tip shows only for your own corner with your taker on the ball', () => {
    const v = view();
    expect(tip('corner').when(v, 0)).toBe(false);
    v.restart = { type: 'corner', team: 0, taker: 9, ready: true, spot: { x: 52, z: 34 }, readyT: 0, aim: { x: 0, z: 0 } };
    v.ctl = [9, 20];
    expect(tip('corner').when(v, 0)).toBe(true);
    v.restart.team = 1;
    expect(tip('corner').when(v, 0)).toBe(false);
  });
  it('tired legs comes up when your player is low on energy', () => {
    const v = view();
    v.ctl = [5, 15];
    expect(tip('tired').when(v, 0)).toBe(false);
    v.players[5].stamina = 0.2;
    expect(tip('tired').when(v, 0)).toBe(true);
  });
  it('through on goal: your carrier near goal with only the keeper ahead', () => {
    const v = view();
    const me = v.players.find((p) => p.team === 0 && p.role !== 'GK')!;
    v.ctl = [me.id, -1];
    const gx = PITCH.halfLength * v.attackDir[0];
    me.pos = { x: gx - Math.sign(gx) * 14, z: 0 };
    v.ball.owner = me.id; v.ball.state = 'dribble';
    for (const p of v.players) if (p.team === 1 && p.role !== 'GK') p.pos = { x: -gx * 0.5, z: 0 };
    expect(tip('oneOnOne').when(v, 0)).toBe(true);
    const d = v.players.find((p) => p.team === 1 && p.role !== 'GK')!;
    d.pos = { x: gx - Math.sign(gx) * 7, z: 1 };
    expect(tip('oneOnOne').when(v, 0)).toBe(false);
  });
});

describe('button icons', () => {
  it('draws Xbox and PlayStation face buttons in their colours, shoulders and sticks as their shapes', () => {
    expect(padGlyphKind('A')).toEqual({ kind: 'face', key: 'xa' });
    expect(padGlyphKind('△').key).toBe('ptriangle');
    expect(padGlyphKind('RB').kind).toBe('bumper');
    expect(padGlyphKind('L2').kind).toBe('trigger');
    expect(padGlyphKind('RS').kind).toBe('stick');
    expect(padKey('B', 'xbox')).toContain('pad-xb');
    expect(padKey('LB/RB', 'xbox').match(/<kbd/g)!.length).toBe(2);
    expect(padKey('—')).toContain('none');
    expect(padKey('A', 'generic')).toBe('<kbd>A</kbd>');
    expect(keyCap('Space')).toContain('class="key"');
    expect(padKey('<x>', 'xbox')).not.toContain('<x>');
  });
});

describe('small fixes', () => {
  it('My goals keeps each save slot\'s clips apart (old clips belong to the first slot)', () => {
    const c = (id: string, slot?: number) => ({ id, slot } as unknown as GoalClip);
    const all = [c('a'), c('b', 0), c('c', 1), c('d', 2)];
    expect(clipsOfSlot(all, 0).map((x) => x.id)).toEqual(['a', 'b']);
    expect(clipsOfSlot(all, 1).map((x) => x.id)).toEqual(['c']);
  });
  it('the daily date is the device\'s own calendar day', () => {
    expect(localDay(new Date(2026, 6, 4, 0, 30))).toBe('2026-07-04');
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});
