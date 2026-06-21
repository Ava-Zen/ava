import { Injectable, signal, computed } from '@angular/core';
import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, DeviceTier } from './device-capability';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmModelOption {
  /** Stable UI/config id. */
  id: string;
  /** Hugging Face ONNX repo id (transformers.js compatible). */
  repoId?: string;
  /** Friendly label shown in the UI. */
  name: string;
  /** Rough on-disk / VRAM footprint, for user guidance. */
  size: string;
  /** Device tier this option is the default for. */
  tier: DeviceTier;
}

interface LoadAttempt {
  device: 'webgpu' | 'wasm';
  dtype: string;
  label: string;
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
    id: 'gemma-3-1b',
    repoId: 'onnx-community/gemma-3-1b-it-ONNX',
    name: 'Gemma 1B',
    size: '~1 GB',
    tier: 'medium',
  },
  high: {
    id: 'gemma-3-1b-hq',
    repoId: 'onnx-community/gemma-3-1b-it-ONNX',
    name: 'Gemma 1B (HQ)',
    size: '~1.5 GB',
    tier: 'high',
  },
};

const UNCENSORED_CHAT_MODEL: LlmModelOption = {
  id: 'qwen3-heretic-0.6b',
  repoId: 'onnx-community/Qwen3-0.6B-heretic-abliterated-uncensored-ONNX',
  name: 'Qwen3 Heretic 0.6B',
  size: '~0.6 GB',
  tier: 'medium',
};

const SYSTEM_PROMPT =
  'You are Ava, a calm, warm and concise voice companion. ' +
  'Answer in a natural, spoken style. Keep replies short — usually one or two ' +
  'sentences — unless the user explicitly asks for detail. Never use markdown, ' +
  'lists or emojis, because your reply will be spoken aloud.';

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly STORAGE_KEY = 'ava-llm-model';
  private readonly UNCENSORED_STORAGE_KEY = 'ava-llm-uncensored';

  /** All available Gemma options, one recommended per device tier. */
  readonly models: LlmModelOption[] = [
    GEMMA_MODELS.low,
    GEMMA_MODELS.medium,
    GEMMA_MODELS.high,
    UNCENSORED_CHAT_MODEL,
  ];

  /** The chosen model id (auto-selected by hardware, user-overridable). */
  private readonly modelId = signal<string>(this.loadStoredModel());

  readonly selectedModel = computed(
    () => this.models.find(m => m.id === this.modelId()) ?? this.models[0]
  );
  readonly isUncensoredMode = computed(() => this.selectedModel().id === UNCENSORED_CHAT_MODEL.id);
  readonly uncensoredModel = UNCENSORED_CHAT_MODEL;

  readonly isLoading = signal(false);
  readonly isReady = signal(false);
  readonly loadInfo = signal('');
  readonly thinkingTrace = signal<string[]>([]);

  private generator: any = null;
  private loadPromise: Promise<any> | null = null;
  private loadedDevice: 'webgpu' | 'wasm' | null = null;

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
      localStorage.removeItem(this.UNCENSORED_STORAGE_KEY);
    } catch {
      // ignore persistence errors
    }
    // Force a reload on next generate.
    this.generator = null;
    this.loadPromise = null;
    this.loadedDevice = null;
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

  private async load(wasmOnly = false): Promise<any> {
    await this.autoSelectModel();
    const preferredModel = this.selectedModel();

    this.isLoading.set(true);
    this.isReady.set(false);

    const { supportsLlmWebGPU } = await detectDeviceCapability();
    const useWebGPU = supportsLlmWebGPU && !wasmOnly;
    const candidates = this.buildCandidateModels(preferredModel, useWebGPU);
    const attempts = this.buildLoadAttempts(useWebGPU);

    let lastError: unknown = null;
    try {
      for (const model of candidates) {
        for (const attempt of attempts) {
          try {
            this.loadInfo.set(`loading ${model.name} (${attempt.label})…`);
            const repoId = model.repoId ?? model.id;
            this.generator = await pipeline('text-generation', repoId, {
              device: attempt.device,
              dtype: attempt.dtype as any,
            });
            this.loadInfo.set(`${model.name} · ${attempt.label}`);
            this.isReady.set(true);
            this.loadedDevice = attempt.device;
            console.info(`[Gemma] Loaded ${repoId} with ${attempt.label}`);
            return this.generator;
          } catch (err) {
            lastError = err;
            console.warn(`[Gemma] ${model.repoId ?? model.id} ${attempt.label} failed`, err);
            this.generator = null;
            this.loadedDevice = null;
          }
        }
      }
      this.loadInfo.set('Gemma could not be loaded.');
      throw lastError ?? new Error('Gemma load failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  private buildCandidateModels(preferredModel: LlmModelOption, useWebGPU: boolean): LlmModelOption[] {
    if (!useWebGPU) {
      return [GEMMA_MODELS.low];
    }

    const fallbackModel = GEMMA_MODELS.low;
    return preferredModel.id === fallbackModel.id
      ? [preferredModel]
      : [preferredModel, fallbackModel];
  }

  private buildLoadAttempts(hasWebGPU: boolean): LoadAttempt[] {
    const attempts: LoadAttempt[] = [];
    if (hasWebGPU) {
      attempts.push({ device: 'webgpu', dtype: 'q4', label: 'webgpu/q4' });
      attempts.push({ device: 'webgpu', dtype: 'fp32', label: 'webgpu/fp32' });
    }

    // Current ONNX Runtime Web's WASM backend cannot execute some block-
    // quantized Gemma graphs, and 1B fp32 can exceed WebView memory. Use fp32
    // only with the small CPU fallback model.
    attempts.push({ device: 'wasm', dtype: 'fp32', label: 'wasm/fp32' });
    return attempts;
  }

  /**
   * Generates a spoken-style reply for the given user text and prior history.
   * History should be the recent conversation turns (excluding the system prompt).
   */
  async generate(userText: string, history: ChatTurn[] = []): Promise<string> {
    this.thinkingTrace.set(['Preparing context', 'Building local prompt']);

    const messages: ChatTurn[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: userText },
    ];

    const options = {
      max_new_tokens: 192,
      do_sample: true,
      temperature: 0.7,
      top_p: 0.9,
    };

    try {
      const generator = await this.ensureLoaded();
      return await this.runGeneration(generator, messages, userText, history, options);
    } catch (e) {
      if (!this.isRecoverableWebGpuRuntimeError(e) || this.loadedDevice !== 'webgpu') {
        this.thinkingTrace.set([]);
        throw e;
      }

      console.warn('[Gemma] WebGPU generation failed; retrying on WASM', e);
      this.thinkingTrace.set(['Preparing context', 'Switching chat model to CPU', 'Generating reply']);
      const generator = await this.reloadOnWasm();
      try {
        return await this.runGeneration(generator, messages, userText, history, options);
      } catch (retryError) {
        this.thinkingTrace.set([]);
        throw retryError;
      }
    }
  }

  private async runGeneration(
    generator: any,
    messages: ChatTurn[],
    userText: string,
    history: ChatTurn[],
    options: Record<string, unknown>
  ): Promise<string> {
    let output: any;
    let promptPrefix = '';
    try {
      this.thinkingTrace.set(['Preparing context', 'Generating reply']);
      output = await generator(messages, options);
    } catch (e) {
      if (!this.isMissingChatTemplateError(e)) throw e;
      this.thinkingTrace.set(['Preparing context', 'Using plain prompt fallback', 'Generating reply']);
      promptPrefix = this.buildPlainPrompt(userText, history);
      output = await generator(promptPrefix, options);
    }

    this.thinkingTrace.set(['Preparing context', 'Generating reply', 'Cleaning response']);
    const reply = this.extractText(output, promptPrefix);
    this.thinkingTrace.set([]);
    return reply;
  }

  private async reloadOnWasm(): Promise<any> {
    this.generator = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    return await this.load(true);
  }

  private buildPlainPrompt(userText: string, history: ChatTurn[]): string {
    const turns = history
      .filter(turn => turn.role !== 'system')
      .map(turn =>
        `<|im_start|>${turn.role === 'assistant' ? 'assistant' : 'user'}\n${turn.content}<|im_end|>`
      )
      .join('\n');

    return [
      `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>`,
      turns,
      `<|im_start|>user\n${userText}<|im_end|>`,
      '<|im_start|>assistant\n',
    ].filter(Boolean).join('\n');
  }

  private isMissingChatTemplateError(error: unknown): boolean {
    return /chat_template|apply_chat_template/i.test(String((error as any)?.message ?? error));
  }

  private isRecoverableWebGpuRuntimeError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /WebGPU|GroupQueryAttention|workgroup storage|compute pipeline|OrtRun|GPU/i.test(message);
  }

  private extractText(output: any, promptPrefix = ''): string {
    try {
      const generated = output?.[0]?.generated_text;
      if (Array.isArray(generated)) {
        // Chat-format output: take the final assistant turn.
        const last = generated.at(-1);
        return this.cleanGeneratedText((last?.content ?? '').toString(), promptPrefix);
      }
      if (typeof generated === 'string') {
        return this.cleanGeneratedText(generated, promptPrefix);
      }
    } catch {
      // fall through
    }
    return '';
  }

  private cleanGeneratedText(text: string, promptPrefix = ''): string {
    let cleaned = text;
    if (promptPrefix && cleaned.startsWith(promptPrefix)) {
      cleaned = cleaned.slice(promptPrefix.length);
    }
    cleaned = cleaned
      .replace(/<\|im_start\|>\s*assistant\s*/gi, '')
      .replace(/<\|im_end\|>/gi, '')
      .replace(/^(System|User|Ava|Assistant):[\s\S]*?\bAva:\s*/i, '')
      .trim();
    return cleaned;
  }

  private loadStoredModel(): string {
    try {
      if (localStorage.getItem(this.UNCENSORED_STORAGE_KEY) === '1') return UNCENSORED_CHAT_MODEL.id;
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored === 'onnx-community/gemma-3-1b-it-ONNX') return GEMMA_MODELS.medium.id;
      if (stored === UNCENSORED_CHAT_MODEL.repoId) return UNCENSORED_CHAT_MODEL.id;
      if (stored && this.modelExists(stored)) return stored;
    } catch {
      // ignore
    }
    return GEMMA_MODELS.medium.id;
  }

  private modelExists(id: string): boolean {
    return this.models.some(model => model.id === id);
  }

  private hasUserOverride(): boolean {
    try {
      return !!localStorage.getItem(this.STORAGE_KEY);
    } catch {
      return false;
    }
  }
}
