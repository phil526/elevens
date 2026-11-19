// Accessibility helpers (19 Nov 2026): colour-blind-safe kits and text size.
//
// Kits: the two sides' kits are compared as a person with that kind of colour blindness would
// see them (Machado et al. 2009 simulation, full strength). If the shirts or shorts are too close,
// the computer side changes to whichever of its kits, or a plain change kit, stands furthest apart.

import type { Kit, TeamDef } from '../shared/teams';

export type ColourVision = 'off' | 'protan' | 'deutan' | 'tritan';
export const COLOUR_VISION: [ColourVision, string][] = [['off', 'Off'], ['protan', 'Red-weak'], ['deutan', 'Green-weak'], ['tritan', 'Blue-weak']];

const M: Record<Exclude<ColourVision, 'off'>, number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const unlin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

/** A colour as seen with this kind of colour vision (0xRRGGBB in, [r, g, b] 0..255 out). */
export function simulate(c: number, mode: ColourVision): [number, number, number] {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  if (mode === 'off') return [r, g, b];
  const m = M[mode];
  const R = lin(r), G = lin(g), B = lin(b);
  const out = [m[0] * R + m[1] * G + m[2] * B, m[3] * R + m[4] * G + m[5] * B, m[6] * R + m[7] * G + m[8] * B];
  return out.map((v) => Math.max(0, Math.min(255, unlin(Math.min(1, v))))) as [number, number, number];
}

/** How far apart two colours look (0..441, plain RGB distance after the simulation). */
export function seenDistance(a: number, b: number, mode: ColourVision = 'off'): number {
  const x = simulate(a, mode), y = simulate(b, mode);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** How well two kits stand apart: mostly the shirts, then the shorts. */
export function kitContrast(a: Kit, b: Kit, mode: ColourVision = 'off'): number {
  const shirt = seenDistance(a.shirt, b.shirt, mode);
  return Math.min(shirt, 0.75 * shirt + 0.25 * seenDistance(a.shorts, b.shorts, mode));
}

/** Plain change kits for when neither of a club's own kits stands out. */
export const CHANGE_KITS: Kit[] = [
  { shirt: 0xf4f4f4, sleeves: 0xf4f4f4, shorts: 0xf4f4f4, socks: 0xf4f4f4, number: 0x111111, keeper: 0x1f9d55 },
  { shirt: 0x141414, sleeves: 0x141414, shorts: 0x141414, socks: 0x141414, number: 0xf4f4f4, keeper: 0xf2b705 },
  { shirt: 0xf2d21b, sleeves: 0xf2d21b, shorts: 0x141414, socks: 0xf2d21b, number: 0x141414, keeper: 0x2f6fde },
  { shirt: 0x123a8c, sleeves: 0x123a8c, shorts: 0xf4f4f4, socks: 0x123a8c, number: 0xffffff, keeper: 0xe8742a },
];

/** Enough contrast: normal vision keeps the clubs' own kits unless they really clash. */
const ENOUGH = 120;

/**
 * The opponent's kit for this match: their chosen kit if it stands apart from yours for this
 * colour vision, else their other kit, else the change kit that stands furthest apart.
 * Returns the kit and whether it is one of the club's own ('home' | 'away') or a change kit.
 */
export function pickOppKit(mine: Kit, opp: TeamDef, want: 'home' | 'away', mode: ColourVision): { kit: Kit; which: 'home' | 'away' | 'change' } {
  const other = want === 'home' ? 'away' : 'home';
  if (kitContrast(mine, opp[want], mode) >= ENOUGH) return { kit: opp[want], which: want };
  if (kitContrast(mine, opp[other], mode) >= ENOUGH) return { kit: opp[other], which: other };
  const options: { kit: Kit; which: 'home' | 'away' | 'change' }[] = [
    { kit: opp[want], which: want }, { kit: opp[other], which: other },
    ...CHANGE_KITS.map((k) => ({ kit: { ...k, keeper: opp[want].keeper }, which: 'change' as const })),
  ];
  let best = options[0], bs = -1;
  for (const o of options) {
    const c = kitContrast(mine, o.kit, mode) + (o.which === 'change' ? -20 : 0); // prefer the club's own kit when it is nearly as good
    if (c > bs) { bs = c; best = o; }
  }
  return best;
}

export type TextSize = 'normal' | 'large' | 'xl';
export const TEXT_ZOOM: Record<TextSize, number> = { normal: 1, large: 1.18, xl: 1.36 };

/** Menu and on-screen text size: scales menus, the score bug, player card and messages. */
export function applyTextSize(size: TextSize | undefined) {
  if (typeof document === 'undefined') return;
  const z = TEXT_ZOOM[size ?? 'normal'] ?? 1;
  document.documentElement.style.setProperty('--ui-zoom', String(z));
  document.body.classList.toggle('text-big', z > 1);
}

/** Hold times: how long a kick takes to charge fully, as a multiple of the normal time. */
export type ChargeSpeed = 'normal' | 'slow' | 'slower';
export const CHARGE_SCALE: Record<ChargeSpeed, number> = { normal: 1, slow: 1.5, slower: 2 };
