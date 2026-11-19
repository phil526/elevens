// Shared input-action layer. Devices report held state in screen space; this
// module merges them, detects presses/releases, handles shot charging and
// produces InputFrames (intentions) for the simulation. Gameplay code never
// sees device-specific buttons.

import { PLAYER } from '../../shared/config';
import type { InputEvent, InputFrame } from '../../shared/types';

export type Device = 'keyboard' | 'gamepad' | 'touch' | 'mouse';

export interface RawState {
  sx: number; // screen-space move, right = +1
  sy: number; // screen-space move, up = +1
  sprint: boolean;
  jockey: boolean;
  pass: boolean;
  through: boolean;
  lob: boolean;
  shoot: boolean;
  switch: boolean;
  skill: boolean;
  pause: boolean;
  help: boolean;
  teamPress: boolean; // defending: the whole team presses for a few seconds
  trap: boolean; // defending: the back four step up (offside trap)
  keeper: boolean; // take control of your keeper (or hand him back)
  plan: boolean; // next game plan (live tactics)
  rsx: number; // right stick (gamepad): flick to switch player when defending, skill move when attacking
  rsy: number;
}

export const emptyRaw = (): RawState => ({ sx: 0, sy: 0, sprint: false, jockey: false, pass: false, through: false, lob: false, shoot: false, switch: false, skill: false, pause: false, help: false, teamPress: false, trap: false, keeper: false, plan: false, rsx: 0, rsy: 0 });

/** Right-stick flick thresholds: a flick fires once when the stick passes FLICK_ON, and re-arms below FLICK_OFF. */
export const FLICK_ON = 0.75;
export const FLICK_OFF = 0.4;

export interface InputSource {
  device: Device;
  read(): RawState;
  clear(): void;
}

export interface SampleContext {
  attacking: boolean; // our team has the ball (from the latest state we know)
}

/** The button being held to charge a kick, and for a shot the style chosen with a second button. */
export type ChargeKind = 'pass' | 'through' | 'lob' | 'shoot';

/** What a held kick button will do, for the receiver preview and the label on the power bar. */
export interface ChargeInfo {
  kind: ChargeKind;
  power: number; // 0..1
  label: string; // e.g. PASS, DRIVEN PASS, CHIP
  driven: boolean;
  lofted: boolean;
  locked: number; // Early receiver: the teammate locked when the button went down, or -1
}

export class ActionLayer {
  private prev = emptyRaw();
  private seq = 0;
  private chargeStart = -1;
  private chargeKind: ChargeKind | null = null;
  private shotStyle: 'chip' | 'low' | 'placed' | undefined;
  /** The switch button went down this sample to pick a placed shot (so it doesn't also switch or call a run). */
  private switchUsed = false;
  private suppressShootRelease = false;
  private flickArmed = true;
  private extra: InputEvent[] = []; // events from outside the polled devices (mouse clicks)
  /** Early: the receiver is picked when a pass button goes down (power then sets the pace). Late: on release. */
  receiverMode: 'early' | 'late' = 'late';
  /** Pass assistance: Assisted picks the teammate and the weight; Semi aims at a teammate but the charge sets the distance; Manual is the stick and the charge only. */
  passAssist: 'assisted' | 'semi' | 'manual' = 'assisted';
  /** Shot assistance: Assisted aims inside the posts for you; Manual shoots exactly where the stick points. */
  shotAssist: 'assisted' | 'manual' = 'assisted';
  /** Right-stick switching measured from your player or from the ball. */
  stickSwitch: 'player' | 'ball' = 'player';
  /** Set by the app: the teammate a pass of this kind would pick right now (ignoring power), or -1. */
  pickReceiver: (kind: 'pass' | 'through' | 'lob') => number = () => -1;
  private locked = -1;
  lastDevice: Device = 'keyboard';
  /** Set by the app: this side's current game plan (index into GAME_PLANS), so the plan button steps to the next. */
  planIndex = 2;
  onPause: () => void = () => {};
  onHelp: () => void = () => {};
  /** Accessibility: kicks take this many times longer to charge fully (Settings > Hold times). */
  chargeScale = 1;
  /** Accessibility: sprint is a toggle (press to start, press again or let go of the stick to stop). */
  sprintToggle = false;
  private sprintLatch = false;
  private sprintRaw = false;

  constructor(public sources: InputSource[]) {}

  /** Buttons held in the last sample (tutorial coach). */
  held() { return this.prev; }

  /** Current kick charge 0..1 (for the power bar), or -1 when not charging. */
  charge(now: number) {
    if (this.chargeStart < 0 || !this.chargeKind) return -1;
    const max = (this.chargeKind === 'shoot' ? PLAYER.shotChargeMax : PLAYER.passChargeMax) * this.chargeScale;
    return Math.min(1, (now - this.chargeStart) / 1000 / max);
  }

  /** The kick being charged, with its style, or null. */
  charging(now: number): ChargeInfo | null {
    const k = this.chargeKind;
    if (!k || this.chargeStart < 0) return null;
    const mod = this.prev.jockey;
    const driven = k === 'pass' && mod;
    const lofted = k === 'through' && mod;
    const label = k === 'shoot'
      ? this.shotStyle === 'chip' ? 'CHIP' : this.shotStyle === 'low' ? 'LOW DRIVE' : this.shotStyle === 'placed' ? 'PLACED' : mod && this.prev.sprint ? 'POWER SHOT' : mod ? 'FINESSE' : 'SHOT'
      : k === 'pass' ? (driven ? 'DRIVEN PASS' : 'PASS') : k === 'through' ? (lofted ? 'LOFTED THROUGH' : 'THROUGH') : 'LOB';
    return { kind: k, power: this.charge(now), label, driven, lofted, locked: this.locked };
  }

  private startCharge(kind: ChargeKind, now: number) {
    this.chargeKind = kind;
    this.chargeStart = now;
    this.shotStyle = undefined;
    this.locked = this.receiverMode === 'early' && kind !== 'shoot' && this.passAssist === 'assisted' ? this.pickReceiver(kind) : -1;
  }

  private endCharge() {
    this.chargeKind = null;
    this.chargeStart = -1;
    this.shotStyle = undefined;
    this.locked = -1;
  }

  private merged(): RawState {
    const m = emptyRaw();
    for (const s of this.sources) {
      const r = s.read();
      const active = Math.hypot(r.sx, r.sy) > 0.05 || Math.hypot(r.rsx, r.rsy) > 0.3 || r.pass || r.shoot || r.lob || r.through || r.switch || r.skill || r.sprint || r.jockey || r.teamPress || r.trap || r.keeper || r.plan;
      if (active) this.lastDevice = s.device;
      m.sx += r.sx; m.sy += r.sy;
      m.rsx += r.rsx; m.rsy += r.rsy;
      for (const k of ['sprint', 'jockey', 'pass', 'through', 'lob', 'shoot', 'switch', 'skill', 'pause', 'help', 'teamPress', 'trap', 'keeper', 'plan'] as const) m[k] = m[k] || r[k];
    }
    const l = Math.hypot(m.sx, m.sy);
    if (l > 1) { m.sx /= l; m.sy /= l; }
    if (this.sprintToggle) {
      if (m.sprint && !this.sprintRaw) this.sprintLatch = !this.sprintLatch;
      this.sprintRaw = m.sprint;
      if (Math.hypot(m.sx, m.sy) < 0.15) this.sprintLatch = false;
      m.sprint = this.sprintLatch;
    }
    return m;
  }

  /** Camera heading on the ground (radians, 0 = looking along -z); set by the app each frame. */
  yaw = 0;

  /** Screen stick (right, up) to pitch (x, z), relative to the camera heading. */
  toWorld(sx: number, sy: number): [number, number] {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return [sx * c + sy * s, sx * s - sy * c];
  }

  /** One 60 Hz sample. Movement is mapped camera-relative: screen up = away from the camera (-z when it faces the pitch square-on). */
  sample(now: number, ctx: SampleContext, enabled = true): InputFrame {
    const r = this.merged();
    const p = this.prev;
    const ev: InputEvent[] = [];
    const pressed = (k: keyof RawState) => !!r[k] && !p[k];
    const released = (k: keyof RawState) => !r[k] && !!p[k];
    if (pressed('pause')) this.onPause();
    if (pressed('help')) this.onHelp();
    if (enabled) {
      this.switchUsed = false;
      if (ctx.attacking || this.chargeKind) this.chargeKicks(r, now, pressed, released, ev);
      else {
        // Defending: these act on the press (tackle, contain, slide; the modifier with the slide button is a tactical foul).
        if (pressed('pass')) ev.push({ k: 'pass' });
        if (pressed('through')) ev.push({ k: 'through' });
        if (pressed('lob')) ev.push(r.jockey ? { k: 'lob', m: true } : { k: 'lob' });
      }
      if (!ctx.attacking && pressed('teamPress')) ev.push({ k: 'press' });
      if (!ctx.attacking && pressed('trap')) ev.push({ k: 'trap' });
      if (pressed('switch') && !this.switchUsed) ev.push({ k: 'switch' });
      if (pressed('keeper')) ev.push({ k: 'keeper' });
      if (pressed('plan')) ev.push({ k: 'plan', p: ((this.planIndex + 1) % 5) / 4 });
      // Skill moves: with the modifier held, the ball roll, elastico and drag-back turn.
      if (pressed('skill')) ev.push(r.jockey ? { k: 'skill', m: true } : { k: 'skill' });
      // Right-stick flick, camera-relative like movement: a skill move with the ball, a directed switch without.
      const rm = Math.hypot(r.rsx, r.rsy);
      if (rm < FLICK_OFF) this.flickArmed = true;
      else if (rm > FLICK_ON && this.flickArmed) {
        this.flickArmed = false;
        const [fx, fz] = this.toWorld(r.rsx / rm, r.rsy / rm);
        ev.push(ctx.attacking ? (r.jockey ? { k: 'skill', x: fx, z: fz, m: true } : { k: 'skill', x: fx, z: fz }) : { k: 'switch', x: fx, z: fz, m: this.stickSwitch === 'ball' });
      }
      for (const e of this.extra.splice(0)) ev.push(e);
      if (!ctx.attacking && !this.chargeKind && pressed('shoot')) { ev.push({ k: 'shoot', p: 0.4 }); this.suppressShootRelease = true; }
      if (released('shoot')) this.suppressShootRelease = false;
    } else {
      this.endCharge();
      this.extra = [];
    }
    this.prev = r;
    // Holding the through-ball button without the ball asks the nearest teammate to press (contain).
    const contain = enabled && !ctx.attacking && r.through;
    const [mx, mz] = this.toWorld(r.sx, r.sy);
    return { seq: ++this.seq, mx: enabled ? mx : 0, mz: enabled ? mz : 0, sprint: enabled && r.sprint, jockey: enabled && r.jockey, contain, ev: ev.slice(0, 4) };
  }

  /**
   * Attacking: every kick button charges while held and fires on release with its power.
   * Pass, through ball and lob use the charge to pick a near or far teammate. Holding lob or
   * through together with shoot turns the shot into a chip or a low drive; the lob or through
   * ball is then not played. The jockey button is the modifier (finesse shot, driven pass,
   * lofted through ball), read at the moment of release.
   */
  private chargeKicks(r: RawState, now: number, pressed: (k: keyof RawState) => boolean, released: (k: keyof RawState) => boolean, ev: InputEvent[]) {
    const p = this.prev;
    if (pressed('shoot') && !this.suppressShootRelease) {
      // A lob or through ball being charged becomes the shot's style.
      const style = r.lob ? 'chip' : r.through ? 'low' : undefined;
      this.startCharge('shoot', now);
      this.shotStyle = style;
    } else if (this.chargeKind === 'shoot' && pressed('pass')) {
      // Fake shot: pass pressed while the shot is being wound up cancels it into a cut across the ball.
      const [fx, fz] = this.toWorld(r.sx, r.sy);
      ev.push({ k: 'skill', v: 'fake', x: fx, z: fz });
      this.endCharge();
      this.suppressShootRelease = true;
      return;
    } else if (this.chargeKind === 'shoot' && !this.shotStyle) {
      if (pressed('lob')) this.shotStyle = 'chip';
      else if (pressed('through')) this.shotStyle = 'low';
      else if (pressed('switch')) { this.shotStyle = 'placed'; this.switchUsed = true; }
    } else if (this.chargeKind === 'shoot' && pressed('switch')) this.switchUsed = true;
    if (!this.chargeKind) {
      for (const k of ['pass', 'through', 'lob'] as const) if (pressed(k)) { this.startCharge(k, now); break; }
    }
    const k = this.chargeKind;
    if (k && released(k)) {
      const power = this.charge(now);
      const m = r.jockey || p.jockey;
      if (k === 'shoot') {
        // Shot types: modifier = finesse, modifier + sprint = power, a second button = chip / low drive / placed.
        const e: InputEvent = this.shotStyle ? { k: 'shoot', p: power, m, v: this.shotStyle } : m && (r.sprint || p.sprint) ? { k: 'shoot', p: power, m, v: 'power' } : { k: 'shoot', p: power, m };
        if (this.shotAssist === 'manual') e.a = 2;
        ev.push(e);
      }
      else {
        const e: InputEvent = this.locked >= 0 ? { k, p: power, m, r: this.locked } : { k, p: power, m };
        if (this.passAssist !== 'assisted') e.a = this.passAssist === 'semi' ? 1 : 2;
        ev.push(e);
      }
      this.endCharge();
    }
  }

  /** Whether the modifier (jockey) button is held right now, for the kick label. */
  modifierHeld() {
    return this.prev.jockey;
  }

  /** A click on the pitch: switch to the teammate nearest that point (sent with the next sample). */
  switchAt(x: number, z: number) {
    this.extra.push({ k: 'switch', x, z, at: true });
    this.lastDevice = 'keyboard';
  }

  /** Focus loss / interruption: nobody keeps running and no half-charged shot fires. */
  clear() {
    this.sprintLatch = false;
    for (const s of this.sources) s.clear();
    this.prev = emptyRaw();
    this.endCharge();
    this.extra = [];
    this.flickArmed = true;
  }

  get nextSeq() {
    return this.seq;
  }
}
