/** Shared types for Ava's Model Context Protocol (MCP) integration. */

/** How Ava authenticates to a given MCP server. */
export type McpAuthMethod = 'none' | 'pat' | 'oauth';

/** Tokens obtained through the OAuth 2.1 authorization code flow. */
export interface McpOAuthTokens {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** Epoch milliseconds when the access token expires (if known). */
  expiresAt?: number;
  scope?: string;
}

/**
 * OAuth client/server details discovered (and cached) for a server so we can
 * refresh tokens without re-running discovery every time.
 */
export interface McpOAuthState {
  clientId?: string;
  clientSecret?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  /** The resource indicator (RFC 8707) — usually the MCP server URL. */
  resource?: string;
  scope?: string;
  tokens?: McpOAuthTokens;
}

/** A user-configured MCP server. */
export interface McpServerConfig {
  id: string;
  name: string;
  /** Streamable HTTP endpoint, e.g. https://api.githubcopilot.com/mcp/ */
  url: string;
  auth: McpAuthMethod;
  /** Personal access token (when auth === 'pat'). */
  pat?: string;
  /** Header used to send the PAT. Defaults to "Authorization: Bearer <pat>". */
  patHeader?: string;
  /** OAuth state (when auth === 'oauth'). */
  oauth?: McpOAuthState;
  enabled: boolean;
  /** Marks built-in presets (e.g. GitHub) so the UI can label them. */
  preset?: string;
  /** Short human description (used for built-in servers in the UI). */
  description?: string;
}

export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error' | 'needs-auth';

/** A tool exposed by an MCP server, annotated with its origin. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

/** Result of calling an MCP tool, flattened for display + the model. */
export interface McpToolResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

/** Live status for a configured server. */
export interface McpServerStatus {
  state: McpConnectionState;
  error?: string;
  tools: McpTool[];
}
