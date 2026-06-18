import { mcpFetch } from './mcp-http';
import { McpServerConfig, McpTool, McpToolResult } from './mcp-types';

const PROTOCOL_VERSION = '2025-06-18';

/** Thrown when a server responds 401 and OAuth is required. */
export class McpUnauthorizedError extends Error {
  constructor(
    message: string,
    /** Value of the WWW-Authenticate header, if any. */
    readonly wwwAuthenticate?: string,
  ) {
    super(message);
    this.name = 'McpUnauthorizedError';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Minimal Streamable HTTP MCP client.
 *
 * Speaks JSON-RPC 2.0 over a single HTTP endpoint, handling both
 * `application/json` and `text/event-stream` (SSE) responses, plus the
 * `Mcp-Session-Id` session header.
 */
export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(
    private readonly server: McpServerConfig,
    /** Returns auth headers to attach to every request. */
    private readonly authHeaders: () => Promise<Record<string, string>>,
  ) {}

  /** Performs the MCP handshake. Safe to call multiple times. */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Ava', version: '0.1.0' },
    });

    // Some servers still respond even without a session id; tolerate both.
    void result;
    this.initialized = true;

    // Notify the server we're ready (notification → no response expected).
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.request('tools/list', {});
    const tools: any[] = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((t) => ({
      name: String(t.name),
      description: t.description ? String(t.description) : undefined,
      inputSchema: t.inputSchema ?? undefined,
      serverId: this.server.id,
      serverName: this.server.name,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    return this.flattenToolResult(result);
  }

  // --- internals ----------------------------------------------------------

  private async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const response = await this.send({ jsonrpc: '2.0', id, method, params });
    const message = await this.readMessage(response, id);
    if (!message) {
      throw new Error(`No response received for ${method}`);
    }
    if (message.error) {
      throw new Error(`${method} failed: ${message.error.message}`);
    }
    return message.result;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    // Notifications have no id and expect a 202 (or empty) response.
    await this.send({ jsonrpc: '2.0', method, params });
  }

  private async send(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(await this.authHeaders()),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.initialized) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;

    const response = await mcpFetch(this.server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const newSession = response.headers.get('Mcp-Session-Id') || response.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;

    if (response.status === 401) {
      throw new McpUnauthorizedError(
        'MCP server requires authentication',
        response.headers.get('WWW-Authenticate') || undefined,
      );
    }
    if (!response.ok && response.status !== 202) {
      const text = await safeText(response);
      throw new Error(`MCP request failed (${response.status}): ${text || response.statusText}`);
    }
    return response;
  }

  /** Reads a JSON-RPC response from JSON or SSE, matching the request id. */
  private async readMessage(response: Response, id: number | string): Promise<JsonRpcResponse | null> {
    if (response.status === 202) return null;

    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    const text = await safeText(response);
    if (!text) return null;

    if (contentType.includes('text/event-stream')) {
      for (const data of parseSseData(text)) {
        const msg = tryParse(data);
        if (msg && (msg.id === id || msg.id === undefined)) return msg;
      }
      return null;
    }

    const parsed = tryParse(text);
    if (Array.isArray(parsed)) {
      return parsed.find((m: JsonRpcResponse) => m.id === id) ?? parsed[0] ?? null;
    }
    return parsed;
  }

  private flattenToolResult(result: any): McpToolResult {
    const isError = Boolean(result?.isError);
    const content: any[] = Array.isArray(result?.content) ? result.content : [];
    const parts: string[] = [];
    for (const item of content) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item?.type === 'resource' && item.resource?.text) {
        parts.push(String(item.resource.text));
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    let text = parts.join('\n').trim();
    if (!text && result?.structuredContent) {
      text = JSON.stringify(result.structuredContent);
    }
    return { text, isError, raw: result };
  }
}

function tryParse(text: string): JsonRpcResponse | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function* parseSseData(text: string): Generator<string> {
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split(/\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length) yield dataLines.join('\n');
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
