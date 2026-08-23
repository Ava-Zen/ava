import { Injectable, computed, signal } from '@angular/core';

export type ThemePreference = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ava-theme';
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f3ddd0',
  dark: '#1a100e',
};

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly preference = signal<ThemePreference>(loadPreference());
  readonly systemDark = signal(readSystemDark());
  readonly resolved = computed<ResolvedTheme>(() =>
    resolveTheme(this.preference(), this.systemDark()),
  );

  private media: MediaQueryList | null = null;
  private onSystemChange?: (event: MediaQueryListEvent) => void;

  constructor() {
    this.apply(this.resolved());
    this.watchSystem();
  }

  setPreference(preference: ThemePreference): void {
    this.preference.set(preference);
    persistPreference(preference);
    this.apply(resolveTheme(preference, this.systemDark()));
  }

  private watchSystem(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    this.media = window.matchMedia('(prefers-color-scheme: dark)');
    this.onSystemChange = event => {
      this.systemDark.set(event.matches);
      if (this.preference() === 'auto') this.apply(event.matches ? 'dark' : 'light');
    };
    this.media.addEventListener('change', this.onSystemChange);
  }

  private apply(theme: ResolvedTheme): void {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset['theme'] = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemDark ? 'dark' : 'light';
}

function loadPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // ignore
  }
  return 'auto';
}

function persistPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // ignore
  }
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
