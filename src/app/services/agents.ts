import { Injectable, signal, computed } from '@angular/core';
import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, DeviceTier } from './device-capability';
import { ChatTurn, LlmModelOption } from './llm';

export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'error';

export interface AgentTask {
  id: string;
  /** Natural-language instruction the user gave for this agent. */
  prompt: string;
  status: AgentTaskStatus;
  result?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Catalogue of Qwen models used for background agent work.
 *
 * Agents favour reasoning quality over latency, so these are larger than the
 * instant-reply Gemma models. Repo ids point at the publicly available
 * transformers.js ONNX builds of the Qwen3 family; swap them for newer Qwen
 * builds as they are published.
 */
const QWEN_MODELS: Record<DeviceTier, LlmModelOption> = {
  low: {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    name: 'Qwen3 0.6B',
    size: '~0.6 GB',
    tier: 'low',
  },
  medium: {
    id: 'onnx-community/Qwen3-1.7B-ONNX',
    name: 'Qwen3 1.7B',
    size: '~1.7 GB',
    tier: 'medium',
  },
  high: {
    id: 'onnx-community/Qwen3-4B-ONNX',
    name: 'Qwen3 4B',
    size: '~4 GB',
    tier: 'high',
  },
};

const UNCENSORED_AGENT_MODEL: LlmModelOption = {
  id: 'onnx-community/Qwen3-0.6B-heretic-abliterated-uncensored-ONNX',
  name: 'Qwen3 Heretic 0.6B',
  size: '~0.6 GB',
  tier: 'medium',
};

const AGENT_SYSTEM_PROMPT =
  'You are an autonomous background agent working on behalf of Ava, a voice ' +
  'companion. You are given a single task and must complete it carefully and ' +
  'thoroughly. Think step by step, then provide a clear, well-structured result. ' +
  'You may use detail and structure here since this output is read, not spoken.';

@Injectable({ providedIn: 'root' })
export class AgentsService {
  private readonly STORAGE_KEY = 'ava-agent-model';

  readonly models: LlmModelOption[] = [
    QWEN_MODELS.low,
    QWEN_MODELS.medium,
    QWEN_MODELS.high,
    UNCENSORED_AGENT_MODEL,
  ];

  private readonly modelId = signal<string>(this.loadStoredModel());

  readonly selectedModel = computed(
    () => this.models.find(m => m.id === this.modelId()) ?? this.models[0]
  );

  readonly isLoading = signal(false);
  readonly isReady = signal(false);
  readonly loadInfo = signal('');

  /** Reactive list of agent tasks (most recent last). */
  readonly tasks = signal<AgentTask[]>([]);
  readonly activeTasks = computed(() =>
    this.tasks().filter(t => t.status === 'queued' || t.status === 'running')
  );
  readonly hasActiveTasks = computed(() => this.activeTasks().length > 0);

  private generator: any = null;
  private loadPromise: Promise<any> | null = null;
  private queue: Promise<void> = Promise.resolve();

  async autoSelectModel(): Promise<void> {
    if (this.hasUserOverride()) return;
    const { tier } = await detectDeviceCapability();
    this.modelId.set(QWEN_MODELS[tier].id);
  }

  setModel(id: string): void {
    if (!this.models.some(m => m.id === id)) return;
    this.modelId.set(id);
    try {
      localStorage.setItem(this.STORAGE_KEY, id);
    } catch {
      // ignore
    }
    this.generator = null;
    this.loadPromise = null;
    this.isReady.set(false);
  }

  resetLoadedModel(): void {
    this.generator = null;
    this.loadPromise = null;
    this.isReady.set(false);
  }

  /**
   * Enqueues a background agent task. Tasks run sequentially so a single device
   * is never overloaded by concurrent model inference. Returns the task id.
   */
  runTask(prompt: string): string {
    const task: AgentTask = {
      id: this.generateId(),
      prompt,
      status: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.update(list => [...list, task]);

    // Chain onto the queue so tasks execute one at a time.
    this.queue = this.queue.then(() => this.execute(task.id));
    return task.id;
  }

  private async execute(taskId: string): Promise<void> {
    this.patchTask(taskId, { status: 'running' });
    try {
      const task = this.tasks().find(t => t.id === taskId);
      if (!task) return;
      const result = await this.generate(task.prompt);
      this.patchTask(taskId, { status: 'done', result });
    } catch (err: any) {
      console.error('[Qwen agent] task failed', err);
      this.patchTask(taskId, {
        status: 'error',
        error: err?.message ?? 'Agent task failed.',
      });
    }
  }

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
    const preferredModel = this.selectedModel();
    const fallbackModel = QWEN_MODELS.medium;
    const uncensored = preferredModel.id === UNCENSORED_AGENT_MODEL.id;
    const candidates = uncensored
      ? [preferredModel, fallbackModel]
      : [preferredModel];

    this.isLoading.set(true);
    this.isReady.set(false);

    const { hasWebGPU } = await detectDeviceCapability();
    const attempts = this.buildLoadAttempts(hasWebGPU, uncensored);

    let lastError: unknown = null;
    try {
      for (const model of candidates) {
        for (const attempt of attempts) {
          try {
            this.loadInfo.set(`loading ${model.name} (${attempt.label})…`);
            this.generator = await pipeline('text-generation', model.id, {
              device: attempt.device,
              dtype: attempt.dtype as any,
            });
            this.loadInfo.set(`${model.name} · ${attempt.label}`);
            this.isReady.set(true);
            console.info(`[Qwen] Loaded ${model.id} with ${attempt.label}`);
            return this.generator;
          } catch (err) {
            lastError = err;
            console.warn(`[Qwen] ${model.id} ${attempt.label} failed`, err);
            this.generator = null;
          }
        }
      }
      this.loadInfo.set('Qwen could not be loaded.');
      throw lastError ?? new Error('Qwen load failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  private buildLoadAttempts(
    hasWebGPU: boolean,
    uncensored: boolean
  ): Array<{ device: 'webgpu' | 'wasm'; dtype: string; label: string }> {
    const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: string; label: string }> = [];
    if (hasWebGPU) {
      attempts.push({ device: 'webgpu', dtype: 'q4', label: 'webgpu/q4' });
      attempts.push({ device: 'webgpu', dtype: 'fp32', label: 'webgpu/fp32' });
    }

    if (uncensored) {
      attempts.push(
        { device: 'wasm', dtype: 'q8', label: 'wasm/q8' },
        { device: 'wasm', dtype: 'fp32', label: 'wasm/fp32' }
      );
    } else {
      attempts.push(
        { device: 'wasm', dtype: 'q4', label: 'wasm/q4' },
        { device: 'wasm', dtype: 'q8', label: 'wasm/q8' }
      );
    }
    return attempts;
  }

  /** Runs a single agent generation. Exposed for advanced/manual use. */
  async generate(prompt: string, history: ChatTurn[] = []): Promise<string> {
    const generator = await this.ensureLoaded();

    const messages: ChatTurn[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: prompt },
    ];

    const options = {
      max_new_tokens: 1024,
      do_sample: true,
      temperature: 0.6,
      top_p: 0.95,
    };

    let output: any;
    let promptPrefix = '';
    try {
      output = await generator(messages, options);
    } catch (e) {
      if (!this.isMissingChatTemplateError(e)) throw e;
      promptPrefix = this.buildPlainPrompt(prompt, history);
      output = await generator(promptPrefix, options);
    }

    return this.extractText(output, promptPrefix);
  }

  private buildPlainPrompt(prompt: string, history: ChatTurn[]): string {
    const turns = history
      .filter(turn => turn.role !== 'system')
      .map(turn =>
        `<|im_start|>${turn.role === 'assistant' ? 'assistant' : 'user'}\n${turn.content}<|im_end|>`
      )
      .join('\n');

    return [
      `<|im_start|>system\n${AGENT_SYSTEM_PROMPT}<|im_end|>`,
      turns,
      `<|im_start|>user\n${prompt}<|im_end|>`,
      '<|im_start|>assistant\n',
    ].filter(Boolean).join('\n');
  }

  private isMissingChatTemplateError(error: unknown): boolean {
    return /chat_template|apply_chat_template/i.test(String((error as any)?.message ?? error));
  }

  clearCompleted(): void {
    this.tasks.update(list =>
      list.filter(t => t.status === 'queued' || t.status === 'running')
    );
  }

  private patchTask(id: string, patch: Partial<AgentTask>): void {
    this.tasks.update(list =>
      list.map(t => (t.id === id ? { ...t, ...patch, updatedAt: new Date() } : t))
    );
  }

  private extractText(output: any, promptPrefix = ''): string {
    try {
      const generated = output?.[0]?.generated_text;
      if (Array.isArray(generated)) {
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
      .replace(/<\|im_end\|>/gi, '');
    return this.stripThinking(cleaned).trim();
  }

  /** Qwen3 can emit <think>…</think> reasoning blocks; remove them from results. */
  private stripThinking(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

  private loadStoredModel(): string {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored && this.modelExists(stored)) return stored;
    } catch {
      // ignore
    }
    return QWEN_MODELS.medium.id;
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

  private generateId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
