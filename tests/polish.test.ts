import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PITCH } from '../src/shared/config';
import { defaultBindings } from '../src/client/input/bindings';
import { MENU_CAM, MENU_SHOTS, menuKits, menuShot, pickMenuTeams } from '../src/client/menuscene';
import { loadingTips } from '../src/client/ui/loading';
import { greeting, lineupLines, pickVoice, splitLine, welcomeLines } from '../src/client/audio/announcer';
import { ALL_CLUBS, teamById } from '../src/shared/teams';
import { defaultConfig, Match } from '../src/shared/match';

describe('menu background cameras', () => {
  it('keep every shot inside the bowl, above the grass and looking at play', () => {
    const spots = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(52, 0, 33), new THREE.Vector3(-52, 0, -33), new THREE.Vector3(30, 0, -20)];
    for (const kind of MENU_SHOTS) for (const f of spots) for (let seed = 1; seed < 5; seed++) for (let t = 0; t <= MENU_CAM.hold; t += 1.5) {
      const s = menuShot(kind, t, f, seed);
      expect(s.pos.y, kind).toBeGreaterThan(1);
      expect(s.pos.y, kind).toBeLessThan(36);
      // Inside the stands, except the gantry over the roofless near straight.
      expect(Math.abs(s.pos.x), kind).toBeLessThanOrEqual(PITCH.halfLength + 4);
      if (kind !== 'gantry') expect(Math.abs(s.pos.z), kind).toBeLessThanOrEqual(PITCH.halfWidth + 5.5);
      expect(Math.hypot(s.look.x - f.x, s.look.z - f.z), kind).toBeLessThan(12);
      expect(s.fov).toBeGreaterThan(8);
    }
  });

  it('picks two different clubs, with kits that stand apart', () => {
    for (let i = 0; i < 50; i++) {
      const [a, b] = pickMenuTeams();
      expect(a).not.toBe(b);
      const k = menuKits([a, b]);
      expect(k[0]).toBe('home');
    }
    for (const a of ALL_CLUBS) for (const b of ALL_CLUBS) {
      if (a === b) continue;
      const k = menuKits([a.id, b.id]);
      const x = teamById(a.id).home.shirt, y = teamById(b.id)[k[1]].shirt;
      const d = Math.hypot(((x >> 16) & 255) - ((y >> 16) & 255), ((x >> 8) & 255) - ((y >> 8) & 255), (x & 255) - (y & 255));
      const other = teamById(b.id)[k[1] === 'home' ? 'away' : 'home'].shirt;
      const d2 = Math.hypot(((x >> 16) & 255) - ((other >> 16) & 255), ((x >> 8) & 255) - ((other >> 8) & 255), (x & 255) - (other & 255));
      expect(d).toBeGreaterThanOrEqual(Math.min(d2, 120));
    }
  });

  it('a computer-only match keeps playing (the background never stalls at kick-off)', () => {
    const m = new Match(defaultConfig({ teams: ['redmoor', 'kestrel'], kits: ['home', 'away'], humans: [false, false], difficulty: ['elite', 'elite'], seed: 7 }));
    const start = { ...m.ball.pos };
    let moved = 0;
    for (let i = 0; i < 60 * 30; i++) { m.step(); m.drainEvents(); moved = Math.max(moved, Math.hypot(m.ball.pos.x - start.x, m.ball.pos.z - start.z)); }
    expect(m.phase).not.toBe('kickoff');
    expect(moved).toBeGreaterThan(10);
  });
});

describe('loading tips', () => {
  it('name the right buttons for keyboard, controller and touch, with nothing left unfilled', () => {
    const b = defaultBindings();
    for (const dev of ['keyboard', 'gamepad', 'touch'] as const) {
      const tips = loadingTips(dev, 'xbox', b);
      expect(tips.length).toBeGreaterThan(15);
      for (const t of tips) {
        expect(t).not.toMatch(/\{\w+\}/);
        expect(t).not.toMatch(/undefined/);
      }
    }
    const pad = loadingTips('gamepad', 'xbox', b).join(' ');
    expect(pad).toMatch(/<kbd[^>]*>(A|B|X|Y|LB|RB|LT|RT)<\/kbd>/);
    expect(loadingTips('touch').join(' ')).not.toMatch(/<kbd>/);
  });
});

describe('stadium announcer', () => {
  it('welcomes the crowd for the time of day', () => {
    expect(greeting('day')).toBe('Good afternoon');
    expect(greeting('night')).toBe('Good evening');
    const w = welcomeLines('Redmoor Rovers', 'Kestrel Bay', 'the Harbourside Ground', 'dusk');
    expect(w.join(' ')).toMatch(/welcome to the Harbourside Ground/);
    expect(w.join(' ')).toMatch(/Redmoor Rovers, against Kestrel Bay/);
  });

  it('reads the visitors in one go, then each home player with a cheer', () => {
    const team = (id: string) => {
      const t = teamById(id);
      return { name: t.name, captain: t.players[5].name, players: t.players.slice(0, 11).map((p) => ({ number: p.number, name: p.name, role: p.role })) };
    };
    const lines = lineupLines(team('redmoor'), team('kestrel'));
    expect(lines[0][0]).toMatch(/^The visitors, Kestrel Bay\./);
    expect(lines[0][1]).toBe(false);
    expect(lines.length).toBe(2 + 11);
    expect(lines.slice(2).every(([, cheer]) => cheer)).toBe(true);
    expect(lines[2][0]).toMatch(/in goal/);
    expect(lines.some(([l]) => /your captain/.test(l))).toBe(true);
  });

  it('prefers a British voice that sounds like a PA announcer', () => {
    const v = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice;
    expect(pickVoice([v('Samantha', 'en-US'), v('Daniel', 'en-GB'), v('Amelie', 'fr-FR')])?.name).toBe('Daniel');
    expect(pickVoice([v('Samantha', 'en-US'), v('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', false)])?.name).toMatch(/Ryan/);
    expect(pickVoice([v('Samantha', 'en-US')])?.name).toBe('Samantha');
    expect(pickVoice([v('Amelie', 'fr-FR')])).toBeNull();
  });

  it('splits long lines at sentence ends so no single line runs too long', () => {
    const long = 'The visitors, Kestrel Bay. 1, Ian Prys. 2, Jan Arndt. 4, Leo Mercer. 5, Sam Bakare. 3, Tom Corrigan. 6, Ravi Sethi. 8, Max Voss. 10, Luis Llorente.';
    const parts = splitLine(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 90)).toBe(true);
    expect(parts.join(' ')).toBe(long);
    expect(splitLine('Short line.')).toEqual(['Short line.']);
  });
});

describe('announcer setting', () => {
  it('is off by default', async () => {
    const { defaultSettings } = await import('../src/client/settings');
    expect(defaultSettings().audio.announcer).toBe(false);
  });
});
