import { Component, signal, computed, effect, ViewChild, ElementRef, inject, HostListener } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Settings } from './settings/settings';
import { pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { GardensService, Garden } from './services/gardens';
import { TtsService } from './services/tts';

interface Message {
  role: 'user' | 'ava';
  text: string;
  timestamp: Date;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Settings],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  protected readonly title = signal('Ava');

  private readonly gardensService = inject(GardensService);
  private readonly tts = inject(TtsService);

  @ViewChild('transcript') private transcriptEl?: ElementRef<HTMLDivElement>;

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

  // Per-garden message storage (keyed by garden id)
  private messagesByGarden = signal<Record<string, Message[]>>({});

  protected readonly messages = computed(() => {
    const gardenId = this.currentGarden()?.id || 'default';
    const all = this.messagesByGarden();
    return all[gardenId] ?? [];
  });

  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.preloadModel().catch(() => {});
    this.preloadKokoro().catch(() => {});
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

  /** Global spacebar toggles listening, unless the user is typing or a dialog is open. */
  @HostListener('document:keydown', ['$event'])
  protected onGlobalKeydown(event: KeyboardEvent) {
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

  protected closeSettings() {
    this.showSettings.set(false);
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
  private isKokoroLoading = signal(false);
  private kokoroLoadInfo = signal('');
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
            { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
            { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' } },
          ]
        : [];
      attempts.push(
        { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
        { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' } }
      );

      for (const a of attempts) {
        try {
          this.transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/moonshine-base-ONNX', a);
          await this.transcriber(new Float32Array(4000));
          this.modelLoadInfo.set(hasWebGPU ? 'webgpu' : 'wasm');
          return;
        } catch {
          this.transcriber = null;
        }
      }
    } catch {
      this.transcriber = null;
    }
  }

  private async preloadKokoro() {
    if (this.kokoro || typeof window === 'undefined') return;
    try {
      this.isKokoroLoading.set(true);
      this.kokoroLoadInfo.set('loading...');

      // Use quantized for speed/size, fp32 for quality on WebGPU
      const hasWebGPU = await this.supportsWebGPU();
      const dtype = hasWebGPU ? 'fp32' : 'q8';
      const device = hasWebGPU ? 'webgpu' : 'wasm';

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
   * WebGPU + q4 on the base merged decoder can fail with "Missing required scale".
   * We try the recommended config first, then fall back to safer options.
   */
  private async ensureTranscriberLoaded(): Promise<any> {
    if (this.transcriber) return this.transcriber;

    this.isModelLoading.set(true);
    this.status.set('listening');
    this.currentTranscript.set('Loading Moonshine Base…');

    const hasWebGPU = await this.supportsWebGPU();
    const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: any; label: string }> = [];

    if (hasWebGPU) {
      attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, label: 'webgpu/q4' });
      attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, label: 'webgpu/fp32' });
    }
    attempts.push(
      { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }, label: 'wasm/q8' },
      { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' }, label: 'wasm/fp32' }
    );

    let lastError: any = null;

    try {
      for (const attempt of attempts) {
        try {
          this.modelLoadInfo.set(attempt.label);
          this.currentTranscript.set(`Loading Moonshine Base (${attempt.label})…`);

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
      this.currentTranscript.set('Moonshine Base could not be loaded.');
      throw lastError ?? new Error('Moonshine load failed');
    } finally {
      this.isModelLoading.set(false);
    }
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

      const transcriber = await this.ensureTranscriberLoaded();

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
            this.commitCurrentUtterance(transcriber);
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
          this.updateLiveTranscript(transcriber);
        }
      };

    } catch (err: any) {
      console.error('Moonshine STT start error', err);
      this.stopMoonshineListening();

      // Only use simulation if we have no working transcriber at all
      if (!this.transcriber) {
        this.currentTranscript.set('Moonshine unavailable – using demo mode');
        setTimeout(() => this.currentTranscript.set(''), 1200);
      }
      // Still allow the orb tap to feel responsive (demo only if completely broken)
      if (!this.transcriber) {
        this.simulateVoiceInput();
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

  private async updateLiveTranscript(transcriber: any) {
    try {
      if (this.moonshineBuffer.length < this.MIN_SPEECH_SAMPLES) return;

      const result: any = await transcriber(this.moonshineBuffer);
      const text = (result?.text || '').trim();
      if (text) {
        this.currentTranscript.set(text);
      }
    } catch (e) {
      // non-fatal for live updates
    }
  }

  private async commitCurrentUtterance(transcriber: any) {
    const bufferToTranscribe = this.moonshineBuffer;
    this.moonshineBuffer = new Float32Array(0);
    this.isSpeechActive = false;
    this.silenceSamples = 0;

    const live = this.currentTranscript();
    if (!live && bufferToTranscribe.length < this.MIN_SPEECH_SAMPLES) {
      return;
    }

    try {
      const result: any = await transcriber(bufferToTranscribe);
      let finalText = (result?.text || live || '').trim();

      if (finalText) {
        this.currentTranscript.set('');
        this.lastLiveUpdate = 0;
        this.handleUserSpeech(finalText);
      }
    } catch (e) {
      console.error('Moonshine transcription error on commit', e);
      if (live) {
        this.currentTranscript.set('');
        this.handleUserSpeech(live);
      }
    }
  }

  private stopMoonshineListening() {
    const wasListening = this.isListening();
    this.isListening.set(false);

    // Attempt to commit any remaining speech
    const willCommit = wasListening && !!this.transcriber && this.moonshineBuffer.length >= this.MIN_SPEECH_SAMPLES;
    if (willCommit) {
      const trans = this.transcriber;
      // fire and forget
      this.commitCurrentUtterance(trans).catch(() => {});
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
    if (partial) {
      const text = partial;
      this.currentTranscript.set('');
      this.handleUserSpeech(text);
    }
  }

  private async handleUserSpeech(text: string) {
    this.currentTranscript.set('');
    this.status.set('thinking');
    this.isThinking.set(true);

    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const currentMsgs = [...(this.messagesByGarden()[gardenId] || [])];

    // Add user message
    const userMsg: Message = { role: 'user', text, timestamp: new Date() };
    currentMsgs.push(userMsg);
    this.setGardenMessages(gardenId, currentMsgs);

    // Simulate "thinking" + proactive gentle response
    await this.delay(650 + Math.random() * 650);

    const response = this.generateAvaResponse(text);
    const avaMsg: Message = { role: 'ava', text: response, timestamp: new Date() };
    currentMsgs.push(avaMsg);
    this.setGardenMessages(gardenId, currentMsgs);

    this.isThinking.set(false);
    this.status.set('speaking');

    // Speak using synthesis if available
    this.speak(response);

    // Return to idle after speaking approx duration
    const speakDuration = Math.max(1400, response.length * 55);
    setTimeout(() => {
      if (this.status() === 'speaking') this.status.set('idle');
    }, speakDuration);
  }

  private async speak(text: string) {
    if (this.tts.selectedVoiceId() === 'kokoro' && (await this.speakWithKokoro(text))) {
      return;
    }

    // 'system' voice, or graceful fallback when Kokoro is unavailable
    this.speakWithSystem(text);
  }

  private async speakWithKokoro(text: string): Promise<boolean> {
    if (!this.kokoro) {
      await this.preloadKokoro().catch(() => {});
    }
    if (!this.kokoro) return false;
    try {
      const voice = this.tts.selectedKokoroVoiceId();
      const audio = await this.kokoro.generate(text, { voice, speed: 0.98 });
      return await this.playAudioBlob(audio.toBlob());
    } catch (e) {
      console.warn('Kokoro TTS failed, falling back', e);
      return false;
    }
  }

  private speakWithSystem(text: string) {
    if (!this.synth) {
      setTimeout(() => this.status.set('idle'), 1600);
      return;
    }
    try {
      this.synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.96;
      utterance.pitch = 1.02;
      utterance.volume = 0.92;
      utterance.onend = () => {
        if (this.status() === 'speaking') this.status.set('idle');
      };
      this.synth.speak(utterance);
    } catch (e) {
      setTimeout(() => this.status.set('idle'), 1600);
    }
  }

  private async playAudioBlob(blob: Blob): Promise<boolean> {
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    const settle = () => {
      URL.revokeObjectURL(url);
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

  private generateAvaResponse(input: string): string {
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
    if (lower.length < 12) {
      return 'I am listening.';
    }

    // Gentle, curious default responses that feel alive
    const responses = [
      'Tell me more about that.',
      'That resonates. What does it mean for you?',
      'I am here with you in this moment.',
      'Interesting. How does that make you feel?',
      'I am thinking with you.',
      'Would you like to explore that together?'
    ];
    return responses[Math.floor(Math.random() * responses.length)];
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
    const gardenId = this.currentGarden()?.id;
    if (gardenId) {
      this.setGardenMessages(gardenId, []);
    }
    this.currentTranscript.set('');
    this.status.set('idle');
    if (this.synth) this.synth.cancel();
    this.scrollToBottom();
  }

  private scrollToBottom() {
    // Double rAF ensures layout has settled after the @for / @if render before scrolling
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = this.transcriptEl?.nativeElement;
        if (el) {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      });
    });
  }

  protected formatTime(date: Date | string): string {
    const value = date instanceof Date ? date : new Date(date);
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
