// Loading screen before a match: the two clubs, a progress bar through the real loading steps
// (players, stadium, warming up the graphics) and gameplay tips that change every few seconds.
// Tips name the buttons of the device in use (keyboard keys, controller buttons or the touch
// buttons), from the player's own control bindings.

import { defaultBindings, keysText, type BindAction, type ControlBindings } from '../input/bindings';
import { padLabels, type PadStyle } from '../input/gamepad';

export type TipDevice = 'keyboard' | 'gamepad' | 'touch';

/** A tip: text with {action} tokens filled with that device's button, or a touch-only wording. */
interface Tip { text: string; touch?: string }

const TIPS: Tip[] = [
  { text: 'Tap {pass} for the nearest teammate; hold it longer to look for one further away.', touch: 'Tap PASS for the nearest teammate; hold it longer to look for one further away.' },
  { text: 'Hold {lob} then press {shoot} to chip a keeper who has come off the line.', touch: 'Hold LOB then press SHOOT to chip a keeper who has come off the line.' },
  { text: 'Hold {jockey} as you release {shoot} for a finesse shot curled into the corner.', touch: 'Hold SHIELD as you release SHOOT for a finesse shot curled into the corner.' },
  { text: 'Hold {jockey} and {sprint} as you release {shoot} for a power shot. Tap {switch} while charging for a placed, side-footed one.', touch: 'Hold SHIELD and SPRINT as you release SHOOT for a power shot.' },
  { text: 'At a free kick, hold {jockey} and move to bend the ball (across) or add dip (towards goal).', touch: 'Free kick: move the target, then time SHOOT as the ring closes.' },
  { text: 'Release a shot just before the ball reaches you to strike it first time.' },
  { text: 'At free kicks and penalties, release as the ring over the ball closes for the most accurate kick.' },
  { text: 'With the ball, press {switch} to call a teammate into a run in behind.', touch: 'With the ball, press RUN to call a teammate into a run in behind.' },
  { text: 'Defending, press {skill} to send your keeper rushing out at a striker through on goal.', touch: 'Defending, press RUSH to send your keeper rushing out at a striker through on goal.' },
  { text: 'Hold {shoot} and tap {pass} for a fake shot that cuts the ball across a defender.', touch: 'Hold SHOOT and tap PASS for a fake shot that cuts the ball across a defender.' },
  { text: 'From wide, hold {jockey} and press {lob} for a whipped cross, or {jockey} and {pass} for a low one.', touch: 'From wide, hold SHIELD and press LOB for a whipped cross, or SHIELD and PASS for a low one.' },
  { text: 'Defending, hold {jockey} to stay goal-side of the carrier instead of diving in.', touch: 'Defending, hold JOCKEY to stay goal-side of the carrier instead of diving in.' },
  { text: 'Press {sprint} from a jog for a burst of pace past a defender.', touch: 'Press SPRINT from a jog for a burst of pace past a defender.' },
  { text: 'Hold a direction as a pass arrives to take your first touch that way.' },
  { text: '{teamPress} sends your team to press high; {trap} springs the offside trap.', touch: 'PRESS sends your team to press high; TRAP springs the offside trap.' },
  { text: 'Every player has a stronger foot: the stars on the player card show how good the other one is.' },
  { text: 'Quick restarts: press a kick button as your taker reaches the ball to catch the other side out.' },
  { text: 'Missed something? Pause and choose Instant replay to watch the last 20 seconds again.' },
  { text: 'Practice has free kicks, penalties and a finishing challenge, with your best scores kept.' },
  { text: 'In Settings > Camera you can switch between Broadcast, Tracking, Wide and Panoramic views.' },
  { text: 'Cup and league runs are saved on this device: carry on from the main menu any time.' },
  { text: 'Keeper has the ball: {pass} rolls it out, {lob} throws, {through} drop-kicks and {shoot} punts it long.', touch: 'Keeper has the ball: PASS rolls it out, LOB throws, THROUGH drop-kicks and SHOOT punts it long.' },
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The tips for this device, as HTML with the buttons shown as keys. */
export function loadingTips(device: TipDevice, style: PadStyle = 'xbox', b: ControlBindings = defaultBindings()): string[] {
  const pad = padLabels(style, b);
  const label = (id: string) => (device === 'gamepad' ? pad[id] ?? id : keysText(b, id as BindAction)[0] ?? '');
  return TIPS.map((t) => {
    if (device === 'touch') return esc(t.touch ?? t.text.replace(/\{\w+\}/g, 'the button'));
    // A tip whose button is unbound on this device falls back to the touch wording (or is dropped).
    let missing = false;
    const html = esc(t.text).replace(/\{(\w+)\}/g, (_, id: string) => {
      const l = label(id);
      if (!l || l === '—') missing = true;
      return `<kbd>${esc(l)}</kbd>`;
    });
    return missing ? '' : html;
  }).filter(Boolean);
}

export interface LoadingInfo {
  home: { name: string; abbr: string; colour: string; ink: string };
  away: { name: string; abbr: string; colour: string; ink: string };
  /** "Pro · 6 minutes", "Practice: free kicks", … */
  detail: string;
  venue: string;
}

export const LOAD_STEPS = ['Players', 'Stadium', 'Warm-up'] as const;

/** The loading screen's markup (inside a .screen). */
export function loadingHtml(info: LoadingInfo, tip: string): string {
  const side = (t: LoadingInfo['home'], cls: string) => `<div class="ld-team ${cls}" style="--c:${t.colour};--ci:${t.ink}"><b>${esc(t.abbr)}</b><span>${esc(t.name)}</span></div>`;
  return `<div class="loading-card">
    <header><span>${esc(info.venue)}</span><em>${esc(info.detail)}</em></header>
    <div class="ld-match">${side(info.home, 'home')}<i>v</i>${side(info.away, 'away')}</div>
    <div class="ld-steps">${LOAD_STEPS.map((s, i) => `<span data-step="${i}">${s}</span>`).join('')}</div>
    <div class="progress ld-bar"><i style="width:4%"></i></div>
    <div class="ld-tip"><b>Tip</b><p>${tip}</p></div>
  </div>`;
}

/**
 * Drives a loading screen already in the page: the bar eases towards the current step's
 * share (it never sits still while a download runs) and the tip changes every 6 seconds.
 */
export class LoadingScreen {
  private step = 0;
  private shown = 0;
  private timer = 0;
  private tipAt = 0;
  private tipI: number;
  private raf = 0;
  readonly started = performance.now();

  constructor(private root: HTMLElement, private tips: string[]) {
    this.tipI = tips.length ? Math.floor(Math.random() * tips.length) : 0;
    this.showTip(false);
    this.setStep(0);
    const tick = () => {
      if (!this.root.isConnected) return;
      this.tick();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setStep(i: number) {
    this.step = i;
    this.root.querySelectorAll<HTMLElement>('[data-step]').forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle('done', n < i);
      el.classList.toggle('on', n === i);
    });
  }

  /** Finished: fill the bar. */
  done() {
    this.step = LOAD_STEPS.length;
    this.setStep(LOAD_STEPS.length);
    this.shown = 100;
    this.paint();
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private tick() {
    const now = performance.now();
    const dt = this.timer ? Math.min(0.1, (now - this.timer) / 1000) : 0;
    this.timer = now;
    // Each step owns a slice of the bar; within it the bar creeps on, slowing as it nears the end.
    const target = Math.min(100, ((this.step + 0.92) / LOAD_STEPS.length) * 100);
    this.shown += (target - this.shown) * Math.min(1, dt * 1.4);
    this.paint();
    if (this.tips.length > 1 && now - this.started - this.tipAt > 6000) {
      this.tipAt = now - this.started;
      this.tipI = (this.tipI + 1) % this.tips.length;
      this.showTip(true);
    }
  }

  private paint() {
    const bar = this.root.querySelector<HTMLElement>('.ld-bar i');
    if (bar) bar.style.width = `${Math.max(4, this.shown).toFixed(1)}%`;
  }

  private showTip(fade: boolean) {
    const p = this.root.querySelector<HTMLElement>('.ld-tip p');
    if (!p || !this.tips.length) return;
    if (!fade) { p.innerHTML = this.tips[this.tipI]; return; }
    p.classList.add('out');
    setTimeout(() => { p.innerHTML = this.tips[this.tipI]; p.classList.remove('out'); }, 220);
  }
}
