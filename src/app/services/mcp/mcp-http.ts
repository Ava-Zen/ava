/**
 * Network + platform helpers for MCP.
 *
 * When Ava runs inside the Tauri webview we route HTTP through the Tauri HTTP
 * plugin so remote MCP servers (e.g. GitHub's hosted server) are not blocked by
 * browser CORS. When running in a plain browser (e.g. `ng serve` for dev) we
 * gracefully fall back to the global `fetch`, which works for CORS-friendly or
 * local MCP servers.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** A `fetch` that bypasses CORS when running under Tauri. */
export async function mcpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return fetch(input, init);
}

/** Open a URL in the user's default system browser. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Subscribe to deep-link callbacks (e.g. `ava://oauth/callback?...`).
 * Returns an unsubscribe function. Resolves to a no-op outside Tauri.
 */
export async function onDeepLink(cb: (urls: string[]) => void): Promise<() => void> {
  if (!isTauri()) {
    return () => {};
  }
  const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  return onOpenUrl(cb);
}
