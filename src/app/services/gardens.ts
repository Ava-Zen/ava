import { Injectable, signal, computed, effect } from '@angular/core';

export interface Garden {
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO
  /** Copilot working directory for this garden. */
  workspace?: string;
  /** When true, Copilot may edit files and run local commands in the workspace. */
  allowLocalTools?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class GardensService {
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

    // Ensure at least one garden
    if (this.gardens().length === 0) {
      this.createGarden('Personal Garden', 'Your private space for thoughts and reflections');
    }

    // Persist on changes
    effect(() => {
      this.saveToStorage();
    });
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
    updates: Partial<Pick<Garden, 'name' | 'description' | 'workspace' | 'allowLocalTools'>>,
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
      // Don't allow deleting the last garden
      return;
    }

    this.gardens.update(gardens => gardens.filter(g => g.id !== id));

    if (this.currentGardenId() === id) {
      // Switch to first remaining garden
      const remaining = this.gardens();
      if (remaining.length > 0) {
        this.currentGardenId.set(remaining[0].id);
      }
    }
  }

  // Helper to get all garden names for quick access
  getGardenNames(): string[] {
    return this.gardens().map(g => g.name);
  }
}
