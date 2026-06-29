import { Injectable, signal, computed } from '@angular/core';
import { AutoModel, AutoProcessor, pipeline } from '@huggingface/transformers';

/** A user-cloned voice: a name plus a 512-dim speaker embedding. */
export interface CustomVoice {
  id: string;
  name: string;
  createdAt: number;
  /** 512-d speaker embedding (base64-encoded Float32). */
  embedding: string;
}

interface StoredState {
  voices: CustomVoice[];
  selectedId: string | null;
}

/**
 * On-device voice cloning. A short sample of the user's voice is turned into a
 * speaker embedding (WavLM SV) and reused with SpeechT5 to synthesise speech in
 * that voice — all locally, no audio ever leaves the machine. SpeechT5 outputs
 * 16 kHz mono audio.
 */
@Injectable({ providedIn: 'root' })
export class CustomVoiceService {
  private readonly STORAGE_KEY = 'ava-custom-voices';
  private readonly TTS_MODEL = 'Xenova/speecht5_tts';
  private readonly EMBED_MODEL = 'Xenova/wavlm-base-plus-sv';
  /** SpeechT5 is trained at 16 kHz. */
  readonly sampleRate = 16000;
  /** Recommended minimum sample length for a usable clone. */
  readonly minSampleSeconds = 5;

  private state = signal<StoredState>(this.load());

  readonly voices = computed(() => this.state().voices);
  readonly selectedId = computed(() => this.state().selectedId);
  readonly selectedVoice = computed(
    () => this.state().voices.find(v => v.id === this.state().selectedId) ?? null
  );
  readonly hasVoices = computed(() => this.state().voices.length > 0);

  readonly isBuilding = signal(false);
  readonly buildStatus = signal('');

  private tts: any = null;
  private embedder: any = null;

  /** Captures a sample and stores a new cloned voice. Returns its id. */
  async addVoice(name: string, samples: Float32Array, sourceRate: number): Promise<string> {
    this.isBuilding.set(true);
    this.buildStatus.set('Analyzing voice...');
    try {
      const mono16k = this.resampleMono(samples, sourceRate, this.sampleRate);
      if (mono16k.length < this.sampleRate * 1.5) {
        throw new Error('Sample too short. Please provide a few seconds of clear speech.');
      }
      const embedding = await this.extractEmbedding(mono16k);
      const voice: CustomVoice = {
        id: `cv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: name.trim() || 'My voice',
        createdAt: Date.now(),
        embedding: this.encodeEmbedding(embedding),
      };
      this.state.update(s => ({ voices: [...s.voices, voice], selectedId: voice.id }));
      this.save();
      return voice.id;
    } finally {
      this.isBuilding.set(false);
      this.buildStatus.set('');
    }
  }

  removeVoice(id: string) {
    this.state.update(s => {
      const voices = s.voices.filter(v => v.id !== id);
      const selectedId = s.selectedId === id ? (voices[0]?.id ?? null) : s.selectedId;
      return { voices, selectedId };
    });
    this.save();
  }

  select(id: string) {
    this.state.update(s => ({ ...s, selectedId: id }));
    this.save();
  }

  /** Synthesises text in the given (or selected) cloned voice → WAV blob. */
  async synthesize(text: string, voiceId?: string): Promise<{ samples: Float32Array; rate: number }> {
    const voice = voiceId
      ? this.voices().find(v => v.id === voiceId)
      : this.selectedVoice();
    if (!voice) throw new Error('No custom voice selected.');

    const tts = await this.ensureTts();
    const speaker_embeddings = this.decodeEmbedding(voice.embedding);
    const audio = await tts(text, { speaker_embeddings });
    const samples: Float32Array = audio.audio ?? audio.data;
    const rate: number = audio.sampling_rate ?? this.sampleRate;
    return { samples, rate };
  }

  private async ensureTts(): Promise<any> {
    if (this.tts) return this.tts;
    this.buildStatus.set('Loading voice synthesizer...');
    this.tts = await pipeline('text-to-speech', this.TTS_MODEL, { dtype: 'fp32' });
    return this.tts;
  }

  private async extractEmbedding(mono16k: Float32Array): Promise<Float32Array> {
    if (!this.embedder) {
      this.embedder = {
        processor: await AutoProcessor.from_pretrained(this.EMBED_MODEL),
        model: await AutoModel.from_pretrained(this.EMBED_MODEL, { dtype: 'fp32' }),
      };
    }
    const { processor, model } = this.embedder;
    const inputs = await processor(mono16k);
    const out = await model(inputs);
    const tensor = out.embeddings ?? out.logits ?? out.last_hidden_state;
    const raw = new Float32Array(tensor.data.length);
    raw.set(tensor.data);
    // SpeechT5 expects 512-d x-vectors; normalize and fit length.
    const vec = this.fitTo512(raw);
    return this.l2normalize(vec);
  }

  private fitTo512(vec: Float32Array): Float32Array {
    if (vec.length === 512) return vec;
    const out = new Float32Array(512);
    out.set(vec.subarray(0, Math.min(vec.length, 512)));
    return out;
  }

  private l2normalize(v: Float32Array): Float32Array {
    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum) || 1;
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
    return out;
  }

  /** Simple linear resample to mono target rate. */
  private resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return input;
    const ratio = toRate / fromRate;
    const length = Math.round(input.length * ratio);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const pos = i / ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] ?? 0;
      const b = input[idx + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  private encodeEmbedding(vec: Float32Array): string {
    const bytes = new Uint8Array(vec.buffer.slice(0));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  private decodeEmbedding(b64: string): Float32Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  private load(): StoredState {
    const fallback: StoredState = { voices: [], selectedId: null };
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<StoredState>;
      const voices = Array.isArray(parsed.voices) ? parsed.voices : [];
      return {
        voices,
        selectedId: voices.some(v => v.id === parsed.selectedId) ? parsed.selectedId! : voices[0]?.id ?? null,
      };
    } catch {
      return fallback;
    }
  }

  private save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.state()));
    } catch {
      // ignore persistence errors
    }
  }
}
