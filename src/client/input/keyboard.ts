import { emptyRaw, type InputSource, type RawState } from './actions';
import { defaultBindings, keyMap, type BindAction, type ControlBindings } from './bindings';

/** The default key map (the Controls menu can change it: see bindings.ts). */
export const KEYMAP: Record<string, BindAction> = keyMap(defaultBindings());

/** Pure keyboard state machine (DOM wiring is separate so it can be unit-tested). */
export class KeyboardState implements InputSource {
  device = 'keyboard' as const;
  private map: Record<string, BindAction> = KEYMAP;
  private down = new Set<string>();
  /** A fixed key map instead of the bindings (one half of a split keyboard in local multiplayer). */
  setMap(m: Record<string, BindAction>) {
    this.map = m;
    this.clear();
  }
  /** Uses new key bindings from now on (held keys are released). */
  setBindings(b: ControlBindings) {
    this.map = keyMap(b);
    this.clear();
  }
  // Keys pressed since the last read. A tap that starts and ends between two
  // samples (fast fingers, or a slow frame) still registers for one sample.
  private latched = new Set<string>();
  /** The action a key (or mouse input) is mapped to, if any. */
  action(code: string): BindAction | undefined {
    return this.map[code];
  }
  handle(code: string, isDown: boolean): boolean {
    if (!(code in this.map)) return false;
    if (isDown) { this.down.add(code); this.latched.add(code); }
    else this.down.delete(code);
    return true;
  }
  read(): RawState {
    const r = emptyRaw();
    const active = new Set([...this.down, ...this.latched]);
    this.latched.clear();
    for (const code of active) {
      const a = this.map[code];
      if (!a) continue;
      if (a === 'up') r.sy += 1;
      else if (a === 'down') r.sy -= 1;
      else if (a === 'left') r.sx -= 1;
      else if (a === 'right') r.sx += 1;
      else (r[a] as boolean) = true;
    }
    r.sx = Math.max(-1, Math.min(1, r.sx));
    r.sy = Math.max(-1, Math.min(1, r.sy));
    const l = Math.hypot(r.sx, r.sy);
    if (l > 1) { r.sx /= l; r.sy /= l; }
    return r;
  }
  clear() {
    this.down.clear();
    this.latched.clear();
  }
}

/** Attach to window. Game keys don't scroll the page or trigger browser shortcuts while playing. */
export function attachKeyboard(k: KeyboardState, isPlaying: () => boolean) {
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (k.handle(e.code, true) && isPlaying() && e.code !== 'Escape') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    k.handle(e.code, false);
  });
}
