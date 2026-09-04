import { Injectable, computed, signal } from '@angular/core';
import { isTauriDesktop } from './updates';

export const CHROME_STORAGE_KEY = 'ava-window-chrome';
export const ORB_WINDOW_SIZE = { width: 196, height: 196 };
export const ORB_MENU_SIZE = { width: 252, height: 372 };

export interface WindowRect {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
}

export interface ChromeState {
  compact: boolean;
  alwaysOnTop: boolean;
  restore: WindowRect | null;
}

@Injectable({ providedIn: 'root' })
export class WindowChromeService {
  readonly desktop = isTauriDesktop();
  readonly compact = signal(false);
  readonly alwaysOnTop = signal(false);
  readonly blocked = signal(true);
  readonly menuOpen = signal(false);
  readonly active = computed(() => this.desktop && this.compact() && !this.blocked());

  private restore: WindowRect | null = null;
  private applyQueue: Promise<void> = Promise.resolve();

  constructor() {
    const stored = loadChromeState();
    this.compact.set(stored.compact);
    this.alwaysOnTop.set(stored.alwaysOnTop);
    this.restore = stored.restore;
    applyOrbChromeAttr(false);
    if (this.desktop) void this.apply();
  }

  setBlocked(blocked: boolean): void {
    if (this.blocked() === blocked) return;
    this.blocked.set(blocked);
    void this.apply();
  }

  async setMenuOpen(open: boolean): Promise<void> {
    if (this.menuOpen() === open) return;
    this.menuOpen.set(open);
    await this.apply();
  }

  async setCompact(compact: boolean): Promise<void> {
    if (!this.desktop) return;
    if (this.compact() === compact) return;
    this.compact.set(compact);
    if (!compact) this.menuOpen.set(false);
    persistChromeState(this.snapshotState());
    applyOrbChromeAttr(this.active());
    await this.apply();
  }

  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    if (!this.desktop) return;
    if (this.alwaysOnTop() === alwaysOnTop) return;
    this.alwaysOnTop.set(alwaysOnTop);
    persistChromeState(this.snapshotState());
    await this.apply();
  }

  async startDragging(): Promise<void> {
    if (!this.desktop || !this.active()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_window_drag');
    } catch {
      // ignore
    }
  }

  private apply(): Promise<void> {
    this.applyQueue = this.applyQueue.then(() => this.applyNow()).catch(() => undefined);
    return this.applyQueue;
  }

  private async applyNow(): Promise<void> {
    if (!this.desktop) return;
    const compact = this.active();
    applyOrbChromeAttr(compact);
    if (compact && !this.restore) {
      this.restore = await snapshotWindowRect();
    }

    const size = compactWindowSize(compact && this.menuOpen());
    const restore = this.restore;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_companion_chrome', {
        chrome: {
          compact,
          alwaysOnTop: this.alwaysOnTop(),
          width: compact ? size.width : restore?.width ?? 0,
          height: compact ? size.height : restore?.height ?? 0,
          clipOrb: compact && !this.menuOpen(),
          x: compact ? null : restore?.x ?? null,
          y: compact ? null : restore?.y ?? null,
        },
      });
    } catch (error) {
      console.warn('Could not apply window chrome', error);
    }

    if (!compact && !this.compact()) {
      this.restore = null;
    }
    persistChromeState(this.snapshotState());
  }

  private snapshotState(): ChromeState {
    return {
      compact: this.compact(),
      alwaysOnTop: this.alwaysOnTop(),
      restore: this.restore,
    };
  }
}

export function compactWindowSize(menuOpen: boolean): { width: number; height: number } {
  return menuOpen ? ORB_MENU_SIZE : ORB_WINDOW_SIZE;
}

export function parseChromeState(raw: string | null): ChromeState {
  const fallback: ChromeState = { compact: false, alwaysOnTop: false, restore: null };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ChromeState>;
    return {
      compact: parsed.compact === true,
      alwaysOnTop: parsed.alwaysOnTop === true,
      restore: parseWindowRect(parsed.restore),
    };
  } catch {
    return fallback;
  }
}

function parseWindowRect(raw: WindowRect | null | undefined): WindowRect | null {
  if (!raw || typeof raw.width !== 'number' || typeof raw.height !== 'number') return null;
  if (raw.width < 360 || raw.height < 600) return null;
  return {
    width: Math.round(raw.width),
    height: Math.round(raw.height),
    x: typeof raw.x === 'number' ? Math.round(raw.x) : null,
    y: typeof raw.y === 'number' ? Math.round(raw.y) : null,
  };
}

function loadChromeState(): ChromeState {
  try {
    return parseChromeState(localStorage.getItem(CHROME_STORAGE_KEY));
  } catch {
    return { compact: false, alwaysOnTop: false, restore: null };
  }
}

function persistChromeState(state: ChromeState): void {
  try {
    localStorage.setItem(CHROME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function applyOrbChromeAttr(active: boolean): void {
  if (typeof document === 'undefined') return;
  if (active) document.documentElement.dataset['orbChrome'] = 'on';
  else delete document.documentElement.dataset['orbChrome'];
}

async function snapshotWindowRect(): Promise<WindowRect> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    const scale = await win.scaleFactor();
    return parseWindowRect({
      width: size.width / scale,
      height: size.height / scale,
      x: pos.x / scale,
      y: pos.y / scale,
    }) ?? { width: 420, height: 720, x: null, y: null };
  } catch {
    return { width: 420, height: 720, x: null, y: null };
  }
}
