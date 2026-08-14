import { Injectable, inject, signal } from '@angular/core';
import { CopilotAuthService } from './copilot-auth';

export interface CopilotRunOptions {
  prompt: string;
  model?: string;
  agent?: string;
  workspace?: string;
  allowWrites?: boolean;
  allowLocalTools?: boolean;
  timeoutSecs?: number;
  onEvent?: (event: CopilotProgressEvent) => void;
}

export interface CopilotProgressEvent {
  event: string;
  text?: string;
}

export interface CopilotRunResult {
  content: string;
  sessionId?: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

@Injectable({ providedIn: 'root' })
export class CopilotRuntimeService {
  private readonly auth = inject(CopilotAuthService);
  readonly lastError = signal('');

  async runTask(options: CopilotRunOptions): Promise<string> {
    if (!isTauri()) {
      throw new Error('GitHub Copilot agents need the Ava desktop app.');
    }

    const host = this.auth.host() ?? (await this.auth.refreshHostStatus());
    if (host && !host.available) {
      throw new Error(host.reason || 'GitHub Copilot is not available on this device.');
    }

    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onEvent = new Channel<CopilotProgressEvent>();
    onEvent.onmessage = event => options.onEvent?.(event);

    const token = await this.auth.getAccessToken();
    const result = await invoke<CopilotRunResult>('copilot_run_task', {
      request: {
        prompt: options.prompt,
        githubToken: token,
        model: options.model,
        agent: options.agent,
        workspace: options.workspace,
        allowWrites: options.allowLocalTools === true || options.allowWrites === true,
        allowLocalTools: options.allowLocalTools === true || options.allowWrites === true,
        timeoutSecs: options.timeoutSecs,
      },
      onEvent,
    });
    return result.content.trim();
  }

  async abort(): Promise<void> {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('copilot_abort');
    } catch {
      // ignore
    }
  }
}
