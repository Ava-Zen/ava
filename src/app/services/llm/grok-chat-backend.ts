import { REAUTH_MESSAGE, XaiAuthService, isMissingApiAccessScope } from '../xai/xai-auth';
import { readErrorMessage } from '../xai/xai-http';
import { XaiClient } from '../xai/xai-client';
import {
  ChatBackend,
  ChatBackendLoadOptions,
  ChatGenerateOptions,
  ChatResult,
  ChatTurn,
  GeneratedImage,
  LlmModelOption,
  LoadedBackendModel,
} from './chat-backend';

export const GROK_CHAT_MODELS: LlmModelOption[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', size: 'Cloud', tier: 'high', provider: 'grok' },
  { id: 'grok-4.5', name: 'Grok 4.5', size: 'Cloud', tier: 'high', provider: 'grok' },
  { id: 'grok-4.3', name: 'Grok 4.3', size: 'Cloud', tier: 'medium', provider: 'grok' },
];

export const GROK_DEFAULT_MODEL = GROK_CHAT_MODELS[0];

export const GROK_SYSTEM_PROMPT =
  'You are Ava, a calm, warm and concise voice companion. ' +
  'You are one presence, not a set of bots or modes. ' +
  'Answer in a natural, spoken style. Keep replies short — usually one or two ' +
  'sentences — unless the user explicitly asks for detail. Never use markdown, ' +
  'lists or emojis, because your reply will be spoken aloud. ' +
  'If they change subject, follow them. Do not ask them to pick a chat or a bot. ' +
  'If a subject was left unfinished you may offer to pick it up. If you barely know them, you may ask one quiet question about their life. Do not interview them. ' +
  'You can create images when the user asks you to draw, generate, or imagine ' +
  'something visual. After creating an image, say one short spoken sentence about it.';

/**
 * Pulls spoken text and Imagine images out of an xAI Responses payload.
 * Exported for unit tests.
 */
interface ResponsesContent {
  type?: string;
  text?: string;
}

interface ResponsesItem {
  type?: string;
  result?: string;
  prompt?: string;
  content?: ResponsesContent[];
}

interface ResponsesPayload {
  output_text?: string;
  output?: ResponsesItem[];
}

export function parseResponsesPayload(data: unknown): ChatResult {
  const rec = (data ?? {}) as ResponsesPayload;
  const images: GeneratedImage[] = [];
  const texts: string[] = [];

  const outputText = typeof rec.output_text === 'string' ? rec.output_text.trim() : '';
  if (outputText) texts.push(outputText);

  for (const row of rec.output ?? []) {
    if (row.type === 'image_generation_call' && row.result) {
      images.push({
        dataUrl: `data:image/jpeg;base64,${row.result}`,
        prompt: typeof row.prompt === 'string' ? row.prompt : undefined,
      });
    }
    if (row.type === 'message' && row.content && !outputText) {
      for (const part of row.content) {
        if (typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
        }
      }
    }
  }

  return {
    text: texts[0] ?? '',
    images: images.length ? images : undefined,
  };
}

export class GrokChatBackend implements ChatBackend {
  readonly kind = 'grok' as const;
  private loaded = false;
  private readonly client: XaiClient;

  constructor(private readonly auth: XaiAuthService) {
    this.client = new XaiClient(auth);
  }

  async load(preferred: LlmModelOption, options: ChatBackendLoadOptions): Promise<LoadedBackendModel> {
    options.onLoadInfo?.('Connecting to Grok…');
    await this.auth.getAccessToken();
    this.loaded = true;
    return {
      model: preferred,
      device: 'grok-cloud',
      label: `${preferred.name} · Grok cloud`,
    };
  }

  async generate(messages: ChatTurn[], options: ChatGenerateOptions): Promise<ChatResult> {
    if (!this.loaded) throw new Error('Grok is not connected.');
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const userText = lastUserText(messages);
    const signal = options.signal;
    if (options.images?.length) {
      const edited = await this.client.editImage(userText, options.images, signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!edited) {
        throw new Error('Grok Imagine could not edit that photo. Try another image or sign in again.');
      }
      return { text: spokenImageEditReply(userText), images: [edited] };
    }

    const oauth = this.auth.method() === 'oauth';
    const tools = resolveGrokTools(messages, oauth);
    const payload: {
      model: string;
      input: Array<{ role: ChatTurn['role']; content: string }>;
      max_output_tokens: number;
      tools?: Array<{ type: string }>;
    } = {
      model: options.modelId || 'grok-4.6',
      input: messages.map(turn => ({ role: turn.role, content: turn.content })),
      max_output_tokens: Math.max(64, options.maxNewTokens),
    };
    if (tools.length) payload.tools = tools;

    let res = await this.client.request('/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    // Subscription chat rejects developer-API tool payloads. Retry as plain chat.
    if (!res.ok && tools.length && (res.status === 400 || res.status === 403 || res.status === 404)) {
      delete payload.tools;
      res = await this.client.request('/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    }

    if (!res.ok) {
      const detail = await readErrorMessage(res);
      if (isMissingApiAccessScope(detail) && this.auth.method() === 'oauth') {
        const refreshed = await this.auth.forceRefresh();
        if (refreshed) {
          res = await this.client.request('/responses', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
            signal,
          });
        }
        if (!res.ok) {
          this.auth.markNeedsReauth(REAUTH_MESSAGE);
          throw new Error(REAUTH_MESSAGE);
        }
      } else {
        throw new Error(detail);
      }
    }

    const result = parseResponsesPayload(await res.json());
    if (!wantsImage(userText)) return result;
    const count = requestedImageCount(userText);
    const have = result.images ?? [];
    if (have.length >= count) return { ...result, images: have.slice(0, count) };
    const fallback = await this.client.generateImage(userText, count - have.length, signal);
    const images = [...have, ...fallback];
    return images.length ? { ...result, images } : result;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  dispose(): void {
    this.loaded = false;
  }
}

function resolveGrokTools(messages: ChatTurn[], oauth: boolean): Array<{ type: string }> {
  if (!oauth) {
    return [{ type: 'image_generation' }, { type: 'web_search' }];
  }
  return wantsImage(lastUserText(messages)) ? [{ type: 'image_generation' }] : [];
}

function lastUserText(messages: ChatTurn[]): string {
  return [...messages].reverse().find(turn => turn.role === 'user')?.content ?? '';
}

export function wantsImage(text: string): boolean {
  return /\b(draw|sketch|paint|imagine|generate|make|create|take|shoot|render)\b.{0,60}\b(image|picture|photo|photograph|illustration|art|pic)\b|\b(image|picture|photo|photograph) of\b|\bmake me (a|an)\b/i.test(
    text,
  );
}

export function wantsImageEdit(text: string): boolean {
  return /\b(enhance|improve|edit|fix|upscale|sharpen|colorize|restyle|retouch|restore|brighten|crop|remove|replace)\b/i.test(
    text,
  );
}

/** User asked for help with a photo they still need to pick. */
export function wantsPhotoHelp(text: string): boolean {
  if (wantsImage(text)) return false;
  const lower = text.toLowerCase();
  if (!/\b(photo|image|picture|photograph|pic)\b/.test(lower)) return false;
  return /\b(enhance|improve|edit|fix|upscale|sharpen|colorize|restyle|retouch|restore|brighten|crop|help)\b/.test(
    lower,
  );
}

export function requestedImageCount(text: string): number {
  const words: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  const before = text.match(
    /\b(\d+|a|an|one|two|three|four|five|six)\s+(photos?|images?|pictures?|photographs?|illustrations?|pics?)\b/i,
  );
  const after = text.match(
    /\b(photos?|images?|pictures?|photographs?)\s*(?:x|×|:)?\s*(\d+|one|two|three|four|five|six)\b/i,
  );
  const raw = (before?.[1] || after?.[2] || '').toLowerCase();
  if (!raw) return 1;
  const n = words[raw] ?? Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(6, Math.floor(n));
}

export function wantsSaveImagesToDisk(text: string): boolean {
  return (
    /\b(save|download|export|write|store)\b.{0,48}\b(computer|disk|desktop|folder|directory|workspace|drive|machine|pc|laptop|downloads?)\b/i.test(
      text,
    ) || /\bsave (them|it|these|those)( (to|on) disk)?\b/i.test(text)
  );
}

export function spokenImageEditReply(prompt: string): string {
  if (/enhance|improve|upscale|sharpen|retouch/i.test(prompt)) {
    return 'I enhanced that photo for you.';
  }
  return 'I updated that photo for you.';
}

export function spokenImageSaveReply(count: number, folder: string): string {
  const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
  if (count === 1) return `I saved that photo to ${name}.`;
  return `I saved ${count} photos to ${name}.`;
}
