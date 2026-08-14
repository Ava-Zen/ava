import { Injectable, computed, inject, signal } from '@angular/core';
import { XaiAuthService } from './xai/xai-auth';
import { GROK_FALLBACK_VOICES, GrokVoiceInfo, XaiClient } from './xai/xai-client';

export type TtsEngine = 'kokoro' | 'system' | 'grok';

export interface TtsVoiceOption {
  id: TtsEngine;
  name: string;
  description: string;
  requiresGrok?: boolean;
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
  grokVoice: string;
}

const DEFAULT_KOKORO_VOICE = 'af_bella';
const DEFAULT_GROK_VOICE = 'carina';

@Injectable({ providedIn: 'root' })
export class TtsService {
  private readonly STORAGE_KEY = 'ava-tts-config';
  private readonly kokoroPreviewBasePath = '/audio/kokoro';
  private readonly xai = inject(XaiAuthService);
  private readonly xaiClient = new XaiClient(this.xai);

  readonly voices: TtsVoiceOption[] = [
    {
      id: 'grok',
      name: 'Grok Voice',
      description: 'Cloud voices from xAI. Requires a Grok login.',
      requiresGrok: true,
    },
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
  readonly grokVoiceCatalog = signal<GrokVoiceInfo[]>(GROK_FALLBACK_VOICES);

  readonly selectedVoiceId = computed(() => {
    const voice = this.config().voice;
    if (voice === 'grok' && !this.xai.signedIn()) return 'kokoro';
    return voice;
  });
  readonly selectedVoice = computed(
    () => this.voices.find(v => v.id === this.selectedVoiceId()) ?? this.voices.find(v => v.id === 'kokoro')!
  );

  readonly selectedKokoroVoiceId = computed(() => this.config().kokoroVoice);
  readonly selectedKokoroVoice = computed(
    () => this.kokoroVoices.find(v => v.id === this.config().kokoroVoice) ?? this.kokoroVoices[0]
  );
  readonly selectedGrokVoiceId = computed(() => this.config().grokVoice);
  readonly selectedGrokVoice = computed(
    () => this.grokVoiceCatalog().find(v => v.id === this.config().grokVoice) ?? this.grokVoiceCatalog()[0]
  );

  setVoice(id: TtsEngine) {
    if (id === 'grok' && !this.xai.signedIn()) return;
    this.config.update(c => ({ ...c, voice: id }));
    this.save();
  }

  setKokoroVoice(id: string) {
    this.config.update(c => ({ ...c, kokoroVoice: id }));
    this.save();
  }

  setGrokVoice(id: string) {
    this.config.update(c => ({ ...c, grokVoice: id, voice: 'grok' }));
    this.save();
  }

  preferGrokVoice(): void {
    if (!this.xai.signedIn()) return;
    this.setVoice('grok');
    void this.refreshGrokVoices();
  }

  async refreshGrokVoices(): Promise<void> {
    if (!this.xai.signedIn()) return;
    try {
      this.grokVoiceCatalog.set(await this.xaiClient.listVoices());
    } catch {
      this.grokVoiceCatalog.set(GROK_FALLBACK_VOICES);
    }
  }

  async synthesizeGrok(text: string): Promise<Blob> {
    return this.xaiClient.synthesizeSpeech(text, this.selectedGrokVoiceId());
  }

  getKokoroPreviewAudioUrl(id: string): string {
    return this.kokoroVoices.some(v => v.id === id)
      ? `${this.kokoroPreviewBasePath}/${id}.wav`
      : `${this.kokoroPreviewBasePath}/${DEFAULT_KOKORO_VOICE}.wav`;
  }

  private load(): TtsConfig {
    const fallback: TtsConfig = {
      voice: 'kokoro',
      kokoroVoice: DEFAULT_KOKORO_VOICE,
      grokVoice: DEFAULT_GROK_VOICE,
    };
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<TtsConfig>;
      return {
        voice: this.isValidVoice(parsed.voice) ? parsed.voice! : 'kokoro',
        kokoroVoice: this.isValidKokoroVoice(parsed.kokoroVoice)
          ? parsed.kokoroVoice!
          : DEFAULT_KOKORO_VOICE,
        grokVoice: this.normalizeGrokVoice(parsed.grokVoice),
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
    return v === 'kokoro' || v === 'system' || v === 'grok';
  }

  private isValidKokoroVoice(v: unknown): v is string {
    return typeof v === 'string' && this.kokoroVoices.some(k => k.id === v);
  }

  private normalizeGrokVoice(v: unknown): string {
    if (typeof v !== 'string' || !v.trim() || v.trim().toLowerCase() === 'eve') {
      return DEFAULT_GROK_VOICE;
    }
    return v.trim();
  }
}
