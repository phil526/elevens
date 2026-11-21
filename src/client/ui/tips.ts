// One-time tips (21 Nov 2026): the first time each situation comes up (your first corner, free
// kick in range, penalty, throw-in, keeper's ball, through on goal, defending, tired legs, a wet
// pitch, a strong wind ...), a small card explains it with the buttons for the device in use,
// then never again on this device. Settings > Gameplay > One-time tips turns them off and can
// show them all again. Off on ?test pages unless &tips, and during the guided first match (the
// coach card teaches there).

import { PITCH } from '../../shared/config';
import type { BindAction } from '../input/bindings';
import type { ViewState } from '../view';

export interface TipDef {
  id: string;
  title: string;
  /** Text with {action} tokens for buttons. */
  text: string;
  /** True while the situation is on (lt: your team). */
  when: (v: ViewState, lt: number) => boolean;
}

const myRestart = (v: ViewState, lt: number, type: string) => {
  const r = v.restart;
  return !!r && r.ready && r.type === type && r.team === lt && v.ctl[lt] === r.taker;
};
const goalDist = (v: ViewState, lt: number, x: number, z: number) => Math.hypot(PITCH.halfLength * v.attackDir[lt] - x, z);
const carrier = (v: ViewState, lt: number) => {
  const i = v.ctl[lt];
  return i >= 0 && v.ball.owner === i && v.ball.state === 'dribble' ? v.players[i] : null;
};

export const TIPS: TipDef[] = [
  { id: 'corner', title: 'Your corner', text: 'Move the yellow target with the stick, then {lob} to cross or {pass} for a short one. Hold {jockey} with {lob} to whip it in.', when: (v, lt) => myRestart(v, lt, 'corner') },
  { id: 'freekick', title: 'Free kick in range', text: 'Aim with the stick and press {shoot} as the ring over the ball closes. Hold {jockey} and move the stick to bend or dip it over the wall.', when: (v, lt) => myRestart(v, lt, 'freekick') && !v.restart!.quick && goalDist(v, lt, v.restart!.spot.x, v.restart!.spot.z) < 32 },
  { id: 'penalty', title: 'Penalty', text: 'Aim with the stick, hold {shoot} and let go as the ring closes. {skill} adds a stutter in the run-up.', when: (v, lt) => myRestart(v, lt, 'penalty') },
  { id: 'penaltyKeeper', title: 'Saving a penalty', text: 'You are the keeper: move along the line, point the way and press {shoot} to dive. Go too early and the taker will see it.', when: (v, lt) => !!v.restart && v.restart.type === 'penalty' && v.restart.team !== lt && v.players[v.ctl[lt]]?.role === 'GK' },
  { id: 'throwin', title: 'Throw-in', text: '{pass} throws it short to feet, {lob} throws it long and {through} sends it down the line.', when: (v, lt) => myRestart(v, lt, 'throwin') },
  { id: 'keeperBall', title: 'Keeper\'s ball', text: '{pass} rolls it out, {lob} throws it, {through} drop-kicks and {shoot} punts it. Aim with the stick and hold for distance.', when: (v, lt) => v.phase === 'play' && v.ball.state === 'held' && v.ball.owner >= 0 && v.players[v.ball.owner]?.team === lt },
  { id: 'wall', title: 'Their free kick', text: 'Move the stick to shift your wall, {switch} changes how many stand in it and {shoot} makes it jump.', when: (v, lt) => !!v.restart && v.restart.type === 'freekick' && v.restart.team !== lt && goalDist(v, 1 - lt, v.restart.spot.x, v.restart.spot.z) < 30 },
  { id: 'oneOnOne', title: 'Through on goal', text: 'Hold {jockey} and press {shoot} to curl it into the far corner, or hold {lob} and press {shoot} to chip the keeper.', when: (v, lt) => {
    const p = carrier(v, lt);
    if (!p || v.phase !== 'play') return false;
    const d = goalDist(v, lt, p.pos.x, p.pos.z);
    if (d > 24 || d < 6) return false;
    const gx = PITCH.halfLength * v.attackDir[lt];
    // Nobody but the keeper between him and the goal.
    return !v.players.some((q) => q.team !== lt && !q.off && q.role !== 'GK' && Math.abs(q.pos.x - gx) < Math.abs(p.pos.x - gx) && Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) < d);
  } },
  { id: 'crossing', title: 'Out wide', text: '{lob} floats a cross into the box. Hold {jockey} with {lob} to whip it in, or {jockey} with {pass} for a low one.', when: (v, lt) => {
    const p = carrier(v, lt);
    return !!p && v.phase === 'play' && Math.abs(p.pos.z) > PITCH.halfWidth - 14 && goalDist(v, lt, p.pos.x, 0) < 30;
  } },
  { id: 'defending', title: 'Winning the ball back', text: '{pass} tackles, {lob} slides in, hold {jockey} to stay goal-side, and {switch} picks the defender nearest the ball. Tackle as his touch knocks the ball off his foot.', when: (v, lt) => v.phase === 'play' && v.clock > 40 && v.ball.owner >= 0 && v.ball.state === 'dribble' && v.players[v.ball.owner]?.team !== lt },
  { id: 'tired', title: 'Tired legs', text: 'Your player is running low on energy, so he is slower and less sharp. Sprint less, or bring on a substitute from the pause menu.', when: (v, lt) => v.phase === 'play' && (v.players[v.ctl[lt]]?.stamina ?? 1) < 0.3 },
  { id: 'rain', title: 'Wet pitch', text: 'In the rain the ball skids on and runs further, and keepers spill more shots. Shoot low and follow up.', when: (v) => v.phase === 'play' && v.weather?.kind === 'rain' },
  { id: 'snow', title: 'Snow', text: 'Snow slows the ball and the players. Play it shorter and give passes more power.', when: (v) => v.phase === 'play' && v.weather?.kind === 'snow' },
  { id: 'wind', title: 'Wind', text: 'The arrow on the radar shows the wind. It bends long balls, crosses and shots: aim into it.', when: (v) => v.phase === 'play' && (v.weather?.wind ?? 0) >= 6 },
];

/** How long a tip shows at most, and at least once its situation has passed (seconds). */
export const TIP_TIME = { max: 9, min: 3.5 } as const;

export class TipCards {
  el: HTMLElement;
  private cur: { tip: TipDef; t: number } | null = null;
  /** Seconds since the last tip went, so two never come one straight after the other. */
  private gap = 99;
  enabled = true;

  constructor(parent: HTMLElement, private seen: () => string[], private markSeen: (id: string) => void, private keyHtml: (a: BindAction) => string) {
    this.el = document.createElement('div');
    this.el.className = 'tipcard';
    this.el.setAttribute('role', 'status');
    parent.appendChild(this.el);
  }

  /** The tip showing now (tests). */
  get showing(): string | null { return this.cur?.tip.id ?? null; }

  /** Called each match frame; `active` false while a menu, cinematic or the line-ups cover the match. */
  update(v: ViewState, lt: number, dt: number, active: boolean) {
    const c = this.cur;
    if (c) {
      c.t += dt;
      const on = c.tip.when(v, lt);
      if (!active || c.t > TIP_TIME.max || (!on && c.t > TIP_TIME.min)) this.hide();
      return;
    }
    this.gap += dt;
    if (!this.enabled || !active || this.gap < 6 || lt < 0 || !v.humans[lt]) return;
    const seen = this.seen();
    const tip = TIPS.find((t) => !seen.includes(t.id) && t.when(v, lt));
    if (!tip) return;
    this.markSeen(tip.id);
    this.cur = { tip, t: 0 };
    const text = tip.text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!).replace(/\{(\w+)\}/g, (_, a: string) => this.keyHtml(a as BindAction));
    this.el.innerHTML = `<b>${tip.title}</b><span>${text}</span><small>Tip · shown once</small>`;
    this.el.classList.add('show');
  }

  hide() {
    if (!this.cur) return;
    this.cur = null;
    this.gap = 0;
    this.el.classList.remove('show');
  }
}
