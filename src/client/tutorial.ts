// Guided first match (19 Nov 2026): a practice match against a Casual computer side with a coach
// card that teaches one thing at a time: moving, sprinting, switching, jockeying, tackling,
// passing, through balls, lobs, skill moves, shooting and finally scoring. Each step shows the
// button for the device in use and ticks off when you have done it; attacking steps come up when
// you have the ball and defending steps when you haven't.

import type { MatchEvent } from '../shared/types';
import type { BindAction } from './input/bindings';
import type { ViewState } from './view';

export interface CoachStep {
  id: string;
  title: string;
  /** Text with {action} placeholders for button names, and {move} for the stick or keys. */
  text: string;
  when: 'attack' | 'defend' | 'any';
}

export const COACH_STEPS: CoachStep[] = [
  { id: 'move', title: 'Move', text: 'Move your player with {move}. The arrow over a head shows who you control.', when: 'any' },
  { id: 'sprint', title: 'Sprint', text: 'Hold {sprint} while moving to sprint. It tires players, so use it in bursts.', when: 'any' },
  { id: 'switch', title: 'Switch player', text: 'Without the ball, press {switch} to take the teammate nearest the ball.', when: 'defend' },
  { id: 'jockey', title: 'Jockey', text: 'Hold {jockey} to jockey: you stay goal-side and face the attacker.', when: 'defend' },
  { id: 'tackle', title: 'Tackle', text: 'Get close and press {pass} to tackle as his touch knocks the ball away from his foot. {lob} is a sliding tackle (risky).', when: 'defend' },
  { id: 'pass', title: 'Pass', text: 'Press {pass} to pass. Point where you want it; hold longer for a teammate further away.', when: 'attack' },
  { id: 'through', title: 'Through ball', text: 'Press {through} to play the ball into space ahead of a runner.', when: 'attack' },
  { id: 'lob', title: 'Lofted pass', text: 'Press {lob} for a lofted pass over the defenders (from wide, it is a cross).', when: 'attack' },
  { id: 'skill', title: 'Skill move', text: 'Press {skill} to beat a defender: push the stick ahead for a knock-on, back for a drag-back.', when: 'attack' },
  { id: 'shoot', title: 'Shoot', text: 'Hold {shoot} to power up, release to shoot. A short hold keeps it low and accurate.', when: 'attack' },
  { id: 'score', title: 'Score!', text: 'Put it all together and score a goal.', when: 'attack' },
];

export interface CoachContext {
  team: number;
  attacking: boolean;
  /** Buttons held this frame (from the action layer). */
  held: { sprint: boolean; jockey: boolean; switch: boolean; pass: boolean; lob: boolean };
  name: (a: BindAction) => string;
  /** The button as an icon (controller buttons drawn, keys as key caps); falls back to the name. */
  key?: (a: BindAction) => string;
  move: string;
}

export class Coach {
  done = new Set<string>();
  private moved = 0;
  private sprintT = 0;
  private jockeyT = 0;
  private last: { x: number; z: number; id: number } | null = null;
  private prev = { switch: false, pass: false, lob: false };
  private el: HTMLElement;
  private shown = '';
  private flashT = 0;
  finished = false;
  onFinish: () => void = () => {};

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'coach';
    host.appendChild(this.el);
  }

  /** The step to show now: the first one not done that fits what is happening, else the first one not done. */
  current(attacking: boolean): CoachStep | null {
    const left = COACH_STEPS.filter((s) => !this.done.has(s.id));
    if (!left.length) return null;
    return left.find((s) => s.when === 'any' || (s.when === 'attack') === attacking) ?? left[0];
  }

  private tick(id: string) {
    if (this.done.has(id)) return;
    this.done.add(id);
    this.flashT = 1.2;
  }

  update(v: ViewState, evs: MatchEvent[], dt: number, c: CoachContext) {
    if (this.finished) return;
    const ctl = v.ctl[c.team];
    const p = ctl >= 0 ? v.players[ctl] : null;
    if (p) {
      if (this.last && this.last.id === ctl) this.moved += Math.hypot(p.pos.x - this.last.x, p.pos.z - this.last.z);
      this.last = { x: p.pos.x, z: p.pos.z, id: ctl };
      if (p.sprinting && Math.hypot(p.vel.x, p.vel.z) > 4) this.sprintT += dt;
      if (c.held.jockey && !c.attacking) this.jockeyT += dt;
    }
    if (this.moved > 12) this.tick('move');
    if (this.sprintT > 1.2) this.tick('sprint');
    if (this.jockeyT > 0.8) this.tick('jockey');
    if (!c.attacking && c.held.switch && !this.prev.switch) this.tick('switch');
    if (!c.attacking && ((c.held.pass && !this.prev.pass) || (c.held.lob && !this.prev.lob)) && this.done.has('switch')) this.tick('tackle');
    this.prev = { switch: c.held.switch, pass: c.held.pass, lob: c.held.lob };
    for (const e of evs) {
      if (e.team !== c.team) continue;
      if (e.type === 'kick' && e.player === ctl) {
        if (e.text === 'pass') this.tick('pass');
        else if (e.text === 'through') this.tick('through');
        else if (e.text === 'lob' || e.text === 'cross') this.tick('lob');
        else if (e.text === 'shot' || e.text === 'volley' || e.text === 'header') this.tick('shoot');
      }
      if (e.type === 'tackle') this.tick('tackle');
      if (e.type === 'skill') this.tick('skill');
      if (e.type === 'goal' && e.text !== 'og') { this.tick('shoot'); this.tick('score'); }
    }
    this.flashT = Math.max(0, this.flashT - dt);
    this.draw(c);
    if (this.done.size >= COACH_STEPS.length) {
      this.finished = true;
      this.draw(c);
      this.onFinish();
    }
  }

  private draw(c: CoachContext) {
    const step = this.current(c.attacking);
    const n = this.done.size, total = COACH_STEPS.length;
    const fill = (t: string) => t.replace(/\{(\w+)\}/g, (_, a: string) => (a === 'move' ? `<kbd>${c.move}</kbd>` : c.key ? c.key(a as BindAction) : `<kbd>${c.name(a as BindAction)}</kbd>`));
    const html = step
      ? `<div class="coach-head"><span>Guided first match</span><b>${n} / ${total}</b></div>
         <div class="coach-title">${this.flashT > 0 ? '<span class="coach-tick">✓ Nice!</span> ' : ''}${step.title}</div>
         <div class="coach-text">${fill(step.text)}</div>
         <div class="coach-dots">${COACH_STEPS.map((s) => `<i class="${this.done.has(s.id) ? 'on' : s === step ? 'now' : ''}"></i>`).join('')}</div>`
      : `<div class="coach-head"><span>Guided first match</span><b>${total} / ${total}</b></div><div class="coach-title">All done!</div>`;
    if (html !== this.shown) { this.el.innerHTML = html; this.shown = html; }
  }

  show(on: boolean) { this.el.hidden = !on; }

  dispose() { this.el.remove(); }
}
