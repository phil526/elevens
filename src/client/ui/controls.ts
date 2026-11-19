// Control reference tables (shown in menus, pause and the in-match overlay).

import { defaultBindings, keyLabel, keysText, mouseAsKeys, type BindAction, type ControlBindings } from '../input/bindings';
import { padLabels, type PadStyle } from '../input/gamepad';

// Keyboard column: {k:x} = every key bound to x ("K or Space"), {k1:x} = its first key. Controller column: {x}.
const ROWS: [string, string, string, string][] = [
  ['Move', '{move}', 'Left stick / D-pad', 'Left virtual stick'],
  ['Sprint', '{k:sprint}', '{sprint}', 'SPRINT (hold)'],
  ['Pass (tap: near teammate, hold: far) / tackle', '{k:pass}', '{pass}', 'PASS / TACKLE'],
  ['Shoot (hold, release) / tackle', '{k:shoot}', '{shoot}', 'SHOOT (hold) / TACKLE'],
  ['Lofted pass / cross · slide tackle', '{k:lob}', '{lob}', 'LOB · SLIDE (defending)'],
  ['Through ball · teammate contain (hold)', '{k:through}', '{through}', 'THROUGH · CONTAIN (defending, hold)'],
  ['Chip shot', 'Hold {k1:lob} + shoot', 'Hold {lob} + {shoot}', 'Hold LOB + SHOOT'],
  ['Low driven shot', 'Hold {k1:through} + shoot', 'Hold {through} + {shoot}', 'Hold THROUGH + SHOOT'],
  ['Modifier: finesse shot, driven pass, lofted through ball · jockey', '{k:jockey} (hold)', '{jockey} (hold)', 'JOCKEY (defending)'],
  ['Finesse shot (curled into the far corner)', 'Hold {k1:jockey} + shoot', 'Hold {jockey} + {shoot}', 'Hold SHIELD + SHOOT'],
  ['Power shot (hard and high, slower to strike)', 'Hold {k1:jockey} + {k1:sprint} + shoot', 'Hold {jockey} + {sprint} + {shoot}', 'Hold SHIELD + SPRINT + SHOOT'],
  ['Placed shot (side-foot, accurate, less pace)', 'Hold {k1:shoot}, tap {k1:switch}', 'Hold {shoot}, tap {switch}', '—'],
  ['Whipped cross (from wide, also early)', 'Hold {k1:jockey} + {k1:lob}', 'Hold {jockey} + {lob}', 'Hold SHIELD + LOB'],
  ['Low cross (from wide)', 'Hold {k1:jockey} + {k1:pass}', 'Hold {jockey} + {pass}', 'Hold SHIELD + PASS'],
  ['Keeper has the ball: roll out · throw · drop-kick · punt (stick aims, hold for distance)', '{k1:pass} · {k1:lob} · {k1:through} · {k1:shoot}', '{pass} · {lob} · {through} · {shoot}', 'PASS · LOB · THROUGH · SHOOT'],
  ['First touch', 'Hold a direction as the ball arrives (+ {k1:sprint} to push it ahead)', 'Hold the stick as the ball arrives (+ {sprint} to push it ahead)', 'Hold the stick as the ball arrives'],
  ['Skill move: forward knock-on · sideways step-over (press again to chain) · diagonally back roulette · straight back drag-back', '{k:skill} + direction', 'Flick {flick} that way, or click {skill}', 'SKILL + stick'],
  ['Advanced skills: forward elastico · sideways ball roll · back drag-back turn', 'Hold {k1:jockey} + {k1:skill} + direction', 'Hold {jockey} + flick {flick}', '—'],
  ['Tactical foul: pull back a runner on the break (usually a booking)', 'Hold {k1:jockey} + {k1:lob} (defending)', 'Hold {jockey} + {lob} (defending)', '—'],
  ['Free kick: bend (stick across) and dip (stick forward) the shot', 'Hold {k1:jockey} + move', 'Hold {jockey} + stick', '—'],
  ['Fake shot (cut the ball across)', 'Hold {k1:shoot}, tap {k1:pass}', 'Hold {shoot}, tap {pass}', 'Hold SHOOT, tap PASS'],
  ['Jockey: no direction holds goal-side of the carrier · + sprint for a quicker shuffle', '{k:jockey} (hold)', '{jockey} (hold)', 'JOCKEY (hold)'],
  ['Switch player (nearest) · with the ball: call a run in behind', '{k:switch}', '{switch}', 'SWITCH (defending)'],
  ['Take control of your keeper (defending) · press again to hand him back', '{k:skill} or {k:keeper}', 'Click {skill}', 'KEEPER (defending)'],
  ['Your keeper: move with the stick · dive (stick picks the side) · come off the line / smother', '{k1:shoot} · {k1:pass}', '{shoot} · {pass}', 'DIVE · COME OUT'],
  ['Defending a free kick: shift the wall · men in the wall · jump', 'Move · {k1:switch} · {k1:shoot}', 'Stick · {switch} · {shoot}', 'Stick · ADD MAN · JUMP'],
  ['Throw-in: short to feet · long · down the line', '{k1:pass} · {k1:lob} · {k1:through}', '{pass} · {lob} · {through}', 'PASS · LOB · THROUGH'],
  ['Throw-in in their third: long throw into the box', '{k1:switch}', '{switch}', '—'],
  ['Next game plan (Park the bus, Counter, Balanced, High press, All-out attack)', '{k:plan}', '{plan}', 'Pause → Game plan'],
  ['Team press (defending)', '{k:teamPress}', '{teamPress}', 'PRESS (defending)'],
  ['Offside trap (defending)', '{k:trap}', '{trap}', 'TRAP (defending)'],
  ['Switch to a chosen player (defending)', 'Click them', 'Flick {flick} towards them', 'Tap them'],
  ['Sprint burst', 'Press {k1:sprint} from a jog', 'Press {sprint} from a jog', 'Press SPRINT from a jog'],
  ['Pause / menu', '{k:pause}', '{pause}', '❚❚ button'],
  ['Controls overlay', '{k:help}', '{help}', 'Pause → Controls'],
  ['Instant replay', 'Pause → Instant replay', 'Pause → Instant replay', 'Pause → Instant replay'],
];

const kbd = (l: string) => `<kbd>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</kbd>`;

/** Keyboard text for an action: every key ("K or Space"), or only the first. */
export function keysHtml(b: ControlBindings, action: BindAction, firstOnly = false): string {
  const l = keysText(b, action);
  if (!l.length) return '<span class="unbound">none</span>';
  return (firstOnly ? l.slice(0, 1) : l).map(kbd).join(' or ');
}

function moveHtml(b: ControlBindings): string {
  const dirs: BindAction[] = ['up', 'left', 'down', 'right'];
  const set = (i: number) => dirs.map((d) => (b.keys[d][i] ? kbd(keyLabel(b.keys[d][i])) : '')).join('');
  const a = set(0);
  const c = set(1);
  return a && c ? `${a} / ${c}` : a || c || '<span class="unbound">none</span>';
}

/** Fills the {…} tokens of a keyboard or controller cell. */
function fillCell(s: string, b: ControlBindings, style: PadStyle): string {
  const pad = padLabels(style, b);
  return s.replace(/\{(k1?:)?(\w+)\}/g, (_, k: string | undefined, id: string) => {
    if (id === 'move') return moveHtml(b);
    if (k) return keysHtml(b, id as BindAction, k === 'k1:');
    const l = pad[id] ?? id;
    return l === '—' ? '<span class="unbound">none</span>' : kbd(l);
  });
}

/** Mouse column cells that differ from the keyboard wording (the rest reads the mouse layout's inputs). */
const MOUSE_CELLS: Record<string, string> = {
  Move: 'Point where to run (further = faster; on your player = stop)',
  'First touch': 'Point where to take it as the ball arrives (+ {k1:sprint} to push it ahead)',
  'Skill move: forward knock-on · sideways step-over · diagonally back roulette · straight back drag-back': '{k:skill}, pointing that way',
  'Switch to a chosen player (defending)': '{k:switch} (nearest)',
  'Defending a free kick: shift the wall · men in the wall · jump': 'Point · {k1:switch} · {k1:shoot}',
};

/**
 * The full controls list. With `mouse` (mouse control on) a Mouse column shows the mouse layout;
 * the keyboard column stays so both can be compared.
 */
export function controlsTable(style: PadStyle = 'xbox', b: ControlBindings = defaultBindings(), mouse = false): string {
  const mb = mouseAsKeys(b);
  const mcell = (a: string, k: string) => (mouse ? `<td>${fillCell(MOUSE_CELLS[a] ?? k, mb, style)}</td>` : '');
  return `${mouse ? '<p class="note">Mouse control is on (Settings): the Mouse column is the layout in use.</p>' : ''}<table class="ctl"><thead><tr><th>Action</th>${mouse ? '<th>Mouse</th>' : ''}<th>Keyboard</th><th>Controller</th><th>Touch</th></tr></thead><tbody>${ROWS.map(
    ([a, k, c, t]) => `<tr><td>${a}</td>${mcell(a, k)}<td>${fillCell(k, b, style)}</td><td>${fillCell(c, b, style)}</td><td>${t}</td></tr>`,
  ).join('')}</tbody></table>
  <p class="note">Context: when your team has the ball the buttons pass and shoot; without it, pass and shoot become standing tackles. Movement is relative to the camera: up moves away from it. Pass, through ball, lob and shot all charge while held and play on release: for passes, the longer you hold the further away the teammate it looks for in that direction. Releasing a pass or shot just before the ball arrives plays it first time. With no direction held, your first touch kills the ball dead. Hold the modifier while releasing for a placed shot, a driven pass or a lofted through ball. Every player has a stronger foot (shown on the player card with weak-foot stars): shooting across to the weaker side is less powerful and less accurate.</p>
  <p class="note">Skill moves: push the stick the way you face for a knock-on, back for a drag-back, or sideways (or not at all) for a step-over. Set pieces: the stick moves a yellow target; pass and lob go to it, shoot aims at its side of the goal, and more power lifts a free kick over the wall. At free kicks and penalties a ring over the ball shrinks and grows: release as it closes for the most accurate kick. With quick restarts on (Settings), press a kick button as your taker reaches the ball to take a throw-in, corner or free kick before the other side is set.</p>
  <p class="note">Weather plays its part: in rain the ball skids on and keepers spill more, snow slows the ball and the players, and wind (arrow on the radar) bends long balls and shots. The referee plays advantage when a foul doesn't stop your attack; a card still follows at the next stoppage.</p>`;
}

export function guideLine(device: 'keyboard' | 'gamepad' | 'touch' | 'mouse', style: PadStyle, attacking: boolean, b: ControlBindings = defaultBindings()): string {
  if (device === 'touch') return '';
  if (device === 'mouse') {
    const k = (a: BindAction) => kbd(keysText(mouseAsKeys(b), a)[0] ?? '—');
    return attacking
      ? `Point to run · ${k('pass')} Pass (hold = further) · ${k('shoot')} Shoot · ${k('lob')} Long ball · ${k('through')} Through ball · ${k('sprint')} Sprint · ${k('switch')} Call run · ${k('skill')} Skill`
      : `Point to run · ${k('pass')} Tackle · ${k('lob')} Slide · ${k('through')} Contain · ${k('jockey')} Jockey · ${k('switch')} Switch · ${k('keeper')} Take keeper`;
  }
  if (device === 'gamepad') {
    const p = padLabels(style, b);
    return attacking
      ? `<kbd>${p.pass}</kbd> Pass (hold = further) · <kbd>${p.shoot}</kbd> Shoot · <kbd>${p.lob}</kbd>+<kbd>${p.shoot}</kbd> Chip · <kbd>${p.through}</kbd> Through · <kbd>${p.jockey}</kbd> Driven/finesse · <kbd>${p.switch}</kbd> Call run`
      : `<kbd>${p.pass}</kbd> Tackle · <kbd>${p.lob}</kbd> Slide · <kbd>${p.through}</kbd> Contain · <kbd>${p.jockey}</kbd> Jockey · <kbd>${p.switch}</kbd>/<kbd>${p.flick}</kbd> Switch · <kbd>${p.skill}</kbd> Take keeper`;
  }
  const k = (a: BindAction) => kbd(keysText(b, a)[0] ?? '—');
  return attacking
    ? `${k('pass')} Pass (hold = further) · ${k('shoot')} Shoot · ${k('lob')}+${k('shoot')} Chip · ${k('through')}+${k('shoot')} Low · ${k('jockey')} Driven/finesse · ${k('switch')} Call run · ${k('skill')} Skill`
    : `${k('pass')} Tackle · ${k('lob')} Slide · ${k('through')} Contain · ${k('jockey')} Jockey · ${k('switch')}/click Switch · ${k('keeper')} Take keeper · ${k('help')} Help`;
}
