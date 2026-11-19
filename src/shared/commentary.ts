// Full-match commentary (19 Nov 2026): a commentator who talks through the whole match. Lines are
// picked from a large bank for what just happened (goals of every kind, saves, misses, the
// woodwork, fouls and cards, corners, offsides, substitutions, injuries, added time, half-time,
// full time) with the players' and clubs' names, the score and the minute, and filled in when play
// goes quiet with talk about the build-up. Pure (no DOM): client/commentator.ts speaks the lines
// and shows them as captions.

import { Rng } from './rng';
import type { MatchEvent } from './types';
import type { Match } from './match';
import { PITCH } from './config';

export interface CommentaryContext {
  teams: [string, string];
  /** Short name of a player by id ('' if unknown). */
  name: (id: number) => string;
  team: (id: number) => number;
  score: [number, number];
  /** Football minute (1-120+). */
  minute: number;
  half: number;
  phase: string;
  /** Team on the ball (-1 none), the carrier's id (-1), and how far up the pitch the ball is for that team (-1 own goal .. 1 their goal). */
  possession: number;
  carrier: number;
  progress: number;
  /** Seconds since the match started (real time, for pacing). */
  now: number;
  weather?: string;
  /** Shootout in progress. */
  shootout?: boolean;
  /** Goals each player has scored this match. */
  goalsBy: (id: number) => number;
}

export interface CommentaryLine { text: string; priority: number; kind: string }

type Tpl = string[];
const L = (...x: string[]): Tpl => x;

export const LINES: Record<string, Tpl> = {
  kickoff: L('And we are under way here, {t0} against {t1}.', "Off we go. {t0} get us started.", 'The referee blows, and this one is up and running.', "Here we go then. Plenty riding on this for both sides.", 'And {t0} against {t1} kicks off in front of a lively crowd.'),
  kickoff2: L("We're back under way for the second half.", 'The second half is up and running. {score}.', 'Off we go again. Forty-five minutes to settle this one.', 'Second half, and {lead} will want more of the same.'),
  kickoffEt: L('Extra time is under way. Who has the legs for this?', 'Thirty more minutes. Somebody has to find a goal.'),
  goal: L('GOAL! {p} scores for {t}!', "It's in! {p} with the finish!", 'GOAL! {p} puts it away!', 'And {p} scores! {t} celebrate!', "That's a goal! {p}!", 'Oh, yes! {p} finds the net for {t}!', 'GOAL! What a moment for {p}!', '{p}! In off the post and in! {t} have scored!'),
  goalHeader: L('GOAL! {p} rises highest and heads it in!', 'A brilliant header from {p}! That is in!', "{p} gets his head to it, and it's a goal!", 'Up goes {p}, and the header flies in!'),
  goalVolley: L('GOAL! {p} volleys it in! What a strike!', 'On the volley! {p}! Sensational!', '{p} hits it first time, out of the air, into the net!'),
  goalLong: L('From way out! {p} has scored a screamer!', 'Oh, what a goal! {p} from distance!', '{p} lets fly from long range... and it flies in! Stunning!', 'You will not see a better goal than that! {p} from thirty yards!'),
  goalFreekick: L('Over the wall and in! {p} with a perfect free kick!', 'GOAL! A free kick from {p} that the keeper could only watch!', "{p} curls it in! What a set piece!"),
  goalPen: L("{p} steps up... and scores. Cool as you like.", 'Penalty scored. {p} sends the keeper the wrong way.', 'No mistake from {p} from the spot.'),
  goalOwn: L('Oh, no! An own goal! {p} turns it into his own net!', "That's gone in off {p}! An own goal, and {t} won't care how it came.", 'Calamity! {p} puts it past his own keeper!'),
  equaliser: L("And {t} are level! {score}!", "It's all square again. {score}.", 'The equaliser! Game on!'),
  lead: L('{t} lead! {score}.', '{t} are in front. {score}.', 'And {t} have the lead!'),
  extend: L('{t} extend the lead. {score}.', "That's {score}, and {t} are pulling away.", 'Another one for {t}. {score}.'),
  pullBack: L('{t} pull one back! {score}. Is there a comeback on?', "That's a lifeline for {t}. {score}.", "{score}. {t} aren't finished yet."),
  late: L('In the {m}th minute! That could be the winner!', 'So late in the game! The place is going wild!', 'At the death! What a time to score!'),
  brace: L('{p} has two today!', "That's his second of the afternoon.", 'Two goals now for {p}.'),
  hattrick: L("That's a hat-trick for {p}! Three goals! Take the match ball home!", 'HAT-TRICK! {p} has three!', 'Three for {p}! What a performance!'),
  save: L('Great save!', 'Saved! Good hands from the keeper.', "{p} shoots... and it's saved.", 'The keeper gets down well to stop {p}.', 'Denied! A fine stop.', '{k} keeps it out!', 'What a save from {k}!', 'Strong wrist from {k}, pushing it away.'),
  catch: L('{k} gathers it comfortably.', 'Straight into the arms of {k}.', 'Easy enough for {k}.', 'Claimed by the keeper.'),
  post: L('Off the post! So close!', '{p} hits the post!', 'The woodwork comes to the rescue!', "It's struck the upright! Inches away!"),
  bar: L('Off the crossbar!', '{p} rattles the bar!', 'Crashes against the bar! The crowd held its breath.', 'Off the woodwork again!'),
  miss: L('{p} drags it wide.', 'Over the bar from {p}.', 'Just wide! {p} will feel he should have done better.', "That's a let-off for {o}.", 'Not far away from {p}.', 'Off target. A chance goes begging.', '{p} snatches at it, and it flies wide.', 'He had to hit the target there.'),
  shotFar: L('{p} tries his luck from distance...', 'A long-range effort from {p}...', '{p} has a go from outside the box...'),
  foul: L('Free kick. {p} brings him down.', "That's a foul by {p}.", 'The referee blows for a foul.', '{p} goes in late, and the whistle goes.', 'Clumsy from {p}. Free kick.', 'Too strong from {p}, and the referee has seen it.'),
  penAward: L('PENALTY! The referee points to the spot!', "It's a penalty! A huge moment!", "He's given it! Penalty to {t}!"),
  yellow: L('Yellow card for {p}.', '{p} goes into the book.', "That's a booking for {p}. He must be careful now.", 'The referee shows {p} a yellow card.'),
  red: L('RED CARD! {p} is off!', "He's sent him off! {p} has to go!", '{t} are down to ten! {p} sees red!', 'Off you go! A red card for {p}.'),
  secondYellow: L("That's a second yellow, and {p} is off!", 'Second booking! {p} is sent off!'),
  offside: L('The flag is up. Offside.', '{p} was offside there.', "Offside. He went too early.", 'The assistant flags, and that move is over.'),
  corner: L('Corner to {t}.', '{t} win a corner.', "That's out for a corner.", 'A corner, and the big men go up.'),
  freekickDanger: L('Free kick in a dangerous position for {t}.', 'This is in shooting range.', 'A chance for {t} from the free kick here.'),
  advantage: L('Advantage played! The referee waves play on.', 'Good advantage from the referee.'),
  sub: L('A change for {t}: {in} replaces {out}.', 'Substitution. {out} makes way for {in}.', '{in} comes on for {t}, replacing {out}.'),
  injury: L('{p} is down, and he looks in some pain.', "This doesn't look good for {p}.", 'The physios are on for {p}.', 'Play is stopped. {p} is hurt.'),
  injuryOff: L("{p} can't carry on. He's going off on a stretcher.", 'A stretcher for {p}. A real blow for {t}.', 'Sad sight, {p} being carried off.'),
  injuryUp: L("{p} is back on his feet. He'll carry on.", 'Good news: {p} is up and running again.'),
  addedTime: L('The board is up: {n} minutes of added time.', 'There will be {n} added minutes.', '{n} minutes of stoppage time to play.'),
  halftime: L("That's half-time. {score}.", 'The referee blows for the break. {score}.', 'Half-time here, and it is {score}.'),
  halftimeLevel: L('Half-time, and nothing to separate them. {score}.', 'All square at the break.'),
  fulltimeWin: L("It's all over! {winner} win it, {score}!", 'The final whistle goes! {winner} take the points. {score}.', 'Full time. {score}, and {winner} are celebrating.'),
  fulltimeDraw: L("Full time, and they can't be separated. {score}.", "It finishes all square. {score}.", 'The points are shared. {score}.'),
  tackle: L('Good tackle from {p}.', '{p} wins it back.', 'Strong in the challenge, {p}.', 'Nicked away by {p}.'),
  skill: L('Lovely skill from {p}!', '{p} with a bit of magic there.', 'Look at that from {p}!', '{p} leaves his man for dead!'),
  through: L('{p} threads a ball through...', 'A lovely pass from {p}, in behind...', 'Defence-splitting ball from {p}!'),
  cross: L('{p} whips in a cross...', 'In comes the cross from {p}...', 'The ball into the box from {p}...'),
  chance: L('Ooh, so close!', 'That was a big chance!', 'The crowd thought that was in!'),
  // Quiet spells: talk about the build-up.
  buildDeep: L('{t} knock it about at the back.', 'Patient from {t}, keeping the ball.', '{p} on the ball in his own half.', '{t} are happy to keep possession here.', 'No hurry from {t}. They are looking for an opening.'),
  buildMid: L('{p} looks for a pass in midfield.', '{t} building through the middle.', '{p} has time on the ball.', 'Nice and neat from {t}.', '{t} probing, looking for a way through.'),
  buildHigh: L('{t} are pressing forward now.', '{p} in a promising position...', '{t} have numbers in the box.', 'This is dangerous for {o}.', '{p} is driving at the defence!'),
  lull: L("{score}, with {m} minutes played.", 'A great atmosphere here tonight.', "It's {score}, and {lead} are looking comfortable.", 'Both sides are working hard for each other.', '{t} have had more of the ball in the last few minutes.', "The crowd are right behind {t0} tonight.", 'Plenty of football still to be played.', 'The tempo has dropped a little.'),
  weatherRain: L('The rain is making the surface slick. The ball is skidding on.', 'Tricky conditions in this rain.'),
  weatherSnow: L('The snow is still coming down. It is a battle out there.', 'Heavy going in the snow.'),
  shootout: L('So it comes down to penalties.', 'Penalties to decide it. Nerves of steel needed.'),
  penScore: L('Scored.', 'Converted.', 'He scores.', 'Into the corner.'),
  penMiss: L('Saved! What a moment!', 'He has missed!', 'Kept out!'),
};

const pick = (rng: Rng, t: Tpl) => t[Math.floor(rng.next() * t.length) % t.length];
const fill = (s: string, map: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? '');

/**
 * Turns match events into commentary lines. One line at a time: low-priority lines are dropped
 * while the commentator is still talking; a goal or a red card always gets through.
 */
export class Commentary {
  private rng: Rng;
  private lastLine = -99;
  private lastFill = -99;
  private recent: string[] = [];
  private lastShot: { id: number; at: number; far: boolean } = { id: -1, at: -99, far: false };
  private lastKicker = -1;
  private pendingSub: string[] = [];
  /** Seconds a line is assumed to take, for pacing (about 2.6 words a second). */
  busyFor = (text: string) => 0.8 + text.split(/\s+/).length / 2.6;
  private busyUntil = -99;
  /** How chatty: 1 normal, lower for fewer lines. */
  chat = 1;

  constructor(seed = 1) { this.rng = new Rng(seed); }

  private line(kind: string, priority: number, ctx: CommentaryContext, map: Record<string, string>): CommentaryLine | null {
    const bank = LINES[kind];
    if (!bank) return null;
    // Not the same line twice in a row (or within the last few).
    let text = '';
    for (let i = 0; i < 6; i++) { text = fill(pick(this.rng, bank), { ...this.base(ctx), ...map }); if (!this.recent.includes(text)) break; }
    this.recent.push(text);
    if (this.recent.length > 24) this.recent.shift();
    return { text, priority, kind };
  }

  private base(ctx: CommentaryContext): Record<string, string> {
    const [a, b] = ctx.score;
    const lead = a === b ? 'both sides' : ctx.teams[a > b ? 0 : 1];
    return { t0: ctx.teams[0], t1: ctx.teams[1], score: `${ctx.teams[0]} ${a}, ${ctx.teams[1]} ${b}`, m: String(ctx.minute), lead };
  }

  /** Lines for this frame's events (usually none or one), and a filler when play has gone quiet. */
  feed(events: MatchEvent[], ctx: CommentaryContext): CommentaryLine[] {
    const out: CommentaryLine[] = [];
    const add = (l: CommentaryLine | null) => { if (l) out.push(l); };
    const nm = (id?: number) => (id !== undefined && id >= 0 ? ctx.name(id) : '');
    const tn = (t?: number) => (t !== undefined && t >= 0 ? ctx.teams[t] ?? '' : '');
    for (const e of events) {
      const t = e.team ?? -1;
      const o = t >= 0 ? ctx.teams[1 - t] ?? '' : '';
      const P = { p: nm(e.player), t: tn(t), o };
      switch (e.type) {
        case 'kickoff':
          if (ctx.minute <= 1 && ctx.half === 1) add(this.line('kickoff', 3, ctx, P));
          else if (ctx.half === 2 && ctx.minute <= 46) add(this.line('kickoff2', 3, ctx, P));
          else if (ctx.half === 3 && ctx.minute <= 91) add(this.line('kickoffEt', 3, ctx, P));
          break;
        case 'kick': {
          if (e.text === 'shot' || e.text === 'volley' || e.text === 'header') {
            const far = (e.power ?? 0) > 22 && ctx.progress < 0.62;
            this.lastShot = { id: e.player ?? -1, at: ctx.now, far };
            if (far && this.rng.chance(0.5)) add(this.line('shotFar', 1, ctx, P));
          } else if (e.text === 'through' && this.rng.chance(0.25 * this.chat)) add(this.line('through', 0, ctx, P));
          else if (e.text === 'cross' && this.rng.chance(0.35 * this.chat)) add(this.line('cross', 0, ctx, P));
          this.lastKicker = e.player ?? -1;
          break;
        }
        case 'goal': {
          if (ctx.shootout) { add(this.line('penScore', 4, ctx, P)); break; }
          const scorer = e.player ?? -1;
          const own = e.text === 'og';
          const kind = own ? 'goalOwn' : e.text === 'pen' ? 'goalPen' : this.goalKind(ctx, scorer);
          const parts: string[] = [];
          const g = this.line(kind, 9, ctx, { ...P, t: tn(t) });
          if (g) parts.push(g.text);
          const [a, b] = ctx.score;
          const mine = t === 0 ? a : b, theirs = t === 0 ? b : a;
          const follow = mine === theirs ? 'equaliser' : mine === theirs + 1 && mine === 1 ? 'lead' : mine === theirs + 1 ? 'lead' : mine > theirs ? 'extend' : 'pullBack';
          const f = this.line(follow, 9, ctx, { t: tn(t) });
          if (f) parts.push(f.text);
          if (ctx.minute >= 85 && Math.abs(mine - theirs) <= 1 && mine >= theirs) { const l = this.line('late', 9, ctx, {}); if (l) parts.push(l.text); }
          const n = own ? 0 : ctx.goalsBy(scorer);
          if (n === 3) { const l = this.line('hattrick', 9, ctx, P); if (l) parts.push(l.text); }
          else if (n === 2 && this.rng.chance(0.6)) { const l = this.line('brace', 9, ctx, P); if (l) parts.push(l.text); }
          out.push({ text: parts.join(' '), priority: 10, kind: 'goal' });
          break;
        }
        case 'save': {
          if (ctx.shootout) { add(this.line('penMiss', 4, ctx, P)); break; }
          const shooter = this.recentShooter(ctx);
          add(this.line('save', 5, ctx, { p: shooter, k: nm(e.player), t: tn(t) }));
          break;
        }
        case 'catch':
          if (this.rng.chance(0.3 * this.chat)) add(this.line('catch', 1, ctx, { k: nm(e.player) }));
          break;
        case 'post': case 'bar':
          add(this.line(e.type, 6, ctx, { p: this.recentShooter(ctx) }));
          break;
        case 'chance':
          // A shot that went wide or over (not one that hit the woodwork, which has its own line).
          if (ctx.now - this.lastShot.at < 4 && !out.some((x) => x.kind === 'post' || x.kind === 'bar')) add(this.line('miss', 4, ctx, { p: this.recentShooter(ctx), o: t >= 0 ? ctx.teams[1 - t] : '' }));
          else if (this.rng.chance(0.5)) add(this.line('chance', 3, ctx, {}));
          break;
        case 'foul':
          if (this.rng.chance(0.7 * this.chat)) add(this.line('foul', 2, ctx, P));
          break;
        case 'restart':
          if (e.text === 'penalty') add(this.line('penAward', 7, ctx, { t: tn(t) }));
          else if (e.text === 'corner' && this.rng.chance(0.55 * this.chat)) add(this.line('corner', 1, ctx, { t: tn(t) }));
          else if (e.text === 'freekick' && Math.abs(e.x ?? 0) > 52.5 - 30 && Math.abs(e.z ?? 0) < 20 && ((e.x ?? 0) > 0) === (t === 0 ? ctx.progress >= -2 : true) && this.rng.chance(0.6)) add(this.line('freekickDanger', 2, ctx, { t: tn(t) }));
          break;
        case 'card':
          add(this.line(e.text === 'red' ? 'red' : e.text === 'second' ? 'secondYellow' : (e.power ?? 1) >= 2 ? 'red' : 'yellow', e.power === 2 || e.text === 'red' ? 8 : 4, ctx, P));
          break;
        case 'offside':
          if (this.rng.chance(0.75 * this.chat)) add(this.line('offside', 2, ctx, P));
          break;
        case 'advantage':
          if (this.rng.chance(0.6)) add(this.line('advantage', 2, ctx, P));
          break;
        case 'sub': {
          const [out1, in1] = (e.text ?? '').split('>');
          if (out1 && in1) add(this.line('sub', 3, ctx, { t: tn(t), out: out1, in: in1 }));
          break;
        }
        case 'injury': {
          // 'subbed:Name' / 'tenmen:Name': the name is his, as the substitute already has his id.
          const [kind, who] = (e.text ?? '').split(':');
          if (kind === 'up') add(this.line('injuryUp', 3, ctx, P));
          else if (kind === 'subbed' || kind === 'tenmen') add(this.line('injuryOff', 5, ctx, who ? { ...P, p: who } : P));
          else add(this.line('injury', 5, ctx, P));
          break;
        }
        case 'addedtime':
          add(this.line('addedTime', 3, ctx, { n: String(e.power ?? 1) }));
          break;
        case 'tackle':
          if (this.rng.chance(0.18 * this.chat)) add(this.line('tackle', 0, ctx, P));
          break;
        case 'skill':
          if (this.rng.chance(0.4 * this.chat)) add(this.line('skill', 1, ctx, P));
          break;
        case 'halftime': {
          const level = ctx.score[0] === ctx.score[1];
          if (ctx.half === 2 && e.text === 'extra') add(this.line('fulltimeDraw', 6, ctx, {}));
          else add(this.line(level && this.rng.chance(0.5) ? 'halftimeLevel' : 'halftime', 6, ctx, {}));
          break;
        }
        case 'fulltime': {
          if (e.text === 'challenge') break;
          const [a, b] = ctx.score;
          add(a === b ? this.line('fulltimeDraw', 8, ctx, {}) : this.line('fulltimeWin', 8, ctx, { winner: ctx.teams[a > b ? 0 : 1] }));
          break;
        }
        default: break;
      }
    }
    // Pacing: the most important line now; a lesser one only when the commentator is free.
    out.sort((x, y) => y.priority - x.priority);
    const best = out[0];
    if (best && (best.priority >= 7 || ctx.now >= this.busyUntil || best.priority >= 5 && ctx.now >= this.busyUntil - 1.2)) {
      this.say(best, ctx.now);
      return [best];
    }
    // Quiet for a while: talk about the play.
    const quiet = ctx.now - this.lastLine;
    if (ctx.phase === 'play' && quiet > 9 / Math.max(0.3, this.chat) && ctx.now - this.lastFill > 7 && ctx.now >= this.busyUntil) {
      const l = this.filler(ctx);
      if (l) { this.lastFill = ctx.now; this.say(l, ctx.now); return [l]; }
    }
    return [];
  }

  private say(l: CommentaryLine, now: number) {
    this.lastLine = now;
    this.busyUntil = now + this.busyFor(l.text);
  }

  private recentShooter(ctx: CommentaryContext) {
    return this.lastShot.id >= 0 && ctx.now - this.lastShot.at < 5 ? ctx.name(this.lastShot.id) : this.lastKicker >= 0 ? ctx.name(this.lastKicker) : 'him';
  }

  private goalKind(ctx: CommentaryContext, scorer: number): string {
    void scorer;
    const s = this.lastShot;
    if (ctx.now - s.at < 5 && s.far) return 'goalLong';
    return 'goal';
  }

  /** A goal of a known kind (from the app, which knows headers, volleys and free kicks). */
  goalLineFor(kind: 'header' | 'volley' | 'freekick' | 'long' | 'normal', ctx: CommentaryContext, scorer: number, team: number): string {
    const k = kind === 'header' ? 'goalHeader' : kind === 'volley' ? 'goalVolley' : kind === 'freekick' ? 'goalFreekick' : kind === 'long' ? 'goalLong' : 'goal';
    return this.line(k, 9, ctx, { p: ctx.name(scorer), t: ctx.teams[team] ?? '' })?.text ?? '';
  }

  private filler(ctx: CommentaryContext): CommentaryLine | null {
    const t = ctx.possession;
    if (t < 0 || ctx.carrier < 0) {
      if (ctx.weather === 'rain' && this.rng.chance(0.15)) return this.line('weatherRain', 0, ctx, {});
      if (ctx.weather === 'snow' && this.rng.chance(0.15)) return this.line('weatherSnow', 0, ctx, {});
      return this.rng.chance(0.4) ? this.line('lull', 0, ctx, { t: ctx.teams[0] }) : null;
    }
    const P = { p: ctx.name(ctx.carrier), t: ctx.teams[t], o: ctx.teams[1 - t] };
    if (this.rng.chance(0.2)) return this.line('lull', 0, ctx, P);
    return this.line(ctx.progress > 0.45 ? 'buildHigh' : ctx.progress > -0.2 ? 'buildMid' : 'buildDeep', 0, ctx, P);
  }
}

/** How many distinct lines the commentator has. */
export const LINE_COUNT = Object.values(LINES).reduce((n, t) => n + t.length, 0);

/** The commentator's view of a match (the client builds this every frame; tests use it too). */
export function matchContext(m: Match, teams: [string, string], now: number): CommentaryContext {
  const b = m.ball;
  const owner = b.owner >= 0 ? m.players[b.owner] : null;
  const team = owner ? owner.team : -1;
  const progress = owner ? (b.pos.x * m.attackDir(owner.team)) / PITCH.halfLength : 0;
  return {
    teams,
    name: (id) => m.players[id]?.def.short ?? '',
    team: (id) => m.players[id]?.team ?? -1,
    score: [m.score[0], m.score[1]],
    minute: Math.floor(m.displayClock / 60) + 1,
    half: m.half,
    phase: m.phase,
    possession: team,
    carrier: owner ? owner.id : -1,
    progress,
    now,
    weather: m.weather?.kind,
    shootout: !!m.shootout,
    goalsBy: (id) => m.goals.filter((g) => g.player === id && !g.ownGoal).length,
  };
}
