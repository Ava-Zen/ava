import { Injectable, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { openExternal } from '../mcp/mcp-http';
import { mcpFetch } from '../mcp/mcp-http';

/**
 * Public OAuth client used by the official GitHub CLI. Device-flow does not
 * need a client secret. The consent screen may say "GitHub CLI" — that is
 * expected, the same way Grok sign-in may say "Grok Build".
 */
export const GITHUB_OAUTH_CLIENT_ID = '178c6fc778ccc68e1d6a';
export const GITHUB_OAUTH_SCOPE = 'read:user repo read:org';
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_DEVICE_VERIFY_URL = 'https://github.com/login/device';
export const GITHUB_API_URL = 'https://api.github.com';

export type CopilotAuthMethod = 'oauth' | 'pat' | 'cli';

export interface CopilotStoredAuth {
  method: CopilotAuthMethod;
  accessToken?: string;
  accountLabel?: string;
  scope?: string;
}

export interface CopilotDeviceLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
}

export interface CopilotHostStatus {
  available: boolean;
  reason: string;
  ghCliAvailable: boolean;
  bundledCli: boolean;
}

const STORAGE_KEY = 'ava-copilot-auth';

@Injectable({ providedIn: 'root' })
export class CopilotAuthService {
  private readonly stored = signal<CopilotStoredAuth | null>(this.load());
  private loginAbort: AbortController | null = null;

  readonly signedIn = computed(() => {
    const auth = this.stored();
    if (!auth) return false;
    if (auth.method === 'cli') return true;
    return !!auth.accessToken;
  });
  readonly method = computed(() => this.stored()?.method ?? null);
  readonly accountLabel = computed(() => this.stored()?.accountLabel ?? '');
  readonly loginPending = signal(false);
  readonly deviceLogin = signal<CopilotDeviceLogin | null>(null);
  readonly error = signal('');
  readonly host = signal<CopilotHostStatus | null>(null);
  readonly ghCliAvailable = computed(() => this.host()?.ghCliAvailable === true);
  readonly runtimeAvailable = computed(() => this.host()?.available === true);

  constructor() {
    void this.refreshHostStatus();
  }

  async getAccessToken(): Promise<string | undefined> {
    const auth = this.stored();
    if (!auth) return undefined;
    if (auth.method === 'cli') return undefined;
    if (!auth.accessToken) {
      throw new Error('Sign in with GitHub Copilot in Settings.');
    }
    return auth.accessToken;
  }

  async loginWithGitHub(): Promise<void> {
    const { assertCloudAllowed } = await import('../cloud-guard');
    assertCloudAllowed('github');
    this.cancelLogin();
    this.error.set('');
    this.loginPending.set(true);
    const abort = new AbortController();
    this.loginAbort = abort;

    try {
      const started = await requestDeviceCode(abort.signal);
      if (abort.signal.aborted) return;

      const login: CopilotDeviceLogin = {
        userCode: started.user_code,
        verificationUri: started.verification_uri || GITHUB_DEVICE_VERIFY_URL,
        verificationUriComplete: started.verification_uri_complete,
        expiresAt: Date.now() + started.expires_in * 1000,
      };
      this.deviceLogin.set(login);

      const openUrl = login.verificationUriComplete || login.verificationUri;
      try {
        await openExternal(openUrl);
      } catch {
        this.error.set('Open the GitHub sign-in page from the button below if the browser did not appear.');
      }

      const tokens = await pollDeviceToken(started, abort.signal);
      if (abort.signal.aborted) return;

      const label = await fetchGithubLogin(tokens.accessToken).catch(() => tokens.accountLabel);
      this.persist({
        method: 'oauth',
        accessToken: tokens.accessToken,
        accountLabel: label || tokens.accountLabel || 'GitHub account',
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

  async loginWithPat(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!isSupportedGithubToken(token)) {
      throw new Error(
        'Paste a fine-grained GitHub PAT (github_pat_…) with Copilot Requests, or an OAuth token (gho_/ghu_). Classic ghp_ tokens are not supported.',
      );
    }
    this.error.set('');
    const label = await fetchGithubLogin(token).catch(() => 'GitHub PAT');
    this.persist({
      method: 'pat',
      accessToken: token,
      accountLabel: label || 'GitHub PAT',
    });
  }

  async importGhCliAuth(): Promise<boolean> {
    try {
      const token = await invoke<string | null>('copilot_read_gh_auth');
      if (!token?.trim()) return false;
      const label = await fetchGithubLogin(token).catch(() => 'GitHub CLI');
      this.persist({
        method: 'oauth',
        accessToken: token.trim(),
        accountLabel: label || 'GitHub CLI',
      });
      return true;
    } catch {
      return false;
    }
  }

  useStoredCliLogin(): void {
    this.error.set('');
    this.persist({
      method: 'cli',
      accountLabel: 'Copilot CLI / GitHub CLI',
    });
  }

  logout(): void {
    this.cancelLogin();
    this.stored.set(null);
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

  async refreshHostStatus(): Promise<CopilotHostStatus | null> {
    try {
      const status = await invoke<CopilotHostStatus>('copilot_status');
      this.host.set(status);
      return status;
    } catch {
      this.host.set({
        available: false,
        reason: 'Copilot needs the Ava desktop app.',
        ghCliAvailable: false,
        bundledCli: false,
      });
      return this.host();
    }
  }

  private persist(auth: CopilotStoredAuth): void {
    this.stored.set(auth);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } catch {
      // Ava can still use the token for this session.
    }
  }

  private load(): CopilotStoredAuth | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CopilotStoredAuth>;
      if (parsed.method !== 'oauth' && parsed.method !== 'pat' && parsed.method !== 'cli') {
        return null;
      }
      if (parsed.method !== 'cli' && !parsed.accessToken) return null;
      return {
        method: parsed.method,
        accessToken: parsed.accessToken,
        accountLabel: parsed.accountLabel,
        scope: parsed.scope,
      };
    } catch {
      return null;
    }
  }
}

export function isSupportedGithubToken(value: string): boolean {
  const token = value.trim();
  if (token.startsWith('ghp_')) return false;
  if (token.startsWith('github_pat_')) return token.length > 20;
  if (token.startsWith('gho_') || token.startsWith('ghu_')) return token.length > 12;
  return false;
}

export function inferCopilotAgent(text: string): string | undefined {
  if (isGithubWorkRequest(text)) return 'github';
  if (isFileWorkRequest(text)) return 'implementer';
  const lower = text.toLowerCase();
  if (/\b(implement|edit|fix|change|write code|refactor|patch|apply)\b/.test(lower)) {
    return 'implementer';
  }
  if (/\b(plan|outline|break down|design)\b/.test(lower)) return 'planner';
  if (/\b(research|look into|investigate|explore|find out|search)\b/.test(lower)) {
    return 'researcher';
  }
  return undefined;
}

export function isFileWorkRequest(text: string): boolean {
  const lower = text.toLowerCase();
  // Photo / Imagine work stays on Grok, even when the user also says "save".
  if (/\b(photo|image|picture|photograph|illustration|pic)\b/.test(lower)) {
    return false;
  }
  return (
    /\b(create|write|save|make|generate|add|put)\b[\s\S]{0,60}\b(file|txt|text file|\.txt|\.md|\.json|folder|directory)\b/.test(lower) ||
    /\b(file|txt|text file)\b[\s\S]{0,32}\b(with (this )?content|called|named)\b/.test(lower)
  );
}

export function needsLocalFileAccess(text: string): boolean {
  return isFileWorkRequest(text) || inferCopilotAgent(text) === 'implementer';
}

export function isExplicitCopilotRequest(text: string): boolean {
  return /\b(copilot|github copilot|use copilot|ask copilot|have copilot)\b/i.test(text);
}

/** GitHub issues, PRs, and repo work that should go through Copilot, not chat. */
export function isGithubWorkRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\bgithub\b/.test(lower)) return true;
  return (
    /\b(issues?|pull requests?|prs?)\b/.test(lower) &&
    /\b(my|open|list|get|show|fetch|assigned|review)\b/.test(lower)
  );
}

export function shouldUseCopilot(
  text: string,
  signedIn: boolean,
  _runtimeIsCopilot = false,
): boolean {
  if (!signedIn) return false;
  // Runtime is only a preference for background-agent work. Casual chat,
  // jokes, and Imagine stay on Grok even after Copilot is signed in.
  return (
    isExplicitCopilotRequest(text) ||
    isGithubWorkRequest(text) ||
    isFileWorkRequest(text)
  );
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
  accountLabel?: string;
  scope?: string;
}

async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
  const res = await withTimeout(
    mcpFetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        scope: GITHUB_OAUTH_SCOPE,
      }),
    }),
    20_000,
    signal,
  );
  if (!res.ok) {
    throw new Error(await readGithubError(res));
  }
  const data = (await res.json()) as DeviceCodeResponse;
  if (!data.device_code || !data.user_code) {
    throw new Error('GitHub did not return a device login code.');
  }
  return {
    ...data,
    verification_uri: data.verification_uri || GITHUB_DEVICE_VERIFY_URL,
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

async function pollDeviceToken(
  started: DeviceCodeResponse,
  signal: AbortSignal,
): Promise<TokenResult> {
  const deadline = Date.now() + started.expires_in * 1000;
  let intervalMs = Math.max(3, started.interval ?? 5) * 1000;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Sign-in cancelled.');
    await sleep(intervalMs, signal);

    const res = await mcpFetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        device_code: started.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = (await res.json().catch(() => ({}))) as TokenPayload;
    if (res.ok && data.access_token) {
      return {
        accessToken: String(data.access_token),
        scope: typeof data.scope === 'string' ? data.scope : undefined,
      };
    }

    const error = String(data.error || '');
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      intervalMs += 2000;
      continue;
    }
    if (error === 'expired_token') {
      throw new Error('The GitHub sign-in code expired. Try again.');
    }
    if (error === 'access_denied') {
      throw new Error('GitHub sign-in was denied.');
    }
    if (error) {
      throw new Error(String(data.error_description || error));
    }
    if (!res.ok) {
      throw new Error(await readGithubError(res));
    }
  }

  throw new Error('Timed out waiting for GitHub authorization.');
}

export async function fetchGithubLogin(token: string): Promise<string | undefined> {
  const res = await mcpFetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { login?: string; name?: string };
  return data.login || data.name;
}

interface TokenPayload {
  access_token?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export async function readGithubError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `GitHub request failed (${res.status})`;
  try {
    const json = JSON.parse(text) as {
      error?: string;
      error_description?: string;
      message?: string;
    };
    return json.error_description || json.message || json.error || text.slice(0, 280);
  } catch {
    return text.slice(0, 280);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Sign-in cancelled.'));
      return;
    }
    const timer = setTimeout(
      () => reject(new Error('Timed out contacting GitHub. Check your network and try again.')),
      ms,
    );
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
