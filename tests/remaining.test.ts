// 19 Nov 2026: more league clubs, club creator, profiles and achievements, accessibility,
// tutorial coach and photo mode helpers.
import { describe, expect, it } from 'vitest';
import { ALL_CLUBS, ROLES, TEAMS, badgeFor, buildCustomClub, getCustomClubs, playableClubs, setCustomClubs, teamById, teamRatings, type CustomClubSpec } from '../src/shared/teams';
import { cupRounds, leagueTable, myFixture, newCompetition, opponentOf, recordResult, roundName } from '../src/shared/competition';
import { defaultConfig, Match } from '../src/shared/match';
import { ACHIEVEMENTS, cleanProfile, loadStore, matchAchievements, newProfile, recordMatch, recordTrophy, resultOf, wasBehind, winningGoal, type MatchSummary } from '../src/client/profile';
import { kitContrast, pickOppKit, seenDistance, simulate } from '../src/client/access';
import { filterPixels, PhotoMode } from '../src/client/photo';
import { Coach, COACH_STEPS } from '../src/client/tutorial';
import { ActionLayer, emptyRaw, type InputSource, type RawState } from '../src/client/input/actions';
import { emptyStats } from '../src/shared/types';
import { badgeSvg } from '../src/client/ui/badge';

const spec = (id = 'custom-1-42'): CustomClubSpec => ({
  id, name: 'Riverford Athletic', abbr: 'RFA', flavour: 'pace',
  badge: { shape: 'round', emblem: 'bird', bg: 0x123a8c, fg: 0xf2c14e, trim: 0xffffff },
  home: { shirt: 0x123a8c, sleeves: 0x123a8c, shorts: 0xf4f4f4, socks: 0x123a8c, number: 0xffffff, keeper: 0x1f9d55 },
  away: { shirt: 0xf2c14e, sleeves: 0xf2c14e, shorts: 0x123a8c, socks: 0xf2c14e, number: 0x123a8c, keeper: 0xe23d28 },
});

describe('more league clubs', () => {
  it('has 18 league clubs besides the two main ones, all different, with full squads and a crest', () => {
    expect(TEAMS).toHaveLength(2);
    expect(ALL_CLUBS).toHaveLength(20);
    const names = new Set<string>();
    for (const t of ALL_CLUBS) {
      expect(new Set(t.players.map((p) => p.role))).toEqual(new Set(ROLES));
      for (const p of t.players) { expect(names.has(p.name), p.name).toBe(false); names.add(p.name); }
      const b = badgeFor(t);
      expect(b.bg).toBe(t.home.shirt);
      expect(badgeSvg(b, t.abbr)).toContain('<svg');
    }
    const ovr = ALL_CLUBS.map((t) => teamRatings(t).ovr);
    expect(Math.max(...ovr) - Math.min(...ovr)).toBeGreaterThanOrEqual(5);
  });

  it('plays a match between two of the new clubs', () => {
    const m = new Match(defaultConfig({ teams: ['kingsmere', 'highmarsh'], humans: [false, false], seed: 3 }));
    for (let i = 0; i < 900; i++) m.step();
    expect(m.teams.map((t) => t.name)).toEqual(['Kingsmere Dynamo', 'Highmarsh Pioneers']);
  });

  it('leagues of 8 to 20 clubs: everyone plays everyone once, and your club is always in', () => {
    for (const n of [8, 12, 16, 20]) {
      const c = newCompetition('league', 'gullhaven', 7 + n, n);
      expect(c.size).toBe(n);
      expect(c.rounds).toHaveLength(n - 1);
      const pairs = new Set<string>();
      for (const r of c.rounds) {
        expect(new Set(r.flatMap((f) => [f.home, f.away])).size).toBe(n);
        for (const f of r) pairs.add([f.home, f.away].sort().join('-'));
      }
      expect(pairs.size).toBe((n * (n - 1)) / 2);
      expect(c.rounds[0].some((f) => f.home === 'gullhaven' || f.away === 'gullhaven')).toBe(true);
    }
  });

  it('a 20-club league plays out and finishes with a table of 20', () => {
    let c = newCompetition('league', 'redmoor', 11, 20);
    while (myFixture(c)) c = recordResult(c, 2, 1);
    expect(c.champion).toBeDefined();
    expect(leagueTable(c)).toHaveLength(20);
    expect(leagueTable(c).find((r) => r.id === 'redmoor')!.pts).toBe(57);
  });

  it('a 16-club cup starts at the round of 16 and has four rounds', () => {
    let c = newCompetition('cup', 'kestrel', 5, 16);
    expect(cupRounds(c)).toEqual(['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
    expect(c.rounds[0]).toHaveLength(8);
    expect(roundName(c)).toBe('Round of 16');
    let rounds = 0;
    while (myFixture(c)) { c = recordResult(c, 1, 0); rounds++; }
    expect(rounds).toBe(4);
    expect(c.champion).toBe('kestrel');
    // An 8-club cup saved before sizes existed still names its rounds from the quarter-finals.
    const old = newCompetition('cup', 'kestrel', 5);
    delete old.size;
    expect(cupRounds(old)).toEqual(['Quarter-finals', 'Semi-finals', 'Final']);
  });
});

describe('club creator', () => {
  it('builds the same squad every time from the club id, and the game can find it', () => {
    const a = buildCustomClub(spec()), b = buildCustomClub(spec());
    expect(a.players.map((p) => p.name)).toEqual(b.players.map((p) => p.name));
    expect(new Set(a.players.map((p) => p.short)).size).toBe(11);
    expect(a.badge?.emblem).toBe('bird');
    setCustomClubs([a]);
    expect(teamById('custom-1-42').name).toBe('Riverford Athletic');
    expect(playableClubs()).toHaveLength(21);
    // A comparable level to the two main clubs.
    expect(Math.abs(teamRatings(a).ovr - teamRatings(TEAMS[0]).ovr)).toBeLessThanOrEqual(6);
    // Your own club can play a cup, against built-in clubs only.
    const c = newCompetition('cup', 'custom-1-42', 9, 8);
    expect(c.rounds[0].flatMap((f) => [f.home, f.away]).filter((id) => id.startsWith('custom-'))).toEqual(['custom-1-42']);
    expect(opponentOf(c)).not.toBe('custom-1-42');
    const m = new Match(defaultConfig({ teams: ['custom-1-42', 'redmoor'], humans: [false, false], seed: 4 }));
    for (let i = 0; i < 300; i++) m.step();
    expect(m.teams[0].name).toBe('Riverford Athletic');
    setCustomClubs([]);
    expect(getCustomClubs()).toHaveLength(0);
  });
});

const summary = (over: Partial<MatchSummary> = {}): MatchSummary => ({
  mode: 'quick', club: 'redmoor', clubName: 'Redmoor Rovers', opp: 'kestrel', oppName: 'Kestrel Bay', custom: false, difficulty: 'pro', adaptiveWorld: false,
  gf: 0, ga: 0, stats: emptyStats(), possession: 0.5, goals: [], sequence: [], half: 2, ...over,
});

describe('profiles, records and achievements', () => {
  it('starts slot 1 from older saves (cup in progress and challenge bests)', () => {
    const mem = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } as unknown as Storage;
    mem.set('elevens.competition', JSON.stringify(newCompetition('league', 'kestrel', 3)));
    mem.set('elevens-challenge-best', JSON.stringify({ penalty: 7 }));
    const s = loadStore('Phil');
    expect(s.active).toBe(0);
    expect(s.slots).toHaveLength(3);
    expect(s.slots[0]!.name).toBe('Phil');
    expect(s.slots[0]!.comp?.club).toBe('kestrel');
    expect(s.slots[0]!.challengeBest.penalty).toBe(7);
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('cleans a damaged save', () => {
    const p = cleanProfile({ name: 'X', stats: { played: 3 }, achievements: null, clubs: [{ id: 'bad' }, spec()] })!;
    expect(p.stats.played).toBe(3);
    expect(p.stats.won).toBe(0);
    expect(p.achievements).toEqual({});
    expect(p.clubs).toHaveLength(1);
    expect(cleanProfile(null)).toBeNull();
  });

  it('reads comebacks and late winners from the goal order', () => {
    const seq: MatchSummary['sequence'] = [{ side: -1, minute: 10 }, { side: 1, minute: 50 }, { side: 1, minute: 88 }];
    expect(wasBehind(seq)).toBe(1);
    expect(winningGoal(seq)?.minute).toBe(88);
    expect(winningGoal([{ side: 1, minute: 5 }, { side: -1, minute: 6 }])).toBeNull();
    expect(resultOf(summary({ gf: 1, ga: 1, pens: [4, 3] }))).toBe('W');
  });

  it('records a match: totals, records, form and the achievements it earns', () => {
    const p = newProfile('Test');
    const won = recordMatch(p, summary({
      gf: 4, ga: 1, possession: 0.64, difficulty: 'elite',
      sequence: [{ side: -1, minute: 5 }, { side: 1, minute: 20 }, { side: 1, minute: 60 }, { side: 1, minute: 70 }, { side: 1, minute: 86 }],
      goals: [{ scorer: 'Reyes', kind: 'header', distance: 8, minute: 20 }, { scorer: 'Reyes', kind: 'freekick', distance: 24, minute: 60 }, { scorer: 'Reyes', kind: 'shot', distance: 27, minute: 70 }, { scorer: 'Castell', kind: 'penalty', distance: 11, minute: 86 }],
    })).map((a) => a.id);
    expect(p.stats).toMatchObject({ played: 1, won: 1, gf: 4, ga: 1 });
    expect(p.records.biggestWin?.value).toBe(3);
    expect(p.records.topScorer?.value).toBe(3);
    expect(p.recent[0].res).toBe('W');
    for (const id of ['first-match', 'first-win', 'hat-trick', 'comeback', 'header', 'freekick', 'long-range', 'penalty', 'possession', 'elite-win']) expect(won, id).toContain(id);
    expect(won).not.toContain('thrashing');
    expect(won).not.toContain('late-winner'); // the winner was Reyes's second, on 60'
    // Achievements unlock once.
    expect(recordMatch(p, summary({ gf: 1, ga: 0 })).map((a) => a.id)).toEqual(['clean-sheet']);
    expect(p.records.unbeaten).toBe(2);
    recordMatch(p, summary({ gf: 0, ga: 2 }));
    expect(p.records.unbeaten).toBe(0);
    expect(p.records.bestUnbeaten?.value).toBe(2);
    // Every achievement id the game can award is in the list.
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const id of matchAchievements(p, summary({ gf: 1, ga: 0, custom: true, adaptiveWorld: true, pens: [5, 4] }))) expect(ids.has(id), id).toBe(true);
  });

  it('a late winner and trophies', () => {
    const p = newProfile('T');
    const got = recordMatch(p, summary({ gf: 2, ga: 1, sequence: [{ side: 1, minute: 30 }, { side: -1, minute: 70 }, { side: 1, minute: 45, added: 2 }] })).map((a) => a.id);
    expect(got).not.toContain('late-winner'); // 45+2 in a match that reached the second half, but it is the first-half clock
    const got2 = recordMatch(p, summary({ gf: 1, ga: 0, sequence: [{ side: 1, minute: 89 }] })).map((a) => a.id);
    expect(got2).toContain('late-winner');
    let c = newCompetition('league', 'redmoor', 2, 16);
    while (myFixture(c)) c = recordResult(c, 5, 0);
    expect(recordTrophy(p, c, 'Redmoor Rovers').map((a) => a.id)).toEqual(['league-win', 'big-league']);
    expect(p.trophies[0]).toMatchObject({ kind: 'league', size: 16 });
  });
});

describe('colour-blind kits', () => {
  it('sees red and green as close for red-weak and green-weak vision', () => {
    expect(seenDistance(0xc8102e, 0x1f9d55, 'off')).toBeGreaterThan(200);
    expect(seenDistance(0xc8102e, 0x1f9d55, 'deutan')).toBeLessThan(seenDistance(0xc8102e, 0x1f9d55, 'off') * 0.6);
    expect(simulate(0xffffff, 'protan').every((v) => v > 240)).toBe(true);
  });

  it('changes the computer side into a kit that stands apart', () => {
    const red = teamById('redmoor').home;
    const green = { ...teamById('harrowfield') };
    // Normal vision: Harrowfield's green home kit is fine against red.
    expect(pickOppKit(red, green, 'home', 'off').which).toBe('home');
    // Green-weak: red and green look alike, so they change into their white away kit.
    const r = pickOppKit(red, green, 'home', 'deutan');
    expect(r.which).toBe('away');
    expect(kitContrast(red, r.kit, 'deutan')).toBeGreaterThan(kitContrast(red, green.home, 'deutan'));
    // Two clubs whose kits both clash get a plain change kit.
    const clash = { ...green, home: { ...red }, away: { ...red, shorts: 0xc8102e } };
    expect(pickOppKit(red, clash, 'home', 'off').which).toBe('change');
  });
});

describe('hold times and toggle sprint', () => {
  const src = (r: Partial<RawState>): InputSource & { r: RawState } => ({ device: 'keyboard', r: { ...emptyRaw(), ...r }, read() { return this.r; }, clear() {} });
  it('a longer hold time fills the power bar more slowly', () => {
    const s = src({});
    const a = new ActionLayer([s]);
    a.sample(0, { attacking: true });
    s.r.pass = true;
    a.sample(100, { attacking: true });
    const normal = a.charge(550);
    a.chargeScale = 2;
    expect(a.charge(550)).toBeCloseTo(normal / 2, 5);
  });

  it('toggle sprint latches on a press and stops when the stick is let go', () => {
    const s = src({ sx: 1 });
    const a = new ActionLayer([s]);
    a.sprintToggle = true;
    expect(a.sample(0, { attacking: false }).sprint).toBe(false);
    s.r.sprint = true;
    expect(a.sample(16, { attacking: false }).sprint).toBe(true);
    s.r.sprint = false;
    expect(a.sample(32, { attacking: false }).sprint).toBe(true);
    s.r.sx = 0;
    expect(a.sample(48, { attacking: false }).sprint).toBe(false);
  });
});

describe('tutorial coach', () => {
  it('ticks steps off from play and finishes after a goal', () => {
    const el = () => ({ className: '', innerHTML: '', hidden: false, remove() {} });
    (globalThis as unknown as { document: unknown }).document = { createElement: el };
    const coach = new Coach({ appendChild() {} } as unknown as HTMLElement);
    let finished = false;
    coach.onFinish = () => { finished = true; };
    const v = { ctl: [0, 11], players: [{ pos: { x: 0, z: 0 }, vel: { x: 6, z: 0 }, sprinting: true }] } as unknown as Parameters<Coach['update']>[0];
    const ctx = (attacking: boolean, held: Partial<{ sprint: boolean; jockey: boolean; switch: boolean; pass: boolean; lob: boolean }> = {}) => ({ team: 0, attacking, held: { sprint: false, jockey: false, switch: false, pass: false, lob: false, ...held }, name: () => 'A', move: 'stick' });
    expect(coach.current(true)?.id).toBe('move');
    for (let i = 0; i < 20; i++) { (v.players[0].pos as { x: number }).x += 1; coach.update(v, [], 0.1, ctx(false)); }
    expect(coach.done.has('move')).toBe(true);
    expect(coach.done.has('sprint')).toBe(true);
    expect(coach.current(false)?.id).toBe('switch');
    expect(coach.current(true)?.id).toBe('pass');
    coach.update(v, [], 0.1, ctx(false, { switch: true }));
    for (let i = 0; i < 10; i++) coach.update(v, [], 0.1, ctx(false, { jockey: true }));
    coach.update(v, [], 0.1, ctx(false, { pass: true }));
    expect(['switch', 'jockey', 'tackle'].every((s) => coach.done.has(s))).toBe(true);
    const k = (text: string) => ({ id: 1, type: 'kick' as const, tick: 0, team: 0, player: 0, text });
    coach.update(v, [k('pass'), k('through'), k('lob'), { id: 2, type: 'skill', tick: 0, team: 0, player: 0 }], 0.1, ctx(true));
    expect(finished).toBe(false);
    coach.update(v, [k('shot'), { id: 3, type: 'goal', tick: 0, team: 0, player: 0, text: '' }], 0.1, ctx(true));
    expect(coach.done.size).toBe(COACH_STEPS.length);
    expect(finished).toBe(true);
    delete (globalThis as unknown as { document?: unknown }).document;
  });
});

describe('photo mode', () => {
  it('orbits around the target and keeps the camera above the grass', () => {
    const p = new PhotoMode();
    const v = { ball: { pos: { x: 10, y: 0.1, z: 5 } } } as unknown as Parameters<PhotoMode['start']>[0];
    p.start(v, { x: 10, y: 30, z: 60 });
    const s0 = p.shot();
    expect(s0.look).toMatchObject({ x: 10, z: 5 });
    expect(Math.hypot(s0.pos.x - 10, s0.pos.y - s0.look.y, s0.pos.z - 5)).toBeCloseTo(14, 3);
    for (let i = 0; i < 100; i++) p.update(0.05, { mx: 0, mz: 0, ox: 1, oy: -1, zoom: 0, lift: 0 });
    const s1 = p.shot();
    expect(s1.pos.y).toBeGreaterThan(0.2);
    expect(Math.hypot(s1.pos.x - s0.pos.x, s1.pos.z - s0.pos.z)).toBeGreaterThan(5);
    // Pushing the stick up moves the target away from the camera.
    const before = { ...p.target };
    p.update(0.5, { mx: 0, mz: 1, ox: 0, oy: 0, zoom: 0, lift: 0 });
    const away = Math.hypot(p.target.x - s1.pos.x, p.target.z - s1.pos.z) - Math.hypot(before.x - s1.pos.x, before.z - s1.pos.z);
    expect(away).toBeGreaterThan(1);
    p.nextFilter();
    expect(p.filter).toBe('vivid');
  });

  it('filters pixels', () => {
    const d = new Uint8ClampedArray([200, 40, 40, 255]);
    filterPixels(d, 'mono');
    expect(d[0]).toBe(d[1]);
    expect(d[1]).toBe(d[2]);
    const e = new Uint8ClampedArray([100, 100, 100, 255]);
    filterPixels(e, 'warm');
    expect(e[0]).toBeGreaterThan(e[2]);
  });
});
