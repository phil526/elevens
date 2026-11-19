// Screen transitions for the menus and overlays. Whenever #ui gets a new screen for a
// different place (not a redraw of the same screen, such as a Settings option changing),
// the old screen is kept for a moment in a layer of its own that fades and slides away while
// the new one slides in; going Back slides the other way. The old copy can't be clicked or
// reached with the controller (it is outside #ui and inert).
//
// Also a full-screen dip to black (`dip`) used going into and out of a match.

export interface TransitionOptions {
  /** Where the app is now (screen + overlay); a change means a new screen. */
  key: () => string;
  /** True for a moment after a Back press, so the slide goes the other way. */
  back: () => boolean;
  /** Off on test pages and when reduced motion is asked for. */
  enabled: () => boolean;
  /** Called on each real change of screen (a whoosh, say). */
  onChange?: (from: string, to: string) => void;
}

export const TRANSITION_MS = 260;

export class ScreenTransitions {
  private last = '';
  private ghosts: HTMLElement;
  private dipEl: HTMLElement;

  constructor(private ui: HTMLElement, private o: TransitionOptions) {
    this.ghosts = document.createElement('div');
    this.ghosts.className = 'ui-ghosts';
    this.ghosts.setAttribute('aria-hidden', 'true');
    ui.parentElement!.insertBefore(this.ghosts, ui);
    this.dipEl = document.createElement('div');
    this.dipEl.className = 'ui-dip';
    document.body.appendChild(this.dipEl);
    this.last = o.key();
    new MutationObserver((list) => this.changed(list)).observe(ui, { childList: true });
  }

  private changed(list: MutationRecord[]) {
    const key = this.o.key();
    if (key === this.last) return;
    const from = this.last;
    this.last = key;
    const added = list.flatMap((m) => Array.from(m.addedNodes)).filter((n): n is HTMLElement => n instanceof HTMLElement && n.isConnected);
    const removed = list.flatMap((m) => Array.from(m.removedNodes)).filter((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains('screen'));
    this.o.onChange?.(from, key);
    if (!this.o.enabled()) return;
    const back = this.o.back();
    const dir = back ? 'back' : 'fwd';
    for (const el of added) {
      if (!el.classList.contains('screen')) continue;
      el.classList.add('enter', dir);
      setTimeout(() => el.classList.remove('enter', 'fwd', 'back'), TRANSITION_MS + 400);
    }
    // The old screen leaves from where it was (scrolled panels keep their place).
    for (const el of removed.slice(-1)) {
      const top = el.scrollTop;
      el.classList.remove('enter', 'fwd', 'back');
      el.classList.add('leave', dir);
      el.setAttribute('inert', '');
      el.querySelectorAll('.pad-focus').forEach((x) => x.classList.remove('pad-focus'));
      this.ghosts.appendChild(el);
      el.scrollTop = top;
      setTimeout(() => el.remove(), TRANSITION_MS);
    }
  }

  /** Fade to black, run `mid` (build the next thing), fade back in. */
  dip(mid: () => void, ms = 220) {
    if (!this.o.enabled()) { mid(); return; }
    this.dipEl.classList.add('on');
    setTimeout(() => {
      try { mid(); } finally {
        requestAnimationFrame(() => this.dipEl.classList.remove('on'));
      }
    }, ms);
  }
}
