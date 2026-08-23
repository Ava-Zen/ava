import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { openExternal } from '../mcp/mcp-http';
import { XAI_AUTH_ISSUER, xaiFetch, readErrorMessage } from './xai-http';

/**
 * Public OAuth client registered for the official Grok CLI. Third-party
 * companions (OpenClaw, Hermes, etc.) reuse this identity so SuperGrok /
 * X Premium+ subscribers can sign in without a separate xAI API key.
 * The consent screen may say "Grok Build" — that is expected.
 */
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';

export type XaiAuthMethod = 'oauth' | 'api-key';

export interface XaiStoredAuth {
  method: XaiAuthMethod;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountLabel?: string;
  scope?: string;
}

export interface XaiDeviceLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export interface XaiOidcEndpoints {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

const STORAGE_KEY = 'ava-xai-auth';
const DEFAULT_ENDPOINTS: XaiOidcEndpoints = {
  deviceAuthorizationEndpoint: `${XAI_AUTH_ISSUER}/oauth2/device/code`,
  tokenEndpoint: `${XAI_AUTH_ISSUER}/oauth2/token`,
};

@Injectable({ providedIn: 'root' })
export class XaiAuthService {
  private readonly stored = signal<XaiStoredAuth | null>(this.load());
  private loginAbort: AbortController | null = null;

  readonly signedIn = computed(() => {
    const auth = this.stored();
    return !!auth?.accessToken;
  });
  readonly method = computed(() => this.stored()?.method ?? null);
  readonly accountLabel = computed(() => this.stored()?.accountLabel ?? '');
  readonly loginPending = signal(false);
  readonly deviceLogin = signal<XaiDeviceLogin | null>(null);
  readonly error = signal('');
  readonly grokCliAvailable = signal(false);
  readonly needsReauth = signal(false);

  constructor() {
    void this.probeGrokCliAuth();
  }

  async getAccessToken(): Promise<string> {
    const auth = this.stored();
    if (!auth?.accessToken) {
      throw new Error('Sign in with Grok to use cloud models.');
    }
    if (auth.method === 'api-key') return auth.accessToken;
    if (this.isExpiring(auth) && auth.refreshToken) {
      const refreshed = await this.refresh(auth);
      this.persist(refreshed);
      return refreshed.accessToken;
    }
    return auth.accessToken;
  }

  async loginWithGrok(): Promise<void> {
    const { assertCloudAllowed } = await import('../cloud-guard');
    assertCloudAllowed('grok');
    this.cancelLogin();
    this.error.set('');
    this.loginPending.set(true);
    const abort = new AbortController();
    this.loginAbort = abort;

    try {
      const endpoints = await discoverOidcEndpoints(abort.signal);
      if (abort.signal.aborted) return;
      const started = await requestDeviceCode(endpoints, abort.signal);
      if (abort.signal.aborted) return;

      const login: XaiDeviceLogin = {
        userCode: started.user_code,
        verificationUri: started.verification_uri,
        verificationUriComplete: started.verification_uri_complete,
        expiresAt: Date.now() + started.expires_in * 1000,
      };
      this.deviceLogin.set(login);

      const openUrl = login.verificationUriComplete || login.verificationUri;
      try {
        await openExternal(openUrl);
      } catch {
        this.error.set('Open the xAI sign-in page from the button below if the browser did not appear.');
      }

      const tokens = await pollDeviceToken(endpoints, started, abort.signal);
      if (abort.signal.aborted) return;

      this.needsReauth.set(false);
      this.persist({
        method: 'oauth',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountLabel: tokens.accountLabel || 'Grok account',
        scope: tokens.scope,
      });
    } catch (err) {
      if (!abort.signal.aborted) {
        this.error.set(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null;
      this.loginPending.set(false);
      this.deviceLogin.set(null);
    }
  }

  async loginWithApiKey(rawKey: string): Promise<void> {
    const key = rawKey.trim();
    if (!isLikelyApiKey(key)) {
      throw new Error('Paste an xAI API key from console.x.ai. It usually starts with xai-.');
    }
    this.error.set('');
    this.persist({
      method: 'api-key',
      accessToken: key,
      accountLabel: 'API key',
    });
  }

  async importGrokCliAuth(): Promise<boolean> {
    const parsed = await this.readGrokCliAuth();
    if (!parsed) return false;
    this.persist(parsed);
    return true;
  }

  /** Refresh even if the access token has not expired yet (picks up new scopes). */
  async forceRefresh(): Promise<boolean> {
    const auth = this.stored();
    if (!auth?.refreshToken || auth.method !== 'oauth') return false;
    try {
      const refreshed = await this.refresh(auth);
      this.persist(refreshed);
      this.needsReauth.set(false);
      return true;
    } catch {
      return false;
    }
  }

  markNeedsReauth(message?: string): void {
    this.needsReauth.set(true);
    if (message) this.error.set(message);
  }

  logout(): void {
    this.cancelLogin();
    this.stored.set(null);
    this.needsReauth.set(false);
    this.error.set('');
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.loginPending.set(false);
    this.deviceLogin.set(null);
  }

  async openVerificationPage(): Promise<void> {
    const login = this.deviceLogin();
    if (!login) return;
    await openExternal(login.verificationUriComplete || login.verificationUri);
  }

  private async probeGrokCliAuth(): Promise<void> {
    const parsed = await this.readGrokCliAuth();
    this.grokCliAvailable.set(!!parsed);
  }

  private async readGrokCliAuth(): Promise<XaiStoredAuth | null> {
    try {
      const raw = await invoke<string | null>('xai_read_grok_cli_auth');
      if (!raw) return null;
      return parseGrokCliAuth(raw);
    } catch {
      return null;
    }
  }

  private async refresh(auth: XaiStoredAuth): Promise<XaiStoredAuth> {
    if (!auth.refreshToken) throw new Error('Grok session expired. Please sign in again.');
    const endpoints = await discoverOidcEndpoints();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    });
    const tokens = await postToken(endpoints.tokenEndpoint, body);
    return {
      ...auth,
      method: 'oauth',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || auth.refreshToken,
      expiresAt: tokens.expiresAt,
      accountLabel: tokens.accountLabel || auth.accountLabel || 'Grok account',
      scope: tokens.scope || auth.scope,
    };
  }

  private persist(auth: XaiStoredAuth): void {
    this.stored.set(auth);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } catch {
      // Ava can still use the token for this session.
    }
  }

  private load(): XaiStoredAuth | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<XaiStoredAuth>;
      if (!parsed.accessToken || (parsed.method !== 'oauth' && parsed.method !== 'api-key')) {
        return null;
      }
      return {
        method: parsed.method,
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        accountLabel: parsed.accountLabel,
        scope: parsed.scope,
      };
    } catch {
      return null;
    }
  }

  private isExpiring(auth: XaiStoredAuth): boolean {
    return isTokenExpiring(auth.expiresAt);
  }
}

export function isTokenExpiring(expiresAt: number | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  return expiresAt - now < 60_000;
}

export function isLikelyApiKey(value: string): boolean {
  const key = value.trim();
  return key.startsWith('xai-') ? key.length > 12 : key.length >= 24;
}

export function parseGrokCliAuth(raw: string): XaiStoredAuth | null {
  try {
    const data = JSON.parse(raw) as unknown;
    const found = findTokenFields(data);
    if (!found?.accessToken) return null;
    return {
      method: 'oauth',
      accessToken: found.accessToken,
      refreshToken: found.refreshToken,
      expiresAt: found.expiresAt,
      accountLabel: found.accountLabel || 'Grok CLI',
    };
  } catch {
    return null;
  }
}

interface LooseTokenRecord {
  access_token?: unknown;
  accessToken?: unknown;
  token?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
  expires_in?: unknown;
  expiresIn?: unknown;
  refresh_token?: unknown;
  refreshToken?: unknown;
  email?: unknown;
  account?: unknown;
  name?: unknown;
}

function findTokenFields(value: unknown, depth = 0): {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountLabel?: string;
} | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const rec = value as LooseTokenRecord;
  const access =
    asString(rec.access_token) ||
    asString(rec.accessToken) ||
    asString(rec.token);
  if (access) {
    const expiresAt =
      asNumber(rec.expires_at) ||
      asNumber(rec.expiresAt) ||
      expiryFromSeconds(asNumber(rec.expires_in) ?? asNumber(rec.expiresIn));
    return {
      accessToken: access,
      refreshToken: asString(rec.refresh_token) || asString(rec.refreshToken),
      expiresAt,
      accountLabel: asString(rec.email) || asString(rec.account) || asString(rec.name),
    };
  }
  for (const child of Object.values(rec)) {
    const found = findTokenFields(child, depth + 1);
    if (found?.accessToken) return found;
  }
  return null;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountLabel?: string;
  scope?: string;
}

export async function discoverOidcEndpoints(signal?: AbortSignal): Promise<XaiOidcEndpoints> {
  try {
    const res = await withTimeout(
      xaiFetch(`${XAI_AUTH_ISSUER}/.well-known/openid-configuration`, {
        headers: { Accept: 'application/json' },
      }),
      20_000,
      signal,
    );
    if (!res.ok) return DEFAULT_ENDPOINTS;
    const meta = (await res.json()) as {
      device_authorization_endpoint?: string;
      token_endpoint?: string;
    };
    return {
      deviceAuthorizationEndpoint:
        meta.device_authorization_endpoint || DEFAULT_ENDPOINTS.deviceAuthorizationEndpoint,
      tokenEndpoint: meta.token_endpoint || DEFAULT_ENDPOINTS.tokenEndpoint,
    };
  } catch {
    return DEFAULT_ENDPOINTS;
  }
}

async function requestDeviceCode(
  endpoints: XaiOidcEndpoints,
  signal?: AbortSignal,
): Promise<DeviceCodeResponse> {
  const res = await withTimeout(
    xaiFetch(endpoints.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }).toString(),
    }),
    20_000,
    signal,
  );
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as DeviceCodeResponse;
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('xAI did not return a device login code.');
  }
  return {
    ...data,
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

async function pollDeviceToken(
  endpoints: XaiOidcEndpoints,
  started: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<TokenResult> {
  const deadline = Date.now() + started.expires_in * 1000;
  let intervalMs = Math.max(3, started.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Sign-in cancelled.');
    await sleep(intervalMs, signal);

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: started.device_code,
      client_id: XAI_OAUTH_CLIENT_ID,
    });

    const res = await xaiFetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const data = (await res.json().catch(() => ({}))) as TokenPayload;
    if (res.ok && data.access_token) {
      return normalizeTokenPayload(data);
    }

    const error = String(data.error || '');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 2000;
      continue;
    }
    if (error === 'expired_token') {
      throw new Error('The Grok sign-in code expired. Try again.');
    }
    if (error === 'access_denied') {
      throw new Error('Grok sign-in was denied.');
    }
    if (error) {
      throw new Error(String(data.error_description || error));
    }
    if (!res.ok) {
      throw new Error(await readErrorMessage(res));
    }
  }

  throw new Error('Timed out waiting for Grok authorization.');
}

async function postToken(endpoint: string, body: URLSearchParams): Promise<TokenResult> {
  const res = await xaiFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const data = (await res.json()) as TokenPayload;
  if (data.error) {
    throw new Error(String(data.error_description || data.error));
  }
  return normalizeTokenPayload(data);
}

interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export function normalizeTokenPayload(data: TokenPayload): TokenResult {
  const accessToken = asString(data.access_token);
  if (!accessToken) throw new Error('Token response did not include an access token.');
  const expiresIn = asNumber(data.expires_in);
  return {
    accessToken,
    refreshToken: asString(data.refresh_token),
    expiresAt: expiryFromSeconds(expiresIn),
    accountLabel: labelFromIdToken(asString(data.id_token)),
    scope: asString(data.scope),
  };
}

export function isMissingApiAccessScope(message: string): boolean {
  return /missing required scope:\s*api:access/i.test(message);
}

export const REAUTH_MESSAGE =
  'Grok needs an updated sign-in that includes API access. Approve it in the browser, then ask again.';

function labelFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as {
      email?: string;
      preferred_username?: string;
      name?: string;
    };
    return payload.email || payload.preferred_username || payload.name;
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return atob(padded);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function expiryFromSeconds(expiresIn: number | undefined): number | undefined {
  if (!expiresIn || expiresIn <= 0) return undefined;
  return Date.now() + expiresIn * 1000;
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sign-in cancelled.'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('Timed out contacting xAI. Check your network and try again.')), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Sign-in cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Sign-in cancelled.'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Sign-in cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
