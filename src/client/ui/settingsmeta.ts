// Settings tidy-up (21 Nov 2026): a one-line explanation under each option, a "Reset" per
// section, and a mark on anything changed from the default. The longer notes now sit under
// "More about these settings" at the end of each section.

import type { Settings } from '../settings';

export interface SettingSection {
  id: 'audio' | 'graphics' | 'camera' | 'gameplay' | 'app';
  name: string;
  /** The settings a Reset puts back to their defaults (dotted paths into Settings). */
  paths: string[];
}

export const SETTING_SECTIONS: SettingSection[] = [
  { id: 'audio', name: 'Audio', paths: ['audio.master', 'audio.effects', 'audio.crowd', 'audio.music', 'audio.musicOn', 'audio.commentary', 'audio.announcer', 'audio.menuSounds', 'audio.muted', 'commentator'] },
  { id: 'graphics', name: 'Graphics', paths: ['graphics.preset', 'graphics.renderScale', 'graphics.autoRes', 'graphics.batterySaver', 'showFps', 'graphics.shadows', 'graphics.players', 'graphics.matchTime', 'graphics.weather', 'wind', 'graphics.wear', 'graphics.sharpen', 'graphics.tvGrade', 'graphics.bigScreen', 'graphics.mowing', 'tvGraphics', 'menuBackdrop'] },
  { id: 'camera', name: 'Camera', paths: ['camera.mode', 'camera.height', 'camera.zoom', 'matchIntro', 'ceremony', 'celebrations', 'graphics.handheld', 'goalReplays', 'varChecks', 'cutaways', 'aerials', 'highlights', 'graphics.bigMoments', 'camera.setPiece', 'camera.reducedMotion'] },
  { id: 'gameplay', name: 'Gameplay', paths: ['mouseControl', 'switchStyle', 'autoSwitch', 'switchSens', 'switchCue', 'quickRestarts', 'receiver', 'passAssist', 'shotAssist', 'momentum', 'habits', 'stickSwitch', 'rumble', 'playerRing', 'showNextMarker', 'controlHints', 'restartCaptions', 'highContrast', 'colourVision', 'textSize', 'chargeSpeed', 'sprintToggle', 'tips'] },
  { id: 'app', name: 'App', paths: [] },
];

/** One line under each option, keyed by its control (r: for a slider). */
export const SETTING_DESC: Record<string, string> = {
  'r:master': 'Everything at once.',
  'r:effects': 'Kicks, whistles, the woodwork and menu sounds.',
  'r:crowd': 'The stadium: chants, roars, oohs and rain.',
  'r:music': 'How loud the title music plays on the menus.',
  music: 'Title music on the menus (it fades out for matches).',
  commentator: 'Captions of what happens, and whether a voice reads them.',
  commentary: 'The recorded commentator for goals, saves and more.',
  announcer: 'Welcome and team line-ups before kick-off.',
  menusfx: 'Ticks and clicks as you move around the menus.',
  mute: 'All sound off.',
  preset: 'Lower is smoother on older phones and tablets.',
  'r:scale': 'Below 1 draws fewer pixels for speed; above 1 is sharper.',
  autores: 'Drops the resolution a little when play gets slow.',
  battery: '30 frames a second, cooler and longer-lasting.',
  showfps: 'Frames per second in the corner of a match.',
  shadows: 'Players and the stadium cast shadows.',
  players: 'Detailed real-looking players or simple fast ones.',
  matchTime: 'Daylight, sunset or floodlights.',
  weather: 'Rain and snow change how the ball plays.',
  wind: 'Wind bends long balls and shots.',
  wear: 'The pitch scuffs up and kits get muddy as the match goes on.',
  sharpen: 'Crisper edges on the players and the lines.',
  tvgrade: 'Colours like a TV broadcast.',
  bigscreen: 'The stadium screens show the match live, or just the score.',
  mowing: 'The stripes cut into the grass.',
  tvg: 'Score bug, line-ups and stats in TV style.',
  menubg: 'A live match plays behind the menus.',
  cmode: 'Where the match camera sits.',
  height: 'How high the camera is.',
  zoom: 'How close the camera is.',
  intro: 'Fly-in over the stadium and the tunnel walk-out.',
  ceremony: 'Mascots, handshakes and team photos.',
  celebs: 'A short scene after each goal.',
  handheld: 'The celebration camera moves like a real cameraman.',
  replays: 'Each goal again from inside the net.',
  varchk: 'Close offside goals are checked with lines.',
  cutaways: 'Shots of the managers and crowd at stoppages.',
  aerials: 'Views from the blimp at half-time.',
  hlights: 'The best moments at half-time and full time.',
  bigm: 'Slow motion, camera shake and a split-second freeze on big moments.',
  spcam: 'Behind the ball for penalties and free kicks.',
  reduced: 'Calmer camera with no shake or sweeping moves.',
  mctl: 'Steer with the mouse pointer on a PC.',
  auto: 'When control jumps to a better-placed defender.',
  swsens: 'How quickly automatic switching reacts.',
  swcue: 'A flash and a blip when control changes player.',
  quick: 'Take throw-ins and free kicks before the other side is set.',
  recv: 'Control switches to the receiver early or as the ball arrives.',
  assist: 'How much help passes get with aim and power.',
  sassist: 'Help aiming shots, or exactly where the stick points.',
  mom: 'A lift for your side when the home crowd gets going.',
  habits: 'The computer adapts to how you attack.',
  sswitch: 'Right-stick switching picks from your player or the ball.',
  rumble: 'The controller shakes for shots, tackles and goals.',
  pring: 'A ring under the player you control.',
  nextm: 'Marks who you would switch to next.',
  chints: 'Button reminders along the bottom of a match.',
  rcap: 'Big captions for throw-ins, corners and goal kicks.',
  hc: 'Bolder outlines on markers and the score.',
  cvd: 'Kits that stay easy to tell apart.',
  tsize: 'Bigger text in menus and the match screen.',
  charge: 'More time to power up kicks.',
  stoggle: 'Hold to sprint, or press once to start and stop.',
  tips: 'A short card the first time each situation comes up.',
};

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

/** Put a section's settings back to the defaults (an option missing from the defaults is removed, so its own default applies). */
export function resetSection(s: Settings, d: Settings, id: SettingSection['id']): void {
  const sec = SETTING_SECTIONS.find((x) => x.id === id);
  if (!sec) return;
  for (const path of sec.paths) {
    const keys = path.split('.');
    const last = keys.pop()!;
    const parent = keys.reduce<Record<string, unknown>>((x, k) => (x[k] ??= {}) as Record<string, unknown>, s as unknown as Record<string, unknown>);
    const v = getPath(d, path);
    if (v === undefined) delete parent[last];
    else parent[last] = typeof v === 'object' && v ? JSON.parse(JSON.stringify(v)) : v;
  }
}
