// App shell: screen flow (title → mode → teams → settings → loading → match →
// half-time → full-time → results), the frame loop, and wiring between the
// session (offline or online), renderer, HUD, audio and input.

import { PLAY_STYLE_NAMES, PLAY_STYLE_NOTES, styleForClub } from '../shared/playstyle';
import type { Difficulty, GamePlan, Mentality } from '../shared/config';
import { GAME_PLANS, GAME_PLAN_NAMES, MATCH, PITCH } from '../shared/config';
import { inCrossZone, selectReceiver, timingRing, SEMI_PASS_ANGLE } from '../shared/kick';
import { DIST_LABEL, distributionFor, pickDistribution } from '../shared/ai/distribution';
import { wallSize } from '../shared/ai/team';
import { partnerships } from '../shared/ai/mates3';
import { defaultConfig } from '../shared/match';
import { cleanWeather, rollWeatherKind, rollWind, windText, type MatchWeather, type WeatherKind } from '../shared/weather';
import type { RoomState, ServerMsg } from '../shared/protocol';
import { ROOM_CODE_RE } from '../shared/protocol';
import { clockText, minuteText } from '../shared/snapshot';
import { ALL_CLUBS, BADGE_EMBLEMS, BADGE_SHAPES, FLAVOURS, FLAVOUR_NAMES, FORMATIONS, FORMATION_NAMES, TEAMS, benchFor, buildCustomClub, defaultTactics, isCustomId, playableClubs, statLine as defStats, teamById, teamRatings, type CustomClubSpec, type Formation, type Kit, type Tactics, type TeamDef } from '../shared/teams';
import type { MatchConfig, MatchEvent, Player, TeamIndex, TeamStats } from '../shared/types';
import { GameAudio, WHISTLES, type WhistleKind } from './audio/audio';
import { CineDirector, introCaption } from './cine';
import { groundFor, groundInSentence } from '../shared/grounds';
import { OfflineSession } from './game/offline';
import { defaultPicks, listDevices, localKind, moveToken, seatsFor, splitKeyMap, SPLIT_KEYS, type LocalDevice, type Seat, type SidePick } from './game/local';
import type { Session } from './game/session';
import { ActionLayer, type InputSource } from './input/actions';
import { GamepadSource } from './input/gamepad';
import { attachKeyboard, KeyboardState } from './input/keyboard';
import { attachMouse, MouseSource } from './input/mouse';
import { isTouchDevice, TouchControls, TouchModel, type TouchContext } from './input/touch';
import { NetClient } from './net/netclient';
import { isLocalHost, onServerState, PLAY_URL, serverState, wakeServer } from './net/hosting';
import { OnlineSession, type StartInfo } from './net/online';
import { AUTO_RES_MIN, GameRenderer, realisticPlayers } from './render/renderer';
import { MOW_NAMES, MOW_PATTERNS, type MowSetting } from './render/vfx';
import { loadPlayerAssets, playerAssetStatus } from './render/realplayer';
import { glStatus, glStatusText } from './render/glcheck';
import { isSoftwareRenderer, lowerGraphics, SlowGuard, softwareGraphics, type SlowSettings } from './render/slowguard';
import type { CameraMode } from './render/camera';
import { loadSettings, saveSettings, type Settings } from './settings';
import { controlsTable, guideLine } from './ui/controls';
import { assign, BIND_ACTIONS, clearSlot, defaultBindings, keyLabel, keysText, mouseAsKeys, padLabel, padText, RESERVED_KEYS, unboundActions, type BindAction, type BindDevice } from './input/bindings';
import { Hud } from './ui/hud';
import { statsGraphic, TvGraphics } from './ui/tvgfx';
import { WEATHER_NAMES } from './render/weather';
import type { ViewState } from './view';
import { SLOW_MO, SlowMo } from './slowmo';
import { CUP_SIZES, LEAGUE_SIZES, cupRounds, leagueTable, myFixture, newCompetition, opponentOf, recordResult, roundName, scoreText, type CompKind, type Competition, type Fixture } from '../shared/competition';
import { ACHIEVEMENTS, SLOT_COUNT, applyClubs, goalSequence, loadStore, newProfile, recordMatch, recordTrophy, saveStore, today, unlock, type Achievement, type GoalDetail, type MatchSummary, type Profile, type ProfileStore } from './profile';
import { badgeSvg, clubBadge } from './ui/badge';
import { CHARGE_SCALE, COLOUR_VISION, applyTextSize, pickOppKit, type ChargeSpeed, type ColourVision, type TextSize } from './access';
import { Coach } from './tutorial';
import { FILTER_CSS, PHOTO_FILTERS, PhotoMode, composePhoto } from './photo';
import { installInfo, registerOffline, toggleFullscreen } from './install';
import type { Rated } from '../shared/ratings';
import { possessionTeam } from './view';
import { MenuBackdrop } from './menuscene';
import { ScreenTransitions } from './ui/transitions';
import { loadingHtml, loadingTips, LoadingScreen, type LoadingInfo } from './ui/loading';
import { Announcer, lineupLines, welcomeLines, type AnnounceTeam } from './audio/announcer';
import { captainIndex } from './render/look';
import { loadChoice, loadMenuOpen, saveChoice, saveMenuOpen, type MatchChoice } from './quickmatch';
import { ModeScreens, type ModeMatch } from './modes/screens';
import { clearModes } from './modes/store';
import { ClipTheatre, makeClip, saveClip, shareVideo, type GoalClip } from './modes/clips';
import { Commentator } from './commentator';
import { loadRanked, rankedHtml, rankedResultHtml, saveRanked } from './modes/ranked';
import { clearSquadOverrides, setSquadOverrides } from '../shared/teams';

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Overlay = 'none' | 'pause' | 'halftime' | 'fulltime' | 'help' | 'settings' | 'replay' | 'photo';

export class App {
  settings: Settings = loadSettings();
  audio = new GameAudio(this.settings.audio);
  hud: Hud;
  /** Broadcast graphics: score bug style, line-ups, lower-thirds. */
  tv: TvGraphics;
  cine: CineDirector;
  private lastCine = 'none';
  private padSkip = false;
  /** Test pages (?test) skip the intro and replays unless they ask for them (&cine). */
  /** Slow motion after goals and the woodwork (offline). */
  private slowMo = new SlowMo();
  private cineOff = new URLSearchParams(location.search).has('test') && !new URLSearchParams(location.search).has('cine');
  renderer: GameRenderer | null = null;
  keyboard = new KeyboardState();
  /** Mouse and keyboard play (Settings > Mouse control): the pointer steers, clicks and keys kick. */
  mouse = new MouseSource();
  /** Where the mouse pointer is on the page (null when it has left the window). */
  private mousePt: { x: number; y: number } | null = null;
  private cursorShown = '';
  gamepad = new GamepadSource();
  touchModel = new TouchModel();
  /** Local multiplayer: the two halves of a shared keyboard. */
  keysL = new KeyboardState();
  keysR = new KeyboardState();
  /** Local multiplayer: where each device sits on the Choose sides screen, and the seats for the match being set up (null: one player v computer). */
  private local: { picks: Record<string, SidePick>; split: boolean; seats: Seat[] | null; prev: Record<string, { x: number; a: boolean; b: boolean }>; keyHeard: boolean; sig: string } = { picks: {}, split: false, seats: null, prev: {}, keyHeard: false, sig: '' };
  /** The seats of the local multiplayer match being played (null otherwise) and the extra seats' input layers. */
  private localPlaying: Seat[] | null = null;
  private extraLayers: { seat: Seat; layer: ActionLayer }[] = [];
  touch: TouchControls;
  actions: ActionLayer;
  session: Session | null = null;
  net: NetClient | null = null;
  room: RoomState | null = null;
  onlineStart: StartInfo | null = null;
  private ui: HTMLElement;
  private overlay: Overlay = 'none';
  /** Save slots: the profiles on this device and the one in use (its clubs, cup or league, stats and achievements). */
  private store: ProfileStore = loadStore(this.settings.name);
  private get profile(): Profile { return this.store.slots[this.store.active]!; }
  /** Cup or league in progress (the active profile's), and whether the current match counts for it. */
  private get comp(): Competition | null { return this.profile.comp; }
  private set comp(c: Competition | null) { this.profile.comp = c; this.saveProfile(); }
  /** What we track during a match for the profile (goal kinds, set pieces, shot distances). */
  private track = { restart: '', restartKick: '', lastKick: { text: '', x: 0, z: 0, player: -1, team: -1, from: '' }, goals: [] as GoalDetail[] };
  /** Guided first match: the coach card, while it runs. */
  private coach: Coach | null = null;
  /** The computer side's kit when it had to change into a plain change kit. */
  private kitOverride: TeamDef | null = null;
  private tutorialMatch = false;
  /** Photo mode (pause menu, offline). */
  private photo = new PhotoMode();
  private photoDrag: { x: number; y: number } | null = null;
  /** Club creator: the club being made or edited, and which part of it is open. */
  private draft: CustomClubSpec | null = null;
  private draftTab: 'kit' | 'away' | 'badge' = 'kit';
  private profileTab: 'career' | 'awards' | 'clubs' | 'slots' = 'career';
  private slotConfirm = -1;
  private achieveEl: HTMLElement;
  private compMatch = false;
  /** Panel to open when the half-time / full-time highlights finish (or are skipped). */
  private afterReel: ((v: ViewState) => void) | null = null;
  /** The last shot struck in open play, to name who hit the woodwork or forced a save. */
  private lastShooter = { player: -1, team: 0, at: -1e9 };
  /** Full-time side effects (cup/league result, adaptive level) happen once, even when the panel is shown again. */
  private resultsNote: string | null = null;
  private compSetup: { kind: CompKind; club: string; leagueSize: number; cupSize: number } = { kind: 'cup', club: TEAMS[0].id, leagueSize: 8, cupSize: 8 };
  private compConfirm = false;
  /** The realistic player models have been downloaded (or we gave up waiting). */
  private playersReady = false;
  /**
   * The realistic players just failed to download: this kick-off goes ahead with the simple players
   * (20 Nov 2026: v80 kept retrying instead, so a PC whose download failed never got past the loading
   * card). Cleared as that match starts, so the next kick-off tries the download again.
   */
  private playersFailedOnce = false;
  /** Half-time / full-time panel: team stats or player ratings. */
  private resultsTab: 'stats' | 'ratings' = 'stats';
  private screenName = 'mode';
  private last = performance.now();
  private fps = 60;
  private touchCovered = false;
  /** The frame-rate readout: frames since the last refresh (twice a second), their total and the slowest. */
  private fpsWin = { n: 0, sum: 0, worst: 0, at: 0, text: '' };
  /** The last frame's real duration in ms (auto resolution). */
  private rawMs = 16.7;
  private autoResOn = !new URLSearchParams(location.search).has('test') || new URLSearchParams(location.search).has('autores');
  private frameMs = 16;
  /** Lowers graphics when a 3D scene keeps running under 15 fps (render/slowguard.ts). Off on test pages unless &slowguard. */
  private slowGuard = new SlowGuard();
  private slowScene = '';
  private slowGuardOn = !new URLSearchParams(location.search).has('test') || new URLSearchParams(location.search).has('slowguard');
  private debugOn = new URLSearchParams(location.search).has('debug');
  private debugOverlay = this.debugOn;
  private debugDraw = false;
  /** The match setup (kept on this device: the main menu's Kick off plays it in one press). */
  private choice: MatchChoice = loadChoice({ club: TEAMS[0].id, opp: TEAMS[1].id, kit: 'home', oppKit: 'home', difficulty: 'pro', mentality: 'balanced', minutes: MATCH.defaultRealMinutes, draw: 'stand' });
  /** Optional menu sections the player left open (More modes, More match options). */
  private menuOpen = loadMenuOpen();
  private lastPhase = '';
  private onlineError = '';
  private endReason = '';
  private padNav = { dir: '', next: 0, prevA: false, prevB: false, key: '', idx: -1 };
  private padSel: HTMLElement | null = null;
  /** Controls menu: the slot waiting for a new key or button, and what happened last. */
  private rebind: { device: BindDevice; action: BindAction; slot: number; until: number; armed: boolean } | null = null;
  private bindTab: 'keys' | 'pad' | 'mouse' | 'list' | '' = '';
  /** Clicks and the browser menu are swallowed briefly after a mouse button was taken for a binding. */
  private swallowUntil = 0;
  private bindMsg = '';
  private bindFlash: BindAction[] = [];
  private controlsBack: (() => void) | null = null;
  private controlsOverlay = false;
  private touchDevice = isTouchDevice();
  /** Live stadium behind the menus (off on ?test pages unless &menubg). */
  backdrop: MenuBackdrop;
  private backdropOff = new URLSearchParams(location.search).has('test') && !new URLSearchParams(location.search).has('menubg');
  /** Screen transitions (off on ?test pages unless &anim, and with reduced motion). */
  private transitions: ScreenTransitions;
  private animOff = new URLSearchParams(location.search).has('test') && !new URLSearchParams(location.search).has('anim');
  /** Set for a moment by a Back press, so the next screen slides in from the other side. */
  private goingBack = 0;
  private loadScreen: LoadingScreen | null = null;
  /** The clubs and kits the stadium was last built for (the menus keep them after a match). */
  private lastTeams: { teams: [string, string]; kits: ['home' | 'away', 'home' | 'away'] } | null = null;
  /** Stadium announcer (welcome during the intro, line-ups before kick-off; offline). */
  announcer = new Announcer();
  /** Career, Be a Pro, scenarios, skill games, trophy cabinet, saved goals (client/modes). */
  modes!: ModeScreens;
  /** The mode match being played (null for a quick match, cup or league, practice, online). */
  private modeMatch: ModeMatch | null = null;
  /** Match commentary: captions and (optionally) the browser's voice. */
  commentator!: Commentator;
  /** A saved goal playing on the menus. */
  private theatre = new ClipTheatre();
  /** Ranked online: this device's identity and record, the queue, the last result. */
  private ranked = loadRanked();
  private rankQueued = false;
  private rankWaiting = 0;
  private rankRes: Extract<ServerMsg, { t: 'rankres' }> | null = null;
  /** Goals saved from this full-time panel (by highlight index). */
  private savedGoals = new Set<number>();
  /** Touch controls are used on touch screens unless a controller is connected. */
  private get touchMode() { return this.touchDevice && this.gamepad.index < 0 && !this.settings.mouseControl; }
  /** Mouse control is on (and in use for this player: local multiplayer keyboard halves keep their keys). */
  private get mouseMode() { return !!this.settings.mouseControl; }
  /** The keyboard-side source for one player: the mouse layout when mouse control is on, else the keyboard. */
  private get keySource(): InputSource { return this.mouseMode ? this.mouse : this.keyboard; }

  constructor() {
    // Start downloading the realistic players on the title screen, so they are in by kick-off.
    if (realisticPlayers(this.settings.graphics)) void loadPlayerAssets();
    this.ui = document.getElementById('ui')!;
    applyClubs(this.profile);
    this.saveProfile();
    applyTextSize(this.settings.textSize);
    this.achieveEl = document.createElement('div');
    this.achieveEl.className = 'achieve-stack';
    document.body.appendChild(this.achieveEl);
    void registerOffline();
    this.backdrop = new MenuBackdrop(document.body);
    this.transitions = new ScreenTransitions(this.ui, {
      key: () => `${this.screenName}|${this.overlay}`,
      back: () => performance.now() - this.goingBack < 600,
      enabled: () => !this.animOff && !this.settings.camera.reducedMotion && !(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches),
      onChange: (_from, to) => { if (to.startsWith('loading')) this.audio.ui('whoosh'); },
    });
    this.announcer.onLine = (cheer) => { if (cheer) { this.audio.cheer(0.45); this.renderer?.crowdMoment('chant', 0); } };
    this.hud = new Hud(document.getElementById('hud')!);
    this.tv = new TvGraphics(document.getElementById('hud')!);
    this.commentator = new Commentator(document.getElementById('hud')!);
    this.modes = new ModeScreens({
      set: (html, cls) => this.set(html, cls),
      on: (sel, fn) => this.on(sel, fn),
      seg: (n, v, c) => this.seg(n, v, c),
      bindSeg: (n, fn) => this.bindSeg(n, fn),
      kitSwatch: (club, kit) => this.kitSwatch(club, kit),
      home: () => { this.goingBack = performance.now(); this.showMode(); },
      play: (m) => this.playMode(m),
      slot: () => this.store.active,
      profile: () => this.profile,
      choice: () => this.choice,
      watchClip: (c, record) => this.watchClip(c, record),
      focusFirst: () => {},
    });
    this.tv.enabled = this.settings.tvGraphics !== false;
    // The stands show the chants and the stamping the crowd audio plays.
    this.audio.onCrowd = (k) => this.renderer?.crowdMoment(k);
    this.touch = new TouchControls(this.touchModel, document.body);
    this.touch.show(false);
    this.touch.onPause = () => this.togglePause();
    // Match intro and goal replays: the match waits while one plays; any input skips it.
    this.cine = new CineDirector(document.body);
    this.cine.onChange = (mode) => {
      const s = this.session;
      if (s instanceof OfflineSession) s.pause(mode !== 'none' || this.overlay !== 'none' || this.tv.holding);
      const inMatch = !!s && this.screenName === 'match';
      this.hud.show(inMatch && mode === 'none');
      this.touch.show(inMatch && mode === 'none' && this.touchMode);
      this.actions.clear();
      const v = s?.view();
      if (mode === 'none' && v) this.renderer?.snapCamera(v);
      // After the walk-out: the line-ups, as on TV.
      if (mode === 'none' && this.lastCine === 'intro' && inMatch) this.startLineups();
      this.lastCine = mode;
      // After the half-time / full-time highlights: the stats panel.
      if (mode === 'none' && this.afterReel) {
        const open = this.afterReel;
        this.afterReel = null;
        if (v && inMatch) open(v);
      }
    };
    this.cine.onCue = (cue) => {
      if (cue === 'walkout') { this.audio.react('applause'); this.renderer?.crowdMoment('walkout'); }
      else if (cue === 'goal' || cue === 'trophy') this.audio.react('goal');
      else if (cue === 'firework') this.audio.firework();
      else if (cue === 'flash') this.audio.click();
      else this.audio.react('ooh');
    };
    const skip = (e: Event) => {
      if (this.tv.holding && this.overlay === 'none') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.audio.unlock();
        this.tv.skip();
        return;
      }
      if (!this.cine.active || this.overlay !== 'none') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.audio.unlock();
      this.cine.skip();
    };
    window.addEventListener('keydown', (e) => { if (!e.repeat) skip(e); }, true);
    window.addEventListener('pointerdown', skip, true);
    this.actions = new ActionLayer([this.keyboard, this.gamepad, this.touchModel]);
    this.actions.onPause = () => this.togglePause();
    this.actions.onHelp = () => this.toggleHelp();
    this.actions.receiverMode = this.settings.receiver;
    this.actions.passAssist = this.settings.passAssist ?? 'assisted';
    this.actions.shotAssist = this.settings.shotAssist ?? 'assisted';
    this.actions.stickSwitch = this.settings.stickSwitch ?? 'player';
    this.actions.pickReceiver = (kind) => this.receiverNow(kind);
    this.actions.chargeScale = CHARGE_SCALE[this.settings.chargeSpeed ?? 'normal'] ?? 1;
    this.actions.sprintToggle = !!this.settings.sprintToggle;
    this.keyboard.setBindings(this.settings.controls);
    this.mouse.setBindings(this.settings.controls);
    this.gamepad.bindings = this.settings.controls;
    this.applyMouseMode();
    attachMouse(this.mouse, document.getElementById('game')!, () => this.mouseMode && this.screenName === 'match' && this.overlay === 'none' && !!this.session,
      (x, y, inside) => { this.mousePt = inside ? { x, y } : null; });
    // Controls menu: a mouse button or wheel turn for the slot waiting for one (Mouse tab).
    window.addEventListener('pointerdown', (e) => this.captureMouse(e, `Mouse${e.button}`), true);
    window.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) >= 1) this.captureMouse(e, e.deltaY < 0 ? 'WheelUp' : 'WheelDown'); }, { capture: true, passive: false });
    window.addEventListener('contextmenu', (e) => { if ((this.rebind?.device === 'mouse' && this.controlsOpen()) || performance.now() < this.swallowUntil) e.preventDefault(); }, true);
    window.addEventListener('click', (e) => { if (performance.now() < this.swallowUntil) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    // Controls menu key capture: runs before the game's own key handling and swallows the key.
    window.addEventListener('keydown', (e) => this.captureKey(e), true);
    attachKeyboard(this.keyboard, () => this.screenName === 'match');
    this.keysL.setMap(splitKeyMap('left'));
    this.keysR.setMap(splitKeyMap('right'));
    attachKeyboard(this.keysL, () => this.screenName === 'match');
    attachKeyboard(this.keysR, () => this.screenName === 'match');
    window.addEventListener('keydown', (e) => this.localKey(e));
    this.gamepad.attach();
    this.gamepad.onChange = (c, id) => {
      this.hud.toast(c ? `Controller connected: ${id.slice(0, 40)}` : 'Controller disconnected');
      this.applyTouchMode();
      // Losing the controller mid-match pauses an offline game rather than leaving the player stranded.
      if (!c) { this.actions.clear(); if (this.session instanceof OfflineSession && this.overlay === 'none' && this.screenName === 'match') this.openPause(); }
    };
    this.applyTouchMode();
    // Interrupted input: nobody keeps running after focus loss.
    window.addEventListener('blur', () => this.actions.clear());
    document.addEventListener('visibilitychange', () => {
      this.actions.clear();
      if (document.hidden) {
        if (this.session instanceof OfflineSession && this.overlay === 'none' && this.screenName === 'match') this.openPause();
        this.audio.suspend();
      } else {
        this.audio.resume();
        if (this.session instanceof OnlineSession) this.session.resync();
      }
    });
    window.addEventListener('resize', () => { this.renderer?.resize(); this.checkOrientation(); });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3' && this.debugOn) { this.debugOverlay = !this.debugOverlay; e.preventDefault(); }
      if (e.code === 'F4' && this.debugOn) { this.debugDraw = !this.debugDraw; e.preventDefault(); }
    });
    const unlock = () => this.audio.unlock();
    // touchend and click too: on iPhone and iPad a pointerdown is not a gesture, so sound only starts on those.
    for (const ev of ['pointerdown', 'touchend', 'click', 'keydown'] as const) window.addEventListener(ev, unlock, true);
    // Menu sounds: Back has its own, option buttons click, everything else confirms.
    this.ui.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t) return;
      const back = t.dataset.a === 'back' || t.dataset.a === 'menu';
      if (back) this.goingBack = performance.now();
      this.audio.ui(back ? 'back' : t.closest('.seg') ? 'toggle' : 'select');
    }, true);
    // Mouse over a button: the same soft tick as moving the controller highlight.
    this.ui.addEventListener('pointerover', (e) => {
      if ((e as PointerEvent).pointerType !== 'mouse') return;
      const t = (e.target as HTMLElement).closest('button:not([disabled])');
      const from = (e as PointerEvent).relatedTarget as HTMLElement | null;
      if (t && !t.contains(from)) this.audio.ui('move');
    });
    // Speech on iPad needs a real gesture (touchend or click; a pointerdown is too early), so
    // every tap, click or key tries until a silent line is heard to start.
    const unlockVoice = () => { if (this.settings.audio.announcer === true) this.announcer.prime(); };
    for (const ev of ['click', 'touchend', 'keydown'] as const) window.addEventListener(ev, unlockVoice, true);
    this.hud.setHighContrast(this.settings.highContrast);
    this.hud.restartCaptions = this.settings.restartCaptions;
    this.audio.setMusic(true); // menu music, from the first click or key press
    // Wake the online match server now (a free server sleeps when unused), so it is ready by the
    // time anyone opens Online; the Online screen shows its state.
    onServerState(() => { const el = this.ui.querySelector('.server-state'); if (el) el.innerHTML = this.serverStateText(); });
    setTimeout(() => void wakeServer(), 1500);
    const room = new URLSearchParams(location.search).get('room');
    if (room && ROOM_CODE_RE.test(room.toUpperCase())) this.showOnline(room.toUpperCase());
    else this.showMode();
    requestAnimationFrame((t) => this.frame(t));
    // The live stadium starts once the title is on screen (building it takes a moment).
    setTimeout(() => this.startBackdrop(), 350);
  }

  // ------------------------------------------------------------- frame loop

  private frame(now: number) {
    const raw = Math.max(0, now - this.last);
    const dt = Math.min(0.1, raw / 1000);
    this.last = now;
    // The frame-rate readout uses the real frame time, not the clamped simulation step.
    this.frameMs = this.frameMs * 0.9 + Math.min(raw, 2000) * 0.1;
    this.fps = 1000 / Math.max(1, this.frameMs);
    this.rawMs = raw;
    if (raw < 2000) { const w = this.fpsWin; w.worst = Math.max(w.worst, raw); w.n++; w.sum += raw; }
    if (this.session && this.renderer && this.overlay === 'photo') {
      this.photoFrame(dt);
    } else if (this.session && this.renderer) {
      if (this.cine.active || this.tv.holding) this.skipFromPad();
      this.tv.tick(dt);
      // Big moments (offline): play runs in slow motion for a moment after a goal or the woodwork.
      // (A cinematic such as the goal replay or highlights always plays at its own speed.)
      if (this.cine.active) this.slowMo.stop();
      const k = this.slowMo.scale(dt);
      this.session.update(dt * k, now);
      const v = this.session.view();
      if (v) this.renderFrame(v, dt * k, now);
      if (this.overlay !== 'none') this.menuGamepad(now);
    } else {
      if (this.theatre.playing && this.renderer) this.theatre.frame(this.renderer, dt, this.settings.camera);
      else if (this.backdrop.active && this.renderer) this.backdrop.frame(this.renderer, dt, this.settings.camera);
      if (this.screenName === 'sides') this.pollSides();
      else this.menuGamepad(now);
    }
    // A menu over the match (pause, half-time, full-time, photo mode): the on-screen controls sit
    // above the menus, so they go while it is open or their stick area and buttons take its taps.
    const covered = this.overlay !== 'none';
    if (covered !== this.touchCovered) {
      this.touchCovered = covered;
      document.body.classList.toggle('menu-over', covered);
      if (covered) this.touchModel.clear();
    }
    this.watchSpeed(raw, now);
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Lower the graphics a step whenever a 3D scene keeps running too slowly to play. */
  private watchSpeed(raw: number, now: number) {
    if (!this.slowGuardOn || !this.renderer) return;
    const scene = this.session ? (this.overlay === 'none' ? 'match' : '') : this.theatre.playing ? 'theatre' : this.backdrop.active ? 'menu' : '';
    if (scene !== this.slowScene) { this.slowScene = scene; this.slowGuard.rearm(now); }
    if (!scene || document.hidden || !this.slowGuard.feed(raw, now)) return;
    const what = lowerGraphics(this.settings as unknown as SlowSettings);
    if (!what) return;
    saveSettings(this.settings);
    this.renderer.applyGraphics(this.settings.graphics);
    if (this.settings.menuBackdrop === false && this.backdrop.active && !this.session) this.backdrop.stop(this.renderer);
    console.warn(`[graphics] running at under 15 fps: ${what}`);
    this.hud.toast(`Running slowly on this computer: ${what}. Settings > Graphics can change it back.`, 5000);
  }

  /** Any controller button skips a cinematic (on the press, not while held). */
  private skipFromPad() {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let down = false;
    for (const p of pads) if (p) for (const b of p.buttons) if (b.pressed) down = true;
    if (down && !this.padSkip && this.overlay === 'none') { if (this.tv.holding) this.tv.skip(); else this.cine.skip(); }
    this.padSkip = down;
  }

  /** The teammate a pass of this kind would go to right now, from the stick (Early receiver lock). */
  private receiverNow(kind: 'pass' | 'through' | 'lob'): number {
    const s = this.session;
    const v = s?.view();
    if (!s || !v) return -1;
    const lt = s.localTeams[0];
    const ctl = v.ctl[lt];
    if (ctl < 0 || v.ball.owner !== ctl) return -1;
    const r = this.actions.sources.map((x) => x.read()).reduce((a, b) => ({ sx: a.sx + b.sx, sy: a.sy + b.sy }), { sx: 0, sy: 0 });
    const [wx, wz] = this.actions.toWorld(r.sx, r.sy);
    return selectReceiver(v.players as unknown as Player[], v.players[ctl] as unknown as Player, wx, wz, kind, v.attackDir[lt], { runner: true }).receiver;
  }

  /** Which touch buttons to show: attacking, defending, in goal (you control the keeper) or lining up a wall. */
  private touchContext(v: ViewState, lt: number, attacking: boolean): TouchContext {
    const rs = v.restart;
    if (rs && rs.type === 'freekick' && rs.team !== lt && v.humans[lt]) {
      const gx = -PITCH.halfLength * v.attackDir[lt];
      const d = Math.hypot(rs.spot.x - gx, rs.spot.z);
      if (d < 30 && wallSize(d) > 0) return 'wall';
    }
    const c = v.ctl[lt];
    if (!attacking && c >= 0 && v.players[c]?.role === 'GK') return 'keeper';
    return attacking ? 'attack' : 'defend';
  }

  private renderFrame(v: ViewState, dt: number, now: number) {
    const s = this.session!;
    const evs = s.drainEvents();
    this.playEvents(v, evs);
    this.hud.onEvents(v, evs);
    this.tv.onEvents(v, evs);
    this.renderer?.onEvents(v, evs);
    this.bigMoments(s, evs);
    const goalEv = evs.find((e) => e.type === 'goal');
    if (goalEv) this.cine.goal(goalEv);
    for (const e of evs) {
      if (e.type === 'kick' && e.team !== undefined && e.text !== 'touch') this.cine.kick(e.team, v);
      else if (e.type === 'offside' && e.player !== undefined && e.team !== undefined && this.renderer) this.cine.offside(v, e.player, e.team, this.renderer);
    }
    this.noteMoments(s, v, evs);
    this.trackEvents(s, v, evs);
    this.commentator.frame(v, evs, dt, this.overlay === 'none' && !this.cine.active);
    this.matchToasts(v, evs);
    if (this.coach) {
      this.coach.show(this.overlay === 'none' && !this.cine.active && !this.tv.holding);
      if (this.overlay === 'none' && !this.cine.active) {
        const h = this.actions.held();
        this.coach.update(v, evs, dt, { team: s.localTeams[0] ?? 0, attacking: s.attacking(), held: { sprint: h.sprint, jockey: h.jockey, switch: h.switch || Math.hypot(h.rsx, h.rsy) > 0.7, pass: h.pass, lob: h.lob }, name: (a) => this.coachName(a), move: this.moveName() });
      }
    }
    // Intro or replay: draw the staged view from the cinematic camera instead of the match.
    const allowReplay = s instanceof OfflineSession && this.settings.goalReplays && !this.cineOff && !s.cfg.practice && !v.shootout && this.overlay === 'none';
    this.cine.varScreens = this.settings.varChecks !== false;
    this.cine.varChecks = s instanceof OfflineSession && this.settings.varChecks !== false && !this.cineOff && !s.cfg.practice && !v.shootout && this.overlay === 'none';
    this.cine.celebrate = s instanceof OfflineSession && this.settings.celebrations !== false && !this.cineOff && !s.cfg.practice && !v.shootout && this.overlay === 'none';
    // Online the celebration cinematic doesn't play: the live match cuts to the pitchside camera instead.
    this.renderer!.liveHandheld = !(s instanceof OfflineSession) && this.settings.celebrations !== false && !v.shootout;
    const cv = this.cine.frame(v, dt, this.renderer!, allowReplay);
    if (cv) {
      this.renderer!.render(cv.view, cv.dt, this.settings.camera, { localTeams: s.localTeams, receiver: -1, showNext: false, playerRing: this.settings.playerRing, highContrast: false });
      this.audio.setCrowdIntensity(this.cine.mode === 'intro' ? 0.42 : this.cine.mode === 'highlights' ? 0.4 : 0.8);
      return;
    }
    const lt = s.localTeams[0];
    const attacking = s.attacking();
    this.updateMouse(v, lt);
    if (this.touchMode) this.touch.setContext(this.touchContext(v, lt, attacking));
    this.actions.planIndex = Math.max(0, GAME_PLANS.indexOf(v.plans[lt] ?? 'balanced'));
    // Intended-receiver hint while our player has the ball.
    let receiver = -1;
    const ctl = v.ctl[lt];
    // Our keeper has the ball in their hands: the stick aims the distribution, the charge sets how far.
    const gkHold = v.phase === 'play' && v.ball.state === 'held' && v.ball.owner >= 0 && v.players[v.ball.owner].team === lt && v.humans[lt] ? v.players[v.ball.owner] : null;
    let distLabel = '';
    if (gkHold) {
      const r = this.actions.sources.map((x) => x.read()).reduce((a, b) => ({ sx: a.sx + b.sx, sy: a.sy + b.sy }), { sx: 0, sy: 0 });
      const [wx, wz] = this.actions.toWorld(r.sx, r.sy);
      const ch = this.actions.charging(now);
      const kind = distributionFor(ch ? ch.kind : 'lob');
      receiver = pickDistribution(v.players as unknown as Player[], gkHold as unknown as Player, wx, wz, kind, v.attackDir[lt], ch ? ch.power : undefined).receiver;
      if (ch) distLabel = DIST_LABEL[kind];
    } else if (ctl >= 0 && v.ball.owner === ctl && v.phase === 'play') {
      const r = this.actions.sources.map((x) => x.read()).reduce((a, b) => ({ sx: a.sx + b.sx, sy: a.sy + b.sy }), { sx: 0, sy: 0 });
      const [wx, wz] = this.actions.toWorld(r.sx, r.sy);
      // While a pass is charged the hint follows the charge: near teammate on a tap, far on a long hold.
      const ch = this.actions.charging(now);
      if (ch && ch.locked >= 0) receiver = ch.locked;
      else if ((!ch || ch.kind !== 'shoot') && this.settings.passAssist !== 'manual') {
        const kind = ch && ch.kind !== 'shoot' ? ch.kind : 'pass';
        const cone = this.settings.passAssist === 'semi' ? SEMI_PASS_ANGLE : undefined;
        const sel = selectReceiver(v.players as unknown as Player[], v.players[ctl] as unknown as Player, wx, wz, kind, v.attackDir[lt], ch ? { power: ch.power, driven: ch.driven, lofted: ch.lofted, cone, runner: this.settings.passAssist === 'assisted' } : { cone });
        receiver = sel.receiver;
      }
    }
    const charge = this.actions.charge(now);
    // Overhead meter label: the kick, and for a pass who it is going to (locked with Early receiver).
    const chg = this.actions.charging(now);
    const rName = chg && chg.kind !== 'shoot' && receiver >= 0 ? v.players[receiver].def.short.toUpperCase() : '';
    // Crosses from wide: a lob is floated, or whipped with the modifier (also early); a driven pass is a low cross.
    let label = chg?.label ?? '';
    if (chg && ctl >= 0 && v.ball.owner === ctl && !gkHold) {
      const at = v.players[ctl].pos, ad = v.attackDir[lt];
      if (chg.kind === 'lob' && this.actions.modifierHeld() && inCrossZone(at, ad, true)) label = 'WHIPPED CROSS';
      else if (chg.kind === 'lob' && inCrossZone(at, ad)) label = 'FLOATED CROSS';
      else if (chg.kind === 'pass' && chg.driven && inCrossZone(at, ad)) label = 'LOW CROSS';
    }
    if (distLabel) label = distLabel;
    const chargeLabel = chg ? (rName || (gkHold && receiver >= 0) ? `${label} ${chg.locked >= 0 ? '\u{1F512}' : '\u2192'} ${rName || v.players[receiver].def.short.toUpperCase()}` : label) : '';
    const chargeTicks = !!chg && chg.kind !== 'shoot' && chg.locked < 0;
    const cp = gkHold ?? (ctl >= 0 ? v.players[ctl] : null);
    const powerAt = cp && this.renderer ? this.renderer.project(cp.pos.x, 2.3, cp.pos.z) : null;
    // Set-piece timing ring over the ball for a human free kick or penalty.
    const rs = v.restart;
    const ringOn = rs && rs.ready && !rs.quick && (rs.type === 'freekick' || rs.type === 'penalty') && s.localTeams.includes(rs.team) && v.humans[rs.team] && (v.ctl[rs.team] === rs.taker || v.mates?.[rs.team] === rs.taker);
    const ringAt = ringOn && this.renderer ? { ...this.renderer.project(v.ball.pos.x, 0.2, v.ball.pos.z), q: timingRing(rs!.readyT) } : null;
    const debug = this.debugOn && this.debugDraw && s instanceof OfflineSession ? { ...s.debugDraw(), shapes: true } : undefined;
    this.renderer!.render(v, dt, this.settings.camera, { localTeams: s.localTeams, receiver, showNext: this.settings.showNextMarker, playerRing: this.settings.playerRing, highContrast: this.settings.highContrast, slotStyle: this.slotStyles() }, debug);
    // Test pages keep a fixed resolution (software rendering is always slow) unless they ask (&autores).
    if (this.overlay === 'none' && this.autoResOn) this.renderer!.autoResolution(this.rawMs);
    this.actions.yaw = this.renderer!.camera.inputYaw;
    for (const x of this.extraLayers) x.layer.yaw = this.actions.yaw;
    // Local multiplayer: a power bar over each other player's man while they charge a kick.
    const extraPower = this.extraLayers.map(({ seat, layer }) => {
      const ch = layer.charging(now);
      const pid = seat.slot ? v.mates?.[seat.team] ?? -1 : v.ctl[seat.team];
      if (!ch || pid < 0 || !this.renderer) return null;
      const p = v.players[pid];
      return { ...this.renderer.project(p.pos.x, 2.3, p.pos.z), charge: ch.power, label: `P${seat.player} ${ch.label}` };
    });
    const info = this.renderer!.info();
    this.hud.update(v, {
      localTeams: s.localTeams, charge, chargeLabel, chargeTicks, powerAt, ringAt, conn: s.conn(), extraPower,
      guide: this.settings.controlHints !== false && (this.settings.highContrast || !this.touchMode) ? guideLine(this.actions.lastDevice === 'keyboard' && this.mouseMode ? 'mouse' : this.actions.lastDevice, this.gamepad.style, attacking, this.settings.controls) : '',
      fps: this.settings.showFps ? this.fpsReadout(now) : null,
      debug: this.debugOverlay ? `fps ${this.fps.toFixed(0)}  frame ${this.frameMs.toFixed(1)} ms  res ${Math.round(this.renderer!.resolutionScale * 100)}%  draw calls ${info.calls}  tris ${info.tris}\n${s.debugText()}` : null,
    });
    this.tv.update(v);
    // Crowd intensity follows danger.
    const danger = Math.max(0, 1 - Math.min(Math.abs(v.ball.pos.x - 52.5), Math.abs(v.ball.pos.x + 52.5)) / 30);
    this.audio.setCrowdIntensity(0.28 + danger * 0.35);
    // Phase transitions → overlays.
    if (v.phase !== this.lastPhase) {
      if (v.phase === 'halftime') this.atBreak(v, 'half', (w) => this.openHalftime(w));
      if (v.phase === 'fulltime') this.atBreak(v, 'match', (w) => this.openResults(w));
      if (this.lastPhase === 'halftime' && this.overlay === 'halftime') this.closeOverlay();
      this.lastPhase = v.phase;
    }
    if (this.overlay === 'halftime' && s instanceof OnlineSession) {
      const el = this.ui.querySelector('.ht-count');
      if (el) el.textContent = `Play restarts automatically (${Math.max(0, Math.ceil(MATCH.halftimePauseOnline - v.phaseT))} s)`;
    }
  }

  /** Goals, the woodwork, saves and near misses are kept for the half-time and full-time highlights (offline matches). */
  private noteMoments(s: Session, v: ViewState, evs: MatchEvent[]) {
    if (!(s instanceof OfflineSession) || s.cfg.practice || v.shootout) return;
    const name = (id: number | undefined) => (id !== undefined && id >= 0 ? v.players[id]?.def.short ?? '' : '');
    const minute = minuteText(v.clock, v.half);
    for (const e of evs) {
      const recent = performance.now() - this.lastShooter.at < 4000; // a shot in the last few seconds
      if (e.type === 'kick' && (e.text === 'shot' || e.text === 'volley' || (e.text === 'header' && Math.abs(e.x ?? v.ball.pos.x) > PITCH.halfLength - 20))) {
        this.lastShooter = { player: e.player ?? -1, team: e.team ?? 0, at: performance.now() };
      } else if (e.type === 'goal') {
        this.cine.moment({ kind: 'goal', team: e.team ?? 0, who: name(e.player) + (e.text === 'og' ? ' (og)' : ''), minute, half: v.half });
      } else if (e.type === 'post' || e.type === 'bar') {
        this.cine.moment({ kind: 'woodwork', team: recent ? this.lastShooter.team : e.team ?? 0, who: recent ? name(this.lastShooter.player) : '', minute, half: v.half });
      } else if (e.type === 'save') {
        this.cine.moment({ kind: 'save', team: e.team ?? 0, who: name(e.player), minute, half: v.half });
      } else if (e.type === 'chance' && recent) {
        this.cine.moment({ kind: 'chance', team: this.lastShooter.team, who: name(this.lastShooter.player), minute, half: v.half });
      }
    }
  }

  /**
   * Half-time or full time: the highlights first (if on and there are any), then the panel.
   * Winning a cup final or the league: the trophy ceremony before them.
   */
  private atBreak(v: ViewState, scope: 'half' | 'match', open: (v: ViewState) => void) {
    const s = this.session;
    this.cine.flushMoments();
    const reel = (w: ViewState) => {
      if (s instanceof OfflineSession && !s.cfg.practice && this.settings.highlights && !this.cineOff && this.overlay === 'none' && !this.cine.active) {
        if (this.cine.startHighlights(this.cine.book.reel(scope, w.half))) { this.afterReel = open; return; }
      }
      open(w);
    };
    const won = scope === 'match' && !this.cineOff ? this.trophyCaption(v) : null;
    if (won && this.renderer && this.overlay === 'none' && !this.cine.active && this.cine.startTrophy(v, this.renderer, 0, won)) { this.afterReel = reel; return; }
    // Half-time: blimp and drone shots over the ground first.
    if (scope === 'half' && s instanceof OfflineSession && !s.cfg.practice && this.settings.aerials !== false && !this.cineOff && this.overlay === 'none' && this.renderer) {
      const e = (x: string) => esc(x);
      const cap = `<b>${e(v.teams[0].name)}</b><span>${v.score[0]} – ${v.score[1]}</span><b>${e(v.teams[1].name)}</b><small>Half-time · ${e(groundFor(teamById(s.cfg.teams[0])).name)}</small>`;
      if (this.cine.startAerial(this.renderer, cap)) { this.afterReel = reel; return; }
    }
    reel(v);
  }

  /** The ceremony's caption if this result wins the competition for the player's club, else null. */
  private trophyCaption(v: ViewState): string | null {
    const s = this.session;
    const c = this.comp;
    if (!(s instanceof OfflineSession) || !this.compMatch || !c || c.champion || opponentOf(c) !== s.cfg.teams[1]) return null;
    const so = v.shootout;
    const pens: [number, number] | undefined = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : undefined;
    const after = recordResult(c, v.score[0], v.score[1], pens, v.half > 2);
    if (after.champion !== after.club) return null;
    return `<b>Champions</b><span>🏆</span><b>${esc(teamById(c.club).name)}</b><small>${c.kind === 'cup' ? 'Cup winners' : 'League champions'} · ${esc(groundFor(teamById(s.cfg.teams[0])).name)}</small>`;
  }

  /** "Highlights" on the half-time and full-time panels: watch them (again), then come back to the panel. */
  private highlightsButton(v: ViewState, scope: 'half' | 'match') {
    if (!(this.session instanceof OfflineSession) || this.session.cfg.practice || !this.cine.book.reel(scope, v.half).length) return '';
    return `<button class="btn" data-a="highlights">Highlights</button>`;
  }

  private bindHighlights(v: ViewState, scope: 'half' | 'match', back: (v: ViewState) => void) {
    this.on('[data-a=highlights]', () => {
      this.overlay = 'none';
      this.ui.innerHTML = '';
      if (this.cine.startHighlights(this.cine.book.reel(scope, v.half))) this.afterReel = back;
      else back(v);
    });
  }

  /** The last shot struck (for commentary on how good it was). */
  private lastShotCall = { t: -99, great: false };

  /** Rumble the controller if it is in use and rumble is on. */
  private buzz(strong: number, weak: number, ms: number) {
    if (this.settings.rumble && this.gamepad.index >= 0) this.gamepad.rumble(strong, weak, ms);
  }

  /** Camera shake for goals, the woodwork, saves and thunderous shots; slow motion (offline) for goals and the woodwork. */
  private bigMoments(s: Session, evs: MatchEvent[]) {
    if (this.settings.graphics.bigMoments === false || this.settings.camera.reducedMotion) return;
    const offline = s instanceof OfflineSession && !this.cine.active;
    for (const e of evs) {
      if (e.type === 'goal') { this.renderer?.shake(0.75); if (offline) this.slowMo.start(SLOW_MO.goal); }
      else if (e.type === 'post' || e.type === 'bar') { this.renderer?.shake(0.5); if (offline) this.slowMo.start(SLOW_MO.woodwork); }
      else if (e.type === 'save') this.renderer?.shake(0.28);
      else if (e.type === 'kick' && (e.text === 'shot' || e.text === 'volley') && (e.power ?? 0) > 27) this.renderer?.shake(0.2);
    }
  }

  /** Rumble for what happens to your side: your shots, tackles and fouls, goals, and the woodwork. */
  private rumbleFor(v: ViewState, e: MatchEvent) {
    const mine = (this.session?.localTeams ?? [0]).includes(e.team ?? -1);
    const ctl = (this.session?.localTeams ?? [0]).map((t) => v.ctl[t]);
    const me = e.player !== undefined && ctl.includes(e.player);
    switch (e.type) {
      case 'kick': if (me && (e.text === 'shot' || e.text === 'volley')) this.buzz(0.35 + Math.min(0.5, (e.power ?? 15) / 60), 0.5, 140); break;
      case 'tackle': if (me) this.buzz(0.55, 0.3, 160); else if (!mine) this.buzz(0.4, 0.15, 140); break;
      case 'foul': this.buzz(0.7, 0.35, 220); break;
      case 'post': case 'bar': this.buzz(0.8, 0.8, 260); break;
      case 'goal': if (mine) this.buzz(1, 1, 700); else this.buzz(0.6, 0.15, 350); break;
      case 'card': if (mine) this.buzz(0.4, 0.4, 200); break;
      default: break;
    }
  }

  private playEvents(v: ViewState, evs: MatchEvent[]) {
    const now = performance.now() / 1000;
    for (const e of evs) this.rumbleFor(v, e);
    // A great effort: hit hard, or from distance. Only those get "What an amazing shot".
    const greatShot = () => this.lastShotCall.great && now - this.lastShotCall.t < 4;
    for (const e of evs) {
      switch (e.type) {
        case 'kick':
          this.audio.kick(e.power ?? 10, e.x ?? 0, e.text);
          if (e.text === 'shot' || e.text === 'volley') {
            this.audio.anticipate();
            this.lastShotCall = { t: now, great: (e.power ?? 0) >= 24 || PITCH.halfLength - Math.abs(e.x ?? 0) >= 22 };
          }
          break;
        case 'post': case 'bar': this.audio.post(e.x ?? 0); this.audio.react('ooh'); if (greatShot() || Math.random() < 0.5) this.audio.call('shot', 0.6); break;
        case 'whistle':
          this.audio.whistle(e.text && e.text in WHISTLES ? (e.text as WhistleKind) : (e.power ?? 1));
          if (e.text === 'halftime' || e.text === 'fulltime' || (e.text === 'kickoff' && v.clock < 1 && v.half === 1)) this.audio.react('applause');
          break;
        case 'goal':
          this.audio.net(e.x ?? 0); this.audio.react('goal');
          if (e.text !== 'og') this.audio.call('goal', 0.5);
          if (Math.random() < 0.5) this.audio.stomp(0.75, 4.5); // the stands keep it going
          break;
        case 'save': this.audio.react('gasp'); if (greatShot()) this.audio.call('shot', 0.45); break;
        case 'chance': this.audio.react('ooh'); break;
        case 'tackle': this.audio.tackle(e.x ?? 0, false); break;
        case 'foul': this.audio.tackle(e.x ?? 0, true); if (Math.random() < 0.45) this.audio.react('boo'); break;
        case 'card': this.audio.react('boo'); break;
        case 'bounce': if ((e.power ?? 0) > 5) this.audio.kick((e.power ?? 0) * 0.5, e.x ?? 0, 'touch'); break;
        default: break;
      }
    }
    void v;
  }

  // ------------------------------------------------------------- screens

  private set(html: string, cls = '') {
    this.ui.innerHTML = `<div class="screen ${cls}">${html}</div>`;
    const first = this.ui.querySelector<HTMLElement>('[autofocus]') ?? this.ui.querySelector<HTMLElement>('.btn.primary, .btn');
    if (first && !this.touchMode) first.focus({ preventScroll: true });
  }

  private on(sel: string, fn: (el: HTMLElement) => void) {
    this.ui.querySelectorAll<HTMLElement>(sel).forEach((el) => el.addEventListener('click', () => fn(el)));
  }

  // ------------------------------------------------------------- local multiplayer

  /** 'P1', 'P1 + P3' or 'Computer' for one side. */
  private sideLabel(seats: Seat[], team: 0 | 1) {
    const ps = seats.filter((st) => st.team === team).map((st) => `P${st.player}`);
    return ps.length ? ps.join(' + ') : 'Computer';
  }

  /** Devices that can play: every connected controller, the keyboard (whole or split) and the touch screen. */
  private sidesDevices(): LocalDevice[] {
    const keyboard = !this.touchDevice || this.local.keyHeard || this.local.split;
    return listDevices(this.gamepad.connectedIndices(), keyboard, this.local.split, this.touchDevice);
  }

  /**
   * Choose sides: each controller (or keyboard half) moves its own token to Home, to Away, or leaves
   * it in the middle. Two on one side play together against the other side (or the computer).
   */
  private showSides() {
    this.screenName = 'sides';
    const L = this.local;
    const devs = this.sidesDevices();
    if (!Object.keys(L.picks).length && devs.length) L.picks = defaultPicks(devs);
    for (const d of devs) if (!(d.id in L.picks)) L.picks[d.id] = 0;
    L.sig = devs.map((d) => d.id).join(',');
    const seats = seatsFor(devs, L.picks);
    const kind = localKind(seats);
    const num = new Map(seats.map((st) => [st.device.id, st.player]));
    const row = (d: LocalDevice) => {
      const p = L.picks[d.id] ?? 0;
      const n = num.get(d.id);
      const tok = `<div class="side-tok ${n ? `p${n}` : ''}"><b>${n ? `P${n}` : '–'}</b><span>${esc(d.name)}</span></div>`;
      return `<div class="side-row" data-dev="${d.id}">
        <div class="side-cell">${p < 0 ? tok : ''}</div>
        <button class="btn small side-mv" data-mv="-1" data-dev="${d.id}" aria-label="${esc(d.name)} to home" ${p < 0 ? 'disabled' : ''}>◀</button>
        <div class="side-cell mid">${p === 0 ? tok : ''}</div>
        <button class="btn small side-mv" data-mv="1" data-dev="${d.id}" aria-label="${esc(d.name)} to away" ${p > 0 ? 'disabled' : ''}>▶</button>
        <div class="side-cell">${p > 0 ? tok : ''}</div>
      </div>`;
    };
    const summary = kind === 'versus' ? `${this.sideLabel(seats, 0)} v ${this.sideLabel(seats, 1)}`
      : kind === 'coop' ? `${seats.map((st) => `P${st.player}`).join(' and ')} together v the computer`
      : kind === 'single' ? `P1 v the computer (move another controller to a side to add a player)` : 'Move at least one player to a side.';
    const keysOn = devs.some((d) => d.kind === 'keys' || d.kind === 'keysL');
    const layout = (side: 'left' | 'right') => {
      const k = SPLIT_KEYS[side];
      const name = (a: BindAction) => (k[a] ?? []).map((c) => keyLabel(c)).join('/');
      return `<b>${side === 'left' ? 'Left (WASD)' : 'Right (arrows)'}</b>: move ${side === 'left' ? 'W A S D' : 'arrow keys'} · sprint ${name('sprint')} · pass ${name('pass')} · shoot ${name('shoot')} · lob ${name('lob')} · through ${name('through')} · switch ${name('switch')} · modifier ${name('jockey')} · skill ${name('skill')}`;
    };
    this.set(`<div class="panel">
      <h2>Local multiplayer: choose sides</h2>
      <div class="side-head"><span>HOME</span><span></span><span>Not playing</span><span></span><span>AWAY</span></div>
      <div class="side-rows">${devs.length ? devs.map(row).join('') : '<p class="note">No controllers yet. Press a button on each controller so the browser can see it.</p>'}</div>
      <p class="side-sum">${esc(summary)}</p>
      <p class="note">Controllers: push the stick or D-pad left or right to pick a side, A to carry on, B to go back. On an iPad, press a button on each controller to make it appear. ${keysOn ? 'Keyboard: A/D or the arrow keys move it, Enter carries on.' : ''} Two players on the same side play together (P1 and P3 against the computer, or 2 v 1, or 2 v 2).</p>
      ${!this.touchDevice || L.keyHeard || L.split ? `<div class="field"><span class="lbl">Keyboard</span>${this.seg('ksplit', [['one', 'One player'], ['split', 'Two players (split)']], L.split ? 'split' : 'one')}</div>` : ''}
      ${L.split ? `<p class="note keys-layout">${layout('left')}<br>${layout('right')}<br>Esc pauses.</p>` : ''}
      <div class="row end" style="margin-top:14px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="next" ${seats.length ? '' : 'disabled'}>Next: clubs</button></div>
    </div>`, 'scroll');
    this.on('[data-mv]', (el) => this.moveSide(el.dataset.dev!, Number(el.dataset.mv) as -1 | 1));
    this.bindSeg('ksplit', (v) => {
      L.split = v === 'split';
      // The keyboard's place carries over to its left half (and back).
      if (L.split && 'keys' in L.picks) { L.picks.keysL = L.picks.keys; delete L.picks.keys; }
      if (!L.split && 'keysL' in L.picks) { L.picks.keys = L.picks.keysL; delete L.picks.keysL; delete L.picks.keysR; }
      this.showSides();
    });
    this.on('[data-a=back]', () => this.showMode());
    this.on('[data-a=next]', () => this.sidesContinue());
  }

  private moveSide(id: string, step: -1 | 1) {
    const before = this.local.picks[id] ?? 0;
    this.local.picks = moveToken(this.local.picks, id, step);
    this.audio.ui(this.local.picks[id] !== before ? 'move' : 'back');
    this.showSides();
  }

  private sidesContinue() {
    const seats = seatsFor(this.sidesDevices(), this.local.picks);
    if (!seats.length) return;
    this.local.seats = seats;
    this.audio.ui('select');
    // The pad press that carried on is still held: the next screen waits for it to be let go.
    this.padNav.prevA = true;
    this.padNav.prevB = true;
    this.showTeams();
  }

  /** Choose sides: every controller's stick moves its own token (polled each frame; a new controller redraws the screen). */
  private pollSides() {
    const L = this.local;
    const devs = this.sidesDevices();
    if (devs.map((d) => d.id).join(',') !== L.sig) { this.showSides(); return; }
    for (const d of devs) {
      if (d.kind !== 'pad') continue;
      const m = this.gamepad.readMenuAt(d.pad!);
      // Buttons start as held, so the press that opened this screen doesn't also carry on.
      const prev = L.prev[d.id] ?? { x: 0, a: true, b: true };
      const x = m.sx > 0.5 ? 1 : m.sx < -0.5 ? -1 : 0;
      L.prev[d.id] = { x, a: m.a || m.start, b: m.b };
      if (x && x !== prev.x) this.moveSide(d.id, x as -1 | 1);
      else if ((m.a || m.start) && !prev.a) this.sidesContinue();
      else if (m.b && !prev.b) { this.padNav.prevB = true; this.padNav.prevA = true; this.showMode(); }
      if (this.screenName !== 'sides') return;
    }
  }

  private localKey(e: KeyboardEvent) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const L = this.local;
    if (this.screenName === 'sides') {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (!L.keyHeard && this.touchDevice) { L.keyHeard = true; this.showSides(); }
      const mv = (id: string, step: -1 | 1) => { e.preventDefault(); this.moveSide(id, step); };
      if (L.split) {
        if (e.code === 'KeyA') mv('keysL', -1);
        else if (e.code === 'KeyD') mv('keysL', 1);
        else if (e.code === 'ArrowLeft') mv('keysR', -1);
        else if (e.code === 'ArrowRight') mv('keysR', 1);
      } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') mv('keys', -1);
      else if (e.code === 'KeyD' || e.code === 'ArrowRight') mv('keys', 1);
      if (e.code === 'Enter') { e.preventDefault(); this.sidesContinue(); }
      if (e.code === 'Escape') { e.preventDefault(); this.showMode(); }
      return;
    }
    // A local match with nobody on the whole keyboard (whose bindings include Esc): Esc still pauses.
    const seats = this.localPlaying;
    if (seats && this.screenName === 'match' && e.code === 'Escape' && this.overlay === 'none' && !seats.some((st) => st.device.kind === 'keys')) {
      e.preventDefault();
      this.togglePause();
    }
  }

  /** An offline session; in a local multiplayer match each seat gets its own input layer. */
  private makeOffline(cfg: MatchConfig): OfflineSession {
    this.resetLocalInput();
    const seats = cfg.practice || cfg.challenge || this.compMatch || this.tutorialMatch ? null : this.local.seats;
    if (!seats || !seats.length || !seats.every((st) => cfg.humans[st.team]) || (cfg.humans[0] && !seats.some((st) => st.team === 0)) || (cfg.humans[1] && !seats.some((st) => st.team === 1))) {
      return new OfflineSession(cfg, this.actions, 0 as TeamIndex);
    }
    this.localPlaying = seats;
    const first = seats[0];
    this.actions.sources = [this.sourceFor(first.device)];
    const extra = seats.slice(1).map((seat) => {
      const layer = new ActionLayer([this.sourceFor(seat.device)]);
      layer.receiverMode = this.settings.receiver;
      layer.passAssist = this.settings.passAssist ?? 'assisted';
      layer.shotAssist = this.settings.shotAssist ?? 'assisted';
      layer.stickSwitch = this.settings.stickSwitch ?? 'player';
      layer.chargeScale = CHARGE_SCALE[this.settings.chargeSpeed ?? 'normal'] ?? 1;
      layer.sprintToggle = !!this.settings.sprintToggle;
      layer.onPause = () => this.togglePause();
      this.extraLayers.push({ seat, layer });
      return { team: seat.team as TeamIndex, slot: seat.slot, layer };
    });
    return new OfflineSession(cfg, this.actions, first.team as TeamIndex, extra);
  }

  private sourceFor(d: LocalDevice): InputSource {
    if (d.kind === 'pad') {
      const g = new GamepadSource();
      g.pin = d.pad!;
      g.bindings = this.settings.controls;
      return g;
    }
    if (d.kind === 'keysL') return this.keysL;
    if (d.kind === 'keysR') return this.keysR;
    if (d.kind === 'touch') return this.touchModel;
    return this.keySource;
  }

  /** Back to one player: P1's input reads every device again. */
  private resetLocalInput() {
    this.actions.sources = [this.keySource, this.gamepad, this.touchModel];
    this.extraLayers = [];
    this.localPlaying = null;
  }

  /** Marker style (P number - 1) for each human, indexed team * 2 + slot; undefined outside local multiplayer. */
  private slotStyles(): number[] | undefined {
    const seats = this.localPlaying;
    if (!seats) return undefined;
    const out = [-1, -1, -1, -1];
    for (const st of seats) out[st.team * 2 + st.slot] = st.player - 1;
    return out;
  }

  /** The setup Kick off plays: the last one used, with the clubs checked (a made club may have been deleted). */
  private quickChoice(): MatchChoice {
    const c = this.choice;
    const clubs = playableClubs();
    if (!clubs.some((t) => t.id === c.club)) c.club = TEAMS[0].id;
    if (!clubs.some((t) => t.id === c.opp) || c.opp === c.club) c.opp = clubs.find((t) => t.id !== c.club)!.id;
    return c;
  }

  /** One-press match against the computer with the last setup. */
  private quickMatch() {
    this.local.seats = null;
    this.quickChoice();
    this.startOffline();
  }

  /**
   * The first screen and main menu: Kick off plays the last setup in one press, Continue plays the
   * next cup or league match, and everything else (other modes, clubs, match settings) is one
   * press further in. "More modes" stays open once opened.
   */
  private showMode() {
    this.screenName = 'mode';
    this.modes.syncSlot();
    const p = this.profile;
    const fresh = !p.tutorialDone && p.stats.played === 0;
    const got = Object.keys(p.achievements).length;
    const c = this.quickChoice();
    const me = teamById(c.club), them = teamById(c.opp);
    const oppKit = this.matchKits(c.club, c.opp, c.kit, c.oppKit).opp;
    const diff = ({ casual: 'Casual', pro: 'Pro', elite: 'Elite', adaptive: 'Adaptive' } as Record<string, string>)[c.difficulty] ?? c.difficulty;
    const draw = { stand: 'Draw stands', extra: 'Extra time + pens', pens: 'Penalties if level' }[c.draw];
    const comp = this.comp;
    const compOpp = comp && !comp.champion && !comp.out && myFixture(comp) ? opponentOf(comp) : null;
    const open = this.menuOpen.modes;
    this.set(`
      <h1 class="logo home-logo">ELEV<span>E</span>NS</h1>
      <p class="tagline home-tag">Broadcast football · eleven a side</p>
      ${fresh ? `<div class="first-run"><b>New to ELEVENS?</b><span>The guided first match teaches the controls one at a time.</span><button class="btn small" data-a="tutorial">Guided first match</button></div>` : ''}
      <div class="quick-card">
        <span class="lbl">Quick match · vs computer</span>
        <div class="qm-teams"><span class="qm-team">${clubBadge(me, 30)}<b>${esc(me.name)}</b>${this.kitSwatch(c.club, c.kit)}</span><i>v</i><span class="qm-team away">${this.swatchOf(oppKit)}<b>${esc(them.name)}</b>${clubBadge(them, 30)}</span></div>
        <p class="qm-meta">${esc(diff)} · ${c.minutes} min · ${draw}</p>
        <div class="qm-buttons">
          <button class="btn primary big" data-a="quick" autofocus data-padstart>Kick off</button>
          <button class="btn" data-a="offline">Change clubs or settings</button>
        </div>
      </div>
      ${comp && compOpp ? `<button class="btn big comp-go" data-a="compnext">Continue ${comp.kind}<small>${esc(roundName(comp))} v ${esc(teamById(compOpp).name)}</small></button>` : ''}
      <div class="home-more">
        <button class="btn more-toggle" data-a="more" aria-expanded="${open}">${open ? 'Fewer modes' : 'More modes'}<span class="chev">${open ? '▴' : '▾'}</span></button>
        ${open ? `<div class="more-modes">
          <button class="btn" data-a="local">Local multiplayer</button>
          <button class="btn" data-a="comp">Cup and league</button>
          <button class="btn" data-a="practice">Practice and tutorial</button>
          <button class="btn" data-a="online">Online match</button>
          <button class="btn" data-a="clubs">Profile and clubs</button>
          ${this.modes.menuButtons()}
        </div>` : ''}
      </div>
      <div class="row center home-row"><button class="btn" data-a="controls">Controls</button><button class="btn" data-a="settings">Settings</button><button class="profile-chip" data-a="profile" title="Profile and save slots"><b>${esc(p.name)}</b><span>${p.stats.played} played · ${p.trophies.length} ${p.trophies.length === 1 ? 'trophy' : 'trophies'} · ${got}/${ACHIEVEMENTS.length} achievements</span></button></div>`, 'home');
    this.on('[data-a=quick]', () => this.quickMatch());
    this.modes.bindMenu();
    this.on('[data-a=compnext]', () => {
      const cc = this.comp, opp = cc ? opponentOf(cc) : null;
      if (!cc || !opp) return;
      this.startOffline(undefined, undefined, { club: cc.club, opp, draw: cc.kind === 'cup' ? 'extra' : 'stand' });
    });
    this.on('[data-a=more]', () => {
      this.menuOpen.modes = !this.menuOpen.modes;
      saveMenuOpen(this.menuOpen);
      this.showMode();
      if (!this.touchMode) this.ui.querySelector<HTMLElement>('[data-a=more]')?.focus({ preventScroll: true });
    });
    this.on('[data-a=offline]', () => { this.local.seats = null; this.showTeams(); });
    this.on('[data-a=local]', () => { this.local.prev = {}; this.showSides(); });
    this.on('[data-a=comp]', () => this.showCompetition());
    this.on('[data-a=practice]', () => this.showPractice());
    this.on('[data-a=tutorial]', () => this.startTutorial());
    this.on('[data-a=profile]', () => { this.profileTab = 'slots'; this.showProfile(); });
    this.on('[data-a=clubs]', () => { this.profileTab = 'career'; this.showProfile(); });
    this.on('[data-a=online]', () => this.showOnline());
    this.on('[data-a=controls]', () => this.showControls(() => this.showMode()));
    this.on('[data-a=settings]', () => this.showSettings(() => this.showMode()));
  }

  // ------------------------------------------------------------- cup and league

  private showCompetition() {
    if (this.comp) this.showCompHub();
    else this.showCompSetup();
  }

  /** New cup or league: the format and size, your club (any club, or one you made), difficulty and match length. */
  private showCompSetup() {
    this.screenName = 'compsetup';
    const cs = this.compSetup, c = this.choice;
    if (!playableClubs().some((t) => t.id === cs.club)) cs.club = TEAMS[0].id;
    const size = cs.kind === 'cup' ? cs.cupSize : cs.leagueSize;
    const card = (id: string) => {
      const t = teamById(id);
      return `<button class="club mini ${cs.club === id ? 'on' : ''}" data-club="${id}"><span class="abbr">${clubBadge(t, 30)} ${t.abbr} ${this.kitSwatch(id, 'home')} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(t.name)}</span><span class="style">${esc(t.style)}</span><span class="pstyle">${PLAY_STYLE_NAMES[styleForClub(t)]}</span></button>`;
    };
    this.set(`<div class="panel">
      <h2>Cup and league</h2>
      <div class="field"><span class="lbl">Competition</span>${this.seg('ckind', [['cup', 'Cup'], ['league', 'League']], cs.kind)}</div>
      <div class="field"><span class="lbl">Clubs</span>${cs.kind === 'cup' ? this.seg('csize', CUP_SIZES.map((n) => [String(n), String(n)]), String(cs.cupSize)) : this.seg('lsize', LEAGUE_SIZES.map((n) => [String(n), String(n)]), String(cs.leagueSize))}
        <span class="note">${cs.kind === 'cup' ? `${size} clubs, knockout: ${size === 16 ? 'round of 16, ' : ''}quarter-finals, semi-finals and the final. A draw goes to extra time and penalties.` : `${size} clubs, ${size - 1} rounds: play everyone once. Three points for a win, one for a draw.`} The other clubs are drawn at random from the ${ALL_CLUBS.length} in the game.</span></div>
      <h3>Your club</h3>
      <div class="grid4">${playableClubs().map((t) => card(t.id)).join('')}</div>
      <p class="note">Make your own club under Profile and clubs.</p>
      <div class="field"><span class="lbl">Computer difficulty</span>${this.seg('diff', [['casual', 'Casual'], ['pro', 'Pro'], ['elite', 'Elite'], ['adaptive', 'Adaptive']], c.difficulty)}</div>
      <div class="field"><span class="lbl">Match length (real minutes)</span>${this.seg('min', MATCH.allowedRealMinutes.map((m) => [String(m), `${m}`]), String(c.minutes))}</div>
      <div class="row end" style="margin-top:16px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="start">Start the ${cs.kind}</button></div>
    </div>`, 'scroll');
    this.bindSeg('ckind', (v) => { cs.kind = v as CompKind; this.showCompSetup(); });
    this.bindSeg('csize', (v) => { cs.cupSize = Number(v); this.showCompSetup(); });
    this.bindSeg('lsize', (v) => { cs.leagueSize = Number(v); this.showCompSetup(); });
    this.on('[data-club]', (el) => { cs.club = el.dataset.club!; this.showCompSetup(); });
    this.bindSeg('diff', (v) => { c.difficulty = v as Difficulty; this.showCompSetup(); });
    this.bindSeg('min', (v) => { c.minutes = Number(v); this.showCompSetup(); });
    this.on('[data-a=back]', () => this.showMode());
    this.on('[data-a=start]', () => {
      this.comp = newCompetition(cs.kind, cs.club, (Math.random() * 2 ** 31) | 0, cs.kind === 'cup' ? cs.cupSize : cs.leagueSize);
      this.showCompHub();
    });
  }

  /** The competition so far: your next match, then the bracket (cup) or the table (league). */
  private showCompHub() {
    const c = this.comp;
    if (!c) { this.showCompSetup(); return; }
    this.screenName = 'comphub';
    const me = teamById(c.club);
    const f = myFixture(c);
    const opp = opponentOf(c);
    const name = (id: string) => `<span class="${id === c.club ? 'me' : ''}">${clubBadge(teamById(id), 18)} ${esc(teamById(id).name)}</span>`;
    const fixtureRow = (x: Fixture) => `<div class="fx${x.home === c.club || x.away === c.club ? ' mine' : ''}">${name(x.home)}<b>${esc(scoreText(x))}</b>${name(x.away)}</div>`;
    let body = '';
    if (c.kind === 'cup') {
      body = `<div class="bracket${cupRounds(c).length > 3 ? ' wide' : ''}">${cupRounds(c).map((rn, i) => `<div class="bround"><h4>${rn}</h4>${(c.rounds[i] ?? []).map(fixtureRow).join('') || '<p class="note">To be decided</p>'}</div>`).join('')}</div>`;
    } else {
      const rows = leagueTable(c);
      body = `<table class="ltable"><tr><th></th><th>Club</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>${rows.map((r, i) => `<tr class="${r.id === c.club ? 'me' : ''}"><td>${i + 1}</td><td>${clubBadge(teamById(r.id), 18)} ${esc(teamById(r.id).name)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gd > 0 ? '+' : ''}${r.gd}</td><td><b>${r.pts}</b></td></tr>`).join('')}</table>
        ${c.round > 0 ? `<h4>${esc(roundName(c, c.round - 1))} results</h4>${c.rounds[c.round - 1].map(fixtureRow).join('')}` : ''}
        ${f ? `<h4>${esc(roundName(c))} fixtures</h4>${c.rounds[c.round].map(fixtureRow).join('')}` : ''}`;
    }
    const head = c.champion
      ? `<div class="comp-banner ${c.champion === c.club ? 'win' : ''}">${c.champion === c.club ? `🏆 ${esc(me.name)} win the ${c.kind}!` : `${esc(teamById(c.champion).name)} win the ${c.kind}.`}${c.kind === 'league' ? ` You finished ${ordinal(leagueTable(c).findIndex((r) => r.id === c.club) + 1)}.` : ''}</div>`
      : c.out ? `<div class="comp-banner">${esc(me.name)} are out of the cup.</div>`
      : f && opp ? `<div class="comp-next"><span class="lbl">${esc(roundName(c))}</span><div class="final small">${this.kitSwatch(c.club, 'home')} ${esc(me.name)} v ${esc(teamById(opp).name)} ${this.kitSwatch(opp, 'home')}</div></div>` : '';
    this.set(`<div class="panel">
      <h2>${clubBadge(me, 34)} ${c.kind === 'cup' ? 'The Elevens Cup' : 'The Elevens League'}</h2>
      ${head}
      ${body}
      <div class="row end" style="margin-top:16px">
        <button class="btn" data-a="back">Main menu</button>
        <button class="btn danger" data-a="new">${this.compConfirm ? 'Sure? Press again' : c.champion || c.out ? 'New competition' : 'Abandon'}</button>
        ${f ? '<button class="btn primary" data-a="play" autofocus>Play match</button>' : ''}
      </div>
    </div>`, 'scroll');
    this.on('[data-a=back]', () => { this.compConfirm = false; this.showMode(); });
    this.on('[data-a=new]', () => {
      if (!this.compConfirm && !c.champion && !c.out) { this.compConfirm = true; this.showCompHub(); return; }
      this.compConfirm = false;
      this.comp = null;
      this.compSetup.club = c.club;
      this.compSetup.kind = c.kind;
      this.showCompSetup();
    });
    this.on('[data-a=play]', () => {
      if (!opp) return;
      this.compConfirm = false;
      this.startOffline(undefined, undefined, { club: c.club, opp, draw: c.kind === 'cup' ? 'extra' : 'stand' });
    });
  }

  /** Practice: no clock, with your club against the computer. Free play, or a set piece on repeat. */
  private showPractice() {
    this.screenName = 'practice';
    this.set(`<div class="panel narrow"><h2>Practice and tutorial</h2>
      <p class="note">No clock and no full time. Use the pause menu to restart or quit.</p>
      <div class="stack" style="margin-top:12px">
        <button class="btn primary big" data-a="p-tutorial">Guided first match${this.profile.tutorialDone ? ' ✓' : ''}</button>
        <p class="note">A coach takes you through the controls one at a time against an easy side: moving, sprinting, switching, tackling, passing, through balls, lobs, skills, shooting and scoring.</p>
        <button class="btn big" data-a="p-free">Free play</button>
        <p class="note">Open play against the computer: try skill moves, called runs, barges and passing.</p>
        <button class="btn big" data-a="p-freekick">Free kicks</button>
        <p class="note">A free kick in shooting range, from a new spot each time. Time the ring for accuracy.</p>
        <button class="btn big" data-a="p-penalty">Penalties</button>
        <p class="note">Penalty after penalty against the keeper.</p>
        <button class="btn big" data-a="p-crosses">Crossing and finishing</button>
        <p class="note">A winger crosses for your striker against two defenders: head it (pass or shoot as it arrives high) or volley it (shoot as it drops to waist height).</p>
      </div>
      <h3 style="margin-top:16px">Challenges</h3>
      <p class="note">Ten attempts, then your score. Best scores are kept on this device.</p>
      <div class="stack">
        ${(['freekick', 'penalty', 'crosses'] as const).map((d) => `<button class="btn" data-ch="${d}">${{ freekick: 'Free-kick challenge', penalty: 'Penalty challenge', crosses: 'Finishing challenge' }[d]}${this.bestScore(d) !== null ? ` · best ${this.bestScore(d)}/10` : ''}</button>`).join('')}
        <button class="btn" data-a="p-control">Ball control drill${this.bestScore('control') !== null ? ` · best ${this.bestScore('control')} pts` : ''}</button>
        <p class="note">60 seconds with a coach: dribble through the gates (quicker and closer for more points), pass to him and control what he plays back, on the ground and in the air. Keepy-ups count too. Losing the ball costs 30.</p>
      </div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="back">Back</button></div></div>`, 'scroll');
    this.on('[data-a=p-tutorial]', () => this.startTutorial());
    this.on('[data-a=p-free]', () => this.startOffline('free'));
    this.on('[data-a=p-freekick]', () => this.startOffline('freekick'));
    this.on('[data-a=p-penalty]', () => this.startOffline('penalty'));
    this.on('[data-a=p-crosses]', () => this.startOffline('crosses'));
    this.on('[data-a=p-control]', () => this.startOffline('control', 60));
    this.ui.querySelectorAll<HTMLElement>('[data-ch]').forEach((b) => b.addEventListener('click', () => this.startOffline(b.dataset.ch as 'freekick', 10)));
    this.on('[data-a=back]', () => this.showMode());
  }

  private kitSwatch(club: string, kit: 'home' | 'away') {
    const k = teamById(club)[kit];
    return `<span class="kit"><i style="background:${hex(k.shirt)}"></i><i style="background:${hex(k.shorts)}"></i><i style="background:${hex(k.socks)}"></i></span>`;
  }

  private clubCard(id: string, on: boolean, extra = '') {
    const t = teamById(id);
    const roster = t.players.map((p) => `<span><b>${p.number}</b>${esc(p.short)} <small>${p.role}</small></span><br>`).join('');
    return `<button class="club ${on ? 'on' : ''}" data-club="${t.id}">
      <span class="abbr">${t.abbr}</span><span class="name">${esc(t.name)}</span>
      <span>${this.kitSwatch(t.id, 'home')} Home ${this.kitSwatch(t.id, 'away')} Away</span>
      <span class="style">${esc(t.style)}</span><span class="pstyle" title="${PLAY_STYLE_NOTES[styleForClub(t)]}">Plays: ${PLAY_STYLE_NAMES[styleForClub(t)]}</span>${extra}<span class="roster">${roster}</span></button>`;
  }

  /** Play vs computer: your club and the opponent, from every club in the game (and your own). */
  private showTeams() {
    this.screenName = 'teams';
    const c = this.quickChoice();
    const clubs = playableClubs();
    saveChoice(c);
    const mini = (t: TeamDef, on: boolean, attr: string) => `<button class="club mini ${on ? 'on' : ''}" ${attr}="${t.id}"><span class="abbr">${clubBadge(t, 28)} ${t.abbr} ${this.kitSwatch(t.id, 'home')} <small class="ovr">${teamRatings(t).ovr}</small></span><span class="name">${esc(t.name)}</span><span class="pstyle" title="${PLAY_STYLE_NOTES[styleForClub(t)]}">${PLAY_STYLE_NAMES[styleForClub(t)]}</span></button>`;
    const me = teamById(c.club), them = teamById(c.opp);
    const kits = this.matchKits(c.club, c.opp, c.kit, c.oppKit);
    const seats = this.local.seats;
    const who = (t: 0 | 1) => seats ? this.sideLabel(seats, t) : t === 0 ? 'You' : 'Computer';
    this.set(`<div class="panel">
      <h2>Choose the clubs</h2>
      <div class="vs-line">${this.clubSummary(me, who(0))}<b>v</b>${this.clubSummary(them, who(1))}</div>
      <h3>${seats ? `Home club · ${who(0)}` : 'Your club'}</h3>
      <div class="grid4 clubs-pick">${clubs.map((t) => mini(t, t.id === c.club, 'data-club')).join('')}</div>
      <h3>${seats ? `Away club · ${who(1)}` : 'Opponent'}</h3>
      <div class="grid4 clubs-pick">${clubs.filter((t) => t.id !== c.club).map((t) => mini(t, t.id === c.opp, 'data-opp')).join('')}</div>
      <div class="row between" style="margin-top:16px">
        <div class="row"><span class="lbl">${seats ? 'Home kit' : 'Your kit'}</span><div class="seg" data-seg="kit">${['home', 'away'].map((k) => `<button data-v="${k}" class="${c.kit === k ? 'on' : ''}">${k}</button>`).join('')}</div></div>
        <div class="row"><span class="lbl">${seats ? 'Away kit' : 'Opponent kit'}</span><div class="seg" data-seg="oppKit">${['home', 'away'].map((k) => `<button data-v="${k}" class="${c.oppKit === k ? 'on' : ''}">${k}</button>`).join('')}</div></div>
      </div>
      <p class="note kit-note">${esc(me.name)} ${this.kitSwatch(c.club, c.kit)} v ${this.swatchOf(kits.opp)} ${esc(them.name)}${kits.which === 'change' ? ' (change kit, so the two sides stand apart)' : kits.which !== c.oppKit ? ` (${kits.which} kit, so the two sides stand apart)` : ''}</p>
      <div class="row end sticky-actions"><button class="btn" data-a="back">Back</button><button class="btn" data-a="next">Match settings</button><button class="btn primary" data-a="kick">Kick off</button></div>
    </div>`, 'scroll');
    this.on('[data-club]', (el) => { c.club = el.dataset.club!; if (c.opp === c.club) c.opp = clubs.find((t) => t.id !== c.club)!.id; this.showTeams(); });
    this.on('[data-opp]', (el) => { c.opp = el.dataset.opp!; this.showTeams(); });
    this.bindSeg('kit', (v) => { c.kit = v as 'home' | 'away'; this.showTeams(); });
    this.bindSeg('oppKit', (v) => { c.oppKit = v as 'home' | 'away'; this.showTeams(); });
    this.on('[data-a=back]', () => (seats ? this.showSides() : this.showMode()));
    this.on('[data-a=next]', () => this.showMatchSettings());
    this.on('[data-a=kick]', () => this.startOffline());
  }

  /** A club in a line: crest, name, ratings and style. */
  private clubSummary(t: TeamDef, who: string) {
    const r = teamRatings(t);
    return `<div class="club-sum">${clubBadge(t, 48)}<div><span class="badge ${who !== 'Computer' ? 'ok' : ''}">${who}</span><span class="name">${esc(t.name)}</span><span class="note">ATT ${r.att} · MID ${r.mid} · DEF ${r.def} · ${esc(t.style)}</span>${who === 'Computer' ? `<span class="note pstyle">Plays ${PLAY_STYLE_NAMES[styleForClub(t)].toLowerCase()}: ${PLAY_STYLE_NOTES[styleForClub(t)]}</span>` : ''}</div></div>`;
  }

  private swatchOf(k: Kit) {
    return `<span class="kit"><i style="background:${hex(k.shirt)}"></i><i style="background:${hex(k.shorts)}"></i><i style="background:${hex(k.socks)}"></i></span>`;
  }

  /** Kits for a match: yours as chosen, theirs changed if it would clash (for the colour-vision setting too). */
  private matchKits(club: string, opp: string, kit: 'home' | 'away', oppKit: 'home' | 'away') {
    const mode: ColourVision = this.settings.colourVision ?? 'off';
    const r = pickOppKit(teamById(club)[kit], teamById(opp), oppKit, mode);
    return { opp: r.kit, which: r.which };
  }

  private bindSeg(name: string, fn: (v: string) => void) {
    this.ui.querySelectorAll<HTMLElement>(`[data-seg=${name}] button`).forEach((b) => b.addEventListener('click', () => fn(b.dataset.v!)));
  }

  /** Team instructions: formation plus width, defensive line and pressing sliders (-2..+2). */
  private tacticsHtml(t: Tactics) {
    const slider = (id: keyof Tactics, label: string, lo: string, hi: string) =>
      `<div class="tslider"><span class="lbl">${label}</span><span class="end">${lo}</span><input type="range" data-t="${id}" min="-2" max="2" step="1" value="${t[id]}"><span class="end">${hi}</span></div>`;
    return `<div class="field"><span class="lbl">Formation</span>${this.seg('form', FORMATIONS.map((f) => [f, FORMATION_NAMES[f]]), t.formation)}</div>
      ${slider('width', 'Width', 'Narrow', 'Wide')}${slider('line', 'Defensive line', 'Deep', 'High')}${slider('press', 'Pressing', 'Stand off', 'Press high')}
      <div class="field"><span class="lbl">Defending corners and wide free kicks</span>${this.seg('mark', [['mixed', 'Mixed'], ['man', 'Man-marking'], ['zonal', 'Zonal']], t.marking ?? 'mixed')}</div>`;
  }

  private bindTactics(t: Tactics, changed: (t: Tactics) => void, redraw: () => void) {
    this.bindSeg('form', (v) => { t.formation = v as Formation; changed(t); redraw(); });
    this.bindSeg('mark', (v) => { if (v === 'man' || v === 'zonal') t.marking = v; else delete t.marking; changed(t); redraw(); });
    this.ui.querySelectorAll<HTMLInputElement>('input[data-t]').forEach((r) => r.addEventListener('input', () => {
      (t as unknown as Record<string, number>)[r.dataset.t!] = Number(r.value);
      changed(t);
    }));
  }

  private seg(name: string, values: [string, string][], cur: string) {
    return `<div class="seg" data-seg="${name}">${values.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }

  /**
   * Match settings: difficulty, length and the draw rule up front; tactics, formation, sliders,
   * marking, auto-switch and quick restarts under "More options" (stays open once opened).
   */
  private showMatchSettings() {
    this.screenName = 'matchsettings';
    const c = this.choice;
    saveChoice(c);
    const open = this.menuOpen.options;
    const t = this.settings.tactics;
    const summary = `${({ defensive: 'Defensive', balanced: 'Balanced', attacking: 'Attacking' } as Record<string, string>)[c.mentality] ?? c.mentality} · ${FORMATION_NAMES[t.formation] ?? t.formation} · auto-switch ${this.settings.autoSwitch ? 'on' : 'off'} · quick restarts ${this.settings.quickRestarts ? 'on' : 'off'}`;
    this.set(`<div class="panel narrow">
      <h2>Match settings</h2>
      <div class="stack">
        <div class="field"><span class="lbl">${this.local.seats && localKind(this.local.seats) === 'versus' ? 'Help level (both players: Casual helps passing and shooting most)' : 'Computer difficulty'}</span>${this.seg('diff', [['casual', 'Casual'], ['pro', 'Pro'], ['elite', 'Elite'], ['adaptive', 'Adaptive']], c.difficulty)}
          ${c.difficulty === 'adaptive' ? `<span class="note">Starts at ${adaptiveName(this.settings.adaptiveLevel)} and moves between Pro and World class with how you are playing, during the match and from one match to the next.</span>` : ''}</div>
        <div class="field"><span class="lbl">Match length (real minutes)</span>${this.seg('min', MATCH.allowedRealMinutes.map((m) => [String(m), `${m}`]), String(c.minutes))}
          <span class="note">${c.minutes} real minutes = 90 football minutes (clock runs ${(5400 / (c.minutes * 60)).toFixed(1)}× real time).</span></div>
        <div class="field"><span class="lbl">If it is a draw</span>${this.seg('draw', [['stand', 'Draw stands'], ['extra', 'Extra time + pens'], ['pens', 'Penalties']], c.draw)}</div>
        <button class="btn more-toggle" data-a="moreopts" aria-expanded="${open}">${open ? 'Fewer options' : 'More options'}<span class="chev">${open ? '▴' : '▾'}</span></button>
        ${open ? `<div class="stack more-opts">
        <div class="field"><span class="lbl">Your tactics</span>${this.seg('ment', [['defensive', 'Defensive'], ['balanced', 'Balanced'], ['attacking', 'Attacking']], c.mentality)}</div>
        ${this.tacticsHtml(t)}
        <div class="field"><span class="lbl">Auto-switch when defending</span>${this.seg('auto', [['on', 'On'], ['off', 'Off']], this.settings.autoSwitch ? 'on' : 'off')}</div>
        <div class="field"><span class="lbl">Quick restarts</span>${this.seg('quick', [['on', 'On'], ['off', 'Off']], this.settings.quickRestarts ? 'on' : 'off')}
          <span class="note">Take throw-ins, corners and free kicks the moment your taker reaches the ball, before the other side is set.</span></div>
        </div>` : `<p class="note more-sum">${esc(summary)}</p>`}
      </div>
      <div class="row end" style="margin-top:18px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="go">Kick off</button></div>
    </div>`, open ? 'scroll' : '');
    this.bindSeg('diff', (v) => { c.difficulty = v as Difficulty; this.showMatchSettings(); });
    this.bindSeg('ment', (v) => { c.mentality = v as Mentality; this.showMatchSettings(); });
    this.bindTactics(this.settings.tactics, () => saveSettings(this.settings), () => this.showMatchSettings());
    this.bindSeg('min', (v) => { c.minutes = Number(v); this.showMatchSettings(); });
    this.bindSeg('draw', (v) => { c.draw = v as 'stand' | 'extra' | 'pens'; this.showMatchSettings(); });
    this.bindSeg('auto', (v) => { this.settings.autoSwitch = v === 'on'; saveSettings(this.settings); this.showMatchSettings(); });
    this.bindSeg('quick', (v) => { this.settings.quickRestarts = v === 'on'; saveSettings(this.settings); this.showMatchSettings(); });
    this.on('[data-a=moreopts]', () => {
      this.menuOpen.options = !this.menuOpen.options;
      saveMenuOpen(this.menuOpen);
      this.showMatchSettings();
      if (!this.touchMode) this.ui.querySelector<HTMLElement>('[data-a=moreopts]')?.focus({ preventScroll: true });
    });
    this.on('[data-a=back]', () => this.showTeams());
    this.on('[data-a=go]', () => this.startOffline());
  }

  private ensureRenderer(): GameRenderer {
    if (!this.renderer) {
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      this.renderer = new GameRenderer(canvas, this.settings.graphics);
      // No graphics acceleration (often work laptops): the browser draws in software at about a frame
      // a second, so start from the lightest settings once (Settings can raise them again).
      if (this.slowGuardOn && !this.settings.softwareLow && isSoftwareRenderer(glStatus.renderer)) {
        softwareGraphics(this.settings as unknown as SlowSettings);
        this.settings.softwareLow = true;
        saveSettings(this.settings);
        this.renderer.applyGraphics(this.settings.graphics);
        console.warn(`[graphics] software drawing (${glStatus.renderer}): quality Low, 50% resolution, live menu stadium and intro off`);
        setTimeout(() => this.hud.toast('This browser has no graphics acceleration, so the game is set to its lightest graphics. Turning on hardware acceleration in the browser settings makes it run far better.', 7000), 1500);
      }
      // The match intro's floodlights clunking on, bank by bank.
      this.renderer.onFloodlight = (pan) => this.audio.floodlight(pan);
      // Click or tap on the pitch: switch to the teammate nearest that point.
      canvas.addEventListener('pointerdown', (e) => { if (this.overlay === 'photo') this.photoDrag = { x: e.clientX, y: e.clientY }; });
      window.addEventListener('pointermove', (e) => {
        if (this.overlay !== 'photo' || !this.photoDrag) return;
        this.photo.drag(e.clientX - this.photoDrag.x, e.clientY - this.photoDrag.y);
        this.photoDrag = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener('pointerup', () => { this.photoDrag = null; });
      window.addEventListener('keydown', (e) => { if (this.overlay === 'photo') this.photoKey(e, true); });
      window.addEventListener('keyup', (e) => { if (this.overlay === 'photo') this.photoKey(e, false); });
      canvas.addEventListener('pointerdown', (e) => {
        if (!this.session || this.screenName !== 'match' || this.overlay !== 'none' || e.button !== 0) return;
        // With mouse control the left button passes (switching is on its own button).
        if (this.mouseMode && e.pointerType === 'mouse') return;
        const pt = this.renderer?.groundPoint(e.clientX, e.clientY);
        if (pt) this.actions.switchAt(pt.x, pt.z);
      });
    }
    return this.renderer;
  }

  /**
   * Loading screen. With `info` it is the match card (clubs, steps, progress and tips): `step`
   * 0 players, 1 stadium, 2 warm-up; a later step keeps the card already showing.
   */
  private loading(text: string, then: () => void, info?: LoadingInfo, step = 1) {
    const keep = this.screenName === 'loading' && !!this.loadScreen && !!this.ui.querySelector('.loading-card');
    this.screenName = 'loading';
    if (!keep) {
      this.loadScreen?.stop();
      this.loadScreen = null;
      if (info) {
        this.set(loadingHtml(info, ''), 'loading-screen');
        this.loadScreen = new LoadingScreen(this.ui.querySelector<HTMLElement>('.loading-card')!, this.tipsNow());
      } else this.set(`<div class="spinner"></div><p class="note" style="margin-top:16px">${esc(text)}</p><div class="progress"><i style="width:60%"></i></div>`);
    }
    this.loadScreen?.setStep(step);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { then(); } catch (err) {
        console.error(err);
        this.set(`<div class="panel narrow"><h2>Could not start</h2><p class="err">${esc(String((err as Error).message ?? err))}</p><p class="note">Your browser may not support WebGL2. Try another browser or lower graphics settings.</p><button class="btn" data-a="menu">Main menu</button></div>`);
        this.on('[data-a=menu]', () => this.showMode());
      }
    }));
  }

  /** Tips for the loading screen, for the controls in use. */
  private tipsNow() {
    const dev = this.gamepad.index >= 0 ? 'gamepad' : this.touchMode ? 'touch' : 'keyboard';
    return loadingTips(dev, this.gamepad.style, dev === 'keyboard' && this.mouseMode ? mouseAsKeys(this.settings.controls) : this.settings.controls);
  }

  /** The loading card's clubs and what kind of match it is. */
  private loadInfo(teams: [string, string], kits: ['home' | 'away', 'home' | 'away'], detail: string): LoadingInfo {
    const side = (i: 0 | 1) => {
      const t = teamById(teams[i]);
      const c = t[kits[i]].shirt;
      const lum = 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
      return { name: t.name, abbr: t.abbr, colour: hex(c), ink: lum > 150 ? '#0b0f14' : '#ffffff' };
    };
    return { home: side(0), away: side(1), detail, venue: groundFor(teamById(teams[0])).name };
  }

  /** The live stadium behind the menus (Settings > Graphics > Menu background). */
  private startBackdrop(teams?: [string, string], kits?: ['home' | 'away', 'home' | 'away']) {
    if (this.backdropOff || this.settings.menuBackdrop === false || this.session || this.backdrop.active) return;
    if (this.screenName === 'loading' || this.screenName === 'match') return;
    try {
      const r = this.ensureRenderer();
      // Phones, tablets and Low quality draw the menus at 30 fps.
      this.backdrop.halfRate = this.touchDevice || this.settings.graphics.preset === 'low';
      this.backdrop.start(r, teams, kits);
    } catch (err) {
      console.warn('menu background unavailable', err);
      this.backdrop.stop(this.renderer);
    }
  }

  /**
   * Last loading step: compile the match's shaders while the loading card shows (so the first
   * seconds of the match don't stutter), keep the card up long enough to read a tip, then dip
   * to black into the match.
   */
  private enterMatch(begin: () => void, view?: ViewState | null) {
    const r = this.renderer;
    this.loadScreen?.setStep(2);
    // One frame of the new stadium from the TV gantry (behind the card, and it warms up the GPU).
    if (r && view && document.body.classList.contains('menu-still')) {
      try {
        r.cine = { pos: { x: 0, y: 30, z: 66 }, look: { x: 0, y: 0, z: 0 }, fov: 34 };
        r.render(view, 1 / 60, this.settings.camera, { localTeams: [], receiver: -1, showNext: false, playerRing: false, highContrast: false });
      } catch (err) { console.warn(err); }
      r.cine = null;
    }
    const min = this.animOff ? 0 : 1600;
    const started = this.loadScreen?.started ?? performance.now();
    const compile = r ? Promise.race([r.renderer.compileAsync(r.scene, r.camera.cam).catch(() => {}), new Promise((ok) => setTimeout(ok, 4000))]) : Promise.resolve();
    void compile.then(() => {
      const wait = Math.max(0, min - (performance.now() - started));
      setTimeout(() => {
        if (this.screenName !== 'loading') return;
        this.loadScreen?.done();
        this.loadScreen?.stop();
        this.loadScreen = null;
        this.transitions.dip(begin);
      }, wait);
    });
  }

  private startOffline(practice?: MatchConfig['practice'], challenge?: number, comp?: { club: string; opp: string; draw: 'stand' | 'extra' }, mode?: ModeMatch) {
    const tutorial = this.tutorialMatch && practice === 'free';
    const c = mode ? { ...this.choice, club: mode.club, draw: mode.draw, minutes: mode.minutes, difficulty: mode.difficulty } : comp ? { ...this.choice, club: comp.club, draw: comp.draw } : this.choice;
    if (!practice && !tutorial && !mode) saveChoice(this.choice);
    // Career and Be a Pro squads stand in for the clubs' own while the match is on.
    this.modeMatch = mode ?? null;
    if (mode) { if (mode.overrides.length) setSquadOverrides(mode.overrides); else clearSquadOverrides(); this.modes.started(mode); }
    const opp = mode ? mode.opp : comp ? comp.opp : c.opp && c.opp !== c.club && playableClubs().some((t) => t.id === c.opp) ? c.opp : playableClubs().find((t) => t.id !== c.club)!.id;
    this.compMatch = !!comp;
    // Your club is always team 0 offline; the computer side changes kit if the two would clash
    // (judged for the colour-vision setting too), into a plain change kit if neither of theirs stands out.
    const kitPick = this.matchKits(c.club, opp, c.kit, c.oppKit);
    const oppKit: 'home' | 'away' = kitPick.which === 'change' ? c.oppKit : kitPick.which;
    const oppDef: TeamDef = kitPick.which === 'change' ? { ...teamById(opp), [oppKit]: kitPick.opp } : teamById(opp);
    const cfg = defaultConfig({
      teams: [c.club, opp], kits: [c.kit, oppKit], realMinutes: c.minutes, humans: [true, false], difficulty: ['pro', tutorial ? 'casual' : c.difficulty], adaptiveStart: this.settings.adaptiveLevel,
      tactics: [{ ...this.settings.tactics }, { ...defaultTactics(), formation: practice ? '433' : FORMATIONS[(Math.random() * FORMATIONS.length) | 0] }],
      draw: practice ? 'stand' : c.draw,
      mentality: [c.mentality, 'balanced'], autoSwitch: [this.settings.autoSwitch, false], quickRestarts: [this.settings.quickRestarts, true], seed: (Math.random() * 2 ** 31) | 0, practice, challenge,
      momentum: this.settings.momentum !== false,
      weather: this.matchWeather(!!practice),
    });
    // Injuries (and stretchers) in offline matches against the computer; the modes add their own settings.
    if (!practice && !comp && !this.local.seats?.length) cfg.injuries = true;
    if (comp) cfg.injuries = true;
    if (mode) Object.assign(cfg, mode.patch);
    // Local multiplayer: humans (and a co-op second human) wherever players sat on the Choose sides screen.
    const seats = !practice && !comp && !tutorial ? this.local.seats : null;
    if (seats && seats.length) {
      const has = (t: number) => seats.some((st) => st.team === t);
      cfg.humans = [has(0), has(1)];
      cfg.mates = [seats.filter((st) => st.team === 0).length > 1, seats.filter((st) => st.team === 1).length > 1];
      cfg.autoSwitch = [has(0) && this.settings.autoSwitch, has(1) && this.settings.autoSwitch];
      cfg.quickRestarts = [has(0) ? this.settings.quickRestarts : true, has(1) ? this.settings.quickRestarts : true];
      // Help for a human's kicks comes from the other side's level: both sides at the chosen level.
      cfg.difficulty = [c.difficulty, c.difficulty];
    }
    // The realistic players (several MB) must be in before kick-off, or the tunnel walk-out shows
    // the simple stand-in figures: wait for them here (they start downloading on the title screen).
    const diffName = ({ casual: 'Casual', pro: 'Pro', elite: 'Elite', adaptive: 'Adaptive' } as Record<string, string>)[c.difficulty] ?? c.difficulty;
    const detail = seats && seats.length ? `Local · ${this.sideLabel(seats, 0)} v ${this.sideLabel(seats, 1)} · ${c.minutes} min` : practice ? `Practice · ${({ free: 'Free play', freekick: 'Free kicks', penalty: 'Penalties', crosses: 'Crossing and finishing', control: 'Ball control drill' } as Record<string, string>)[practice] ?? 'Practice'}${challenge && practice !== 'control' ? ' challenge' : ''}`
      : `${comp ? (this.comp?.kind === 'league' ? 'League · ' : 'Cup · ') : ''}${diffName} · ${c.minutes} min`;
    const detailText = mode ? mode.detail : detail;
    const info = this.loadInfo(cfg.teams as [string, string], cfg.kits, detailText);
    if (realisticPlayers(this.settings.graphics) && !this.playersReady && !this.playersFailedOnce) {
      this.loading('Bringing the players out…', () => {}, info, 0);
      const t0 = performance.now();
      void Promise.race([loadPlayerAssets(), new Promise((r) => setTimeout(() => r('slow'), 25000))]).then((got) => {
        // Loaded, or still coming after 25 s (they swap in when they arrive): don't wait again. Failed
        // (a dropped connection): play this one with the simple players and try again next kick-off.
        this.playersReady = !!got;
        this.playersFailedOnce = !got;
        if (this.screenName === 'loading') { console.info(`players ${got ? 'loaded' : 'failed'} in ${Math.round(performance.now() - t0)} ms`); this.startOffline(practice, challenge, comp, mode); }
      }).catch((err) => {
        console.warn('[players] waiting for the realistic players failed:', err);
        this.playersFailedOnce = true;
        if (this.screenName === 'loading') this.startOffline(practice, challenge, comp, mode);
      });
      return;
    }
    this.playersFailedOnce = false;
    this.loading(`Building ${groundInSentence(groundFor(teamById(cfg.teams[0])).name)}…`, () => {
      this.backdrop.stop(this.renderer, true);
      const r = this.ensureRenderer();
      r.setupMatch([teamById(cfg.teams[0]), oppDef], cfg.kits, cfg.weather);
      this.lastTeams = { teams: [cfg.teams[0], cfg.teams[1]], kits: [cfg.kits[0], cfg.kits[1]] };
      this.kitOverride = oppDef !== teamById(opp) ? oppDef : null;
      const s = this.makeOffline(cfg);
      this.enterMatch(() => this.beginSession(s), s.view());
    }, info, 1);
  }

  /**
   * This match's weather: the Weather setting (Random rolls one), and wind unless Settings turn it
   * off. Test pages stay clear and still unless they ask (&weather=rain, &wind=6). Practice is still.
   */
  private matchWeather(practice: boolean): MatchWeather {
    const params = new URLSearchParams(location.search);
    const forced = params.get('weather');
    const set = this.settings.graphics.weather ?? 'random';
    const kind: WeatherKind = forced === 'rain' || forced === 'snow' || forced === 'clear' ? forced : set !== 'random' ? set : params.has('test') ? 'clear' : rollWeatherKind(Math.random());
    const fw = params.get('wind');
    if (fw !== null) return { kind, wind: Math.max(0, Math.min(10, Number(fw) || 0)), windDir: Number(params.get('winddir') ?? 0) || 0 };
    if (practice || params.has('test') || this.settings.wind === false) return { kind, wind: 0, windDir: 0 };
    return { kind, ...rollWind(kind, Math.random(), Math.random()) };
  }

  private beginSession(s: Session) {
    this.session?.dispose();
    // A change kit is only for looks: the score bug, radar and line-ups read it from the match's club (also on restarts and rematches).
    if (s instanceof OfflineSession && this.kitOverride && s.cfg.teams[1] === this.kitOverride.id) s.match.teams[1] = this.kitOverride;
    this.track = { restart: '', restartKick: '', lastKick: { text: '', x: 0, z: 0, player: -1, team: -1, from: '' }, goals: [] };
    this.resultsNote = null;
    this.coach?.dispose();
    this.coach = null;
    if (this.tutorialMatch && s instanceof OfflineSession && s.cfg.practice === 'free') {
      this.coach = new Coach(document.getElementById('hud')!);
      this.coach.onFinish = () => {
        this.profile.tutorialDone = true;
        this.announce(unlock(this.profile, ['tutorial']));
        this.saveProfile();
        setTimeout(() => { if (this.coach && this.overlay === 'none' && this.session === s) this.openTutorialDone(); }, 2200);
      };
    }
    this.backdrop.stop(this.renderer);
    this.backdrop.release();
    this.loadScreen?.stop();
    this.loadScreen = null;
    this.announcer.stop();
    this.session = s;
    this.lastPhase = '';
    this.overlay = 'none';
    this.screenName = 'match';
    this.ui.innerHTML = '';
    this.hud.show(true);
    this.touch.show(this.touchMode);
    this.actions.clear();
    this.hud.setPractice(s instanceof OfflineSession ? s.cfg.practice : null, s instanceof OfflineSession ? s.cfg.challenge ?? 0 : 0);
    if (!(s instanceof OfflineSession)) s.setTactics({ ...this.settings.tactics });
    const v = s.view();
    if (v) this.renderer!.snapCamera(v);
    this.audio.unlock();
    this.audio.setMusic(false);
    this.checkOrientation();
    this.cine.reset();
    this.slowMo.stop();
    this.tv.reset();
    this.lastCine = 'none';
    this.afterReel = null;
    this.resultsNote = null;
    this.lastShooter = { player: -1, team: 0, at: -1e9 };
    this.audio.setRain(this.renderer?.weather === 'rain' ? 1 : 0);
    this.welcomed = false;
    this.commentator.reset();
    this.commentator.mode = s instanceof OfflineSession && s.cfg.practice ? 'off' : this.settings.commentator ?? 'captions';
    this.commentator.volume = this.settings.audio.muted ? 0 : this.settings.audio.master;
    this.savedGoals.clear();
    if (s instanceof OfflineSession && !s.cfg.practice && this.settings.matchIntro && !this.cineOff && this.renderer && !(this.modeMatch && !this.modeMatch.intro)) {
      this.cine.startIntro(this.renderer.tunnel(), introCaption(teamById(s.cfg.teams[0]).name, teamById(s.cfg.teams[1]).name, groundFor(teamById(s.cfg.teams[0])).name), this.settings.ceremony !== false);
      this.announceWelcome(s);
    } else this.startLineups();
  }

  /** What Settings says about the announcer's voice. */
  /** Whether the recorded crowd and match sounds loaded (Settings > Audio), so a quiet or odd-sounding match can be reported. */
  private soundStatus(): string {
    const a = this.audio;
    if (!a.ctx) return 'Crowd and match sounds: they load after your first tap or key press.';
    const st = a.sampleStatus;
    if (!a.loaded) return `Crowd and match sounds: loading (${st.loaded} of ${st.total})…`;
    if (!st.failed) return `Crowd and match sounds: all ${st.total} loaded.`;
    return `Crowd and match sounds: ${st.failed} of ${st.total} could not load (${esc(st.error)}).`;
  }

  private voiceStatus(): string {
    const a = this.announcer;
    if (!a.available) return 'This browser has no speech, so the stadium announcer stays quiet.';
    if (a.problem) return `${a.problem} Check the device volume and that the iPad isn't on silent, then press Test voice.`;
    if (a.works) return `Working (${a.voiceName}).`;
    return `Uses this device's own voice (${a.voiceName}). Press Test voice to hear it; on iPad, tap the screen at least once before a match.`;
  }

  /** The announcer's volume: the master level (speech can't go through the game's mixer). */
  private syncAnnouncer() {
    const a = this.settings.audio;
    this.announcer.enabled = a.announcer === true && (!this.cineOff || new URLSearchParams(location.search).has('lineups'));
    this.announcer.volume = a.muted ? 0 : a.master;
  }

  private welcomed = false;
  /** "Good evening, and welcome to…" as the camera flies in (offline matches). */
  private announceWelcome(s: OfflineSession) {
    this.syncAnnouncer();
    if (this.welcomed || s.cfg.practice) return;
    this.welcomed = true;
    const t = this.settings.graphics.matchTime ?? 'dusk';
    void this.announcer.say(welcomeLines(teamById(s.cfg.teams[0]).name, teamById(s.cfg.teams[1]).name, groundInSentence(groundFor(teamById(s.cfg.teams[0])).name), t));
  }

  /**
   * The announcer reads the line-ups while the TV line-ups show (offline): the visitors, then
   * the home side name by name with a cheer for each. The line-ups stay up until the last
   * name (any button still kicks off at once).
   */
  private announceLineups(s: OfflineSession, v: ViewState) {
    this.syncAnnouncer();
    if (!this.announcer.enabled || !this.announcer.available || this.announcer.volume <= 0.01) return;
    // No intro: the welcome comes first, in the same reading (a new reading stops the last).
    const welcome: string[] = [];
    if (!this.welcomed) {
      this.welcomed = true;
      welcome.push(...welcomeLines(teamById(s.cfg.teams[0]).name, teamById(s.cfg.teams[1]).name, groundInSentence(groundFor(teamById(s.cfg.teams[0])).name), this.settings.graphics.matchTime ?? 'dusk'));
    }
    const team = (t: 0 | 1): AnnounceTeam => {
      const def = v.teams[t];
      const ps = v.players.filter((p) => p.team === t && !p.off);
      const cap = def.players[captainIndex(def)]?.name;
      return { name: def.name, captain: cap, players: ps.map((p) => ({ number: p.def.number, name: p.def.name, role: p.role })) };
    };
    const lines: [string, boolean][] = [...welcome.map((w): [string, boolean] => [w, false]), ...lineupLines(team(0), team(1))];
    // Roughly how long the reading takes (about 2.6 words a second, plus pauses), as a cap.
    const words = lines.reduce((n, [l]) => n + l.split(/\s+/).length, 0);
    this.tv.setLineupsLength(Math.min(60, 4 + words / 2.4 + lines.length * 0.35));
    void this.announcer.say(lines).then(() => {
      setTimeout(() => { if (this.session === s && this.tv.holding) this.tv.skip(); }, 1200);
    });
  }

  /** TV line-ups before kick-off (after the intro, if it plays). Offline they hold the match until skipped. */
  private startLineups() {
    const s = this.session;
    const v = s?.view();
    // Test pages skip them unless they ask (&lineups or &cine).
    if (!s || !v || !this.settings.tvGraphics || (this.cineOff && !new URLSearchParams(location.search).has('lineups')) || v.phase !== 'kickoff' || v.clock > 0) return;
    if (s instanceof OfflineSession && s.cfg.practice) return;
    const hold = s instanceof OfflineSession;
    const weather = this.renderer ? WEATHER_NAMES[this.renderer.weather] : '';
    this.tv.showLineups(v, {
      hold, venue: groundFor(v.teams[0]).name, weather: (weather === 'Clear' ? (this.settings.graphics.matchTime === 'night' ? 'Clear night' : 'Clear skies') : weather) + (v.weather && v.weather.wind >= 1 ? ` · ${windText(v.weather.wind)}` : ''),
      done: () => {
        // Skipped (or finished): the announcer stops with the line-ups.
        if (this.session === s) this.announcer.stop();
        if (this.session === s && s instanceof OfflineSession) s.pause(this.overlay !== 'none' || this.cine.active);
      },
    });
    if (hold) (s as OfflineSession).pause(true);
    if (s instanceof OfflineSession) this.announceLineups(s, v);
  }

  private endSession() {
    this.session?.dispose();
    this.session = null;
    this.modeMatch = null;
    clearSquadOverrides();
    this.commentator.reset();
    this.coach?.dispose();
    this.coach = null;
    this.tutorialMatch = false;
    this.kitOverride = null;
    this.resetLocalInput();
    if (this.overlay === 'photo') this.closePhoto(false);
    this.announcer.stop();
    this.cine.reset();
    this.slowMo.stop();
    this.tv.reset();
    this.audio.setRain(0);
    this.audio.crowdOff();
    this.audio.setMusic(true);
    this.hud.show(false);
    this.touch.show(false);
    this.overlay = 'none';
    this.actions.clear();
    if (this.net) { this.net.close(); this.net = null; }
    this.room = null;
    this.onlineStart = null;
    // Back on the menus: the stadium carries on behind them with the same two clubs (no rebuild).
    const last = this.lastTeams;
    setTimeout(() => this.startBackdrop(last?.teams, last?.kits), 0);
  }

  /** "58 fps · 17 ms · slowest 24 ms · Medium 90%", refreshed twice a second so it can be read. */
  private fpsReadout(now: number): string {
    const w = this.fpsWin;
    if (now - w.at >= 500 && w.n > 0) {
      const avg = w.sum / w.n;
      const q = ({ low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' } as Record<string, string>)[this.settings.graphics.preset] ?? '';
      w.text = `${Math.round(1000 / avg)} fps · ${avg.toFixed(1)} ms · slowest ${Math.round(w.worst)} ms · ${q} ${Math.round((this.renderer?.resolutionScale ?? 1) * 100)}%`;
      w.n = 0; w.sum = 0; w.worst = 0; w.at = now;
    }
    return w.text || '…';
  }

  /** Shows or hides the on-screen controls when a controller connects or disconnects. */
  private applyTouchMode() {
    document.body.classList.toggle('touch', this.touchMode);
    this.touch.show(this.touchMode && !!this.session);
  }

  private checkOrientation() {
    const el = document.getElementById('rotate')!;
    el.hidden = !(this.touchDevice && this.screenName === 'match' && innerHeight > innerWidth);
  }

  // ------------------------------------------------------------- overlays

  private togglePause() {
    if (this.screenName !== 'match' || !this.session) return;
    if (this.overlay === 'replay') this.closeInstantReplay();
    else if (this.overlay === 'pause' || this.overlay === 'help' || this.overlay === 'settings') this.closeOverlay();
    else if (this.overlay === 'none') this.openPause();
  }

  /**
   * Instant replay from the pause menu: the last 20 seconds of play. A bar along the bottom
   * plays/pauses, jumps back or forward 5 seconds, changes the speed and the camera; Back (B or
   * Esc) returns to the pause menu.
   */
  private openInstantReplay() {
    if (!this.cine.startInstant()) return;
    this.overlay = 'replay';
    this.hud.show(false);
    this.touch.show(false);
    this.ui.innerHTML = `<div class="replay-bar">
      <div class="replay-info"><span class="replay-time"></span><span class="replay-track"><i></i></span><span class="replay-cam"></span></div>
      <div class="replay-btns">
        <button class="btn" data-a="rback">⏪ 5s</button>
        <button class="btn primary" data-a="rplay">Pause</button>
        <button class="btn" data-a="rfwd">5s ⏩</button>
        <button class="btn" data-a="rslow">Speed 1x</button>
        <button class="btn" data-a="rcam">Camera</button>
        <button class="btn" data-a="back">Back</button>
      </div></div>`;
    const play = this.ui.querySelector<HTMLElement>('[data-a=rplay]')!;
    const slow = this.ui.querySelector<HTMLElement>('[data-a=rslow]')!;
    const time = this.ui.querySelector<HTMLElement>('.replay-time')!;
    const bar = this.ui.querySelector<HTMLElement>('.replay-track i')!;
    const cam = this.ui.querySelector<HTMLElement>('.replay-cam')!;
    this.cine.onInstant = (st) => {
      const left = st.last - st.t;
      time.textContent = left < 0.05 ? 'LIVE' : `-${left.toFixed(1)}s`;
      bar.style.width = `${(100 * (st.t - st.first)) / Math.max(0.01, st.last - st.first)}%`;
      cam.textContent = st.cam;
      const p = st.playing ? 'Pause' : 'Play';
      if (play.textContent !== p) play.textContent = p;
      const sp = `Speed ${st.speed === 1 ? '1x' : st.speed === 0.5 ? '½x' : '¼x'}`;
      if (slow.textContent !== sp) slow.textContent = sp;
    };
    this.on('[data-a=rplay]', () => this.cine.instantControl('play'));
    this.on('[data-a=rback]', () => this.cine.instantControl('back'));
    this.on('[data-a=rfwd]', () => this.cine.instantControl('forward'));
    this.on('[data-a=rslow]', () => this.cine.instantControl('slow'));
    this.on('[data-a=rcam]', () => this.cine.instantControl('camera'));
    this.on('[data-a=back]', () => this.closeInstantReplay());
    if (!this.touchMode) play.focus({ preventScroll: true });
  }

  private closeInstantReplay() {
    this.cine.onInstant = () => {};
    this.cine.stopInstant();
    this.openPause();
  }

  private toggleHelp() {
    if (this.screenName !== 'match') return;
    if (this.overlay === 'help') this.closeOverlay();
    else if (this.overlay === 'none') this.showControls(() => this.closeOverlay(), true);
  }

  private closeOverlay() {
    this.overlay = 'none';
    this.ui.innerHTML = '';
    if (this.session instanceof OfflineSession) this.session.pause(this.cine.active || this.tv.holding);
    this.actions.clear();
  }

  private openPause() {
    const s = this.session;
    if (!s) return;
    this.overlay = 'pause';
    this.announcer.stop();
    const offline = s instanceof OfflineSession;
    if (offline) s.pause(true);
    const ment = offline ? s.match.cfg.mentality[0] : this.onlineStart?.mentality[this.onlineStart.side] ?? 'balanced';
    const pv = s.view();
    const myTeam = s.localTeams[0] ?? 0;
    const subsLeft = pv && !(offline && s.cfg.practice) && !pv.shootout ? 5 - pv.subs.filter((x) => x[0] === myTeam).length : 0;
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h2>${offline ? 'Paused' : 'Match menu'}</h2>
      ${offline ? '' : '<p class="note">Online matches cannot be paused by one player: the match continues while this menu is open.</p>'}
      <div class="stack">
        <button class="btn primary" data-a="resume">Resume</button>
        ${offline && this.cine.canInstant ? '<button class="btn" data-a="instant">Instant replay</button>' : ''}
        ${offline ? '<button class="btn" data-a="photo">Photo mode</button>' : ''}
        ${offline && s.cfg.difficulty[1] === 'adaptive' && !s.cfg.practice ? `<p class="note">Computer level (Adaptive): ${adaptiveName(s.match.adaptiveLevel)}</p>` : ''}
        <div class="field"><span class="lbl">Tactics</span>${this.seg('ment', [['defensive', 'Defensive'], ['balanced', 'Balanced'], ['attacking', 'Attacking']], ment)}</div>
        ${pv && !pv.shootout ? `<div class="field"><span class="lbl">Game plan</span>${this.seg('plan', GAME_PLANS.map((g) => [g, GAME_PLAN_NAMES[g]] as [string, string]), pv.plans[myTeam])}<p class="note">${PLAN_NOTES[pv.plans[myTeam]]} Change it in play with ${this.bindingName('plan')}.</p></div>` : ''}
        ${this.tacticsHtml(this.settings.tactics)}
        ${offline ? `<button class="btn" data-a="restart">${(s as OfflineSession).cfg.practice ? 'Restart practice' : 'Restart match'}</button>` : ''}
        ${subsLeft > 0 ? `<button class="btn" data-a="subs">Substitutions (${subsLeft} left)</button>` : ''}
        ${pv && !pv.shootout ? '<button class="btn" data-a="instr">Player instructions</button>' : ''}
        ${pv ? '<button class="btn" data-a="squads">Player stats</button>' : ''}
        <button class="btn" data-a="controls">Controls</button>
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn danger" data-a="quit">${offline ? 'Quit to menu' : 'Leave match'}</button>
      </div></div></div>`;
    this.on('[data-a=resume]', () => this.closeOverlay());
    this.on('[data-a=instant]', () => this.openInstantReplay());
    this.on('[data-a=photo]', () => this.openPhoto());
    this.bindSeg('ment', (v) => {
      s.setMentality(v as Mentality);
      if (this.onlineStart) this.onlineStart.mentality[this.onlineStart.side] = v as Mentality;
      this.openPause();
    });
    this.bindSeg('plan', (v) => { s.setPlan(v as GamePlan); setTimeout(() => this.overlay === 'pause' && this.openPause(), 50); });
    this.bindTactics(this.settings.tactics, (t) => { saveSettings(this.settings); s.setTactics({ ...t }); }, () => this.openPause());
    this.on('[data-a=squads]', () => this.showSquads());
    this.on('[data-a=instr]', () => this.showInstructions());
    this.on('[data-a=restart]', () => { const cfg = (s as OfflineSession).cfg; cfg.seed = (Math.random() * 2 ** 31) | 0; this.beginSession(this.makeOffline(cfg)); });
    this.on('[data-a=subs]', () => this.showSubs());
    this.on('[data-a=controls]', () => this.showControls(() => this.openPause(), true));
    this.on('[data-a=settings]', () => this.showSettings(() => this.openPause(), true));
    this.on('[data-a=quit]', () => { this.endSession(); this.showMode(); });
  }

  /** The button for an action on the device last used, for hints ("the plan button" when unbound). */
  private bindingName(a: BindAction): string {
    const pad = this.actions.lastDevice === 'gamepad';
    const l = pad ? padText(this.settings.controls, this.padStyleShown, a) : this.touchMode ? [] : keysText(this.mouseMode ? mouseAsKeys(this.settings.controls) : this.settings.controls, a);
    return l.length ? l[0] : a === 'plan' ? 'the Game plan button (set one in Controls)' : 'its button';
  }

  /** Player instructions: tell single teammates to stay back or get forward (kept for the match). */
  private showInstructions() {
    const s = this.session;
    const v = s?.view();
    if (!s || !v) return;
    const team = s.localTeams[0] ?? 0;
    const ins = s.instructions();
    const opts: [string, string][] = [['-1', 'Stay back'], ['0', 'Normal'], ['1', 'Get forward']];
    const ROLE_NAMES: Record<string, string> = { RB: 'Right back', RCB: 'Centre-back', LCB: 'Centre-back', LB: 'Left back', CDM: 'Holding mid', RCM: 'Midfield', LCM: 'Midfield', RW: 'Right wing', LW: 'Left wing', ST: 'Striker' };
    const rows = v.players.filter((p) => p.team === team && !p.off && p.role !== 'GK').map((p) => {
      const slot = p.id - team * 11;
      return `<div class="field instr"><span class="lbl">${p.def.number} ${esc(p.def.short)} <small>${ROLE_NAMES[p.role] ?? p.role}</small></span>${this.seg('in' + slot, opts, String(ins[slot] ?? 0))}</div>`;
    }).join('');
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h2>Player instructions</h2>
      <p class="note">Stay back: no forward runs or overlaps, sits deeper when you attack. Get forward: joins attacks, makes runs beyond the striker and stays up when you defend.</p>
      <div class="stack instr-list">${rows}</div>
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="reset">All normal</button><button class="btn primary" data-a="back">Back</button></div>
    </div></div>`;
    for (let slot = 0; slot < 11; slot++) this.bindSeg('in' + slot, (val) => { s.setInstruction(slot, Number(val)); this.showInstructions(); });
    this.on('[data-a=reset]', () => { for (let slot = 0; slot < 11; slot++) if ((ins[slot] ?? 0) !== 0) s.setInstruction(slot, 0); this.showInstructions(); });
    this.on('[data-a=back]', () => this.openPause());
  }

  /** Both line-ups with their ratings, so you can see who is quick, who can shoot and who is tiring. */
  private showSquads() {
    const s = this.session;
    const v = s?.view();
    if (!s || !v) return;
    const cls = (x: number) => x >= 80 ? 'r-top' : x >= 72 ? 'r-good' : x >= 64 ? 'r-mid' : 'r-low';
    const side = (t: 0 | 1) => {
      const tr = teamRatings(v.teams[t]);
      const rows = v.players.filter((p) => p.team === t && !p.off).map((p) => {
        const st = defStats(p.def, p.role);
        const cells = p.role === 'GK' ? [st.gk, st.pas, st.pac] : [st.pac, st.sho, st.pas, st.dri, st.def];
        return `<tr><td>${p.def.number}</td><td class="nm">${esc(p.def.short)}</td><td>${p.role}</td><td><b class="${cls(st.ovr)}">${st.ovr}</b></td>${cells.map((c, i) => `<td class="${cls(c)}">${p.role === 'GK' ? ['GK ', 'PAS ', 'PAC '][i] : ''}${c}</td>`).join('')}${p.role === 'GK' ? '<td></td><td></td>' : ''}<td><i class="stam"><i style="width:${Math.round(p.stamina * 100)}%;background:${p.stamina < 0.45 ? 'var(--warn)' : 'var(--accent)'}"></i></i></td></tr>`;
      }).join('');
      return `<div><h3>${esc(v.teams[t].name)} <small>OVR ${tr.ovr} · ATT ${tr.att} · MID ${tr.mid} · DEF ${tr.def}</small></h3>
        <table class="squad"><tr><th>#</th><th>Name</th><th>Pos</th><th>OVR</th><th>PAC</th><th>SHO</th><th>PAS</th><th>DRI</th><th>DEF</th><th>Energy</th></tr>${rows}</table></div>`;
    };
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel wide">
      <h2>Player stats</h2>
      <p class="note">Pace sets top speed and acceleration, shooting and passing set how accurate and how firm kicks are, dribbling is the first touch and close control, defending is tackling. Tired players play below these numbers.</p>
      <div class="squads">${side(0)}${side(1)}</div>
      ${this.partnershipsHtml(v)}
      <div class="row end" style="margin-top:12px"><button class="btn primary" data-a="back">Back</button></div>
    </div></div>`;
    this.on('[data-a=back]', () => this.openPause());
  }

  /** Partnerships on the player's side (offline): the pairs that have built an understanding this match. */
  private partnershipsHtml(v: ViewState): string {
    const s = this.session;
    if (!(s instanceof OfflineSession)) return '';
    const team = s.localTeams[0] ?? 0;
    const list = partnerships(s.match, team).filter((x) => x.passes >= 3).slice(0, 4);
    const nm = (id: number) => `#${v.players[id].def.number} ${esc(v.players[id].def.short)}`;
    const body = list.length
      ? list.map((x) => `<li>${nm(x.a)} &amp; ${nm(x.b)} <small>${x.level >= 1 ? 'great understanding' : x.level >= 0.4 ? 'linking up' : 'getting to know each other'}</small></li>`).join('')
      : '<li><small>None yet: teammates who keep passing to each other build an understanding during the match.</small></li>';
    return `<h3 style="margin-top:12px">Partnerships</h3><ul class="partners">${body}</ul>
      <p class="note">Pairs with an understanding find each other a little more accurately, read each other's passes and offer themselves for the ball more.</p>`;
  }

  /** Substitutions: pick who comes off and who comes on; the change is made at the next stoppage. */
  private showSubs(sel: { out: number; on: number } = { out: -1, on: -1 }, note = '') {
    const s = this.session;
    const v = s?.view();
    if (!s || !v) return;
    const team = s.localTeams[0] ?? 0;
    const used = v.subs.filter((x) => x[0] === team);
    const bench = benchFor(v.teams[team]);
    const pct = (x: number) => Math.round(x * 100);
    const mine = v.players.filter((p) => p.team === team && !p.off);
    const outGk = sel.out >= 0 && v.players[sel.out].role === 'GK';
    const rows = mine.map((p) => `<button class="subrow ${sel.out === p.id ? 'on' : ''}" data-out="${p.id}"><b>${p.def.number}</b><span>${esc(p.def.short)}</span><small>${p.role}</small><i class="stam"><i style="width:${pct(p.stamina)}%;background:${p.stamina < 0.45 ? 'var(--warn)' : 'var(--accent)'}"></i></i></button>`).join('');
    const brows = bench.map((d, i) => {
      const gone = used.some((x) => x[2] === i);
      const bad = sel.out >= 0 && (d.role === 'GK') !== outGk;
      return `<button class="subrow ${sel.on === i ? 'on' : ''}" data-on="${i}" ${gone || bad ? 'disabled' : ''}><b>${d.number}</b><span>${esc(d.short)}</span><small>${gone ? 'used' : d.role === 'GK' ? 'GK' : d.role === 'RCB' ? 'DEF' : d.role === 'RCM' ? 'MID' : d.role === 'RW' ? 'WING' : 'FWD'}</small></button>`;
    }).join('');
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel">
      <h2>Substitutions</h2>
      <p class="note">${5 - used.length} of 5 left. Tired players' bars run low as the match goes on and they no longer recover fully; a substitute comes on fresh. Changes are made at the next stoppage.</p>
      <div class="subgrid"><div><span class="lbl">On the pitch</span>${rows}</div><div><span class="lbl">Bench</span>${brows}</div></div>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      <div class="row end" style="margin-top:12px"><button class="btn" data-a="back">Back</button><button class="btn primary" data-a="make" ${sel.out >= 0 && sel.on >= 0 ? '' : 'disabled'}>Make substitution</button></div>
    </div></div>`;
    this.ui.querySelectorAll<HTMLElement>('[data-out]').forEach((b) => b.addEventListener('click', () => this.showSubs({ out: Number(b.dataset.out), on: -1 })));
    this.ui.querySelectorAll<HTMLElement>('[data-on]').forEach((b) => b.addEventListener('click', () => this.showSubs({ ...sel, on: Number(b.dataset.on) })));
    this.on('[data-a=back]', () => this.openPause());
    this.on('[data-a=make]', () => {
      const ok = s.requestSub(sel.out, sel.on);
      if (!ok) { this.showSubs({ out: -1, on: -1 }, 'That change is not allowed.'); return; }
      this.showSubs({ out: -1, on: -1 }, `${v.players[sel.out].def.short} off, ${bench[sel.on].short} on${v.phase === 'play' ? ' at the next stoppage' : ''}.`);
    });
  }

  /** Team stats as a TV graphic: both values and a bar in the club colours for each stat. */
  private statsTable(v: ViewState) {
    return statsGraphic(v);
  }

  /** Man of the Match: who, for whom, their rating and what they did. */
  private motm(v: ViewState) {
    const r = v.ratings?.find((x) => x.motm);
    if (!r) return '';
    return `<div class="motm"><span class="motm-tag">Man of the Match</span><b>${esc(r.name)}</b><span class="rating ${ratingClass(r.rating)}">${r.rating.toFixed(1)}</span><span class="motm-sub">${esc(v.teams[r.team as 0 | 1].name)} · ${esc(statLine(r))}</span></div>`;
  }

  /** Both line-ups with each player's rating (substitutes under the player they replaced). */
  private ratingsTable(v: ViewState) {
    const rs = v.ratings ?? [];
    const col = (t: number) => rs
      .filter((r) => r.team === t)
      .sort((a, b) => a.pid - b.pid || a.from - b.from)
      .map((r) => `<div class="pr${r.motm ? ' star' : ''}${r.from > 0 ? ' sub' : ''}" title="${esc(statLine(r))}"><span class="pn">${r.number}</span><span class="pname">${esc(r.short)}${r.red ? ' 🟥' : r.yellow ? ' 🟨' : ''}${r.goals ? ' ' + '⚽'.repeat(Math.min(r.goals, 3)) : ''}</span><span class="rating ${ratingClass(r.rating)}">${r.rating.toFixed(1)}</span></div>`)
      .join('');
    return `<div class="ratings"><div><h4>${esc(v.teams[0].abbr)}</h4>${col(0)}</div><div><h4>${esc(v.teams[1].abbr)}</h4>${col(1)}</div></div>`;
  }

  /** Stats or ratings, switched by a button (so a controller can flip between them). */
  private statsBlock(v: ViewState) {
    if (!v.ratings?.length) return this.statsTable(v);
    return `<div class="stats-tabs" data-tab="${this.resultsTab}"><div class="tab-stats">${this.statsTable(v)}</div><div class="tab-ratings">${this.ratingsTable(v)}</div></div>`;
  }

  private bindStatsToggle() {
    this.on('[data-a=ratings]', (el) => {
      this.resultsTab = this.resultsTab === 'stats' ? 'ratings' : 'stats';
      this.ui.querySelector('.stats-tabs')?.setAttribute('data-tab', this.resultsTab);
      el.textContent = this.resultsTab === 'stats' ? 'Player ratings' : 'Match stats';
    });
  }

  private ratingsButton(v: ViewState) {
    return v.ratings?.length ? `<button class="btn" data-a="ratings">${this.resultsTab === 'stats' ? 'Player ratings' : 'Match stats'}</button>` : '';
  }

  private scorers(v: ViewState) {
    const list = (t: number) => v.goals.filter((g) => g.team === t).map((g) => `${esc(v.players[g.player]?.def.short ?? '?')}${g.ownGoal ? ' (og)' : ''} ${g.added ? `${g.minute}+${g.added}` : Math.min(120, g.minute)}'`).join('<br>') || '&nbsp;';
    return `<div class="scorers"><div>${list(0)}</div><div>${list(1)}</div></div>`;
  }

  private openHalftime(v: ViewState) {
    if (!this.session) return;
    this.overlay = 'halftime';
    const offline = this.session instanceof OfflineSession;
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h3 style="text-align:center">${v.half === 1 ? 'Half-time' : v.half === 2 ? 'Full-time · extra time next' : 'Extra time · half-time'}</h3>
      <div class="final">${v.teams[0].abbr} ${v.score[0]} – ${v.score[1]} ${v.teams[1].abbr}</div>
      ${this.scorers(v)}${this.statsBlock(v)}
      <p class="note">${v.half === 2 ? 'Level after 90 minutes: two halves of 15 minutes, then penalties if it is still level.' : 'Teams change ends. The camera stays on the same side.'}</p>
      ${offline ? `<div class="row end">${this.highlightsButton(v, 'half')}${this.ratingsButton(v)}<button class="btn primary" data-a="second">${v.half === 1 ? 'Start second half' : v.half === 2 ? 'Start extra time' : 'Start second half of extra time'}</button></div>` : '<p class="note ht-count"></p>'}
    </div></div>`;
    this.on('[data-a=second]', () => { (this.session as OfflineSession).continueHalftime(); this.closeOverlay(); });
    this.bindHighlights(v, 'half', (w) => this.openHalftime(w));
    this.bindStatsToggle();
  }

  // ------------------------------------------------------------- modes added 19 Nov 2026

  /** A match for Career, Be a Pro, a scenario or a skill game. */
  private playMode(m: ModeMatch) {
    this.local.seats = null;
    this.startOffline(m.patch.practice, m.patch.challenge, undefined, m);
  }

  /** Full time of a mode match: the usual panel with what it meant for the mode, and Continue. */
  private openModeResults(v: ViewState, mm: ModeMatch, first: boolean) {
    const s = this.session as OfflineSession;
    this.overlay = 'fulltime';
    if (first && mm.kind !== 'skill') this.recordForProfile(v);
    this.resultsNote = '';
    const res = this.modes.finish(v, s.match);
    const so = v.shootout;
    const pens = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : null;
    const title = mm.kind === 'skill' ? ({ crossbar: 'Crossbar challenge', targets: 'Target practice' } as Record<string, string>)[mm.ref ?? ''] ?? 'Skill game'
      : `Full-time · ${pens ? `${v.teams[so!.winner as 0 | 1].name} win on penalties` : v.score[0] === v.score[1] ? 'Draw' : `${v.score[0] > v.score[1] ? v.teams[0].name : v.teams[1].name} win${v.half > 2 ? ' after extra time' : ''}`}`;
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h3 style="text-align:center">${esc(title)}</h3>
      ${mm.kind === 'skill' ? '' : `<div class="final">${v.teams[0].abbr} ${v.score[0]} – ${v.score[1]} ${v.teams[1].abbr}</div>${pens ? `<div class="final small">Penalties ${pens[0]} – ${pens[1]}</div>` : ''}${this.motm(v)}${this.scorers(v)}`}
      ${res?.html ?? ''}
      ${mm.kind === 'skill' ? '' : this.statsBlock(v)}
      ${mm.kind === 'skill' ? '' : this.saveGoalsHtml(v)}
      <div class="row end">${mm.kind === 'skill' ? '' : this.highlightsButton(v, 'match') + this.ratingsButton(v)}${mm.kind === 'skill' || mm.kind === 'scenario' ? '<button class="btn" data-a="again">Try again</button>' : ''}<button class="btn primary" data-a="mcont">${esc(res?.label ?? 'Continue')}</button></div>
    </div></div>`;
    this.bindSaveGoals(v);
    this.bindHighlights(v, 'match', (w) => this.openResults(w));
    this.bindStatsToggle();
    this.on('[data-a=mcont]', () => { const next = res?.next; this.endSession(); if (next) next(); else this.showMode(); });
    this.on('[data-a=again]', () => { this.endSession(); this.playMode(mm); });
  }

  /** Your goals this match, each with a Save button (they go to My goals). */
  private saveGoalsHtml(v: ViewState): string {
    const me = this.session?.localTeams[0] ?? 0;
    const goals = this.cine.book.list.map((h, i) => ({ h, i })).filter(({ h }) => h.kind === 'goal' && h.team === me && h.clip.length > 20);
    if (!goals.length || this.cineOff && !new URLSearchParams(location.search).has('clips')) return '';
    void v;
    return `<div class="save-goals"><span class="lbl">Save your goals</span>${goals.map(({ h, i }) => `<button class="btn small" data-savegoal="${i}" ${this.savedGoals.has(i) ? 'disabled' : ''}>${this.savedGoals.has(i) ? '✓ Saved' : `Save ${esc(h.who)} ${esc(h.minute)}`}</button>`).join('')}</div>`;
  }

  private bindSaveGoals(v: ViewState) {
    this.on('[data-savegoal]', (el) => {
      const i = Number(el.dataset.savegoal);
      const h = this.cine.book.list[i];
      if (!h || this.savedGoals.has(i)) return;
      const live = this.session?.view() ?? v;
      const clip = makeClip(live, h.clip, h.t, `${h.who} ${h.minute}`, `${v.teams[0].name} ${v.score[0]}–${v.score[1]} ${v.teams[1].name}`);
      el.setAttribute('disabled', '');
      el.textContent = 'Saving…';
      void saveClip(clip).then((ok) => {
        if (ok) this.savedGoals.add(i);
        el.textContent = ok ? '✓ Saved' : 'Storage full';
      });
    });
  }

  /** Plays a saved goal in the stadium (and records it as a video to share when asked). */
  private watchClip(c: GoalClip, record: boolean) {
    if (this.session) return;
    const r = this.ensureRenderer();
    this.backdrop.stop(r);
    this.backdrop.release();
    this.screenName = 'clip';
    this.ui.innerHTML = `<div class="clip-bar"><b>${esc(c.title)}</b><span class="clip-part">${record ? '<span class="clip-rec">● REC</span> ' : ''}As it happened</span><button class="btn small" data-a="clipstop">${record ? 'Cancel' : 'Stop'}</button></div>`;
    document.body.classList.add('clip-live');
    let cancelled = false;
    const done = (video: Blob | null) => {
      document.body.classList.remove('clip-live');
      this.renderer!.cine = null;
      this.screenName = 'clips';
      const back = (note = '') => { void this.modes.showClips(note); const last = this.lastTeams; setTimeout(() => this.startBackdrop(last?.teams, last?.kits), 0); };
      if (record && video && !cancelled) {
        this.ui.innerHTML = `<div class="screen"><div class="panel narrow"><h3>Your video is ready</h3><p class="note">${esc(c.title)} · ${esc(c.sub)}</p><div class="row end"><button class="btn" data-a="vback">Back</button><button class="btn primary" data-a="vshare" autofocus>Share video</button></div></div></div>`;
        this.on('[data-a=vback]', () => back());
        this.on('[data-a=vshare]', () => void shareVideo(video, `${c.title} ${c.sub}`).then((how) => back(how === 'shared' ? 'Shared.' : how === 'downloaded' ? 'Saved to your downloads.' : '')));
      } else back(record && !cancelled ? 'This browser can\'t record video from the game, sorry.' : '');
    };
    this.theatre.onEnd = done;
    this.theatre.start(c, r, record);
    const part = this.ui.querySelector('.clip-part');
    const tick = () => { if (!this.theatre.playing) return; if (part) part.innerHTML = `${record ? '<span class="clip-rec">● REC</span> ' : ''}${this.theatre.part}`; setTimeout(tick, 250); };
    tick();
    this.on('[data-a=clipstop]', () => { cancelled = true; this.theatre.stop(); });
  }

  /** Short messages over the match: skill-game points, injuries. */
  private matchToasts(v: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      let text = '', cls = '';
      if (e.type === 'call' && e.text?.startsWith('skill:')) {
        const [, pts, what] = e.text.split(':');
        text = Number(pts) > 0 ? `${what} +${pts}` : Number(pts) < 0 ? `${what} ${pts}` : what;
        cls = Number(pts) > 0 ? 'good' : 'bad';
        // Keepy-ups in the ball control drill come thick and fast: no crowd roar for each one.
        if (what !== 'Keepy-up') { if (Number(pts) > 0) this.audio.react('goal'); else this.audio.react('ooh'); }
      } else if (e.type === 'injury') {
        const [kind, named] = (e.text ?? '').split(':');
        const who = named || (v.players[e.player ?? -1]?.def.short ?? '');
        text = kind === 'up' ? `${who} is back on his feet` : kind === 'subbed' ? `${who} is stretchered off and replaced` : kind === 'tenmen' ? `${who} is stretchered off: no substitutes left` : `${who} is down injured`;
        cls = kind === 'up' ? 'good' : 'bad';
      }
      if (!text) continue;
      // The newest message replaces any still showing (they sit in the same spot).
      document.querySelectorAll('#hud .match-toast').forEach((o) => o.remove());
      const el = document.createElement('div');
      el.className = `match-toast ${cls}`;
      el.textContent = text;
      document.getElementById('hud')!.appendChild(el);
      setTimeout(() => el.remove(), 2600);
    }
  }

  /** End of a practice challenge: the score, and the best on this device. */
  private openChallengeResult(v: ViewState, cfg: MatchConfig) {
    this.overlay = 'fulltime';
    const d = cfg.practice as 'freekick' | 'penalty' | 'crosses' | 'control';
    const prev = this.bestScore(d);
    const score = v.score[0];
    if (this.resultsNote === null) {
      this.resultsNote = '';
      if (prev === null || score > prev) this.profile.challengeBest[d] = score;
      if (d !== 'control' && score >= 10 && (cfg.challenge ?? 0) >= 10) this.announce(unlock(this.profile, ['perfect-ten']));
      this.saveProfile();
    }
    const name = { freekick: 'Free-kick challenge', penalty: 'Penalty challenge', crosses: 'Finishing challenge', control: 'Ball control drill' }[d];
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h3 style="text-align:center">${name}</h3>
      <div class="final">${d === 'control' ? `${score} points` : `${score} / ${cfg.challenge}`}</div>
      <p class="note" style="text-align:center">${prev === null ? 'First try: this is your best so far.' : score > prev ? `New best! (was ${prev})` : `Best: ${prev}`}</p>
      <div class="row end"><button class="btn" data-a="menu">Practice menu</button><button class="btn primary" data-a="again">Try again</button></div>
    </div></div>`;
    this.on('[data-a=menu]', () => { this.endSession(); this.showPractice(); });
    this.on('[data-a=again]', () => { cfg.seed = (Math.random() * 2 ** 31) | 0; this.beginSession(this.makeOffline(cfg)); });
  }

  private openResults(v: ViewState) {
    if (!this.session) return;
    // Adaptive difficulty carries over: the next match starts where this one finished, nudged by the result.
    const first = this.resultsNote === null;
    if (first && this.session instanceof OfflineSession && this.session.cfg.difficulty[1] === 'adaptive' && !this.session.cfg.humans[1] && !this.session.cfg.practice) {
      const m = this.session.match;
      const gd = m.score[0] - m.score[1];
      this.settings.adaptiveLevel = Math.max(1, Math.min(3, m.adaptiveLevel + Math.sign(gd) * 0.1));
      saveSettings(this.settings);
    }
    if (this.modeMatch && this.session instanceof OfflineSession) { this.openModeResults(v, this.modeMatch, first); return; }
    if (this.session instanceof OfflineSession && this.session.cfg.challenge) { this.openChallengeResult(v, this.session.cfg); return; }
    this.overlay = 'fulltime';
    const online = this.session instanceof OnlineSession;
    const so = v.shootout;
    const pens = so && so.winner >= 0 ? [so.kicks[0].filter(Boolean).length, so.kicks[1].filter(Boolean).length] : null;
    // A cup or league match: the result goes into the competition (once).
    let compNote = this.resultsNote ?? '';
    if (first && this.compMatch && this.comp && this.session instanceof OfflineSession && opponentOf(this.comp) === this.session.cfg.teams[1]) {
      const before = this.comp;
      this.comp = recordResult(before, v.score[0], v.score[1], pens ? [pens[0], pens[1]] : undefined, v.half > 2);
      if (this.comp.champion && !before.champion) this.announce(recordTrophy(this.profile, this.comp, teamById(this.comp.club).name));
      this.saveProfile();
      compNote = `<p class="note comp-note">${esc(compSummary(this.comp))}</p>`;
    }
    if (first) this.recordForProfile(v);
    this.resultsNote = compNote;
    const result = (online && this.rankedForfeit(v)) || (pens ? `${v.teams[so!.winner as 0 | 1].name} win ${Math.max(...pens)}–${Math.min(...pens)} on penalties` : v.score[0] === v.score[1] ? 'Draw' : `${v.score[0] > v.score[1] ? v.teams[0].name : v.teams[1].name} win${v.half > 2 ? ' after extra time' : ''}`);
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h3 style="text-align:center">Full-time · ${esc(result)}</h3>
      <div class="final">${v.teams[0].abbr} ${v.score[0]} – ${v.score[1]} ${v.teams[1].abbr}</div>
      ${pens ? `<div class="final small">Penalties ${pens[0]} – ${pens[1]}</div>` : ''}
      ${this.motm(v)}
      ${this.scorers(v)}${this.statsBlock(v)}
      <p class="note rematch-note">${online && !this.room?.ranked ? 'A rematch starts when both players choose it.' : ''}</p>
      ${online && this.room?.ranked ? `<div class="rank-note">${this.rankRes ? rankedResultHtml(this.rankRes) : '<p class="note">Updating your division…</p>'}</div>` : ''}
      ${compNote}
      ${online ? '' : this.saveGoalsHtml(v)}
      <div class="row end">${online ? '' : this.highlightsButton(v, 'match')}${this.ratingsButton(v)}<button class="btn" data-a="menu">Main menu</button>${this.compMatch ? '<button class="btn primary" data-a="comp">Continue</button>' : online && this.room?.ranked ? '<button class="btn primary" data-a="rankmenu">Ranked menu</button>' : '<button class="btn primary" data-a="rematch">Rematch</button>'}</div>
    </div></div>`;
    this.on('[data-a=comp]', () => { this.endSession(); this.showCompHub(); });
    this.on('[data-a=rankmenu]', () => { this.endSession(); this.showRanked(); });
    this.bindSaveGoals(v);
    this.bindHighlights(v, 'match', (w) => this.openResults(w));
    this.bindStatsToggle();
    this.on('[data-a=menu]', () => { this.endSession(); this.showMode(); });
    this.on('[data-a=rematch]', (el) => {
      if (this.session instanceof OfflineSession) {
        const cfg = this.session.cfg;
        cfg.seed = (Math.random() * 2 ** 31) | 0;
        this.beginSession(this.makeOffline(cfg));
      } else if (this.net) {
        this.net.send({ t: 'rematch', want: true });
        el.setAttribute('disabled', '');
        el.textContent = 'Waiting for opponent…';
      }
    });
  }

  // ------------------------------------------------------------- profile, achievements, tutorial, photo mode

  private saveProfile() { saveStore(this.store); }

  private bestScore(d: string): number | null {
    const v = this.profile.challengeBest[d];
    return typeof v === 'number' ? v : null;
  }

  /** Achievement pop-ups (top right; they stack and fade after a few seconds). */
  private announce(list: Achievement[]) {
    list.forEach((a, i) => setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'achieve';
      el.innerHTML = `<span class="ic">${a.icon}</span><div><small>Achievement unlocked</small><b>${esc(a.name)}</b><span>${esc(a.text)}</span></div>`;
      this.achieveEl.appendChild(el);
      this.audio.ui('select');
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); }, 4800);
    }, i * 900));
  }

  /** Goals, set pieces and shot distances for the profile (goal kinds feed the achievements). */
  private trackEvents(s: Session, v: ViewState, evs: MatchEvent[]) {
    const me = s.localTeams[0] ?? 0;
    const t = this.track;
    for (const e of evs) {
      if (e.type === 'restart') t.restart = e.text ?? '';
      else if (e.type === 'kickoff') t.restart = '';
      else if (e.type === 'kick') {
        const pl = v.players[e.player ?? -1];
        t.lastKick = { text: e.text ?? '', x: e.x ?? pl?.pos.x ?? 0, z: e.z ?? pl?.pos.z ?? 0, player: e.player ?? -1, team: e.team ?? -1, from: t.restart };
        t.restart = '';
      } else if (e.type === 'goal' && e.team === me && e.text !== 'og' && e.text !== 'pen' && !v.shootout) {
        const k = t.lastKick;
        const scorer = v.players[e.player ?? -1]?.def.short ?? '?';
        const kind: GoalDetail['kind'] = k.from === 'penalty' ? 'penalty' : k.from === 'freekick' && k.player === e.player && (k.text === 'shot' || k.text === 'volley') ? 'freekick'
          : k.text === 'header' ? 'header' : k.text === 'volley' ? 'volley' : k.text === 'shot' ? 'shot' : 'other';
        const gx = PITCH.halfLength * v.attackDir[me];
        const g = v.goals[v.goals.length - 1];
        t.goals.push({ scorer, kind, distance: k.player === e.player ? Math.hypot(k.x - gx, k.z) : 0, minute: g?.minute ?? 0, ...(g?.added ? { added: g.added } : {}) });
      }
    }
  }

  /** Full time: the match goes on the active profile's record (not practice, challenges or the tutorial). */
  private recordForProfile(v: ViewState) {
    const s = this.session;
    if (!s) return;
    const off = s instanceof OfflineSession ? s : null;
    if (off && (off.cfg.practice || off.cfg.challenge)) return;
    // Local versus (people on both sides) is not a result against the computer.
    if (off && off.cfg.humans[0] && off.cfg.humans[1]) return;
    const me = (s.localTeams[0] ?? 0) as 0 | 1, them = (1 - me) as 0 | 1;
    const so = v.shootout;
    const pens: [number, number] | undefined = so && so.winner >= 0 ? [so.kicks[me].filter(Boolean).length, so.kicks[them].filter(Boolean).length] : undefined;
    const st = v.stats;
    const poss = st[me].possessionTicks / Math.max(1, st[me].possessionTicks + st[them].possessionTicks);
    const mode: MatchSummary['mode'] = !off ? 'online' : this.compMatch && this.comp ? this.comp.kind : 'quick';
    const m: MatchSummary = {
      mode, club: v.teams[me].id, clubName: v.teams[me].name, opp: v.teams[them].id, oppName: v.teams[them].name, custom: isCustomId(v.teams[me].id),
      difficulty: off ? off.cfg.difficulty[1] : '', adaptiveWorld: !!off && off.cfg.difficulty[1] === 'adaptive' && off.match.adaptiveLevel >= 2.5,
      gf: v.score[me], ga: v.score[them], pens, stats: st[me], possession: poss, goals: this.track.goals, sequence: goalSequence(v.goals, me), half: v.half,
    };
    this.announce(recordMatch(this.profile, m));
    this.saveProfile();
    // The club's history (Trophy cabinet and club history): offline matches against the computer.
    if (off) this.modes.recordClub({ club: m.club, opp: m.opp, oppName: m.oppName, gf: m.gf, ga: m.ga, pens, scorers: v.goals.filter((g) => g.team === me && !g.ownGoal).map((g) => v.players[g.player]?.def.short ?? '?'), mode: this.modeMatch?.kind ?? mode });
  }

  private coachName(a: BindAction): string {
    if (this.touchMode) return ({ pass: 'PASS', shoot: 'SHOOT', lob: 'LOB', through: 'THROUGH', sprint: 'SPRINT', jockey: 'JOCKEY', switch: 'SWITCH', skill: 'SKILL' } as Record<string, string>)[a] ?? a.toUpperCase();
    return this.bindingName(a);
  }

  private moveName(): string {
    if (this.actions.lastDevice === 'gamepad') return 'the left stick';
    if (this.touchMode) return 'the left thumb pad';
    if (this.mouseMode) return 'the mouse (point where to run)';
    const k = (a: BindAction) => keysText(this.settings.controls, a)[0] ?? '';
    return [k('up'), k('left'), k('down'), k('right')].join(' ');
  }

  /** Guided first match: practice open play against a Casual side, with the coach card. */
  private startTutorial() {
    this.tutorialMatch = true;
    this.startOffline('free');
  }

  private openTutorialDone() {
    const s = this.session;
    if (!(s instanceof OfflineSession)) return;
    this.overlay = 'pause';
    s.pause(true);
    this.ui.innerHTML = `<div class="screen translucent"><div class="panel narrow">
      <h2>Guided match complete</h2>
      <p class="note">You have moved, sprinted, switched, jockeyed, tackled, passed, played through balls and lobs, beaten a man and scored. The Controls screen lists everything else, such as chips, driven passes, crosses and set pieces.</p>
      <div class="stack" style="margin-top:12px">
        <button class="btn primary" data-a="real">Play a real match</button>
        <button class="btn" data-a="keep">Keep practising</button>
        <button class="btn" data-a="menu">Main menu</button>
      </div></div></div>`;
    this.on('[data-a=real]', () => { this.endSession(); this.showTeams(); });
    this.on('[data-a=keep]', () => { this.coach?.dispose(); this.coach = null; this.closeOverlay(); });
    this.on('[data-a=menu]', () => { this.endSession(); this.showMode(); });
  }

  /** Photo mode: freeze the match and fly the camera around it. */
  private openPhoto() {
    const s = this.session;
    const v = s?.view();
    const r = this.renderer;
    if (!(s instanceof OfflineSession) || !v || !r) return;
    this.overlay = 'photo';
    s.pause(true);
    const cp = r.camera.cam.position;
    this.photo.start(v, { x: cp.x, y: cp.y, z: cp.z });
    this.photoPrev = { a: true, b: true, x: true, y: true };
    document.body.classList.add('photo-on');
    this.drawPhotoPanel();
  }

  private photoPrev = { a: false, b: false, x: false, y: false };

  private drawPhotoPanel() {
    const p = this.photo;
    this.ui.innerHTML = p.panel ? `<div class="photo-panel">
      <div class="row between"><b class="photo-title">Photo mode</b><span class="note">Left stick move · Right stick orbit · LT/RT zoom · LB/RB up/down · X filter · Y hide · A take · B back${this.touchMode ? ' · drag to orbit' : ''}</span></div>
      <div class="row wrap">${this.seg('pfilter', PHOTO_FILTERS.map(([f, n]) => [f, n] as [string, string]), p.filter)}</div>
      <div class="row wrap">
        <button class="btn small" data-a="zout">Zoom out</button><button class="btn small" data-a="zin">Zoom in</button>
        ${this.seg('pvig', [['on', 'Vignette'], ['off', 'No vignette']], p.vignette ? 'on' : 'off')}
        ${this.seg('pstamp', [['on', 'Score stamp'], ['off', 'No stamp']], p.stamp ? 'on' : 'off')}
        <button class="btn small" data-a="phide">Hide panel</button>
        <button class="btn small" data-a="back">Back</button>
        <button class="btn primary" data-a="snap">Take photo</button>
      </div></div>` : '<button class="photo-show" data-a="pshow">Show panel</button>';
    const canvas = this.renderer?.renderer.domElement;
    if (canvas) canvas.style.filter = FILTER_CSS[p.filter];
    this.bindSeg('pfilter', (v) => { p.filter = v as typeof p.filter; this.drawPhotoPanel(); });
    this.bindSeg('pvig', (v) => { p.vignette = v === 'on'; this.drawPhotoPanel(); });
    this.bindSeg('pstamp', (v) => { p.stamp = v === 'on'; this.drawPhotoPanel(); });
    this.on('[data-a=zin]', () => p.step(1));
    this.on('[data-a=zout]', () => p.step(-1));
    this.on('[data-a=phide]', () => { p.panel = false; this.drawPhotoPanel(); });
    this.on('[data-a=pshow]', () => { p.panel = true; this.drawPhotoPanel(); });
    this.on('[data-a=back]', () => this.closePhoto(true));
    this.on('[data-a=snap]', () => this.takePhoto());
  }

  private photoKey(e: KeyboardEvent, down: boolean) {
    if (e.code === 'Escape' && down) { e.preventDefault(); e.stopImmediatePropagation(); if (this.ui.querySelector('.photo-shot')) this.drawPhotoPanel(); else this.closePhoto(true); return; }
    if (e.code === 'Space' && down && !e.repeat && !this.ui.querySelector('.photo-shot')) { e.preventDefault(); this.takePhoto(); return; }
    if (down) this.photo.keys.add(e.code); else this.photo.keys.delete(e.code);
  }

  private photoFrame(dt: number) {
    const s = this.session, r = this.renderer;
    const v = s?.view();
    if (!s || !r || !v) return;
    const reviewing = !!this.ui.querySelector('.photo-shot');
    r.cine = this.photo.update(reviewing ? 0 : dt);
    r.render(v, 0.0001, this.settings.camera, { localTeams: [], receiver: -1, showNext: false, playerRing: false, highContrast: false, hideMarkers: true });
    // Controller buttons: A take, B back, X filter, Y show or hide the panel.
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const b = { a: false, b: false, x: false, y: false };
    for (const p of pads) if (p) { b.a ||= !!p.buttons[0]?.pressed; b.b ||= !!p.buttons[1]?.pressed; b.x ||= !!p.buttons[2]?.pressed; b.y ||= !!p.buttons[3]?.pressed; }
    const pr = this.photoPrev;
    if (b.a && !pr.a) { if (reviewing) this.drawPhotoPanel(); else this.takePhoto(); }
    if (b.b && !pr.b) { if (reviewing) this.drawPhotoPanel(); else this.closePhoto(true); }
    if (b.x && !pr.x && !reviewing) { this.photo.nextFilter(); this.drawPhotoPanel(); }
    if (b.y && !pr.y && !reviewing) { this.photo.panel = !this.photo.panel; this.drawPhotoPanel(); }
    this.photoPrev = b;
  }

  private takePhoto() {
    const s = this.session, r = this.renderer;
    const v = s?.view();
    if (!s || !r || !v) return;
    r.cine = this.photo.shot();
    r.render(v, 0.0001, this.settings.camera, { localTeams: [], receiver: -1, showNext: false, playerRing: false, highContrast: false, hideMarkers: true });
    const stamp = this.photo.stamp ? `${v.teams[0].abbr} ${v.score[0]}–${v.score[1]} ${v.teams[1].abbr} · ${minuteText(v.clock, v.half)}` : null;
    const url = composePhoto(r.renderer.domElement, { filter: this.photo.filter, vignette: this.photo.vignette, stamp });
    this.audio.ui('select');
    if (!url) { this.hud.toast('This browser would not let the game read the picture.'); return; }
    this.profile.photos++;
    this.announce(unlock(this.profile, ['photographer']));
    this.saveProfile();
    const name = `elevens-${today()}-${Date.now() % 100000}.jpg`;
    const canShare = typeof navigator.share === 'function';
    this.ui.innerHTML = `<div class="photo-shot"><img src="${url}" alt="Your photo">
      <div class="row center wrap">
        <a class="btn primary" href="${url}" download="${name}" data-a="save">Save picture</a>
        ${canShare ? '<button class="btn" data-a="share">Share</button>' : ''}
        <button class="btn" data-a="again">Back to photo mode</button>
      </div>
      <p class="note">${this.touchDevice ? 'On iPad you can also touch and hold the picture, then choose Save to Photos.' : 'Save picture downloads it as a JPEG.'}</p></div>`;
    this.on('[data-a=again]', () => this.drawPhotoPanel());
    this.on('[data-a=share]', () => {
      void fetch(url).then((res) => res.blob()).then((blob) => {
        const file = new File([blob], name, { type: 'image/jpeg' });
        const data: ShareData = navigator.canShare?.({ files: [file] }) ? { files: [file], title: 'ELEVENS' } : { title: 'ELEVENS', text: stamp ?? 'ELEVENS' };
        return navigator.share(data);
      }).catch(() => this.hud.toast('Sharing is not available here: use Save picture or touch and hold the picture.'));
    });
  }

  private closePhoto(backToPause: boolean) {
    this.photo.stop();
    document.body.classList.remove('photo-on');
    const canvas = this.renderer?.renderer.domElement;
    if (canvas) canvas.style.filter = '';
    if (this.renderer) this.renderer.cine = null;
    const v = this.session?.view();
    if (v) this.renderer?.snapCamera(v);
    this.overlay = 'none';
    this.ui.innerHTML = '';
    if (backToPause) this.openPause();
  }

  // ------------------------------------------------------------- profile screen and club creator

  private showProfile() {
    this.screenName = 'profile';
    const p = this.profile;
    const tab = this.profileTab;
    const tabs = this.seg('ptab', [['career', 'Career'], ['awards', 'Trophies and achievements'], ['clubs', 'My clubs'], ['slots', 'Save slots']], tab);
    let body = '';
    if (tab === 'career') {
      const s = p.stats;
      const rec = (label: string, e?: { value: number; text: string; date: string }, unit = '') => `<tr><td>${label}</td><td><b>${e ? `${e.value}${unit}` : '–'}</b></td><td class="note">${e ? `${esc(e.text)} · ${e.date}` : ''}</td></tr>`;
      body = `<div class="career">
        <div class="bigstats">${[['Played', s.played], ['Won', s.won], ['Drawn', s.drawn], ['Lost', s.lost], ['Goals', s.gf], ['Conceded', s.ga], ['Clean sheets', s.cleanSheets], ['Win rate', s.played ? `${Math.round((s.won / s.played) * 100)}%` : '–']].map(([k, n]) => `<div><b>${n}</b><span>${k}</span></div>`).join('')}</div>
        <h3>Records</h3>
        <table class="records">${rec('Biggest win', p.records.biggestWin, ' goals')}${rec('Most goals in a match', p.records.mostGoals)}${rec('Most goals by one player', p.records.topScorer)}${rec('Longest unbeaten run', p.records.bestUnbeaten, ' matches')}${rec('Longest winning run', p.records.bestWins, ' matches')}<tr><td>Current run</td><td><b>${p.records.unbeaten}</b></td><td class="note">matches unbeaten</td></tr></table>
        <h3>Recent results</h3>
        ${p.recent.length ? `<div class="recent">${p.recent.map((r) => `<div><i class="res ${r.res}">${r.res}</i>${esc(r.text)} <span class="note">${r.date}</span></div>`).join('')}</div>` : '<p class="note">No matches yet. Results against the computer, in the cup and league and online all count (practice does not).</p>'}
        <p class="note">Matches by mode: ${Object.entries(s.modes).map(([k, n]) => `${({ quick: 'vs computer', cup: 'cup', league: 'league', online: 'online' } as Record<string, string>)[k] ?? k} ${n}`).join(' · ') || 'none yet'}. Photos taken: ${p.photos}.</p>
      </div>`;
    } else if (tab === 'awards') {
      body = `<h3>Trophy cabinet</h3>
        ${p.trophies.length ? `<div class="trophies">${p.trophies.map((t) => `<div class="trophy"><span>${t.kind === 'cup' ? '🏆' : '🥇'}</span><b>${t.kind === 'cup' ? 'Elevens Cup' : 'Elevens League'}</b><small>${esc(t.clubName)} · ${t.size} clubs · ${t.date}</small></div>`).join('')}</div>` : '<p class="note">Empty for now: win the cup or the league to fill it.</p>'}
        <h3>Achievements · ${Object.keys(p.achievements).length} of ${ACHIEVEMENTS.length}</h3>
        <div class="achievements">${ACHIEVEMENTS.map((a) => { const d = p.achievements[a.id]; return `<div class="ach ${d ? 'got' : ''}"><span class="ic">${d ? a.icon : '🔒'}</span><div><b>${esc(a.name)}</b><span>${esc(a.text)}</span>${d ? `<small>${d}</small>` : ''}</div></div>`; }).join('')}</div>`;
    } else if (tab === 'clubs') {
      body = `<p class="note">Make up to 6 clubs of your own: name, crest and kits, and a playing style. They play in Play vs computer and the cup and league (not online), and belong to this profile.</p>
        <div class="grid3">${p.clubs.map((c) => { const t = teamById(c.id); return `<div class="club mini myclub"><span class="abbr">${clubBadge(t, 40)} ${esc(c.abbr)} ${this.kitSwatch(c.id, 'home')} ${this.kitSwatch(c.id, 'away')}</span><span class="name">${esc(c.name)}</span><span class="style">${FLAVOUR_NAMES[c.flavour]} · overall ${teamRatings(t).ovr}</span><div class="row"><button class="btn small" data-edit="${c.id}">Edit</button><button class="btn small danger" data-del="${c.id}">${this.slotConfirm === -2 && this.delClub === c.id ? 'Sure?' : 'Delete'}</button></div></div>`; }).join('')}</div>
        ${p.clubs.length < 6 ? '<button class="btn primary" data-a="newclub">Create a club</button>' : '<p class="note">That is the most clubs one profile can hold: delete one to make another.</p>'}`;
    } else {
      body = `<p class="note">Each save slot is a separate profile with its own career, trophies, achievements, clubs, cup or league and challenge bests. Settings and controls are shared by everyone on this device.</p>
        <div class="grid3">${Array.from({ length: SLOT_COUNT }, (_, i) => {
          const q = this.store.slots[i];
          if (!q) return `<div class="slot empty"><b>Slot ${i + 1}</b><span class="note">Empty</span><button class="btn small primary" data-new="${i}">New profile</button></div>`;
          const on = i === this.store.active;
          return `<div class="slot ${on ? 'on' : ''}"><b>${esc(q.name)}</b><span class="note">Slot ${i + 1} · since ${q.created}</span><span>${q.stats.played} played · ${q.stats.won} won · ${q.trophies.length} trophies · ${Object.keys(q.achievements).length} achievements</span>
            <div class="row wrap">${on ? '<span class="badge ok">In use</span>' : `<button class="btn small primary" data-use="${i}">Use this slot</button>`}<button class="btn small" data-ren="${i}">Rename</button><button class="btn small danger" data-wipe="${i}">${this.slotConfirm === i ? 'Sure? Press again' : 'Delete'}</button></div></div>`;
        }).join('')}</div>
        <div class="field" style="margin-top:14px"><label for="pname">Profile name</label><input id="pname" type="text" maxlength="18" value="${esc(p.name)}" autocomplete="nickname"></div>`;
    }
    this.set(`<div class="panel"><h2>${esc(p.name)}</h2>${tabs}<div class="ptab-body">${body}</div>
      <div class="row end" style="margin-top:16px"><button class="btn" data-a="back">Back</button></div></div>`, 'scroll');
    this.bindSeg('ptab', (v) => { this.profileTab = v as typeof this.profileTab; this.slotConfirm = -1; this.showProfile(); });
    this.on('[data-a=back]', () => { this.slotConfirm = -1; this.showMode(); });
    this.on('[data-a=newclub]', () => this.openCreator(null));
    this.on('[data-edit]', (el) => this.openCreator(p.clubs.find((c) => c.id === el.dataset.edit) ?? null));
    this.on('[data-del]', (el) => {
      const id = el.dataset.del!;
      if (this.comp && this.comp.club === id) { this.hud.toast('That club is in your cup or league: finish or abandon it first.'); this.showProfile(); return; }
      if (!(this.slotConfirm === -2 && this.delClub === id)) { this.slotConfirm = -2; this.delClub = id; this.showProfile(); return; }
      p.clubs = p.clubs.filter((c) => c.id !== id);
      applyClubs(p);
      this.saveProfile();
      this.slotConfirm = -1;
      this.showProfile();
    });
    this.on('[data-use]', (el) => { this.useSlot(Number(el.dataset.use)); this.showProfile(); });
    this.on('[data-new]', (el) => { const i = Number(el.dataset.new); this.store.slots[i] = newProfile(`Player ${i + 1}`); this.useSlot(i); this.showProfile(); });
    this.on('[data-ren]', (el) => { this.useSlot(Number(el.dataset.ren)); this.showProfile(); this.ui.querySelector<HTMLInputElement>('#pname')?.focus(); });
    this.on('[data-wipe]', (el) => {
      const i = Number(el.dataset.wipe);
      if (this.slotConfirm !== i) { this.slotConfirm = i; this.showProfile(); return; }
      this.slotConfirm = -1;
      this.store.slots[i] = null;
      // The slot's career, Be a Pro, cabinet and club history go with it.
      clearModes(i);
      this.modes.syncSlot(true);
      if (!this.store.slots.some(Boolean)) this.store.slots[i] = newProfile('Player 1');
      if (!this.store.slots[this.store.active]) this.store.active = this.store.slots.findIndex(Boolean);
      this.useSlot(this.store.active);
      this.showProfile();
    });
    const nm = this.ui.querySelector<HTMLInputElement>('#pname');
    nm?.addEventListener('change', () => { p.name = nm.value.trim().slice(0, 18) || p.name; this.saveProfile(); setTimeout(() => { if (this.screenName === 'profile') this.showProfile(); }, 0); });
  }

  private delClub = '';

  private useSlot(i: number) {
    if (!this.store.slots[i]) return;
    this.store.active = i;
    applyClubs(this.profile);
    this.saveProfile();
    this.compConfirm = false;
  }

  /** The club creator: name and initials, playing style, crest, home and away kits. */
  private openCreator(edit: CustomClubSpec | null) {
    const n = this.profile.clubs.reduce((m, c) => Math.max(m, Number(c.id.split('-')[1]) || 0), 0) + 1;
    this.draft = edit ? JSON.parse(JSON.stringify(edit)) as CustomClubSpec : {
      id: `custom-${n}-${(Math.random() * 1e6) | 0}`, name: randomClubName(), abbr: '', flavour: 'balanced',
      badge: { shape: 'shield', emblem: 'star', bg: 0x123a8c, fg: 0xf2c14e, trim: 0xffffff },
      home: { shirt: 0x123a8c, sleeves: 0x123a8c, shorts: 0xf4f4f4, socks: 0x123a8c, number: 0xffffff, keeper: 0x1f9d55 },
      away: { shirt: 0xf2c14e, sleeves: 0xf2c14e, shorts: 0x123a8c, socks: 0xf2c14e, number: 0x123a8c, keeper: 0xe23d28 },
    };
    if (!this.draft.abbr) this.draft.abbr = abbrOf(this.draft.name);
    this.draftTab = 'kit';
    this.showCreator(!!edit);
  }

  private showCreator(editing: boolean) {
    this.screenName = 'creator';
    const d = this.draft!;
    const pal = (part: string, cur: number) => `<div class="swatches" data-part="${part}">${PALETTE.map((c) => `<button class="sw ${c === cur ? 'on' : ''}" data-c="${c}" style="background:${hex(c)}" aria-label="${hex(c)}"></button>`).join('')}</div>`;
    const kitRows = (k: Kit, pre: string) => `
      <div class="crow"><span class="lbl">Shirt</span>${pal(`${pre}.shirt`, k.shirt)}</div>
      <div class="crow"><span class="lbl">Sleeves</span>${pal(`${pre}.sleeves`, k.sleeves)}</div>
      <div class="crow"><span class="lbl">Shorts</span>${pal(`${pre}.shorts`, k.shorts)}</div>
      <div class="crow"><span class="lbl">Socks</span>${pal(`${pre}.socks`, k.socks)}</div>`;
    const preview = (k: Kit) => `<svg viewBox="0 0 60 70" width="70" height="82" class="kitprev"><path d="M18 6 L8 10 L2 24 L10 28 L14 20 L14 44 L46 44 L46 20 L50 28 L58 24 L52 10 L42 6 C40 10 34 12 30 12 C26 12 20 10 18 6 Z" fill="${hex(k.shirt)}"/><path d="M8 10 L2 24 L10 28 L14 20 Z M52 10 L58 24 L50 28 L46 20 Z" fill="${hex(k.sleeves)}"/><text x="30" y="34" text-anchor="middle" font-size="14" font-weight="900" font-family="system-ui" fill="${hex(k.number)}">10</text><path d="M14 44 H46 L45 56 H32 L30 50 L28 56 H15 Z" fill="${hex(k.shorts)}"/><rect x="16" y="58" width="9" height="11" fill="${hex(k.socks)}"/><rect x="35" y="58" width="9" height="11" fill="${hex(k.socks)}"/></svg>`;
    let body = '';
    if (this.draftTab === 'kit') body = kitRows(d.home, 'home');
    else if (this.draftTab === 'away') body = kitRows(d.away, 'away');
    else body = `
      <div class="crow"><span class="lbl">Shape</span>${this.seg('bshape', BADGE_SHAPES.map((x) => [x, x] as [string, string]), d.badge.shape)}</div>
      <div class="crow"><span class="lbl">Emblem</span><div class="emblems">${BADGE_EMBLEMS.map((e) => `<button class="em ${d.badge.emblem === e ? 'on' : ''}" data-em="${e}" aria-label="${e}">${badgeSvg({ ...d.badge, emblem: e }, d.abbr, 40)}</button>`).join('')}</div></div>
      <div class="crow"><span class="lbl">Background</span>${pal('badge.bg', d.badge.bg)}</div>
      <div class="crow"><span class="lbl">Emblem colour</span>${pal('badge.fg', d.badge.fg)}</div>
      <div class="crow"><span class="lbl">Trim</span>${pal('badge.trim', d.badge.trim)}</div>`;
    const clash = pickOppKit(d.home, { ...teamById(TEAMS[0].id), home: d.away, away: d.away }, 'home', 'off').which === 'change';
    this.set(`<div class="panel creator">
      <h2>${editing ? 'Edit your club' : 'Create a club'}</h2>
      <div class="creator-top">
        <div class="creator-badge">${badgeSvg(d.badge, d.abbr, 110)}</div>
        <div class="creator-kits">${preview(d.home)}<span class="note">Home</span>${preview(d.away)}<span class="note">Away</span></div>
        <div class="stack grow">
          <div class="field"><label for="cname">Club name</label><div class="row"><input id="cname" type="text" maxlength="24" value="${esc(d.name)}"><button class="btn small" data-a="rname">Random name</button></div></div>
          <div class="field"><label for="cabbr">Short name (3 letters)</label><input id="cabbr" type="text" maxlength="3" value="${esc(d.abbr)}" style="width:110px;text-transform:uppercase"></div>
          <div class="field"><span class="lbl">Playing style</span>${this.seg('flav', FLAVOURS.map((f) => [f, FLAVOUR_NAMES[f]] as [string, string]), d.flavour)}</div>
        </div>
      </div>
      ${this.seg('ctab', [['kit', 'Home kit'], ['away', 'Away kit'], ['badge', 'Crest']], this.draftTab)}
      <div class="creator-body">${body}</div>
      ${clash ? '<p class="note warn">Your home and away kits look alike: pick an away kit that stands apart, for matches against clubs in your colours.</p>' : ''}
      <p class="note">The squad is made for you from the club name and style (a level like the two main clubs), and keeps its names and ratings.</p>
      <div class="row end" style="margin-top:14px"><button class="btn" data-a="back">Cancel</button><button class="btn primary" data-a="saveclub">${editing ? 'Save changes' : 'Create club'}</button></div>
    </div>`, 'scroll');
    const redraw = () => { if (this.screenName === 'creator' && this.draft === d) this.showCreator(editing); };
    const nameIn = this.ui.querySelector<HTMLInputElement>('#cname')!, abbrIn = this.ui.querySelector<HTMLInputElement>('#cabbr')!;
    nameIn.addEventListener('input', () => { const auto = d.abbr === abbrOf(d.name); d.name = nameIn.value; if (auto) { d.abbr = abbrOf(d.name); abbrIn.value = d.abbr; } });
    nameIn.addEventListener('change', () => setTimeout(redraw, 0)); // not inside the blur that fires it
    abbrIn.addEventListener('change', () => { d.abbr = abbrIn.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 3) || abbrOf(d.name); setTimeout(redraw, 0); });
    this.on('[data-a=rname]', () => { d.name = randomClubName(); d.abbr = abbrOf(d.name); redraw(); });
    this.bindSeg('flav', (v) => { d.flavour = v as CustomClubSpec['flavour']; redraw(); });
    this.bindSeg('ctab', (v) => { this.draftTab = v as typeof this.draftTab; redraw(); });
    this.bindSeg('bshape', (v) => { d.badge.shape = v as CustomClubSpec['badge']['shape']; redraw(); });
    this.on('[data-em]', (el) => { d.badge.emblem = el.dataset.em as CustomClubSpec['badge']['emblem']; redraw(); });
    this.ui.querySelectorAll<HTMLElement>('.swatches').forEach((row) => row.querySelectorAll<HTMLElement>('.sw').forEach((b) => b.addEventListener('click', () => {
      const [obj, key] = row.dataset.part!.split('.') as ['home' | 'away' | 'badge', string];
      const c = Number(b.dataset.c);
      (d[obj] as unknown as Record<string, number>)[key] = c;
      if (obj !== 'badge') {
        const k = d[obj];
        if (key === 'shirt') { if (k.sleeves === k.shirt || key === 'shirt') k.sleeves = c; }
        k.number = readableInk(k.shirt);
        k.keeper = keeperColour(k.shirt, k.shorts);
        if (obj === 'home' && key === 'shirt') d.badge.bg = c;
      }
      redraw();
    })));
    this.on('[data-a=back]', () => { this.draft = null; this.profileTab = 'clubs'; this.showProfile(); });
    this.on('[data-a=saveclub]', () => {
      d.name = d.name.trim().slice(0, 24) || 'My Club';
      d.abbr = (d.abbr || abbrOf(d.name)).toUpperCase().slice(0, 3);
      const list = this.profile.clubs;
      const i = list.findIndex((c) => c.id === d.id);
      if (i >= 0) list[i] = d; else list.push(d);
      applyClubs(this.profile);
      this.announce(unlock(this.profile, ['founder']));
      this.saveProfile();
      this.draft = null;
      this.choice.club = d.id;
      this.compSetup.club = d.id;
      this.profileTab = 'clubs';
      this.showProfile();
    });
  }

  // ------------------------------------------------------------- controls & settings

  private get padStyleShown() { return this.gamepad.style === 'generic' && this.gamepad.index < 0 ? 'xbox' : this.gamepad.style; }

  /**
   * Controls: remap keyboard keys and controller buttons (select a slot, then press the new key
   * or button; a key or button used elsewhere swaps), or read the full list of controls.
   */
  private showControls(back: () => void, overlay = false) {
    if (overlay) this.overlay = 'help';
    else this.screenName = 'controls';
    this.controlsBack = back;
    this.controlsOverlay = overlay;
    if (!this.bindTab) this.bindTab = this.gamepad.index >= 0 ? 'pad' : this.touchMode ? 'list' : this.mouseMode ? 'mouse' : 'keys';
    const tab = this.bindTab;
    const b = this.settings.controls;
    const style = this.padStyleShown;
    const rb = this.rebind;
    const DEV_WORD = { keys: 'key', pad: 'button', mouse: 'key or button' } as const;
    let body = '';
    if (tab === 'list') {
      body = controlsTable(style, b, this.mouseMode);
    } else {
      const dev = tab;
      const slots = 2;
      const label = (v: string | number) => (dev === 'pad' ? padLabel(style, v as number) : keyLabel(v as string));
      const rows = BIND_ACTIONS.filter((a) => dev === 'keys' || a.pad).map((a) => {
        const list = b[dev][a.id] as (string | number)[];
        const cells = Array.from({ length: slots }, (_, i) => {
          const listening = rb && rb.device === dev && rb.action === a.id && rb.slot === i;
          const v = list[i];
          const text = listening ? (dev === 'keys' ? 'Press a key…' : dev === 'mouse' ? 'Click or press a key…' : 'Press a button…') : v === undefined ? (i === 0 ? 'none' : '+') : label(v);
          // A second slot can only be filled after the first.
          const dis = i > list.length ? 'disabled' : '';
          const start = i === 0 && a.id === (dev === 'keys' ? 'up' : 'pass') ? ' data-padstart' : '';
          return `<button class="bind${listening ? ' listening' : ''}${v === undefined ? ' empty' : ''}" data-bind="${a.id}" data-slot="${i}"${start} ${dis}>${esc(text)}</button>`;
        }).join('');
        const clr = list.length ? `<button class="bind clr" data-clear="${a.id}" title="Remove the last ${DEV_WORD[dev]}" aria-label="Remove the last ${DEV_WORD[dev]} for ${esc(a.name)}">✕</button>` : '<span></span>';
        const fixed = dev !== 'pad' && a.id === 'pause' ? '<small>Esc also pauses</small>' : '';
        return `<div class="bindrow${this.bindFlash.includes(a.id) ? ' flash' : ''}${list.length === 0 && !(dev === 'pad' && a.id === 'help') ? ' warn' : ''}"><span class="bname">${esc(a.name)}${fixed}</span>${cells}${clr}</div>`;
      }).join('');
      const unb = unboundActions(b, dev).map((id) => BIND_ACTIONS.find((x) => x.id === id)!.name);
      const help = dev === 'keys'
        ? 'Select a slot, then press the new key. A key already in use swaps with this slot. Esc cancels, Backspace removes the key.'
        : dev === 'mouse'
          ? 'Your player runs towards the mouse pointer on the pitch: the further away it is, the faster he runs, and resting it on him stops him. Passes, shots and skill moves go the way the pointer is, and at set pieces the target follows it. To change a control, select a slot, then click a mouse button, turn the wheel or press a key. One already in use swaps with this slot. Esc cancels, Backspace removes it.'
          : `Highlight a slot and press A, let go, then press the new button (wait 6 seconds to cancel). A button already in use swaps with this slot. Movement stays on the left stick and D-pad, and the right stick still flicks. In menus A always selects and B always goes back.${this.gamepad.index < 0 ? ' No controller is connected: press a button on it to wake it.' : ''}`;
      const mouseToggle = dev === 'mouse'
        ? `<div class="row between"><span class="lbl">Mouse control</span>${this.seg('mctl', [['off', 'Off'], ['on', 'On']], this.mouseMode ? 'on' : 'off')}</div>
          <p class="note">${this.mouseMode ? 'On: matches use this layout instead of the Keyboard one (a controller still works too).' : 'Off: matches use the Keyboard layout. Turn it on to play with the mouse.'}</p>`
        : '';
      body = `${mouseToggle}<p class="note">${help}</p>
        ${dev === 'pad' ? `<p class="note">Showing ${style === 'playstation' ? 'PlayStation' : style === 'xbox' ? 'Xbox' : 'generic'} button names.</p>` : ''}
        <div class="bindtbl">${rows}</div>
        <p class="bindmsg${unb.length ? ' warn' : ''}" aria-live="polite">${esc(this.bindMsg)}${unb.length ? `${this.bindMsg ? ' ' : ''}No ${DEV_WORD[dev]} for: ${esc(unb.join(', '))}.` : ''}</p>
`;
    }
    const DEV_NAME = { keys: 'keyboard', pad: 'controller', mouse: 'mouse' } as const;
    const reset = tab === 'list' ? '' : `<button class="btn" data-a="bindreset">Reset ${DEV_NAME[tab]} to defaults</button>`;
    this.set(`<div class="panel"><h2>Controls</h2>
      ${this.seg('ctab', [['pad', 'Controller'], ['keys', 'Keyboard'], ['mouse', 'Mouse'], ['list', 'All controls']], tab)}
      ${body}
      <div class="row end" style="margin-top:12px">${reset}<button class="btn primary" data-a="back">Back</button></div></div>`, overlay ? 'translucent' : '');
    const redraw = () => this.showControls(back, overlay);
    this.bindSeg('ctab', (v) => { this.endRebind(); this.bindTab = v as 'keys' | 'pad' | 'mouse' | 'list'; this.bindMsg = ''; this.bindFlash = []; redraw(); });
    this.bindSeg('mctl', (v) => { this.setMouseControl(v === 'on'); redraw(); });
    this.on('[data-bind]', (el) => {
      const action = el.dataset.bind as BindAction;
      const slot = Number(el.dataset.slot);
      const dev = this.bindTab as BindDevice;
      const same = this.rebind && this.rebind.action === action && this.rebind.slot === slot && this.rebind.device === dev;
      this.endRebind();
      if (same) { redraw(); return; }
      this.rebind = { device: dev, action, slot, until: performance.now() + 6000, armed: false };
      this.bindMsg = '';
      this.bindFlash = [];
      redraw();
    });
    this.on('[data-clear]', (el) => {
      const action = el.dataset.clear as BindAction;
      const dev = this.bindTab as BindDevice;
      this.endRebind();
      const list = this.settings.controls[dev][action];
      if (list.length) clearSlot(this.settings.controls, dev, action, list.length - 1);
      this.bindMsg = `Removed from ${BIND_ACTIONS.find((x) => x.id === action)!.name}.`;
      this.bindFlash = [action];
      this.bindingsChanged();
      redraw();
    });
    this.on('[data-a=bindreset]', () => {
      const dev = this.bindTab as BindDevice;
      this.endRebind();
      (this.settings.controls as unknown as Record<string, unknown>)[dev] = defaultBindings()[dev];
      this.bindMsg = `${DEV_NAME[dev][0].toUpperCase()}${DEV_NAME[dev].slice(1)} controls reset to the defaults.`;
      this.bindFlash = [];
      this.bindingsChanged();
      redraw();
    });
    this.on('[data-a=back]', () => { this.endRebind(); this.bindMsg = ''; this.bindFlash = []; back(); });
  }

  /** Turns mouse control on or off (Settings and Controls > Mouse) and hands the input to the right source. */
  private setMouseControl(on: boolean) {
    this.settings.mouseControl = on;
    saveSettings(this.settings);
    this.applyMouseMode();
    this.applyTouchMode();
  }

  /** The first player reads the mouse layout or the keyboard, whichever is in use (outside local multiplayer seats that don't use either). */
  private applyMouseMode() {
    const want = this.keySource, other = want === this.mouse ? this.keyboard : this.mouse;
    const i = this.actions.sources.indexOf(other);
    if (i >= 0) this.actions.sources[i] = want;
    for (const x of this.extraLayers) {
      const j = x.layer.sources.indexOf(other);
      if (j >= 0) x.layer.sources[j] = want;
    }
    this.keyboard.clear();
    this.mouse.clear();
    if (!this.mouseMode) { this.mouse.cursor = null; this.mouse.from = null; }
  }

  /**
   * Each match frame with mouse control: the point under the pointer, and where the run starts
   * (the player you control, or the set-piece target while you aim one). Also the crosshair pointer.
   */
  private updateMouse(v: ViewState, lt: number) {
    const canvas = document.getElementById('game');
    const on = this.mouseMode && this.overlay === 'none';
    const cur = on ? 'crosshair' : '';
    if (canvas && cur !== this.cursorShown) { canvas.style.cursor = cur; this.cursorShown = cur; }
    if (!on || !this.renderer) { this.mouse.cursor = null; this.mouse.from = null; return; }
    this.mouse.yaw = this.renderer.camera.inputYaw;
    this.mouse.cursor = this.mousePt ? this.renderer.groundPoint(this.mousePt.x, this.mousePt.y) : null;
    // Local multiplayer: the seat on the whole keyboard (it uses the mouse); else the first player.
    const seat = this.localPlaying?.find((st) => st.device.kind === 'keys');
    const team = seat ? seat.team : lt;
    const pid = seat && seat.slot ? v.mates?.[team] ?? -1 : v.ctl[team];
    if (this.localPlaying && !seat) { this.mouse.from = null; return; }
    const rs = v.restart;
    if (rs && rs.ready && rs.team === team && rs.taker === pid && v.humans[team]) this.mouse.from = { x: rs.aim.x, z: rs.aim.z };
    else this.mouse.from = pid >= 0 ? { x: v.players[pid].pos.x, z: v.players[pid].pos.z } : null;
  }

  private controlsOpen() {
    return (this.screenName === 'controls' && this.overlay === 'none') || this.overlay === 'help';
  }

  private redrawControls() {
    if (this.controlsBack && this.controlsOpen()) this.showControls(this.controlsBack, this.controlsOverlay);
  }

  private endRebind() {
    if (!this.rebind) return;
    this.rebind = null;
    this.gamepad.muted = false;
    // The button that was just pressed is still down: don't let the menu or the match act on it.
    this.padNav.prevA = true;
    this.padNav.prevB = true;
    this.gamepad.clear();
    this.keyboard.clear();
  }

  /** Saves the bindings and hands them to the keyboard and controller. */
  private bindingsChanged() {
    this.keyboard.setBindings(this.settings.controls);
    this.mouse.setBindings(this.settings.controls);
    this.gamepad.bindings = this.settings.controls;
    saveSettings(this.settings);
  }

  /** Gives the waiting slot its new key or button and explains any swap. */
  private finishRebind(input: string | number) {
    const rb = this.rebind;
    if (!rb) return;
    const name = (id: BindAction) => BIND_ACTIONS.find((x) => x.id === id)!.name;
    const label = rb.device !== 'pad' ? keyLabel(input as string) : padLabel(this.padStyleShown, input as number);
    const res = assign(this.settings.controls, rb.device, rb.action, rb.slot, input);
    let msg = `${label} is now ${name(rb.action)}.`;
    if (res.from) {
      const now = (this.settings.controls[rb.device][res.from] as (string | number)[]);
      msg += res.swapped
        ? ` ${name(res.from)} moved to ${now.map((v) => (rb.device !== 'pad' ? keyLabel(v as string) : padLabel(this.padStyleShown, v as number))).join(' and ')}.`
        : ` It was ${name(res.from)}${now.length ? '' : ', which has none now'}.`;
    }
    this.bindMsg = msg;
    this.bindFlash = res.from ? [rb.action, res.from] : [rb.action];
    this.endRebind();
    this.bindingsChanged();
    this.redrawControls();
  }

  private captureKey(e: KeyboardEvent) {
    const rb = this.rebind;
    if (!rb || rb.device === 'pad' || !this.controlsOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') { this.endRebind(); this.bindMsg = 'Cancelled.'; this.redrawControls(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') {
      const list = this.settings.controls[rb.device][rb.action];
      if (rb.slot < list.length) clearSlot(this.settings.controls, rb.device, rb.action, rb.slot);
      this.bindMsg = `${rb.device === 'mouse' ? 'Input' : 'Key'} removed from ${BIND_ACTIONS.find((x) => x.id === rb.action)!.name}.`;
      this.bindFlash = [rb.action];
      this.endRebind();
      this.bindingsChanged();
      this.redrawControls();
      return;
    }
    if (/^(Control|Alt|Meta|OS)/.test(e.code) || RESERVED_KEYS.has(e.code) || !e.code) {
      this.bindMsg = 'Ctrl, Alt and Cmd can\'t be used: pick another key.';
      this.redrawControls();
      return;
    }
    this.finishRebind(e.code);
  }

  /** Mouse tab capture: the next mouse button or wheel turn goes to the waiting slot (the click doesn't reach the menu). */
  private captureMouse(e: Event, code: string) {
    const rb = this.rebind;
    if (!rb || rb.device !== 'mouse' || !this.controlsOpen()) return;
    if (e instanceof PointerEvent && e.pointerType !== 'mouse') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // The click (and for the right button the browser menu) that follows this press is swallowed too.
    this.swallowUntil = performance.now() + 350;
    this.finishRebind(code);
  }

  /** Controller capture: wait until everything is let go, then take the next button pressed. */
  private padRebind(now: number) {
    const rb = this.rebind!;
    if (!this.controlsOpen()) { this.endRebind(); return; }
    if (now > rb.until) { this.endRebind(); this.bindMsg = 'No button pressed: cancelled.'; this.redrawControls(); return; }
    const held = this.gamepad.pressedButtons();
    if (!rb.armed) {
      if (!held.length && !this.gamepad.anyButton()) rb.armed = true;
      return;
    }
    if (held.length) this.finishRebind(held[0]);
  }

  /** Quality and player style when Settings opened (a change rebuilds the menu stadium). */
  private gfxAtOpen = '';
  private showSettings(back: () => void, overlay = false) {
    const gfxKey = `${this.settings.graphics.preset}|${this.settings.graphics.players}`;
    if (this.screenName !== 'settings' && this.overlay !== 'settings') this.gfxAtOpen = gfxKey;
    if (overlay) this.overlay = 'settings';
    else this.screenName = 'settings';
    const s = this.settings;
    const range = (id: string, v: number, min = 0, max = 1, step = 0.05) => `<input type="range" data-r="${id}" min="${min}" max="${max}" step="${step}" value="${v}">`;
    this.set(`<div class="panel narrow"><h2>Settings</h2>
      <h3>Audio</h3>
      <div class="stack">
        <div class="row between"><span class="lbl">Master</span>${range('master', s.audio.master)}</div>
        <div class="row between"><span class="lbl">Effects</span>${range('effects', s.audio.effects)}</div>
        <div class="row between"><span class="lbl">Crowd</span>${range('crowd', s.audio.crowd)}</div>
        <p class="note sound-status">${this.soundStatus()}</p>
        <div class="row between"><span class="lbl">Menu music</span>${range('music', s.audio.music)}</div>
        <div class="row between"><span class="lbl">Music</span>${this.seg('music', [['on', 'On'], ['off', 'Off']], s.audio.musicOn ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Commentary</span>${this.seg('commentator', [['voice', 'Voice and captions'], ['captions', 'Captions'], ['off', 'Off']], s.commentator ?? 'captions')}</div>
        <p class="note">A commentator talks you through the whole match. The voice is your device's own speech voice.</p>
        <div class="row between"><span class="lbl">Goal calls</span>${this.seg('commentary', [['on', 'On'], ['off', 'Off']], s.audio.commentary !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Stadium announcer</span>${this.seg('announcer', [['on', 'On'], ['off', 'Off']], s.audio.announcer === true ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Menu sounds</span>${this.seg('menusfx', [['on', 'On'], ['off', 'Off']], s.audio.menuSounds !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Announcer voice</span><button class="btn small" data-a="voicetest">Test voice</button></div>
        <p class="note voice-status">${this.voiceStatus()}</p>
        <div class="row between"><span class="lbl">Mute</span>${this.seg('mute', [['off', 'Sound on'], ['on', 'Muted']], s.audio.muted ? 'on' : 'off')}</div>
      </div>
      <h3>Graphics</h3>
      <div class="stack">
        <div class="row between"><span class="lbl">Quality</span>${this.seg('preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], s.graphics.preset)}</div>
        <div class="row between"><span class="lbl">Render scale</span>${range('scale', s.graphics.renderScale, 0.5, 1.5, 0.05)}</div>
        <div class="row between"><span class="lbl">Auto resolution</span>${this.seg('autores', [['on', 'On'], ['off', 'Off']], s.graphics.autoRes !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Frame rate</span>${this.seg('showfps', [['on', 'Show'], ['off', 'Hide']], s.showFps ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Shadows</span>${this.seg('shadows', [['on', 'On'], ['off', 'Off']], s.graphics.shadows ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Players</span>${this.seg('players', [['realistic', 'Realistic'], ['classic', 'Classic']], s.graphics.players ?? 'realistic')}</div>
        ${realisticPlayers(s.graphics) ? `<p class="note players-status">${({ idle: 'Realistic players: not loaded yet', loading: 'Realistic players: loading…', ready: 'Realistic players: loaded', failed: `Realistic players could not load, so simple players are shown (${esc(playerAssetStatus.detail)})` } as const)[playerAssetStatus.state]}</p>` : ''}
        <p class="note gl-status">${esc(glStatusText())}</p>
        <div class="row between"><span class="lbl">Match time</span>${this.seg('matchTime', [['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']], s.graphics.matchTime ?? 'dusk')}</div>
        <div class="row between"><span class="lbl">Weather</span>${this.seg('weather', [['random', 'Random'], ['clear', 'Clear'], ['rain', 'Rain'], ['snow', 'Snow']], s.graphics.weather ?? 'random')}</div>
        <div class="row between"><span class="lbl">Wind</span>${this.seg('wind', [['on', 'On'], ['off', 'Off']], s.wind !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Pitch and kit wear</span>${this.seg('wear', [['on', 'On'], ['off', 'Off']], s.graphics.wear !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">TV colour grade</span>${this.seg('tvgrade', [['on', 'On'], ['off', 'Off']], s.graphics.tvGrade !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Big screens</span>${this.seg('bigscreen', [['live', 'Live pictures'], ['scores', 'Scores only']], s.graphics.bigScreen ?? 'live')}</div>
        <div class="row between wrapline"><span class="lbl">Mowing</span>${this.seg('mowing', [['random', 'Random'], ...MOW_PATTERNS.map((m): [string, string] => [m, MOW_NAMES[m].replace(' stripes', '')])], s.graphics.mowing ?? 'random').replace('class="seg"', 'class="seg wrap"')}</div>
        <div class="row between"><span class="lbl">TV graphics</span>${this.seg('tvg', [['on', 'On'], ['off', 'Off']], s.tvGraphics !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Menu background</span>${this.seg('menubg', [['on', 'Live stadium'], ['off', 'Plain']], s.menuBackdrop !== false ? 'on' : 'off')}</div>
        <p class="note">Weather starts with the next match; Random picks clear, rain or snow each time. It changes how the ball plays: on a wet pitch it skids on and rolls further and keepers spill more, snow slows it down, and wind (shown by the arrow on the radar) carries crosses, long balls and shots. Wind Off keeps every match still. Pitch and kit wear: the grass scuffs and churns to mud where play goes (more in the rain), and kits pick up mud from slides, falls and dives and darken with sweat as the match goes on (realistic players). TV graphics shows the team line-ups before kick-off and match stats along the bottom of the screen. Menu background Live stadium shows a computer match in the stadium behind the menus (30 frames a second on phones and tablets); Plain saves battery. TV colour grade gives the picture a broadcast look: softer shadows, richer colour in the grass and kits, and on High and Ultra a soft glow round the floodlights. Big screens Live pictures shows play on the two big screens (Medium and up), with a slowed replay after each goal; Scores only shows the score and sponsors, which is a little faster. Mowing picks the pattern cut into the grass for the next match (Random changes it each time). Auto resolution draws slightly fewer pixels (never below ${Math.round(AUTO_RES_MIN * 100)}% of the render scale) when the frame rate drops during a match, and goes back up when it recovers. Frame rate Show puts a small readout at the top of the match screen: frames a second, the average and slowest frame time over the last half second, the quality and the resolution in use.</p>
      </div>
      <h3>Camera</h3>
      <div class="stack">
        <div class="row between"><span class="lbl">View</span>${this.seg('cmode', [['tracking', 'Tracking'], ['wide', 'Wide'], ['panoramic', 'Panoramic'], ['broadcast', 'Broadcast']], s.camera.mode ?? 'tracking')}</div>
        <div class="row between"><span class="lbl">Height</span>${this.seg('height', [['low', 'Low'], ['standard', 'Standard'], ['high', 'High']], s.camera.height)}</div>
        <div class="row between"><span class="lbl">Zoom</span>${this.seg('zoom', [['near', 'Near'], ['standard', 'Standard'], ['far', 'Far']], s.camera.zoom)}</div>
        <div class="row between"><span class="lbl">Match intro</span>${this.seg('intro', [['on', 'On'], ['off', 'Off']], s.matchIntro ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Pre-match ceremony</span>${this.seg('ceremony', [['on', 'On'], ['off', 'Off']], s.ceremony !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Goal celebrations</span>${this.seg('celebs', [['on', 'On'], ['off', 'Off']], s.celebrations !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Celebration camera</span>${this.seg('handheld', [['on', 'Handheld'], ['off', 'Steady']], s.graphics.handheld !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Goal replays</span>${this.seg('replays', [['on', 'On'], ['off', 'Off']], s.goalReplays ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Offside checks</span>${this.seg('varchk', [['on', 'On'], ['off', 'Off']], s.varChecks !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Half-time aerials</span>${this.seg('aerials', [['on', 'On'], ['off', 'Off']], s.aerials !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Half-time highlights</span>${this.seg('hlights', [['on', 'On'], ['off', 'Off']], s.highlights ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Big moments</span>${this.seg('bigm', [['on', 'On'], ['off', 'Off']], s.graphics.bigMoments !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Reduced camera motion</span>${this.seg('reduced', [['off', 'Off'], ['on', 'On']], s.camera.reducedMotion ? 'on' : 'off')}</div>
        <p class="note">These play in matches against the computer, and any button skips them. Pre-match ceremony: mascots walk out holding the players' hands, then the handshake line and both team photos. Goal celebrations: the scorer's knee slide, crest kiss, huddle or cheer, before the replay. Celebration camera Handheld films them from a camera on the operator's shoulder by the touchline (online it cuts to it live after a goal); Steady keeps the shots smooth. Offside checks: the moment is shown again with the offside lines drawn, full screen and on the big screens. Half-time aerials: blimp and drone shots over the ground before the highlights.</p>
      </div>
      <h3>Gameplay and accessibility</h3>
      <div class="stack">
        <div class="row between"><span class="lbl">Mouse control</span>${this.seg('mctl', [['off', 'Off'], ['on', 'On']], s.mouseControl ? 'on' : 'off')}</div>
        <p class="note">Mouse control (PC): your player runs towards the mouse pointer. Left click passes, right click shoots (hold to power up), A plays a long ball, S a through ball, Shift sprints and Space switches player. Change them in Controls, Mouse.</p>
        <div class="row between"><span class="lbl">Auto-switch</span>${this.seg('auto', [['on', 'On'], ['off', 'Off']], s.autoSwitch ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Quick restarts</span>${this.seg('quick', [['on', 'On'], ['off', 'Off']], s.quickRestarts ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Pass receiver</span>${this.seg('recv', [['late', 'Late'], ['early', 'Early']], s.receiver)}</div>
        <div class="row between"><span class="lbl">Pass assistance</span>${this.seg('assist', [['assisted', 'Assisted'], ['semi', 'Semi'], ['manual', 'Manual']], s.passAssist ?? 'assisted')}</div>
        <div class="row between"><span class="lbl">Shot assistance</span>${this.seg('sassist', [['assisted', 'Assisted'], ['manual', 'Manual']], s.shotAssist ?? 'assisted')}</div>
        <p class="note">Manual is for experts: passes go exactly where the stick points and as far as you charge them, with no teammate picked and no help with accuracy. Manual shots go where the stick points too, so you can miss the target.</p>
        <div class="row between"><span class="lbl">Home crowd momentum</span>${this.seg('mom', [['on', 'On'], ['off', 'Off']], s.momentum !== false ? 'on' : 'off')}</div>
        <p class="note">When your side is on top at home (shots, corners, pressure), the crowd lifts your players: they tire a little more slowly and strike the ball a little cleaner. The bar under the score shows who is on top.</p>
        <div class="row between"><span class="lbl">Right-stick switch from</span>${this.seg('sswitch', [['player', 'Your player'], ['ball', 'The ball']], s.stickSwitch ?? 'player')}</div>
        <div class="row between"><span class="lbl">Controller rumble</span>${this.seg('rumble', [['on', 'On'], ['off', 'Off']], s.rumble ? 'on' : 'off')}</div>
        <p class="note">${this.gamepad.index < 0 ? 'Connect a controller to check rumble.' : this.gamepad.canRumble() ? 'This controller and browser support rumble.' : 'This browser does not offer rumble for this controller, so it stays still.'}</p>
        <div class="row between"><span class="lbl">Player ring</span>${this.seg('pring', [['on', 'On'], ['off', 'Off']], s.playerRing ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Next-switch marker</span>${this.seg('nextm', [['on', 'On'], ['off', 'Off']], s.showNextMarker ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Button hints</span>${this.seg('chints', [['on', 'On'], ['off', 'Off']], s.controlHints !== false ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Restart captions</span>${this.seg('rcap', [['on', 'On'], ['off', 'Off']], s.restartCaptions ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">High-contrast markers</span>${this.seg('hc', [['off', 'Off'], ['on', 'On']], s.highContrast ? 'on' : 'off')}</div>
        <div class="row between"><span class="lbl">Colour-blind kits</span>${this.seg('cvd', COLOUR_VISION, s.colourVision ?? 'off')}</div>
        <div class="row between"><span class="lbl">Text size</span>${this.seg('tsize', [['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra large']], s.textSize ?? 'normal')}</div>
        <div class="row between"><span class="lbl">Kick hold time</span>${this.seg('charge', [['normal', 'Normal'], ['slow', 'Longer'], ['slower', 'Longest']], s.chargeSpeed ?? 'normal')}</div>
        <div class="row between"><span class="lbl">Sprint</span>${this.seg('stoggle', [['hold', 'Hold'], ['toggle', 'Toggle']], s.sprintToggle ? 'toggle' : 'hold')}</div>
        <p class="note">Colour-blind kits: when the two sides' kits would be hard to tell apart with red-weak, green-weak or blue-weak colour vision, the computer side changes into its other kit or a plain change kit that stands apart. Text size makes the menus, score, player card and messages bigger. Kick hold time makes the power bar fill more slowly (1.5 or 2 times as long), so there is more time to pick the power. Sprint Toggle: press once to sprint and again (or let go of the stick) to stop.</p>
      </div>
      <h3>App</h3>
      <div class="stack">
        ${(() => { const i = installInfo(); return `
        ${i.canFullscreen ? '<div class="row between"><span class="lbl">Full screen</span><button class="btn small" data-a="fullscreen">Full screen on or off</button></div>' : ''}
        <p class="note">${i.standalone ? 'Running as a home-screen app.' : i.framed
          ? 'Home-screen app: this copy of the game runs inside the claude.ai page, which cannot be installed as an app or work offline (the page keeps that to itself). To get an ELEVENS icon on your iPad home screen that opens full screen and works without a connection, the game needs its own web address: the built game folder can be put on any free static web host, then open it in Safari and choose Share, Add to Home Screen.' + (i.canFullscreen ? '' : ' Full screen is not allowed from inside the claude.ai page either.')
          : `Home-screen app: ${i.ios ? 'in Safari choose Share, then Add to Home Screen' : 'use your browser\'s Install or Add to Home Screen option'} to get an ELEVENS icon that opens full screen. ${i.offline ? 'Offline play is ready: files you have loaded are kept, so matches against the computer work with no connection.' : 'Offline play starts once the game has been opened from its own web address over https.'}`}</p>`; })()}
      </div>
      <p class="note">Tracking slides along the touchline with play; Wide and Panoramic sit higher and further back to show more of the pitch. Broadcast is a fixed TV camera above the halfway line that pans and zooms; movement stays relative to the screen. Match intro flies over the stadium and follows the teams out of the tunnel before kick-off; Goal replays show each goal again from inside the net. Half-time highlights shows the goals, saves, near misses and shots off the woodwork at half-time and full time (the Highlights button on those screens shows them again). Both are for matches against the computer and any button skips them. Big moments shakes the camera for goals, saves and shots off the woodwork, slows play down for a moment after a goal or the woodwork (against the computer), and on Medium and up softens the background in close-ups, replays and goal celebrations; Reduced camera motion turns the shake and slow motion off. Pass receiver Late picks the teammate when you release the button (a longer hold looks further away); Early locks the teammate when you press it, and the hold sets how firm the pass is. Pass assistance Assisted picks the teammate and weighs the pass for you; Semi aims at a teammate near where you point, but the hold alone sets how far the ball goes; Manual sends the ball exactly where you point, as far as the hold says. Right-stick switch: when defending, flick the right stick towards a teammate to take control of them, measured from your player or from the ball. Player ring shows a circle and facing arrow on the grass under your player; the pointer above the head always shows. Quality preset and player changes apply fully at the next kick-off. Players Realistic shows the motion-captured players on every quality, Low included; Classic shows the simple ones, which are a little quicker on old phones.</p>
      <div class="row end"><button class="btn primary" data-a="back">Done</button></div></div>`, overlay ? 'translucent' : '');
    const save = () => {
      saveSettings(s);
      this.audio.apply(s.audio);
      this.renderer?.applyGraphics(s.graphics);
      this.hud.setHighContrast(s.highContrast);
      if (this.session instanceof OfflineSession) { this.session.match.ctrl[0].autoSwitch = s.autoSwitch; this.session.match.ctrl[0].quickRestarts = s.quickRestarts; }
    };
    this.ui.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) => r.addEventListener('input', () => {
      const v = Number(r.value);
      if (r.dataset.r === 'master') s.audio.master = v;
      if (r.dataset.r === 'effects') s.audio.effects = v;
      if (r.dataset.r === 'crowd') s.audio.crowd = v;
      if (r.dataset.r === 'music') s.audio.music = v;
      if (r.dataset.r === 'scale') s.graphics.renderScale = v;
      save();
    }));
    const redraw = () => this.showSettings(back, overlay);
    this.bindSeg('mute', (v) => { s.audio.muted = v === 'on'; save(); redraw(); });
    this.bindSeg('music', (v) => { s.audio.musicOn = v === 'on'; save(); redraw(); });
    this.bindSeg('commentary', (v) => { s.audio.commentary = v === 'on'; save(); redraw(); });
    this.bindSeg('commentator', (v) => { s.commentator = v as 'voice' | 'captions' | 'off'; save(); redraw(); this.commentator.mode = v as 'voice' | 'captions' | 'off'; });
    this.bindSeg('announcer', (v) => { s.audio.announcer = v === 'on'; save(); redraw(); this.syncAnnouncer(); if (!s.audio.announcer) this.announcer.stop(); });
    this.on('[data-a=voicetest]', (b) => {
      this.syncAnnouncer();
      const st = this.ui.querySelector<HTMLElement>('.voice-status');
      if (st) st.textContent = 'Speaking…';
      void this.announcer.test().then((ok) => {
        const el = this.ui.querySelector<HTMLElement>('.voice-status');
        if (el) el.textContent = ok ? `Working (${this.announcer.voiceName}).` : this.voiceStatus();
      });
      void b;
    });
    this.bindSeg('menusfx', (v) => { s.audio.menuSounds = v === 'on'; save(); redraw(); });
    this.bindSeg('preset', (v) => { s.graphics.preset = v as Settings['graphics']['preset']; save(); redraw(); });
    this.bindSeg('autores', (v) => { s.graphics.autoRes = v === 'on'; save(); redraw(); });
    this.bindSeg('showfps', (v) => { s.showFps = v === 'on'; save(); redraw(); });
    this.bindSeg('shadows', (v) => { s.graphics.shadows = v === 'on'; save(); redraw(); });
    this.bindSeg('players', (v) => { s.graphics.players = v as 'realistic' | 'classic'; save(); redraw(); });
    this.bindSeg('matchTime', (v) => { s.graphics.matchTime = v as 'day' | 'dusk' | 'night'; save(); redraw(); });
    this.bindSeg('weather', (v) => { s.graphics.weather = v as 'random' | 'clear' | 'rain' | 'snow'; save(); redraw(); });
    this.bindSeg('wear', (v) => { s.graphics.wear = v === 'on'; save(); redraw(); });
    this.bindSeg('tvgrade', (v) => { s.graphics.tvGrade = v === 'on'; save(); redraw(); });
    this.bindSeg('bigscreen', (v) => { s.graphics.bigScreen = v as 'live' | 'scores'; save(); redraw(); });
    this.bindSeg('mowing', (v) => { s.graphics.mowing = v as MowSetting; save(); redraw(); });
    this.bindSeg('bigm', (v) => { s.graphics.bigMoments = v === 'on'; save(); redraw(); });
    this.bindSeg('wind', (v) => { s.wind = v === 'on'; save(); redraw(); });
    this.bindSeg('menubg', (v) => {
      s.menuBackdrop = v === 'on';
      save();
      if (!s.menuBackdrop) this.backdrop.stop(this.renderer);
      else if (!overlay) this.startBackdrop(this.lastTeams?.teams, this.lastTeams?.kits);
      redraw();
    });
    this.bindSeg('tvg', (v) => { s.tvGraphics = v === 'on'; this.tv.enabled = s.tvGraphics; save(); redraw(); });
    this.bindSeg('cmode', (v) => { s.camera.mode = v as CameraMode; save(); redraw(); });
    this.bindSeg('height', (v) => { s.camera.height = v as Settings['camera']['height']; save(); redraw(); });
    this.bindSeg('zoom', (v) => { s.camera.zoom = v as Settings['camera']['zoom']; save(); redraw(); });
    this.bindSeg('intro', (v) => { s.matchIntro = v === 'on'; save(); redraw(); });
    this.bindSeg('replays', (v) => { s.goalReplays = v === 'on'; save(); redraw(); });
    this.bindSeg('ceremony', (v) => { s.ceremony = v === 'on'; save(); redraw(); });
    this.bindSeg('handheld', (v) => { s.graphics.handheld = v === 'on'; save(); redraw(); });
    this.bindSeg('celebs', (v) => { s.celebrations = v === 'on'; save(); redraw(); });
    this.bindSeg('varchk', (v) => { s.varChecks = v === 'on'; save(); redraw(); });
    this.bindSeg('aerials', (v) => { s.aerials = v === 'on'; save(); redraw(); });
    this.bindSeg('hlights', (v) => { s.highlights = v === 'on'; save(); redraw(); });
    this.bindSeg('reduced', (v) => { s.camera.reducedMotion = v === 'on'; save(); redraw(); });
    this.bindSeg('auto', (v) => { s.autoSwitch = v === 'on'; save(); redraw(); });
    this.bindSeg('mctl', (v) => { this.setMouseControl(v === 'on'); redraw(); });
    this.bindSeg('quick', (v) => { s.quickRestarts = v === 'on'; save(); redraw(); });
    this.bindSeg('assist', (v) => { s.passAssist = v as 'assisted' | 'semi' | 'manual'; this.actions.passAssist = s.passAssist; save(); redraw(); });
    this.bindSeg('sassist', (v) => { s.shotAssist = v as 'assisted' | 'manual'; this.actions.shotAssist = s.shotAssist; save(); redraw(); });
    this.bindSeg('mom', (v) => { s.momentum = v === 'on'; save(); redraw(); });
    this.bindSeg('recv', (v) => { s.receiver = v as 'early' | 'late'; this.actions.receiverMode = s.receiver; save(); redraw(); });
    this.bindSeg('sswitch', (v) => { s.stickSwitch = v as 'player' | 'ball'; this.actions.stickSwitch = s.stickSwitch; save(); redraw(); });
    this.bindSeg('rumble', (v) => { s.rumble = v === 'on'; save(); redraw(); if (s.rumble) this.gamepad.rumble(0.6, 0.6, 180); });
    this.bindSeg('pring', (v) => { s.playerRing = v === 'on'; save(); redraw(); });
    this.bindSeg('nextm', (v) => { s.showNextMarker = v === 'on'; save(); redraw(); });
    this.bindSeg('chints', (v) => { s.controlHints = v === 'on'; save(); redraw(); });
    this.bindSeg('rcap', (v) => { s.restartCaptions = v === 'on'; this.hud.restartCaptions = s.restartCaptions; save(); redraw(); });
    this.bindSeg('hc', (v) => { s.highContrast = v === 'on'; save(); redraw(); });
    this.bindSeg('cvd', (v) => { s.colourVision = v as ColourVision; save(); redraw(); });
    this.bindSeg('tsize', (v) => { s.textSize = v as TextSize; applyTextSize(s.textSize); save(); redraw(); });
    this.bindSeg('charge', (v) => { s.chargeSpeed = v as ChargeSpeed; this.actions.chargeScale = CHARGE_SCALE[s.chargeSpeed]; save(); redraw(); });
    this.bindSeg('stoggle', (v) => { s.sprintToggle = v === 'toggle'; this.actions.sprintToggle = s.sprintToggle; save(); redraw(); });
    this.on('[data-a=fullscreen]', () => { void toggleFullscreen().then(() => setTimeout(() => this.renderer?.resize(), 200)); });
    this.on('[data-a=back]', () => {
      // A new quality preset or player style: rebuild the menu stadium for it (same clubs).
      if (!overlay && this.backdrop.active && `${s.graphics.preset}|${s.graphics.players}` !== this.gfxAtOpen) {
        const t = this.backdrop.teams, k = this.backdrop.kits;
        this.backdrop.stop(this.renderer);
        this.startBackdrop(t ?? undefined, k ?? undefined);
      }
      back();
    });
  }

  /**
   * Controller navigation for menus and in-match overlays: the left stick or D-pad moves a
   * highlight to the nearest button in that direction (held, it repeats), A presses it, B goes
   * back. The highlight is our own class, because Safari (iPad) and Chrome don't show the
   * focus ring for focus moved by script after a touch or click.
   */
  private menuGamepad(now: number) {
    if (this.overlay === 'photo') return;
    this.gamepad.muted = !!this.rebind;
    if (this.rebind) {
      if (this.rebind.device === 'pad') this.padRebind(now);
      else if (now > this.rebind.until + 4000) { this.endRebind(); this.bindMsg = 'No key pressed: cancelled.'; this.redrawControls(); }
      if (this.rebind) return;
    }
    const keyBefore = this.screenName + this.overlay;
    const m = this.gamepad.readMenu();
    const r = { sx: m.sx, sy: m.sy, pass: m.a, lob: m.b };
    const els = Array.from(this.ui.querySelectorAll<HTMLElement>('button:not([disabled]), input, select'))
      .filter((e) => e.offsetParent !== null || e.getClientRects().length > 0);
    if (this.padSel && !els.includes(this.padSel)) {
      // Redrawn (e.g. a Settings option was changed): keep the highlight in the same place.
      const same = this.padNav.key === this.screenName + this.overlay;
      // A new screen can name where the highlight starts (Controls: its first slot).
      this.setPadSel((same && this.padNav.idx >= 0 && this.padNav.idx < els.length ? els[this.padNav.idx] : null) ?? els.find((e) => e.hasAttribute('data-padstart')) ?? null);
    }
    const dir = r.sy > 0.5 ? 'up' : r.sy < -0.5 ? 'down' : r.sx < -0.5 ? 'left' : r.sx > 0.5 ? 'right' : '';
    if (!dir) this.padNav.dir = '';
    else if (dir !== this.padNav.dir || now >= this.padNav.next) {
      this.padNav.next = now + (dir !== this.padNav.dir ? 380 : 140);
      this.padNav.dir = dir;
      if (els.length) this.setPadSel(this.padSel ? nearestIn(els, this.padSel, dir) ?? this.padSel : (els.find((e) => e.hasAttribute('data-padstart')) ?? els.find((e) => e.classList.contains('primary')) ?? els[0]));
    }
    if (r.pass && !this.padNav.prevA) {
      this.audio.unlock(); // a controller press counts as a gesture in some browsers
      if (this.padSel) this.padSel.click();
      else (els.find((e) => e.hasAttribute('data-padstart')) ?? els.find((e) => e.classList.contains('primary')) ?? els[0])?.click();
    }
    if (r.lob && !this.padNav.prevB) this.ui.querySelector<HTMLElement>('[data-a=back]')?.click();
    const key = this.screenName + this.overlay;
    // A press that opened another screen leaves no position to keep there.
    this.padNav.idx = key !== keyBefore ? -1 : this.padSel ? els.indexOf(this.padSel) : -1;
    this.padNav.key = key;
    this.padNav.prevA = r.pass;
    this.padNav.prevB = r.lob;
  }

  private setPadSel(el: HTMLElement | null) {
    if (el && this.padSel && el !== this.padSel && this.padSel.isConnected) this.audio.ui('move');
    this.padSel?.classList.remove('pad-focus');
    this.padSel = el;
    if (!el) return;
    el.classList.add('pad-focus');
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------- online

  private showOnline(code = '') {
    this.screenName = 'online';
    const name = this.settings.name;
    this.set(`<div class="panel narrow">
      <h2>Online match</h2>
      <p class="note">Play one other person. You each control one club; the computer runs your teammates.</p>
      <p class="note server-state">${this.serverStateText()}</p>
      <button class="btn big" data-a="ranked">Ranked match<small class="note"> · climb the divisions</small></button>
      <div class="field"><label for="nm">Your name</label><input id="nm" type="text" maxlength="16" value="${esc(name)}" placeholder="Player" autocomplete="nickname"></div>
      <h3>Create</h3>
      <button class="btn primary" data-a="create">Create private room</button>
      <h3>Join</h3>
      <div class="row"><input id="code" class="code" type="text" maxlength="5" value="${esc(code)}" placeholder="CODE" autocapitalize="characters"><button class="btn" data-a="join">Join room</button></div>
      <p class="err">${esc(this.onlineError)}</p>
      <p class="note net-status"></p>
      <div class="row end"><button class="btn" data-a="back">Back</button></div></div>`);
    const nameEl = this.ui.querySelector<HTMLInputElement>('#nm')!;
    const codeEl = this.ui.querySelector<HTMLInputElement>('#code')!;
    if (serverState() !== 'ready' && serverState() !== 'blocked') void wakeServer();
    const getName = () => { this.settings.name = nameEl.value.trim().slice(0, 16); saveSettings(this.settings); return this.settings.name || 'Player'; };
    this.on('[data-a=create]', () => this.connectAnd(getName(), () => this.net!.send({ t: 'create', name: getName() })));
    this.on('[data-a=ranked]', () => { getName(); this.showRanked(); });
    this.on('[data-a=join]', () => {
      const c = codeEl.value.trim().toUpperCase();
      if (!ROOM_CODE_RE.test(c)) { this.onlineError = 'Room codes are 5 letters/numbers (no 0, O, 1, I or L).'; this.showOnline(c); return; }
      this.connectAnd(getName(), () => this.net!.send({ t: 'join', code: c, name: getName() }));
    });
    this.on('[data-a=back]', () => { this.onlineError = ''; this.net?.close(); this.net = null; history.replaceState(null, '', location.pathname); this.showMode(); });
    if (code && ROOM_CODE_RE.test(code) && !this.net) {
      // Arrived via a shareable link: join straight away.
      this.connectAnd(getName(), () => this.net!.send({ t: 'join', code, name: getName() }));
    }
  }

  /** One line on the Online screen: is the match server awake? */
  private serverStateText(): string {
    const st = serverState();
    const elsewhere = PLAY_URL && !location.href.startsWith(PLAY_URL) && !isLocalHost(location.hostname);
    const link = elsewhere ? ` Online play works at <a href="${PLAY_URL}" target="_blank" rel="noopener">${PLAY_URL.replace(/^https:\/\//, '').replace(/\/$/, '')}</a>.` : '';
    if (st === 'ready') return '<span class="badge ok">Match server ready</span>';
    if (st === 'waking') return '<span class="badge warn">Waking up the match server</span> It sleeps when nobody has played for a while and takes up to a minute to wake.';
    if (st === 'blocked') return `<span class="badge bad">Can't go online from here</span> This page blocks connections to the match server.${link}`;
    if (st === 'unreachable') return `<span class="badge bad">Match server not answering</span> Check your connection, then try again.${link}`;
    return '<span class="badge">Checking the match server…</span>';
  }

  /** Ranked online: division, record, club, the queue and the top players. */
  private showRanked(error = '') {
    this.screenName = 'ranked';
    const connected = this.net?.status === 'connected';
    const status = error || (this.rankQueued ? 'Searching for an opponent of about your level…' : connected ? '' : 'Find a match to connect to the match server.');
    this.set(rankedHtml(this.ranked, status, this.rankQueued, this.rankWaiting, connected), 'scroll');
    const name = () => this.settings.name || 'Player';
    const join = () => {
      this.rankRes = null;
      const { id, key, club, rec, sig } = this.ranked;
      this.net!.send(rec && sig ? { t: 'ranked', id, key, name: name(), club, saved: { rec, sig } } : { t: 'ranked', id, key, name: name(), club });
      this.net!.send({ t: 'board' });
    };
    this.on('[data-rclub]', (el) => { this.ranked.club = el.dataset.rclub!; saveRanked(this.ranked); if (this.rankQueued && this.net) join(); else this.showRanked(); });
    this.on('[data-a=rfind]', () => this.connectAnd(name(), join));
    this.on('[data-a=rcancel]', () => { this.net?.send({ t: 'unranked' }); this.rankQueued = false; this.showRanked(); });
    this.on('[data-a=rback]', () => {
      if (this.rankQueued) this.net?.send({ t: 'unranked' });
      this.rankQueued = false;
      this.net?.close();
      this.net = null;
      this.goingBack = performance.now();
      this.showOnline();
    });
  }

  private setNetStatus(text: string) {
    const el = this.ui.querySelector('.net-status');
    if (el) el.textContent = text;
  }

  private connectAnd(name: string, then: () => void) {
    this.onlineError = '';
    if (this.net && this.net.status === 'connected') { then(); return; }
    this.net?.close();
    const net = new NetClient();
    this.net = net;
    let sentFirst = false;
    net.onStatus = (st) => {
      if (st === 'connecting') this.setNetStatus('Connecting to the match server…');
      if (st === 'waking') this.setNetStatus('Waking up the match server. The first match of the day can take up to a minute…');
      if (st === 'unavailable' || st === 'blocked') {
        this.onlineError = st === 'blocked' ? 'This copy of the game can\'t go online (the page it runs in blocks connections). Use the link below.' : 'Could not reach the match server. Check your connection and try again in a minute.';
        this.net = null;
        if (this.screenName === 'online') this.showOnline();
        if (this.screenName === 'ranked') { this.rankQueued = false; this.showRanked(this.onlineError); }
      }
      if (st === 'reconnecting') { this.setNetStatus('Connection lost. Reconnecting…'); if (this.screenName === 'lobby') this.renderLobby(); }
      if (st === 'disconnected') this.connectionLost('Connection to the server was lost.');
      if (st === 'connected' && this.screenName === 'lobby') this.renderLobby();
    };
    net.onWelcome = (resumed) => {
      if (!sentFirst) { sentFirst = true; if (!resumed) then(); return; }
      if (!resumed && (this.room || this.session)) {
        // We reconnected but the server no longer knows us: it restarted.
        this.connectionLost('The match server restarted, so the room and match were lost.');
        net.resetIdentity();
      }
    };
    net.onRoom = (r) => this.onRoom(r);
    net.onSnapshot = (s, at) => { if (this.session instanceof OnlineSession) this.session.push(s, at); };
    net.onMessage = (m) => this.onServerMsg(m);
    net.connect(name);
  }

  private connectionLost(msg: string) {
    const wasPlaying = !!this.session;
    this.endSession();
    this.onlineError = msg;
    if (this.screenName === 'ranked' || (this.room?.ranked && this.screenName === 'lobby')) { this.rankQueued = false; this.room = null; this.showRanked(msg); return; }
    if (wasPlaying || this.screenName === 'lobby') this.showOnline();
    else if (this.screenName === 'online') this.showOnline();
  }

  private onServerMsg(m: ServerMsg) {
    switch (m.t) {
      case 'err':
        if (m.code === 'rate_limited' || m.code === 'bad_msg') { console.warn('server:', m.msg); return; }
        this.onlineError = m.msg;
        if (this.session || this.screenName === 'lobby') { this.connectionLost(m.msg); return; }
        if (this.screenName === 'online') this.showOnline((this.ui.querySelector<HTMLInputElement>('#code')?.value ?? '').toUpperCase());
        if (this.screenName === 'ranked') { this.rankQueued = false; this.showRanked(m.msg); }
        break;
      case 'rank':
        this.ranked.rec = m.rec;
        if (m.sig) this.ranked.sig = m.sig;
        this.rankQueued = m.queued;
        this.rankWaiting = m.waiting;
        saveRanked(this.ranked);
        if (this.screenName === 'ranked') this.showRanked();
        break;
      case 'board':
        this.ranked.board = m.top;
        saveRanked(this.ranked);
        if (this.screenName === 'ranked') this.showRanked();
        break;
      case 'rankres': {
        this.ranked.rec = m.after;
        if (m.sig) this.ranked.sig = m.sig;
        this.rankRes = m;
        saveRanked(this.ranked);
        const el = this.ui.querySelector('.rank-note');
        if (el) el.innerHTML = rankedResultHtml(m);
        const fv = this.overlay === 'fulltime' ? this.session?.view() : null;
        const head = fv ? this.rankedForfeit(fv) : null;
        const h3 = this.ui.querySelector('.panel h3');
        if (head && h3) h3.textContent = `Full-time · ${head}`;
        break;
      }
      case 'start': {
        this.onlineStart = { side: m.side, teams: m.teams, kits: m.kits, minutes: m.minutes, mentality: m.mentality, weather: m.weather };
        const info = this.onlineStart;
        if (this.session instanceof OnlineSession) this.session.dispose();
        this.loading(`Building ${groundInSentence(groundFor(teamById(info.teams[0])).name)}…`, () => {
          this.backdrop.stop(this.renderer, true);
          const r = this.ensureRenderer();
          r.setupMatch([teamById(info.teams[0]), teamById(info.teams[1])], info.kits, cleanWeather(info.weather));
          this.lastTeams = { teams: [info.teams[0], info.teams[1]], kits: [info.kits[0], info.kits[1]] };
          // Online the server is already counting: no minimum time on the card.
          this.beginSession(new OnlineSession(info, this.net!, this.actions));
        }, this.loadInfo(info.teams as [string, string], info.kits, `Online · ${info.minutes} min`), 1);
        break;
      }
      case 'opp':
        if (this.session instanceof OnlineSession) {
          this.session.oppStatus = m.status === 'disconnected' ? `Opponent reconnecting (${Math.round((m.graceMs ?? 0) / 1000)} s)` : '';
          this.hud.toast(m.status === 'disconnected' ? 'Opponent lost connection. The computer controls their team while they reconnect.' : m.status === 'reconnected' ? 'Opponent reconnected' : 'Opponent left the match', 4000);
        } else if (m.status === 'left' && this.screenName === 'lobby') this.renderLobby();
        break;
      case 'end':
        this.endReason = m.reason;
        if (m.reason !== 'fulltime' && this.session) {
          const v = this.session.view();
          if (v) {
            this.openResults(v);
            const note = this.ui.querySelector('.rematch-note');
            if (note) note.textContent = m.reason === 'abandoned' ? 'Match abandoned: your opponent did not reconnect in time.' : 'Your opponent left the match.';
            this.ui.querySelector('[data-a=rematch]')?.setAttribute('disabled', '');
          }
        }
        break;
      default:
        break;
    }
  }

  /** Ranked: a win awarded because the other player left (the score may say otherwise). */
  private rankedForfeit(v: ViewState): string | null {
    const r = this.rankRes;
    if (!r || !this.room?.ranked || r.after.w <= r.before.w) return null;
    const me = this.room.you;
    return v.score[me] > v.score[1 - me] ? null : `You win · ${r.opp} left the match`;
  }

  private onRoom(r: RoomState) {
    this.room = r;
    if (r.state === 'lobby' || r.state === 'countdown') {
      if (this.session) { this.session.dispose(); this.session = null; this.audio.crowdOff(); this.audio.setMusic(true); this.hud.show(false); this.touch.show(false); }
      this.renderLobby();
    } else if (r.state === 'results' && this.overlay === 'fulltime') {
      const note = this.ui.querySelector('.rematch-note');
      const other = r.seats[1 - r.you];
      if (note && r.rematch[1 - r.you]) note.textContent = 'Your opponent wants a rematch.';
      if (note && !other) note.textContent = 'Your opponent has left.';
    }
  }

  private renderLobby() {
    const r = this.room;
    if (!r) return;
    this.screenName = 'lobby';
    if (r.ranked) {
      const me = r.seats[r.you], other = r.seats[1 - r.you];
      this.set(`<div class="panel narrow"><h2>Ranked match found</h2>
        <div class="grid2">${[me, other].map((s, i) => s ? `<div class="club ${i === 0 ? 'on' : ''}"><span class="abbr">${i === 0 ? 'You' : 'Opponent'}</span><span class="name">${esc(s.name)}</span><span>${esc(teamById(s.club).name)} ${this.kitSwatch(s.club, s.kit)}</span></div>` : '<div class="club"><span class="name">Opponent left</span></div>').join('')}</div>
        <p class="note" style="margin-top:12px">${other ? (r.state === 'countdown' ? `Kick-off in ${Math.ceil(r.countdown / 1000)}…` : 'Getting ready…') : 'Your opponent left before kick-off. No points change.'}</p>
        <div class="row end"><button class="btn" data-a="rleave">${other ? 'Leave (counts as a defeat once play starts)' : 'Back'}</button></div></div>`);
      this.on('[data-a=rleave]', () => { this.net?.send({ t: 'leave' }); this.room = null; this.showRanked(); });
      return;
    }
    const me = r.seats[r.you]!, other = r.seats[1 - r.you];
    const host = r.host === r.you;
    // Keep any ?server= override so the link works when the client and server are hosted apart.
    const q = new URLSearchParams(location.search);
    q.delete('test');
    q.set('room', r.code);
    const link = `${location.origin}${location.pathname}?${q.toString()}`;
    const seat = (s: typeof me | null, label: string) => s
      ? `<div class="club ${s === me ? 'on' : ''}"><span class="abbr">${label}</span><span class="name">${esc(s.name)}</span>
         <span>${esc(teamById(s.club).name)} ${this.kitSwatch(s.club, s.kit)} · ${s.mentality}</span>
         <span>${s.connected ? '<span class="badge ok">Connected</span>' : '<span class="badge bad">Disconnected</span>'} ${s.ready ? '<span class="badge ok">Ready</span>' : '<span class="badge warn">Not ready</span>'}</span></div>`
      : `<div class="club"><span class="abbr">${label}</span><span class="name">Waiting…</span><span class="note">Share the code or link below.</span></div>`;
    const status = this.net?.status === 'reconnecting' ? 'Reconnecting to the server…'
      : r.state === 'countdown' ? `Both ready. Kick-off in ${Math.ceil(r.countdown / 1000)}…`
      : !other ? 'Waiting for an opponent to join.' : !other.connected ? 'Opponent disconnected.' : !me.ready ? 'Press Ready when you are happy with the settings.' : !other.ready ? 'Waiting for your opponent to get ready.' : '';
    this.set(`<div class="panel">
      <div class="row between"><h2>Private room</h2><span class="bigcode">${r.code}</span></div>
      <div class="row"><input type="text" readonly value="${esc(link)}" style="flex:1;min-width:200px;font-size:14px" id="link"><button class="btn small" data-a="copy">Copy link</button></div>
      <div class="grid2" style="margin-top:14px">${seat(r.seats[0], r.you === 0 ? 'You (host)' : 'Host')}${seat(r.seats[1], r.you === 1 ? 'You' : 'Guest')}</div>
      <div class="stack" style="margin-top:14px">
        <div class="row between"><span class="lbl">Club${host ? '' : ' (host chooses)'}</span>${host ? `<button class="btn small" data-a="swap">Swap clubs</button>` : `<span>${esc(teamById(me.club).name)}</span>`}</div>
        <div class="row between"><span class="lbl">Your kit</span>${this.seg('kit', [['home', 'Home'], ['away', 'Away']], me.kit)}</div>
        <div class="row between"><span class="lbl">Your tactics</span>${this.seg('ment', [['defensive', 'Defensive'], ['balanced', 'Balanced'], ['attacking', 'Attacking']], me.mentality)}</div>
        <div class="row between"><span class="lbl">Match length${host ? '' : ' (host chooses)'}</span>${host ? this.seg('min', MATCH.allowedRealMinutes.map((m) => [String(m), `${m} min`]), String(r.minutes)) : `<span>${r.minutes} min</span>`}</div>
      </div>
      <p class="note" style="margin-top:12px">${esc(status)}</p>
      <div class="row end"><button class="btn" data-a="leave">Leave room</button><button class="btn ${me.ready ? '' : 'primary'}" data-a="ready" ${other ? '' : 'disabled'}>${me.ready ? 'Not ready' : 'Ready'}</button></div>
    </div>`);
    const n = this.net!;
    this.on('[data-a=copy]', () => {
      const el = this.ui.querySelector<HTMLInputElement>('#link')!;
      el.select();
      void navigator.clipboard?.writeText(link).then(() => this.hud.toast('Link copied'), () => {});
    });
    this.on('[data-a=swap]', () => n.send({ t: 'lobby', swap: true }));
    this.bindSeg('kit', (v) => n.send({ t: 'lobby', kit: v as 'home' | 'away' }));
    this.bindSeg('ment', (v) => n.send({ t: 'lobby', mentality: v as Mentality }));
    this.bindSeg('min', (v) => n.send({ t: 'lobby', minutes: Number(v) }));
    this.on('[data-a=ready]', () => n.send({ t: 'lobby', ready: !me.ready }));
    this.on('[data-a=leave]', () => { this.net?.close(); this.net = null; this.room = null; history.replaceState(null, '', location.pathname); this.showOnline(); });
  }
}

export { clockText };

/** Adaptive level in words: 1 Pro, 2 Elite, 3 World class, with + for in between. */
const PLAN_NOTES: Record<GamePlan, string> = {
  bus: 'Everyone drops deep and narrow, one player presses, few runs forward.',
  counter: 'Sit a little deeper, keep the forwards high and break quickly when you win it.',
  balanced: 'Your chosen tactics, nothing extra.',
  press: 'Push up and hunt the ball in their half with more players.',
  attack: 'Everyone pushes on and makes runs; it leaves space behind.',
};

function adaptiveName(l: number) {
  const base = l < 1.5 ? 'Pro' : l < 2.5 ? 'Elite' : 'World class';
  const near = l < 1.5 ? 1 : l < 2.5 ? 2 : 3;
  return l - near > 0.15 ? `${base}+` : l - near < -0.15 ? `${base}−` : base;
}


/** The element nearest to `from` in a direction (screen space), favouring ones in line with it. */
export function nearestIn(els: HTMLElement[], from: HTMLElement, dir: 'up' | 'down' | 'left' | 'right'): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bs = Infinity;
  for (const e of els) {
    if (e === from) continue;
    const b = e.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const across = dir === 'up' || dir === 'down' ? dx : dy;
    if (along < 4) continue;
    const score = along + Math.abs(across) * 2.5;
    if (score < bs) { bs = score; best = e; }
  }
  return best;
}

/** Colour band for a rating: poor, average, good, excellent. */
function ratingClass(r: number) { return r >= 8 ? 'r-top' : r >= 7 ? 'r-good' : r >= 6 ? 'r-mid' : 'r-low'; }

/** A player's match in a few words, e.g. "2 goals, 1 assist, 31/36 passes". */
function statLine(r: Rated) {
  const bits: string[] = [];
  const n = (k: number, one: string, many = one + 's') => { if (k) bits.push(`${k} ${k === 1 ? one : many}`); };
  n(r.goals, 'goal'); n(r.assists, 'assist'); n(r.saves, 'save'); n(r.keyPasses, 'chance created', 'chances created');
  n(r.tackles, 'tackle'); n(r.interceptions, 'interception');
  if (r.passes) bits.push(`${r.completed}/${r.passes} passes`);
  if (r.ownGoals) bits.push('own goal');
  return bits.slice(0, 4).join(', ') || `${Math.max(0, (r.to < 0 ? 90 : r.to) - r.from)} minutes`;
}

function ordinal(n: number) { return n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'); }

/** One line on where the competition stands after your match. */
function compSummary(c: Competition): string {
  const me = teamById(c.club).name;
  if (c.champion) return c.champion === c.club ? `${me} win the ${c.kind}!` : `${teamById(c.champion).name} win the ${c.kind}.`;
  if (c.out) return `${me} are out of the cup.`;
  if (c.kind === 'cup') return `${me} are through to the ${(cupRounds(c)[c.round] ?? 'final').toLowerCase()}.`;
  const pos = leagueTable(c).findIndex((r) => r.id === c.club) + 1;
  return `${me} are ${ordinal(pos)} in the league after ${c.round} of ${c.rounds.length} rounds.`;
}

/** Colours offered in the club creator. */
const PALETTE = [0xf4f4f4, 0xc0c4cc, 0x141414, 0x2b2f38, 0xc8102e, 0x7a1f3d, 0xe8742a, 0xf2c14e, 0xf2d21b, 0x1f9d55, 0x165a36, 0x0f8b8d, 0x7ec8e3, 0x2f6fde, 0x123a8c, 0x5b2a86, 0x8e6cc9, 0xe85d9c, 0x6b3e26, 0xb4642d];

/** Shirt numbers in white or black, whichever reads better. */
function readableInk(c: number) {
  const lum = 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
  return lum > 150 ? 0x111111 : 0xffffff;
}

/** A keeper colour that stands out from the outfield kit. */
function keeperColour(shirt: number, shorts: number) {
  const opts = [0x1f9d55, 0xf2b705, 0x7b3fe4, 0xe23d28, 0x2b2d33, 0xe85d9c];
  const d = (a: number, b: number) => Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
  return opts.reduce((best, o) => (Math.min(d(o, shirt), d(o, shorts)) > Math.min(d(best, shirt), d(best, shorts)) ? o : best), opts[0]);
}

/** Three-letter short name from a club name ("Riverside Athletic" -> "RAT", "Gullford" -> "GUL"). */
function abbrOf(name: string) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return 'NEW';
  if (words.length === 1) return words[0].slice(0, 3).padEnd(3, 'X');
  if (words.length === 2) return (words[0].slice(0, 2) + words[1][0]).slice(0, 3);
  return words.slice(0, 3).map((w) => w[0]).join('');
}

const NAME_A = ['Ash', 'Bright', 'Cold', 'Elder', 'Fern', 'Glen', 'Hollow', 'Iron', 'Kings', 'Lark', 'Marsh', 'North', 'Oak', 'Raven', 'Silver', 'Stone', 'West', 'Wolf', 'Black', 'Red'];
const NAME_B = ['ford', 'water', 'brook', 'field', 'haven', 'ridge', 'wick', 'stead', 'mouth', 'cliffe', 'bury', 'dale', 'gate', 'moor', 'port', 'vale'];
const NAME_C = ['United', 'Athletic', 'Rovers', 'Town', 'City', 'Wanderers', 'Albion', 'FC', 'Rangers', 'Harriers', 'Dynamo', 'Sporting'];
/** A made-up club name (the club creator's Random name). */
function randomClubName() {
  const r = (a: string[]) => a[Math.floor(Math.random() * a.length)];
  return `${r(NAME_A)}${r(NAME_B)} ${r(NAME_C)}`;
}
