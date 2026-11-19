// Match weather in the simulation: what it does to the ball and the players. The look of it
// (falling rain and snow, wet grass) lives in client/render/weather.ts and follows this.
//
// Rain: a wet, fast surface. The ball skids on when it lands and rolls further, keepers find it
// harder to hold, and slide tackles carry. Snow: a heavy, slow pitch where the ball holds up and
// players are a touch slower to get going. Wind pushes the ball while it is in the air, so long
// balls, crosses and shots drift; nobody on the pitch allows for it.

import { BALL } from './config';
import type { BallEnv } from './ball';

export type WeatherKind = 'clear' | 'rain' | 'snow';

export interface MatchWeather {
  kind: WeatherKind;
  wind: number; // m/s
  windDir: number; // radians, world x/z: the direction the wind blows towards
}

export const CLEAR_WEATHER: MatchWeather = { kind: 'clear', wind: 0, windDir: 0 };

/** Chances for Random weather: mostly dry, rain often, snow now and then. */
export function rollWeatherKind(r: number): WeatherKind {
  return r < 0.55 ? 'clear' : r < 0.85 ? 'rain' : 'snow';
}

/** Wind for a match: rain brings the strongest, snow and dry days are calmer. `r1`, `r2` are 0..1 draws. */
export function rollWind(kind: WeatherKind, r1: number, r2: number): { wind: number; windDir: number } {
  const max = kind === 'rain' ? 8 : kind === 'snow' ? 5 : 6;
  const min = kind === 'rain' ? 1.5 : 0;
  return { wind: Math.round((min + (max - min) * r1 * r1) * 10) / 10, windDir: Math.round((r2 * 2 * Math.PI - Math.PI) * 100) / 100 };
}

/** Repair a weather object from a config or the network. */
export function cleanWeather(w: unknown): MatchWeather {
  const o = (w && typeof w === 'object' ? w : {}) as Partial<MatchWeather>;
  const kind: WeatherKind = o.kind === 'rain' || o.kind === 'snow' ? o.kind : 'clear';
  const wind = typeof o.wind === 'number' && Number.isFinite(o.wind) ? Math.max(0, Math.min(10, o.wind)) : 0;
  const windDir = typeof o.windDir === 'number' && Number.isFinite(o.windDir) ? o.windDir : 0;
  return { kind, wind, windDir };
}

/** How the weather changes the ball's physics. */
export function weatherEnv(w: MatchWeather | undefined): BallEnv {
  const k = w?.kind ?? 'clear';
  const wind = w?.wind ?? 0, a = w?.windDir ?? 0;
  const wx = wind * Math.cos(a), wz = wind * Math.sin(a);
  if (k === 'rain') return { wx, wz, roll: BALL.rollDecel * 0.72, restitution: BALL.restitution * 0.9, bounceFriction: 0.95 };
  if (k === 'snow') return { wx, wz, roll: BALL.rollDecel * 1.45, restitution: BALL.restitution * 0.72, bounceFriction: 0.74 };
  return { wx, wz, roll: BALL.rollDecel, restitution: BALL.restitution, bounceFriction: BALL.bounceFriction };
}

/** How the weather changes the players: acceleration, top speed, keepers holding on, slide length. */
export interface WeatherPlay {
  accel: number;
  speed: number;
  turn: number;
  catch: number; // multiplier on a keeper's chance to hold a shot rather than parry it
  slide: number; // slide-tackle speed
  control: number; // extra first-touch difficulty (subtracted from the clean-control chance)
}
export function weatherPlay(w: MatchWeather | undefined): WeatherPlay {
  const k = w?.kind ?? 'clear';
  if (k === 'rain') return { accel: 0.95, speed: 1, turn: 0.93, catch: 0.8, slide: 1.15, control: 0.05 };
  if (k === 'snow') return { accel: 0.9, speed: 0.97, turn: 0.9, catch: 0.92, slide: 0.9, control: 0.04 };
  return { accel: 1, speed: 1, turn: 1, catch: 1, slide: 1, control: 0 };
}

/** "Strong wind", "Light breeze" ... for the line-ups and HUD. */
export function windText(wind: number): string {
  return wind < 1 ? 'Still' : wind < 3 ? 'Light breeze' : wind < 5 ? 'Breezy' : wind < 6.5 ? 'Windy' : 'Strong wind';
}
