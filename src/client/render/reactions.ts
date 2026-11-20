// Players react when play stops: the man penalised throws his arms out at the referee, a
// striker who misses puts his hands on his head, defenders appeal for offside, a team that
// concedes stands with hands on hips or bent over, and at full time the winners salute the
// crowd while the losers drop to their haunches.
//
// Purely visual: the simulation never knows. Each reaction is a pose in the procedural
// player's channels (see player.ts) blended over the upper body (and over the legs for the
// crouches, only while the player is standing), for a few seconds, with a soft start and end.

import { BRZ, BY, ELX, ERX, HLX, HRX, KLX, KRX, NKX, SLX, SLZ, SPX, SRX, SRZ } from './player';
export { UPPER, LEGS } from './player';
import type { MatchEvent } from '../../shared/types';
import type { ViewState } from '../view';

export type ReactionKind =
  | 'protest' | 'appeal' | 'headInHands' | 'handsOnHips' | 'dejected' | 'crouch'
  | 'armsUp' | 'fistPump' | 'highFive' | 'clap' | 'call'
  // Managers on the touchline and the trophy lift.
  | 'urge' | 'point' | 'lift'
  // The fourth official's board; substitutes warming up.
  | 'board' | 'stretch' | 'armCircle'
  // Goal celebrations (render/celebration.ts).
  | 'kneeSlide' | 'badgeKiss' | 'huddle' | 'aeroplane' | 'kneelSky' | 'cupEar' | 'pointCrowd' | 'dance' | 'bow' | 'armsWide'
  // The walk-out and the pre-match ceremony (render/mascots.ts, render/prematch.ts).
  | 'holdHand' | 'mascotHand' | 'shake' | 'photoStand' | 'photoCrouch' | 'lineUp' | 'teamHuddle'
  // 20 Nov 2026 (render/moves7.ts pack): a hand on an opponent's shirt and a hand-off in a duel,
  // the keeper organising his wall, and the officials' signals (render/officials.ts).
  | 'grabL' | 'grabR' | 'fendL' | 'fendR' | 'organise'
  // Shootouts: the rest of the team arm in arm on the halfway line.
  | 'armsLinked'
  | 'refPoint' | 'refCard' | 'refAdvantage' | 'refSpot' | 'flagUp' | 'flagPoint';

/** When the pre-match huddle breaks up (seconds into the 'teamHuddle' reaction). */
export const PREMATCH_HUDDLE_BREAK = 3.3;

const FULL: ReadonlySet<ReactionKind> = new Set<ReactionKind>(['crouch', 'stretch', 'kneeSlide', 'huddle', 'teamHuddle', 'photoCrouch', 'kneelSky', 'dance', 'bow']);
const CALL_CHANNELS = [SRX, SRZ, ERX] as const;
const LEFT_CHANNELS = [SLX, SLZ, ELX] as const;

interface Reaction { kind: ReactionKind; t: number; dur: number; seed: number }
interface Queued { id: number; kind: ReactionKind; at: number; dur: number }

/** The pose of a reaction `t` seconds in. Writes only the channels the reaction uses. */
export function reactionPose(kind: ReactionKind, t: number, seed: number, P: Float32Array) {
  const s = (f: number, ph = 0) => Math.sin(t * f + seed * 6.28 + ph);
  switch (kind) {
    case 'protest': {
      // Arms out, palms up, gesturing at the referee: "what was that?"
      const g = Math.max(0, s(5.5));
      P[SPX] = 0.04; P[NKX] = -0.12;
      P[SLX] = -0.55 - 0.25 * g; P[SLZ] = 0.7 + 0.15 * s(5.5, 1);
      P[SRX] = -0.55 - 0.25 * g; P[SRZ] = -0.7 - 0.15 * s(5.5, 2);
      P[ELX] = -0.85; P[ERX] = -0.85;
      break;
    }
    case 'appeal':
      // One arm straight up (offside! / foul!), the hand flapping a little.
      P[SPX] = -0.04; P[NKX] = -0.1;
      P[SRX] = -2.95; P[SRZ] = -0.12 - 0.08 * s(6); P[ERX] = -0.1;
      P[SLX] = 0.1; P[SLZ] = 0.18; P[ELX] = -0.35;
      break;
    case 'headInHands':
      // Both hands on top of the head, looking up at the sky.
      P[SPX] = -0.06 + 0.04 * s(1.3); P[NKX] = -0.3;
      P[SLX] = -2.35; P[SLZ] = 0.8; P[ELX] = -2.25;
      P[SRX] = -2.35; P[SRZ] = -0.8; P[ERX] = -2.25;
      break;
    case 'handsOnHips':
      P[SPX] = 0.02; P[NKX] = 0.18 + 0.06 * s(0.9);
      P[SLX] = 0.35; P[SLZ] = 0.5; P[ELX] = -1.55;
      P[SRX] = 0.35; P[SRZ] = -0.5; P[ERX] = -1.55;
      break;
    case 'dejected':
      // Head down, arms hanging.
      P[SPX] = 0.16; P[NKX] = 0.6;
      P[SLX] = 0.05; P[SLZ] = 0.06; P[ELX] = -0.15;
      P[SRX] = 0.05; P[SRZ] = -0.06; P[ERX] = -0.15;
      break;
    case 'crouch':
      // Bent over, hands on knees, getting the breath back.
      P[BY] = -0.12; P[SPX] = 0.78 + 0.03 * s(2.2); P[NKX] = -0.4;
      P[HLX] = -0.5; P[HRX] = -0.5; P[KLX] = 0.62; P[KRX] = 0.62;
      P[SLX] = -0.9; P[SLZ] = 0.12; P[ELX] = -0.15;
      P[SRX] = -0.9; P[SRZ] = -0.12; P[ERX] = -0.15;
      break;
    case 'call': {
      // Calling for the ball in play: one arm up, the hand beckoning.
      P[NKX] = -0.12;
      P[SRX] = -2.7 - 0.12 * Math.abs(s(7)); P[SRZ] = -0.2; P[ERX] = -0.35 - 0.25 * Math.abs(s(7));
      break;
    }
    case 'armsUp': {
      const k = Math.abs(s(6.5));
      P[SPX] = -0.12; P[NKX] = -0.25;
      P[SLX] = -2.6 - 0.25 * k; P[SLZ] = 0.4; P[ELX] = -0.2;
      P[SRX] = -2.6 - 0.25 * k; P[SRZ] = -0.4; P[ERX] = -0.2;
      break;
    }
    case 'fistPump': {
      const k = Math.abs(s(6));
      P[SPX] = 0.12; P[NKX] = 0.05;
      P[SRX] = -1.3 - 0.6 * k; P[SRZ] = -0.25; P[ERX] = -1.9;
      P[SLX] = 0.1; P[SLZ] = 0.2; P[ELX] = -0.6;
      break;
    }
    case 'highFive': {
      // Hand up and across for a teammate's slap, then down again.
      const up = Math.min(1, t / 0.35) * (1 - Math.max(0, Math.min(1, (t - 1.2) / 0.4)));
      P[SPX] = 0; P[NKX] = -0.15;
      P[SRX] = -0.3 - 2.35 * up; P[SRZ] = -0.2 - 0.25 * up; P[ERX] = -0.35;
      P[SLX] = 0; P[SLZ] = 0.15; P[ELX] = -0.4;
      break;
    }
    case 'urge': {
      // A manager waving the team forward: both arms swinging up and out, again and again.
      const k = Math.abs(s(5.2));
      P[SPX] = 0.1; P[NKX] = -0.15;
      P[SLX] = -0.9 - 1.0 * k; P[SLZ] = 0.25; P[ELX] = -0.5 + 0.3 * k;
      P[SRX] = -0.9 - 1.0 * k; P[SRZ] = -0.25; P[ERX] = -0.5 + 0.3 * k;
      break;
    }
    case 'point': {
      // Pointing across the pitch, the other hand on the hip: "push up!", "mark him!"
      const k = s(3.1);
      P[NKX] = -0.12;
      P[SRX] = -1.5 - 0.12 * k; P[SRZ] = -0.55 + 0.12 * k; P[ERX] = -0.08;
      P[SLX] = 0.35; P[SLZ] = 0.5; P[ELX] = -1.55;
      break;
    }
    case 'lift': {
      // The trophy held high over the head in both hands, pumped up and down.
      const k = Math.abs(s(2.4));
      P[SPX] = -0.1; P[NKX] = -0.35;
      P[SLX] = -2.85 - 0.12 * k; P[SLZ] = 0.1; P[ELX] = -0.25 + 0.12 * k;
      P[SRX] = -2.85 - 0.12 * k; P[SRZ] = -0.1; P[ERX] = -0.25 + 0.12 * k;
      break;
    }
    case 'kneeSlide': {
      // Down on both knees, leaning back, arms flung wide, roaring at the sky.
      const k = Math.min(1, t / 0.25);
      P[BY] = -0.46 * k; P[HLX] = -0.05; P[HRX] = -0.05; P[KLX] = 1.75 * k; P[KRX] = 1.75 * k;
      P[SPX] = -0.38 * k + 0.04 * s(3); P[NKX] = -0.5;
      P[SLX] = -1.25 - 0.25 * Math.abs(s(2.5)); P[SLZ] = 1.15; P[ELX] = -0.25;
      P[SRX] = -1.25 - 0.25 * Math.abs(s(2.5, 0.4)); P[SRZ] = -1.15; P[ERX] = -0.25;
      break;
    }
    case 'badgeKiss': {
      // Pulling the crest on his shirt up to his lips, the other arm out to the fans; then pointing at it.
      const kiss = t < 1.6;
      P[SPX] = kiss ? 0.16 : -0.06; P[NKX] = kiss ? 0.42 : -0.15;
      P[SLX] = kiss ? -1.05 : -0.75; P[SLZ] = kiss ? -0.42 : -0.32; P[ELX] = kiss ? -2.35 : -2.0;
      P[SRX] = kiss ? -0.55 : -1.0 - 0.15 * Math.abs(s(5)); P[SRZ] = kiss ? -0.85 : 0.25; P[ERX] = kiss ? -0.35 : -1.35;
      break;
    }
    case 'huddle': {
      // Arms round each other's shoulders, heads down, bouncing together.
      const b = Math.abs(Math.sin(t * 6.2));
      P[BY] = -0.05 - 0.08 * b; P[HLX] = -0.22 - 0.12 * b; P[HRX] = -0.22 - 0.12 * b; P[KLX] = 0.3 + 0.22 * b; P[KRX] = 0.3 + 0.22 * b;
      P[SPX] = 0.42; P[NKX] = 0.3;
      P[SLX] = -1.4; P[SLZ] = 1.2; P[ELX] = -0.45;
      P[SRX] = -1.4; P[SRZ] = -1.2; P[ERX] = -0.45;
      break;
    }
    case 'aeroplane': {
      // Arms spread like wings, tipping from side to side as he banks round.
      const tip = 0.22 * s(2.1);
      P[SPX] = 0.08; P[NKX] = -0.2;
      P[SLX] = -0.15 + tip; P[SLZ] = 1.42 + tip; P[ELX] = -0.08;
      P[SRX] = -0.15 - tip; P[SRZ] = -1.42 + tip; P[ERX] = -0.08;
      break;
    }
    case 'kneelSky': {
      // Down on one knee and then both, both arms straight up, fingers to the sky, looking up.
      const k = Math.min(1, t / 0.35);
      P[BY] = -0.5 * k; P[HLX] = -0.1; P[HRX] = 0.15; P[KLX] = 1.8 * k; P[KRX] = 1.7 * k;
      P[SPX] = -0.2 * k; P[NKX] = -0.55;
      P[SLX] = -2.95 - 0.06 * s(3); P[SLZ] = 0.22; P[ELX] = -0.05;
      P[SRX] = -2.95 - 0.06 * s(3, 1); P[SRZ] = -0.22; P[ERX] = -0.05;
      break;
    }
    case 'cupEar': {
      // A hand cupped to his ear ("I can't hear you!"), the other arm wide, leaning in.
      P[SPX] = 0.1; P[NKX] = 0.05; P[BRZ] = 0.1;
      P[SRX] = -1.35; P[SRZ] = -1.25; P[ERX] = -2.45;
      P[SLX] = -0.6 - 0.15 * Math.abs(s(3)); P[SLZ] = 1.05; P[ELX] = -0.35;
      break;
    }
    case 'pointCrowd': {
      // Both arms out to the crowd, hands jabbing: "come on!"
      const k = Math.abs(s(5.5));
      P[SPX] = 0.1 + 0.05 * k; P[NKX] = -0.12;
      P[SLX] = -1.45 - 0.2 * k; P[SLZ] = 0.18; P[ELX] = -0.12 - 0.25 * (1 - k);
      P[SRX] = -1.45 - 0.2 * k; P[SRZ] = -0.18; P[ERX] = -0.12 - 0.25 * (1 - k);
      break;
    }
    case 'dance': {
      // A little routine in a line: bounce on the knees, hips swaying, fists rolling round each other.
      // Timed by t alone, so dancers who start together stay in step.
      const b = Math.abs(Math.sin(t * 5.6)), r = Math.sin(t * 5.6), q = Math.cos(t * 5.6);
      P[BY] = -0.04 - 0.07 * b; P[HLX] = -0.18 - 0.1 * b; P[HRX] = -0.18 - 0.1 * b; P[KLX] = 0.3 + 0.18 * b; P[KRX] = 0.3 + 0.18 * b;
      P[BRZ] = 0.12 * r; P[SPX] = 0.08; P[NKX] = -0.05 + 0.08 * b;
      P[SLX] = -1.0 + 0.35 * r; P[SLZ] = 0.3; P[ELX] = -1.7 + 0.25 * q;
      P[SRX] = -1.0 - 0.35 * r; P[SRZ] = -0.3; P[ERX] = -1.7 - 0.25 * q;
      break;
    }
    case 'bow': {
      // Teammates bowing down to the scorer, arms stretched out in front.
      const b = 0.5 + 0.5 * Math.sin(t * 3.4);
      P[BY] = -0.12; P[HLX] = -0.55 - 0.15 * b; P[HRX] = -0.55 - 0.15 * b; P[KLX] = 0.45; P[KRX] = 0.45;
      P[SPX] = 0.55 + 0.35 * b; P[NKX] = 0.2;
      P[SLX] = -1.9 - 0.4 * b; P[SLZ] = 0.25; P[ELX] = -0.1;
      P[SRX] = -1.9 - 0.4 * b; P[SRZ] = -0.25; P[ERX] = -0.1;
      break;
    }
    case 'armsWide':
      // Arms spread, palms up, chest out: "here I am".
      P[SPX] = -0.14; P[NKX] = -0.28;
      P[SLX] = -0.75 - 0.08 * s(2); P[SLZ] = 1.25; P[ELX] = -0.3;
      P[SRX] = -0.75 - 0.08 * s(2, 1); P[SRZ] = -1.25; P[ERX] = -0.3;
      break;
    case 'lineUp': {
      // Standing tall in the line-up: arms down by the sides, or hands clasped in front (as in TV
      // walk-outs), shifting the weight and breathing, the odd glance down.
      const clasp = seed > 0.55;
      const b = 0.025 * s(1.6), glance = Math.max(0, s(0.45, 2)) ** 6;
      P[SPX] = -0.03 + b * 0.4 + 0.12 * glance; P[NKX] = -0.04 + 0.35 * glance;
      if (clasp) { P[SLX] = -0.42; P[SLZ] = -0.12; P[ELX] = -0.85 + b; P[SRX] = -0.42; P[SRZ] = 0.12; P[ERX] = -0.85 + b; }
      else { P[SLX] = -0.12 + b; P[SLZ] = 0.07; P[ELX] = -0.3; P[SRX] = -0.12 - b; P[SRZ] = -0.07; P[ERX] = -0.3; }
      break;
    }
    case 'armsLinked': {
      // Arm in arm on the halfway line during a shootout: arms out round the neighbours' shoulders,
      // a nervous sway and the odd bounce on the toes.
      const sway = 0.04 * s(0.9), bob = Math.max(0, s(2.2, 1)) ** 4 * 0.03;
      P[BY] = bob; P[SPX] = 0.06 + sway * 0.5; P[NKX] = 0.05;
      P[SLX] = -0.35; P[SLZ] = 1.3; P[ELX] = -0.55 + sway;
      P[SRX] = -0.35; P[SRZ] = -1.3; P[ERX] = -0.55 - sway;
      break;
    }
    case 'teamHuddle': {
      // The pre-match huddle (20 Nov 2026, from Philip's walk-out video): arms round the shoulders
      // either side, bent in towards the middle and still while the captain talks, a little sway;
      // then everyone straightens, claps once and breaks away.
      const brk = Math.max(0, Math.min(1, (t - PREMATCH_HUDDLE_BREAK) / 0.35));
      const sway = 0.03 * s(1.3);
      const k = 1 - brk;
      P[BY] = -0.06 * k; P[HLX] = -0.14 * k; P[HRX] = -0.14 * k; P[KLX] = 0.24 * k; P[KRX] = 0.24 * k;
      P[SPX] = 0.5 * k + sway; P[NKX] = 0.42 * k - 0.1 * brk;
      if (brk <= 0) {
        P[SLX] = -1.35; P[SLZ] = 1.15; P[ELX] = -0.42 + sway;
        P[SRX] = -1.35; P[SRZ] = -1.15; P[ERX] = -0.42 - sway;
      } else {
        // The clap: both hands together in front of the chest.
        const c = Math.abs(Math.sin(brk * Math.PI));
        P[SLX] = -1.35 + 0.35 * brk; P[SLZ] = 1.15 - 1.3 * brk + 0.1 * c; P[ELX] = -0.42 - 1.0 * brk;
        P[SRX] = -1.35 + 0.35 * brk; P[SRZ] = -1.15 + 1.3 * brk - 0.1 * c; P[ERX] = -0.42 - 1.0 * brk;
      }
      break;
    }
    case 'grabL': case 'grabR': {
      // A hand on the opponent's shirt alongside: the arm reaching out at shoulder height, tugging.
      const l = kind === 'grabL', tug = 0.08 * s(9);
      if (l) { P[SLX] = -1.05 + tug; P[SLZ] = 0.95; P[ELX] = -0.2; } else { P[SRX] = -1.05 + tug; P[SRZ] = -0.95; P[ERX] = -0.2; }
      break;
    }
    case 'fendL': case 'fendR': {
      // Holding the defender off: the arm out to the side, elbow bent, forearm braced.
      const l = kind === 'fendL', push = 0.06 * s(7);
      if (l) { P[SLX] = -0.55; P[SLZ] = 1.05 + push; P[ELX] = -0.95; } else { P[SRX] = -0.55; P[SRZ] = -1.05 - push; P[ERX] = -0.95; }
      break;
    }
    case 'organise': {
      // The keeper sets his wall: one arm points along the line ("one more!"), then a hand cupped
      // to the mouth, shouting; then the other way.
      const ph = (t * 0.55 + seed) % 2;
      const point = ph < 1;
      const k = Math.sin(Math.PI * (ph % 1));
      P[SPX] = 0.1; P[NKX] = -0.12;
      if (point) {
        P[SRX] = -1.5; P[SRZ] = -0.55 - 0.15 * k; P[ERX] = -0.1 - 0.1 * s(8);
        P[SLX] = -0.4; P[SLZ] = 0.35; P[ELX] = -0.6;
      } else {
        P[SLX] = -1.0; P[SLZ] = 0.55; P[ELX] = -2.3;
        P[SRX] = -1.2 - 0.3 * k; P[SRZ] = -0.25; P[ERX] = -0.3;
      }
      break;
    }
    case 'refPoint':
      // Free kick: the right arm straight out the way it goes, the whistle in the left hand at the mouth.
      P[SPX] = -0.02; P[NKX] = -0.05;
      P[SRX] = -1.5; P[SRZ] = -0.08; P[ERX] = -0.05;
      P[SLX] = -1.0; P[SLZ] = 0.55; P[ELX] = -2.25;
      break;
    case 'refCard':
      // The card held straight up, the other hand at the side.
      P[SPX] = -0.05; P[NKX] = -0.08;
      P[SRX] = -2.98; P[SRZ] = -0.1; P[ERX] = -0.05;
      P[SLX] = -0.1; P[SLZ] = 0.15; P[ELX] = -0.3;
      break;
    case 'refAdvantage':
      // Play on: both arms swept forward and up.
      P[SPX] = 0.05; P[NKX] = -0.05;
      P[SLX] = -1.35 + 0.08 * s(4); P[SRX] = -1.35 + 0.08 * s(4); P[SLZ] = 0.25; P[SRZ] = -0.25; P[ELX] = -0.12; P[ERX] = -0.12;
      break;
    case 'refSpot':
      // Penalty: the arm pointing down at the spot.
      P[SPX] = 0.04; P[NKX] = 0.1;
      P[SRX] = -1.05; P[SRZ] = -0.05; P[ERX] = -0.02;
      P[SLX] = -1.0; P[SLZ] = 0.55; P[ELX] = -2.25;
      break;
    case 'flagUp':
      // Assistant: the flag held straight up.
      P[SRX] = -2.98; P[SRZ] = -0.06; P[ERX] = -0.04;
      P[SLX] = -0.05; P[SLZ] = 0.12; P[ELX] = -0.25;
      break;
    case 'flagPoint':
      // Assistant: the flag held out at 45 degrees the way the throw-in or kick goes.
      P[SRX] = -2.2; P[SRZ] = -0.1; P[ERX] = -0.04;
      P[SLX] = -0.05; P[SLZ] = 0.12; P[ELX] = -0.25;
      break;
    case 'holdHand':
      // Walking out with a mascot: the right hand down and out to the side, holding the child's.
      P[SRX] = -0.12; P[SRZ] = -0.42; P[ERX] = -0.12;
      break;
    case 'mascotHand':
      // The mascot's left hand up in the player's; the other arm swinging a little.
      P[NKX] = -0.2; P[SPX] = -0.04;
      P[SLX] = -0.15; P[SLZ] = 1.5; P[ELX] = -0.25;
      P[SRX] = 0.12 * s(5.2); P[SRZ] = -0.1; P[ERX] = -0.25;
      break;
    case 'shake':
      // A handshake: the right hand forward at waist height, pumping.
      P[SRX] = -0.85 - 0.07 * s(13); P[SRZ] = -0.08; P[ERX] = -0.55;
      break;
    case 'photoStand':
      // Back row of the team photo: standing straight, arms down by the sides, chin up.
      P[SPX] = -0.05; P[NKX] = -0.1;
      P[SLX] = 0.04; P[SLZ] = 0.1; P[ELX] = -0.12;
      P[SRX] = 0.04; P[SRZ] = -0.1; P[ERX] = -0.12;
      break;
    case 'photoCrouch':
      // Front row: crouched low, forearms resting on the knees.
      P[BY] = -0.44; P[HLX] = -1.3; P[HRX] = -1.3; P[KLX] = 1.95; P[KRX] = 1.95;
      P[SPX] = 0.38; P[NKX] = -0.32;
      P[SLX] = -0.75; P[SLZ] = 0.08; P[ELX] = -0.45;
      P[SRX] = -0.75; P[SRZ] = -0.08; P[ERX] = -0.45;
      break;
    case 'board':
      // The substitution board held up over the head in both hands, facing the pitch.
      P[SPX] = -0.06; P[NKX] = -0.08;
      P[SLX] = -2.7; P[SLZ] = 0.3; P[ELX] = -0.42;
      P[SRX] = -2.7; P[SRZ] = -0.3; P[ERX] = -0.42;
      break;
    case 'stretch': {
      // Quad stretch on the touchline: heel to the backside, a hand holding the foot, then the other leg.
      const right = t % 4.4 < 2.2;
      P[SPX] = 0.06; P[NKX] = 0.1;
      if (right) { P[HRX] = 0.12; P[KRX] = 2.2; P[SRX] = 0.55; P[SRZ] = -0.12; P[ERX] = -1.0; P[SLZ] = 0.45 + 0.05 * s(2); P[ELX] = -0.3; }
      else { P[HLX] = 0.12; P[KLX] = 2.2; P[SLX] = 0.55; P[SLZ] = 0.12; P[ELX] = -1.0; P[SRZ] = -0.45 - 0.05 * s(2); P[ERX] = -0.3; }
      break;
    }
    case 'armCircle': {
      // Arm circles before going on.
      const a = t * 6.5 + seed * 6.28;
      P[SPX] = 0.02;
      P[SLX] = -1.55 + 1.45 * Math.sin(a); P[SLZ] = 0.22 + 0.25 * Math.abs(Math.cos(a)); P[ELX] = -0.1;
      P[SRX] = -1.55 + 1.45 * Math.sin(a + 0.4); P[SRZ] = -0.22 - 0.25 * Math.abs(Math.cos(a + 0.4)); P[ERX] = -0.1;
      break;
    }
    case 'clap': {
      const k = Math.abs(s(8.5));
      P[SPX] = 0.04; P[NKX] = -0.1;
      P[SLX] = -1.05; P[SLZ] = -0.32 + 0.22 * k; P[ELX] = -1.05;
      P[SRX] = -1.05; P[SRZ] = 0.32 - 0.22 * k; P[ERX] = -1.05;
      break;
    }
  }
}

/** One player's reaction this frame: the pose, how much of it shows and whether the legs join in. */
export interface ReactionFrame {
  /** Only these channels (a call in play moves just the right arm), else the whole upper body. */
  only?: readonly number[]; pose: Float32Array; w: number; full: boolean; kind: ReactionKind }

const SHOT_KICKS = new Set(['shot', 'volley', 'chip', 'placed', 'finesse', 'power']);

/** Picks and times the reactions from match events; the renderer reads `frame(id)` for each player. */
export class ReactionDirector {
  private live = new Map<number, Reaction>();
  private queue: Queued[] = [];
  private now = 0;
  private lastShot: { player: number; team: number; at: number } | null = null;
  private frames = new Map<number, ReactionFrame>();
  private rnd: () => number;

  constructor(seed = 97) {
    let s = seed;
    this.rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }

  /** Forget everything (a new match). */
  reset() {
    this.live.clear();
    this.queue = [];
    this.lastShot = null;
  }

  /** Start a reaction for one player after `delay` seconds (replacing what they were doing). */
  add(id: number, kind: ReactionKind, dur: number, delay = 0) {
    this.queue.push({ id, kind, at: this.now + delay, dur });
  }

  /** Drop what a player is doing or about to do. */
  cancel(id: number) {
    this.live.delete(id);
    this.queue = this.queue.filter((q) => q.id !== id);
  }

  private pick<T>(opts: [T, number][]): T {
    let r = this.rnd() * opts.reduce((a, [, w]) => a + w, 0);
    for (const [o, w] of opts) if ((r -= w) <= 0) return o;
    return opts[opts.length - 1][0];
  }

  private near(v: ViewState, id: number, team: number, r: number) {
    const c = v.players[id].pos;
    return v.players.filter((p) => p.id !== id && p.team === team && !p.off && Math.hypot(p.pos.x - c.x, p.pos.z - c.z) < r);
  }

  onEvents(v: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      const pid = e.player !== undefined && e.player >= 0 && e.player < v.players.length ? e.player : -1;
      switch (e.type) {
        case 'kick':
          if (pid >= 0 && (SHOT_KICKS.has(e.text ?? '') || (e.text === 'header' && Math.abs(v.players[pid].pos.x) > 36))) this.lastShot = { player: pid, team: v.players[pid].team, at: this.now };
          break;
        case 'post': case 'bar': case 'chance': case 'catch': case 'parry':
          this.missed(v, e.type === 'post' || e.type === 'bar' ? 'woodwork' : e.type === 'chance' ? 'close' : 'saved');
          break;
        case 'restart':
          if (e.text === 'goalkick') this.missed(v, 'wide');
          break;
        case 'goal':
          if (v.shootout || e.team === undefined) break;
          this.goal(v, e.team, pid);
          break;
        case 'foul':
          if (pid < 0) break;
          this.add(pid, 'protest', 2.4, 0.25);
          for (const p of this.near(v, pid, v.players[pid].team, 14)) if (this.rnd() < 0.35) this.add(p.id, 'protest', 1.8, 0.4 + this.rnd() * 0.5);
          for (const p of this.near(v, pid, 1 - v.players[pid].team, 12)) if (this.rnd() < 0.3) this.add(p.id, 'appeal', 1.3, 0.1);
          break;
        case 'card':
          if (pid < 0) break;
          if (e.text === 'yellow') { this.add(pid, 'protest', 1.5, 0.1); this.add(pid, 'handsOnHips', 2.8, 1.6); }
          else { this.add(pid, 'headInHands', 1.6, 0.1); this.add(pid, 'dejected', 4, 1.7); }
          for (const p of this.near(v, pid, v.players[pid].team, 12)) if (this.rnd() < 0.5) this.add(p.id, 'protest', 1.8, 0.3 + this.rnd() * 0.4);
          break;
        case 'offside':
          if (pid < 0) break;
          this.add(pid, this.rnd() < 0.6 ? 'protest' : 'handsOnHips', 2.2, 0.3);
          for (const p of this.near(v, pid, 1 - v.players[pid].team, 25)) if (p.role !== 'GK' && this.rnd() < 0.6) this.add(p.id, 'appeal', 1.6, this.rnd() * 0.25);
          break;
        case 'halftime':
          for (const p of v.players) if (!p.off && this.rnd() < 0.45) this.add(p.id, this.pick<ReactionKind>([['handsOnHips', 3], ['crouch', 1], ['clap', 1]]), 5 + this.rnd() * 3, 0.3 + this.rnd());
          break;
        case 'fulltime':
          this.fullTime(v);
          break;
      }
    }
  }

  /** A shot that didn't go in: the striker (and sometimes a teammate) can't believe it. */
  private missed(v: ViewState, how: 'woodwork' | 'close' | 'saved' | 'wide') {
    const s = this.lastShot;
    if (!s || this.now - s.at > 4.5) return;
    this.lastShot = null;
    const kind: ReactionKind = how === 'saved' ? this.pick([['headInHands', 2], ['handsOnHips', 1], ['crouch', 1]]) : this.pick([['headInHands', 4], ['crouch', 1]]);
    this.add(s.player, kind, how === 'saved' ? 1.8 : 2.6, how === 'saved' ? 0.5 : 0.2);
    if (how === 'woodwork' || how === 'close') {
      for (const p of this.near(v, s.player, s.team, 22)) if (this.rnd() < 0.4) this.add(p.id, 'headInHands', 2, 0.3 + this.rnd() * 0.4);
    }
  }

  private goal(v: ViewState, team: number, scorer: number) {
    this.lastShot = null;
    // The scoring side: claps, fist pumps and high fives near the scorer (the scorer has his own celebration).
    for (const p of v.players) {
      if (p.off || p.id === scorer) continue;
      if (p.team === team) {
        const close = scorer >= 0 && Math.hypot(p.pos.x - v.players[scorer].pos.x, p.pos.z - v.players[scorer].pos.z) < 26;
        if (close || p.role === 'GK' || this.rnd() < 0.4) this.add(p.id, this.pick<ReactionKind>(close ? [['highFive', 3], ['fistPump', 3], ['clap', 2], ['armsUp', 2]] : [['fistPump', 2], ['clap', 2], ['armsUp', 1]]), 3 + this.rnd() * 3, 0.2 + this.rnd() * 0.8);
      } else {
        // The side that conceded.
        this.add(p.id, p.role === 'GK' ? this.pick<ReactionKind>([['crouch', 2], ['dejected', 1], ['protest', 1]]) : this.pick<ReactionKind>([['handsOnHips', 4], ['dejected', 3], ['headInHands', 2], ['crouch', 2]]), 4 + this.rnd() * 4, 0.3 + this.rnd() * 0.9);
      }
    }
  }

  private fullTime(v: ViewState) {
    const diff = v.score[0] - v.score[1];
    for (const p of v.players) {
      if (p.off) continue;
      const res = diff === 0 ? 0 : (diff > 0) === (p.team === 0) ? 1 : -1;
      const kind = res > 0 ? this.pick<ReactionKind>([['armsUp', 3], ['clap', 3], ['fistPump', 2], ['highFive', 1]])
        : res < 0 ? this.pick<ReactionKind>([['crouch', 3], ['dejected', 3], ['handsOnHips', 2], ['headInHands', 1]])
        : this.pick<ReactionKind>([['handsOnHips', 3], ['clap', 2], ['crouch', 1]]);
      this.add(p.id, kind, 12 + this.rnd() * 10, 0.2 + this.rnd() * 1.2);
    }
  }

  /** Keep a short reaction going for a player who isn't already reacting (calling for the ball). */
  hold(id: number, kind: ReactionKind, dur: number) {
    const r = this.live.get(id);
    if (r && r.kind !== kind) return;
    if (r) { r.dur = Math.max(r.dur, r.t + dur); return; }
    this.live.set(id, { kind, t: 0, dur, seed: this.rnd() });
  }

  /** Advance the clock (paused while cinematics play). */
  update(dt: number) {
    this.now += dt;
    for (const q of this.queue) if (q.at <= this.now) this.live.set(q.id, { kind: q.kind, t: 0, dur: q.dur, seed: this.rnd() });
    this.queue = this.queue.filter((q) => q.at > this.now);
    for (const [id, r] of this.live) {
      r.t += dt;
      if (r.t >= r.dur) this.live.delete(id);
    }
  }

  /** Whether anyone is reacting (or about to). */
  get busy() {
    return this.live.size > 0 || this.queue.length > 0;
  }

  /** This frame's reaction for player `id`, or null. */
  frame(id: number): ReactionFrame | null {
    const r = this.live.get(id);
    if (!r) return null;
    let f = this.frames.get(id);
    if (!f) { f = { pose: new Float32Array(17), w: 0, full: false, kind: r.kind }; this.frames.set(id, f); }
    f.kind = r.kind;
    f.pose.fill(0);
    reactionPose(r.kind, r.t, r.seed, f.pose);
    const ein = Math.min(1, r.t / 0.3), eout = Math.min(1, (r.dur - r.t) / 0.45);
    const e = Math.min(ein, eout);
    f.w = e * e * (3 - 2 * e);
    f.full = FULL.has(r.kind);
    f.only = r.kind === 'call' || r.kind === 'holdHand' || r.kind === 'shake' || r.kind === 'grabR' || r.kind === 'fendR' ? CALL_CHANNELS
      : r.kind === 'grabL' || r.kind === 'fendL' ? LEFT_CHANNELS : undefined;
    return f;
  }

  /** Which reaction a player is showing (tests and screenshots). */
  kindOf(id: number): ReactionKind | null {
    return this.live.get(id)?.kind ?? null;
  }
}
