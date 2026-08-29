import { Injectable, signal } from '@angular/core';
import { isTauriDesktop } from './updates';
import type { GrokPhase } from './grok-cli/types';

export interface SelfImproveTool {
  id: string;
  label: string;
  present: boolean;
  installUrl: string;
  installCommand: string;
  detail: string;
}

export interface SelfImproveStatus {
  desktop: boolean;
  fromCheckout: boolean;
  customized: boolean;
  armed: boolean;
  sourcePath: string;
  pristinePath: string;
  liveExe: string;
  originalExe: string;
  os?: string;
  node: boolean;
  npm: boolean;
  cargo: boolean;
  ready: boolean;
  missing: string[];
  tools?: SelfImproveTool[];
  grokInstallUrl?: string;
  grokInstallCommand?: string;
  message: string;
}

export interface SelfImproveEnsure {
  path: string;
  fromCheckout: boolean;
}

export type SelfImproveGrokGate = Extract<GrokPhase, 'setup' | 'signed-out' | 'ready' | 'boot'>;

const SETUP_SEEN_KEY = 'ava-self-improve-setup-seen';

export function grokCliInstallCommand(os?: string): string {
  const windows = (os || guessOs()) === 'windows';
  return windows
    ? 'irm https://x.ai/cli/install.ps1 | iex'
    : 'curl -fsSL https://x.ai/cli/install.sh | bash';
}

export function grokCliInstallUrl(): string {
  return 'https://x.ai/cli';
}

export function guessOs(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/windows/i.test(ua)) return 'windows';
  if (/mac os|macintosh/i.test(ua)) return 'macos';
  return 'linux';
}

export function missingTools(status: SelfImproveStatus | null): SelfImproveTool[] {
  return (status?.tools || []).filter(tool => !tool.present);
}

export function buildSelfImproveSetupSpeech(opts: {
  grokPhase: SelfImproveGrokGate | string;
  status: SelfImproveStatus | null;
  firstTime: boolean;
}): string {
  const grokPhase = opts.grokPhase;
  const grokMissing = grokPhase === 'setup' || grokPhase === 'boot';
  const grokSignedOut = grokPhase === 'signed-out';
  const tools = missingTools(opts.status);
  const parts: string[] = [];

  if (opts.firstTime) {
    parts.push(
      'To change myself I need the Grok CLI, signed in, plus Node.js, npm, Rust, and the C++ build tools.',
    );
  }

  if (grokMissing) {
    const command = opts.status?.grokInstallCommand || grokCliInstallCommand(opts.status?.os);
    parts.push(
      opts.firstTime
        ? `Grok is not installed yet. I can install it here, or in a terminal run: ${command}. Then sign in.`
        : `I still need the Grok CLI. I can install it here, or run: ${command}.`,
    );
  } else if (grokSignedOut) {
    parts.push(
      opts.firstTime
        ? 'Grok is installed. Sign in with Grok first, then I can change myself.'
        : 'Sign in with Grok first, then I can change myself.',
    );
  }

  if (tools.length) {
    const lines = tools.map(tool => {
      if (tool.installCommand) return `${tool.label}: ${tool.installCommand}`;
      if (tool.installUrl) return `${tool.label}: ${tool.installUrl}`;
      return tool.label;
    });
    if (lines.length === 1) {
      parts.push(`I also need ${lines[0]}.`);
    } else {
      parts.push(`I also need ${lines.join('. ')}.`);
    }
  }

  if (!parts.length) {
    return 'I cannot change myself on this computer yet.';
  }

  if (opts.firstTime) {
    parts.push('I opened the setup so you can tap the links.');
  }
  return parts.join(' ');
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
  readonly waitingOnSetup = signal(false);

  consumeFirstAsk(): boolean {
    try {
      if (localStorage.getItem(SETUP_SEEN_KEY) === '1') return false;
      localStorage.setItem(SETUP_SEEN_KEY, '1');
      return true;
    } catch {
      return true;
    }
  }

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
    this.waitingOnSetup.set(false);
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
