import { Injectable, signal, computed } from '@angular/core';

export type TtsEngine = 'kokoro' | 'system';

export interface TtsVoiceOption {
  id: TtsEngine;
  name: string;
  description: string;
}

interface TtsConfig {
  voice: TtsEngine;
}

@Injectable({ providedIn: 'root' })
export class TtsService {
  private readonly STORAGE_KEY = 'ava-tts-config';

  readonly voices: TtsVoiceOption[] = [
    {
      id: 'kokoro',
      name: 'Kokoro 82M',
      description: 'On-device neural voice. Fast, warm and natural.',
    },
    {
      id: 'system',
      name: 'System Voice',
      description: 'Built-in operating-system speech synthesis. Always available.',
    },
  ];

  private readonly config = signal<TtsConfig>(this.load());

  readonly selectedVoiceId = computed(() => this.config().voice);
  readonly selectedVoice = computed(
    () => this.voices.find(v => v.id === this.config().voice) ?? this.voices[0]
  );

  setVoice(id: TtsEngine) {
    this.config.set({ voice: id });
    this.save();
  }

  private load(): TtsConfig {
    const fallback: TtsConfig = { voice: 'kokoro' };
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<TtsConfig>;
      return { voice: this.isValidVoice(parsed.voice) ? parsed.voice! : 'kokoro' };
    } catch {
      return fallback;
    }
  }

  private save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.config()));
    } catch {
      // ignore persistence errors
    }
  }

  private isValidVoice(v: unknown): v is TtsEngine {
    return v === 'kokoro' || v === 'system';
  }
}
