import { mcpFetch, onDeepLink, openExternal } from './mcp-http';
import { McpOAuthState, McpOAuthTokens, McpServerConfig } from './mcp-types';

/** Custom URL scheme registered with Tauri for OAuth redirects. */
const REDIRECT_URI = 'ava://oauth/callback';

/**
 * Runs the OAuth 2.1 authorization-code-with-PKCE flow:
 * (optional) metadata discovery → (optional) dynamic client registration →
 * browser authorization → deep-link callback → token exchange. Returns the
 * updated OAuth state with tokens, ready to persist.
 *
 * When the server's OAuth state already has `clientId`, `authorizationEndpoint`
 * and `tokenEndpoint` (e.g. a GitHub OAuth App), discovery and dynamic client
 * registration are skipped — only the client ID + PKCE are used (no secret/
 * backend required).
 */
export async function authorizeServer(server: McpServerConfig): Promise<McpOAuthState> {
  const state: McpOAuthState = { ...(server.oauth ?? {}) };

  const preconfigured = Boolean(
    state.clientId && state.authorizationEndpoint && state.tokenEndpoint,
  );
  if (!preconfigured) {
    // MCP-style flow: the server URL acts as the OAuth resource indicator.
    state.resource = state.resource ?? server.url;
    await discoverEndpoints(server.url, state);
    await ensureClientRegistered(state);
  }

  if (!state.clientId) {
    throw new Error('An OAuth client ID is required for this server.');
  }

  const verifier = randomString(64);
  const challenge = await s256Challenge(verifier);
  const csrf = randomString(32);

  const authUrl = new URL(state.authorizationEndpoint!);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', state.clientId!);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', csrf);
  if (state.resource) authUrl.searchParams.set('resource', state.resource);
  if (state.scope) authUrl.searchParams.set('scope', state.scope);

  const code = await waitForCallback(csrf, () => openExternal(authUrl.toString()));
  state.tokens = await exchangeCode(state, code, verifier);
  return state;
}

/** Returns a valid access token, refreshing if needed. Throws if re-auth is required. */
export async function getValidAccessToken(state: McpOAuthState): Promise<{ token: string; state: McpOAuthState }> {
  const tokens = state.tokens;
  if (!tokens) throw new Error('Not authorized');

  const expiringSoon = tokens.expiresAt && tokens.expiresAt - Date.now() < 60_000;
  if (expiringSoon && tokens.refreshToken && state.tokenEndpoint) {
    const refreshed = await refreshTokens(state, tokens.refreshToken);
    const next = { ...state, tokens: refreshed };
    return { token: refreshed.accessToken, state: next };
  }
  return { token: tokens.accessToken, state };
}

// --- discovery --------------------------------------------------------------

async function discoverEndpoints(serverUrl: string, state: McpOAuthState): Promise<void> {
  if (state.authorizationEndpoint && state.tokenEndpoint) return;

  const origin = new URL(serverUrl).origin;
  const path = new URL(serverUrl).pathname.replace(/\/$/, '');

  // RFC 9728 protected-resource metadata → authorization server(s).
  let authServer = origin;
  let scope: string | undefined;
  const prmCandidates = [
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of prmCandidates) {
    const prm = await fetchJson(url);
    if (prm?.authorization_servers?.length) {
      authServer = String(prm.authorization_servers[0]).replace(/\/$/, '');
      if (Array.isArray(prm.scopes_supported)) scope = prm.scopes_supported.join(' ');
      break;
    }
  }

  // RFC 8414 authorization-server metadata (fall back to OIDC discovery).
  const asPath = new URL(authServer).pathname.replace(/\/$/, '');
  const asOrigin = new URL(authServer).origin;
  const asCandidates = [
    `${asOrigin}/.well-known/oauth-authorization-server${asPath}`,
    `${asOrigin}/.well-known/oauth-authorization-server`,
    `${authServer}/.well-known/openid-configuration`,
    `${asOrigin}/.well-known/openid-configuration`,
  ];
  let meta: any = null;
  for (const url of asCandidates) {
    meta = await fetchJson(url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) break;
    meta = null;
  }

  if (meta) {
    state.authorizationEndpoint = meta.authorization_endpoint;
    state.tokenEndpoint = meta.token_endpoint;
    state.registrationEndpoint = meta.registration_endpoint;
  } else {
    // Sensible defaults if the server doesn't publish metadata.
    state.authorizationEndpoint = `${authServer}/authorize`;
    state.tokenEndpoint = `${authServer}/token`;
    state.registrationEndpoint = `${authServer}/register`;
  }
  if (!state.scope) state.scope = scope;
}

async function ensureClientRegistered(state: McpOAuthState): Promise<void> {
  if (state.clientId) return;
  if (!state.registrationEndpoint) {
    throw new Error('Server does not support dynamic client registration; a client ID is required.');
  }

  const res = await mcpFetch(state.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Ava',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: state.scope,
    }),
  });
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed (${res.status})`);
  }
  const data = await res.json();
  state.clientId = data.client_id;
  if (data.client_secret) state.clientSecret = data.client_secret;
}

// --- token exchange ---------------------------------------------------------

async function exchangeCode(state: McpOAuthState, code: string, verifier: string): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: state.clientId!,
    code_verifier: verifier,
  });
  if (state.resource) body.set('resource', state.resource);
  if (state.clientSecret) body.set('client_secret', state.clientSecret);
  return postToken(state.tokenEndpoint!, body);
}

async function refreshTokens(state: McpOAuthState, refreshToken: string): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: state.clientId!,
  });
  if (state.resource) body.set('resource', state.resource);
  if (state.clientSecret) body.set('client_secret', state.clientSecret);
  const tokens = await postToken(state.tokenEndpoint!, body);
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

async function postToken(endpoint: string, body: URLSearchParams): Promise<McpOAuthTokens> {
  const res = await mcpFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  // GitHub (and some others) return HTTP 200 with an error payload on failure.
  if (data.error) {
    throw new Error(`Token request failed: ${data.error_description || data.error}`);
  }
  if (!data.access_token) {
    throw new Error('Token response did not include an access token.');
  }
  const expiresIn = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
  };
}

// --- deep-link callback -----------------------------------------------------

function waitForCallback(expectedState: string, trigger: () => Promise<void>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for authorization (5 min).'));
    }, 5 * 60_000);

    const cleanup = () => {
      clearTimeout(timeout);
      if (unlisten) unlisten();
    };

    const handle = (urls: string[]) => {
      for (const raw of urls) {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          continue;
        }
        if (!raw.startsWith('ava://')) continue;
        const params = url.searchParams;
        const error = params.get('error');
        if (error) {
          cleanup();
          reject(new Error(`Authorization denied: ${params.get('error_description') || error}`));
          return;
        }
        const code = params.get('code');
        const returnedState = params.get('state');
        if (code && returnedState === expectedState) {
          cleanup();
          resolve(code);
          return;
        }
      }
    };

    onDeepLink(handle)
      .then((fn) => {
        unlisten = fn;
        return trigger();
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

// --- crypto helpers ---------------------------------------------------------

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await mcpFetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
