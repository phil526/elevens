// Home-screen app support (19 Nov 2026). When the game is served from its own address (the
// self-hosted build: `npm run build`, then any static host or `npm start`), it is an installable
// web app: a manifest and icons for "Add to Home Screen" on iPad, full screen with no browser
// bars, and a service worker (public/sw.js) that keeps every file it has loaded so the game also
// starts with no connection (online matches still need the server). Inside the claude.ai
// Artifact page none of that is allowed (the page lives in a sandboxed frame on claude.ai), so
// there the Settings screen offers full screen where the browser allows it and explains the rest.

export interface InstallInfo {
  /** Running as an installed home-screen app. */
  standalone: boolean;
  /** Inside another page's frame (such as the claude.ai Artifact viewer). */
  framed: boolean;
  /** The browser can switch the game to full screen from here. */
  canFullscreen: boolean;
  /** A service worker is looking after offline play. */
  offline: boolean;
  /** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
  ios: boolean;
}

let swReady = false;

function framed(): boolean {
  try { return window.top !== window.self; } catch { return true; }
}

export function installInfo(): InstallInfo {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = nav.standalone === true || (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches);
  const d = document as Document & { webkitFullscreenEnabled?: boolean };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return { standalone, framed: framed(), canFullscreen: !!(document.fullscreenEnabled || d.webkitFullscreenEnabled), offline: swReady, ios };
}

/** Keep the game's files for offline play (own address only; never inside a frame or on test pages). */
export async function registerOffline(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || framed()) return;
    if (new URLSearchParams(location.search).has('test')) return;
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    // Only where the build put sw.js next to the page (dev servers and other hosts may not have it).
    const url = new URL('sw.js', location.href);
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!head || !head.ok) return;
    await navigator.serviceWorker.register(url, { scope: './' });
    swReady = true;
  } catch {
    /* not allowed here: the game still works online */
  }
}

/** Full screen on or off (where the browser and the page allow it). */
export async function toggleFullscreen(): Promise<boolean> {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen(); else d.webkitExitFullscreen?.();
      return false;
    }
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' }); else el.webkitRequestFullscreen?.();
    return true;
  } catch {
    return false;
  }
}
