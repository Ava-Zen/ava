import { Injectable, computed, signal } from '@angular/core';
import { isTauriDesktop } from './updates';

export interface HomeEntry {
  name: string;
  rel: string;
  dir: boolean;
}

const ROOT_KEY = 'ava-home-root';
const BROWSER_FS_KEY = 'ava-okf-fs';
export const BROWSER_HOME = 'browser';

@Injectable({ providedIn: 'root' })
export class HomeService {
  readonly desktop = signal(isTauriDesktop());
  readonly root = signal<string | null>(this.loadStoredRoot());
  readonly ready = signal(false);
  readonly label = computed(() => this.folderLabel(this.root()));

  private readyWaiters: Array<() => void> = [];
  private browserFs: Record<string, string> = this.loadBrowserFs();

  constructor() {
    void this.bootstrap();
  }

  whenReady(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    return new Promise(resolve => this.readyWaiters.push(resolve));
  }

  async suggestedPath(): Promise<string | null> {
    if (!this.desktop()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('home_suggested_path');
      return path?.trim() || null;
    } catch {
      return null;
    }
  }

  async chooseFolder(): Promise<string | null> {
    if (!this.desktop()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('home_pick_folder');
      return path?.trim() || null;
    } catch {
      return null;
    }
  }

  async pickFolder(): Promise<string | null> {
    const path = await this.chooseFolder();
    if (!path) return null;
    await this.setRoot(path);
    return path;
  }

  async useSuggested(): Promise<string | null> {
    const path = await this.suggestedPath();
    if (!path) return null;
    await this.setRoot(path);
    return path;
  }

  async setRoot(path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed) return;
    const previous = this.root();
    if (previous && isBrowserHome(previous) && previous !== trimmed) {
      this.persistBrowserFs(previous);
    }
    if (this.desktop() && !isBrowserHome(trimmed)) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('home_ensure', { root: trimmed });
      } catch (error) {
        console.warn('Could not create home folder', error);
      }
    }
    if (isBrowserHome(trimmed)) {
      this.browserFs = this.loadBrowserFs(trimmed);
    }
    this.root.set(trimmed);
    this.persistRoot(trimmed);
  }

  folderLabel(path: string | null | undefined): string {
    if (!path || isBrowserHome(path)) return 'This browser';
    const trimmed = path.replace(/[\\/]+$/, '');
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || trimmed;
  }

  async readText(rel: string): Promise<string | null> {
    const root = this.root();
    if (!root) return null;
    if (!this.desktop() || isBrowserHome(root)) {
      return this.browserFs[normalizeRel(rel)] ?? null;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('home_read_text', { root, rel: normalizeRel(rel) });
    } catch {
      return null;
    }
  }

  async writeText(rel: string, contents: string): Promise<void> {
    const root = this.root();
    if (!root) return;
    const path = normalizeRel(rel);
    if (!this.desktop() || isBrowserHome(root)) {
      this.browserFs[path] = contents;
      this.persistBrowserFs(root);
      return;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('home_write_text', { root, rel: path, contents });
  }

  async list(rel = ''): Promise<HomeEntry[]> {
    const root = this.root();
    if (!root) return [];
    const prefix = normalizeRel(rel);
    if (!this.desktop() || isBrowserHome(root)) {
      return this.listBrowser(prefix);
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<HomeEntry[]>('home_list', { root, rel: prefix });
    } catch {
      return [];
    }
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.readText(rel)) != null;
  }

  private async bootstrap(): Promise<void> {
    try {
      if (this.desktop()) {
        const stored = this.root();
        if (!stored || isBrowserHome(stored)) {
          const suggested = await this.suggestedPath();
          if (suggested) await this.setRoot(suggested);
        } else {
          await this.setRoot(stored);
        }
      } else if (!this.root()) {
        this.root.set(BROWSER_HOME);
        this.persistRoot(BROWSER_HOME);
      }
    } finally {
      this.ready.set(true);
      for (const waiter of this.readyWaiters.splice(0)) waiter();
    }
  }

  private listBrowser(prefix: string): HomeEntry[] {
    const seen = new Map<string, HomeEntry>();
    const start = prefix ? `${prefix}/` : '';
    for (const path of Object.keys(this.browserFs)) {
      if (prefix && path !== prefix && !path.startsWith(start)) continue;
      if (path === prefix) continue;
      const rest = prefix ? path.slice(start.length) : path;
      const [name] = rest.split('/');
      if (!name) continue;
      const dir = rest.includes('/');
      const rel = prefix ? `${prefix}/${name}` : name;
      if (!seen.has(rel)) {
        seen.set(rel, { name, rel, dir });
      } else if (dir) {
        seen.get(rel)!.dir = true;
      }
    }
    return [...seen.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  private loadStoredRoot(): string | null {
    try {
      return localStorage.getItem(ROOT_KEY);
    } catch {
      return null;
    }
  }

  private persistRoot(path: string): void {
    try {
      localStorage.setItem(ROOT_KEY, path);
    } catch {
      // ignore
    }
  }

  private loadBrowserFs(root = BROWSER_HOME): Record<string, string> {
    try {
      const raw = localStorage.getItem(browserFsKey(root));
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private persistBrowserFs(root = this.root() || BROWSER_HOME): void {
    try {
      localStorage.setItem(browserFsKey(root), JSON.stringify(this.browserFs));
    } catch {
      // ignore quota
    }
  }
}

export function isBrowserHome(path: string | null | undefined): boolean {
  if (!path) return true;
  return path === BROWSER_HOME || path.startsWith(`${BROWSER_HOME}:`);
}

function browserFsKey(root: string): string {
  if (!root || root === BROWSER_HOME) return BROWSER_FS_KEY;
  if (root.startsWith(`${BROWSER_HOME}:`)) return `${BROWSER_FS_KEY}:${root.slice(BROWSER_HOME.length + 1)}`;
  return BROWSER_FS_KEY;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
