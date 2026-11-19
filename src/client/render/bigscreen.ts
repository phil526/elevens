// The big screens' live pictures: a second, low-resolution TV camera follows play a few times a
// second and its frames are kept in a short ring, so after a goal the screens can replay the
// build-up slowed down. Medium renders 8 frames a second at 288 x 144, High and Ultra 12 at
// 384 x 192; Low (and Settings > Graphics > Big screen "Scores only") keeps the painted pages.
// Frames are stored in linear HDR (half float where the device can render it) and tone mapped
// when the screen is drawn, so the pictures match the broadcast.

import * as THREE from 'three';
import type { ViewState } from '../view';

export const FEED = {
  fps: [0, 8, 12, 12],
  size: [[0, 0], [288, 144], [384, 192], [384, 192]] as [number, number][],
  /** Seconds of play kept for the replay, how much longer it records after a goal, and the replay speed. */
  keep: 4.5, after: 1.2, slow: 0.5,
} as const;

export type FeedMode = 'live' | 'replay';

export class BigScreenFeed {
  readonly cam = new THREE.PerspectiveCamera(24, 2, 1, 700);
  private live: THREE.WebGLRenderTarget;
  private ring: THREE.WebGLRenderTarget[] = [];
  private head = 0; // next slot to write
  private filled = 0;
  private acc = 0;
  private readonly step: number;
  private look = new THREE.Vector3(0, 0, 0);
  private pos = new THREE.Vector3(0, 18, 46);
  private started = false;
  // Replay state: frames to play (oldest first), the playhead, and the countdown to freezing.
  private freezeIn = -1;
  private frozen = false;
  private playhead = -1;
  private frames: THREE.WebGLRenderTarget[] = [];
  // Copying a frame into the ring.
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quadMat = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, depthWrite: false });

  constructor(renderer: THREE.WebGLRenderer, readonly quality: number) {
    const [w, h] = FEED.size[quality] ?? FEED.size[1];
    this.step = 1 / (FEED.fps[quality] || 8);
    const ext = renderer.extensions;
    const half = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
    const opts = { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.live = new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: true });
    const n = Math.ceil(FEED.keep / this.step);
    for (let i = 0; i < n; i++) this.ring.push(new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: false }));
    this.quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.quadMat));
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
  }

  /** What the screens show now: the newest frame live, or the replay's current frame. */
  get texture(): THREE.Texture | null {
    if (this.playhead >= 0) return this.frames[Math.min(this.frames.length - 1, Math.floor(this.playhead))]?.texture ?? null;
    if (!this.filled) return null;
    return this.ring[(this.head - 1 + this.ring.length) % this.ring.length].texture;
  }

  get mode(): FeedMode { return this.playhead >= 0 ? 'replay' : 'live'; }
  get frameCount() { return this.filled; }
  get replaying() { return this.playhead >= 0; }

  /** A goal: keep recording a moment longer, then hold the frames for the replay. */
  goal() {
    if (this.frozen || this.playhead >= 0) return;
    this.freezeIn = FEED.after;
  }

  /** Back to live pictures (a new half, a restart of the match). */
  reset() {
    this.freezeIn = -1; this.frozen = false; this.playhead = -1; this.frames = []; this.filled = 0; this.started = false;
  }

  /**
   * Called once a frame before the main render. goalShowing: the screens are on their GOAL!
   * page (the replay starts once it ends). hide: meshes to leave out of the feed (the screens).
   * capture false (cinematics): keep the clock going but film nothing.
   */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, view: ViewState, dt: number, goalShowing: boolean, hide: THREE.Object3D[], capture = true) {
    // The camera: high on the near side, following the ball like the broadcast.
    const b = view.ball.pos;
    const tx = THREE.MathUtils.clamp(b.x, -40, 40), tz = THREE.MathUtils.clamp(b.z, -26, 26);
    const wantPos = new THREE.Vector3(tx * 0.72, 19, 50);
    const wantLook = new THREE.Vector3(tx, 0.5, tz * 0.65);
    const k = this.started ? Math.min(1, dt * 2.5) : 1;
    this.started = true;
    this.pos.lerp(wantPos, k);
    this.look.lerp(wantLook, k);
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    const zoomed = 24 - Math.min(6, Math.abs(tx) / 8);
    if (Math.abs(this.cam.fov - zoomed) > 0.05) { this.cam.fov = zoomed; this.cam.updateProjectionMatrix(); }

    if (this.freezeIn >= 0) {
      this.freezeIn -= dt;
      if (this.freezeIn < 0) {
        this.frozen = true;
        this.frames = [];
        for (let i = 0; i < this.filled; i++) this.frames.push(this.ring[(this.head - this.filled + i + this.ring.length * 2) % this.ring.length]);
      }
    }
    if (this.frozen && !goalShowing && this.playhead < 0 && this.frames.length) this.playhead = 0;
    if (this.playhead >= 0) {
      this.playhead += (dt / this.step) * FEED.slow;
      if (this.playhead >= this.frames.length + 6) { // hold the last frame briefly
        this.playhead = -1; this.frozen = false; this.frames = []; this.filled = 0;
      }
      return;
    }
    if (this.frozen || !capture) return;
    this.acc += dt;
    if (this.acc < this.step) return;
    this.acc = Math.min(this.acc - this.step, this.step);
    this.capture(renderer, scene, hide);
  }

  private capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, hide: THREE.Object3D[]) {
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const prevTarget = renderer.getRenderTarget();
    const autoShadow = renderer.shadowMap.autoUpdate;
    // The shadow maps were drawn for this frame's main view already (or will be): reuse them.
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.live);
    renderer.render(scene, this.cam);
    // Copy into the ring.
    this.quadMat.map = this.live.texture;
    const slot = this.ring[this.head];
    renderer.setRenderTarget(slot);
    renderer.render(this.quadScene, this.quadCam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoShadow;
    hide.forEach((o, i) => (o.visible = vis[i]));
    this.head = (this.head + 1) % this.ring.length;
    this.filled = Math.min(this.ring.length, this.filled + 1);
  }

  dispose() {
    this.live.dispose();
    for (const r of this.ring) r.dispose();
    this.quadMat.dispose();
  }
}
