import { Injectable, inject, signal } from '@angular/core';
import { assertCloudAllowed } from '../cloud-guard';
import { DebugLogService } from '../debug-log';
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
  private readonly debug = inject(DebugLogService);
  readonly lastError = signal('');

  async runTask(options: CopilotRunOptions): Promise<string> {
    assertCloudAllowed('github');
    if (!isTauri()) {
      throw new Error('GitHub Copilot agents need the Ava desktop app.');
    }

    const host = this.auth.host() ?? (await this.auth.refreshHostStatus());
    if (host && !host.available) {
      throw new Error(host.reason || 'GitHub Copilot is not available on this device.');
    }

    this.debug.log('copilot', `Run ${options.agent || 'copilot'}`, options.prompt, {
      data: { workspace: options.workspace, model: options.model },
    });
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const onEvent = new Channel<CopilotProgressEvent>();
    onEvent.onmessage = event => {
      if (event.text) this.debug.log('command', event.event || 'Copilot', event.text);
      options.onEvent?.(event);
    };

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
    const content = result.content.trim();
    this.debug.log('copilot', 'Copilot finished', content);
    return content;
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
