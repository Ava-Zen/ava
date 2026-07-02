import { env } from '@huggingface/transformers';

type StatusHook = (status: string) => void;

let installed = false;
let statusHook: StatusHook | null = null;

/** Routes cache progress lines to the current load's status callback. */
export function setModelCacheStatusHook(hook: StatusHook | null): void {
  statusHook = hook;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function restoreDefaultCache(): void {
  const e = env as any;
  e.useCustomCache = false;
  e.customCache = undefined;
  e.useBrowserCache = true;
}

/**
 * Redirects transformers.js model downloads through the Tauri host.
 *
 * By default transformers.js caches models in the WebView's Cache Storage,
 * which is unavailable in insecure contexts (Android dev builds served over
 * LAN) and evictable by the OS — models silently re-download on every app
 * start. Instead, the host downloads each Hugging Face file once (resumable)
 * into the app data dir and the WebView reads it back via the asset protocol.
 *
 * No-op outside Tauri; reverts to the browser cache when talking to an older
 * host without the `web_model_cache_ensure` command.
 */
export async function installTauriModelCache(): Promise<void> {
  if (installed || !isTauri()) return;
  installed = true;

  const { invoke, Channel, convertFileSrc } = await import('@tauri-apps/api/core');

  const match = async (request: RequestInfo | URL): Promise<Response | undefined> => {
    const key =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    // Non-remote keys (e.g. '/models/...' local-path probes) are not ours.
    if (!key.startsWith('https://huggingface.co/')) return undefined;

    try {
      const onProgress = new Channel<{ status: string; progress?: number }>();
      onProgress.onmessage = event => {
        const suffix = typeof event.progress === 'number' ? ` (${Math.round(event.progress)}%)` : '';
        statusHook?.(`${event.status}${suffix}`);
      };
      const path = await invoke<string>('web_model_cache_ensure', { url: key, onProgress });
      const response = await fetch(convertFileSrc(path));
      return response.ok ? response : undefined;
    } catch (err) {
      if (/not found|unknown command/i.test(String(err))) {
        // Older host: give the WebView cache back rather than caching nothing.
        console.warn('[LLM] Host has no model cache command; using browser cache');
        restoreDefaultCache();
      } else {
        console.warn('[LLM] Tauri model cache failed; downloading directly', err);
      }
      return undefined;
    }
  };

  const e = env as any;
  e.useBrowserCache = false;
  e.useCustomCache = true;
  e.customCache = {
    match,
    // match() already persisted the file on the host; nothing to store here.
    put: async () => {},
  };
}
