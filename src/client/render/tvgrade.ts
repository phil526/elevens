// The TV look: the colour a football broadcast has. Built into the tone mapping every material
// already runs (three's CustomToneMapping hook), so it costs nothing extra on any quality level:
// ACES filmic, then softer, slightly lifted shadows, a gentle highlight roll-off, richer
// mid-tone colour (the grass and kits), warm highlights and cool shadows. On High and Ultra the
// renderer also adds a soft glow (lower bloom threshold) and softer shadow edges everywhere.

import * as THREE from 'three';

/** The grade's strengths (display-referred, 0..1). */
export const TV_GRADE = { lift: 0.022, toe: 0.55, contrast: 1.05, sat: 1.1, warm: 0.014, cool: 0.016, shoulder: 0.9 } as const;

const GLSL = /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
  vec3 c = ACESFilmicToneMapping( color );
  // Work in a display-like curve.
  vec3 g = pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  float l = dot( g, vec3( 0.2126, 0.7152, 0.0722 ) );
  // Softer shadows: lift the toe a little without greying the blacks.
  g += ${TV_GRADE.lift.toFixed(3)} * ( 1.0 - smoothstep( 0.0, ${TV_GRADE.toe.toFixed(2)}, l ) ) * ( 0.4 + 0.6 * smoothstep( 0.0, 0.08, l ) );
  // A broadcast S-curve round the mid-tones, rolling off gently into the highlights.
  g = mix( g, ( g - 0.5 ) * ${TV_GRADE.contrast.toFixed(3)} + 0.5, 1.0 - smoothstep( 0.6, 1.0, l ) );
  g = mix( g, ${TV_GRADE.shoulder.toFixed(3)} + ( g - ${TV_GRADE.shoulder.toFixed(3)} ) * 0.6, step( ${TV_GRADE.shoulder.toFixed(3)}, g ) );
  // Richer colour in the mid-tones (grass, kits, the crowd), not in the near-whites.
  l = dot( g, vec3( 0.2126, 0.7152, 0.0722 ) );
  float midK = smoothstep( 0.05, 0.35, l ) * ( 1.0 - smoothstep( 0.75, 1.0, l ) );
  g = mix( vec3( l ), g, 1.0 + ( ${TV_GRADE.sat.toFixed(3)} - 1.0 ) * midK );
  // Warm highlights, cool shadows.
  float hi = smoothstep( 0.45, 0.95, l ), lo = 1.0 - smoothstep( 0.05, 0.45, l );
  g += vec3( ${TV_GRADE.warm.toFixed(3)}, ${(TV_GRADE.warm * 0.35).toFixed(4)}, -${TV_GRADE.warm.toFixed(3)} ) * hi + vec3( -${(TV_GRADE.cool * 0.5).toFixed(4)}, 0.0, ${TV_GRADE.cool.toFixed(3)} ) * lo;
  return pow( clamp( g, 0.0, 1.0 ), vec3( 2.2 ) );
}`;

let patched = false;
let ok = false;
/** Swap three's empty CustomToneMapping for the TV grade (once, before any shader compiles). */
export function installTvGrade() {
  if (patched) return;
  patched = true;
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  if (chunk.includes(stub)) { THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, GLSL); ok = true; }
  else console.warn('[tvgrade] tone mapping hook not found; using plain ACES');
}

/** The tone mapping to use: the TV grade, or plain ACES filmic. */
export function toneMappingFor(tv: boolean): THREE.ToneMapping {
  installTvGrade();
  return tv && ok ? THREE.CustomToneMapping : THREE.ACESFilmicToneMapping;
}
