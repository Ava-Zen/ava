import { Injectable, signal, computed } from '@angular/core';
import { pipeline } from '@huggingface/transformers';
import { detectDeviceCapability, DeviceTier } from './device-capability';
import { ChatTurn, LlmModelOption } from './llm';

export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'error';

/** A tool the agent may call while working on a task. */
export interface AgentToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Executes a tool call and returns a textual result for the model. */
export type AgentToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

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

type InferenceDevice = 'webnn-npu' | 'webnn-gpu' | 'webgpu' | 'wasm';

interface LoadAttempt {
  device: InferenceDevice;
  dtype: string;
  label: string;
}

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
  readonly activeModel = signal<LlmModelOption | null>(null);

  /** Reactive list of agent tasks (most recent last). */
  readonly tasks = signal<AgentTask[]>([]);
  readonly activeTasks = computed(() =>
    this.tasks().filter(t => t.status === 'queued' || t.status === 'running')
  );
  readonly hasActiveTasks = computed(() => this.activeTasks().length > 0);

  private generator: any = null;
  private loadPromise: Promise<any> | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Optional tool context per task (not persisted). */
  private readonly toolContext = new Map<
    string,
    { tools: AgentToolDef[]; exec: AgentToolExecutor }
  >();
  private loadedDevice: InferenceDevice | null = null;

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
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
  }

  resetLoadedModel(): void {
    this.generator = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
  }

  async reloadOnCpu(): Promise<any> {
    this.generator = null;
    this.loadPromise = null;
    this.loadedDevice = null;
    this.isReady.set(false);
    this.activeModel.set(null);
    return await this.load(true);
  }

  /**
   * Enqueues a background agent task. Tasks run sequentially so a single device
   * is never overloaded by concurrent model inference. Returns the task id.
   *
   * Optionally provide `tools` plus an `exec` callback so the agent can call
   * MCP tools while working on the task.
   */
  runTask(prompt: string, tools?: AgentToolDef[], exec?: AgentToolExecutor): string {
    const task: AgentTask = {
      id: this.generateId(),
      prompt,
      status: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tasks.update(list => [...list, task]);
    if (tools && tools.length && exec) {
      this.toolContext.set(task.id, { tools, exec });
    }

    // Chain onto the queue so tasks execute one at a time.
    this.queue = this.queue.then(() => this.execute(task.id));
    return task.id;
  }

  private async execute(taskId: string): Promise<void> {
    this.patchTask(taskId, { status: 'running' });
    try {
      const task = this.tasks().find(t => t.id === taskId);
      if (!task) return;
      const ctx = this.toolContext.get(taskId);
      const result = ctx
        ? await this.generateWithTools(task.prompt, ctx.tools, ctx.exec)
        : await this.generate(task.prompt);
      this.patchTask(taskId, { status: 'done', result });
    } catch (err: any) {
      console.error('[Qwen agent] task failed', err);
      this.patchTask(taskId, {
        status: 'error',
        error: this.friendlyError(err) ?? err?.message ?? 'Agent task failed.',
      });
    } finally {
      this.toolContext.delete(taskId);
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

  private async load(wasmOnly = false): Promise<any> {
    await this.autoSelectModel();
    const preferredModel = this.selectedModel();

    this.isLoading.set(true);
    this.isReady.set(false);
    this.activeModel.set(null);

    const capability = await detectDeviceCapability();
    const acceleratorAttempts = wasmOnly ? [] : this.buildAcceleratorAttempts(capability);
    const hasAccelerator = acceleratorAttempts.length > 0;
    const candidates = this.buildCandidateModels(preferredModel, hasAccelerator);
    const attempts = hasAccelerator ? acceleratorAttempts : this.buildCpuLoadAttempts();

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
            this.activeModel.set(model);
            this.loadedDevice = attempt.device;
            console.info(`[Qwen] Loaded ${model.id} with ${attempt.label}`);
            return this.generator;
          } catch (err) {
            lastError = err;
            console.warn(`[Qwen] ${model.id} ${attempt.label} failed`, err);
            this.generator = null;
            this.loadedDevice = null;
          }
        }
      }
      this.loadInfo.set(hasAccelerator
        ? 'GPU/NPU agent failed. CPU fallback is available in Settings.'
        : 'Qwen could not be loaded.');
      throw lastError ?? new Error('Qwen load failed');
    } finally {
      this.isLoading.set(false);
    }
  }

  private buildCandidateModels(preferredModel: LlmModelOption, useAccelerator: boolean): LlmModelOption[] {
    const fallbackModel = QWEN_MODELS.low;
    if (!useAccelerator) {
      return preferredModel.id === UNCENSORED_AGENT_MODEL.id
        ? [preferredModel, fallbackModel]
        : [fallbackModel];
    }

    return preferredModel.id === fallbackModel.id
      ? [preferredModel]
      : [preferredModel, fallbackModel];
  }

  private buildAcceleratorAttempts(capability: Awaited<ReturnType<typeof detectDeviceCapability>>): LoadAttempt[] {
    const attempts: LoadAttempt[] = [];
    if (capability.hasWebNN) {
      attempts.push({ device: 'webnn-npu', dtype: 'q4', label: 'webnn-npu/q4' });
      attempts.push({ device: 'webnn-gpu', dtype: 'q4', label: 'webnn-gpu/q4' });
    }
    if (capability.supportsLlmWebGPU) {
      attempts.push({ device: 'webgpu', dtype: 'q4', label: 'webgpu/q4' });
      attempts.push({ device: 'webgpu', dtype: 'fp32', label: 'webgpu/fp32' });
    }
    return attempts;
  }

  private buildCpuLoadAttempts(): LoadAttempt[] {
    return [{ device: 'wasm', dtype: 'fp32', label: 'wasm/fp32' }];
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

  /**
   * Turns a raw agent failure into a short, friendly explanation. Returns null
   * when the error is not one we recognise.
   */
  friendlyError(error: unknown): string | null {
    const message = String((error as any)?.message ?? error);
    const onCpu = this.loadedDevice === 'wasm';

    if (/workgroup storage|compute pipeline|GroupQueryAttention/i.test(message)) {
      return onCpu
        ? 'This device ran low on memory for the agent model. Try a smaller model in Settings or close some apps.'
        : "Your graphics chip can't fit this agent model in accelerated mode. Switch to CPU in Settings, or pick a smaller model.";
    }
    if (/out of memory|oom|allocation failed|enough memory|insufficient/i.test(message)) {
      return 'The agent ran out of memory. Close some apps, free up space, or pick a smaller model in Settings.';
    }
    if (/WebGPU|WebNN|OrtRun|GPU|NPU|device lost/i.test(message)) {
      return 'The agent hit a hardware acceleration snag. Switch to CPU in Settings and try again.';
    }
    return null;
  }

  /**
   * Runs an agent task with a bounded tool-use loop. The model may request a
   * tool call by emitting a JSON object `{ "tool": name, "arguments": {...} }`;
   * Ava executes it and feeds the result back. After a few rounds (or when the
   * model stops requesting tools) the final plain-text answer is returned.
   */
  async generateWithTools(
    prompt: string,
    tools: AgentToolDef[],
    exec: AgentToolExecutor,
    maxRounds = 4,
    baseInstructions: string = AGENT_SYSTEM_PROMPT,
  ): Promise<string> {
    const generator = await this.ensureLoaded();

    const toolList = tools
      .map(t => `- ${t.name}: ${t.description ?? 'no description'}\n  input schema: ${JSON.stringify(t.inputSchema ?? {})}`)
      .join('\n');

    const systemPrompt =
      baseInstructions +
      '\n\nYou can use the following tools to gather information or take actions:\n' +
      toolList +
      '\n\nTo call a tool, reply with ONLY a single JSON object on its own line, ' +
      'no other text: {"tool": "<tool_name>", "arguments": { ... }}. ' +
      'You will then receive the tool result and may call another tool or finish. ' +
      'When you have enough information, reply with the final answer as plain ' +
      'text (no JSON, no tool call).';

    const messages: ChatTurn[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    let lastText = '';
    for (let round = 0; round < maxRounds; round++) {
      const output: any = await generator(messages, {
        max_new_tokens: 1024,
        do_sample: true,
        temperature: 0.6,
        top_p: 0.95,
      });
      const text = this.extractText(output);
      lastText = text;

      const call = this.parseToolCall(text);
      if (!call) return text;

      const known = tools.find(t => t.name === call.tool);
      messages.push({ role: 'assistant', content: text });
      if (!known) {
        messages.push({
          role: 'user',
          content: `Tool "${call.tool}" is not available. Available tools: ${tools.map(t => t.name).join(', ')}. Try another tool or give your final answer.`,
        });
        continue;
      }

      let resultText: string;
      try {
        resultText = await exec(call.tool, call.arguments);
      } catch (err: any) {
        resultText = `Error: ${err?.message ?? String(err)}`;
      }
      messages.push({
        role: 'user',
        content: `Result of ${call.tool}:\n${resultText}\n\nUse this to continue, or give your final answer.`,
      });
    }

    // Ran out of rounds — return the last text, stripped of any trailing tool JSON.
    const trailing = this.parseToolCall(lastText);
    return trailing ? 'I gathered some information but could not finish the task in time.' : lastText;
  }

  /** Extracts a `{ "tool": ..., "arguments": {...} }` directive from model text. */
  private parseToolCall(text: string): { tool: string; arguments: Record<string, unknown> } | null {
    const stripped = this.stripThinking(text);
    for (const candidate of this.balancedJsonObjects(stripped)) {
      if (!/"tool"\s*:/.test(candidate)) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed.tool === 'string') {
          return {
            tool: parsed.tool,
            arguments:
              parsed.arguments && typeof parsed.arguments === 'object'
                ? parsed.arguments
                : {},
          };
        }
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  /** Yields top-level brace-balanced `{...}` substrings (handles nesting + strings). */
  private *balancedJsonObjects(text: string): Generator<string> {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        if (depth > 0) {
          depth--;
          if (depth === 0 && start >= 0) {
            yield text.slice(start, i + 1);
            start = -1;
          }
        }
      }
    }
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
