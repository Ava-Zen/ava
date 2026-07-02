import { Injectable, signal, computed } from '@angular/core';
import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, DeviceTier, isAndroidWebView } from './device-capability';

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
  /**
   * Preferred dtype on GPU/NPU accelerators, overriding the default q4.
   * Some repos ship broken or missing variants for the default dtypes.
   */
  acceleratorDtype?: string;
}

type InferenceDevice = 'webnn-npu' | 'webnn-gpu' | 'webgpu' | 'wasm';

interface LoadAttempt {
  device: InferenceDevice;
  dtype: string;
  label: string;
}

/**
 * Catalogue of models used for *instant* spoken replies.
 *
 * These are kept deliberately small so the first token arrives quickly.
 * Repo ids point at the publicly available transformers.js ONNX builds;
 * swap them for newer builds as they are published.
 */
const GEMMA_1B: LlmModelOption = {
  id: 'gemma-3-1b',
  repoId: 'onnx-community/gemma-3-1b-it-ONNX',
  name: 'Gemma 1B',
  size: '~1 GB',
  tier: 'medium',
};

const GEMMA_1B_HQ: LlmModelOption = {
  id: 'gemma-3-1b-hq',
  repoId: 'onnx-community/gemma-3-1b-it-ONNX',
  name: 'Gemma 1B (HQ)',
  size: '~1.5 GB',
  tier: 'high',
};

// Qwen3 ONNX builds are meant to run as q4f16 on GPU/NPU (per their model cards).
const QWEN_0_6B: LlmModelOption = {
  id: 'qwen3-0.6b',
  repoId: 'onnx-community/Qwen3-0.6B-ONNX',
  name: 'Qwen3 0.6B',
  size: '~0.6 GB',
  tier: 'low',
  acceleratorDtype: 'q4f16',
};

const QWEN_1_7B: LlmModelOption = {
  id: 'qwen3-1.7b',
  repoId: 'onnx-community/Qwen3-1.7B-ONNX',
  name: 'Qwen3 1.7B',
  size: '~1.7 GB',
  tier: 'medium',
  acceleratorDtype: 'q4f16',
};

const QWEN_4B: LlmModelOption = {
  id: 'qwen3-4b',
  repoId: 'onnx-community/Qwen3-4B-ONNX',
  name: 'Qwen3 4B',
  size: '~4 GB',
  tier: 'high',
  acceleratorDtype: 'q4f16',
};

/** Default conversation model per device tier. */
const DEFAULT_MODELS: Record<DeviceTier, LlmModelOption> = {
  low: QWEN_0_6B,
  medium: GEMMA_1B,
  high: GEMMA_1B_HQ,
};

/** Smallest model, used as the fallback when the preferred one fails to load. */
const FALLBACK_MODEL = QWEN_0_6B;

const UNCENSORED_CHAT_MODEL: LlmModelOption = {
  id: 'qwen3-heretic-0.6b',
  repoId: 'onnx-community/Qwen3-0.6B-heretic-abliterated-uncensored-ONNX',
  name: 'Qwen3 Heretic 0.6B',
  size: '~0.6 GB',
  tier: 'medium',
  // This auto-converted export produces garbage tokens with plain q4 on
  // WebGPU/WebNN, and its fp16/fp32 variants are broken or impractically
  // large. q4f16 is the dtype the Qwen3 ONNX builds are meant to run with.
  acceleratorDtype: 'q4f16',
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
  private readonly ANDROID_LOAD_TIMEOUT_MS = 180000;

  /** All available conversation options, one recommended per device tier. */
  readonly models: LlmModelOption[] = [
    QWEN_0_6B,
    GEMMA_1B,
    GEMMA_1B_HQ,
    QWEN_1_7B,
    QWEN_4B,
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
  readonly downloadStatus = signal('');
  readonly activeModel = signal<LlmModelOption | null>(null);
  readonly thinkingTrace = signal<string[]>([]);

  private generator: any = null;
  private loadPromise: Promise<any> | null = null;
  private loadedDevice: InferenceDevice | null = null;

  /** Picks the best default model for this device unless the user has overridden it. */
  async autoSelectModel(): Promise<void> {
    if (this.hasUserOverride()) return;
    const { tier } = await detectDeviceCapability();
    this.modelId.set(DEFAULT_MODELS[tier].id);
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
    this.activeModel.set(null);
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

  async reloadOnCpu(): Promise<any> {
    this.generator = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
    return await this.load(true);
  }

  private async load(wasmOnly = false): Promise<any> {
    await this.autoSelectModel();
    const preferredModel = this.selectedModel();

    this.isLoading.set(true);
    this.isReady.set(false);
    this.activeModel.set(null);
    this.downloadStatus.set('Preparing model download…');

    const capability = await detectDeviceCapability();
    const acceleratorAttempts = wasmOnly ? [] : this.buildAcceleratorAttempts(capability);
    const hasAccelerator = acceleratorAttempts.length > 0;
    const candidates = this.buildCandidateModels(preferredModel, hasAccelerator);
    const attempts = hasAccelerator ? acceleratorAttempts : this.buildCpuLoadAttempts();

    let lastError: unknown = null;
    try {
      for (const model of candidates) {
        for (const attempt of this.attemptsForModel(model, attempts)) {
          try {
            this.loadInfo.set(`loading ${model.name} (${attempt.label})…`);
            const repoId = model.repoId ?? model.id;
            this.generator = await this.loadPipeline(repoId, attempt);
            this.loadInfo.set(`${model.name} · ${attempt.label}`);
            this.isReady.set(true);
            this.activeModel.set(model);
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
      this.loadInfo.set(hasAccelerator
        ? 'GPU/NPU chat failed. CPU fallback is available in Settings.'
        : 'Gemma could not be loaded.');
      throw lastError ?? new Error('Gemma load failed');
    } finally {
      this.isLoading.set(false);
      this.downloadStatus.set('');
    }
  }

  private buildCandidateModels(preferredModel: LlmModelOption, useAccelerator: boolean): LlmModelOption[] {
    if (!useAccelerator) {
      return [FALLBACK_MODEL];
    }

    return preferredModel.id === FALLBACK_MODEL.id
      ? [preferredModel]
      : [preferredModel, FALLBACK_MODEL];
  }

  private buildAcceleratorAttempts(capability: Awaited<ReturnType<typeof detectDeviceCapability>>): LoadAttempt[] {
    const attempts: LoadAttempt[] = [];
    if (capability.hasWebNN) {
      attempts.push({ device: 'webnn-npu', dtype: 'q4', label: 'webnn-npu/q4' });
      attempts.push({ device: 'webnn-gpu', dtype: 'q4', label: 'webnn-gpu/q4' });
    }
    if (capability.supportsLlmWebGPU) {
      attempts.push({ device: 'webgpu', dtype: 'q4', label: 'webgpu/q4' });
      // Note: not fp32 — the "fp32" model.onnx of these ONNX exports is a
      // mixed-precision graph with fp16 Cast nodes that WebGPU sessions reject.
      attempts.push({ device: 'webgpu', dtype: 'q4f16', label: 'webgpu/q4f16' });
    }
    return attempts;
  }

  private buildCpuLoadAttempts(): LoadAttempt[] {
    // q4 keeps the CPU fallback download small; the fp32 exports of these
    // repos ship multi-GB external data files.
    return [{ device: 'wasm', dtype: 'q4', label: 'wasm/q4' }];
  }

  /** Applies a model's pinned accelerator dtype to the generic attempt list. */
  private attemptsForModel(model: LlmModelOption, attempts: LoadAttempt[]): LoadAttempt[] {
    const dtype = model.acceleratorDtype;
    if (!dtype) return attempts;
    const seen = new Set<string>();
    return attempts
      .map(attempt =>
        attempt.device === 'wasm'
          ? attempt
          : { device: attempt.device, dtype, label: `${attempt.device}/${dtype}` }
      )
      .filter(attempt => {
        if (seen.has(attempt.label)) return false;
        seen.add(attempt.label);
        return true;
      });
  }

  private async loadPipeline(repoId: string, attempt: LoadAttempt): Promise<any> {
    this.downloadStatus.set(`Downloading ${repoId} (${attempt.label})…`);
    const load = pipeline('text-generation', repoId, {
      device: attempt.device,
      dtype: attempt.dtype as any,
      progress_callback: (event: any) => {
        if (event?.status === 'progress') {
          // transformers.js reports progress as a 0–100 percentage already.
          const progress = typeof event.progress === 'number'
            ? Math.min(100, Math.round(event.progress))
            : null;
          const file = event?.file ? ` · ${event.file}` : '';
          const suffix = progress != null ? ` (${progress}%)` : '';
          this.downloadStatus.set(`Downloading ${repoId}${file}${suffix}`);
        } else if (event?.status === 'done') {
          this.downloadStatus.set(`Downloaded ${repoId}`);
        }
      },
    });

    if (!isAndroidWebView()) return await load;

    return await Promise.race([
      load,
      new Promise((_, reject) => {
        window.setTimeout(
          () => reject(new Error(`Timed out loading ${repoId} (${attempt.label}) on Android WebView`)),
          this.ANDROID_LOAD_TIMEOUT_MS
        );
      }),
    ]);
  }

  /**
   * Generates a spoken-style reply for the given user text and prior history.
   * History should be the recent conversation turns (excluding the system prompt).
   */
  async generate(userText: string, history: ChatTurn[] = []): Promise<string> {
    this.thinkingTrace.set(['Preparing context', 'Building local prompt']);

    const options = {
      max_new_tokens: 192,
      do_sample: true,
      temperature: 0.7,
      top_p: 0.9,
    };

    try {
      const generator = await this.ensureLoaded();
      // Qwen3 models emit <think>…</think> reasoning that eats the short
      // spoken-reply token budget; the /no_think soft switch disables it.
      const active = this.activeModel();
      const isQwen = /qwen/i.test(`${active?.repoId ?? ''} ${active?.id ?? ''}`);
      const messages: ChatTurn[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: isQwen ? `${userText} /no_think` : userText },
      ];
      return await this.runGeneration(generator, messages, userText, history, options);
    } catch (e) {
      if (this.loadedDevice && this.loadedDevice !== 'wasm' && this.isRecoverableAcceleratorRuntimeError(e)) {
        console.warn('[Gemma] Accelerator generation failed; CPU fallback is available in Settings', e);
        this.loadInfo.set('GPU/NPU chat failed during generation. CPU fallback is available in Settings.');
      }
      this.thinkingTrace.set([]);
      throw e;
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

  private isRecoverableAcceleratorRuntimeError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /WebGPU|WebNN|GroupQueryAttention|workgroup storage|compute pipeline|OrtRun|GPU|NPU/i.test(message);
  }

  /**
   * Turns a raw generation/load failure into a short, friendly explanation the
   * user can act on. Returns null when the error is not one we recognise.
   */
  friendlyError(error: unknown): string | null {
    const message = String((error as any)?.message ?? error);
    const onCpu = this.loadedDevice === 'wasm';

    if (/workgroup storage|compute pipeline|GroupQueryAttention/i.test(message)) {
      return onCpu
        ? "This device ran low on memory for Ava's chat model. Try a smaller model in Settings or close some apps."
        : "Your graphics chip can't fit this chat model in accelerated mode. Switch to CPU in Settings → Conversation model, or pick a smaller model.";
    }
    if (/out of memory|oom|allocation failed|enough memory|insufficient/i.test(message)) {
      return 'Ava ran out of memory loading the chat model. Close some apps, free up space, or pick a smaller model in Settings.';
    }
    if (/WebGPU|WebNN|OrtRun|GPU|NPU|device lost/i.test(message)) {
      return "Ava's hardware acceleration hit a snag. Switch to CPU in Settings → Conversation model and try again.";
    }
    return null;
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

  sanitizeModelOutput(text: string, promptPrefix = ''): string {
    let cleaned = text;
    if (promptPrefix && cleaned.startsWith(promptPrefix)) {
      cleaned = cleaned.slice(promptPrefix.length);
    }

    cleaned = cleaned
      // Remove Qwen3-style reasoning blocks; an unterminated <think> means the
      // model never reached its answer, so drop everything from it onward.
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<think>[\s\S]*$/i, '')
      .replace(/<\/?think>/gi, '')
      .replace(/<\|im_start\|>\s*(system|user|assistant)\s*/gi, '')
      .replace(/<\|im_end\|>/gi, '')
      .replace(/^\s*(system|user|assistant)\s*[:\-]\s*/gi, '')
      .replace(/^(System|User|Ava|Assistant):[\s\S]*?\bAva:\s*/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  private cleanGeneratedText(text: string, promptPrefix = ''): string {
    return this.sanitizeModelOutput(text, promptPrefix);
  }

  private loadStoredModel(): string {
    try {
      if (localStorage.getItem(this.UNCENSORED_STORAGE_KEY) === '1') return UNCENSORED_CHAT_MODEL.id;
      const stored = localStorage.getItem(this.STORAGE_KEY);
      // Migrate legacy stored ids.
      if (stored === 'onnx-community/gemma-3-1b-it-ONNX') return GEMMA_1B.id;
      if (stored === 'onnx-community/gemma-3-270m-it-ONNX') return QWEN_0_6B.id;
      if (stored === UNCENSORED_CHAT_MODEL.repoId) return UNCENSORED_CHAT_MODEL.id;
      if (stored && this.modelExists(stored)) return stored;
    } catch {
      // ignore
    }
    return GEMMA_1B.id;
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
