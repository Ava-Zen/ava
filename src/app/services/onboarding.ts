import { Injectable, signal, computed } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export interface AvaProfile {
  name: string;
  pronunciation?: string;
  primaryUse?: string;
  preferredInput?: 'voice' | 'text' | 'both';
  modelDownloadConsent: boolean;
  completedAt: string;
}

@Injectable({ providedIn: 'root' })
export class OnboardingService {
  private readonly COMPLETE_KEY = 'ava-onboarding-complete';
  private readonly PROFILE_KEY = 'ava-user-profile';
  private suggestedNameLoad?: Promise<string | null>;

  readonly completed = signal(this.loadCompleted());
  readonly profile = signal<AvaProfile | null>(this.loadProfile());
  readonly suggestedName = signal<string | null>(null);
  readonly userName = computed(() => this.profile()?.name ?? '');

  constructor() {
    void this.loadSuggestedName();
  }

  complete(profile: Omit<AvaProfile, 'completedAt'>): void {
    const next: AvaProfile = {
      ...profile,
      name: this.cleanName(profile.name),
      pronunciation: this.cleanOptional(profile.pronunciation),
      primaryUse: this.cleanOptional(profile.primaryUse),
      completedAt: new Date().toISOString(),
    };

    this.profile.set(next);
    this.completed.set(true);

    try {
      localStorage.setItem(this.PROFILE_KEY, JSON.stringify(next));
      localStorage.setItem(this.COMPLETE_KEY, '1');
    } catch {
      // Ava can still continue for this session if persistence is unavailable.
    }
  }

  async loadSuggestedName(): Promise<string | null> {
    this.suggestedNameLoad ??= this.fetchSuggestedName();
    return this.suggestedNameLoad;
  }

  private async fetchSuggestedName(): Promise<string | null> {
    try {
      const suggested = await invoke<string | null>('suggested_user_name');
      const cleaned = this.cleanOptional(suggested) ?? null;
      this.suggestedName.set(cleaned);
      return cleaned;
    } catch {
      this.suggestedName.set(null);
      return null;
    }
  }

  private loadCompleted(): boolean {
    try {
      return localStorage.getItem(this.COMPLETE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private loadProfile(): AvaProfile | null {
    try {
      const raw = localStorage.getItem(this.PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AvaProfile;
      if (!parsed?.name || !parsed.modelDownloadConsent) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private cleanName(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  private cleanOptional(value?: string | null): string | undefined {
    const cleaned = value?.trim().replace(/\s+/g, ' ');
    return cleaned || undefined;
  }
}
