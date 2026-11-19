import { defaultTactics, cleanTactics, type Tactics } from '../shared/teams';
// Player settings, persisted per browser (best effort: storage can be unavailable).

import type { AudioSettings } from './audio/audio';
import { cleanBindings, defaultBindings, type ControlBindings } from './input/bindings';
import type { CameraSettings } from './render/camera';
import type { GraphicsSettings } from './render/renderer';

export interface Settings {
  audio: AudioSettings;
  graphics: GraphicsSettings;
  camera: CameraSettings;
  autoSwitch: boolean;
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
  /** TV line-ups before kick-off and stat strips during play (the broadcast score bug always shows). */
  tvGraphics: boolean;
  /** Live 3D stadium behind the menus (the computer plays a match; client/menuscene.ts). */
  menuBackdrop: boolean;
  /** Set once a tablet's old Low default has been moved up to Medium (18 Nov 2026). */
  tabletMedium?: boolean;
  /** Set once an old saved Tracking camera has been moved to the new Broadcast default (18 Nov 2026). */
  broadcastDefault?: boolean;
  /** Set once old saved settings have been moved to the new Player ring Off default (18 Nov 2026). */
  ringOffDefault?: boolean;
  /** Wind in matches (rolled with the weather); off keeps every match still. */
  wind: boolean;
  /** Set once old saved settings have been moved to the new announcer Off default (19 Nov 2026). */
  announcerOffDefault?: boolean;
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
  // Phones start on Low; tablets on Medium, which shows the realistic (Higgsfield) players.
  return {
    audio: { master: 0.8, effects: 0.9, crowd: 0.6, muted: false, music: 0.5, musicOn: true, commentary: true, menuSounds: true, announcer: false },
    graphics: { preset: mobile ? (isTablet() ? 'medium' : 'low') : 'high', renderScale: mobile ? 0.85 : 1, shadows: !mobile, players: 'realistic', autoRes: true, wear: true, bigMoments: true },
    camera: { mode: 'broadcast', height: 'standard', zoom: mobile ? 'near' : 'standard', reducedMotion: false },
    autoSwitch: true,
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
    matchIntro: true,
    goalReplays: true,
    highlights: true,
    celebrations: true,
    ceremony: true,
    aerials: true,
    varChecks: true,
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
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const out: Settings = { ...d, ...s, audio: { ...d.audio, ...s.audio }, graphics: { ...d.graphics, ...s.graphics }, camera: { ...d.camera, ...s.camera }, tactics: cleanTactics(s.tactics), controls: cleanBindings(s.controls) };
    // One-time moves to newer defaults (not on ?test pages, whose scripts set settings exactly).
    const test = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test');
    if (test) return out;
    // Tablets saved before 18 Nov started on Low (classic players): move them up to Medium once.
    if (!out.tabletMedium && isTablet()) {
      if (out.graphics.preset === 'low') out.graphics.preset = 'medium';
      out.tabletMedium = true;
    }
    // Broadcast became the default camera on 18 Nov: settings saved before then held the old default.
    if (!out.broadcastDefault) {
      if ((out.camera.mode ?? 'tracking') === 'tracking') out.camera.mode = 'broadcast';
      out.broadcastDefault = true;
    }
    // The ring under your player became optional (Off by default) on 18 Nov: turn it off once.
    if (!out.ringOffDefault) {
      out.playerRing = false;
      out.ringOffDefault = true;
    }
    // Philip asked for the stadium announcer to be off by default (19 Nov): turn it off once.
    if (!out.announcerOffDefault) {
      out.audio.announcer = false;
      out.announcerOffDefault = true;
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
