import { Injectable, signal, computed, effect } from '@angular/core';

export interface Garden {
  id: string;
  name: string;
  description?: string;
  createdAt: string; // ISO
}

@Injectable({
  providedIn: 'root'
})
export class GardensService {
  private readonly STORAGE_KEY = 'ava-gardens';
  private readonly CURRENT_KEY = 'ava-current-garden';

  readonly gardens = signal<Garden[]>([]);
  readonly currentGardenId = signal<string>('');

  readonly currentGarden = computed(() => {
    const id = this.currentGardenId();
    return this.gardens().find(g => g.id === id) || this.gardens()[0];
  });

  constructor() {
    this.loadFromStorage();

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
    } catch (e) {
      console.warn('Failed to load gardens from storage', e);
      this.resetToDefault();
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.gardens()));
      localStorage.setItem(this.CURRENT_KEY, this.currentGardenId());
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

  updateGarden(id: string, updates: Partial<Pick<Garden, 'name' | 'description'>>) {
    this.gardens.update(gardens =>
      gardens.map(g =>
        g.id === id
          ? { ...g, ...updates, name: updates.name?.trim() || g.name }
          : g
      )
    );
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
