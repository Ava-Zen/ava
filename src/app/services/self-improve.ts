import { Injectable, signal } from '@angular/core';
import { isTauriDesktop } from './updates';

export interface SelfImproveStatus {
  desktop: boolean;
  fromCheckout: boolean;
  customized: boolean;
  armed: boolean;
  sourcePath: string;
  pristinePath: string;
  liveExe: string;
  originalExe: string;
  node: boolean;
  npm: boolean;
  cargo: boolean;
  ready: boolean;
  missing: string[];
  message: string;
}

export interface SelfImproveEnsure {
  path: string;
  fromCheckout: boolean;
}

export function buildSelfImprovePrompt(task: string): string {
  const request = task.trim() || 'the change the user asked for';
  return [
    'This session is Ava changing her own source. Stay in this workspace. Do not open another project.',
    `The user asked Ava to improve herself by: ${request}`,
    'Make the smallest change that does that. Follow Agents.md.',
    'Before you finish you must prove the app still compiles:',
    '- `npm run build` must succeed (Angular).',
    '- `node scripts/with-windows-clang.js cargo check --manifest-path src-tauri/Cargo.toml` must succeed (Rust).',
    'If either fails, fix it and run them again. Do not finish while compile is red.',
    'When both succeed, call the Ava MCP tool `speak` with a short line such as: "I\'m done with my self-improvements. I\'m going to sleep for a moment. Be right back."',
    'Then call the Ava MCP tool `self_improve_ready`. That is what rebuilds and restarts Ava. Do not skip it. Do not call it unless this session is a self-improvement Ava started.',
  ].join('\n');
}

export function buildSelfImproveFollowUp(task: string): string {
  const request = task.trim() || 'the change the user asked for';
  return [
    `Another self-improvement on Ava herself: ${request}`,
    'Same rules: stay in this workspace, compile must pass, then speak, then self_improve_ready.',
  ].join('\n');
}

@Injectable({ providedIn: 'root' })
export class SelfImproveService {
  readonly desktop = signal(isTauriDesktop());
  readonly status = signal<SelfImproveStatus | null>(null);
  readonly phase = signal<'idle' | 'working' | 'compiling' | 'restarting'>('idle');
  readonly error = signal('');

  async refresh(): Promise<SelfImproveStatus | null> {
    if (!this.desktop()) return null;
    try {
      const status = await invoke<SelfImproveStatus>('self_improve_status');
      this.status.set(status);
      this.error.set('');
      return status;
    } catch (err) {
      this.error.set(readError(err));
      return null;
    }
  }

  async ensureSource(): Promise<SelfImproveEnsure> {
    if (!this.desktop()) {
      throw new Error('Self-improvement lives in the desktop app.');
    }
    const result = await invoke<SelfImproveEnsure>('self_improve_ensure_source');
    await this.refresh();
    return result;
  }

  async arm(): Promise<void> {
    if (!this.desktop()) return;
    await invoke('self_improve_arm');
    this.phase.set('working');
  }

  async reset(): Promise<void> {
    if (!this.desktop()) return;
    this.phase.set('restarting');
    await invoke('self_improve_reset');
    await this.refresh();
  }

  missingToolsLine(status: SelfImproveStatus | null): string {
    const missing = status?.missing || [];
    if (!missing.length) return '';
    if (missing.length === 1) return `I need ${missing[0]} on this computer to change myself.`;
    const last = missing[missing.length - 1];
    return `I need ${missing.slice(0, -1).join(', ')}, and ${last} on this computer to change myself.`;
  }
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(command, args);
}

function readError(err: unknown): string {
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = String((err as { message?: unknown }).message || '');
    if (message.trim()) return message;
  }
  return 'I could not do that.';
}
