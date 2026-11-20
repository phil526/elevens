import type * as THREE from 'three';

/**
 * Graphics self-check (20 Nov 2026). Chrome on Windows draws through Direct3D, which refuses some
 * WebGL draws that other systems let through: a whole match came out black on Philip's PC while the
 * score and radar carried on. Nothing showed in our cloud test browsers. So the game now watches for
 * refused draws itself, steps down to simpler drawing when it sees them, remembers that for this
 * browser and graphics chip, and says what happened in Settings > Graphics.
 *
 * Levels: 0 everything on; 1 shadows off; 2 also no post-processing, depth of field, wet-pitch
 * mirror or live big-screen pictures.
 */
export const GL_SAFE_MAX = 2;
const KEY = 'elevens.glsafe.v1';

export const glStatus = {
  renderer: '',
  level: 0,
  /** Refused draws seen since the page opened. */
  errors: 0,
  shaderErrors: 0,
  lost: false,
  lastError: 0,
  detail: '',
};

function load(renderer: string): number {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { level?: number; renderer?: string } | null;
    // Another browser or graphics chip starts again from everything on.
    if (s && s.renderer === renderer) return Math.max(0, Math.min(GL_SAFE_MAX, s.level ?? 0));
  } catch { /* storage blocked: start from everything on */ }
  return 0;
}

function save(level: number, renderer: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ level, renderer, at: new Date().toISOString() })); } catch { /* fine */ }
}

/** What Settings > Graphics says about the check. */
export function glStatusText(): string {
  const s = glStatus;
  const chip = s.renderer ? ` (${s.renderer})` : '';
  if (s.lost) return `Graphics check: the browser stopped the 3D view${chip}. Reloading the page usually brings it back.`;
  if (s.level === 0 && !s.errors && !s.shaderErrors) return `Graphics check: no drawing problems${chip}.`;
  const what = s.level >= 2 ? 'shadows, post-processing, depth of field, the wet-pitch mirror and the live big-screen pictures are off'
    : s.level === 1 ? 'shadows are off' : 'nothing was changed';
  const err = s.shaderErrors ? `${s.shaderErrors} shader${s.shaderErrors === 1 ? '' : 's'} failed to build` : `the browser refused some drawing (WebGL error ${s.lastError || '?'})`;
  return `Graphics check: ${err}${chip}, so ${what} on this computer.${s.detail ? ` ${s.detail}` : ''}`;
}

export class GlCheck {
  level = 0;
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  private frames = 0;
  private bad = 0;

  constructor(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.gl = renderer.getContext();
    let name = '';
    try {
      const ext = this.gl.getExtension('WEBGL_debug_renderer_info');
      name = String(ext ? this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : this.gl.getParameter(this.gl.RENDERER));
    } catch { /* not exposed */ }
    // "ANGLE (Intel, Intel(R) Iris(R) Plus Graphics (0x00008A5A) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> the useful middle.
    glStatus.renderer = name.replace(/^ANGLE \(/, '').replace(/\)$/, '').replace(/\s*\(0x[0-9a-f]+\)/i, '').replace(/ vs_\d_\d ps_\d_\d/, '').slice(0, 90);
    this.level = glStatus.level = load(glStatus.renderer);
    if (this.level) console.warn(`[graphics] drawing problems were seen before on this computer: safe level ${this.level}`);
    // A shader that won't build draws nothing: count it (three.js logs the details itself as well).
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      glStatus.shaderErrors++;
      const log = `${gl.getProgramInfoLog(program) ?? ''} ${gl.getShaderInfoLog(vs) ?? ''} ${gl.getShaderInfoLog(fs) ?? ''}`.replace(/\s+/g, ' ').trim();
      console.error('[graphics] shader failed to build:', log.slice(0, 600));
      glStatus.detail = log ? `First error: ${log.slice(0, 140)}` : '';
      this.bad += 3;
    };
    canvas.addEventListener('webglcontextlost', () => { glStatus.lost = true; console.warn('[graphics] WebGL context lost'); });
    canvas.addEventListener('webglcontextrestored', () => { glStatus.lost = false; });
  }

  /** Start watching closely again (a new match or scene). */
  rearm() { this.frames = 0; this.bad = 0; }

  /**
   * After each drawn frame. Checks closely for the first 4 seconds or so of a scene, then about every
   * 2 seconds (asking the browser for errors costs a little). Returns the new safe level when it
   * should step down, otherwise 0.
   */
  afterFrame(): number {
    const f = this.frames++;
    if (f > 240 && f % 120) return 0;
    let e = 0;
    try { e = this.gl.getError(); } catch { return 0; }
    if (e && e !== this.gl.CONTEXT_LOST_WEBGL) { this.bad++; glStatus.errors++; glStatus.lastError = e; }
    if (this.bad < 3 || this.level >= GL_SAFE_MAX) return 0;
    this.level = glStatus.level = this.level + 1;
    this.bad = 0;
    this.frames = 0;
    save(this.level, glStatus.renderer);
    console.warn(`[graphics] the browser refused drawing (WebGL error ${glStatus.lastError}): stepping down to safe level ${this.level}`);
    return this.level;
  }
}
