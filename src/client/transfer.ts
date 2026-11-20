// Moving saves between devices (20 Nov 2026). Everything the game keeps in this browser
// (profiles and save slots, career and the other modes, club levels, tournaments, friends
// leagues, ranked identity, settings and controls) is packed into one bundle. The bundle goes
// to another device as a short code (held for 30 minutes by the match server, which keeps
// nothing on disk) or as a file. Graphics settings stay with each device, and so do things
// that only make sense on one machine (the graphics self-check, open menus, the online seat).

export interface SaveBundle {
  app: 'elevens';
  v: 1;
  made: string;
  /** localStorage key -> stored text. */
  data: Record<string, string>;
}

/** Keys that belong to one device and never travel. */
const DEVICE_ONLY = new Set(['elevens.token', 'elevens.glsafe.v1', 'elevens.menuopen.v1']);

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const storage = (): Store | null => { try { return localStorage; } catch { return null; } };

export function travels(key: string): boolean {
  return key.startsWith('elevens.') && !DEVICE_ONLY.has(key);
}

/** Everything that travels, from this browser's storage. */
export function collectSave(ls: Store | null = storage()): SaveBundle {
  const data: Record<string, string> = {};
  if (ls) {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !travels(k)) continue;
      const v = ls.getItem(k);
      if (v != null) data[k] = v;
    }
  }
  return { app: 'elevens', v: 1, made: new Date().toISOString(), data };
}

export function isBundle(x: unknown): x is SaveBundle {
  const b = x as SaveBundle;
  return !!b && typeof b === 'object' && b.app === 'elevens' && b.v === 1 && !!b.data && typeof b.data === 'object'
    && Object.entries(b.data).every(([k, v]) => typeof k === 'string' && typeof v === 'string');
}

/** What a bundle holds, for the confirm line ("3 profiles, 41 matches, career, settings"). */
export function describeSave(b: SaveBundle): string {
  const parts: string[] = [];
  try {
    const store = JSON.parse(b.data['elevens.profiles.v1'] ?? 'null') as { slots?: ({ name: string; stats?: { played: number } } | null)[] } | null;
    const slots = (store?.slots ?? []).filter(Boolean) as { name: string; stats?: { played: number } }[];
    if (slots.length) parts.push(`${slots.length === 1 ? `profile ${slots[0].name}` : `${slots.length} profiles (${slots.map((s) => s.name).join(', ')})`}`, `${slots.reduce((n, s) => n + (s.stats?.played ?? 0), 0)} matches played`);
  } catch { /* unreadable profile: still offer the rest */ }
  if (Object.keys(b.data).some((k) => k.startsWith('elevens.modes.v1.') && /"career":\{/.test(b.data[k]))) parts.push('a career');
  if (b.data['elevens.levels.v1']) parts.push('club levels');
  if (b.data['elevens.settings.v1']) parts.push('settings and controls');
  return parts.join(', ') || 'nothing yet';
}

/**
 * Writes a bundle into this browser: the travelling keys are replaced, this device's graphics
 * settings are kept. Returns how many keys were written.
 */
export function applySave(b: SaveBundle, ls: Store | null = storage()): number {
  if (!ls) throw new Error('This browser does not allow saving.');
  // Keep this device's graphics (quality suits each screen) inside the incoming settings.
  const incoming = { ...b.data };
  const mineRaw = ls.getItem('elevens.settings.v1');
  if (incoming['elevens.settings.v1'] && mineRaw) {
    try {
      const theirs = JSON.parse(incoming['elevens.settings.v1']);
      const mine = JSON.parse(mineRaw);
      if (mine?.graphics) theirs.graphics = mine.graphics;
      for (const f of ['tabletMedium', 'softwareLow', 'commentaryOffTouch'] as const) if (f in (mine ?? {})) theirs[f] = mine[f];
      incoming['elevens.settings.v1'] = JSON.stringify(theirs);
    } catch { /* keep theirs as they are */ }
  }
  // Remove travelling keys this device has that the bundle doesn't (an empty slot stays empty).
  const old: string[] = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && travels(k) && !(k in incoming)) old.push(k); }
  for (const k of old) ls.removeItem(k);
  let n = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!travels(k)) continue;
    ls.setItem(k, v);
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ packing

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Bundle -> text: "EV1Z." + deflated base64 where the browser can, else "EV1J." + base64 JSON. */
export async function packSave(b: SaveBundle): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(b));
  if (canZip()) {
    try { return 'EV1Z.' + toB64(await pipe(raw, new CompressionStream('deflate-raw'))); } catch { /* fall through */ }
  }
  return 'EV1J.' + toB64(raw);
}

export async function unpackSave(text: string): Promise<SaveBundle> {
  const t = text.trim();
  let json: string;
  if (t.startsWith('{')) json = t;
  else if (t.startsWith('EV1J.')) json = new TextDecoder().decode(fromB64(t.slice(5)));
  else if (t.startsWith('EV1Z.')) {
    if (!canZip()) throw new Error('This browser is too old to open that save.');
    json = new TextDecoder().decode(await pipe(fromB64(t.slice(5)), new DecompressionStream('deflate-raw')));
  } else throw new Error('That is not an ELEVENS save.');
  const b = JSON.parse(json) as unknown;
  if (!isBundle(b)) throw new Error('That is not an ELEVENS save.');
  return b;
}

// ------------------------------------------------------------------ transfer codes

export const TRANSFER_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

export function cleanCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** http(s) address of the match server's transfer endpoint, from its ws address. */
export function transferUrl(ws: string, code = ''): string {
  return ws.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '/transfer') + (code ? `/${code}` : '');
}

/** Hands the save to the match server and returns the six-letter code another device types in. */
export async function sendSave(ws: string, b: SaveBundle): Promise<{ code: string; minutes: number }> {
  const body = await packSave(b);
  const r = await fetch(transferUrl(ws), { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
  const j = await r.json().catch(() => ({})) as { code?: string; minutes?: number; error?: string };
  if (!r.ok || !j.code) throw new Error(j.error ?? `The server said no (${r.status}).`);
  return { code: j.code, minutes: j.minutes ?? 30 };
}

export async function fetchSave(ws: string, code: string): Promise<SaveBundle> {
  const r = await fetch(transferUrl(ws, code), { cache: 'no-store' });
  if (r.status === 404) throw new Error('No save with that code. Codes last 30 minutes: make a new one on the other device.');
  if (!r.ok) throw new Error(`The server said no (${r.status}).`);
  return unpackSave(await r.text());
}

/** Downloads the save as a file (or offers the share sheet on phones that support it). */
export async function downloadSave(b: SaveBundle): Promise<void> {
  const text = await packSave(b);
  const name = `elevens-save-${b.made.slice(0, 10)}.elevens`;
  const file = typeof File === 'function' ? new File([text], name, { type: 'text/plain' }) : null;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (file && nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await nav.share({ files: [file], title: 'ELEVENS save' }); return; } catch { /* cancelled: fall back to a download */ }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ------------------------------------------------------------------ the panel (Profile > Save slots)

export interface TransferHost {
  on(sel: string, fn: (el: HTMLElement) => void): void;
  root(): HTMLElement;
  redraw(): void;
  serverUrl(): string;
  wake(): Promise<string>;
  /** After loading a save: reload the game so every part picks it up. */
  reload(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "Move to another device": send a code or a file here, load one there. */
export class TransferPanel {
  private busy = '';
  private code = '';
  private codeUntil = 0;
  private msg = '';
  private err = false;
  private pending: SaveBundle | null = null;
  private typed = '';

  constructor(private h: TransferHost) {}

  html(): string {
    const pending = this.pending;
    const status = this.busy ? `<p class="note xfer-busy">${esc(this.busy)}</p>` : this.msg ? `<p class="${this.err ? 'xfer-err' : 'note xfer-ok'}">${esc(this.msg)}</p>` : '';
    const codeBox = this.code && Date.now() < this.codeUntil
      ? `<div class="xfer-code"><span class="lbl">Your transfer code</span><b data-xfer-code>${this.code.split('').join(' ')}</b><span class="note">On the other device: Profile, Save slots, Load a save, and type this code. It works for 30 minutes.</span></div>` : '';
    const confirm = pending
      ? `<div class="xfer-confirm"><b>Load this save?</b><span>It holds ${esc(describeSave(pending))}, saved ${esc(new Date(pending.made).toLocaleString())}. It replaces every profile and setting on this device (your graphics settings stay as they are).</span>
          <div class="row wrap"><button class="btn small danger" data-a="xfer-apply">Replace and load</button><button class="btn small" data-a="xfer-cancel">Cancel</button></div></div>` : '';
    return `<div class="xfer">
      <h3>Move to another device</h3>
      <p class="note">Take your profiles, careers, trophies, club levels, tournaments and controls to your phone, tablet or another computer.</p>
      <div class="xfer-cols">
        <div><span class="lbl">From this device</span>
          <div class="row wrap"><button class="btn small primary" data-a="xfer-send" ${this.busy ? 'disabled' : ''}>Get a transfer code</button><button class="btn small" data-a="xfer-file" ${this.busy ? 'disabled' : ''}>Save to a file</button></div>
          ${codeBox}</div>
        <div><span class="lbl">Load a save</span>
          <div class="row wrap xfer-enter"><input id="xfer-in" type="text" inputmode="text" autocapitalize="characters" maxlength="8" placeholder="Code" value="${esc(this.typed)}" aria-label="Transfer code"><button class="btn small primary" data-a="xfer-get" ${this.busy ? 'disabled' : ''}>Load</button><button class="btn small" data-a="xfer-open" ${this.busy ? 'disabled' : ''}>Load from a file</button></div>
          <input id="xfer-filein" type="file" accept=".elevens,.txt,text/plain" hidden></div>
      </div>
      ${confirm}${status}
    </div>`;
  }

  private set(busy = '', msg = '', err = false) { this.busy = busy; this.msg = msg; this.err = err; this.h.redraw(); }

  bind() {
    const root = this.h.root();
    const input = root.querySelector<HTMLInputElement>('#xfer-in');
    input?.addEventListener('input', () => { this.typed = cleanCode(input.value); if (input.value !== this.typed) input.value = this.typed; });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void this.get(); } e.stopPropagation(); });
    this.h.on('[data-a=xfer-send]', () => void this.send());
    this.h.on('[data-a=xfer-file]', () => void this.file());
    this.h.on('[data-a=xfer-get]', () => void this.get());
    this.h.on('[data-a=xfer-open]', () => root.querySelector<HTMLInputElement>('#xfer-filein')?.click());
    root.querySelector<HTMLInputElement>('#xfer-filein')?.addEventListener('change', (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void this.readFile(f);
    });
    this.h.on('[data-a=xfer-apply]', () => {
      if (!this.pending) return;
      try { applySave(this.pending); } catch (e) { this.set('', (e as Error).message, true); return; }
      this.pending = null;
      this.set('Loaded. Restarting the game with your save…');
      setTimeout(() => this.h.reload(), 700);
    });
    this.h.on('[data-a=xfer-cancel]', () => { this.pending = null; this.set(); });
  }

  private async send() {
    this.set('Waking the server and sending your save…');
    try {
      const st = await this.h.wake();
      if (st === 'blocked') throw new Error('This copy of the game cannot reach the server. Use Save to a file, or open the game at its own address.');
      if (st !== 'ready') throw new Error('The server did not answer. Try again in a minute, or use Save to a file.');
      const { code, minutes } = await sendSave(this.h.serverUrl(), collectSave());
      this.code = code;
      this.codeUntil = Date.now() + minutes * 60_000;
      this.set();
    } catch (e) { this.set('', e instanceof TypeError ? 'Could not reach the server. Use Save to a file instead.' : (e as Error).message, true); }
  }

  private async file() {
    try { await downloadSave(collectSave()); this.set('', 'Save file made. Open it on the other device with Load from a file.'); } catch (e) { this.set('', (e as Error).message, true); }
  }

  private async get() {
    const code = this.typed;
    if (!TRANSFER_CODE_RE.test(code)) { this.set('', 'Codes are six letters and numbers, like K7Q2MX.', true); return; }
    this.set('Fetching the save…');
    try {
      const st = await this.h.wake();
      if (st !== 'ready') throw new Error('The server did not answer. Try again in a minute, or use a save file.');
      this.pending = await fetchSave(this.h.serverUrl(), code);
      this.set();
    } catch (e) { this.set('', e instanceof TypeError ? 'Could not reach the server. Use a save file instead.' : (e as Error).message, true); }
  }

  private async readFile(f: File) {
    try { this.pending = await unpackSave(await f.text()); this.set(); } catch (e) { this.set('', (e as Error).message, true); }
  }
}
