import { Injectable, computed, signal } from '@angular/core';
import { McpClient, McpUnauthorizedError } from './mcp/mcp-client';
import { authorizeServer, getValidAccessToken } from './mcp/mcp-oauth';
import {
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpToolResult,
} from './mcp/mcp-types';

const STORAGE_KEY = 'ava-mcp-servers';

/** Stable id for the built-in (hosted) weather server. */
export const WEATHER_SERVER_ID = 'weather';

/**
 * Servers that ship with Ava and are always present. The user does not add or
 * remove these; they are connected automatically at startup. They are kept out
 * of the user-managed list and surfaced separately as "built in".
 */
const DEFAULT_SERVERS: ReadonlyArray<McpServerConfig> = [
  {
    id: WEATHER_SERVER_ID,
    name: 'Weather',
    description: 'Current conditions, forecasts, and alerts (global).',
    url: 'https://weather.nostria.app/mcp',
    auth: 'none',
    enabled: true,
    preset: 'weather',
  },
];

/** Presets considered built-in/managed (not shown in the user-managed list). */
const MANAGED_PRESETS = new Set(['weather']);

const isManaged = (s: McpServerConfig): boolean =>
  !!s.preset && MANAGED_PRESETS.has(s.preset);

/** GitHub's fixed OAuth endpoints (no discovery / dynamic registration). */
export const GITHUB_OAUTH_DEFAULTS = {
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  scope: 'repo read:org read:user',
} as const;

/** Built-in presets a user can add with one click. */
export const MCP_PRESETS: ReadonlyArray<Omit<McpServerConfig, 'id' | 'enabled'>> = [
  {
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'pat',
    preset: 'github',
    oauth: { ...GITHUB_OAUTH_DEFAULTS },
  },
];

@Injectable({ providedIn: 'root' })
export class McpService {
  private readonly _servers = signal<McpServerConfig[]>(this.load());
  private readonly _statuses = signal<Record<string, McpServerStatus>>({});
  private readonly clients = new Map<string, McpClient>();

  /** User-managed (non built-in) servers. */
  readonly servers = computed<McpServerConfig[]>(() =>
    this._servers().filter((s) => !isManaged(s)),
  );
  /** Per-server connection status + discovered tools. */
  readonly statuses = this._statuses.asReadonly();

  /** Built-in servers with live connection state + tool counts (for the UI). */
  readonly builtInServers = computed(() =>
    this._servers()
      .filter(isManaged)
      .map((s) => {
        const status = this._statuses()[s.id];
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          state: status?.state ?? 'disconnected',
          toolCount: status?.tools.length ?? 0,
        };
      }),
  );

  /** All tools across every connected server (built-in + user-managed). */
  readonly tools = computed<McpTool[]>(() =>
    Object.values(this._statuses()).flatMap((s) => s.tools),
  );

  readonly hasTools = computed(() => this.tools().length > 0);
  readonly connectedCount = computed(
    () => Object.values(this._statuses()).filter((s) => s.state === 'connected').length,
  );

  // --- registry CRUD ------------------------------------------------------

  addServer(input: Partial<McpServerConfig> & { name: string; url: string }): McpServerConfig {
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      url: input.url.trim(),
      auth: input.auth ?? 'none',
      pat: input.pat,
      patHeader: input.patHeader,
      oauth: input.oauth,
      preset: input.preset,
      enabled: input.enabled ?? true,
    };
    this._servers.update((list) => [...list, server]);
    this.persist();
    return server;
  }

  addPreset(preset: Omit<McpServerConfig, 'id' | 'enabled'>): McpServerConfig {
    return this.addServer({ ...preset, enabled: true });
  }

  updateServer(id: string, patch: Partial<McpServerConfig>): void {
    this._servers.update((list) =>
      list.map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s)),
    );
    this.persist();
    // Configuration changed — drop any cached client/session.
    this.clients.delete(id);
  }

  removeServer(id: string): void {
    this._servers.update((list) => list.filter((s) => s.id !== id));
    this.clients.delete(id);
    this._statuses.update((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
    this.persist();
  }

  // --- connection ---------------------------------------------------------

  async connect(id: string): Promise<void> {
    const server = this.find(id);
    if (!server) return;
    this.setStatus(id, { state: 'connecting', tools: this.toolsFor(id) });
    try {
      const client = this.clientFor(server);
      const tools = await client.listTools();
      this.setStatus(id, { state: 'connected', tools });
    } catch (err) {
      if (err instanceof McpUnauthorizedError) {
        this.setStatus(id, {
          state: 'needs-auth',
          tools: [],
          error: 'Authentication required.',
        });
      } else {
        this.setStatus(id, {
          state: 'error',
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Connect every enabled server (used at startup). */
  async connectAll(): Promise<void> {
    await Promise.all(
      this._servers()
        .filter((s) => s.enabled)
        .map((s) => this.connect(s.id)),
    );
  }

  disconnect(id: string): void {
    this.clients.delete(id);
    this.setStatus(id, { state: 'disconnected', tools: [] });
  }

  /** Runs the OAuth flow for a server, persists tokens, then connects. */
  async authenticate(id: string): Promise<void> {
    const server = this.find(id);
    if (!server) return;
    const oauth = await authorizeServer(server);
    this.updateServer(id, { auth: 'oauth', oauth });
    await this.connect(id);
  }

  // --- tool invocation ----------------------------------------------------

  /** Find a tool by name (optionally constrained to one server). */
  findTool(name: string, serverId?: string): McpTool | undefined {
    return this.tools().find(
      (t) => t.name === name && (!serverId || t.serverId === serverId),
    );
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const server = this.find(serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    const client = this.clientFor(server);
    return client.callTool(name, args);
  }

  // --- internals ----------------------------------------------------------

  private clientFor(server: McpServerConfig): McpClient {
    let client = this.clients.get(server.id);
    if (!client) {
      client = new McpClient(server, () => this.authHeaders(server.id));
      this.clients.set(server.id, client);
    }
    return client;
  }

  private async authHeaders(id: string): Promise<Record<string, string>> {
    const server = this.find(id);
    if (!server) return {};

    if (server.auth === 'pat' && server.pat) {
      if (server.patHeader && server.patHeader.toLowerCase() !== 'authorization') {
        return { [server.patHeader]: server.pat };
      }
      return { Authorization: `Bearer ${server.pat}` };
    }

    if (server.auth === 'oauth' && server.oauth?.tokens) {
      const { token, state } = await getValidAccessToken(server.oauth);
      if (state !== server.oauth) {
        // Persist refreshed tokens without dropping the client/session.
        this._servers.update((list) =>
          list.map((s) => (s.id === id ? { ...s, oauth: state } : s)),
        );
        this.persist();
      }
      return { Authorization: `${state.tokens!.tokenType} ${token}` };
    }

    return {};
  }

  private toolsFor(id: string): McpTool[] {
    return this._statuses()[id]?.tools ?? [];
  }

  private setStatus(id: string, status: McpServerStatus): void {
    this._statuses.update((s) => ({ ...s, [id]: status }));
  }

  private find(id: string): McpServerConfig | undefined {
    return this._servers().find((s) => s.id === id);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._servers()));
    } catch {
      /* ignore quota / private-mode errors */
    }
  }

  private load(): McpServerConfig[] {
    let stored: McpServerConfig[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) stored = parsed;
    } catch {
      stored = [];
    }
    // Built-in servers are always defined by code (authoritative), so drop any
    // persisted copies and re-seed them fresh alongside the user's servers.
    const userServers = stored.filter((s) => !isManaged(s));
    return [...DEFAULT_SERVERS.map((s) => ({ ...s })), ...userServers];
  }
}
