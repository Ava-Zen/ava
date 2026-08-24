import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { BROWSER_HOME, HomeService, isBrowserHome } from './home';

export interface Garden {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  /** Folder where this garden's Ava keeps her files. */
  home?: string;
  /** Copilot working directory for this garden. */
  workspace?: string;
  /** When true, Copilot may edit files and run local commands in the workspace. */
  allowLocalTools?: boolean;
}

export type HomeClaim =
  | { ok: true; path: string }
  | { ok: false; error: string | null; owner?: Garden };

@Injectable({
  providedIn: 'root'
})
export class GardensService {
  private readonly homeService = inject(HomeService);
  private readonly STORAGE_KEY = 'ava-gardens';
  private readonly CURRENT_KEY = 'ava-current-garden';
  private readonly RECENTS_KEY = 'ava-workspace-recents';
  private readonly LEGACY_WORKSPACE_KEY = 'ava-copilot-workspace';
  private readonly LEGACY_WRITES_KEY = 'ava-copilot-allow-writes';

  readonly gardens = signal<Garden[]>([]);
  readonly currentGardenId = signal<string>('');
  readonly recentWorkspaces = signal<string[]>([]);

  readonly currentGarden = computed(() => {
    const id = this.currentGardenId();
    return this.gardens().find(g => g.id === id) || this.gardens()[0];
  });

  constructor() {
    this.loadFromStorage();
    this.migrateLegacyCopilotWorkspace();

    if (this.gardens().length === 0) {
      this.createGarden('Personal Garden', 'Your private space for thoughts and reflections');
    }

    void this.homeService.whenReady().then(() => this.bindCurrentHome());

    effect(() => {
      this.saveToStorage();
    });
  }

  folderOwner(path: string, exceptId?: string): Garden | undefined {
    const key = homePathKey(path);
    if (!key) return undefined;
    return this.gardens().find(garden =>
      garden.id !== exceptId && !!garden.home && homePathKey(garden.home) === key,
    );
  }

  homeLabel(garden: Garden | null | undefined): string {
    return this.homeService.folderLabel(garden?.home);
  }

  async useGarden(id: string): Promise<boolean> {
    if (!this.gardens().some(g => g.id === id)) return false;
    this.currentGardenId.set(id);
    const garden = this.currentGarden();
    if (garden?.home) await this.homeService.setRoot(garden.home);
    return true;
  }

  async createNamedGarden(name: string, home?: string): Promise<HomeClaim & { garden?: Garden }> {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'Name the garden first.' };

    let path = home?.trim() || '';
    if (!path) {
      if (this.homeService.desktop()) {
        path = (await this.homeService.chooseFolder()) || '';
        if (!path) return { ok: false, error: null };
      } else {
        path = `${BROWSER_HOME}:${this.generateId()}`;
      }
    }

    const owner = this.folderOwner(path);
    if (owner) return { ok: false, error: `That folder already belongs to ${owner.name}.`, owner };

    const garden = this.createGarden(trimmed);
    this.updateGarden(garden.id, { home: path });
    await this.homeService.setRoot(path);
    return { ok: true, path, garden };
  }

  async createGardenFromFolder(): Promise<HomeClaim & { garden?: Garden }> {
    if (!this.homeService.desktop()) {
      return this.createNamedGarden(`Garden ${this.gardens().length + 1}`);
    }
    const path = await this.homeService.chooseFolder();
    if (!path) return { ok: false, error: null };
    const owner = this.folderOwner(path);
    if (owner) return { ok: false, error: `That folder already belongs to ${owner.name}.`, owner };
    return this.createNamedGarden(this.homeService.folderLabel(path), path);
  }

  async pickHomeFor(gardenId?: string): Promise<HomeClaim> {
    const id = gardenId || this.currentGardenId();
    if (!id) return { ok: false, error: 'No garden to attach a folder to.' };
    const path = await this.homeService.chooseFolder();
    if (!path) return { ok: false, error: null };
    return this.assignHome(id, path);
  }

  async assignHome(gardenId: string, path: string): Promise<HomeClaim> {
    const trimmed = path.trim();
    if (!trimmed) return { ok: false, error: null };
    const owner = this.folderOwner(trimmed, gardenId);
    if (owner) return { ok: false, error: `That folder already belongs to ${owner.name}.`, owner };
    this.updateGarden(gardenId, { home: trimmed });
    if (this.currentGardenId() === gardenId) await this.homeService.setRoot(trimmed);
    return { ok: true, path: trimmed };
  }

  private loadFromStorage() {
    try {
      const savedGardens = localStorage.getItem(this.STORAGE_KEY);
      if (savedGardens) {
        this.gardens.set(JSON.parse(savedGardens));
      }

      const savedCurrent = localStorage.getItem(this.CURRENT_KEY);
      if (savedCurrent && this.gardens().some(g => g.id === savedCurrent)) {
        this.currentGardenId.set(savedCurrent);
      } else if (this.gardens().length > 0) {
        this.currentGardenId.set(this.gardens()[0].id);
      }

      const recents = localStorage.getItem(this.RECENTS_KEY);
      if (recents) {
        const parsed = JSON.parse(recents) as unknown;
        if (Array.isArray(parsed)) {
          this.recentWorkspaces.set(parsed.filter((p): p is string => typeof p === 'string' && !!p.trim()));
        }
      }
    } catch (e) {
      console.warn('Failed to load gardens from storage', e);
      this.resetToDefault();
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.gardens()));
      localStorage.setItem(this.CURRENT_KEY, this.currentGardenId());
      localStorage.setItem(this.RECENTS_KEY, JSON.stringify(this.recentWorkspaces()));
    } catch (e) {
      console.warn('Failed to save gardens', e);
    }
  }

  private resetToDefault() {
    const defaultGarden: Garden = {
      id: this.generateId(),
      name: 'Personal Garden',
      description: 'Your private space for thoughts and reflections',
      createdAt: new Date().toISOString()
    };
    this.gardens.set([defaultGarden]);
    this.currentGardenId.set(defaultGarden.id);
  }

  private generateId(): string {
    return 'garden-' + Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  private bindCurrentHome(): void {
    const current = this.currentGarden();
    const root = this.homeService.root();
    if (current && !current.home && root) {
      this.updateGarden(current.id, { home: root });
      return;
    }
    if (current?.home && current.home !== root) {
      void this.homeService.setRoot(current.home);
    }
  }

  createGarden(name: string, description?: string): Garden {
    const newGarden: Garden = {
      id: this.generateId(),
      name: name.trim() || 'Untitled Garden',
      description: description?.trim(),
      createdAt: new Date().toISOString()
    };

    this.gardens.update(gardens => [...gardens, newGarden]);
    this.selectGarden(newGarden.id);
    return newGarden;
  }

  selectGarden(id: string) {
    if (this.gardens().some(g => g.id === id)) {
      this.currentGardenId.set(id);
    }
  }

  updateGarden(
    id: string,
    updates: Partial<Pick<Garden, 'name' | 'description' | 'home' | 'workspace' | 'allowLocalTools'>>,
  ) {
    this.gardens.update(gardens =>
      gardens.map(g =>
        g.id === id
          ? { ...g, ...updates, name: updates.name?.trim() || g.name }
          : g
      )
    );
  }

  setCurrentWorkspace(path: string): void {
    const garden = this.currentGarden();
    if (!garden) return;
    const workspace = path.trim();
    this.updateGarden(garden.id, { workspace: workspace || undefined });
    if (workspace) this.rememberWorkspace(workspace);
  }

  setCurrentAllowLocalTools(allow: boolean): void {
    const garden = this.currentGarden();
    if (!garden) return;
    this.updateGarden(garden.id, { allowLocalTools: allow });
  }

  rememberWorkspace(path: string): void {
    const workspace = path.trim();
    if (!workspace) return;
    this.recentWorkspaces.update(list =>
      [workspace, ...list.filter(item => item !== workspace)].slice(0, 8)
    );
  }

  workspaceLabel(path: string | undefined): string {
    if (!path?.trim()) return 'Choose folder';
    if (isBrowserHome(path)) return 'This browser';
    const trimmed = path.replace(/[\\/]+$/, '');
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || trimmed;
  }

  private migrateLegacyCopilotWorkspace(): void {
    const current = this.currentGarden();
    if (!current) return;
    try {
      const legacyPath = localStorage.getItem(this.LEGACY_WORKSPACE_KEY)?.trim();
      if (legacyPath && !current.workspace) {
        this.updateGarden(current.id, { workspace: legacyPath });
        this.rememberWorkspace(legacyPath);
      }
      if (localStorage.getItem(this.LEGACY_WRITES_KEY) === '1' && !current.allowLocalTools) {
        this.updateGarden(current.id, { allowLocalTools: true });
      }
    } catch {
      // ignore
    }
  }

  deleteGarden(id: string) {
    const currentGardens = this.gardens();
    if (currentGardens.length <= 1) {
      return;
    }

    this.gardens.update(gardens => gardens.filter(g => g.id !== id));

    if (this.currentGardenId() === id) {
      const remaining = this.gardens();
      if (remaining.length > 0) {
        this.currentGardenId.set(remaining[0].id);
      }
    }
  }

  getGardenNames(): string[] {
    return this.gardens().map(g => g.name);
  }
}

export function homePathKey(path: string | null | undefined): string {
  if (!path?.trim()) return '';
  return path.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

export function sameHomePath(a?: string | null, b?: string | null): boolean {
  const left = homePathKey(a);
  const right = homePathKey(b);
  return !!left && left === right;
}
