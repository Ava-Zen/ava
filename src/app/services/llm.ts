import { Injectable, signal, computed } from '@angular/core';
import { detectDeviceCapability, DeviceTier } from './device-capability';
import {
  ChatBackend,
  ChatTurn,
  LlmModelOption,
  resolveChatBackend,
} from './llm/chat-backend';
import {
  NativeLlamaBackend,
  NATIVE_CHAT_MODELS,
  NATIVE_DEFAULT_MODELS,
  NATIVE_FALLBACK_MODEL,
} from './llm/native-llama-backend';

// Re-exported for existing consumers (AgentsService, components, specs).
export type { ChatTurn, LlmModelOption } from './llm/chat-backend';

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

/** Default conversation model per device tier (web/transformers.js engine). */
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

/** Conversation options for the in-WebView (transformers.js) engine. */
const WEB_CHAT_MODELS: LlmModelOption[] = [
  QWEN_0_6B,
  GEMMA_1B,
  GEMMA_1B_HQ,
  QWEN_1_7B,
  QWEN_4B,
  UNCENSORED_CHAT_MODEL,
];

@Injectable({ providedIn: 'root' })
export class LlmService {
  private readonly STORAGE_KEY = 'ava-llm-model';
  private readonly UNCENSORED_STORAGE_KEY = 'ava-llm-uncensored';

  /** True when the Tauri host provides the native llama.cpp engine. */
  private readonly nativeEngine = signal(false);

  /**
   * Available conversation options for the active engine: GGUF builds when the
   * native engine is present, ONNX builds for the in-WebView engine.
   */
  readonly models = computed<LlmModelOption[]>(() =>
    this.nativeEngine() ? NATIVE_CHAT_MODELS : WEB_CHAT_MODELS
  );

  /** The chosen model id (auto-selected by hardware, user-overridable). */
  private readonly modelId = signal<string>(this.loadStoredModel());

  readonly selectedModel = computed(
    () => this.models().find(m => m.id === this.modelId()) ?? this.models()[0]
  );
  readonly isUncensoredMode = computed(() => this.selectedModel().id === UNCENSORED_CHAT_MODEL.id);
  readonly uncensoredModel = UNCENSORED_CHAT_MODEL;

  readonly isLoading = signal(false);
  readonly isReady = signal(false);
  readonly loadInfo = signal('');
  readonly downloadStatus = signal('');
  readonly activeModel = signal<LlmModelOption | null>(null);
  readonly thinkingTrace = signal<string[]>([]);

  private backend: ChatBackend | null = null;
  private loadPromise: Promise<ChatBackend> | null = null;
  private loadedDevice: string | null = null;

  constructor() {
    // Probe the host early so Settings shows the right catalogue before the
    // first generation. Cheap: one IPC call, no model download.
    void NativeLlamaBackend.detect().then(backend => {
      if (backend) this.nativeEngine.set(true);
    });
  }

  /** Picks the best default model for this device unless the user has overridden it. */
  async autoSelectModel(): Promise<void> {
    if (this.hasUserOverride()) return;
    const { tier } = await detectDeviceCapability();
    const defaults = this.nativeEngine() ? NATIVE_DEFAULT_MODELS : DEFAULT_MODELS;
    this.modelId.set(defaults[tier].id);
  }

  /** Explicit user override of the model size. Persisted across sessions. */
  setModel(id: string): void {
    if (!this.models().some(m => m.id === id)) return;
    this.modelId.set(id);
    try {
      localStorage.setItem(this.STORAGE_KEY, id);
      localStorage.removeItem(this.UNCENSORED_STORAGE_KEY);
    } catch {
      // ignore persistence errors
    }
    // Force a reload on next generate.
    this.backend?.dispose();
    this.backend = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
  }

  /**
   * Lazily loads the chat engine (native llama.cpp in Tauri builds, otherwise
   * transformers.js in the WebView). Safe to call repeatedly; the underlying
   * load happens only once.
   */
  async ensureLoaded(): Promise<ChatBackend> {
    if (this.backend?.isLoaded()) return this.backend;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.load();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  async reloadOnCpu(): Promise<ChatBackend> {
    this.backend?.dispose();
    this.backend = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
    return await this.load(true);
  }

  private async load(cpuOnly = false): Promise<ChatBackend> {
    this.isLoading.set(true);
    this.isReady.set(false);
    this.activeModel.set(null);
    this.downloadStatus.set('Preparing model download…');

    try {
      const backend = await resolveChatBackend();
      this.nativeEngine.set(backend.kind === 'native-llama');
      await this.autoSelectModel();
      const preferredModel = this.selectedModel();
      const fallback = backend.kind === 'native-llama' ? NATIVE_FALLBACK_MODEL : FALLBACK_MODEL;

      const loaded = await backend.load(preferredModel, {
        fallback,
        cpuOnly,
        onLoadInfo: info => this.loadInfo.set(info),
        onDownloadStatus: status => this.downloadStatus.set(status),
      });

      this.backend = backend;
      this.loadedDevice = loaded.device;
      this.loadInfo.set(loaded.label);
      this.isReady.set(true);
      this.activeModel.set(loaded.model);
      return backend;
    } catch (err) {
      const capability = await detectDeviceCapability();
      const hasAccelerator = !cpuOnly && (capability.hasWebNN || capability.supportsLlmWebGPU);
      this.loadInfo.set(hasAccelerator
        ? 'GPU/NPU chat failed. CPU fallback is available in Settings.'
        : 'The chat model could not be loaded.');
      throw err;
    } finally {
      this.isLoading.set(false);
      this.downloadStatus.set('');
    }
  }

  /**
   * Generates a spoken-style reply for the given user text and prior history.
   * History should be the recent conversation turns (excluding the system prompt).
   */
  async generate(userText: string, history: ChatTurn[] = []): Promise<string> {
    this.thinkingTrace.set(['Preparing context', 'Building local prompt']);

    try {
      const backend = await this.ensureLoaded();
      // Qwen models emit <think>…</think> reasoning that eats the short
      // spoken-reply token budget; the /no_think soft switch disables it.
      const active = this.activeModel();
      const isQwen = /qwen/i.test(`${active?.repoId ?? ''} ${active?.id ?? ''}`);
      const messages: ChatTurn[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: isQwen ? `${userText} /no_think` : userText },
      ];

      this.thinkingTrace.set(['Preparing context', 'Generating reply']);
      const raw = await backend.generate(messages, {
        maxNewTokens: 192,
        doSample: true,
        temperature: 0.7,
        topP: 0.9,
      });

      this.thinkingTrace.set(['Preparing context', 'Generating reply', 'Cleaning response']);
      const reply = this.sanitizeModelOutput(raw);
      this.thinkingTrace.set([]);
      return reply;
    } catch (e) {
      if (this.loadedDevice && this.loadedDevice !== 'wasm' && this.isRecoverableAcceleratorRuntimeError(e)) {
        console.warn('[LLM] Accelerator generation failed; CPU fallback is available in Settings', e);
        this.loadInfo.set('GPU/NPU chat failed during generation. CPU fallback is available in Settings.');
      }
      this.thinkingTrace.set([]);
      throw e;
    }
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
    return this.models().some(model => model.id === id);
  }

  private hasUserOverride(): boolean {
    try {
      return !!localStorage.getItem(this.STORAGE_KEY);
    } catch {
      return false;
    }
  }
}
