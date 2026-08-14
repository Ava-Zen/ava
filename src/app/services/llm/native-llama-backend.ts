import {
  ChatBackend,
  ChatBackendLoadOptions,
  ChatGenerateOptions,
  ChatResult,
  ChatTurn,
  LlmModelOption,
  LoadedBackendModel,
} from './chat-backend';
import { isAndroidWebView } from '../device-capability';

/**
 * Conversation catalogue for the native engine (llama.cpp, GGUF, Q4_K_M).
 *
 * Repo ids verified on Hugging Face (unsloth GGUF builds of the official
 * Qwen3.5 / Gemma 4 releases).
 */
export const NATIVE_CHAT_MODELS: LlmModelOption[] = [
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5 0.8B',
    size: '~0.5 GB',
    tier: 'low',
    gguf: { repoId: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'Qwen3.5-0.8B-Q4_K_M.gguf' },
  },
  {
    id: 'gemma4-e2b',
    name: 'Gemma 4 E2B',
    size: '~3.1 GB',
    tier: 'medium',
    gguf: { repoId: 'unsloth/gemma-4-E2B-it-GGUF', file: 'gemma-4-E2B-it-Q4_K_M.gguf' },
  },
  {
    id: 'gemma4-e4b',
    name: 'Gemma 4 E4B',
    size: '~5 GB',
    tier: 'high',
    gguf: { repoId: 'unsloth/gemma-4-E4B-it-GGUF', file: 'gemma-4-E4B-it-Q4_K_M.gguf' },
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    size: '~2.5 GB',
    tier: 'high',
    gguf: { repoId: 'unsloth/Qwen3.5-4B-GGUF', file: 'Qwen3.5-4B-Q4_K_M.gguf' },
  },
  {
    id: 'gemma4-12b',
    name: 'Gemma 4 12B',
    size: '~7 GB',
    tier: 'high',
    gguf: { repoId: 'unsloth/gemma-4-12b-it-GGUF', file: 'gemma-4-12b-it-Q4_K_M.gguf' },
  },
];

/** Default native conversation model per device tier (12B is opt-in only). */
export const NATIVE_DEFAULT_MODELS = {
  low: NATIVE_CHAT_MODELS[0],   // Qwen3.5 0.8B
  medium: NATIVE_CHAT_MODELS[1], // Gemma 4 E2B
  high: NATIVE_CHAT_MODELS[2],   // Gemma 4 E4B
} as const;

/** Smallest native model, used as load fallback. */
export const NATIVE_FALLBACK_MODEL = NATIVE_CHAT_MODELS[0];

interface NativeLlmStatus {
  available: boolean;
  engine?: string;
  devices?: string[];
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Client for the native llama.cpp engine hosted in the Tauri (Rust) process.
 *
 * IPC contract (implemented incrementally in `src-tauri/src/llm.rs`):
 * - `llm_native_status()` → `{ available, engine, devices }`
 *   Reports whether the bundled engine can run on this device. Currently a
 *   stub returning `available: false`; flip once the engine lands.
 * - `llm_load_model({ repoId, file, onProgress: Channel<{ status, progress }> })`
 *   → `{ device, label }` — downloads (resumable, checksummed) into the app
 *   data dir and loads the model with the best available backend
 *   (Vulkan/Metal/CUDA → CPU).
 * - `llm_generate({ messages, options, onToken: Channel<string> })` → `string`
 *   Applies the model's own chat template; streams tokens over the channel.
 * - `llm_cancel()` — aborts the in-flight generation.
 */
export class NativeLlamaBackend implements ChatBackend {
  readonly kind = 'native-llama' as const;

  private loaded = false;

  /** Returns a backend instance when the Tauri host reports a usable engine. */
  static async detect(): Promise<NativeLlamaBackend | null> {
    if (!isTauri() || isAndroidWebView()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<NativeLlmStatus>('llm_native_status');
      if (status?.available) return new NativeLlamaBackend();
    } catch {
      // Command not present in this build — native engine not bundled.
    }
    return null;
  }

  async load(preferred: LlmModelOption, options: ChatBackendLoadOptions): Promise<LoadedBackendModel> {
    if (isAndroidWebView()) {
      throw new Error('Native model loading is disabled on Android; the web engine will be used instead');
    }

    const gguf = preferred.gguf;
    if (!gguf) {
      throw new Error(`Model ${preferred.id} has no GGUF build for the native engine`);
    }

    const { invoke, Channel } = await import('@tauri-apps/api/core');

    const onProgress = new Channel<{ status: string; progress?: number }>();
    onProgress.onmessage = event => {
      const suffix = typeof event.progress === 'number' ? ` (${Math.round(event.progress)}%)` : '';
      options.onDownloadStatus?.(`${event.status}${suffix}`);
    };

    options.onLoadInfo?.(`loading ${preferred.name} (llama.cpp)…`);
    const result = await invoke<{ device: string; label: string }>('llm_load_model', {
      repoId: gguf.repoId,
      file: gguf.file,
      displayName: preferred.name,
      onProgress,
    });

    this.loaded = true;
    return {
      model: preferred,
      device: result.device,
      label: `${preferred.name} · ${result.label}`,
    };
  }

  async generate(messages: ChatTurn[], options: ChatGenerateOptions): Promise<ChatResult> {
    if (!this.loaded) throw new Error('Native chat model is not loaded');

    const { invoke, Channel } = await import('@tauri-apps/api/core');

    const onToken = new Channel<string>();
    if (options.onToken) {
      onToken.onmessage = chunk => options.onToken?.(chunk);
    }

    const text = await invoke<string>('llm_generate', {
      messages,
      options: {
        maxNewTokens: options.maxNewTokens,
        temperature: options.temperature,
        topP: options.topP,
        doSample: options.doSample,
      },
      onToken,
    });
    return { text };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  dispose(): void {
    this.loaded = false;
  }
}
