import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, isAndroidWebView } from '../device-capability';
import {
  ChatBackend,
  ChatBackendLoadOptions,
  ChatGenerateOptions,
  ChatTurn,
  LlmModelOption,
  LoadedBackendModel,
} from './chat-backend';

type InferenceDevice = 'webnn-npu' | 'webnn-gpu' | 'webgpu' | 'wasm';

interface LoadAttempt {
  device: InferenceDevice;
  dtype: string;
  label: string;
}

const ANDROID_LOAD_TIMEOUT_MS = 180000;

/**
 * Chat engine running inside the WebView via transformers.js + ONNX Runtime
 * Web. Tries WebNN/WebGPU accelerator variants first, then falls back to a
 * small model, and finally to CPU (wasm) when no accelerator is available.
 */
export class TransformersChatBackend implements ChatBackend {
  readonly kind = 'transformers-js' as const;

  private generator: any = null;

  async load(preferred: LlmModelOption, options: ChatBackendLoadOptions): Promise<LoadedBackendModel> {
    this.dispose();

    const capability = await detectDeviceCapability();
    const acceleratorAttempts = options.cpuOnly ? [] : this.buildAcceleratorAttempts(capability);
    const hasAccelerator = acceleratorAttempts.length > 0;
    const candidates = this.buildCandidateModels(preferred, options.fallback, hasAccelerator);
    const attempts = hasAccelerator ? acceleratorAttempts : this.buildCpuLoadAttempts();

    let lastError: unknown = null;
    for (const model of candidates) {
      for (const attempt of this.attemptsForModel(model, attempts)) {
        try {
          options.onLoadInfo?.(`loading ${model.name} (${attempt.label})…`);
          const repoId = model.repoId ?? model.id;
          this.generator = await this.loadPipeline(repoId, attempt, options);
          console.info(`[LLM] Loaded ${repoId} with ${attempt.label}`);
          return { model, device: attempt.device, label: `${model.name} · ${attempt.label}` };
        } catch (err) {
          lastError = err;
          console.warn(`[LLM] ${model.repoId ?? model.id} ${attempt.label} failed`, err);
          this.generator = null;
        }
      }
    }
    throw lastError ?? new Error('Chat model load failed');
  }

  async generate(messages: ChatTurn[], options: ChatGenerateOptions): Promise<string> {
    if (!this.generator) throw new Error('Chat model is not loaded');

    const genOptions = {
      max_new_tokens: options.maxNewTokens,
      do_sample: options.doSample,
      temperature: options.temperature,
      top_p: options.topP,
    };

    let output: any;
    let promptPrefix = '';
    try {
      output = await this.generator(messages, genOptions);
    } catch (e) {
      if (!this.isMissingChatTemplateError(e)) throw e;
      // Repo has no chat template: fall back to a hand-built ChatML prompt.
      promptPrefix = this.buildPlainPrompt(messages);
      output = await this.generator(promptPrefix, genOptions);
    }

    return this.extractText(output, promptPrefix);
  }

  isLoaded(): boolean {
    return this.generator != null;
  }

  dispose(): void {
    this.generator = null;
  }

  private buildCandidateModels(
    preferred: LlmModelOption,
    fallback: LlmModelOption | undefined,
    useAccelerator: boolean
  ): LlmModelOption[] {
    if (!useAccelerator) {
      // CPU can only sensibly run the smallest model.
      return [fallback ?? preferred];
    }
    if (!fallback || preferred.id === fallback.id) return [preferred];
    return [preferred, fallback];
  }

  private buildAcceleratorAttempts(
    capability: Awaited<ReturnType<typeof detectDeviceCapability>>
  ): LoadAttempt[] {
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

  private async loadPipeline(
    repoId: string,
    attempt: LoadAttempt,
    options: ChatBackendLoadOptions
  ): Promise<any> {
    options.onDownloadStatus?.(`Downloading ${repoId} (${attempt.label})…`);
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
          options.onDownloadStatus?.(`Downloading ${repoId}${file}${suffix}`);
        } else if (event?.status === 'done') {
          options.onDownloadStatus?.(`Downloaded ${repoId}`);
        }
      },
    });

    if (!isAndroidWebView()) return await load;

    return await Promise.race([
      load,
      new Promise((_, reject) => {
        window.setTimeout(
          () => reject(new Error(`Timed out loading ${repoId} (${attempt.label}) on Android WebView`)),
          ANDROID_LOAD_TIMEOUT_MS
        );
      }),
    ]);
  }

  private buildPlainPrompt(messages: ChatTurn[]): string {
    const turns = messages.map(turn => `<|im_start|>${turn.role}\n${turn.content}<|im_end|>`);
    return [...turns, '<|im_start|>assistant\n'].join('\n');
  }

  private isMissingChatTemplateError(error: unknown): boolean {
    return /chat_template|apply_chat_template/i.test(String((error as any)?.message ?? error));
  }

  /** Pulls the assistant text out of the pipeline output shape. */
  private extractText(output: any, promptPrefix: string): string {
    const generated = output?.[0]?.generated_text;
    let text = '';
    if (Array.isArray(generated)) {
      text = (generated.at(-1)?.content ?? '').toString();
    } else if (typeof generated === 'string') {
      text = generated;
    }
    if (promptPrefix && text.startsWith(promptPrefix)) {
      text = text.slice(promptPrefix.length);
    }
    return text;
  }
}
