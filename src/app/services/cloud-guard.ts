const STORAGE_KEY = 'ava-dev-block-cloud';

export const CLOUD_BLOCKED_MESSAGE =
  'Cloud requests are blocked in this development session.';

const CLOUD_HOST =
  /(?:^|\/\/)(?:[^/]*\.)?(?:x\.ai|grok\.com|github\.com|api\.github\.com|copilot(?:-proxy)?)/i;

export function isCloudBlocked(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    if (sessionStorage.getItem(STORAGE_KEY) === '1') return true;
    if (localStorage.getItem(STORAGE_KEY) === '1') return true;
  } catch {
    // ignore
  }
  try {
    if (new URLSearchParams(window.location.search).has('nocloud')) {
      rememberCloudBlock();
      return true;
    }
  } catch {
    // ignore
  }
  const w = window as Window & { __karma__?: unknown; __VITEST__?: unknown };
  if (w.__karma__ || w.__VITEST__) return true;
  try {
    const mode = (import.meta as { env?: { MODE?: string } }).env?.MODE;
    if (mode === 'test') return true;
  } catch {
    // ignore
  }
  return false;
}

export function rememberCloudBlock(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // ignore
  }
}

export function isCloudUrl(url: string): boolean {
  return CLOUD_HOST.test(url);
}

export function assertCloudAllowed(provider: 'grok' | 'github'): void {
  if (!isCloudBlocked()) return;
  throw new Error(`${CLOUD_BLOCKED_MESSAGE} (${provider})`);
}
