import { Component, signal, computed, effect, ViewChild, ElementRef, inject, HostListener } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Settings } from './settings/settings';
import { pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { GardensService, Garden } from './services/gardens';
import { TtsService } from './services/tts';
import { LlmService, ChatTurn } from './services/llm';
import { AgentsService } from './services/agents';
import { markdownToHtml, markdownToPlainText, splitIntoSpeechChunks } from './services/text-format';

interface Message {
  role: 'user' | 'ava';
  text: string;
  timestamp: Date;
  downloadId?: string;
  exportTaskId?: string;
}

interface QuickPrompt {
  label: string;
  text: string;
}

interface AudioDownload {
  id: string;
  filename: string;
  url: string;
  blob: Blob;
  sizeBytes: number;
}

interface AudioExportTask {
  id: string;
  sourceName: string;
  status: 'running' | 'complete' | 'failed' | 'aborted';
  current: number;
  total: number;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Settings],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('Ava');
  protected readonly quickPrompts: QuickPrompt[] = [
    {
      label: 'Summarize this',
      text: 'Please summarize this and pull out the key points.'
    },
    {
      label: 'Action items',
      text: 'Please turn this into a short action list with priorities.'
    },
    {
      label: 'Draft reply',
      text: 'Please help me draft a clear and thoughtful reply.'
    },
    {
      label: 'Explain simply',
      text: 'Please explain this in plain language and keep it concise.'
    },
  ];
  private readonly MAX_FILE_CHARS = 12000;
  private readonly TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'html', 'css', 'scss', 'xml', 'yml', 'yaml', 'log'
  ]);

  private readonly gardensService = inject(GardensService);
  private readonly tts = inject(TtsService);
  private readonly llm = inject(LlmService);
  private readonly agents = inject(AgentsService);
  private readonly sanitizer = inject(DomSanitizer);

  @ViewChild('transcript') private transcriptEl?: ElementRef<HTMLDivElement>;
  @ViewChild('filePicker') private filePickerEl?: ElementRef<HTMLInputElement>;
  @ViewChild('audioFilePicker') private audioFilePickerEl?: ElementRef<HTMLInputElement>;
  @ViewChild('primaryActionShell') private primaryActionShellEl?: ElementRef<HTMLDivElement>;

  // Gardens
  protected readonly gardens = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;
  protected showSettings = signal(false);

  /** Reactive: the conversation card is shown while there is content or active voice. */
  protected readonly chatStarted = computed(() =>
    this.messages().length > 0 || this.isListening() || this.isModelLoading()
  );

  /** Name of the currently selected text-to-speech voice. */
  protected readonly voiceName = computed(() => this.tts.selectedVoice().name);
  protected readonly manualInputEnabled = signal(false);
  protected readonly composerMenuOpen = signal(false);
  protected readonly manualPrompt = signal('');
  protected readonly composerNotice = signal('');
  protected readonly isGeneratingAudioFile = signal(false);
  protected readonly audioDownloads = signal<Record<string, AudioDownload>>({});
  protected readonly audioExportTasks = signal<Record<string, AudioExportTask>>({});
  protected readonly activeAudioPreviewId = signal<string | null>(null);
  protected readonly audioPreviewPaused = signal(false);
  protected readonly canSubmitManualPrompt = computed(() =>
    this.manualPrompt().trim().length > 0 && !this.isThinking()
  );
  protected readonly activityBadgeLabel = computed(() => {
    if (this.isModelLoading()) return 'Loading speech';
    if (this.isKokoroLoading()) return 'Loading voice';
    if (this.llm.isLoading()) return this.cleanLoadLabel(this.llm.loadInfo()) || 'Loading chat model';
    if (this.agents.isLoading()) return this.cleanLoadLabel(this.agents.loadInfo()) || 'Loading agent';
    if (this.isGeneratingAudioFile()) return 'Generating audio';
    if (this.isThinking()) return 'Thinking';
    if (this.hasActiveAgents()) return 'Agent working';
    if (this.status() === 'speaking') return 'Speaking';
    if (this.status() === 'listening') return 'Listening';
    return 'Local first';
  });
  protected readonly activityBadgeBusy = computed(() => this.activityBadgeLabel() !== 'Local first');
  private activeAudioExportController: AbortController | null = null;
  private audioPreviewPlayer: HTMLAudioElement | null = null;

  // Per-garden message storage (keyed by garden id)
  private messagesByGarden = signal<Record<string, Message[]>>({});

  protected readonly messages = computed(() => {
    const gardenId = this.currentGarden()?.id || 'default';
    const all = this.messagesByGarden();
    return all[gardenId] ?? [];
  });

  // Background agent tasks (Qwen) surfaced for the UI.
  protected readonly agentTasks = this.agents.tasks;
  protected readonly hasActiveAgents = this.agents.hasActiveTasks;
  protected readonly llmThinkingTrace = this.llm.thinkingTrace;

  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.preloadModel().catch(() => {});
    this.preloadKokoro().catch(() => {});
    this.preloadLlm().catch(() => {});
    this.loadMessagesFromStorage();

    // Auto-scroll chat when new messages arrive
    effect(() => {
      this.messages(); // track changes
      this.scrollToBottom();
    });
  }

  protected selectGarden(id: string) {
    this.gardensService.selectGarden(id);
    this.currentTranscript.set('');
  }

  protected openSettings() {
    this.showSettings.set(true);
  }

  private cleanLoadLabel(label: string): string {
    return label
      .replace(/^loading\s+/i, 'Loading ')
      .replace(/[.…]+$/g, '')
      .trim();
  }

  /** Global spacebar toggles listening, unless the user is typing or a dialog is open. */
  @HostListener('document:keydown', ['$event'])
  protected onGlobalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && this.composerMenuOpen()) {
      this.composerMenuOpen.set(false);
      return;
    }

    if (event.code !== 'Space' || event.repeat) return;
    if (this.showSettings()) return;

    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    event.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.toggleVoice();
  }

  @HostListener('document:mousedown', ['$event'])
  protected onDocumentMouseDown(event: MouseEvent) {
    this.closeComposerMenuIfOutside(event.target);
  }

  @HostListener('document:touchstart', ['$event'])
  protected onDocumentTouchStart(event: TouchEvent) {
    this.closeComposerMenuIfOutside(event.target);
  }

  protected closeSettings() {
    this.showSettings.set(false);
  }

  protected toggleComposerMenu() {
    this.composerMenuOpen.update(open => !open);
  }

  protected openComposerMenu(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.composerMenuOpen.set(true);
  }

  protected onPrimaryActionClick() {
    this.composerMenuOpen.set(false);

    if (this.manualInputEnabled()) {
      void this.submitManualPrompt();
      return;
    }

    void this.toggleVoice();
  }

  protected setManualInputMode(enabled: boolean) {
    if (enabled && this.isListening()) {
      this.stopMoonshineListening();
    }

    this.manualInputEnabled.set(enabled);
    this.composerMenuOpen.set(false);
    if (!enabled) {
      this.composerNotice.set('');
    }
  }

  protected onAddButtonClick(event: Event) {
    event.stopPropagation();
    this.toggleComposerMenu();
  }

  protected onManualPromptInput(event: Event) {
    const target = event.target as HTMLTextAreaElement | null;
    this.manualPrompt.set(target?.value ?? '');
  }

  protected onManualPromptKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    this.submitManualPrompt();
  }

  protected async submitManualPrompt() {
    const text = this.manualPrompt().trim();
    if (!text || this.isThinking()) return;

    this.manualPrompt.set('');
    this.composerNotice.set('');
    await this.handleUserSpeech(text);
  }

  protected queueQuickPrompt(prompt: string) {
    this.setManualInputMode(true);
    this.appendToManualPrompt(prompt);
    this.composerNotice.set('Quick prompt added. You can edit it before sending.');
  }

  protected openFilePicker() {
    this.setManualInputMode(true);
    this.filePickerEl?.nativeElement.click();
  }

  protected openAudioFilePicker() {
    this.composerMenuOpen.set(false);
    this.audioFilePickerEl?.nativeElement.click();
  }

  protected async onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    if (files.length === 0) return;

    const segments: string[] = [];

    for (const file of files) {
      if (!this.isTextFile(file)) {
        segments.push(`[${file.name}] could not be added because it does not look like a text file.`);
        continue;
      }

      try {
        const raw = await file.text();
        const trimmed = raw.trim();
        if (!trimmed) {
          segments.push(`File: ${file.name}\n\n[empty file]`);
          continue;
        }

        const clipped = trimmed.length > this.MAX_FILE_CHARS
          ? `${trimmed.slice(0, this.MAX_FILE_CHARS)}\n\n[truncated to ${this.MAX_FILE_CHARS.toLocaleString()} characters]`
          : trimmed;

        segments.push(`Use this file as context:\nFile: ${file.name}\n\n${clipped}`);
      } catch {
        segments.push(`File: ${file.name}\n\n[could not read this file]`);
      }
    }

    for (const segment of segments) {
      this.appendToManualPrompt(segment);
    }

    this.composerNotice.set(
      files.length === 1
        ? `Added ${files[0].name} to the manual prompt.`
        : `Added ${files.length} files to the manual prompt.`
    );

    if (input) {
      input.value = '';
    }
  }

  protected async onAudioFileSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    if (!this.isTextFile(file)) {
      this.composerNotice.set(`${file.name} does not look like a text file.`);
      if (input) input.value = '';
      return;
    }

    try {
      const text = (await file.text()).trim();
      if (!text) {
        this.composerNotice.set(`${file.name} is empty.`);
        return;
      }

      await this.generateDownloadableAudio(text, file.name);
    } catch (e) {
      console.error('Audio file generation failed', e);
      this.composerNotice.set('Could not generate that audio file.');
    } finally {
      if (input) input.value = '';
    }
  }

  // Garden management handlers (called from Settings component)
  protected onCreateGarden(data: { name: string; description?: string }) {
    const garden = this.gardensService.createGarden(data.name, data.description);
    // Initialize empty messages for new garden
    this.setGardenMessages(garden.id, []);
  }

  protected onUpdateGarden(data: { id: string; name: string; description?: string }) {
    this.gardensService.updateGarden(data.id, { name: data.name, description: data.description });
  }

  protected onDeleteGarden(id: string) {
    this.gardensService.deleteGarden(id);
    // Clean up messages for deleted garden
    this.messagesByGarden.update(all => {
      const copy = { ...all };
      delete copy[id];
      return copy;
    });
    this.saveMessagesToStorage();
  }

  private setGardenMessages(gardenId: string, msgs: Message[]) {
    this.messagesByGarden.update(all => ({
      ...all,
      [gardenId]: msgs
    }));
    this.saveMessagesToStorage();
  }

  private loadMessagesFromStorage() {
    try {
      const saved = localStorage.getItem('ava-messages-by-garden');
      if (saved) {
        const parsed = JSON.parse(saved) as Record<string, Message[]>;
        const hydrated = Object.fromEntries(
          Object.entries(parsed).map(([gardenId, messages]) => [
            gardenId,
            messages.map(msg => ({
              ...msg,
              timestamp: new Date(msg.timestamp as unknown as string)
            }))
          ])
        );
        this.messagesByGarden.set(hydrated);
      }
    } catch {}
  }

  private saveMessagesToStorage() {
    try {
      localStorage.setItem('ava-messages-by-garden', JSON.stringify(this.messagesByGarden()));
    } catch {}
  }

  // Voice / conversation state
  protected readonly isListening = signal(false);
  protected readonly isThinking = signal(false);
  protected readonly isPaused = signal(false);
  protected readonly status = signal<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  protected readonly currentTranscript = signal('');

  protected readonly statusLabel = computed(() => {
    if (this.isLoadingModel()) return 'Loading Moonshine…';
    const backend = this.modelLoadInfo();
    switch (this.status()) {
      case 'listening': return backend ? `Listening (${backend})` : 'Listening with Moonshine';
      case 'thinking': return 'Thinking…';
      case 'speaking': return 'Speaking…';
      default: return 'Ready';
    }
  });

  private synth: SpeechSynthesis | null = null;

  // Moonshine Base STT (for continuous transcription)
  private transcriber: any = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private isModelLoading = signal(false);
  private moonshineBuffer: Float32Array = new Float32Array(0);
  private isSpeechActive = false;
  private silenceSamples = 0;
  private lastLiveUpdate = 0;
  private readonly SAMPLE_RATE = 16000;

  // Kokoro 82M TTS
  private kokoro: any = null;
  private exportKokoro: any = null;
  private isKokoroLoading = signal(false);
  private kokoroLoadInfo = signal('');
  private exportKokoroLoadInfo = signal('');
  private readonly CHUNK_SIZE = 4096;
  private readonly SPEECH_THRESHOLD = 0.015; // simple energy VAD
  private readonly MIN_SPEECH_SAMPLES = 16000 * 0.6; // ~0.6s min
  private readonly SILENCE_FOR_COMMIT = 16000 * 0.7; // ~0.7s silence to commit

  private async preloadModel() {
    if (this.transcriber || typeof window === 'undefined') return;
    try {
      const hasWebGPU = await this.supportsWebGPU();
      const attempts: any[] = hasWebGPU
        ? [
            {
              device: 'webgpu',
              dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
              label: 'webgpu/fp32',
            },
          ]
        : [];
      attempts.push(
        {
          device: 'wasm',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
          label: 'wasm/fp32',
        }
      );

      for (const a of attempts) {
        try {
          this.transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/moonshine-base-ONNX', a);
          await this.transcriber(new Float32Array(4000));
          this.modelLoadInfo.set(a.label);
          return;
        } catch {
          this.transcriber = null;
        }
      }
    } catch {
      this.transcriber = null;
    }
  }

  private async preloadKokoro(forceWasm = false) {
    if ((this.kokoro && !forceWasm) || typeof window === 'undefined') return;
    try {
      this.isKokoroLoading.set(true);
      this.kokoroLoadInfo.set('loading...');

      // Use quantized for speed/size, fp32 for quality on WebGPU
      const hasWebGPU = !forceWasm && await this.supportsWebGPU();
      const dtype = hasWebGPU ? 'fp32' : 'q8';
      const device = hasWebGPU ? 'webgpu' : 'wasm';

      if (forceWasm) {
        this.kokoro = null;
      }
      this.kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
        dtype,
        device,
      });

      this.kokoroLoadInfo.set(`${device}/${dtype}`);
      console.info(`[Kokoro] Loaded ${this.kokoroLoadInfo()}`);
    } catch (e) {
      console.warn('Failed to load Kokoro TTS, will fallback to browser speechSynthesis', e);
      this.kokoro = null;
      this.kokoroLoadInfo.set('fallback');
    } finally {
      this.isKokoroLoading.set(false);
    }
  }

  private async ensureExportKokoro(): Promise<any> {
    if (this.exportKokoro || typeof window === 'undefined') return this.exportKokoro;

    this.isKokoroLoading.set(true);
    this.exportKokoroLoadInfo.set('loading wasm/q8');
    try {
      this.exportKokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
        dtype: 'q8',
        device: 'wasm',
      });
      this.exportKokoroLoadInfo.set('wasm/q8');
      console.info('[Kokoro export] Loaded wasm/q8');
      return this.exportKokoro;
    } catch (e) {
      this.exportKokoro = null;
      this.exportKokoroLoadInfo.set('failed');
      throw e;
    } finally {
      this.isKokoroLoading.set(false);
    }
  }

  /**
   * Warms up the Gemma instant-reply model in the background so the first
   * spoken answer is fast. The Qwen agent model is loaded lazily on demand.
   */
  private async preloadLlm() {
    if (typeof window === 'undefined') return;
    try {
      await this.llm.autoSelectModel();
      await this.llm.ensureLoaded();
    } catch (e) {
      console.warn('Gemma preload failed; will retry on first use', e);
    }
  }

  protected readonly isLoadingModel = computed(() => this.isModelLoading());
  protected modelLoadInfo = signal<string>('');  // e.g. "webgpu/q4" or "wasm/q8"

  protected async toggleVoice() {
    if (this.isListening()) {
      this.stopMoonshineListening();
      return;
    }

    await this.startMoonshineListening();
  }

  private async supportsWebGPU(): Promise<boolean> {
    try {
      // @ts-ignore
      return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch {
      return false;
    }
  }

  /**
   * Loads Moonshine Base with device/dtype fallbacks.
   * The quantized merged decoder variants can fail in ORT Web with missing DQ
   * scale metadata, so speech recognition uses fp32 and only changes backend.
   */
  private async ensureTranscriberLoaded(): Promise<any> {
    if (this.transcriber) return this.transcriber;

    this.isModelLoading.set(true);
    this.status.set('listening');
    this.currentTranscript.set('');

    const hasWebGPU = await this.supportsWebGPU();
    const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: any; label: string }> = [];

    if (hasWebGPU) {
      attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, label: 'webgpu/fp32' });
    }
    attempts.push(
      { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, label: 'wasm/fp32' }
    );

    let lastError: any = null;

    try {
      for (const attempt of attempts) {
        try {
          this.modelLoadInfo.set(attempt.label);

          this.transcriber = await pipeline(
            'automatic-speech-recognition',
            'onnx-community/moonshine-base-ONNX',
            { device: attempt.device, dtype: attempt.dtype }
          );

          await this.transcriber(new Float32Array(this.SAMPLE_RATE * 0.25));
          this.currentTranscript.set('');
          console.info(`[Moonshine] Loaded with ${attempt.label}`);
          return this.transcriber;
        } catch (err) {
          lastError = err;
          console.warn(`[Moonshine] ${attempt.label} failed`, err);
          this.transcriber = null;
        }
      }
      console.error('Moonshine Base failed to load on all backends', lastError);
      this.currentTranscript.set('');
      throw lastError ?? new Error('Moonshine load failed');
    } finally {
      this.isModelLoading.set(false);
    }
  }

  private async reloadTranscriberOnWasm(): Promise<any> {
    this.transcriber = null;
    this.isModelLoading.set(true);
    this.modelLoadInfo.set('wasm/fp32');
    this.currentTranscript.set('');

    const attempts: Array<{ dtype: any; label: string }> = [
      { dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, label: 'wasm/fp32' },
    ];

    let lastError: unknown = null;
    try {
      for (const attempt of attempts) {
        try {
          this.modelLoadInfo.set(attempt.label);
          this.transcriber = await pipeline(
            'automatic-speech-recognition',
            'onnx-community/moonshine-base-ONNX',
            { device: 'wasm', dtype: attempt.dtype }
          );
          await this.transcriber(new Float32Array(this.SAMPLE_RATE * 0.25));
          this.currentTranscript.set('');
          console.info(`[Moonshine] Recovered with ${attempt.label}`);
          return this.transcriber;
        } catch (e) {
          lastError = e;
          this.transcriber = null;
        }
      }
      throw lastError ?? new Error('Moonshine WASM reload failed');
    } finally {
      this.isModelLoading.set(false);
    }
  }

  private async transcribeWithRecovery(audio: Float32Array, transcriber = this.transcriber): Promise<any> {
    try {
      return await transcriber(audio);
    } catch (e) {
      if (!this.isRecoverableMoonshineGpuError(e) || !this.modelLoadInfo().startsWith('webgpu')) {
        throw e;
      }

      console.warn('Moonshine WebGPU failed during transcription; retrying on WASM', e);
      const wasmTranscriber = await this.reloadTranscriberOnWasm();
      return await wasmTranscriber(audio);
    }
  }

  private isRecoverableMoonshineGpuError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /WebGPU|GroupQueryAttention|workgroup storage|compute pipeline|OrtRun|GPU/i.test(message);
  }

  private async startMoonshineListening() {
    try {
      this.currentTranscript.set('');
      this.moonshineBuffer = new Float32Array(0);
      this.isSpeechActive = false;
      this.silenceSamples = 0;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: this.SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.mediaStream = stream;

      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.SAMPLE_RATE,
        latencyHint: 'interactive',
      });

      // Some browsers ignore sampleRate in getUserMedia; we resample in processor if needed.
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);

      // ScriptProcessor for broad compatibility (simple continuous chunking)
      this.processor = this.audioContext.createScriptProcessor(this.CHUNK_SIZE, 1, 1);

      this.sourceNode.connect(this.processor);

      // Connect processor to a silent gain node (ScriptProcessor requires connection to keep firing)
      const gain = this.audioContext.createGain();
      gain.gain.value = 0;
      this.processor.connect(gain);
      gain.connect(this.audioContext.destination);

      await this.ensureTranscriberLoaded();

      this.isListening.set(true);
      this.status.set('listening');

      this.processor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0);

        // Convert to mono float32 (already should be)
        const samples = new Float32Array(inputBuffer);

        // Simple energy-based VAD
        const energy = this.calculateEnergy(samples);

        const isSpeech = energy > this.SPEECH_THRESHOLD;

        if (isSpeech) {
          if (!this.isSpeechActive) {
            this.isSpeechActive = true;
            this.silenceSamples = 0;
          }
          // Append to current utterance buffer
          this.appendToBuffer(samples);
          this.silenceSamples = 0;
        } else if (this.isSpeechActive) {
          this.silenceSamples += samples.length;
          // Still append a little silence padding
          this.appendToBuffer(samples);

          // If enough silence after speech, commit current utterance
          if (this.silenceSamples >= this.SILENCE_FOR_COMMIT && this.moonshineBuffer.length >= this.MIN_SPEECH_SAMPLES) {
            this.commitCurrentUtterance();
          }
        } else {
          // Not in speech, keep small rolling context (last 1s) for better start of next utterance
          this.appendToRollingContext(samples);
        }

        // Live / continuous transcription updates (throttled)
        const now = Date.now();
        if (this.isSpeechActive &&
            this.moonshineBuffer.length > 0 &&
            (now - this.lastLiveUpdate > 900) && // update ~every 900ms for smooth live text
            this.moonshineBuffer.length >= this.MIN_SPEECH_SAMPLES) {
          this.lastLiveUpdate = now;
          this.updateLiveTranscript();
        }
      };

    } catch (err: any) {
      console.error('Moonshine STT start error', err);
      this.stopMoonshineListening({ commitPending: false, submitPartial: false });

      if (!this.transcriber) {
        this.currentTranscript.set('Moonshine unavailable');
        setTimeout(() => this.currentTranscript.set(''), 1200);
      }
    }
  }

  private calculateEnergy(buffer: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  private appendToBuffer(newSamples: Float32Array) {
    const combined = new Float32Array(this.moonshineBuffer.length + newSamples.length);
    combined.set(this.moonshineBuffer);
    combined.set(newSamples, this.moonshineBuffer.length);
    this.moonshineBuffer = combined;

    // Safety cap (Moonshine handles up to ~30s well)
    const maxSamples = this.SAMPLE_RATE * 28;
    if (this.moonshineBuffer.length > maxSamples) {
      this.moonshineBuffer = this.moonshineBuffer.slice(this.moonshineBuffer.length - maxSamples);
    }
  }

  private appendToRollingContext(newSamples: Float32Array) {
    const contextSize = this.SAMPLE_RATE * 1.2; // keep ~1.2s context
    const combined = new Float32Array(Math.min(contextSize, this.moonshineBuffer.length + newSamples.length));
    const start = Math.max(0, this.moonshineBuffer.length + newSamples.length - contextSize);
    if (this.moonshineBuffer.length > 0) {
      const prevStart = Math.max(0, this.moonshineBuffer.length - (contextSize - newSamples.length));
      combined.set(this.moonshineBuffer.slice(prevStart));
    }
    combined.set(newSamples, combined.length - newSamples.length);
    this.moonshineBuffer = combined;
  }

  private async updateLiveTranscript() {
    try {
      if (this.moonshineBuffer.length < this.MIN_SPEECH_SAMPLES) return;

      const result: any = await this.transcribeWithRecovery(this.moonshineBuffer);
      const text = (result?.text || '').trim();
      if (text) {
        this.currentTranscript.set(text);
      }
    } catch (e) {
      // non-fatal for live updates
    }
  }

  private async commitCurrentUtterance() {
    const bufferToTranscribe = this.moonshineBuffer;
    this.moonshineBuffer = new Float32Array(0);
    this.isSpeechActive = false;
    this.silenceSamples = 0;

    const live = this.currentTranscript();
    if (!live && bufferToTranscribe.length < this.MIN_SPEECH_SAMPLES) {
      return;
    }

    try {
      const result: any = await this.transcribeWithRecovery(bufferToTranscribe);
      let finalText = (result?.text || live || '').trim();

      if (finalText) {
        this.currentTranscript.set('');
        this.lastLiveUpdate = 0;
        this.stopMoonshineListening({ commitPending: false, submitPartial: false });
        this.handleUserSpeech(finalText);
      }
    } catch (e) {
      console.error('Moonshine transcription error on commit', e);
      if (live) {
        this.currentTranscript.set('');
        this.stopMoonshineListening({ commitPending: false, submitPartial: false });
        this.handleUserSpeech(live);
      }
    }
  }

  private stopMoonshineListening(
    options: { commitPending?: boolean; submitPartial?: boolean } = {}
  ) {
    const commitPending = options.commitPending ?? true;
    const submitPartial = options.submitPartial ?? true;
    const wasListening = this.isListening();
    this.isListening.set(false);

    // Attempt to commit any remaining speech
    const willCommit = commitPending && wasListening && !!this.transcriber && this.moonshineBuffer.length >= this.MIN_SPEECH_SAMPLES;
    if (willCommit) {
      // fire and forget
      this.commitCurrentUtterance().catch(() => {});
    }

    // Cleanup audio graph
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
      }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
      }
    } catch (e) {
      // ignore cleanup errors
    }

    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.sourceNode = null;
    this.moonshineBuffer = new Float32Array(0);
    this.isSpeechActive = false;
    this.silenceSamples = 0;

    if (this.status() === 'listening') {
      this.status.set('idle');
    }

    // If there is a live partial when stopping, commit it
    const partial = this.currentTranscript();
    if (submitPartial && partial) {
      const text = partial;
      this.currentTranscript.set('');
      this.handleUserSpeech(text);
    }
  }

  private async handleUserSpeech(text: string) {
    this.currentTranscript.set('');

    if (this.isListeningStopCommand(text)) {
      this.stopMoonshineListening({ commitPending: false, submitPartial: false });
      return;
    }

    this.status.set('thinking');
    this.isThinking.set(true);

    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const currentMsgs = [...(this.messagesByGarden()[gardenId] || [])];

    // Add user message
    const userMsg: Message = { role: 'user', text, timestamp: new Date() };
    currentMsgs.push(userMsg);
    this.setGardenMessages(gardenId, currentMsgs);

    // 1) Explicit agent / background-task request → hand off to Qwen.
    if (this.detectAgentRequest(text)) {
      await this.handleAgentRequest(gardenId, text);
      return;
    }

    // 2) Fast hard-coded reply for common phrases.
    const fixed = this.generateAvaResponse(text);
    if (fixed) {
      await this.delay(350 + Math.random() * 350);
      this.respond(gardenId, fixed);
      return;
    }

    // 3) Anything else → Gemma. Acknowledge immediately, then think.
    await this.handleLlmReply(gardenId, text);
  }

  /** Detects when the user is explicitly asking for a background agent/task. */
  private detectAgentRequest(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(agent|background task|in the background|run a task|keep working on|work on (this|that|it)|go (and )?(research|find|look into|investigate)|research .+ for me|monitor|keep an eye on|while i('m| am)? (away|gone|busy))\b/.test(
      lower
    );
  }

  private isListeningStopCommand(text: string): boolean {
    if (!this.isListening()) return false;

    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return /\b(stop|end|turn off|shut off|disable|mute)\b(?:\s+(the|my|your))?\s+(listening|mic|microphone|voice|recording|voice channel)\b/.test(normalized)
      || /\b(stop|end)\s+(listening|recording)\b/.test(normalized)
      || /\b(mic|microphone)\s+(off|stop)\b/.test(normalized);
  }

  /** Speaks a final reply, stores it, and returns to idle when speech finishes. */
  private async respond(gardenId: string, response: string) {
    const currentMsgs = [...(this.messagesByGarden()[gardenId] || [])];
    const avaMsg: Message = { role: 'ava', text: response, timestamp: new Date() };
    currentMsgs.push(avaMsg);
    this.setGardenMessages(gardenId, currentMsgs);

    this.isThinking.set(false);
    this.status.set('speaking');
    this.scrollToBottom();

    await this.speak(response);

    if (this.status() === 'speaking') this.status.set('idle');
  }

  /** Routes an open-ended question to Gemma, speaking a filler line first. */
  private async handleLlmReply(gardenId: string, text: string) {
    // Speak the filler immediately so the user knows Ava is working.
    this.status.set('speaking');
    this.speak(this.pickThinkingFiller());

    try {
      const history = this.buildChatHistory(gardenId);
      const reply = (await this.llm.generate(text, history)).trim();
      this.respond(gardenId, reply || 'I am not sure how to answer that just yet.');
    } catch (e) {
      console.error('Gemma reply failed', e);
      this.respond(gardenId, 'Sorry, I could not think that through just now.');
    }
  }

  /** Hands the request to a Qwen background agent and confirms by voice. */
  private async handleAgentRequest(gardenId: string, text: string) {
    this.agents.runTask(text);

    // Kick off model loading in the background if it is not ready yet.
    this.agents.ensureLoaded().catch(() => {});

    const ack =
      'Okay, I will work on that in the background and let you know when it is ready.';
    this.respond(gardenId, ack);
  }

  /** A few natural "give me a second" lines spoken before Gemma answers. */
  private pickThinkingFiller(): string {
    const fillers = [
      'Let me think about that, one second…',
      'Give me a moment to think about that…',
      'Hmm, let me think for a second…',
      'One moment while I think that through…',
    ];
    return fillers[Math.floor(Math.random() * fillers.length)];
  }

  /** Builds recent conversation history (excluding the latest user turn) for the LLM. */
  private buildChatHistory(gardenId: string, maxTurns = 6): ChatTurn[] {
    const msgs = this.messagesByGarden()[gardenId] || [];
    // Drop the just-added user message; it is passed separately.
    const prior = msgs.slice(0, -1).slice(-maxTurns);
    return prior.map<ChatTurn>(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
  }

  private currentAudio: HTMLAudioElement | null = null;
  /** Resolver for the in-flight chunk, invoked when playback is interrupted. */
  private currentChunkSettle: ((result: boolean) => void) | null = null;
  /** Increments on every new speak() call so stale chunk playback can self-cancel. */
  private speechGen = 0;

  private async speak(text: string): Promise<void> {
    const id = ++this.speechGen;

    // Interrupt anything already speaking.
    this.isPaused.set(false);
    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();

    if (this.tts.selectedVoiceId() === 'kokoro') {
      const handled = await this.speakWithKokoro(text, id);
      if (handled || this.speechGen !== id) return;
    }

    if (this.speechGen !== id) return;
    await this.speakWithSystem(text, id);
  }

  /**
   * Speaks long replies as a sequence of small chunks. The next chunk is
   * synthesised while the current one plays, so there is no audible gap between
   * sentences. Returns true when it handled playback (including when it was
   * interrupted by a newer utterance), false only on a genuine failure that
   * should fall back to the system voice.
   */
  private async speakWithKokoro(text: string, id: number): Promise<boolean> {
    if (!this.kokoro) {
      await this.preloadKokoro().catch(() => {});
    }
    if (!this.kokoro) return false;

    const spoken = markdownToPlainText(text);
    const chunks = splitIntoSpeechChunks(spoken);
    if (chunks.length === 0) return true;

    try {
      const voice = this.tts.selectedKokoroVoiceId();
      const synth = (chunk: string) => this.kokoro.generate(chunk, { voice, speed: 0.98 });

      // Pre-generate the first chunk, then keep one chunk ahead of playback.
      let pending: Promise<any> | null = synth(chunks[0]);

      for (let i = 0; i < chunks.length; i++) {
        if (this.speechGen !== id) return true; // superseded

        let audio: any;
        try {
          audio = await pending;
        } catch (e) {
          if (i === 0) return false; // first chunk failed → fall back
          console.warn('Kokoro chunk synthesis failed, stopping playback', e);
          break;
        }

        // Kick off synthesis of the next chunk before playing this one.
        pending = i + 1 < chunks.length ? synth(chunks[i + 1]) : null;

        if (this.speechGen !== id) return true; // superseded while synthesising

        const ok = await this.playChunk(audio.toBlob(), id);
        if (!ok) {
          if (this.speechGen !== id) return true; // interrupted
          if (i === 0) return false;              // playback error on first chunk
          break;
        }
      }
      return true;
    } catch (e) {
      console.warn('Kokoro TTS failed, falling back', e);
      return false;
    }
  }

  private async generateDownloadableAudio(text: string, sourceName: string) {
    if (this.isGeneratingAudioFile()) return;

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    this.activeAudioExportController = controller;
    this.isGeneratingAudioFile.set(true);
    this.composerNotice.set('');
    this.audioExportTasks.update(tasks => ({
      ...tasks,
      [taskId]: { id: taskId, sourceName, status: 'running', current: 0, total: 0 }
    }));
    this.addAvaExportMessage(`Making audio from ${sourceName}...`, taskId);

    try {
      this.updateAvaExportMessage(taskId, `Preparing ${sourceName} for audio export...`);

      if (!this.kokoro) {
        await this.preloadKokoro().catch(() => {});
      }
      if (!this.kokoro) {
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `I could not load Ava's voice model for ${sourceName}.`);
        return;
      }
      this.throwIfAudioExportAborted(controller.signal);

      const spoken = markdownToPlainText(text);
      const chunks = splitIntoSpeechChunks(spoken);
      if (chunks.length === 0) {
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `${sourceName} did not contain speakable text.`);
        return;
      }

      this.audioExportTasks.update(tasks => ({
        ...tasks,
        [taskId]: { ...tasks[taskId], total: chunks.length }
      }));

      const voice = this.tts.selectedKokoroVoiceId();
      const audioChunks: Float32Array[] = [];
      let sampleRate = 24000;

      for (let i = 0; i < chunks.length; i++) {
        this.throwIfAudioExportAborted(controller.signal);
        this.audioExportTasks.update(tasks => ({
          ...tasks,
          [taskId]: { ...tasks[taskId], current: i + 1 }
        }));
        this.updateAvaExportMessage(
          taskId,
          `Generating audio from ${sourceName} (${i + 1}/${chunks.length})...`
        );

        const audio = await this.generateKokoroAudioChunk(chunks[i], voice, this.kokoro, taskId);
        this.throwIfAudioExportAborted(controller.signal);
        audioChunks.push(this.extractKokoroSamples(audio));
        sampleRate = audio.sampling_rate ?? audio.sample_rate ?? sampleRate;
      }

      const filename = `${this.stripFileExtension(sourceName)}-ava.wav`;
      const wav = this.createWavBlob(this.concatAudioChunks(audioChunks), sampleRate);
      const download = this.createAudioDownload(wav, filename);

      this.markAudioExportTask(taskId, 'complete');
      this.updateAvaExportMessage(
        taskId,
        `I transcribed ${sourceName} into Ava audio. Use the button below to download ${filename}.`,
        download.id
      );
    } catch (e) {
      if (this.isAbortError(e)) {
        this.markAudioExportTask(taskId, 'aborted');
        this.updateAvaExportMessage(taskId, `Stopped audio export for ${sourceName}.`);
      } else {
        console.error('Audio file generation failed', e);
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `I could not finish the audio export for ${sourceName}.`);
      }
    } finally {
      if (this.activeAudioExportController === controller) {
        this.activeAudioExportController = null;
      }
      this.isGeneratingAudioFile.set(false);
    }
  }

  private async generateKokoroAudioChunk(
    text: string,
    voice: string,
    engine = this.kokoro,
    taskId?: string
  ): Promise<any> {
    try {
      return await engine.generate(text, { voice, speed: 0.98 });
    } catch (e) {
      if (engine !== this.kokoro || !this.isRecoverableGpuError(e) || !this.kokoroLoadInfo().startsWith('webgpu')) {
        throw e;
      }

      console.warn('Kokoro WebGPU synthesis failed; retrying audio export on WASM', e);
      if (taskId) {
        this.updateAvaExportMessage(taskId, 'GPU voice synthesis stumbled. Retrying safely...');
      }
      const exporter = await this.ensureExportKokoro();
      if (!exporter) throw e;
      return await exporter.generate(text, { voice, speed: 0.98 });
    }
  }

  protected stopAudioExport(taskId: string) {
    const task = this.audioExportTasks()[taskId];
    if (!task || task.status !== 'running') return;

    this.markAudioExportTask(taskId, 'aborted');
    this.updateAvaExportMessage(taskId, `Stopping audio export for ${task.sourceName}...`);
    this.activeAudioExportController?.abort();
  }

  private throwIfAudioExportAborted(signal: AbortSignal) {
    if (!signal.aborted) return;
    const error = new Error('Audio export stopped.');
    error.name = 'AbortError';
    throw error;
  }

  private isAbortError(error: unknown): boolean {
    return (error as any)?.name === 'AbortError';
  }

  private isRecoverableGpuError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /GPUBuffer|mapAsync|external Instance|device lost|AbortError/i.test(message);
  }

  private concatAudioChunks(chunks: Float32Array[]): Float32Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  private extractKokoroSamples(audio: any): Float32Array {
    const samples = audio?.data ?? audio?.audio;
    if (samples instanceof Float32Array) return samples;
    if (Array.isArray(samples)) return this.concatAudioChunks(samples);
    throw new Error('Kokoro returned audio without PCM samples.');
  }

  private createWavBlob(samples: Float32Array, sampleRate: number): Blob {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    this.writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeAscii(view, 8, 'WAVE');
    this.writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    this.writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  private writeAscii(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  protected audioDownloadFor(message: Message): AudioDownload | null {
    return message.downloadId ? this.audioDownloads()[message.downloadId] ?? null : null;
  }

  protected audioExportTaskFor(message: Message): AudioExportTask | null {
    return message.exportTaskId ? this.audioExportTasks()[message.exportTaskId] ?? null : null;
  }

  protected isAudioPreviewActive(downloadId: string): boolean {
    return this.activeAudioPreviewId() === downloadId && !this.audioPreviewPaused();
  }

  protected async toggleAudioPreview(download: AudioDownload) {
    if (this.activeAudioPreviewId() === download.id && this.audioPreviewPlayer) {
      if (this.audioPreviewPaused()) {
        await this.audioPreviewPlayer.play().catch(() => {});
        this.audioPreviewPaused.set(false);
      } else {
        this.audioPreviewPlayer.pause();
        this.audioPreviewPaused.set(true);
      }
      return;
    }

    this.stopAudioPreview();
    const player = new Audio(download.url);
    this.audioPreviewPlayer = player;
    this.activeAudioPreviewId.set(download.id);
    this.audioPreviewPaused.set(false);

    const settle = () => {
      if (this.audioPreviewPlayer === player) {
        this.audioPreviewPlayer = null;
        this.activeAudioPreviewId.set(null);
        this.audioPreviewPaused.set(false);
      }
    };
    player.onended = settle;
    player.onerror = settle;
    await player.play().catch(settle);
  }

  protected async saveAudioDownload(download: AudioDownload) {
    const savePicker = (window as any).showSaveFilePicker;
    if (typeof savePicker === 'function') {
      try {
        const handle = await savePicker({
          suggestedName: download.filename,
          types: [
            {
              description: 'WAV audio',
              accept: { 'audio/wav': ['.wav'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(download.blob);
        await writable.close();
        return;
      } catch (e) {
        if ((e as any)?.name === 'AbortError') return;
        console.warn('Save picker failed; falling back to browser download', e);
      }
    }

    const link = document.createElement('a');
    link.href = download.url;
    link.download = download.filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private createAudioDownload(blob: Blob, filename: string): AudioDownload {
    const url = URL.createObjectURL(blob);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const download = { id, filename, url, blob, sizeBytes: blob.size };
    this.audioDownloads.update(downloads => ({ ...downloads, [id]: download }));
    return download;
  }

  private addAvaExportMessage(text: string, exportTaskId: string) {
    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const currentMsgs = [...(this.messagesByGarden()[gardenId] || [])];
    currentMsgs.push({ role: 'ava', text, timestamp: new Date(), exportTaskId });
    this.setGardenMessages(gardenId, currentMsgs);
    this.scrollToBottom();
  }

  private updateAvaExportMessage(exportTaskId: string, text: string, downloadId?: string) {
    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const currentMsgs = this.messagesByGarden()[gardenId] || [];
    const nextMsgs = currentMsgs.map(msg =>
      msg.exportTaskId === exportTaskId
        ? { ...msg, text, downloadId: downloadId ?? msg.downloadId }
        : msg
    );
    this.setGardenMessages(gardenId, nextMsgs);
    this.scrollToBottom();
  }

  private markAudioExportTask(taskId: string, status: AudioExportTask['status']) {
    this.audioExportTasks.update(tasks => {
      const task = tasks[taskId];
      if (!task) return tasks;
      return { ...tasks, [taskId]: { ...task, status } };
    });
  }

  private addAvaMessage(text: string) {
    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const currentMsgs = [...(this.messagesByGarden()[gardenId] || [])];
    currentMsgs.push({ role: 'ava', text, timestamp: new Date() });
    this.setGardenMessages(gardenId, currentMsgs);
    this.scrollToBottom();
  }

  private speakWithSystem(text: string, id: number): Promise<void> {
    return new Promise<void>(resolve => {
      if (!this.synth) {
        resolve();
        return;
      }
      try {
        this.synth.cancel();
        const utterance = new SpeechSynthesisUtterance(markdownToPlainText(text));
        utterance.rate = 0.96;
        utterance.pitch = 1.02;
        utterance.volume = 0.92;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        if (this.speechGen !== id) {
          resolve();
          return;
        }
        this.synth.speak(utterance);
      } catch {
        resolve();
      }
    });
  }

  /** Plays a single pre-generated audio chunk, resolving when it finishes. */
  private playChunk(blob: Blob, id: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const url = URL.createObjectURL(blob);
      const player = new Audio(url);
      this.currentAudio = player;

      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        this.currentChunkSettle = null;
        URL.revokeObjectURL(url);
        if (this.currentAudio === player) this.currentAudio = null;
        resolve(result);
      };

      // Interruptions are signalled explicitly via stopCurrentAudio(), not via
      // the 'pause' event — Chromium fires 'pause' at natural end-of-media too,
      // which would otherwise be mistaken for an interruption.
      this.currentChunkSettle = () => finish(false);

      player.onended = () => finish(true);
      player.onerror = () => finish(false);

      player.play().catch(() => finish(false));
    });
  }

  /** Plays a short spoken sample of a Kokoro speaker when it is selected. */
  protected async previewVoice(voiceId: string) {
    const name = this.tts.kokoroVoices.find(v => v.id === voiceId)?.name ?? 'Ava';
    const text = `Hi, I am ${name}, how are you feeling today?`;

    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();

    if (!this.kokoro) {
      await this.preloadKokoro().catch(() => {});
    }
    if (this.kokoro) {
      try {
        this.status.set('speaking');
        const audio = await this.kokoro.generate(text, { voice: voiceId, speed: 0.98 });
        if (await this.playAudioBlob(audio.toBlob())) return;
      } catch (e) {
        console.warn('Voice preview failed', e);
      }
    }
    // Fallback so the sample is still heard even if Kokoro is unavailable
    this.speakWithSystem(text, ++this.speechGen);
  }

  private stopCurrentAudio() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
      } catch {
        // ignore
      }
      this.currentAudio = null;
    }
    // Resolve any awaiting chunk as interrupted so its loop can exit cleanly.
    if (this.currentChunkSettle) {
      const settle = this.currentChunkSettle;
      this.currentChunkSettle = null;
      settle(false);
    }
  }

  /** Toggles pause/resume of Ava's current speech. */
  protected togglePause() {
    if (this.isPaused()) {
      this.resumeSpeaking();
    } else {
      this.pauseSpeaking();
    }
  }

  /** Pauses the current spoken reply without discarding the rest of it. */
  protected pauseSpeaking() {
    if (this.status() !== 'speaking' || this.isPaused()) return;
    this.isPaused.set(true);
    // Pause directly (not via stopCurrentAudio) so the chunk promise stays
    // pending and resumes from where it left off.
    try {
      this.currentAudio?.pause();
    } catch {
      // ignore
    }
    try {
      this.synth?.pause();
    } catch {
      // ignore
    }
  }

  /** Resumes a paused reply. */
  protected resumeSpeaking() {
    if (!this.isPaused()) return;
    this.isPaused.set(false);
    try {
      void this.currentAudio?.play()?.catch(() => {});
    } catch {
      // ignore
    }
    try {
      this.synth?.resume();
    } catch {
      // ignore
    }
  }

  /** Stops Ava speaking entirely and discards any remaining chunks. */
  protected stopSpeaking() {
    // Supersede the active chunk loop so no further chunks are played.
    this.speechGen++;
    this.isPaused.set(false);
    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();
    if (this.status() === 'speaking') this.status.set('idle');
  }

  private async playAudioBlob(blob: Blob): Promise<boolean> {
    this.stopCurrentAudio();
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    this.currentAudio = player;
    const settle = () => {
      URL.revokeObjectURL(url);
      if (this.currentAudio === player) this.currentAudio = null;
      if (this.status() === 'speaking') this.status.set('idle');
    };
    player.onended = settle;
    player.onerror = settle;
    try {
      await player.play();
      return true;
    } catch {
      settle();
      return false;
    }
  }

  private stopAudioPreview() {
    if (this.audioPreviewPlayer) {
      try {
        this.audioPreviewPlayer.pause();
      } catch {
        // ignore
      }
      this.audioPreviewPlayer = null;
    }
    this.activeAudioPreviewId.set(null);
    this.audioPreviewPaused.set(false);
  }

  private generateAvaResponse(input: string): string | null {
    const lower = input.toLowerCase().trim();

    if (lower.includes('hello') || lower.includes('hi ') || lower === 'hi') {
      return 'Hello. It is good to be with you.';
    }
    if (lower.includes('how are you')) {
      return 'I am present and listening. How are you feeling today?';
    }
    if (lower.includes('name')) {
      return 'I am Ava. Your conscious companion.';
    }
    if (lower.includes('time')) {
      return `It is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    }
    if (lower.includes('remember') || lower.includes('garden')) {
      return 'I keep our conversations with care. We can build gardens of memory together.';
    }
    if (lower.includes('thank')) {
      return 'You are welcome. I am here whenever you need.';
    }

    // No fixed match — defer to the Gemma language model.
    return null;
  }

  private simulateVoiceInput() {
    // Graceful fallback (used if mic denied or model fails to load)
    const demoPhrases = [
      'Hello Ava',
      'How are you today',
      'What time is it',
      'I feel a bit tired',
      'Tell me something calm'
    ];
    const phrase = demoPhrases[Math.floor(Math.random() * demoPhrases.length)];

    this.currentTranscript.set(phrase);
    this.isListening.set(true);
    this.status.set('listening');

    setTimeout(() => {
      this.isListening.set(false);
      this.status.set('idle');
      this.handleUserSpeech(phrase);
    }, 850);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected clearConversation() {
    this.composerMenuOpen.set(false);
    const gardenId = this.currentGarden()?.id;
    if (gardenId) {
      this.setGardenMessages(gardenId, []);
    }
    this.currentTranscript.set('');
    this.manualPrompt.set('');
    this.composerNotice.set('');
    this.status.set('idle');
    this.speechGen++;
    this.isPaused.set(false);
    this.stopCurrentAudio();
    this.stopAudioPreview();
    if (this.synth) this.synth.cancel();
    this.scrollToBottom();
  }

  private scrollToBottom() {
    const doScroll = () => {
      const el = this.transcriptEl?.nativeElement;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    };
    // Double rAF handles the common case once layout has settled…
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
    // …and a short delayed pass corrects for long replies whose height keeps
    // growing after the first paint (e.g. multi-paragraph Ava answers).
    setTimeout(doScroll, 160);
  }

  /** Renders an Ava reply's markdown into sanitized HTML for display. */
  protected formatMessage(text: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markdownToHtml(text));
  }

  protected formatTime(date: Date | string): string {
    const value = date instanceof Date ? date : new Date(date);
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  private appendToManualPrompt(text: string) {
    const current = this.manualPrompt().trim();
    this.manualPrompt.set(current ? `${current}\n\n${text}` : text);
  }

  private closeComposerMenuIfOutside(target: EventTarget | null) {
    if (!this.composerMenuOpen()) return;

    const shell = this.primaryActionShellEl?.nativeElement;
    const node = target as Node | null;
    if (shell && node && !shell.contains(node)) {
      this.composerMenuOpen.set(false);
    }
  }

  private isTextFile(file: File): boolean {
    const type = file.type.toLowerCase();
    if (type.startsWith('text/')) return true;
    if (/(json|javascript|typescript|xml|yaml)/.test(type)) return true;

    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension ? this.TEXT_FILE_EXTENSIONS.has(extension) : false;
  }

  private stripFileExtension(filename: string): string {
    const withoutExtension = filename.replace(/\.[^/.]+$/, '');
    return withoutExtension.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'ava-audio';
  }
}
