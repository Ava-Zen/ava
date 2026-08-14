import { mcpFetch } from '../mcp/mcp-http';

export const XAI_API_BASE = 'https://api.x.ai/v1';
/** SuperGrok / X Premium+ OAuth chat is billed against the subscription, not console credits. */
export const GROK_OAUTH_API_BASE = 'https://cli-chat-proxy.grok.com/v1';
export const XAI_AUTH_ISSUER = 'https://auth.x.ai';

/** Identity the subscription proxy requires (426 without these). */
export const GROK_CLI_HEADERS: Record<string, string> = {
  'User-Agent': 'xai-grok-cli',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-version': '0.2.114',
};

export function resolveXaiBaseUrl(method: 'oauth' | 'api-key' | null | undefined): string {
  return method === 'oauth' ? GROK_OAUTH_API_BASE : XAI_API_BASE;
}

/** CORS-safe fetch: Tauri HTTP plugin in the desktop shell, window.fetch in the browser. */
export function xaiFetch(input: string, init?: RequestInit): Promise<Response> {
  return mcpFetch(input, init);
}

export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `Request failed (${res.status})`;
  try {
    const json = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof json.error === 'string' && json.error.trim()) return json.error;
    if (json.error && typeof json.error === 'object' && json.error.message) {
      return json.error.message;
    }
    if (json.message) return json.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 280);
}
