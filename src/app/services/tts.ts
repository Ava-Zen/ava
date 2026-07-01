import { Injectable, signal, computed } from '@angular/core';

export type TtsEngine = 'kokoro' | 'custom' | 'system';

export interface TtsVoiceOption {
  id: TtsEngine;
  name: string;
  description: string;
}

/** A specific Kokoro speaker. */
export interface KokoroVoiceOption {
  id: string;
  name: string;
  accent: string;
}

interface TtsConfig {
  voice: TtsEngine;
  kokoroVoice: string;
}

const DEFAULT_KOKORO_VOICE = 'af_bella';

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
      id: 'custom',
      name: 'Custom Voice',
      description: 'Clone your own voice from a recording. Runs fully on-device.',
    },
    {
      id: 'system',
      name: 'System Voice',
      description: 'Built-in operating-system speech synthesis. Always available.',
    },
  ];

  /** Selectable Kokoro speakers. */
  readonly kokoroVoices: KokoroVoiceOption[] = [
    { id: 'af_bella', name: 'Bella', accent: 'American · Female' },
    { id: 'af_nicole', name: 'Nicole', accent: 'American · Female' },
    { id: 'am_adam', name: 'Adam', accent: 'American · Male' },
    { id: 'am_puck', name: 'Puck', accent: 'American · Male' },
    { id: 'am_eric', name: 'Eric', accent: 'American · Male' },
    { id: 'bf_isabella', name: 'Isabella', accent: 'British · Female' },
    { id: 'bm_george', name: 'George', accent: 'British · Male' },
  ];

  private readonly config = signal<TtsConfig>(this.load());

  readonly selectedVoiceId = computed(() => this.config().voice);
  readonly selectedVoice = computed(
    () => this.voices.find(v => v.id === this.config().voice) ?? this.voices[0]
  );

  readonly selectedKokoroVoiceId = computed(() => this.config().kokoroVoice);
  readonly selectedKokoroVoice = computed(
    () => this.kokoroVoices.find(v => v.id === this.config().kokoroVoice) ?? this.kokoroVoices[0]
  );

  setVoice(id: TtsEngine) {
    this.config.update(c => ({ ...c, voice: id }));
    this.save();
  }

  setKokoroVoice(id: string) {
    this.config.update(c => ({ ...c, kokoroVoice: id }));
    this.save();
  }

  private load(): TtsConfig {
    const fallback: TtsConfig = { voice: 'kokoro', kokoroVoice: DEFAULT_KOKORO_VOICE };
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<TtsConfig>;
      return {
        voice: this.isValidVoice(parsed.voice) ? parsed.voice! : 'kokoro',
        kokoroVoice: this.isValidKokoroVoice(parsed.kokoroVoice)
          ? parsed.kokoroVoice!
          : DEFAULT_KOKORO_VOICE,
      };
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
    return v === 'kokoro' || v === 'custom' || v === 'system';
  }

  private isValidKokoroVoice(v: unknown): v is string {
    return typeof v === 'string' && this.kokoroVoices.some(k => k.id === v);
  }
}
