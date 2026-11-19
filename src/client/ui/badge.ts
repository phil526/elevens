// Club crests as inline SVG: a shape in the club colour with a trim, and an emblem or the club's
// initials. Built-in clubs get one from their kit colours (badgeFor); creator clubs choose theirs.

import { badgeFor, type Badge, type BadgeEmblem, type BadgeShape, type TeamDef } from '../../shared/teams';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export const SHAPES: Record<BadgeShape, string> = {
  shield: 'M50 4 L92 16 V52 C92 76 72 90 50 98 C28 90 8 76 8 52 V16 Z',
  round: 'M50 4 A46 46 0 1 1 49.9 4 Z',
  crest: 'M14 6 H86 V58 C86 80 66 92 50 98 C34 92 14 80 14 58 Z',
  diamond: 'M50 2 L96 50 L50 98 L4 50 Z',
  hex: 'M50 3 L92 27 V73 L50 97 L8 73 V27 Z',
};

export const EMBLEMS: Record<Exclude<BadgeEmblem, 'letters'>, string> = {
  star: '<path d="M50 24 L57 42 L76 42 L61 54 L67 73 L50 61 L33 73 L39 54 L24 42 L43 42 Z"/>',
  ball: '<circle cx="50" cy="50" r="22" fill="none" stroke-width="5"/><path d="M50 37 L61 45 L57 58 L43 58 L39 45 Z"/>',
  bird: '<path d="M22 48 C34 36 44 40 50 48 C56 38 68 32 80 36 C70 40 64 48 62 56 C58 66 46 70 36 64 L28 70 L32 60 C28 58 24 54 22 48 Z"/>',
  crown: '<path d="M24 66 L24 36 L37 50 L50 30 L63 50 L76 36 L76 66 Z"/><rect x="24" y="68" width="52" height="7"/>',
  anchor: '<circle cx="50" cy="28" r="6" fill="none" stroke-width="5"/><rect x="47" y="33" width="6" height="40"/><rect x="36" y="42" width="28" height="5"/><path d="M26 56 C28 72 42 78 50 78 C58 78 72 72 74 56 L68 60 C66 68 58 72 50 72 C42 72 34 68 32 60 Z"/>',
  tree: '<path d="M50 20 L70 46 H60 L74 64 H26 L40 46 H30 Z"/><rect x="46" y="64" width="8" height="14"/>',
  flame: '<path d="M50 20 C58 34 70 40 68 58 C66 72 58 78 50 78 C40 78 32 70 32 58 C32 48 40 42 42 32 C46 40 46 46 50 50 C54 42 52 30 50 20 Z"/>',
  bolt: '<path d="M56 18 L30 54 H48 L42 82 L70 44 H52 Z"/>',
  wave: '<path d="M18 46 C28 36 38 36 46 46 C54 56 64 56 74 46 L82 46 L82 56 C72 66 62 66 54 56 C46 46 36 46 26 56 L18 56 Z"/><path d="M18 62 C28 52 38 52 46 62 C54 72 64 72 74 62 L82 62 L82 70 C72 80 62 80 54 70 C46 60 36 60 26 70 L18 70 Z"/>',
  tower: '<path d="M34 78 V40 H30 V26 H38 V32 H45 V26 H55 V32 H62 V26 H70 V40 H66 V78 Z"/><rect x="45" y="56" width="10" height="22" fill="#0006"/>',
  stripes: '<rect x="28" y="20" width="10" height="62"/><rect x="45" y="20" width="10" height="62"/><rect x="62" y="20" width="10" height="62"/>',
};

/** A crest as an SVG string, `size` px square. */
export function badgeSvg(b: Badge, abbr = '', size = 40): string {
  const shape = SHAPES[b.shape] ?? SHAPES.shield;
  const fg = hex(b.fg), bg = hex(b.bg), trim = hex(b.trim);
  const emblem = b.emblem === 'letters' || !EMBLEMS[b.emblem as Exclude<BadgeEmblem, 'letters'>]
    ? `<text x="50" y="${abbr.length > 2 ? 60 : 64}" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="900" font-size="${abbr.length > 2 ? 26 : 34}" fill="${fg}">${abbr.replace(/[<&>"]/g, '')}</text>`
    : `<g fill="${fg}" stroke="${fg}" stroke-width="0">${EMBLEMS[b.emblem as Exclude<BadgeEmblem, 'letters'>]}</g>`;
  return `<svg class="crest" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><path d="${shape}" fill="${bg}" stroke="${trim}" stroke-width="5" stroke-linejoin="round"/>${emblem}</svg>`;
}

/** A club's crest. */
export function clubBadge(t: TeamDef, size = 40): string {
  return badgeSvg(badgeFor(t), t.abbr, size);
}
