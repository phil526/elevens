// Depth of field for Medium (High and Ultra use the composer's BokehPass): during close-ups,
// replays and celebrations the frame is drawn into a texture with its depth, then one full-screen
// pass blurs what is nearer or further than the focus, tone maps it and puts it on screen.
// Costs nothing in normal play, which draws straight to the screen as before.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const FS = /* glsl */ `
#include <common>
#include <packing>
uniform sampler2D tColor, tDepth;
uniform float uFocus, uAperture, uMaxBlur, uNear, uFar, uAspect;
varying vec2 vUv;
float viewZ(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar); }
float coc(float z) { return clamp(abs(z - uFocus) / max(z, 0.05) * uAperture, 0.0, 1.0); }
void main() {
  float c0 = coc(viewZ(vUv));
  vec4 acc = vec4(texture2D(tColor, vUv).rgb, 1.0);
  float rad = c0 * uMaxBlur;
  if (rad > 0.0004) {
    // A golden-angle spiral of taps; each weighted by how blurred it is itself, so sharp things
    // in focus do not smear into the soft background around them.
    for (int i = 1; i < 20; i++) {
      float fi = float(i);
      float r = sqrt(fi / 19.0) * rad;
      float a = fi * 2.39996;
      vec2 uv = vUv + vec2(cos(a) / uAspect, sin(a)) * r;
      float w = max(coc(viewZ(uv)), 0.04);
      acc += vec4(texture2D(tColor, uv).rgb * w, w);
    }
  }
  gl_FragColor = vec4(acc.rgb / acc.a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class LiteDof {
  private target: THREE.WebGLRenderTarget | null = null;
  private mat = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null },
      uFocus: { value: 10 }, uAperture: { value: 0.5 }, uMaxBlur: { value: 0.012 },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uAspect: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: FS,
    depthTest: false, depthWrite: false,
  });
  private quad = new FullScreenQuad(this.mat);
  /** Frames drawn with the blur (tests). */
  frames = 0;

  /**
   * Draw the scene with depth of field. `focus` in metres from the camera; `aperture` how quickly
   * things go soft away from it; `maxBlur` the widest blur as a share of the screen height.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, focus: number, aperture: number, maxBlur: number) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.target) {
      const depth = new THREE.DepthTexture(size.x, size.y);
      depth.type = THREE.UnsignedIntType;
      this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4, depthTexture: depth, generateMipmaps: false });
    } else if (this.target.width !== size.x || this.target.height !== size.y) this.target.setSize(size.x, size.y);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
    const u = this.mat.uniforms;
    u.tColor.value = this.target.texture;
    u.tDepth.value = this.target.depthTexture;
    u.uFocus.value = focus; u.uAperture.value = aperture; u.uMaxBlur.value = maxBlur;
    u.uNear.value = camera.near; u.uFar.value = camera.far; u.uAspect.value = size.x / Math.max(1, size.y);
    this.quad.render(renderer);
    this.frames++;
  }

  /** Free the frame texture (quality changed away from Medium). */
  dispose() {
    this.target?.dispose();
    this.target = null;
  }
}
