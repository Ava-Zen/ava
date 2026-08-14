import { DeviceTier } from '../device-capability';

/** A single conversation turn exchanged with a chat model. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Reference to a GGUF build of a model, consumed by the native llama.cpp engine. */
export interface GgufSource {
  /** Hugging Face repo id hosting the GGUF files. */
  repoId: string;
  /** File name of the quantised build to download (e.g. `*-Q4_K_M.gguf`). */
  file: string;
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
   * Only meaningful for the transformers.js backend.
   */
  acceleratorDtype?: string;
  /** GGUF build for the native llama.cpp engine (Tauri builds only). */
  gguf?: GgufSource;
  /** Where this option runs. Local catalogue entries omit this. */
  provider?: 'local' | 'grok' | 'copilot';
}

export interface GeneratedImage {
  dataUrl: string;
  prompt?: string;
}

export interface ChatResult {
  text: string;
  images?: GeneratedImage[];
}

/** Sampling/generation options, backend-agnostic. */
export interface ChatGenerateOptions {
  maxNewTokens: number;
  temperature: number;
  topP: number;
  doSample: boolean;
  /** Cloud model id when the backend talks to a remote API. */
  modelId?: string;
  /** Streaming hook; backends that support it deliver incremental text. */
  onToken?: (chunk: string) => void;
}

/** Result of a successful backend load. */
export interface LoadedBackendModel {
  /** The catalogue entry that actually loaded (may be a fallback). */
  model: LlmModelOption;
  /** Execution device, e.g. 'webgpu', 'wasm', 'native-gpu', 'native-cpu'. */
  device: string;
  /** Human-readable summary for the UI, e.g. 'Gemma 1B · webgpu/q4'. */
  label: string;
}

export interface ChatBackendLoadOptions {
  /** Smallest model to fall back to when the preferred one fails. */
  fallback?: LlmModelOption;
  /** Force CPU execution (user-initiated fallback from Settings). */
  cpuOnly?: boolean;
  /** UI hook: short status line, e.g. 'loading Gemma 1B (webgpu/q4)…'. */
  onLoadInfo?: (info: string) => void;
  /** UI hook: download progress line. */
  onDownloadStatus?: (status: string) => void;
}

/**
 * A chat inference engine. Implementations:
 *
 * - `TransformersChatBackend` — transformers.js + ONNX Runtime Web inside the
 *   WebView (works everywhere, including plain browsers).
 * - `NativeLlamaBackend` — llama.cpp hosted in the Tauri (Rust) process,
 *   using GGUF models stored on disk (desktop + mobile builds).
 * - `GrokChatBackend` — xAI Responses API after a SuperGrok / API-key login.
 *
 * Use `resolveChatBackend()` to pick the best available local engine.
 */
export interface ChatBackend {
  readonly kind: 'transformers-js' | 'native-llama' | 'grok';

  /**
   * Loads the preferred model, falling back as needed. Throws when nothing
   * could be loaded.
   */
  load(preferred: LlmModelOption, options: ChatBackendLoadOptions): Promise<LoadedBackendModel>;

  /** Generates a completion for the given conversation. Requires `load()`. */
  generate(messages: ChatTurn[], options: ChatGenerateOptions): Promise<ChatResult>;

  /** True once a model is loaded and ready to generate. */
  isLoaded(): boolean;

  /** Releases the loaded model so the next `load()` starts fresh. */
  dispose(): void;
}

let backendPromise: Promise<ChatBackend> | null = null;

/**
 * Picks the best available chat backend: the native llama.cpp engine when the
 * Tauri host reports it, otherwise the in-WebView transformers.js engine.
 * The choice is made once per session.
 */
export function resolveChatBackend(): Promise<ChatBackend> {
  backendPromise ??= (async () => {
    const [{ NativeLlamaBackend }, { TransformersChatBackend }] = await Promise.all([
      import('./native-llama-backend'),
      import('./transformers-chat-backend'),
    ]);
    return (await NativeLlamaBackend.detect()) ?? new TransformersChatBackend();
  })();
  return backendPromise;
}
