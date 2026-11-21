// Goal clips (19 Nov 2026): save your best goals from the full-time screen, watch them again from
// the main menu (match camera, then slow motion from inside the net), and share them as a video
// (recorded from the game's own canvas; the share sheet on iPad, a download on a PC).
//
// A clip is the recorded play (the same snapshots the goal replays use, thinned to 20 a second)
// plus the two clubs and kits, so it plays back in the stadium with the right shirts and names.
// Clips live in IndexedDB on this device.

import type { CameraSettings } from '../render/camera';
import { ReplayRecorder, netCamShot, goalSideOf, stageReplay, type Snap } from '../render/cinematic';
import type { GameRenderer } from '../render/renderer';
import type { ViewState } from '../view';
import * as THREE from 'three';

export interface GoalClip {
  id: string;
  date: string;
  /** "Okafor 23'" and "Rivertown 2–1 Harbour City". */
  title: string;
  sub: string;
  /** Recorder time of the goal itself. */
  tg: number;
  base: ViewState;
  snaps: Snap[];
  /** The save slot (profile) it belongs to; clips saved before 21 Nov 2026 have none and count as the first slot's. */
  slot?: number;
}

/** Clips of one save slot (each profile has its own My goals). */
export const clipsOfSlot = (all: GoalClip[], slot: number) => all.filter((c) => (c.slot ?? 0) === slot);

export const CLIP_MAX = 40;
const DB = 'elevens-clips', STORE = 'clips';

function open(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    if (typeof indexedDB === 'undefined') { fail(new Error('No storage')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error ?? new Error('Storage blocked'));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((ok, fail) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
    t.oncomplete = () => db.close();
  });
}

export async function listClips(slot?: number): Promise<GoalClip[]> {
  try {
    const all = await tx<GoalClip[]>('readonly', (s) => s.getAll() as IDBRequest<GoalClip[]>);
    return (slot === undefined ? all : clipsOfSlot(all, slot)).sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch { return []; }
}

/** Delete every clip of a save slot (the slot was deleted). */
export async function deleteSlotClips(slot: number): Promise<void> {
  for (const c of await listClips(slot)) await deleteClip(c.id);
}

export async function saveClip(c: GoalClip): Promise<boolean> {
  try {
    const all = await listClips();
    if (all.length >= CLIP_MAX) return false;
    await tx('readwrite', (s) => s.put(c));
    return true;
  } catch { return false; }
}

export async function deleteClip(id: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
}

/** A clip from a highlight of the match that has just been played. */
export function makeClip(live: ViewState, clip: ReplayRecorder, tg: number, title: string, sub: string, slot = 0): GoalClip {
  const snaps = clip.snapshots();
  // About 20 snapshots a second is plenty (playback interpolates between them).
  const thin: Snap[] = [];
  for (const s of snaps) if (!thin.length || s.t - thin[thin.length - 1].t >= 0.048 || s === snaps[snaps.length - 1]) thin.push(s);
  const base = JSON.parse(JSON.stringify({ ...live, ratings: undefined, stats: live.stats })) as ViewState;
  return { id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, date: new Date().toISOString(), title, sub, tg, base, snaps: JSON.parse(JSON.stringify(thin)), slot };
}

const CLIP = { slow: 0.55, after: 1.2, beforeNet: 3.2 } as const;

/**
 * Plays a clip in the stadium: first as it happened from the match camera, then again in slow
 * motion from inside the net. Driven from the app's frame loop while no match is running.
 */
export class ClipTheatre {
  clip: GoalClip | null = null;
  private rec: ReplayRecorder | null = null;
  private t = 0;
  private pass: 0 | 1 = 0;
  private look = new THREE.Vector3();
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  /** Called when the clip ends (after both passes); with the video when it was being recorded. */
  onEnd: (video: Blob | null) => void = () => {};

  get playing() { return !!this.clip; }

  start(c: GoalClip, r: GameRenderer, record = false) {
    this.clip = c;
    this.rec = ReplayRecorder.of(c.snaps);
    this.pass = 0;
    this.t = this.rec.first;
    this.look.set(0, 0, 0);
    r.setupMatch([c.base.teams[0], c.base.teams[1]], c.base.kits, c.base.weather);
    const first = this.rec.at(this.t);
    if (first) r.snapCamera(stageReplay(c.base, first));
    this.chunks = [];
    this.recorder = null;
    if (record) this.startRecording(r);
  }

  private startRecording(r: GameRenderer) {
    const canvas = r.renderer.domElement as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream };
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') return;
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
    try {
      const rec = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      rec.start(250);
      this.recorder = rec;
    } catch { this.recorder = null; }
  }

  stop() {
    const rec = this.recorder;
    this.recorder = null;
    this.clip = null;
    this.rec = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => this.onEnd(this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType || 'video/webm' }) : null);
      rec.stop();
    } else this.onEnd(null);
  }

  /** One frame; false once the clip is over. */
  frame(r: GameRenderer, dt: number, cam: CameraSettings): boolean {
    const c = this.clip, rec = this.rec;
    if (!c || !rec) return false;
    const end = Math.min(rec.last, c.tg + CLIP.after);
    if (this.pass === 0) {
      this.t += dt;
      if (this.t >= end) { this.pass = 1; this.t = Math.max(rec.first, c.tg - CLIP.beforeNet); this.look.set(0, 0, 0); }
    } else {
      this.t += dt * CLIP.slow;
      if (this.t >= end) { this.stop(); r.cine = null; return false; }
    }
    const s = rec.at(this.t);
    if (!s) return false;
    const view = stageReplay(c.base, s);
    if (this.pass === 1) {
      const g = rec.at(c.tg) ?? s;
      const { side, z } = goalSideOf(g.ball.pos);
      r.cine = netCamShot(side, z, s.ball.pos, this.look, dt);
    } else r.cine = null;
    r.render(view, this.pass === 1 ? dt * CLIP.slow : dt, cam, { localTeams: [], receiver: -1, showNext: false, playerRing: false, highContrast: false });
    return true;
  }

  /** Which part is showing (for the caption). */
  get part(): string { return this.pass === 0 ? 'As it happened' : 'From the net'; }
}

/** Shares a recorded video (the share sheet where the browser has one), or downloads it. */
export async function shareVideo(video: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const ext = video.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([video], `${name.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'elevens-goal'}.${ext}`, { type: video.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title: name, text: `${name} · ELEVENS` }); return 'shared'; } catch (e) { if ((e as Error).name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}
