// Goalkeeper handling poses in the procedural solver's channels (shared by the classic and the
// realistic players): catches of every height, hands rising to meet a ball before it arrives,
// standing parries, and the one-handed overarm throw and underarm roll.

// Pose channels, the same numbers as player.ts (which imports this file, so they are repeated here;
// tests/keeperpose.test.ts checks they match).
export const KP_CH = { BY: 0, BRZ: 1, SPX: 2, HLX: 3, HLZ: 4, KLX: 5, HRX: 6, HRZ: 7, KRX: 8, SLX: 9, SLZ: 10, ELX: 11, SRX: 12, SRZ: 13, ERX: 14, NKX: 15 } as const;
const { BY, BRZ, SPX, HLX, HLZ, KLX, HRX, HRZ, KRX, SLX, SLZ, ELX, SRX, SRZ, ERX, NKX } = KP_CH;

export type CatchStyle = 'scoop' | 'kneel' | 'waist' | 'chest' | 'head' | 'high' | 'smother';

/** How long each catch takes, from the moment the ball is in the gloves to holding it at the chest. */
export const CATCH_DUR: Record<CatchStyle, number> = { scoop: 0.8, kneel: 0.95, waist: 0.6, chest: 0.55, head: 0.65, high: 0.85, smother: 1.3 };

/**
 * Which catch, by the ball's height when it reaches the keeper: a low ball is gathered with a stoop
 * (or, when it is hit hard, behind a kneeling long barrier), then a basket catch at the waist, a
 * chest catch, a W catch in front of the face, and a jumping catch above the head. A keeper
 * coming out fast for a ball at someone's feet smothers it on his side.
 */
export function catchStyleFor(ballY: number, ballSpeed: number, keeperSpeed: number): CatchStyle {
  if (keeperSpeed > 2.5 && ballY < 0.6) return 'smother';
  if (ballY < 0.42) return ballSpeed > 13 ? 'kneel' : 'scoop';
  if (ballY < 1.05) return 'waist';
  if (ballY < 1.5) return 'chest';
  if (ballY < 2.0) return 'head';
  return 'high';
}

type Pose = [number, number][];
const ease = (t: number) => { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ball held into the chest, standing: where every catch ends. */
const HOLD: Pose = [[BY, 0], [SPX, 0.12], [HLX, -0.1], [HRX, -0.1], [KLX, 0.15], [KRX, 0.15], [HLZ, 0.05], [HRZ, -0.05], [SLX, -0.3], [SRX, -0.3], [ELX, -1.25], [ERX, -1.25], [SLZ, 0.22], [SRZ, -0.22], [NKX, 0.15], [BRZ, 0]];

/** The moment of contact for each catch. */
const CONTACT: Record<Exclude<CatchStyle, 'smother'>, Pose> = {
  // Legs together, bend at the waist, palms behind the ball on the grass.
  scoop: [[BY, -0.42], [SPX, 1.05], [HLX, -1.25], [HRX, -1.25], [KLX, 1.45], [KRX, 1.45], [HLZ, 0.02], [HRZ, -0.02], [SLX, -0.55], [SRX, -0.55], [SLZ, 0.12], [SRZ, -0.12], [ELX, -0.2], [ERX, -0.2], [NKX, -0.35], [BRZ, 0]],
  // Long barrier: down on the right knee with the shin across the line, left knee up, hands in front.
  kneel: [[BY, -0.5], [SPX, 0.55], [HLX, -1.35], [KLX, 1.45], [HLZ, 0.12], [HRX, 0.15], [KRX, 1.75], [HRZ, -0.3], [SLX, -0.55], [SRX, -0.55], [ELX, -0.15], [ERX, -0.15], [SLZ, 0.1], [SRZ, -0.1], [NKX, -0.3], [BRZ, 0]],
  // Basket: forearms under the ball, scooping it into the stomach as the body folds over it.
  waist: [[BY, -0.08], [SPX, 0.5], [HLX, -0.4], [HRX, -0.4], [KLX, 0.45], [KRX, 0.45], [HLZ, 0.05], [HRZ, -0.05], [SLX, -0.75], [SRX, -0.75], [ELX, -1.0], [ERX, -1.0], [SLZ, 0.15], [SRZ, -0.15], [NKX, -0.1], [BRZ, 0]],
  // Chest: arms out in front, then cushioned back into the chest.
  chest: [[BY, -0.03], [SPX, 0.1], [HLX, -0.15], [HRX, -0.15], [KLX, 0.25], [KRX, 0.25], [HLZ, 0.05], [HRZ, -0.05], [SLX, -1.45], [SRX, -1.45], [ELX, -0.55], [ERX, -0.55], [SLZ, 0.25], [SRZ, -0.25], [NKX, 0], [BRZ, 0]],
  // W catch: hands up in front of the face, thumbs together, elbows out.
  head: [[BY, 0], [SPX, -0.05], [HLX, -0.12], [HRX, -0.12], [KLX, 0.2], [KRX, 0.2], [HLZ, 0.05], [HRZ, -0.05], [SLX, -2.35], [SRX, -2.35], [ELX, -1.0], [ERX, -1.0], [SLZ, 0.4], [SRZ, -0.4], [NKX, -0.15], [BRZ, 0]],
  // High: jumping off one foot, the other knee up for protection, arms at full stretch overhead.
  high: [[BY, 0.38], [SPX, -0.08], [HLX, -0.95], [KLX, 1.3], [HLZ, 0.05], [HRX, 0.05], [KRX, 0.35], [HRZ, -0.05], [SLX, -2.95], [SRX, -2.95], [ELX, -0.25], [ERX, -0.25], [SLZ, 0.18], [SRZ, -0.18], [NKX, -0.25], [BRZ, 0]],
};

/** Smother, lying on one side curled round the ball (side +1 rolls to the keeper's left). */
const SMOTHER: Pose = [[BY, 0.2], [SPX, 0.35], [HLX, -0.9], [KLX, 1.2], [HLZ, 0], [HRX, -0.7], [KRX, 1.0], [HRZ, 0], [SLX, -1.5], [SRX, -1.5], [ELX, -1.4], [ERX, -1.4], [SLZ, 0.2], [SRZ, -0.2], [NKX, 0.2]];

function put(X: Float32Array, pose: Pose) { for (const [c, v] of pose) X[c] = v; }
function blend(X: Float32Array, a: Pose, b: Pose, k: number) {
  const m = new Map(b);
  for (const [c, v] of a) X[c] = lerp(v, m.get(c) ?? v, k);
}
/** Swap left and right legs (for a long barrier on the other knee). */
function mirrorLegs(X: Float32Array) {
  const [hl, kl, hlz] = [X[HLX], X[KLX], X[HLZ]];
  X[HLX] = X[HRX]; X[KLX] = X[KRX]; X[HLZ] = -X[HRZ];
  X[HRX] = hl; X[KRX] = kl; X[HRZ] = -hlz;
}

/** The catch as the hands come to meet the ball (k 0..1, 1 at contact), over a standing pose already in X. */
export function anticipatePose(X: Float32Array, style: CatchStyle, k: number, side: number) {
  if (style === 'smother') return;
  const c = CONTACT[style];
  const e = ease(k);
  for (const [ch, v] of c) X[ch] = lerp(X[ch], v, e);
  if (style === 'high') X[BY] = 0.38 * e * e; // the jump rises into the catch
  if (style === 'kneel' && side < 0) mirrorLegs(X);
}

/** The catch itself, u 0 (ball in the gloves) to 1 (held at the chest, standing). */
export function catchPose(X: Float32Array, style: CatchStyle, u: number, side: number) {
  if (style === 'smother') {
    // Down onto the side in the first fifth, curled round the ball, then up through a kneel.
    const down = ease(u / 0.2), up = ease((u - 0.55) / 0.45);
    // Starts stooped at the ball (it is taken low), goes down on the side, then gets up.
    if (up <= 0) blend(X, CONTACT.scoop, SMOTHER, down);
    else blend(X, SMOTHER, HOLD, up);
    X[BRZ] = side * 1.3 * down * (1 - up);
    if (up > 0 && up < 1) { X[BY] = lerp(X[BY], -0.35, Math.sin(Math.PI * up)); X[KLX] += 0.9 * Math.sin(Math.PI * up); X[KRX] += 0.9 * Math.sin(Math.PI * up); X[HLX] -= 0.6 * Math.sin(Math.PI * up); }
    return;
  }
  const c = CONTACT[style];
  if (style === 'high') {
    // Arms bring the ball down as the keeper falls back to the grass and lands on bent knees.
    put(X, c);
    const fall = Math.min(1, u / 0.4);
    const arms = ease((u - 0.1) / 0.5), legs = ease((u - 0.3) / 0.7);
    blend(X, c, HOLD, arms);
    X[BY] = u < 0.4 ? 0.38 * (1 - fall * fall) : -0.12 * Math.sin(Math.PI * Math.min(1, (u - 0.4) / 0.5));
    X[HLX] = lerp(-0.95, -0.1, legs); X[KLX] = lerp(1.3, 0.15, legs) + (u > 0.4 ? 0.5 * Math.sin(Math.PI * Math.min(1, (u - 0.4) / 0.5)) : 0);
    X[HRX] = lerp(0.05, -0.1, legs); X[KRX] = lerp(0.35, 0.15, legs) + (u > 0.4 ? 0.5 * Math.sin(Math.PI * Math.min(1, (u - 0.4) / 0.5)) : 0);
    return;
  }
  const hold = style === 'kneel' ? 0.35 : style === 'scoop' ? 0.2 : 0.08;
  const k = ease((u - hold) / (1 - hold));
  blend(X, c, HOLD, k);
  const mid = Math.sin(Math.PI * k);
  if (style === 'scoop' || style === 'kneel') { X[ELX] -= 0.6 * mid; X[ERX] -= 0.6 * mid; } // curl the ball up the shins into the chest
  if (style === 'waist' || style === 'chest') { X[SPX] += 0.25 * Math.sin(Math.PI * Math.min(1, u / 0.6)); X[BY] -= 0.05 * mid; } // cushion it
  if (style === 'kneel' && side < 0) mirrorLegs(X);
}

/** Standing parry: palms pushed out at the ball's height, then recovered (u 0..1 over about 0.4 s). */
export function parryPose(X: Float32Array, ballY: number, u: number, w: number) {
  const k = Math.sin(Math.PI * Math.min(1, u)) * w;
  const raise = -(0.9 + Math.min(2.0, Math.max(0, ballY)) * 0.75);
  X[SLX] = lerp(X[SLX], raise, k); X[SRX] = lerp(X[SRX], raise, k);
  X[ELX] = lerp(X[ELX], -0.1, k); X[ERX] = lerp(X[ERX], -0.1, k);
  X[SLZ] = lerp(X[SLZ], 0.12, k); X[SRZ] = lerp(X[SRZ], -0.12, k);
  X[SPX] = lerp(X[SPX], ballY < 0.6 ? 0.6 : 0.05, k);
  X[BY] = lerp(X[BY], ballY < 0.6 ? -0.15 : ballY > 2 ? 0.15 : 0, k);
}

/**
 * One-handed overarm throw (right hand). Wind-up: the left foot steps towards the target, the left
 * arm points at it and the throwing arm swings back behind the body; then the arm comes over the
 * top, straight, released in front of the head; the follow-through carries it down across the body
 * as the back leg swings through.
 */
export function overarmPose(X: Float32Array, t: number, w: number) {
  if (t < w) {
    const k = t / w;
    const a = ease(k / 0.55), b = ease((k - 0.55) / 0.45);
    X[SRX] = lerp(lerp(-0.3, 0.75, a), 3.75, b); X[ERX] = lerp(lerp(-1.25, -0.3, a), -0.1, b); X[SRZ] = lerp(-0.2, -0.35, a) + 0.2 * b;
    X[SLX] = lerp(lerp(-0.3, -1.6, a), -0.6, b); X[ELX] = lerp(lerp(-1.25, -0.15, a), -1.0, b); X[SLZ] = lerp(lerp(0.2, 0.05, a), 0.3, b);
    X[HLX] = lerp(-0.1, -0.5, a); X[KLX] = lerp(0.15, 0.3, a); X[HRX] = lerp(-0.1, 0.32, a); X[KRX] = lerp(0.15, 0.3, a);
    X[SPX] = lerp(lerp(0.12, -0.22, a), 0.22, b); X[NKX] = lerp(0.1, -0.1, a);
    X[BY] = -0.05 * a; X[HLZ] = 0.06; X[HRZ] = -0.06;
  } else {
    const f = ease((t - w) / 0.3);
    X[SRX] = lerp(3.75, 5.3, f); X[ERX] = lerp(-0.1, -0.35, f); X[SRZ] = lerp(-0.15, 0.25, f);
    X[SLX] = lerp(-0.6, -0.2, f); X[ELX] = lerp(-1.0, -0.6, f); X[SLZ] = 0.3;
    X[HLX] = lerp(-0.5, -0.35, f); X[KLX] = lerp(0.3, 0.4, f); X[HRX] = lerp(0.32, -0.3, f); X[KRX] = lerp(0.3, 0.55, f);
    X[SPX] = lerp(0.22, 0.45, f); X[NKX] = -0.1 + 0.15 * f; X[BY] = lerp(-0.05, -0.1, f); X[HLZ] = 0.06; X[HRZ] = -0.06;
  }
}

/**
 * Underarm roll (right hand), bowled along the grass: down into a crouch on the right knee with
 * the left leg forward, the arm swings back and through low, releasing the ball by the front foot,
 * the left arm out for balance; then up again.
 */
export function rollPose(X: Float32Array, t: number, w: number) {
  const down = ease(t / (w * 0.8));
  const up = ease((t - w - 0.12) / 0.28);
  const crouch = down * (1 - up);
  X[BY] = -0.42 * crouch; X[SPX] = lerp(0.12, 0.7, crouch); X[NKX] = lerp(0.1, -0.3, crouch);
  X[HLX] = lerp(-0.1, -1.15, crouch); X[KLX] = lerp(0.15, 1.35, crouch); X[HLZ] = 0.08;
  X[HRX] = lerp(-0.1, 0.25, crouch); X[KRX] = lerp(0.15, 1.5, crouch); X[HRZ] = -0.12 * crouch;
  X[SLX] = lerp(-0.3, -0.5, down); X[SLZ] = lerp(0.22, 0.65, down); X[ELX] = lerp(-1.25, -0.4, down);
  if (t < w) {
    const k = t / w;
    const back = ease(k / 0.6), through = ease((k - 0.6) / 0.4);
    X[SRX] = lerp(lerp(-0.3, 0.95, back), -0.35, through); X[ERX] = lerp(-1.25, -0.1, back); X[SRZ] = -0.15;
  } else {
    const f = ease((t - w) / 0.25);
    X[SRX] = lerp(-0.35, -1.3, f); X[ERX] = lerp(-0.1, -0.3, f); X[SRZ] = -0.15;
  }
}
