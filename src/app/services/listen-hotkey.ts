import { Injectable, signal } from '@angular/core';
import { isTauriDesktop } from './updates';

export type ListenHotkey = 'off' | 'F7' | 'F8' | 'F9' | 'F10';

export const LISTEN_HOTKEY_STORAGE_KEY = 'ava-listen-hotkey';
export const LISTEN_HOTKEY_OPTIONS: ListenHotkey[] = ['off', 'F7', 'F8', 'F9', 'F10'];

@Injectable({ providedIn: 'root' })
export class ListenHotkeyService {
  readonly desktop = isTauriDesktop();
  readonly key = signal<ListenHotkey>(loadHotkey());

  async start(): Promise<void> {
    if (!this.desktop) return;
    await this.apply(this.key());
  }

  async setKey(key: ListenHotkey): Promise<void> {
    this.key.set(key);
    persistHotkey(key);
    await this.apply(key);
  }

  private async apply(key: ListenHotkey): Promise<void> {
    if (!this.desktop) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_listen_hotkey', { key });
    } catch (error) {
      console.warn('Could not set listen hotkey', error);
    }
  }
}

export function parseListenHotkey(raw: string | null): ListenHotkey {
  if (raw == null) return 'F8';
  const value = raw.trim().toUpperCase();
  if (value === 'OFF' || value === 'NONE' || value === '') return 'off';
  if (value === 'F7' || value === 'F8' || value === 'F9' || value === 'F10') return value;
  return 'F8';
}

function loadHotkey(): ListenHotkey {
  try {
    return parseListenHotkey(localStorage.getItem(LISTEN_HOTKEY_STORAGE_KEY));
  } catch {
    return 'F8';
  }
}

function persistHotkey(key: ListenHotkey): void {
  try {
    localStorage.setItem(LISTEN_HOTKEY_STORAGE_KEY, key);
  } catch {
    // ignore
  }
}
