import { XaiAuthService } from './xai-auth';
import {
  GROK_CLI_HEADERS,
  XAI_API_BASE,
  readErrorMessage,
  resolveXaiBaseUrl,
  xaiFetch,
} from './xai-http';

export interface GrokVoiceInfo {
  id: string;
  name: string;
  description?: string;
}

export const GROK_FALLBACK_VOICES: GrokVoiceInfo[] = [
  { id: 'carina', name: 'Carina', description: 'Soft, empathetic, and soothing' },
  { id: 'eve', name: 'Eve', description: 'Warm and upbeat' },
  { id: 'ara', name: 'Ara', description: 'Clear and bright' },
  { id: 'luna', name: 'Luna', description: 'Calm and even' },
  { id: 'leo', name: 'Leo', description: 'Steady and grounded' },
  { id: 'rex', name: 'Rex', description: 'Deep and calm' },
  { id: 'sal', name: 'Sal', description: 'Soft and conversational' },
];

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class XaiClient {
  constructor(private readonly auth: XaiAuthService) {}

  async request(
    path: string,
    init: RequestInit = {},
    kind: 'chat' | 'media' = 'chat',
  ): Promise<Response> {
    const token = await this.auth.getAccessToken();
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (this.auth.method() === 'oauth') {
      for (const [key, value] of Object.entries(GROK_CLI_HEADERS)) {
        if (!headers.has(key)) headers.set(key, value);
      }
    }
    const base = kind === 'chat' ? resolveXaiBaseUrl(this.auth.method()) : XAI_API_BASE;
    const res = await xaiFetch(`${base}${path}`, { ...init, headers });
    if (res.status === 401) {
      throw new Error('Grok session expired. Please sign in again.');
    }
    if (res.status === 429) {
      throw new Error('Grok is rate-limiting requests. Wait a moment and try again.');
    }
    return res;
  }

  async listVoices(): Promise<GrokVoiceInfo[]> {
    const res = await this.request('/tts/voices', { headers: { Accept: 'application/json' } }, 'media');
    if (!res.ok) return GROK_FALLBACK_VOICES;
    const data = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string; description?: string }> };
    const voices = (data.voices ?? [])
      .map(v => ({
        id: String(v.voice_id || '').trim(),
        name: String(v.name || v.voice_id || '').trim(),
        description: v.description,
      }))
      .filter(v => v.id && v.name);
    return voices.length ? voices : GROK_FALLBACK_VOICES;
  }

  async synthesizeSpeech(text: string, voiceId: string): Promise<Blob> {
    const res = await this.request(
      '/tts',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          voice_id: voiceId,
          language: 'en',
          output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
        }),
      },
      'media',
    );
    if (!res.ok) throw new Error(await readErrorMessage(res));
    return await res.blob();
  }

  async editImage(
    prompt: string,
    images: Array<{ dataUrl: string }>,
  ): Promise<{ dataUrl: string; prompt?: string } | null> {
    const refs = images
      .map(image => parseDataUrl(image.dataUrl))
      .filter((image): image is { url: string; type: 'image_url' } => !!image);
    if (!refs.length) return null;

    const body = JSON.stringify({
      model: 'grok-imagine-image-2.0',
      prompt,
      image: refs[0],
      images: refs.length > 1 ? refs : undefined,
      n: 1,
      response_format: 'b64_json',
    });
    return this.postImagine('/images/edits', body, prompt);
  }

  async generateImage(prompt: string): Promise<{ dataUrl: string; prompt?: string } | null> {
    const body = JSON.stringify({
      model: 'grok-imagine-image-2.0',
      prompt,
      n: 1,
      response_format: 'b64_json',
    });
    return this.postImagine('/images/generations', body, prompt);
  }

  private async postImagine(
    path: string,
    body: string,
    prompt: string,
  ): Promise<{ dataUrl: string; prompt?: string } | null> {
    for (const kind of ['media', 'chat'] as const) {
      try {
        const res = await this.request(
          path,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body,
          },
          kind,
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const first = data.data?.[0];
        if (first?.b64_json) {
          return { dataUrl: `data:image/jpeg;base64,${first.b64_json}`, prompt };
        }
        if (first?.url) return { dataUrl: first.url, prompt };
      } catch {
        // try the other host
      }
    }
    return null;
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    const wav = encodeWavPcm16(samples, sampleRate);
    const form = new FormData();
    form.append('format', 'true');
    form.append('language', 'en');
    form.append('file', wav, 'utterance.wav');
    const res = await this.request('/stt', { method: 'POST', body: form }, 'media');
    if (!res.ok) throw new Error(await readErrorMessage(res));
    const data = (await res.json()) as { text?: string };
    return (data.text || '').trim();
  }
}

export function parseDataUrl(dataUrl: string): { url: string; type: 'image_url' } | null {
  const value = dataUrl.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith('data:image/')) {
    return { url: value, type: 'image_url' };
  }
  return { url: `data:image/jpeg;base64,${value}`, type: 'image_url' };
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
