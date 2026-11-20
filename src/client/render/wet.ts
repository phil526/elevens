// A wet pitch that mirrors the floodlights, the sky and the players (High and Ultra, in the rain):
// a second, smaller render of just the players, the ball, the floodlights and the sky, seen from
// below the pitch (a mirror camera, as three's Reflector does), which the grass shader blends in
// where the pitch is wet, most of all in the puddles, rippled by the rain.
// Medium and Low keep the cheaper floodlight glints in the grass shader (render/vfx.ts).

import * as THREE from 'three';

/** Render layer for things that show in the wet pitch. */
export const REFLECT_LAYER = 3;

/** Share of the screen's resolution the reflection is drawn at, by quality. */
export const REFLECT_SCALE = [0, 0, 0.4, 0.5] as const;

export class WetReflection {
  target: THREE.WebGLRenderTarget | null = null;
  readonly matrix = new THREE.Matrix4();
  private cam = new THREE.PerspectiveCamera();
  private scale = 0;
  /** Frames drawn (tests). */
  frames = 0;

  setQuality(q: number) {
    this.scale = REFLECT_SCALE[Math.max(0, Math.min(3, q))];
    if (!this.scale) { this.target?.dispose(); this.target = null; }
  }

  get enabled() {
    return this.scale > 0;
  }

  /**
   * Mark an object (and everything in it) as showing in the wet pitch. Floodlights never do (lamp
   * meshes, their glow sprites): the roof's light strip and lamp panels came out as sharp white
   * bars across the pitch, drawn four times over by the smear. The grass shader's soft floodlight
   * glints stand in for them.
   */
  static show(o: THREE.Object3D) {
    o.traverse((c) => { if (!c.userData.lamp && !c.userData.noReflect) c.layers.enable(REFLECT_LAYER); });
  }

  /**
   * Draw the reflection for this frame's camera. Shadows are not redrawn for it.
   * Returns false when there is nothing to draw (dry pitch, Medium or Low).
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, wet: number): boolean {
    if (!this.scale || wet < 0.02) return false;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(size.x * this.scale)), h = Math.max(64, Math.round(size.y * this.scale));
    if (!this.target) this.target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, generateMipmaps: false });
    else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    // The camera mirrored in the pitch (y = 0): the same view seen from below the ground.
    const cp = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(cp);
    const vc = this.cam;
    vc.position.set(cp.x, -cp.y, cp.z);
    vc.up.set(0, 1, 0).applyMatrix4(rot);
    vc.up.y = -vc.up.y;
    vc.lookAt(look.x, -look.y, look.z);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    vc.layers.set(REFLECT_LAYER);
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    const prev = renderer.getRenderTarget();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, vc);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadows;
    this.frames++;
    return true;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
  }
}
