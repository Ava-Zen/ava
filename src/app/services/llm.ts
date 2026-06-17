import { Injectable, signal, computed } from '@angular/core';
import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, DeviceTier } from './device-capability';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmModelOption {
  /** Hugging Face ONNX repo id (transformers.js compatible). */
  id: string;
  /** Friendly label shown in the UI. */
  name: string;
  /** Rough on-disk / VRAM footprint, for user guidance. */
  size: string;
  /** Device tier this option is the default for. */
  tier: DeviceTier;
}

/**
 * Catalogue of Gemma models used for *instant* spoken replies.
 *
 * These are kept deliberately small so the first token arrives quickly.
 * Repo ids point at the publicly available transformers.js ONNX builds of the
 * Gemma family; swap them for newer Gemma builds as they are published.
 */
const GEMMA_MODELS: Record<DeviceTier, LlmModelOption> = {
  low: {
    id: 'onnx-community/gemma-3-270m-it-ONNX',
    name: 'Gemma 270M',
    size: '~0.3 GB',
    tier: 'low',
  },
  medium: {
    id: 'onnx-community/gemma-3-1b-it-ONNX',
    name: 'Gemma 1B',
    size: '~1 GB',
    tier: 'medium',
  },
  high: {
    id: 'onnx-community/gemma-3-1b-it-ONNX',
    name: 'Gemma 1B (HQ)',
    size: '~1.5 GB',
    tier: 'high',
  },
};

const SYSTEM_PROMPT =
  'You are Ava, a calm, warm and concise voice companion. ' +
  'Answer in a natural, spoken style. Keep replies short — usually one or two ' +
  'sentences — unless the user explicitly asks for detail. Never use markdown, ' +
  'lists or emojis, because your reply will be spoken aloud.';

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly STORAGE_KEY = 'ava-llm-model';

  /** All available Gemma options, one recommended per device tier. */
  readonly models: LlmModelOption[] = [
    GEMMA_MODELS.low,
    GEMMA_MODELS.medium,
    GEMMA_MODELS.high,
  ];

  /** The chosen model id (auto-selected by hardware, user-overridable). */
  private readonly modelId = signal<string>(this.loadStoredModel());

  readonly selectedModel = computed(
    () => this.models.find(m => m.id === this.modelId()) ?? this.models[0]
  );

  readonly isLoading = signal(false);
  readonly isReady = signal(false);
  readonly loadInfo = signal('');

  private generator: any = null;
  private loadPromise: Promise<any> | null = null;

  /** Picks the best default model for this device unless the user has overridden it. */
  async autoSelectModel(): Promise<void> {
    if (this.hasUserOverride()) return;
    const { tier } = await detectDeviceCapability();
    this.modelId.set(GEMMA_MODELS[tier].id);
  }

  /** Explicit user override of the model size. Persisted across sessions. */
  setModel(id: string): void {
    if (!this.models.some(m => m.id === id)) return;
    this.modelId.set(id);
    try {
      localStorage.setItem(this.STORAGE_KEY, id);
    } catch {
      // ignore persistence errors
    }
    // Force a reload on next generate.
    this.generator = null;
    this.loadPromise = null;
    this.isReady.set(false);
  }

  /**
   * Lazily loads the Gemma generation pipeline with WebGPU → WASM fallback.
   * Safe to call repeatedly; the underlying load happens only once.
   */
  async ensureLoaded(): Promise<any> {
    if (this.generator) return this.generator;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.load();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async load(): Promise<any> {
    await this.autoSelectModel();
    const modelId = this.modelId();

    this.isLoading.set(true);
    this.isReady.set(false);

    const { hasWebGPU } = await detectDeviceCapability();
    const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: string; label: string }> = [];
    if (hasWebGPU) {
      attempts.push({ device: 'webgpu', dtype: 'q4f16', label: 'webgpu/q4f16' });
    }
    attempts.push(
      { device: 'wasm', dtype: 'q4', label: 'wasm/q4' },
      { device: 'wasm', dtype: 'q8', label: 'wasm/q8' }
    );

    let lastError: unknown = null;
    try {
      for (const attempt of attempts) {
        try {
          this.loadInfo.set(`loading ${this.selectedModel().name} (${attempt.label})…`);
          this.generator = await pipeline('text-generation', modelId, {
            device: attempt.device,
            dtype: attempt.dtype as any,
          });
          this.loadInfo.set(`${this.selectedModel().name} · ${attempt.label}`);
          this.isReady.set(true);
          console.info(`[Gemma] Loaded ${modelId} with ${attempt.label}`);
          return this.generator;
        } catch (err) {
          lastError = err;
          console.warn(`[Gemma] ${attempt.label} failed`, err);
          this.generator = null;
        }
      }
      this.loadInfo.set('Gemma could not be loaded.');
      throw lastError ?? new Error('Gemma load failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Generates a spoken-style reply for the given user text and prior history.
   * History should be the recent conversation turns (excluding the system prompt).
   */
  async generate(userText: string, history: ChatTurn[] = []): Promise<string> {
    const generator = await this.ensureLoaded();

    const messages: ChatTurn[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userText },
    ];

    const output: any = await generator(messages, {
      max_new_tokens: 192,
      do_sample: true,
      temperature: 0.7,
      top_p: 0.9,
    });

    return this.extractText(output);
  }

  private extractText(output: any): string {
    try {
      const generated = output?.[0]?.generated_text;
      if (Array.isArray(generated)) {
        // Chat-format output: take the final assistant turn.
        const last = generated.at(-1);
        return (last?.content ?? '').toString().trim();
      }
      if (typeof generated === 'string') {
        return generated.trim();
      }
    } catch {
      // fall through
    }
    return '';
  }

  private loadStoredModel(): string {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored && this.modelExists(stored)) return stored;
    } catch {
      // ignore
    }
    return GEMMA_MODELS.medium.id;
  }

  private modelExists(id: string): boolean {
    return [GEMMA_MODELS.low.id, GEMMA_MODELS.medium.id, GEMMA_MODELS.high.id].includes(id);
  }

  private hasUserOverride(): boolean {
    try {
      return !!localStorage.getItem(this.STORAGE_KEY);
    } catch {
      return false;
    }
  }
}
