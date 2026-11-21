// Button icons (21 Nov 2026): controller buttons are drawn as the real thing instead of plain
// letters: Xbox face buttons as coloured A/B/X/Y discs, PlayStation as the cross, circle, square
// and triangle in their colours, bumpers and triggers as their shapes, sticks as rings. Keyboard
// keys stay key caps. Used by the button hints, the controls list, loading tips, the tutorial
// coach, the one-time tips and the Controls menu.

import type { PadStyle } from '../input/gamepad';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The kind of glyph a controller label gets: face button (with its colour key), shoulder, trigger, stick, small, or plain. */
export function padGlyphKind(label: string): { kind: 'face' | 'bumper' | 'trigger' | 'stick' | 'small' | 'plain'; key: string } {
  switch (label) {
    case 'A': return { kind: 'face', key: 'xa' };
    case 'B': return { kind: 'face', key: 'xb' };
    case 'X': return { kind: 'face', key: 'xx' };
    case 'Y': return { kind: 'face', key: 'xy' };
    case '✕': return { kind: 'face', key: 'pcross' };
    case '○': return { kind: 'face', key: 'pcircle' };
    case '□': return { kind: 'face', key: 'psquare' };
    case '△': return { kind: 'face', key: 'ptriangle' };
    case 'LB': case 'RB': case 'L1': case 'R1': return { kind: 'bumper', key: '' };
    case 'LT': case 'RT': case 'L2': case 'R2': return { kind: 'trigger', key: '' };
    case 'LS': case 'RS': case 'L3': case 'R3': case 'R stick': case 'L stick': return { kind: 'stick', key: '' };
    case 'View': case 'Menu': case 'Create': case 'Options': case 'Xbox': case 'PS': return { kind: 'small', key: '' };
    default: return { kind: 'plain', key: '' };
  }
}

/** One controller button as an icon. Several buttons ("LB/RB") become several icons. */
export function padKey(label: string, style: PadStyle = 'xbox'): string {
  if (!label || label === '—') return '<span class="unbound">none</span>';
  if (label.includes('/') && !label.startsWith('Axes')) return label.split('/').map((l) => padKey(l, style)).join('');
  const g = padGlyphKind(label);
  if (style === 'generic' || g.kind === 'plain') return `<kbd>${esc(label)}</kbd>`;
  const text = label === 'R stick' ? 'R' : label === 'L stick' ? 'L' : label;
  return `<kbd class="pad pad-${g.kind}${g.key ? ` pad-${g.key}` : ''}" title="${esc(label)}" aria-label="${esc(label)}">${esc(text)}</kbd>`;
}

/** A keyboard key (or mouse button) as a key cap. */
export function keyCap(label: string): string {
  if (!label || label === '—') return '<span class="unbound">none</span>';
  return `<kbd class="key">${esc(label)}</kbd>`;
}
