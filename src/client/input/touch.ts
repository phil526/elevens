// Mobile touch controls: floating virtual stick on the left, large contextual
// action buttons on the right. Multi-touch through Pointer Events, so you can
// move while charging or releasing a shot.

import { emptyRaw, type InputSource, type RawState } from './actions';

export type TouchButton = 'a' | 'b' | 'c' | 'd' | 'e' | 'sprint' | 'f' | 'g' | 'h';
type Action = 'pass' | 'shoot' | 'lob' | 'through' | 'switch' | 'jockey' | 'sprint' | 'skill' | 'teamPress' | 'trap';

// Defending reuses the attacking actions the simulation reinterprets: lob = slide tackle, held through = contain.
// The small row (f, g, h): with the ball, RUN calls a run (switch) and SHIELD holds the modifier, which shields
// the ball and also turns passes driven, through balls lofted and shots placed. Without it, RUSH sends the
// keeper, PRESS starts a team press and TRAP springs the offside trap.
const ATTACK: Record<TouchButton, Action | null> = { a: 'pass', b: 'shoot', c: 'lob', d: 'through', e: 'skill', sprint: 'sprint', f: 'switch', g: 'jockey', h: null };
const DEFEND: Record<TouchButton, Action | null> = { a: 'pass', b: 'lob', c: 'jockey', d: 'switch', e: 'through', sprint: 'sprint', f: 'skill', g: 'teamPress', h: 'trap' };
// In goal: COME OUT (pass) rushes the keeper off his line, DIVE (shoot) dives, OUTFIELD (skill) hands him back.
const KEEPER: Record<TouchButton, Action | null> = { a: 'pass', b: 'shoot', c: 'jockey', d: 'switch', e: null, sprint: 'sprint', f: 'skill', g: 'teamPress', h: 'trap' };
// Setting a wall at a free kick against you: JUMP (shoot), ADD MAN (switch: 2 to 5 in the wall).
const WALL: Record<TouchButton, Action | null> = { a: null, b: 'shoot', c: null, d: 'switch', e: null, sprint: null, f: null, g: null, h: null };
export type TouchContext = 'attack' | 'defend' | 'keeper' | 'wall';
const MAPS: Record<TouchContext, Record<TouchButton, Action | null>> = { attack: ATTACK, defend: DEFEND, keeper: KEEPER, wall: WALL };
export const TOUCH_LABELS: Record<TouchContext, Record<TouchButton, string>> = {
  attack: { a: 'PASS', b: 'SHOOT', c: 'LOB', d: 'THROUGH', e: 'SKILL', sprint: 'SPRINT', f: 'RUN', g: 'SHIELD', h: '' },
  defend: { a: 'TACKLE', b: 'SLIDE', c: 'JOCKEY', d: 'SWITCH', e: 'CONTAIN', sprint: 'SPRINT', f: 'KEEPER', g: 'PRESS', h: 'TRAP' },
  keeper: { a: 'COME OUT', b: 'DIVE', c: 'JOCKEY', d: 'SWITCH', e: '', sprint: 'SPRINT', f: 'OUTFIELD', g: 'PRESS', h: 'TRAP' },
  wall: { a: '', b: 'JUMP', c: '', d: 'ADD MAN', e: '', sprint: '', f: '', g: '', h: '' },
};

/** Pointer bookkeeping, independent of the DOM (unit-testable). */
export class TouchModel implements InputSource {
  device = 'touch' as const;
  radius = 60;
  context: TouchContext = 'attack';
  /** Shorthand for the two everyday contexts. */
  get attacking() { return this.context === 'attack'; }
  set attacking(v: boolean) { this.context = v ? 'attack' : 'defend'; }
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private held = new Map<number, Action>();
  private latched = new Set<Action>(); // taps shorter than one sample still count once

  stickDown(id: number, x: number, y: number) {
    if (!this.stick) this.stick = { id, ox: x, oy: y, x, y };
  }
  move(id: number, x: number, y: number) {
    if (this.stick && this.stick.id === id) { this.stick.x = x; this.stick.y = y; }
  }
  buttonDown(id: number, b: TouchButton) {
    const a = MAPS[this.context][b];
    if (!a) return;
    this.held.set(id, a);
    this.latched.add(a);
  }
  up(id: number) {
    if (this.stick && this.stick.id === id) this.stick = null;
    this.held.delete(id);
  }
  stickVector(): [number, number] {
    if (!this.stick) return [0, 0];
    let dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
    const l = Math.hypot(dx, dy);
    if (l < 6) return [0, 0];
    if (l > this.radius) { dx *= this.radius / l; dy *= this.radius / l; }
    return [dx / this.radius, -dy / this.radius];
  }
  stickOrigin() {
    return this.stick ? { ox: this.stick.ox, oy: this.stick.oy, x: this.stick.x, y: this.stick.y } : null;
  }
  read(): RawState {
    const r = emptyRaw();
    [r.sx, r.sy] = this.stickVector();
    for (const a of [...this.held.values(), ...this.latched]) (r as unknown as Record<string, boolean>)[a] = true;
    this.latched.clear();
    return r;
  }
  clear() {
    this.stick = null;
    this.held.clear();
    this.latched.clear();
  }
}

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/** Builds the overlay DOM and wires pointer events into a TouchModel. */
export class TouchControls {
  el: HTMLDivElement;
  private knob: HTMLDivElement;
  private base: HTMLDivElement;
  private buttons = new Map<TouchButton, HTMLButtonElement>();
  onPause: () => void = () => {};

  constructor(public model: TouchModel, parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'touch-layer';
    this.el.innerHTML = `
      <div class="stick-zone"></div>
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="touch-buttons">
        <button data-b="sprint" class="tb tb-sprint">SPRINT</button>
        <button data-b="e" class="tb tb-e">SKILL</button>
        <button data-b="d" class="tb tb-d">THROUGH</button>
        <button data-b="c" class="tb tb-c">LOB</button>
        <button data-b="a" class="tb tb-a">PASS</button>
        <button data-b="b" class="tb tb-b">SHOOT</button>
        <button data-b="f" class="tb tb-s tb-f">RUN</button>
        <button data-b="g" class="tb tb-s tb-g">SHIELD</button>
        <button data-b="h" class="tb tb-s tb-h" style="visibility:hidden"></button>
      </div>
      <button class="touch-pause" aria-label="Pause">❚❚</button>`;
    parent.appendChild(this.el);
    this.base = this.el.querySelector('.stick-base')!;
    this.knob = this.el.querySelector('.stick-knob')!;
    const zone = this.el.querySelector<HTMLDivElement>('.stick-zone')!;
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      model.stickDown(e.pointerId, e.clientX, e.clientY);
      this.drawStick();
    });
    zone.addEventListener('pointermove', (e) => { model.move(e.pointerId, e.clientX, e.clientY); this.drawStick(); });
    const end = (e: PointerEvent) => { model.up(e.pointerId); this.drawStick(); };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    this.el.querySelectorAll<HTMLButtonElement>('.tb').forEach((btn) => {
      const b = btn.dataset.b as TouchButton;
      this.buttons.set(b, btn);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        model.buttonDown(e.pointerId, b);
        btn.classList.add('down');
      });
      const up = (e: PointerEvent) => { model.up(e.pointerId); btn.classList.remove('down'); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
    });
    this.el.querySelector('.touch-pause')!.addEventListener('click', () => this.onPause());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Attacking, defending, in goal (controlling the keeper) or setting a free-kick wall. */
  setContext(ctx: boolean | TouchContext) {
    const c: TouchContext = ctx === true ? 'attack' : ctx === false ? 'defend' : ctx;
    if (this.model.context === c) return;
    this.model.context = c;
    const labels = TOUCH_LABELS[c];
    for (const [b, btn] of this.buttons) { btn.textContent = labels[b]; btn.style.visibility = labels[b] ? '' : 'hidden'; }
    this.el.classList.toggle('defending', c !== 'attack');
  }

  private drawStick() {
    const s = this.model.stickOrigin();
    if (!s) { this.base.style.display = 'none'; return; }
    this.base.style.display = 'block';
    this.base.style.left = `${s.ox}px`;
    this.base.style.top = `${s.oy}px`;
    const [vx, vy] = this.model.stickVector();
    this.knob.style.transform = `translate(${vx * this.model.radius}px, ${-vy * this.model.radius}px)`;
  }

  show(v: boolean) {
    this.el.style.display = v ? 'block' : 'none';
    if (!v) this.model.clear();
  }
}
