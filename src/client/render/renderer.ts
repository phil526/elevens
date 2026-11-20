// Scene owner: renderer, lights, stadium, players, ball and on-pitch markers.

import { MatchExtras } from './medics';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BALL } from '../../shared/config';
import type { Kit, PlayerDef, TeamDef } from '../../shared/teams';
import { bootColour, captainIndex, playerBuild } from './look';
import { hairStyleFor } from './hair';
import { groundFor } from '../../shared/grounds';
import { setKitClub } from './badgetex';
import { ClubFlags, CornerFlags, flagWind } from './clubflags';
import { ALL_CLUBS } from '../../shared/teams';

/** The ground to build: the home club's, or another club's on test pages (?ground=kingsmere). */
function groundTeam(home: TeamDef): TeamDef {
  const id = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('ground') : null;
  return (id && ALL_CLUBS.find((t) => t.id === id)) || home;
}
import type { ViewState } from '../view';
import { BroadcastCamera, type CameraSettings } from './camera';
import { TunnelSet, tunnelOf, type CineShot, type TunnelInfo } from './cinematic';
import { kitMaterials, PlayerModel } from './player';
import { loadPlayerAssets, RealPlayerModel, type PlayerAssets } from './realplayer';
import { buildStadium } from './stadium';
import { Sky } from './sky';
import { toneMappingFor } from './tvgrade';
import { Breath, coldFor } from './breath';
import { Pitchside } from './pitchside';
import { Managers } from './managers';
import { Touchline } from './touchline';
import { Officials, type OfficialStage } from './officials';
import { Mascots, type MascotMode } from './mascots';
import { Blimp } from './blimp';
import { VAR, VarLines, drawVarPage, type VarInfo } from './var';
import { BigScreenFeed } from './bigscreen';
import { Ceremony } from './ceremony';
import { GrassBlades } from './grassblades';
import { updateCrowd } from './crowd';
import type { Arena } from './arena';
import { canvasTex } from './textures';
import { ballMaterial, BallSpin } from './ball';
import { ReactionDirector } from './reactions';
import { GlCheck } from './glcheck';
import { INJURY } from '../../shared/injury';
import { firstTouchFor, makeGesture, tirednessFor } from './motion';
import { possessionTeam } from '../view';
import { AutoRes } from './autores';
import { CrowdMoments } from './crowdlife';
import type { MatchEvent } from '../../shared/types';
import { KitWear, PitchWear, playedShare } from './wear';
import { LiteDof } from './dof';
import { Handheld, HANDHELD, pitchsideShot } from './handheld';
import { FanDisplay } from './tifo';
import { FlareSmoke } from './smoke';
import { PitchMarks } from './marks';
import { WetReflection } from './wet';
import { bankOrder, FloodHaze, litShare } from './haze';
import { rollWeather, weatherLook, WeatherFx, type Weather, type WeatherSetting } from './weather';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import type { MatchWeather } from '../../shared/weather';
import { BallTrail, CrossShadows, FloodGlare, glowTexture, GradeShader, LOOKS, type MatchTime, NetPanel, Particles, type GrassUniforms, MOW_PATTERNS, type MowPattern, type MowSetting } from './vfx';

const BALL_DRAW_SCALE = 1.6;

/**
 * Points along the floodlight ring that give off lens glare: every fourth lamp bank of the main
 * lamp mesh (the banks are quads, 4 vertices each), so about a dozen round the bowl.
 */
function glarePoints(stadium: THREE.Object3D): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  stadium.updateMatrixWorld(true);
  stadium.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (typeof o.userData.lamp !== 'number' || o.userData.lamp < 0.58 || !mesh.geometry) return;
    const a = mesh.geometry.getAttribute('position');
    for (let i = 0; i + 3 < a.count; i += 16) {
      const c = new THREE.Vector3();
      for (let k = 0; k < 4; k++) c.add(new THREE.Vector3(a.getX(i + k), a.getY(i + k), a.getZ(i + k)));
      out.push(c.multiplyScalar(0.25).applyMatrix4(mesh.matrixWorld));
    }
  });
  return out;
}

export interface GraphicsSettings {
  preset: 'low' | 'medium' | 'high' | 'ultra';
  renderScale: number; // 0.5..1.5 (above 1 renders more pixels than the screen, then downsamples)
  shadows: boolean;
  /** Player bodies: generated, motion-captured models or the lightweight procedural ones (Classic). */
  players?: 'realistic' | 'classic';
  /** Mowing pattern cut into the grass; Random picks one each match (render/vfx.ts MOW_GLSL). */
  mowing?: MowSetting;
  /** Lighting look: daylight, low sun with floodlights coming on, or a floodlit night match. */
  matchTime?: MatchTime;
  /** Rain, snow or clear skies; Random picks one for each match (render/weather.ts). */
  weather?: WeatherSetting;
  /** Auto resolution: draw slightly fewer pixels while the frame rate is dropping, and go back up when it recovers (default on). */
  autoRes?: boolean;
  /** Pitch wear and mud, muddy and sweaty kits building up over the match (default on). */
  wear?: boolean;
  /** TV colour grade: softer shadows, broadcast colour and (High and Ultra) a soft glow (default on). */
  tvGrade?: boolean;
  /** Big screens: live pictures and goal replays (Medium and up), or the score pages only. */
  bigScreen?: 'live' | 'scores';
  /** Big moments: camera shake, a moment of slow motion on goals and the woodwork, and depth of field in replays and celebrations (default on). */
  bigMoments?: boolean;
  /** Celebration camera: a handheld pitchside camera for goal celebrations (default), or steady shots. */
  handheld?: boolean;
}

export { AUTO_RES_MIN } from './autores';

/** Realistic (motion-captured) players on every quality, Low included (phones need them too, 20 Nov), unless Players is Classic. */
export const realisticPlayers = (g: GraphicsSettings) => g.players !== 'classic';

export interface MarkerInfo {
  localTeams: number[]; // teams controlled on this device
  receiver: number; // intended receiver hint, -1 none
  showNext: boolean;
  /**
   * Local multiplayer: the marker style (0 P1 .. 3 P4, -1 none) for each human, indexed team * 2 + slot
   * (slot 1 = the co-op second human). Default: home P1, away P2.
   */
  slotStyle?: number[];
  /** Ring and facing arrow on the grass under the controlled player (the pointer above the head always shows). */
  playerRing?: boolean;
  highContrast: boolean;
  /** Photo mode: no pointers, rings or hints at all. */
  hideMarkers?: boolean;
}

export interface DebugDraw {
  targets?: { x: number; z: number; team: number }[];
  formation?: { x: number; z: number; team: number }[];
  shapes?: boolean;
}

const QUALITY = { low: 0, medium: 1, high: 2, ultra: 3 } as const;
const DPR_CAP = { low: 1, medium: 1.5, high: 2, ultra: 2.5 } as const;
const MAX_DPR = 3;
/** On Low, realistic players further than this from the camera (m) don't plant their feet. */
const LITE_IK_DIST = 32;

function markerSprite(shape: 'triangle' | 'diamond', colour: string, label: string) {
  const tex = canvasTex(128, 128, (g) => {
    g.fillStyle = colour;
    g.strokeStyle = '#0b0f14';
    g.lineWidth = 6;
    g.beginPath();
    if (shape === 'triangle') { g.moveTo(24, 22); g.lineTo(104, 22); g.lineTo(64, 78); }
    else { g.moveTo(64, 10); g.lineTo(100, 48); g.lineTo(64, 86); g.lineTo(28, 48); }
    g.closePath();
    g.stroke();
    g.fill();
    g.font = '900 34px system-ui, Arial, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 6;
    g.strokeText(label, 64, 118);
    g.fillText(label, 64, 118);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.3, 1.3, 1);
  s.renderOrder = 10;
  return s;
}

/** Speech bubble with a "!" over a teammate calling for the ball. */
function callSprite() {
  const tex = canvasTex(128, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#0b0f14';
    g.lineWidth = 7;
    g.beginPath();
    g.roundRect(14, 10, 100, 80, 26);
    g.moveTo(52, 88); g.lineTo(64, 116); g.lineTo(76, 88);
    g.closePath();
    g.stroke();
    g.fill();
    g.fillStyle = '#0b0f14';
    g.font = '900 64px system-ui, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('!', 64, 52);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, opacity: 0.92 }));
  s.renderOrder = 9;
  return s;
}

function ring(inner: number, outer: number, colour: number, opacity: number, theta = Math.PI * 2) {
  const g = new THREE.RingGeometry(inner, outer, 40, 1, 0, theta);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false }));
  m.renderOrder = 2;
  return m;
}

/** Dots in the free-kick bend line. */
const FK_DOTS = 22;

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: BroadcastCamera;
  private players: (PlayerModel | RealPlayerModel)[] = [];
  private playerAssets: PlayerAssets | null = null;
  private playersReal = false;
  /** The squad entry each model was built for: a substitution swaps the model (shirt number, skin, hair). */
  private modelDefs: PlayerDef[] = [];
  private matchArgs: [[TeamDef, TeamDef], ['home' | 'away', 'home' | 'away']] | null = null;
  private ball!: THREE.Mesh;
  private ballShadow!: THREE.Mesh;
  private stadium: THREE.Group | null = null;
  // Supporters' excitement (home, away) and time left celebrating a goal.
  viewOverride: { pos: [number, number, number]; look: [number, number, number] } | null = null;
  /** Cinematic camera (match intro, goal replay): replaces the match camera while set. */
  cine: CineShot | null = null;
  private cineOn = false;
  private tunnelSet = new TunnelSet();
  private crowdE: [number, number] = [0.1, 0.1];
  private cheerT: [number, number] = [0, 0];
  private lastScore: [number, number] | null = null;
  private sun!: THREE.DirectionalLight;
  private markers: { ring: THREE.Mesh; arrow: THREE.Mesh; sprite: THREE.Sprite }[] = [];
  private nextRing!: THREE.Mesh;
  /** A ring that bursts out from the player you have just switched to (20 Nov 2026). */
  private flashRing!: THREE.Mesh;
  private flash = { id: -1, t: 99 };
  /** Bubbles over teammates calling for the ball. */
  private callBubbles: THREE.Sprite[] = [];
  private recvRing!: THREE.Mesh;
  private holdRing!: THREE.Mesh;
  private aimRing!: THREE.Mesh;
  private aimDot!: THREE.Mesh;
  /** Direct free kick: dotted line showing the bend and dip the taker has chosen (19 Nov 2026). */
  private fkLine: THREE.Points | null = null;
  private blobs: THREE.Mesh[] = [];
  private liteFrustum = new THREE.Frustum();
  private liteMat = new THREE.Matrix4();
  /** Round a player, generous so a turning or diving player at the edge of the picture is never caught frozen. */
  private liteSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  private debugGroup = new THREE.Group();
  private ballSpinner = new BallSpin();
  private ballQ = new THREE.Quaternion();
  private time = 0;
  private gfx: GraphicsSettings;
  private builtFor = '';
  // High and Ultra: multisampled HDR target, subtle bloom on floodlights and highlights, image-based light.
  private composer: EffectComposer | null = null;
  /** Watches for draws the browser refuses and steps down to simpler drawing (render/glcheck.ts). */
  private glCheck!: GlCheck;
  private bloom: UnrealBloomPass | null = null;
  private envMap: THREE.Texture | null = null;
  private grade: ShaderPass | null = null;
  private hemi!: THREE.HemisphereLight;
  /** Sky dome: gradient, drifting clouds, the setting sun at dusk, stars and the moon at night. */
  private sky = new Sky();
  private lookFor = '';
  // Effects layered on the stadium: goal-net cloth, ball trail, turf particles, floodlight shadows and glows.
  private nets: NetPanel[] = [];
  private trail = new BallTrail();
  private particles = new Particles();
  /** Breath on cold nights (snow, or a night match). */
  private breath = new Breath();
  /** Ball kids, photographers and stewards; the two managers. */
  private pitchside: Pitchside | null = null;
  private managers: Managers | null = null;
  /** Physios and stretcher, skill-game targets (render/medics.ts). */
  private extras = new MatchExtras();
  /** The fourth official with his board, and the substitutes warming up. */
  touchline: Touchline | null = null;
  /** The referee and his assistants on the pitch (render/officials.ts). */
  officials: Officials | null = null;
  /** Set by the intro each frame: where the officials stand (null: the match itself). */
  officialStage: OfficialStage | null = null;
  /** Mascots for the walk-out and line-up (set by the intro each frame; null builds none / throws them away). */
  mascotMode: MascotMode | null = null;
  mascots: Mascots | null = null;
  /** The airship circling over the ground (Medium and up). */
  blimp: Blimp | null = null;
  /** Offside lines for the VAR replay, and the check on the big screens. */
  readonly varLines = new VarLines();
  private varScreen: { info: VarInfo; until: number } | null = null;
  /** The big screens' live pictures and goal replays (render/bigscreen.ts). */
  feed: BigScreenFeed | null = null;
  private feedHide: THREE.Object3D[] = [];
  private feedHideFor: Arena | null = null;
  private feedHideQ = -1;
  /** The trophy ceremony (render/ceremony.ts), while one plays; client/cine.ts directs it. */
  ceremony: Ceremony | null = null;
  /** Players' reactions keep playing during this cinematic (the trophy ceremony stages its own). */
  cineReactions = false;
  private ceremonyLift = 0;
  private ceremonyCaptain = -1;
  private chaseK = [0, 0];
  private flashT = 0;
  private flashKind: 'save' | 'close' = 'save';
  private mouthY: number[] = [];
  private cross: CrossShadows | null = null;
  private halos: THREE.Sprite[] = [];
  private lamps: { m: THREE.MeshBasicMaterial; k: number }[] = [];
  private grassU: GrassUniforms | null = null;
  /** Grass blades for close shots (Medium and up). */
  private blades: GrassBlades | null = null;
  /** This match's mowing pattern. */
  mowPattern: MowPattern = 'stripes';
  private ballRoot = new THREE.Group();
  private sprayAcc = 0;
  /** This match's weather and its rain or snow. */
  private weatherFx = new WeatherFx();
  private weatherFor = '';
  /** Players' reactions after the whistle (arms out, hands on heads, high fives). */
  reactions = new ReactionDirector();
  /** Flags, scarves, clapping, hands on heads and the Mexican wave. */
  crowd = new CrowdMoments();
  private prevBallV = new THREE.Vector3();
  private prevBallP = new THREE.Vector3();
  /** Pixel ratio from the quality preset and render scale, before auto resolution. */
  private baseDpr = 1;
  /** Auto resolution: the share of baseDpr being drawn. */
  private dyn = new AutoRes();
  /** Turf worn and churned to mud where play goes, and kits getting muddy and sweaty. */
  readonly pitchWear = new PitchWear();
  readonly kitWear = new KitWear();
  /** Footprints and slide tracks in snow and mud, torn turf and divots (render/marks.ts). */
  readonly marks = new PitchMarks();
  /** The wet pitch's mirror image (High and Ultra, in the rain). */
  readonly wet = new WetReflection();
  /** How strongly the wet pitch mirrors (tuning and tests). */
  reflGain = 1.6;
  private lastView: ViewState | null = null;
  /** Lens glare from the floodlights (dusk and night). */
  private glare = new FloodGlare();
  private glareK = 0;
  /** Beams of light through the night air from the floodlight banks (render/haze.ts). */
  private haze = new FloodHaze();
  /** Fan display across the home end before kick-off, and smoke from the flares. */
  readonly tifo = new FanDisplay();
  readonly smoke = new FlareSmoke();
  private flarePos: THREE.Vector3[] = [];
  private hazeK = 0;
  /**
   * Floodlights coming on in the match intro: 0 (all off) .. 1 (all on). The intro (client/cine.ts)
   * sets it each frame; outside a cinematic the lights are always on.
   */
  lightsOn = 1;
  private litNow = 1;
  /** A floodlight bank has just come on (pan -1 left .. 1 right), for its clunk. */
  onFloodlight: ((pan: number) => void) | null = null;
  private lampU = { uLampOn: { value: 1 }, uLampOff: { value: new THREE.Color(0x5d6168) } };
  /** Camera shake: decays from 1 (a goal) to 0; random but smooth. */
  private trauma = 0;
  private shakeSeed = Math.random() * 100;
  /** Depth of field (High and Ultra): soft background in replays and goal celebrations. */
  private bokeh: BokehPass | null = null;
  /** Depth of field on Medium (no composer there), and where it is focused this frame. */
  readonly liteDof = new LiteDof();
  private dofFocus = 10;
  /** Handheld celebration camera: the operator's wobble, and the live pitchside shot after a goal. */
  readonly handheld = new Handheld();
  /** Set by the app where the celebration cinematic doesn't play (online): a live pitchside shot after a goal. */
  liveHandheld = false;
  private liveCam: CineShot | null = null;
  private liveState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), on: false };
  private goalT = 0;
  private goalTeam = -1;
  private dofW = 0;
  /** Flags on the roof in the home club's colours, and the spring-mounted corner flags. */
  private clubFlags: ClubFlags | null = null;
  cornerFlags: CornerFlags | null = null;

  constructor(private canvas: HTMLCanvasElement, gfx: GraphicsSettings) {
    this.gfx = gfx;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: gfx.preset !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // Count every pass of a frame (shadows, scene, post-processing) in the debug figures.
    this.renderer.info.autoReset = false;
    this.glCheck = new GlCheck(this.renderer, canvas);
    this.camera = new BroadcastCamera(1);
    this.scene.fog = new THREE.Fog(0x27486f, 160, 420);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2f4a2a, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.position.set(-40, 80, 50);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.sky.mesh);
    this.scene.add(this.trail.mesh, this.particles.points, this.breath.points, this.ballRoot, this.weatherFx.group, this.glare.group, this.marks.divots, this.haze.mesh, this.smoke.mesh);
    this.scene.add(this.debugGroup);
    this.scene.add(this.extras.group);
    this.applyGraphics(gfx);
    WetReflection.show(this.sky.mesh);
    // Footsteps splash in the rain and kick up powder in the snow (Medium and up).
    this.marks.onStep = (x, z, sp) => {
      if (sp < 4.5 || QUALITY[this.gfx.preset] < 1 || this.weather === 'clear' || Math.random() > 0.55) return;
      this.particles.spray(x, z, 0, 0, this.weather === 'snow' ? 0.02 : 0.04 + sp * 0.006, this.weather === 'snow');
    };
  }

  /** Fetch the realistic players if they're wanted and not here yet (again after a failed attempt). */
  private wantPlayers() {
    if (!realisticPlayers(this.gfx) || this.playerAssets || this.playersWaiting) return;
    this.playersWaiting = true;
    void loadPlayerAssets().then((a) => {
      this.playersWaiting = false;
      if (!a) return;
      this.playerAssets = a;
      // Swap the procedural stand-ins for the realistic bodies as soon as they arrive.
      if (this.matchArgs && realisticPlayers(this.gfx) && !this.playersReal) this.buildPlayers(...this.matchArgs);
    });
  }
  private playersWaiting = false;

  applyGraphics(gfx: GraphicsSettings) {
    this.gfx = gfx;
    this.wantPlayers();
    const q = QUALITY[gfx.preset];
    const scale = q >= 3 ? gfx.renderScale : Math.min(1, gfx.renderScale);
    this.baseDpr = Math.min(MAX_DPR, Math.min(window.devicePixelRatio || 1, DPR_CAP[gfx.preset]) * scale);
    if (gfx.autoRes === false) this.dyn.reset();
    this.renderer.setPixelRatio(this.baseDpr * this.dyn.scale);
    // Safe level 1 and up: no shadows (the graphics check saw this browser refuse draws).
    const shadows = gfx.shadows && q > 0 && this.glCheck.level < 1;
    this.renderer.shadowMap.enabled = shadows;
    // Always PCF. three r186 dropped PCFSoftShadowMap: it switches to PCF only when the shadows are
    // drawn, after the materials were built for "soft", which sample the shadow map the wrong way.
    // Chrome on Windows (Direct3D) then refuses those draws and the pitch, stands and players were
    // black (20 Nov 2026); other systems happened to let it through.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = shadows;
    const size = q >= 3 ? 4096 : q > 1 ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      this.sun.shadow.mapSize.set(size, size);
    }
    // At High and above the shadow frustum follows play, so the same map covers less ground at more detail.
    const half = q > 1 ? 42 : 70;
    const sc = this.sun.shadow.camera;
    sc.left = -half; sc.right = half; sc.top = half * 0.75; sc.bottom = -half * 0.75; sc.near = 10; sc.far = 220;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    const tv = gfx.tvGrade !== false;
    // The TV look softens shadow edges too.
    this.sun.shadow.radius = (q >= 3 ? 3 : 2) + (tv ? 1.5 : 0);
    const tm = toneMappingFor(tv);
    if (this.renderer.toneMapping !== tm) {
      this.renderer.toneMapping = tm;
      // Every material picks up the new tone mapping on its next compile.
      this.scene.traverse((o) => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true; });
    }
    for (const b of this.blobs) b.visible = !shadows;
    for (const p of [...this.players, ...(this.managers?.models ?? []), ...(this.touchline?.models ?? []), ...(this.officials?.models ?? [])]) for (const m of p.meshes) m.castShadow = shadows;
    if (this.ball) this.ball.castShadow = shadows;
    // Image-based lighting gives kits, posts and the ball soft reflections.
    if (q >= 2 && !this.envMap) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envMap = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    this.scene.environment = q >= 2 ? this.envMap : null;
    this.scene.environmentIntensity = 0.22;
    this.setupPost(this.glCheck.level >= 2 ? 0 : q);
    this.sky.setQuality(q);
    this.marks.setQuality(q);
    this.wet.setQuality(q);
    this.lookFor = '';
    this.applyLook();
    this.resize();
  }

  private matchTime(): MatchTime {
    return this.gfx.matchTime ?? 'dusk';
  }

  /** Sky, lights, floodlights, bloom and grade for the chosen match time. */
  private applyLook() {
    const t = this.matchTime();
    const key = `${t}|${this.builtFor}|${!!this.composer}|${this.weather}|${this.gfx.tvGrade !== false}`;
    if (key === this.lookFor) return;
    this.lookFor = key;
    const L = weatherLook(LOOKS[t], this.weather);
    this.sky.setLook(L, t, this.weather);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(L.fog); fog.near = L.fogNear; fog.far = L.fogFar;
    this.hemi.color.setHex(L.hemiSky); this.hemi.groundColor.setHex(L.hemiGround); this.hemi.intensity = L.hemi;
    this.sun.color.setHex(L.sun); this.sun.intensity = L.sunI;
    this.sun.position.set(...L.sunPos);
    this.sun.target.position.set(0, 0, 0);
    this.renderer.toneMappingExposure = L.exposure;
    this.scene.environmentIntensity = L.env;
    for (const { m, k } of this.lamps) {
      // Lamps above 1.0 are picked up by bloom on High and Ultra.
      const on = L.lamps > 0 ? Math.max(1, L.lamps * k) : 0;
      m.color.setHex(on ? 0xfff6e2 : 0x5d6168).multiplyScalar(on || 1);
    }
    for (const h of this.halos) { (h.material as THREE.SpriteMaterial).opacity = L.halo * (this.composer ? 0.6 : 1); h.visible = L.halo > 0; }
    // TV look: a soft glow round bright kits, lines and the sky as well as the lamps.
    const tvg = this.gfx.tvGrade !== false;
    if (this.bloom) { this.bloom.strength = L.bloom + (tvg ? 0.07 : 0); this.bloom.threshold = tvg ? 0.92 : 1.1; }
    // Rain on the lens spreads the glare.
    this.glareK = L.glare * (this.weather === 'rain' ? 1.3 : 1);
    // Haze in the floodlights: a night match most, dusk a little; rain and snow catch the light.
    this.hazeK = L.lamps > 0 ? (t === 'night' ? 0.35 : 0.12) * (this.weather === 'rain' ? 1.8 : this.weather === 'snow' ? 1.4 : 1) * (this.composer ? 1 : 1.15) : 0;
    this.litNow = -1;
    // Flare smoke takes the scene's light: bright grey by day, floodlit grey at dusk and night.
    const sl = t === 'day' ? 0.86 : t === 'dusk' ? 0.62 : 0.5;
    this.smoke.setLight(new THREE.Color(sl, sl * 0.98, sl * 1.02).multiplyScalar(this.weather === 'rain' ? 0.85 : 1));
    if (this.grade) {
      const u = this.grade.uniforms;
      u.uLift.value.set(...L.grade.lift); u.uGain.value.set(...L.grade.gain);
      u.uSat.value = L.grade.sat; u.uContrast.value = L.grade.contrast; u.uVignette.value = L.grade.vignette;
    }
    if (this.grassU) {
      this.grassU.uPool.value = L.pool;
      // Floodlights mirrored in a wet pitch: strongest at night, none in daylight.
      if (this.grassU.uGlint) this.grassU.uGlint.value = Math.min(1, L.lamps / 4);
    }
    this.litNow = -1;
    this.applyLit(this.lightsOn);
  }

  /**
   * Give a floodlight mesh its banks: each vertex knows when its bank comes on in the intro
   * (render/haze.ts bankOrder), and the material shows it off (grey) until then, with a brief
   * flare as it strikes up.
   */
  private bankLamps(mesh: THREE.Mesh) {
    const g = mesh.geometry;
    if (!g.getAttribute('aBank')) {
      const pos = g.getAttribute('position');
      const a = new Float32Array(pos.count), v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); a[i] = bankOrder(v.x, v.z); }
      g.setAttribute('aBank', new THREE.BufferAttribute(a, 1));
    }
    const m = mesh.material as THREE.MeshBasicMaterial;
    if (m.userData.banked) return;
    m.userData.banked = true;
    const u = this.lampU;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uLampOn = u.uLampOn;
      sh.uniforms.uLampOff = u.uLampOff;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aBank;\nvarying float vBank;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBank = aBank;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vBank;\nuniform float uLampOn;\nuniform vec3 uLampOff;')
        .replace('#include <map_fragment>', `#include <map_fragment>
  if (vBank > uLampOn) diffuseColor.rgb = uLampOff;
  else if (uLampOn < 0.999) diffuseColor.rgb *= 1.0 + 0.9 * (1.0 - smoothstep(0.0, 0.05, uLampOn - vBank));`);
    };
    m.customProgramCacheKey = () => 'lamp-banks';
    m.needsUpdate = true;
  }

  /**
   * Light from the floodlights for the share of banks on (1 outside the intro): the floodlit key
   * light, sky light, light pools, the faint shadows, halos and glare all come up bank by bank.
   */
  private applyLit(on: number) {
    const t = this.matchTime();
    const L = weatherLook(LOOKS[t], this.weather);
    const lit = L.lamps > 0 ? litShare(on) : 1;
    if (lit === this.litNow && on >= 1) return;
    const was = this.litNow;
    this.litNow = lit;
    const night = t === 'night';
    this.sun.intensity = L.sunI * (night ? 0.1 + 0.9 * lit : 0.6 + 0.4 * lit);
    this.hemi.intensity = L.hemi * (night ? 0.45 + 0.55 * lit : 0.8 + 0.2 * lit);
    this.lampU.uLampOn.value = L.lamps > 0 ? on : 1;
    this.lampU.uLampOff.value.setHex(0x5d6168);
    if (this.grassU) this.grassU.uPool.value = L.pool * lit;
    for (const h of this.halos) {
      const k = bankOrder(h.position.x, h.position.z) <= on ? 1 : 0;
      (h.material as THREE.SpriteMaterial).opacity = L.halo * (this.composer ? 0.6 : 1) * k;
      h.visible = L.halo > 0 && k > 0;
    }
    // A bank coming on: its clunk, panned towards it.
    if (was >= 0 && lit > was && lit < 1.001 && this.onFloodlight) {
      const a = (lit - 1 / 16) * 8;
      const seq = [0, 4, 2, 6, 1, 5, 3, 7];
      const sector = seq[Math.max(0, Math.min(7, Math.round(a) - 1))];
      const ang = -Math.PI + (sector + 0.5) * (Math.PI / 4);
      const p = new THREE.Vector3(Math.cos(ang) * 60, 40, Math.sin(ang) * 45).project(this.camera.cam);
      this.onFloodlight(Math.max(-1, Math.min(1, p.x)));
    }
  }

  /** The weather for this match ('clear' until a match is set up). */
  get weather(): Weather {
    return this.weatherFx.weather;
  }

  /**
   * Build this match's rain or snow. The match decides its weather (it changes how the ball plays);
   * without one (older callers) the graphics setting picks, Random rolling a new one each match.
   */
  private chooseWeather(mw?: MatchWeather) {
    let w: Weather;
    if (mw) w = mw.kind;
    else {
      const set = this.gfx.weather ?? 'random';
      const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
      const forced = params.get('weather');
      // Test pages keep clear skies unless they ask (&weather=rain), so screenshots stay comparable.
      w = forced === 'rain' || forced === 'snow' || forced === 'clear' ? forced : set !== 'random' ? set : params.has('test') ? 'clear' : rollWeather();
    }
    const key = `${w}|${this.gfx.preset}`;
    if (key !== this.weatherFor) {
      this.weatherFor = key;
      this.weatherFx.setup(w, QUALITY[this.gfx.preset]);
      this.resize();
      this.lookFor = '';
    }
    const wind = mw?.wind ?? 0, a = mw?.windDir ?? 0;
    this.weatherFx.setWind(wind * Math.cos(a), wind * Math.sin(a));
  }

  private setupPost(q: number) {
    if (q !== 1) this.liteDof.dispose();
    if (q < 2) {
      this.composer?.dispose();
      this.composer = null;
      this.bloom = null;
      this.grade = null;
      this.bokeh = null;
      return;
    }
    if (this.composer) return;
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera.cam));
    // Off (no cost) except in replays and celebrations, when it renders a depth pass and blurs.
    this.bokeh = new BokehPass(this.scene, this.camera.cam, { focus: 40, aperture: 0.00012, maxblur: 0.008 });
    this.bokeh.enabled = false;
    this.composer.addPass(this.bokeh);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.16, 0.4, 1.1);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    if (this.grade) this.grade.uniforms.uAspect.value = w / Math.max(1, h);
    this.particles.setScale(h * this.renderer.getPixelRatio(), this.camera.cam.fov);
    this.breath.parts.setScale(h * this.renderer.getPixelRatio(), this.camera.cam.fov);
    this.weatherFx.setScale((h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.cam.fov * Math.PI) / 360)));
    this.camera.resize(w / Math.max(1, h));
  }

  /** Auto resolution (render/autores.ts), fed each match frame's real duration. */
  autoResolution(frameMs: number) {
    if (this.gfx.autoRes === false) return;
    if (this.dyn.feed(frameMs, performance.now()) === null) return;
    this.renderer.setPixelRatio(this.baseDpr * this.dyn.scale);
    this.resize();
  }

  /** Share of the chosen resolution being drawn (1 unless auto resolution has stepped down). */
  get resolutionScale(): number {
    return this.dyn.scale;
  }

  /** Crowd mood: supporters rise as their team nears goal and celebrate goals. */
  private updateCrowd(view: ViewState, dt: number) {
    if (!this.lastScore || view.phase === 'kickoff' && view.score[0] + view.score[1] === 0) this.lastScore = [view.score[0], view.score[1]];
    for (const t of [0, 1] as const) {
      if (view.score[t] > this.lastScore[t]) this.cheerT[t] = 7;
      this.cheerT[t] = Math.max(0, this.cheerT[t] - dt);
    }
    this.lastScore = [view.score[0], view.score[1]];
    const owner = view.ball.owner >= 0 ? view.players[view.ball.owner].team : view.ball.lastTouchTeam;
    for (const t of [0, 1] as const) {
      const goalX = view.attackDir[t] * 52.5;
      const near = Math.max(0, 1 - Math.abs(view.ball.pos.x - goalX) / 32);
      let target = 0.12 + (owner === t ? 0.55 * near * near : 0.1 * near);
      if (view.phase === 'halftime' || view.phase === 'fulltime') target = 0.05;
      if (this.cheerT[t] > 0) target = 1;
      // Quick to rise, slower to settle.
      const rate = target > this.crowdE[t] ? 3 : 0.8;
      this.crowdE[t] += (target - this.crowdE[t]) * Math.min(1, rate * dt);
    }
    updateCrowd(this.time, this.crowdE[0], this.crowdE[1]);
    const calm = view.phase === 'play' && this.crowdE[0] < 0.3 && this.crowdE[1] < 0.3;
    this.crowd.update(dt, calm);
    // LED boards, big screens and flares. The GOAL! takeover holds for 5 s then fades over 2 s.
    const arena = this.stadium?.userData.arena as Arena | undefined;
    // The boards chase in a club's colours while it attacks near goal, and flash on a big save or a near miss.
    let chase: { team: 0 | 1; k: number } | undefined;
    for (const t of [0, 1] as const) {
      const near = 1 - Math.abs(view.ball.pos.x - view.attackDir[t] * 52.5) / 32;
      const on = view.phase === 'play' && owner === t && near > 0.45 ? 1 : 0;
      this.chaseK[t] += (on - this.chaseK[t]) * Math.min(1, dt * (on ? 2.5 : 1.2));
      if (this.chaseK[t] > 0.01 && (!chase || this.chaseK[t] > chase.k)) chase = { team: t, k: this.chaseK[t] };
    }
    this.flashT = Math.max(0, this.flashT - dt);
    const flash = this.flashT > 0 ? { kind: this.flashKind, k: Math.min(1, (3.2 - this.flashT) / 0.25, this.flashT / 0.6) } : undefined;
    const feed = this.feed ? { tex: this.feed.texture, mode: this.feed.mode } : null;
    if (this.varScreen && this.time > this.varScreen.until) this.varScreen = null;
    const vs = this.varScreen;
    const cols = this.matchArgs ? [this.matchArgs[0][0][this.matchArgs[1][0]].shirt, this.matchArgs[0][1][this.matchArgs[1][1]].shirt] as [number, number] : [0xffffff, 0x222222] as [number, number];
    const blink = Math.floor(this.time * 2) % 2 === 0;
    const varPage = vs ? { key: `${vs.until}|${blink}`, draw: (g: CanvasRenderingContext2D) => drawVarPage(g, vs.info, cols, (id) => (id < 11 ? 0 : 1), blink) } : null;
    arena?.update(this.time, { goal: Math.min(1, Math.max(this.cheerT[0], this.cheerT[1]) / 2), score: view.score, clock: view.clock, chase, flash, feed, varPage });
  }

  // Movement detail (motion.ts): who has the ball, and the ball just before, to spot first touches.
  private moveOwner = -1;
  private moveBall = { y: 0, vx: 0, vz: 0, state: 'dead' as string, owner: -1 };
  private recv: { id: number; t: number; y: number; dx: number; dz: number } | null = null;
  private foulFrom: { x: number; z: number } | null = null;
  /** 20 Nov 2026 animation pack: when each player last hurdled, and until when a knocked player limps. */
  private hurdleAt = new Map<number, number>();
  private limpUntil = new Map<number, number>();
  private injuredLast = -1;
  private injuredSev = 0;

  /** Spot a player taking a pass (the ball's height and line just before decide the first touch). */
  private trackPossession(view: ViewState) {
    const b = view.ball;
    if (b.owner === this.moveOwner) return;
    const prev = this.moveBall, id = b.owner;
    this.moveOwner = id;
    if (id < 0 || view.phase !== 'play' || b.state !== 'dribble' || this.cine) return;
    const p = view.players[id];
    const m = this.players[id];
    if (!p || !m) return;
    // A pass or loose ball arriving (not a tackle taking it off someone's feet).
    if (prev.state !== 'flight' && prev.state !== 'free') return;
    const sp = Math.hypot(prev.vx, prev.vz);
    const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
    const right = (b.pos.z - p.pos.z) * fx - (b.pos.x - p.pos.x) * fz;
    const kind = firstTouchFor(prev.y, 0);
    m.play(makeGesture(kind, right >= 0 ? 1 : -1, Math.min(1, 0.55 + sp / 20)));
    this.recv = { id, t: this.time, y: prev.y, dx: sp > 0.5 ? prev.vx / sp : fx, dz: sp > 0.5 ? prev.vz / sp : fz };
  }

  /** A touch on the ball: a first touch steered away (flick, push), or a dribbling touch timed to the ball. */
  private touchGesture(view: ViewState, id: number) {
    const p = view.players[id], m = this.players[id];
    if (!p || !m) return;
    const b = view.ball;
    const bs = Math.hypot(b.vel.x, b.vel.z), ps = Math.hypot(p.vel.x, p.vel.z);
    const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
    const big = bs - ps > 1.8;
    const r = this.recv;
    if (r && r.id === id && this.time - r.t < 0.3) {
      if (r.y > 0.5) return; // chest and thigh control already playing
      const ox = bs > 0.5 ? b.vel.x / bs : fx, oz = bs > 0.5 ? b.vel.z / bs : fz;
      const turn = Math.acos(Math.max(-1, Math.min(1, ox * r.dx + oz * r.dz)));
      const outRight = oz * fx - ox * fz;
      const kind = big ? 'push' : firstTouchFor(r.y, Math.PI - turn > 0.8 && turn > 0.8 ? turn : 0);
      if (kind !== 'cushion') m.play(makeGesture(kind, outRight >= 0 ? 1 : -1));
      return;
    }
    if (b.owner !== id && b.state !== 'free') return;
    const side = m instanceof RealPlayerModel ? m.swingSide : ((b.pos.z - p.pos.z) * fx - (b.pos.x - p.pos.x) * fz >= 0 ? 1 : -1);
    m.play(makeGesture(big ? 'push' : 'touch', side, big ? 1 : Math.min(1, 0.6 + ps / 12)));
  }

  /** Each frame before the models update: tiredness, resting, the carrier to tackle, kick aims and shoulder checks. */
  private motionInputs(view: ViewState) {
    this.trackPossession(view);
    const b = view.ball;
    const owner = b.owner >= 0 ? view.players[b.owner] : null;
    const poss = possessionTeam(view);
    const flying = b.state === 'flight' && b.flight !== 'deflect';
    const bsp = Math.hypot(b.vel.x, b.vel.z);
    this.duelsAndHurdles(view, owner);
    for (const p of view.players) {
      const m = this.players[p.id];
      if (!m || p.off) continue;
      m.tired = p.role === 'GK' ? 0 : tirednessFor(p.stamina);
      const far = Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z);
      m.resting = view.phase !== 'play' || far > 32;
      m.foe = owner && owner.team !== p.team ? { x: owner.pos.x, z: owner.pos.z, vx: owner.vel.x, vz: owner.vel.z } : null;
      // Where a kick is going: its target, the chosen receiver or stick direction (offline), or the goal for a shot.
      if (p.action.type === 'kick') {
        const a = p.action as typeof p.action & { receiver?: number; dir?: { x: number; z: number } };
        const rc = a.receiver !== undefined && a.receiver >= 0 ? view.players[a.receiver] : null;
        m.aimHint = a.target ? { x: a.target.x, z: a.target.z } : rc ? { x: rc.pos.x, z: rc.pos.z }
          : a.dir && (a.dir.x || a.dir.z) ? { x: p.pos.x + a.dir.x * 10, z: p.pos.z + a.dir.z * 10 }
          : a.kind === 'shot' ? { x: view.attackDir[p.team] * 52.5, z: 0 } : null;
      } else m.aimHint = null;
      if (m instanceof RealPlayerModel) {
        let cue = 0;
        if (view.phase === 'play' && p.role !== 'GK' && b.owner !== p.id) {
          if (flying && b.lastTouchTeam === p.team && bsp > 3) {
            // A pass on its way: is it coming to me, with time for a look?
            const rx = p.pos.x - b.pos.x, rz = p.pos.z - b.pos.z;
            const t = (rx * b.vel.x + rz * b.vel.z) / (bsp * bsp);
            const mx = rx - b.vel.x * t, mz = rz - b.vel.z * t;
            if (t > 0.45 && t < 3 && Math.hypot(mx, mz) < 3.5) cue = 2;
          }
          if (!cue && (poss === p.team || poss < 0) && far < 28) cue = 1;
        }
        m.scanCue = cue;
      }
    }
  }

  /**
   * 20 Nov 2026 animation pack (render/moves7.ts), all from what the view shows:
   * - a runner jumps over a slide tackle or a keeper going down at his feet;
   * - a defender running alongside or behind the carrier gets a hand on his shirt, and the carrier
   *   holds him off with an arm;
   * - the keeper organises his wall for a free kick in range;
   * - an injured player lies holding his leg, sits up for the physio, and limps for a while if he plays on.
   */
  private duelsAndHurdles(view: ViewState, owner: ViewState['players'][number] | null) {
    const live = view.phase === 'play' && !this.cine;
    const now = this.time;
    for (const p of view.players) {
      const m = this.players[p.id];
      if (!m || p.off) continue;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      // Hurdles: someone sliding in (or a keeper diving low) right in front of a runner.
      if (live && p.action.type === 'none' && sp > 2.4 && now - (this.hurdleAt.get(p.id) ?? -9) > 1.2) {
        for (const o of view.players) {
          if (o.team === p.team || o.off) continue;
          const sliding = o.action.type === 'slide' && o.action.t < 0.42;
          const diving = o.role === 'GK' && o.action.type === 'dive' && !!o.action.target && o.action.target.y < 0.6 && o.action.t < 0.4;
          if (!sliding && !diving) continue;
          const dx = o.pos.x - p.pos.x, dz = o.pos.z - p.pos.z, d = Math.hypot(dx, dz);
          if (d > 1.7 || d < 0.2) continue;
          // In the runner's path: ahead of him.
          if ((dx * p.vel.x + dz * p.vel.z) / (d * sp) < 0.35) continue;
          const right = dz * Math.cos(p.facing) - dx * Math.sin(p.facing);
          m.play(makeGesture('hurdle', right >= 0 ? -1 : 1));
          this.hurdleAt.set(p.id, now);
          break;
        }
      }
      // Shirt-pulling and hand-offs alongside the ball carrier.
      if (live && owner && owner !== p && p.team !== owner.team && p.role !== 'GK' && p.action.type === 'none' && owner.action.type === 'none') {
        const osp = Math.hypot(owner.vel.x, owner.vel.z);
        const dx = owner.pos.x - p.pos.x, dz = owner.pos.z - p.pos.z, d = Math.hypot(dx, dz);
        if (d < 1.3 && d > 0.3 && sp > 2.2 && osp > 2.2) {
          // Beside or behind the carrier, not squared up in front of him.
          const ahead = (-dx * Math.cos(owner.facing) + -dz * Math.sin(owner.facing)) / d;
          if (ahead < 0.45) {
            const pr = dz * Math.cos(p.facing) - dx * Math.sin(p.facing); // carrier to the defender's right (+)
            const orr = -dz * Math.cos(owner.facing) + dx * Math.sin(owner.facing); // defender to the carrier's right (+)
            this.reactions.hold(p.id, pr >= 0 ? 'grabR' : 'grabL', 0.3);
            this.reactions.hold(owner.id, orr >= 0 ? 'fendR' : 'fendL', 0.3);
          }
        }
      }
      // The keeper organising his wall.
      const rs = view.restart;
      if (p.role === 'GK' && rs && rs.type === 'freekick' && rs.team !== p.team && view.phase === 'restart' && !this.cine) {
        const goalX = -view.attackDir[p.team] * 52.5;
        if (Math.hypot(rs.spot.x - goalX, rs.spot.z) < 36 && p.action.type === 'none') this.reactions.hold(p.id, 'organise', 0.5);
      }
      // Shootout: arm in arm on the halfway line.
      if (view.shootout && view.phase !== 'fulltime' && !this.cine && Math.abs(p.pos.x - 0.6) < 0.8 && Math.abs(p.pos.z) < 9 && Math.hypot(p.vel.x, p.vel.z) < 0.6 && p.action.type === 'none') {
        if (this.reactions.kindOf(p.id) !== 'armsLinked') this.reactions.cancel(p.id);
        this.reactions.hold(p.id, 'armsLinked', 0.4);
      }
    }
    // Injured: down holding the leg, sitting up while treated (a knock), then limping for a while.
    const j = view.injury;
    for (const m of this.players) if (m) m.injury = null;
    if (j && j.stage !== 'done') {
      const m = this.players[j.pid];
      if (m) m.injury = j.stage === 'treat' && j.severity === 1 ? { stage: 'treat', t: j.t - INJURY.down - INJURY.runOn } : { stage: 'down', t: j.t };
      this.injuredLast = j.pid;
      this.injuredSev = j.severity;
    } else if (this.injuredLast >= 0) {
      // A knock: he plays on, limping it off.
      if (this.injuredSev === 1) this.limpUntil.set(this.injuredLast, now + 14);
      this.injuredLast = -1;
    }
    for (const [id, until] of this.limpUntil) {
      const m = this.players[id];
      if (!m || now > until) { if (m) m.limp = 0; this.limpUntil.delete(id); continue; }
      m.limp = Math.min(1, (until - now) / 4) * 0.9;
    }
  }

  /** Match events this frame: players react to stoppages, the crowd to chances and goals. */
  onEvents(view: ViewState, evs: MatchEvent[]) {
    if (!evs.length) return;
    this.trackPossession(view);
    for (const e of evs) {
      const id = e.player;
      if (id === undefined || id < 0) continue;
      if (e.type === 'kick' && e.text === 'touch') this.touchGesture(view, id);
      else if (e.type === 'block') {
        const p = view.players[id];
        const right = (view.ball.pos.z - p.pos.z) * Math.cos(p.facing) - (view.ball.pos.x - p.pos.x) * Math.sin(p.facing);
        this.players[id]?.play(makeGesture('block', right >= 0 ? 1 : -1));
      } else if (e.type === 'foul' && e.x !== undefined && e.z !== undefined) {
        // The victim is the nearest opponent to where it happened; he goes down away from the offender.
        const off = view.players[id];
        let victim = -1, best = 2.5;
        for (const q of view.players) if (q.team !== off.team && !q.off) { const d = Math.hypot(q.pos.x - e.x, q.pos.z - e.z!); if (d < best) { best = d; victim = q.id; } }
        this.foulFrom = { x: off.pos.x, z: off.pos.z };
        if (victim >= 0) this.players[victim]?.onFouled(this.foulFrom);
      } else if (e.type === 'advantage' && this.foulFrom) {
        // Played on: the fouled player rides the challenge with a stagger.
        const p = view.players[id];
        const right = (p.pos.z - this.foulFrom.z) * Math.cos(p.facing) - (p.pos.x - this.foulFrom.x) * Math.sin(p.facing);
        this.players[id]?.play(makeGesture('stagger', right >= 0 ? 1 : -1));
      }
    }
    this.reactions.onEvents(view, evs);
    for (const e of evs) if (e.type === 'parry' && e.player !== undefined) this.players[e.player]?.onParry(view.ball.pos.y);
    this.pitchside?.onEvents(view, evs);
    for (const e of evs) {
      if (e.type === 'goal') { this.goalTeam = e.team ?? -1; this.feed?.goal(); if (e.team === 0 || e.team === 1) this.smoke.goal(e.team); }
      else if (e.type === 'save') { this.flashT = 3.2; this.flashKind = 'save'; }
      else if (e.type === 'post' || e.type === 'bar') { this.flashT = 3.2; this.flashKind = 'close'; }
    }
    this.managers?.onEvents(view, evs);
    this.touchline?.onEvents(view, evs);
    this.officials?.onEvents(view, evs);
    this.crowdEvents(view, evs);
  }

  /** The crowd's side of the events: hands on heads at a near miss, scarves up for kick-off. */
  private crowdEvents(view: ViewState, evs: MatchEvent[]) {
    for (const e of evs) {
      if (e.type === 'chance' && e.team !== undefined && e.team >= 0) this.crowd.trigger('miss', e.team);
      else if ((e.type === 'post' || e.type === 'bar') && view.ball.lastTouchTeam >= 0) this.crowd.trigger('miss', view.ball.lastTouchTeam);
      else if (e.type === 'kickoff' && view.clock < 1 && view.half === 1) this.crowd.trigger('kickoff');
    }
  }

  /** Crowd moments from outside the match: a chant or stamping (audio), the teams walking out. */
  crowdMoment(kind: 'chant' | 'stomp' | 'walkout', team = Math.random() < 0.7 ? 0 : 1) {
    this.crowd.trigger(kind, team);
  }

  /** Build (or rebuild) the scene for a match between these teams/kits. */
  setupMatch(teams: [TeamDef, TeamDef], kits: ['home' | 'away', 'home' | 'away'], weather?: MatchWeather) {
    this.wantPlayers();
    this.glCheck.rearm();
    this.chooseWeather(weather);
    this.chooseMowing();
    this.feed?.reset();
    this.flashT = 0; this.chaseK = [0, 0];
    this.reactions.reset();
    this.crowd.reset();
    this.pitchWear.reset();
    this.kitWear.reset();
    this.marks.reset(this.weather === 'snow');
    this.tifo.reset();
    const key = `${teams[0].id}:${kits[0]}|${teams[1].id}:${kits[1]}|${this.gfx.preset}|${realisticPlayers(this.gfx) && !!this.playerAssets}`;
    if (key === this.builtFor) { this.weatherTints(); this.smoke.setup(this.flarePos, QUALITY[this.gfx.preset]); return; }
    this.builtFor = key;
    for (const m of this.markers) this.scene.remove(m.ring, m.arrow, m.sprite);
    this.markers = [];
    if (this.stadium) this.scene.remove(this.stadium);
    const k0 = teams[0][kits[0]], k1 = teams[1][kits[1]];
    this.stadium = buildStadium({ quality: QUALITY[this.gfx.preset], homeColour: k0.shirt, awayColour: k1.shirt, homeName: teams[0].name, awayName: teams[1].name, homeShort: teams[0].abbr, awayShort: teams[1].abbr, ground: groundFor(groundTeam(teams[0])) });
    this.scene.add(this.stadium);
    const arenaObj = this.stadium.userData.arena as Arena | undefined;
    this.pitchside = arenaObj ? new Pitchside(arenaObj.staff, QUALITY[this.gfx.preset]) : null;
    this.clubFlags = arenaObj ? new ClubFlags(arenaObj.flagpoles, teams[0], teams[0].home, QUALITY[this.gfx.preset]) : null;
    if (this.blimp) { this.blimp.group.removeFromParent(); this.blimp = null; }
    if (arenaObj && QUALITY[this.gfx.preset] >= 1) { this.blimp = new Blimp(arenaObj.roofHeight + 3.5); this.scene.add(this.blimp.group); }
    if (this.clubFlags) this.stadium.add(this.clubFlags.group);
    this.cornerFlags = new CornerFlags(teams[0].home);
    this.stadium.add(this.cornerFlags.group);
    if (this.pitchside) this.stadium.add(this.pitchside.group);
    if (arenaObj && QUALITY[this.gfx.preset] >= 1) { this.tifo.build(teams[0], k0, arenaObj.tiers.low, arenaObj.tiers.upr); this.stadium.add(this.tifo.group); }
    else this.tifo.dispose();
    this.flarePos = arenaObj?.flarePos ?? [];
    this.smoke.setup(this.flarePos, QUALITY[this.gfx.preset]);
    this.tunnelSet.build(this.scene, tunnelOf(this.stadium), k0.shirt);
    this.scene.add(this.varLines.group);
    this.collectEffects(this.stadium);
    const aniso = QUALITY[this.gfx.preset] > 1 ? this.renderer.capabilities.getMaxAnisotropy() : 4;
    this.stadium.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && 'map' in m && m.map) { m.map.anisotropy = aniso; m.map.needsUpdate = true; }
    });
    this.matchArgs = [teams, kits];
    // Each kit knows its club, so shirts wear the crest.
    teams.forEach((t) => { setKitClub(t.home, t); setKitClub(t.away, t); });
    this.buildPlayers(teams, kits);
    // Ball and its shadow (always shown: it is what makes height readable).
    // Drawn larger than life (as broadcast games do) so it reads at camera distance; physics uses BALL.radius.
    const bq = QUALITY[this.gfx.preset];
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL.radius * BALL_DRAW_SCALE, bq > 0 ? 40 : 24, bq > 0 ? 28 : 16), ballMaterial(bq));
    this.ballSpinner.reset();
    this.ball.castShadow = this.renderer.shadowMap.enabled;
    if (this.ball.parent) this.ball.parent.remove(this.ball);
    this.ballRoot.clear();
    this.ballRoot.add(this.ball);
    WetReflection.show(this.ball);
    const sg = new THREE.CircleGeometry(BALL.radius * BALL_DRAW_SCALE * 1.1, 16);
    sg.rotateX(-Math.PI / 2);
    this.ballShadow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    this.ballShadow.position.y = 0.015;
    this.scene.add(this.ballShadow);
    // Controlled-player markers: P1 yellow triangle, P2 cyan diamond, P3 green triangle, P4 pink diamond (shape + colour).
    const styles: [number, string, 'triangle' | 'diamond', string][] = [[0xffd60a, '#ffd60a', 'triangle', 'P1'], [0x4cc9f0, '#4cc9f0', 'diamond', 'P2'], [0x7ae582, '#7ae582', 'triangle', 'P3'], [0xff7eb6, '#ff7eb6', 'diamond', 'P4']];
    for (const [c, css, shape, label] of styles) {
      const r = ring(0.62, 0.8, c, 0.95);
      const ag = new THREE.ConeGeometry(0.22, 0.5, 3);
      ag.rotateX(Math.PI / 2);
      ag.rotateY(0);
      const arrow = new THREE.Mesh(ag, new THREE.MeshBasicMaterial({ color: c }));
      arrow.scale.y = 0.15;
      const sprite = markerSprite(shape, css, label);
      this.scene.add(r, arrow, sprite);
      this.markers.push({ ring: r, arrow, sprite });
    }
    for (const s of this.callBubbles) this.scene.remove(s);
    this.callBubbles = [0, 1, 2].map(() => { const s = callSprite(); s.visible = false; this.scene.add(s); return s; });
    this.nextRing = ring(0.55, 0.64, 0xffffff, 0.45);
    this.flashRing = ring(0.62, 0.86, 0xffffff, 0.9);
    this.flashRing.visible = false;
    this.scene.add(this.flashRing);
    this.recvRing = ring(0.7, 0.82, 0xffffff, 0.7);
    this.holdRing = ring(0.95, 1.08, 0xffd60a, 0.85);
    // Set-piece target: a ring on the grass (or on the goal line for penalties) with a centre dot.
    this.aimRing = ring(1.0, 1.25, 0xffd60a, 0.9);
    this.aimDot = ring(0, 0.22, 0xffd60a, 0.9);
    this.scene.add(this.nextRing, this.recvRing, this.holdRing, this.aimRing, this.aimDot);
    if (this.fkLine) this.scene.remove(this.fkLine);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FK_DOTS * 3), 3));
    this.fkLine = new THREE.Points(fg, new THREE.PointsMaterial({ color: 0xffd60a, size: 0.6, transparent: true, opacity: 0.85, depthWrite: false }));
    this.fkLine.frustumCulled = false;
    this.fkLine.visible = false;
    this.scene.add(this.fkLine);
    this.weatherTints();
  }

  /**
   * The free kick's flight as dots: it sets off to one side and bends back onto the target (the
   * sim pre-aims against the curl, shared/kick.ts), and with dip it climbs later and drops sharply.
   */
  private freeKickPath(from: { x: number; z: number }, to: { x: number; z: number }, curve: number, dip: number) {
    const pos = (this.fkLine!.geometry.getAttribute('position') as THREE.BufferAttribute);
    const dx = to.x - from.x, dz = to.z - from.z, d = Math.max(1, Math.hypot(dx, dz));
    const ux = dx / d, uz = dz / d;
    // Spin pushes the ball towards the side at +90° of travel (ball.ts), so it starts out on the other side.
    const px = -uz, pz = ux;
    const tf = d / 22;
    const lateral = 0.5 * Math.abs(curve) * 10 * 1.1 * tf * tf * Math.sign(curve);
    const h = Math.min(4, 1.2 + d * 0.07);
    const k = 1 / (1 + 1.2 * dip);
    for (let i = 0; i < FK_DOTS; i++) {
      const t = (i + 1) / (FK_DOTS + 1);
      const off = lateral * (t * t - t);
      const y = 0.12 + h * Math.sin(Math.PI * Math.pow(t, k));
      pos.setXYZ(i, from.x + ux * d * t + px * off, y, from.z + uz * d * t + pz * off);
    }
    pos.needsUpdate = true;
  }

  /** In the snow the lines are painted blue and the ball is the high-visibility orange one. */
  private weatherTints() {
    const snow = this.weather === 'snow';
    const lines = this.stadium?.getObjectByName('pitchLines') as THREE.Mesh | undefined;
    (lines?.material as THREE.MeshStandardMaterial | undefined)?.color.setHex(snow ? 0x2f6fe0 : 0xf4f4f0);
    (this.ball?.material as THREE.MeshStandardMaterial | undefined)?.color.setHex(snow ? 0xff8a1e : 0xffffff);
  }

  /** The groundsman's pattern for this match: the setting, or a new one each match on Random (?mow=checks forces one). */
  private chooseMowing() {
    const set = this.gfx.mowing ?? 'random';
    const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('mow') : null;
    const test = typeof location !== 'undefined' && new URLSearchParams(location.search).has('test');
    this.mowPattern = (MOW_PATTERNS as readonly string[]).includes(forced ?? '') ? forced as MowPattern
      : set !== 'random' ? set : test ? 'stripes' : MOW_PATTERNS[Math.floor(Math.random() * MOW_PATTERNS.length)];
    if (this.grassU?.uMow) this.grassU.uMow.value = MOW_PATTERNS.indexOf(this.mowPattern);
  }

  /** Find the stadium's nets, floodlights and grass, and set up the per-match effects. */
  private collectEffects(stadium: THREE.Group) {
    this.nets = [];
    this.lamps = [];
    for (const h of this.halos) this.scene.remove(h);
    this.halos = [];
    this.grassU = (stadium.userData.grass as GrassUniforms | undefined) ?? null;
    if (this.grassU?.uWearMap) this.grassU.uWearMap.value = this.pitchWear.texture;
    if (this.grassU?.uMow) this.grassU.uMow.value = MOW_PATTERNS.indexOf(this.mowPattern);
    // Grass blades for close shots, coloured from the same turf texture and mowing pattern.
    if (this.blades?.mesh) { this.scene.remove(this.blades.mesh); this.blades.dispose(); }
    this.blades = this.grassU?.uMow ? new GrassBlades(QUALITY[this.gfx.preset], (stadium.userData.grassMap as THREE.Texture | undefined) ?? null, this.grassU.uMow) : null;
    if (this.blades?.mesh) this.scene.add(this.blades.mesh);
    const glow = glowTexture();
    stadium.updateMatrixWorld(true);
    stadium.traverse((o) => {
      if (o.userData.nets) this.nets.push(...(o.userData.nets as NetPanel[]));
      const lamp = o.userData.lamp;
      if (lamp) {
        const mesh = o as THREE.Mesh;
        this.lamps.push({ m: mesh.material as THREE.MeshBasicMaterial, k: typeof lamp === 'number' ? lamp : 1 });
        this.bankLamps(mesh);
        // Not in the wet-pitch mirror (see WetReflection.show): the shader's glints reflect the lights.
        if (lamp === true) {
          // A glow around each floodlight head (bloom adds to it on High and Ultra).
          const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xfff1d6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
          mesh.getWorldPosition(h.position);
          h.scale.set(26, 20, 1);
          h.userData.noReflect = true;
          this.halos.push(h);
          this.scene.add(h);
        }
      }
    });
    const banks = glarePoints(stadium);
    this.glare.setLamps(banks);
    this.haze.setLamps(banks, QUALITY[this.gfx.preset]);
    if (!this.cross) {
      this.cross = new CrossShadows(22);
      this.scene.add(this.cross.mesh);
    }
    this.lookFor = '';
    this.applyLook();
  }

  /** Ball effects: stretch at speed, trail behind fast balls, turf thrown up by strikes and bounces, net ripples. */
  private updateBallFx(view: ViewState, dt: number, drawn: THREE.Vector3) {
    const q = QUALITY[this.gfx.preset];
    const b = view.ball;
    const vel = new THREE.Vector3(b.vel.x, b.vel.y, b.vel.z);
    const pos = new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z);
    const jumped = pos.distanceTo(this.prevBallP) > 4; // restarts teleport the ball
    const speed = vel.length();
    // Trail: shots, driven passes and long balls in the air or skimming the turf.
    const fast = b.state === 'flight' && b.owner < 0 ? THREE.MathUtils.smoothstep(speed, 15, 26) : 0;
    this.trail.update(this.time, drawn, fast, this.camera.cam.position, BALL.radius * BALL_DRAW_SCALE, jumped);
    // Stretch along the direction of travel (Medium and up).
    const k = q > 0 && b.owner < 0 ? Math.min(0.22, Math.max(0, speed - 12) / 90) : 0;
    if (k > 0.002) {
      this.ballRoot.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), vel.clone().normalize());
      this.ballRoot.scale.set(1 + k, 1 - k * 0.35, 1 - k * 0.35);
    } else {
      this.ballRoot.quaternion.identity();
      this.ballRoot.scale.set(1, 1, 1);
    }
    this.ball.quaternion.copy(this.ballRoot.quaternion).invert().multiply(this.ballQ);
    if (!jumped && dt > 0) {
      // Strikes and hard bounces near the ground throw up grass (Medium and up).
      const dv = vel.clone().sub(this.prevBallV);
      if (q > 0 && b.pos.y < 0.7) {
        if (dv.length() > 9) {
          const d = vel.clone().setY(0).normalize();
          this.particles.turf(b.pos.x, b.pos.z, -d.x * 0.3, -d.z * 0.3, Math.min(1, dv.length() / 30));
          if (this.weather !== 'clear') this.particles.spray(b.pos.x, b.pos.z, -d.x * 0.3, -d.z * 0.3, Math.min(1, dv.length() / 30), this.weather === 'snow');
        } else if (this.prevBallV.y < -4 && vel.y > 0.5) {
          const d = vel.clone().setY(0).normalize();
          this.particles.turf(b.pos.x, b.pos.z, d.x * 0.5, d.z * 0.5, Math.min(0.6, -this.prevBallV.y / 20));
          if (this.weather !== 'clear') this.particles.spray(b.pos.x, b.pos.z, d.x * 0.5, d.z * 0.5, Math.min(0.8, -this.prevBallV.y / 14), this.weather === 'snow');
        }
      }
      for (const n of this.nets) n.touch(pos, vel, this.prevBallV, BALL.radius);
      // A ball skimming a wet pitch throws up spray as it goes (Medium and up).
      if (q > 0 && this.weather === 'rain' && b.pos.y < 0.3 && speed > 3.5) {
        this.sprayAcc += dt * speed * 1.1 * this.weatherFx.cover;
        const d = vel.clone().setY(0).normalize();
        for (; this.sprayAcc > 1; this.sprayAcc -= 1) this.particles.spray(b.pos.x - d.x * 0.1, b.pos.z - d.z * 0.1, d.x * 0.45, d.z * 0.45, 0.02 + speed * 0.005);
      }
    }
    for (const n of this.nets) n.step(dt);
    this.particles.update(dt);
    this.prevBallV.copy(vel);
    this.prevBallP.copy(pos);
  }

  /** A substitute comes on: rebuild that one model with their number and looks. */
  private replaceModel(id: number, def: PlayerDef) {
    if (!this.matchArgs) return;
    const [teams, kits] = this.matchArgs;
    const kit = teams[id < 11 ? 0 : 1][kits[id < 11 ? 0 : 1]];
    const assets = this.playersReal ? this.playerAssets : null;
    const shadows = this.renderer.shadowMap.enabled;
    const gk = id % 11 === 0;
    const pm = this.makeModel(id, def, kit, gk, assets, kitMaterials(kit), shadows, false);
    this.scene.remove(this.players[id].root);
    this.players[id] = pm;
    if (this.lastView) this.kitWear.fresh(id, this.lastView);
    this.modelDefs[id] = def;
    this.scene.add(pm.root);
    WetReflection.show(pm.root);
  }

  /** One player's model, sized to their build, with their boots, name and (for captains) armband. */
  private makeModel(id: number, def: PlayerDef, kit: Kit, gk: boolean, assets: PlayerAssets | null, mats: ReturnType<typeof kitMaterials> | null, shadows: boolean, captain: boolean) {
    const pm = assets
      ? new RealPlayerModel(id, assets, kit, gk, def.skin, def.number, shadows, { name: def.short, boot: bootColour(def), captain, hair: def.hair, hairStyle: hairStyleFor(def.name), detail: QUALITY[this.gfx.preset] })
      : new PlayerModel(id, mats, gk, def.skin, def.hair, def.number, shadows);
    const b = playerBuild(def);
    pm.root.scale.set(b.w, b.h, b.w);
    this.mouthY[id] = 1.6 * b.h;
    return pm;
  }

  /** A mascot for every player (the first seven of each side on Medium), in the club kits. */
  private buildMascots(view: ViewState) {
    const [teams, kits] = this.matchArgs!;
    const q = QUALITY[this.gfx.preset];
    const real = this.playersReal ? this.playerAssets : null;
    const ids = view.players.filter((p) => !p.off && (!real || q >= 2 || p.id % 11 < 7)).map((p) => p.id);
    this.mascots = new Mascots(view, [teams[0][kits[0]], teams[1][kits[1]]], ids, real, this.renderer.shadowMap.enabled && q >= 2);
    this.scene.add(this.mascots.group);
  }

  /** (Re)create the 22 player models and their blob shadows. */
  private buildPlayers(teams: [TeamDef, TeamDef], kits: ['home' | 'away', 'home' | 'away']) {
    if (this.mascots) { this.mascots.dispose(); this.mascots = null; }
    for (const p of this.players) this.scene.remove(p.root);
    for (const b of this.blobs) this.scene.remove(b);
    this.players = [];
    this.blobs = [];
    const assets = realisticPlayers(this.gfx) ? this.playerAssets : null;
    this.playersReal = !!assets;
    const shadows = this.renderer.shadowMap.enabled;
    const blobGeo = new THREE.CircleGeometry(0.45, 16);
    blobGeo.rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    teams.forEach((team, t) => {
      const kit = team[kits[t]];
      const mats = assets ? null : kitMaterials(kit);
      team.players.forEach((def, i) => {
        const id = t * 11 + i;
        const pm = this.makeModel(id, def, kit, def.role === 'GK', assets, mats, shadows, i === captainIndex(team));
        this.players.push(pm);
        this.modelDefs[id] = def;
        this.scene.add(pm.root);
        WetReflection.show(pm.root);
        const blob = new THREE.Mesh(blobGeo, blobMat);
        blob.position.y = 0.02;
        blob.visible = !shadows;
        this.blobs.push(blob);
        this.scene.add(blob);
      });
    });
    // The managers, dressed to match the bodies in use.
    if (this.managers) this.scene.remove(this.managers.group);
    this.managers = new Managers(teams, kits, assets, shadows);
    this.scene.add(this.managers.group);
    WetReflection.show(this.managers.group);
    if (this.touchline) this.scene.remove(this.touchline.group);
    this.touchline = new Touchline(teams, [teams[0][kits[0]], teams[1][kits[1]]], assets, shadows, QUALITY[this.gfx.preset]);
    this.scene.add(this.touchline.group);
    if (this.officials) this.scene.remove(this.officials.group);
    this.officials = new Officials([teams[0][kits[0]], teams[1][kits[1]]], teams[0].players[0], assets, shadows);
    this.scene.add(this.officials.group);
    WetReflection.show(this.officials.group);
  }

  render(view: ViewState, dt: number, cam: CameraSettings, mk: MarkerInfo, debug?: DebugDraw) {
    this.time += dt;
    this.lastView = view;
    this.renderer.info.reset();
    this.updateCrowd(view, dt);
    this.camera.update(view, dt, cam);
    if (this.faceFollow !== null) this.viewOverride = this.faceView(this.faceFollow.id, this.faceFollow.dist);
    if (this.viewOverride) {
      // Screenshot scripts (?test) can place the camera anywhere to inspect the stadium.
      const o = this.viewOverride;
      this.camera.cam.position.set(o.pos[0], o.pos[1], o.pos[2]);
      this.camera.cam.lookAt(o.look[0], o.look[1], o.look[2]);
    }
    this.updateLiveHandheld(view, dt);
    this.applyCine();
    this.applyShake(dt, cam);
    if (!this.cine) this.lightsOn = 1;
    this.applyLit(this.lightsOn);
    // Reactions wait while a cinematic (intro, goal replay) shows recorded play.
    if (!this.cine || this.cineReactions) this.reactions.update(dt);
    const b = view.ball;
    const ballV = new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z);
    // Wear builds from live play only (not while a cinematic replays recorded play).
    const wearOn = this.gfx.wear !== false;
    const wet = this.weather === 'rain' ? this.weatherFx.cover : 0;
    if (wearOn && !this.cine) {
      this.pitchWear.update(view, dt, wet);
      this.kitWear.update(view, dt, wet, this.pitchWear);
    }
    if (this.grassU?.uWearOn && this.grassU.uAge) {
      this.grassU.uWearOn.value = wearOn ? 1 : 0;
      this.grassU.uAge.value = playedShare(view);
    }
    // Footprints, slide tracks and divots (with pitch wear).
    this.marks.update(view, dt, wearOn && !this.cine);
    const mt = this.marks.texture;
    if (this.grassU?.uMarks && this.grassU.uMarksOn && this.grassU.uMarksTexel) {
      this.grassU.uMarksOn.value = mt && wearOn ? 1 : 0;
      if (mt) { this.grassU.uMarks.value = mt; const tg = this.marks.target!; this.grassU.uMarksTexel.value.set(1 / tg.width, 1 / tg.height); }
    }
    this.marks.divots.visible = wearOn;
    // Slide tackles throw up turf, spray or snow as they go (Medium and up).
    if (QUALITY[this.gfx.preset] > 0 && dt > 0 && !this.cine) {
      for (const p of view.players) {
        if (p.off || p.action.type !== 'slide' || Math.random() > 0.3) continue;
        const sp = Math.hypot(p.vel.x, p.vel.z);
        if (sp < 2) continue;
        const ux = p.vel.x / sp, uz = p.vel.z / sp;
        if (this.weather === 'clear') this.particles.turf(p.pos.x + ux * 0.5, p.pos.z + uz * 0.5, ux * 0.6, uz * 0.6, 0.12);
        else this.particles.spray(p.pos.x + ux * 0.5, p.pos.z + uz * 0.5, ux * 0.7, uz * 0.7, 0.18, this.weather === 'snow');
      }
    }
    // Mascots (intro only): built when the walk-out starts, gone after the line-up.
    if (this.mascotMode && !this.mascots && this.matchArgs) this.buildMascots(view);
    if (this.mascots && !this.mascotMode) { this.mascots.dispose(); this.mascots = null; }
    if (this.mascots && this.mascotMode === 'hand') for (const id of this.mascots.players) this.reactions.hold(id, 'holdHand', 0.5);
    this.motionInputs(view);
    // Low (phones): realistic players off screen skip their pose, and only players near the camera
    // plant their feet (foot IK is a fifth of the players' per-frame work and can't be seen far off).
    const lite = QUALITY[this.gfx.preset] === 0;
    if (lite) {
      const cam = this.camera.cam;
      cam.updateMatrixWorld();
      this.liteFrustum.setFromProjectionMatrix(this.liteMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    }
    view.players.forEach((p, i) => {
      if (this.players[i] && this.modelDefs[i] && p.def.number !== this.modelDefs[i].number) this.replaceModel(i, p.def);
      const m = this.players[i];
      if (!m) return;
      // Sent-off players leave the pitch.
      m.root.visible = !p.off;
      this.blobs[i].visible = !p.off;
      if (p.off) return;
      // A teammate calling for the ball puts an arm up (only outside cinematics, never over a reaction).
      if (p.calling && !this.cine && view.phase === 'play') this.reactions.hold(i, 'call', 0.5);
      m.reaction = this.cine && !this.cineReactions ? null : this.reactions.frame(i);
      // Throw-in taker at the line with the ball: hold it overhead. Ball at the feet: dribbling arms.
      const rs = view.restart;
      m.holdThrow = view.phase === 'restart' && !!rs && rs.type === 'throwin' && rs.taker === i && p.action.type === 'none'
        && Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) < 1.2;
      m.dribbling = b.state === 'dribble' && b.owner === p.id;
      // Keepers' hands come up to meet a loose ball or one in flight from the other side.
      m.ballFoe = p.role === 'GK' && (b.state === 'flight' || b.state === 'free') && b.lastTouchTeam >= 0 && b.lastTouchTeam !== p.team;
      m.ballVel.set(b.vel.x, b.vel.y, b.vel.z);
      if (m instanceof RealPlayerModel) {
        const kw = this.kitWear.get(i);
        m.wear.mud = wearOn ? kw.mud : 0; m.wear.front = kw.front; m.wear.sweat = wearOn ? kw.sweat : 0;
      }
      if (m instanceof RealPlayerModel) {
        if (lite) {
          this.liteSphere.center.set(p.pos.x, 0.95, p.pos.z);
          m.skipPose = !this.renderer.shadowMap.enabled && !this.liteFrustum.intersectsSphere(this.liteSphere);
          m.footIK = this.camera.cam.position.distanceToSquared(this.liteSphere.center) < LITE_IK_DIST * LITE_IK_DIST;
        } else { m.skipPose = false; m.footIK = true; }
      }
      m.update(p, dt, this.time, b.state === 'held' && b.owner === p.id, ballV);
      const blob = this.blobs[i];
      blob.position.x = p.pos.x;
      blob.position.z = p.pos.z;
    });
    if (this.mascots && this.mascotMode) this.mascots.update(view, dt, this.time, this.mascotMode, ballV);
    this.moveBall.y = b.pos.y; this.moveBall.vx = b.vel.x; this.moveBall.vz = b.vel.z; this.moveBall.state = b.state; this.moveBall.owner = b.owner;
    // Ball: position, rolling rotation and shadow. A keeper diving or down holds it in his gloves.
    if (b.state === 'held' && b.owner >= 0) (this.players[b.owner] as { heldBallPos?: (v: THREE.Vector3) => boolean } | undefined)?.heldBallPos?.(ballV);
    // Throw-ins: the ball is in the taker's hands until it is thrown.
    const rs = view.restart;
    if (view.phase === 'restart' && rs && rs.type === 'throwin' && rs.taker >= 0) this.players[rs.taker]?.throwBallPos(ballV, dt);
    // A keeper's throw or roll: the ball leaves his hand rather than appearing on its flight.
    else if (b.state !== 'held') for (const p of view.players) if (p.role === 'GK' && p.action.type === 'throw') this.players[p.id]?.throwBallPos(ballV, dt);
    this.ballRoot.position.copy(ballV);
    this.ballRoot.position.y += BALL.radius * (BALL_DRAW_SCALE - 1);
    // Rolling on the ground; side spin on curling shots and backspin on lofted balls in the air.
    this.ballSpinner.step(this.ballQ, b.pos, b.vel, b.state === 'flight' || b.state === 'free', dt, BALL.radius * BALL_DRAW_SCALE);
    this.updateBallFx(view, dt, this.ballRoot.position);
    this.extras.update(view, dt, (i) => this.players[i]?.root);
    // Clouds drift with the wind; at dusk the sun goes down as the match goes on.
    const wd = view.weather;
    this.sky.update(this.time, playedShare(view), wd ? { x: wd.wind * Math.cos(wd.windDir), z: wd.wind * Math.sin(wd.windDir) } : undefined, dt);
    // Rain or snow round the play, and the pitch getting wetter or whiter.
    this.weatherFx.update(this.time, view.phase === 'play' ? dt : 0, this.camera.cam, new THREE.Vector3(b.pos.x, 0, b.pos.z));
    if (this.grassU?.uWet && this.grassU.uSnow) {
      this.grassU.uWet.value = this.weather === 'rain' ? this.weatherFx.cover : 0;
      this.grassU.uSnow.value = this.weather === 'snow' ? this.weatherFx.cover : 0;
    }
    // Faint floodlight shadows, one away from each mast.
    this.cross?.update(view.players.map((p) => ({ x: p.pos.x, z: p.pos.z, visible: !p.off })), LOOKS[this.matchTime()].crossShadow * (this.litNow < 0 ? 1 : this.litNow));
    this.ballShadow.position.set(b.pos.x, 0.015, b.pos.z);
    const hs = 1 + b.pos.y * 0.25;
    this.ballShadow.scale.set(hs, 1, hs);
    (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.12, 0.45 - b.pos.y * 0.04);

    // Markers.
    const live = view.phase !== 'halftime' && view.phase !== 'fulltime' && !mk.hideMarkers;
    const used = new Set<number>();
    for (let key = 0; key < 4; key++) {
      const t = key >> 1;
      const pid = key & 1 ? view.mates?.[t] ?? -1 : view.ctl[t];
      const style = mk.slotStyle ? mk.slotStyle[key] ?? -1 : key === 0 ? 0 : key === 2 ? 1 : -1;
      if (style < 0 || style >= this.markers.length || used.has(style)) continue;
      used.add(style);
      const m = this.markers[style];
      const show = live && view.humans[t] && pid >= 0;
      // Behind the taker in the set-piece view, his pointer would sit in the middle of the picture.
      m.sprite.visible = show && !(this.camera.setPieceK > 0.4 && view.restart && view.restart.taker === pid);
      m.ring.visible = m.arrow.visible = show && mk.playerRing !== false;
      if (!show) continue;
      const p = view.players[pid];
      m.ring.position.set(p.pos.x, 0.03, p.pos.z);
      m.arrow.position.set(p.pos.x + Math.cos(p.facing) * 1.05, 0.04, p.pos.z + Math.sin(p.facing) * 1.05);
      m.arrow.rotation.y = Math.PI / 2 - p.facing;
      m.sprite.position.set(p.pos.x, 2.75 + Math.sin(this.time * 4) * 0.05, p.pos.z);
      const s = mk.highContrast ? 1.6 : 1.25;
      m.sprite.scale.set(s, s, 1);
    }
    for (let i = 0; i < this.markers.length; i++) if (!used.has(i)) { const m = this.markers[i]; m.sprite.visible = m.ring.visible = m.arrow.visible = false; }
    // Calling teammates on this device's side: a small bubble over the head.
    let nb = 0;
    for (const p of view.players) {
      if (nb >= this.callBubbles.length) break;
      if (!live || view.phase !== 'play' || !p.calling || p.off || !mk.localTeams.includes(p.team) || !view.humans[p.team]) continue;
      const sp = this.callBubbles[nb++];
      sp.visible = true;
      sp.position.set(p.pos.x, 2.45 + Math.abs(Math.sin(this.time * 7)) * 0.08, p.pos.z);
      const sc = mk.highContrast ? 0.95 : 0.7;
      sp.scale.set(sc, sc, 1);
    }
    for (let i = nb; i < this.callBubbles.length; i++) this.callBubbles[i].visible = false;
    const lt = mk.localTeams[0];
    const nxt = lt !== undefined ? view.next[lt] : -1;
    this.nextRing.visible = live && mk.showNext && nxt >= 0 && view.ball.owner !== view.ctl[lt];
    if (this.nextRing.visible) { const p = view.players[nxt]; this.nextRing.position.set(p.pos.x, 0.025, p.pos.z); }
    // Switch flash: a ring bursting out from the new man and fading (0.45 s).
    this.flash.t += dt;
    const fl = this.flash.t < 0.45 && this.flash.id >= 0 && live && !mk.hideMarkers;
    this.flashRing.visible = fl;
    if (fl) {
      const p = view.players[this.flash.id], k = this.flash.t / 0.45;
      this.flashRing.position.set(p.pos.x, 0.03, p.pos.z);
      this.flashRing.scale.setScalar(1 + k * 1.8);
      (this.flashRing.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k) * (1 - k);
    }
    this.recvRing.visible = live && mk.receiver >= 0;
    if (this.recvRing.visible) {
      const p = view.players[mk.receiver];
      this.recvRing.position.set(p.pos.x, 0.025, p.pos.z);
      const pulse = 1 + Math.sin(this.time * 8) * 0.06;
      this.recvRing.scale.set(pulse, 1, pulse);
    }
    // Set-piece target for a local human taker.
    const r = view.restart;
    const aiming = !!r && r.ready && mk.localTeams.includes(r.team) && view.humans[r.team] && (view.ctl[r.team] === r.taker || view.mates?.[r.team] === r.taker) && r.type !== 'kickoff';
    this.aimRing.visible = this.aimDot.visible = aiming;
    if (aiming) {
      const pulse = 1 + Math.sin(this.time * 6) * 0.08;
      this.aimRing.position.set(r!.aim.x, 0.035, r!.aim.z);
      this.aimDot.position.set(r!.aim.x, 0.036, r!.aim.z);
      this.aimRing.scale.set(pulse, 1, pulse);
    }
    if (this.fkLine) {
      this.fkLine.visible = aiming && r!.type === 'freekick' && !r!.quick && (Math.abs(r!.curve ?? 0) > 0.02 || (r!.dip ?? 0) > 0.02);
      if (this.fkLine.visible) this.freeKickPath(r!.spot, r!.aim, r!.curve ?? 0, r!.dip ?? 0);
    }
    // Goalkeeper holding: shrinking countdown ring (time-limited distribution).
    this.holdRing.visible = b.state === 'held' && b.owner >= 0 && view.phase === 'play';
    if (this.holdRing.visible) {
      const gk = view.players[b.owner];
      this.holdRing.position.set(gk.pos.x, 0.03, gk.pos.z);
      const left = Math.max(0.02, 1 - view.holdT / 6);
      this.holdRing.scale.set(left, 1, left);
    }
    this.drawDebug(debug);
    if (this.sun.castShadow && QUALITY[this.gfx.preset] > 1) {
      // Keep the detailed shadow area centred on play (snapped to texels to avoid shimmering).
      const step = (84 / this.sun.shadow.mapSize.x) * 4;
      const fx = Math.round(Math.max(-30, Math.min(30, b.pos.x)) / step) * step;
      const fz = Math.round(Math.max(-12, Math.min(12, b.pos.z)) / step) * step;
      this.sun.target.position.set(fx, 0, fz);
      const sp0 = LOOKS[this.matchTime()].sunPos;
      this.sun.position.set(fx + sp0[0], sp0[1], fz + sp0[2]);
    }
    if (this.ceremony?.active) {
      // The trophy in the captain's hands (between the hand bones; above the head on classic players).
      const cm = this.players[this.ceremonyCaptain];
      let hands: THREE.Vector3 | null = null;
      if (cm) {
        cm.root.updateMatrixWorld(true);
        const l = cm.root.getObjectByName('LeftHand'), r = cm.root.getObjectByName('RightHand');
        hands = l && r ? l.getWorldPosition(new THREE.Vector3()).add(r.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.06, 0))
          : new THREE.Vector3(0, 2.02, 0.05).applyMatrix4(cm.root.matrixWorld);
      }
      this.ceremony.update(dt, hands, this.ceremonyLift);
    }
    // Breath on cold nights.
    this.breath.on = QUALITY[this.gfx.preset] > 0 && coldFor(this.matchTime(), this.weather);
    this.pitchside?.update(view, dt);
    this.managers?.update(view, dt, this.time);
    this.touchline?.update(view, dt, this.time);
    this.officials?.update(view, dt, this.time, this.officialStage);
    this.blimp?.update(this.time, this.matchTime() === 'night');
    this.breath.update(view, dt, this.time, this.mouthY, wd ? { x: wd.wind * Math.cos(wd.windDir), z: wd.wind * Math.sin(wd.windDir) } : { x: 0, z: 0 }, this.managers?.mouths());
    this.blades?.update(this.camera.cam, this.time, b.pos, wd ? { x: wd.wind * Math.cos(wd.windDir), z: wd.wind * Math.sin(wd.windDir) } : { x: 0, z: 0 }, this.weather === 'snow' ? this.weatherFx.cover : 0);
    this.glare.update(this.camera.cam, this.glareK * Math.max(0, this.litNow));
    // The beams read best from low down; from high above (the intro fly-in) they would fog the pitch.
    const camY = this.camera.cam.position.y;
    this.haze.update(this.time, this.hazeK * Math.max(0.3, Math.min(1, 1.45 - camY / 55)), this.cine ? this.lightsOn : 1);
    // Before the first kick-off: the fan display goes up and the flares are lit as the teams come out.
    const waiting = view.half === 1 && view.clock < 0.5 && view.phase === 'kickoff' && view.score[0] + view.score[1] === 0;
    this.tifo.update(dt, this.time, waiting);
    this.smoke.update(dt, this.time, waiting, wd ? { x: wd.wind * Math.cos(wd.windDir), z: wd.wind * Math.sin(wd.windDir) } : { x: 0, z: 0 });
    const fw = flagWind(wd ? { x: wd.wind * Math.cos(wd.windDir), z: wd.wind * Math.sin(wd.windDir) } : undefined);
    this.clubFlags?.update(this.time, fw);
    this.cornerFlags?.update(dt, this.time, fw, { x: b.pos.x, y: b.pos.y, z: b.pos.z, vx: b.vel.x, vy: b.vel.y, vz: b.vel.z }, view.players.filter((p) => !p.off && Math.abs(Math.abs(p.pos.x) - 52.5) < 2 && Math.abs(Math.abs(p.pos.z) - 34) < 2).map((p) => ({ x: p.pos.x, z: p.pos.z, vx: p.vel.x, vz: p.vel.z })));
    this.updateDof(view, dt);
    this.updateFeed(view, dt);
    this.marks.flush(this.renderer);
    // The wet pitch's mirror image, drawn before the frame itself.
    if (this.grassU?.uReflOn && this.grassU.uRefl && this.grassU.uReflMat && this.glCheck.level < 2) {
      this.camera.cam.updateMatrixWorld();
      const on = this.wet.render(this.renderer, this.scene, this.camera.cam, wet);
      this.grassU.uReflOn.value = on ? this.reflGain : 0;
      if (on) { this.grassU.uRefl.value = this.wet.target!.texture; this.grassU.uReflMat.value.copy(this.wet.matrix); }
    }
    if (this.composer) this.composer.render();
    else if (this.dofW > 0.02 && this.glCheck.level < 2) {
      // Medium: blur round the focus, more for close shots (as a real lens), up to 1.4% of the screen.
      this.liteDof.render(this.renderer, this.scene, this.camera.cam, this.dofFocus, (4 / Math.max(4, this.dofFocus)) * this.dofW, 0.014 * this.dofW);
    } else this.renderer.render(this.scene, this.camera.cam);
    if (this.glCheck.afterFrame()) this.stepDownGraphics();
  }

  /** The browser refused some drawing: rebuild with the next safer level (shadows off, then plain drawing). */
  private stepDownGraphics() {
    if (this.grassU?.uReflOn) this.grassU.uReflOn.value = 0;
    this.applyGraphics(this.gfx);
    // Materials were built for the old set-up (shadow samplers and all): build them again.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) for (const x of m) x.needsUpdate = true; else if (m) m.needsUpdate = true;
    });
  }

  /** A team's captain on the pitch now (the armband; the first outfielder still on if he has gone off). */
  captainOf(view: ViewState, team: 0 | 1): number {
    const [teams] = this.matchArgs ?? [null];
    const ci = teams ? captainIndex(teams[team]) : 9;
    const id = team * 11 + ci;
    const p = view.players[id];
    if (p && !p.off && p.def.number === this.modelDefs[id]?.number) return id;
    return view.players.find((q) => q.team === team && !q.off && q.role !== 'GK')?.id ?? id;
  }

  /** Start the trophy ceremony for a team (confetti in its colours); the director then calls trophyLift. */
  startCeremony(team: 0 | 1, captain: number) {
    this.stopCeremony();
    const args = this.matchArgs;
    const kit = args ? args[0][team][args[1][team]] : null;
    this.ceremony = new Ceremony(QUALITY[this.gfx.preset], kit ? [kit.shirt, kit.second ?? kit.number] : [0xffffff, 0xd4af37]);
    this.ceremony.trophy.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = this.renderer.shadowMap.enabled; });
    this.scene.add(this.ceremony.group);
    this.ceremony.start();
    this.ceremonyCaptain = captain;
    this.ceremonyLift = 0;
    this.cineReactions = true;
  }

  /** How far the trophy has come up into the captain's hands (0..1). */
  trophyLift(k: number) { this.ceremonyLift = k; }

  stopCeremony() {
    this.cineReactions = false;
    if (!this.ceremony) return;
    this.scene.remove(this.ceremony.group);
    this.ceremony.dispose();
    this.ceremony = null;
  }

  /** The big screens' live pictures: Medium and up, unless Big screen is set to the scores only. */
  private updateFeed(view: ViewState, dt: number) {
    const q = QUALITY[this.gfx.preset];
    const arena = this.stadium?.userData.arena as Arena | undefined;
    if (q === 0 || this.gfx.bigScreen === 'scores' || !arena || this.glCheck.level >= 2) {
      if (this.feed) { this.feed.dispose(); this.feed = null; }
      return;
    }
    if (!this.feed || this.feed.quality !== q) { this.feed?.dispose(); this.feed = new BigScreenFeed(this.renderer, q); }
    // On Medium (the tablet default) the feed leaves the crowd out: the fans are most of the
    // stadium's triangles, and at 288 x 144 on a screen across the ground nobody misses them.
    if (this.feedHideFor !== arena || this.feedHideQ !== q) {
      const fans: THREE.Object3D[] = [];
      if (q <= 1) arena.group.traverse((o) => { if (o.name === 'fans') fans.push(o); });
      this.feedHide = [...arena.screenMeshes, ...fans];
      this.feedHideFor = arena;
      this.feedHideQ = q;
    }
    this.feed.update(this.renderer, this.scene, view, dt, Math.max(this.cheerT[0], this.cheerT[1]) > 1, this.feedHide, !this.cine);
  }

  private bigMomentsOn(cam?: CameraSettings) {
    return this.gfx.bigMoments !== false && !(cam ?? this.lastCam)?.reducedMotion;
  }
  private lastCam: CameraSettings | null = null;

  /** A big moment: shake the camera (0..1: 1 for a goal). Ignored with big moments off or reduced motion. */
  shake(amount: number) {
    if (!this.bigMomentsOn()) return;
    this.trauma = Math.min(1, Math.max(this.trauma, amount));
  }

  /** Current shake (0..1), for tests. */
  get shakeLevel() {
    return this.trauma;
  }

  /** Small, smooth turns of the match camera (squared trauma, so small knocks barely show). */
  private applyShake(dt: number, cam: CameraSettings) {
    this.lastCam = cam;
    if (this.trauma <= 0) return;
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
    if (this.cine || !this.bigMomentsOn(cam)) return;
    const k = this.trauma * this.trauma, t = this.time * 17 + this.shakeSeed;
    const n = (f: number, o: number) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.13 + o * 1.7) * 0.4;
    const c = this.camera.cam;
    c.rotateY(n(1, 0) * 0.012 * k);
    c.rotateX(n(1.1, 3) * 0.009 * k);
    c.rotateZ(n(0.8, 7) * 0.006 * k);
  }

  /** Depth of field: focus on the ball (or the scorer) in replays, highlights and goal celebrations. */
  private updateDof(view: ViewState, dt: number) {
    const q = QUALITY[this.gfx.preset];
    if (!this.bokeh && q !== 1) { this.dofW = 0; return; }
    const want = this.bigMomentsOn() && (!!this.cine || view.phase === 'goal') ? 1 : 0;
    this.dofW += (want - this.dofW) * Math.min(1, dt * 3);
    if (this.bokeh) this.bokeh.enabled = this.dofW > 0.02;
    if (this.dofW <= 0.02) return;
    const c = this.camera.cam;
    const b = view.ball.pos;
    // Close-ups focus on what the shot looks at (the players in the tunnel, the scorer, the
    // trophy); live celebrations on the scorer's group (nearest celebrating player to the camera
    // within 25 m of the ball); anything else on the ball.
    let focus = c.position.distanceTo(new THREE.Vector3(b.x, b.y, b.z));
    if (this.ceremony?.active) focus = c.position.distanceTo(this.ceremony.trophy.position);
    else if (this.cine) {
      const l = this.cine.look;
      const dl = c.position.distanceTo(new THREE.Vector3(l.x, l.y, l.z));
      // Replays look at the ball anyway; a shot looking past the action (a wide fly-in) keeps it sharp.
      if (dl < 40) focus = dl;
    } else {
      let best = Infinity;
      for (const p of view.players) {
        if (p.off || Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > 25 || p.action.type !== 'celebrate') continue;
        const d = c.position.distanceTo(new THREE.Vector3(p.pos.x, 1.2, p.pos.z));
        if (d < best) best = d;
      }
      if (best < Infinity) focus = best;
    }
    this.dofFocus = focus;
    if (!this.bokeh) return;
    const u = (this.bokeh as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
    u.focus.value = focus;
    // Wider apertures for close shots, as a real lens: keep the blur readable but not overpowering.
    u.aperture.value = (0.0001 + 0.003 / Math.max(4, focus)) * this.dofW;
    u.nearClip.value = c.near;
    u.farClip.value = c.far;
    u.maxblur.value = 0.009 * this.dofW;
  }

  private drawDebug(d?: DebugDraw) {
    this.debugGroup.clear();
    if (!d) return;
    const mat = [new THREE.MeshBasicMaterial({ color: 0xff3b3b }), new THREE.MeshBasicMaterial({ color: 0x3bb0ff })];
    const g = new THREE.SphereGeometry(0.25, 6, 4);
    for (const t of d.targets ?? []) { const m = new THREE.Mesh(g, mat[t.team]); m.position.set(t.x, 0.3, t.z); this.debugGroup.add(m); }
    const bg = new THREE.BoxGeometry(0.4, 0.05, 0.4);
    for (const f of d.formation ?? []) { const m = new THREE.Mesh(bg, mat[f.team]); m.position.set(f.x, 0.05, f.z); this.debugGroup.add(m); }
    if (d.shapes) {
      const cyl = new THREE.CylinderGeometry(0.36, 0.36, 1.82, 12, 1, true);
      const wm = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
      for (const p of this.players) { const m = new THREE.Mesh(cyl, wm); m.position.set(p.root.position.x, 0.91, p.root.position.z); this.debugGroup.add(m); }
    }
  }

  /**
   * Where to draw an arrow at the screen edge pointing at a pitch point that is off the screen (CSS
   * pixels, angle in radians, 0 = pointing right), or null while it is on the screen.
   */
  edgePoint(x: number, z: number, margin = 30): { x: number; y: number; angle: number } | null {
    const v = new THREE.Vector3(x, 1, z).project(this.camera.cam);
    const behind = v.z > 1;
    if (!behind && Math.abs(v.x) <= 0.98 && Math.abs(v.y) <= 0.96) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    let dx = v.x, dy = -v.y;
    if (behind) { dx = -dx; dy = -dy; }
    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) dy = 1;
    const hw = w / 2 - margin, hh = h / 2 - margin;
    // From the centre along (dx, dy) in pixels, to the first border it meets.
    const px = dx * (w / 2), py = dy * (h / 2);
    const k = Math.min(hw / Math.max(1e-6, Math.abs(px)), hh / Math.max(1e-6, Math.abs(py)));
    return { x: w / 2 + px * k, y: h / 2 + py * k, angle: Math.atan2(py, px) };
  }

  /** Flash the marker of the player control has just switched to. */
  flashSwitch(id: number) {
    this.flash = { id, t: 0 };
  }

  /** Project a world point to CSS pixels (for HUD elements such as the shot-power bar). */
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera.cam);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: v.z < 1 };
  }

  /** The point on the pitch under a screen position (CSS pixels), or null if the ray misses the ground. */
  groundPoint(cx: number, cy: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera.cam);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  /** An offside check on the big screens for a few seconds. */
  showVarCheck(info: VarInfo) {
    this.varScreen = { info, until: this.time + VAR.screen };
  }

  /** Height of the stand roofs (aerial shots). */
  get roofTop(): number {
    const a = this.stadium?.userData.arena as Arena | undefined;
    return a ? a.roofHeight + 3.5 : 30;
  }

  /** Where the players' tunnel is, for the walk-out shot. */
  tunnel(): TunnelInfo {
    return tunnelOf(this.stadium);
  }

  /** Show the inside of the tunnel (walk-out shot) or hide it again. */
  setTunnelShot(on: boolean) {
    this.tunnelSet.setActive(on, this.renderer, this.stadium);
  }

  /** Screenshot tests: show one player's face in a mood ('neutral', 'joy', 'effort', 'frustration'). */
  set faceTest(f: { id: number; mood: string } | null) {
    const map: Record<string, 'calm' | 'joy' | 'effort' | 'anger'> = { neutral: 'calm', joy: 'joy', effort: 'effort', frustration: 'anger' };
    this.players.forEach((p, i) => { if ('moodOverride' in p) (p as { moodOverride: string | null }).moodOverride = f && f.id === i ? map[f.mood] ?? 'calm' : null; });
  }

  /** Screenshot tests: keep the camera in front of this player's face. */
  faceFollow: { id: number; dist: number } | null = null;

  /** Screenshot tests: a camera in front of a realistic player's face. */
  faceView(id: number, dist = 0.7) {
    const p = this.players[id] as { faceView?: (d: number) => { pos: [number, number, number]; look: [number, number, number] } | null } | undefined;
    return p?.faceView?.(dist) ?? null;
  }

  /** Whether the celebration camera is handheld now (tests). */
  get handheldOn() {
    return this.gfx.handheld !== false && (!!this.liveCam || this.handheld.amount > 0);
  }

  /** A planned celebration shot as the handheld operator holds it (unchanged with the steady camera). */
  handheldShot(shot: CineShot, dt: number): CineShot {
    if (this.gfx.handheld === false) { this.handheld.amount = 0; return shot; }
    return this.handheld.shake(shot, dt, this.lastCam?.reducedMotion ? 0.35 : 1);
  }

  /** After a goal, where no celebration cinematic plays: cut to the pitchside camera on the scorers. */
  private updateLiveHandheld(view: ViewState, dt: number) {
    const was = !!this.liveCam;
    this.liveCam = null;
    if (!this.cine) this.handheld.amount = 0;
    if (view.phase !== 'goal') { this.goalT = 0; this.liveState.on = false; return; }
    this.goalT += dt;
    if (!this.liveHandheld || this.cine || this.viewOverride || this.gfx.handheld === false || this.goalT < HANDHELD.delay) return;
    const shot = pitchsideShot(view, this.goalTeam, this.liveState, dt);
    if (!shot) return;
    if (!was) this.handheld.reset();
    this.liveCam = this.handheld.shake(shot, dt, this.lastCam?.reducedMotion ? 0.35 : 1);
  }

  private applyCine() {
    const cam = this.camera.cam;
    const c = this.cine ?? this.liveCam;
    if (c) {
      cam.up.set(c.up?.x ?? 0, c.up?.y ?? 1, c.up?.z ?? 0);
      cam.position.set(c.pos.x, c.pos.y, c.pos.z);
      cam.lookAt(c.look.x, c.look.y, c.look.z);
      const near = c.near ?? 0.5;
      if (cam.fov !== c.fov || cam.near !== near) { cam.fov = c.fov; cam.near = near; cam.updateProjectionMatrix(); }
      this.cineOn = true;
    } else if (this.cineOn) {
      this.cineOn = false;
      cam.up.set(0, 1, 0);
      cam.near = 0.5;
      cam.updateProjectionMatrix();
      this.camera.resetLens();
    }
  }

  snapCamera(view: ViewState) {
    this.camera.snap(view);
  }

  info() {
    const i = this.renderer.info;
    return { calls: i.render.calls, tris: i.render.triangles };
  }

  dispose() {
    this.composer?.dispose();
    this.feed?.dispose();
    this.renderer.dispose();
  }
}
