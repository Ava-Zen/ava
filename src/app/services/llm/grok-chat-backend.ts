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
  'Answer in a natural, spoken style. Keep replies short — usually one or two ' +
  'sentences — unless the user explicitly asks for detail. Never use markdown, ' +
  'lists or emojis, because your reply will be spoken aloud. ' +
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
    });

    // Subscription chat rejects developer-API tool payloads. Retry as plain chat.
    if (!res.ok && tools.length && (res.status === 400 || res.status === 403 || res.status === 404)) {
      delete payload.tools;
      res = await this.client.request('/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
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
    if (result.images?.length || !wantsImage(lastUserText(messages))) return result;
    const fallback = await this.client.generateImage(lastUserText(messages));
    return fallback ? { ...result, images: [fallback] } : result;
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
