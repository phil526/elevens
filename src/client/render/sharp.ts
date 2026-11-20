// Sharper picture (Settings > Graphics "Sharper picture", default on).
//
// Low and Medium used to draw straight to the screen: on Low with no smoothing at all (jagged
// edges on lines, posts and players), and on phones and tablets at a lower resolution than the
// screen, which the browser then stretches (soft). With this on, the frame is drawn into a
// multisampled texture (4x smoothing, which phone and tablet GPUs do almost for free), then one
// full-screen pass tone maps it and sharpens it with contrast-adaptive sharpening (CAS): edges
// get crisper, flat areas are left alone, and already-bright detail isn't pushed into halos.
// High and Ultra already draw through the post-processing chain; there the same sharpening is
// folded into the colour grade pass (vfx.ts GradeShader), so it adds no pass.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** How hard each quality sharpens (0 none .. 1 strongest); lower resolutions get more. */
export const SHARPEN = { low: 0.62, medium: 0.48, high: 0.34, ultra: 0.3, perLostRes: 0.6, max: 0.85 } as const;

/** Sharpening strength for a quality and the share of the resolution being drawn (auto resolution). */
export function sharpenFor(preset: 'low' | 'medium' | 'high' | 'ultra', resScale = 1): number {
  const base = SHARPEN[preset];
  return Math.min(SHARPEN.max, base + Math.max(0, 1 - resScale) * SHARPEN.perLostRes);
}

/**
 * Contrast-adaptive sharpening on five taps (centre and its four neighbours, display-ready
 * colours 0..1). `s` 0..1. The weight shrinks where the neighbourhood is already near black or
 * white, so it never rings.
 */
export const CAS_GLSL = /* glsl */ `
vec3 casSharpen(vec3 c, vec3 n, vec3 w, vec3 e, vec3 s, float k) {
  vec3 mn = min(min(min(n, w), min(e, s)), c);
  vec3 mx = max(max(max(n, w), max(e, s)), c);
  vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
  vec3 wt = amp * (-1.0 / mix(8.0, 5.0, clamp(k, 0.0, 1.0)));
  return clamp((c + (n + w + e + s) * wt) / (1.0 + 4.0 * wt), 0.0, 1.0);
}`;

const FS = /* glsl */ `
#include <common>
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSharp;
varying vec2 vUv;
${CAS_GLSL}
vec3 shown(vec2 uv) {
  vec3 c = texture2D(tColor, uv).rgb;
  #if defined( TONE_MAPPING )
  c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
void main() {
  vec3 c = shown(vUv);
  if (uSharp > 0.001) {
    c = casSharpen(c, shown(vUv + vec2(0.0, uTexel.y)), shown(vUv - vec2(uTexel.x, 0.0)), shown(vUv + vec2(uTexel.x, 0.0)), shown(vUv - vec2(0.0, uTexel.y)), uSharp);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/** Low and Medium: draw the frame smoothed (MSAA) into a texture, then tone map + sharpen it onto the screen. */
export class SharpPass {
  private target: THREE.WebGLRenderTarget | null = null;
  private mat = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) }, uSharp: { value: 0.5 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FS,
    depthTest: false, depthWrite: false,
  });
  private quad = new FullScreenQuad(this.mat);
  /** Frames drawn through the pass (tests). */
  frames = 0;
  /** Strength used for the last frame (tests). */
  strength = 0;
  /** Smoothing samples for the frame texture (4x; 0 turns the smoothing off and only sharpens). */
  samples = 4;

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, strength: number) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.target && this.target.samples !== this.samples) this.dispose();
    if (!this.target) {
      this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.samples, generateMipmaps: false });
    } else if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(size.x, size.y);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    const u = this.mat.uniforms;
    u.tColor.value = this.target.texture;
    u.uTexel.value.set(1 / size.x, 1 / size.y);
    u.uSharp.value = strength;
    this.quad.render(renderer);
    this.frames++;
    this.strength = strength;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
  }
}
