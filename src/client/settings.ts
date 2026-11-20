import { defaultTactics, cleanTactics, type Tactics } from '../shared/teams';
// Player settings, persisted per browser (best effort: storage can be unavailable).

import type { AudioSettings } from './audio/audio';
import { cleanBindings, defaultBindings, migrateKeysNov20, type ControlBindings } from './input/bindings';
import type { CameraSettings } from './render/camera';
import type { GraphicsSettings } from './render/renderer';
import type { SwitchSens, SwitchStyle } from '../shared/types';

export interface Settings {
  audio: AudioSettings;
  graphics: GraphicsSettings;
  camera: CameraSettings;
  autoSwitch: boolean;
  /** Auto-switch style (20 Nov 2026): Off, High balls, Assisted (only when beaten) or Full. autoSwitch follows it. */
  switchStyle?: SwitchStyle;
  /** How readily the auto-switch moves you: Calm, Normal or Eager. */
  switchSens?: SwitchSens;
  /** A flash on the new player, a soft click and a light buzz whenever control switches while defending. */
  switchCue?: boolean;
  quickRestarts: boolean;
  /** Pass receiver: 'late' picks on release (charge = distance), 'early' locks on press (charge = pace). */
  receiver: 'early' | 'late';
  /** Pass assistance: how much the game helps aim and weigh passes. */
  passAssist: 'assisted' | 'semi' | 'manual';
  /** Shot assistance: Manual aims exactly where the stick points, with no help on target (19 Nov 2026). */
  shotAssist: 'assisted' | 'manual';
  /** Home crowd momentum: the home crowd lifts your side when it is on top (offline; 19 Nov 2026). */
  momentum: boolean;
  /** Right-stick switching: a flick picks the teammate in that direction from your player, or from the ball. */
  stickSwitch: 'player' | 'ball';
  /** Your team instructions (formation and sliders), used offline and sent to the server online. */
  tactics: Tactics;
  /** Where the Adaptive difficulty starts next match (1 Pro .. 3 World class); updated after each match. */
  adaptiveLevel: number;
  highContrast: boolean;
  showNextMarker: boolean;
  /** Ring (and facing arrow) on the grass under your controlled player; off by default, the pointer above the head stays. */
  playerRing: boolean;
  /** Controller rumble on shots, tackles, goals and the woodwork (where the browser supports it). */
  rumble: boolean;
  /** On-screen captions for throw-ins, goal kicks, corners and free kicks (off by default). */
  restartCaptions: boolean;
  /** Bar of button hints along the bottom of the match screen ("Pass (hold = further) · Shoot ..."); on by default. */
  controlHints: boolean;
  /** A small frame-rate readout at the top of the match screen (19 Nov 2026). */
  showFps?: boolean;
  /** Stadium fly-in and tunnel walk-out before kick-off (offline). */
  matchIntro: boolean;
  /** Net-cam replay after each goal (offline). */
  goalReplays: boolean;
  /** Highlights reel (goals, saves, near misses) at half-time and full time (offline). */
  highlights: boolean;
  /** Goal celebrations (knee slides, crest kisses, huddles) shown before the replay (offline). */
  celebrations?: boolean;
  /** Before kick-off: mascots on the walk-out, the handshake line and the team photos (offline). */
  ceremony?: boolean;
  /** Half-time: blimp and drone shots over the ground before the highlights (offline). */
  aerials?: boolean;
  /** Offside checks shown again with the lines drawn, on the big screens and full screen (offline). */
  varChecks?: boolean;
  /** TV cutaways at stoppages: the player, his manager or the fans after a near miss, save, booking or foul (default on). */
  cutaways?: boolean;
  /** TV line-ups before kick-off and stat strips during play (the broadcast score bug always shows). */
  tvGraphics: boolean;
  /** Live 3D stadium behind the menus (the computer plays a match; client/menuscene.ts). */
  menuBackdrop: boolean;
  /** Set once a tablet's old Low default has been moved up to Medium (18 Nov 2026). */
  tabletMedium?: boolean;
  /** Set once graphics were lowered for a browser that draws in software (no graphics acceleration, 20 Nov 2026). */
  softwareLow?: boolean;
  /** Set once commentary has been turned off on phones and tablets (Philip, 20 Nov 2026: the captions sit over the middle of the pitch). */
  commentaryOffTouch?: boolean;
  /** Set once an old saved Tracking camera has been moved to the new Broadcast default (18 Nov 2026). */
  broadcastDefault?: boolean;
  /** Set once old saved settings have been moved to the new Player ring Off default (18 Nov 2026). */
  ringOffDefault?: boolean;
  /** Wind in matches (rolled with the weather); off keeps every match still. */
  wind: boolean;
  /** Set once old saved settings have been moved to the new announcer Off default (19 Nov 2026). */
  announcerOffDefault?: boolean;
  /** Set once keyboard controls still on the old defaults have moved to Philip's layout (20 Nov 2026). */
  keysNov20?: boolean;
  /** Accessibility: kits chosen to stand apart for this kind of colour vision. */
  colourVision: import('./access').ColourVision;
  /** Accessibility: menu and on-screen text size. */
  textSize: import('./access').TextSize;
  /** Accessibility: how long kicks take to charge fully. */
  chargeSpeed: import('./access').ChargeSpeed;
  /** Accessibility: sprint toggles on and off instead of being held. */
  sprintToggle: boolean;
  /** PC: play with the mouse (the pointer steers, clicks pass and shoot; Controls > Mouse). */
  mouseControl: boolean;
  /** Match commentary (19 Nov 2026): the device's speech voice with captions, captions only, or off. */
  commentator?: 'voice' | 'captions' | 'off';
  /** Keyboard keys and controller buttons for each action (Controls menu). */
  controls: ControlBindings;
  name: string;
}

const KEY = 'elevens.settings.v1';

/** Touch screen at least 700 px on its short side: an iPad or other tablet, not a phone. */
export function isTablet(): boolean {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return coarse && typeof screen !== 'undefined' && Math.min(screen.width, screen.height) >= 700;
}

export function defaultSettings(): Settings {
  const mobile = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  // Phones start on Low and tablets on Medium; both show the realistic (Higgsfield) players (Low
  // has them too since 20 Nov 2026, with lighter posing for players off screen).
  return {
    audio: { master: 0.8, effects: 0.9, crowd: 0.6, muted: false, music: 0.5, musicOn: true, commentary: true, menuSounds: true, announcer: false },
    graphics: { preset: mobile ? (isTablet() ? 'medium' : 'low') : 'high', renderScale: mobile ? 0.85 : 1, shadows: !mobile, players: 'realistic', autoRes: true, wear: true, bigMoments: true },
    camera: { mode: 'broadcast', height: 'standard', zoom: mobile ? 'near' : 'standard', reducedMotion: false },
    // Phones and tablets: commentary off (its captions cover the middle of a small screen).
    commentator: mobile ? 'off' : 'captions',
    autoSwitch: true,
    switchStyle: 'full',
    switchSens: 'normal',
    switchCue: true,
    quickRestarts: true,
    receiver: 'late',
    passAssist: 'assisted',
    shotAssist: 'assisted',
    momentum: true,
    stickSwitch: 'player',
    tactics: defaultTactics(),
    adaptiveLevel: 2,
    highContrast: false,
    showNextMarker: true,
    playerRing: false,
    rumble: true,
    restartCaptions: false,
    controlHints: true,
    showFps: false,
    matchIntro: true,
    goalReplays: true,
    highlights: true,
    celebrations: true,
    ceremony: true,
    aerials: true,
    varChecks: true,
    cutaways: true,
    tvGraphics: true,
    wind: true,
    menuBackdrop: true,
    colourVision: 'off',
    textSize: 'normal',
    chargeSpeed: 'normal',
    sprintToggle: false,
    mouseControl: false,
    controls: defaultBindings(),
    name: '',
    // A new player already has today's defaults: the one-time moves in loadSettings are for older saves only.
    tabletMedium: true,
    broadcastDefault: true,
    ringOffDefault: true,
    announcerOffDefault: true,
    commentaryOffTouch: true,
    keysNov20: true,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const out: Settings = { ...d, ...s, audio: { ...d.audio, ...s.audio }, graphics: { ...d.graphics, ...s.graphics }, camera: { ...d.camera, ...s.camera }, tactics: cleanTactics(s.tactics), controls: cleanBindings(s.controls) };
    // Auto-switch styles (20 Nov 2026): an older On/Off setting becomes Full or Off.
    if (!s.switchStyle) out.switchStyle = out.autoSwitch === false ? 'off' : 'full';
    out.autoSwitch = out.switchStyle !== 'off';
    // One-time moves to newer defaults (not on ?test pages, whose scripts set settings exactly).
    const test = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test');
    if (test) return out;
    // Tablets saved before 18 Nov started on Low (classic players): move them up to Medium once.
    if (!s.tabletMedium && isTablet()) {
      if (out.graphics.preset === 'low') out.graphics.preset = 'medium';
      out.tabletMedium = true;
    }
    // Broadcast became the default camera on 18 Nov: settings saved before then held the old default.
    if (!s.broadcastDefault) {
      if ((out.camera.mode ?? 'tracking') === 'tracking') out.camera.mode = 'broadcast';
      out.broadcastDefault = true;
    }
    // The ring under your player became optional (Off by default) on 18 Nov: turn it off once.
    if (!s.ringOffDefault) {
      out.playerRing = false;
      out.ringOffDefault = true;
    }
    // Philip asked for commentary off on phones and tablets (20 Nov): turn it off there once.
    if (!s.commentaryOffTouch) {
      if (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) out.commentator = 'off';
      out.commentaryOffTouch = true;
    }
    // Philip asked for the stadium announcer to be off by default (19 Nov): turn it off once.
    if (!s.announcerOffDefault) {
      out.audio.announcer = false;
      out.announcerOffDefault = true;
    }
    // Philip's keyboard layout became the default (20 Nov): untouched old default keys move to it once.
    if (!s.keysNov20) {
      migrateKeysNov20(out.controls);
      out.keysNov20 = true;
    }
    return out;
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
