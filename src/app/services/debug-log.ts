import { Injectable, isDevMode, signal } from '@angular/core';
import { isTauriDesktop } from './updates';

export type DebugKind =
  | 'system'
  | 'status'
  | 'speech'
  | 'route'
  | 'think'
  | 'llm'
  | 'tool'
  | 'command'
  | 'mcp'
  | 'agent'
  | 'copilot'
  | 'tts'
  | 'memory'
  | 'error';

export type DebugLevel = 'info' | 'warn' | 'error';

export interface DebugEvent {
  id: string;
  at: number;
  kind: DebugKind;
  level: DebugLevel;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface DebugAgentSnapshot {
  id: string;
  status: string;
  engine: string;
  prompt: string;
  progress?: string;
}

export interface DebugSnapshot {
  status: string;
  thinking: boolean;
  listening: boolean;
  speaking: boolean;
  transcript: string;
  thinkingTrace: string[];
  model: string;
  intelligence: string;
  voice: string;
  garden: string;
  workspace: string;
  topic: string;
  mcp: string[];
  agents: DebugAgentSnapshot[];
  copilot: boolean;
  grok: boolean;
  at: number;
}

type DebugEnvelope =
  | { type: 'hello' }
  | { type: 'clear' }
  | { type: 'event'; event: DebugEvent }
  | { type: 'snapshot'; snapshot: DebugSnapshot }
  | { type: 'state'; events: DebugEvent[]; snapshot: DebugSnapshot | null };

const CHANNEL_NAME = 'ava-debug-log';
const TAURI_EVENT = 'ava://debug';
const MAX_EVENTS = 400;
const DETAIL_LIMIT = 4000;
const WINDOW_QUERY = 'debug';

export function isDebugWindow(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('window') === WINDOW_QUERY;
  } catch {
    return false;
  }
}

export function extractThinkBlock(text: string): string | null {
  const closed = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (closed?.[1]?.trim()) return closed[1].trim();
  const open = text.match(/<think>([\s\S]*)$/i);
  if (open?.[1]?.trim()) return open[1].trim();
  return null;
}

export function clipDebugText(text: string, max = DETAIL_LIMIT): string {
  const scrubbed = text.replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, 'data:…');
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max)}\n… [${scrubbed.length - max} more characters]`;
}

export function formatDebugDetail(detail: unknown): string | undefined {
  if (detail == null || detail === '') return undefined;
  if (typeof detail === 'string') return clipDebugText(detail);
  try {
    return clipDebugText(JSON.stringify(detail, null, 2));
  } catch {
    return clipDebugText(String(detail));
  }
}

@Injectable({ providedIn: 'root' })
export class DebugLogService {
  readonly events = signal<DebugEvent[]>([]);
  readonly snapshot = signal<DebugSnapshot | null>(null);
  readonly overlayOpen = signal(false);
  readonly available = signal(false);
  readonly liveCommand = signal('');
  readonly liveThink = signal('');

  private readonly role: 'host' | 'viewer' = isDebugWindow() ? 'viewer' : 'host';
  private channel: BroadcastChannel | null = null;
  private seq = 0;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private tauriEmit: ((payload: DebugEnvelope) => void) | null = null;
  private unlistenTauri: (() => void) | null = null;
  private receivedState = false;

  constructor() {
    this.available.set(isDebugWindow() || isDevMode());
    this.bindChannel();
    void this.bindTauri();
    if (this.role === 'viewer') this.startHello();
  }

  log(
    kind: DebugKind,
    title: string,
    detail?: unknown,
    extra?: { level?: DebugLevel; data?: Record<string, unknown> },
  ): void {
    if (this.role === 'viewer' || !this.available()) return;
    const event: DebugEvent = {
      id: `${Date.now().toString(36)}-${++this.seq}`,
      at: Date.now(),
      kind,
      level: extra?.level ?? (kind === 'error' ? 'error' : 'info'),
      title,
      detail: formatDebugDetail(detail),
      data: extra?.data,
    };
    this.append(event);
    if (kind === 'think') this.liveThink.set(title);
    if (kind === 'tool' || kind === 'command' || kind === 'mcp' || kind === 'copilot') {
      this.liveCommand.set(title);
    }
    if (kind === 'error') this.liveCommand.set(title);
    this.post({ type: 'event', event });
  }

  publishSnapshot(snapshot: DebugSnapshot): void {
    if (this.role === 'viewer' || !this.available()) return;
    this.snapshot.set(snapshot);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      const current = this.snapshot();
      if (current) this.post({ type: 'snapshot', snapshot: current });
    }, 120);
  }

  clear(): void {
    this.events.set([]);
    this.liveCommand.set('');
    this.liveThink.set('');
    this.post({ type: 'clear' });
  }

  async open(): Promise<void> {
    if (typeof window === 'undefined' || isDebugWindow()) return;
    this.available.set(true);
    if (isTauriDesktop()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('open_debug_window');
        return;
      } catch (error) {
        this.log('error', 'Could not open debug window', error);
      }
    }
    this.overlayOpen.set(true);
  }

  closeOverlay(): void {
    this.overlayOpen.set(false);
  }

  popOut(): void {
    if (typeof window === 'undefined') return;
    const url = `${window.location.origin}${window.location.pathname}?window=${WINDOW_QUERY}`;
    const popup = window.open(url, 'ava-debug', 'width=820,height=940,noopener');
    if (popup) this.overlayOpen.set(false);
  }

  shouldAutoOpenOverlay(): boolean {
    return isDevMode() && !isTauriDesktop() && !isDebugWindow();
  }

  private append(event: DebugEvent): void {
    this.events.update(list => {
      if (list.some(item => item.id === event.id)) return list;
      const next = [...list, event];
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    });
  }

  private bindChannel(): void {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = message => this.onEnvelope(message.data as DebugEnvelope);
    } catch {
      this.channel = null;
    }
  }

  private async bindTauri(): Promise<void> {
    if (!isTauriDesktop()) return;
    try {
      const { emit, listen } = await import('@tauri-apps/api/event');
      this.tauriEmit = payload => {
        void emit(TAURI_EVENT, payload);
      };
      this.unlistenTauri = await listen<DebugEnvelope>(TAURI_EVENT, event => {
        this.onEnvelope(event.payload);
      });
    } catch {
      this.tauriEmit = null;
    }
  }

  private startHello(): void {
    this.post({ type: 'hello' });
    let attempts = 0;
    this.helloTimer = setInterval(() => {
      attempts += 1;
      if (this.receivedState || attempts > 12) {
        if (this.helloTimer) clearInterval(this.helloTimer);
        this.helloTimer = null;
        return;
      }
      this.post({ type: 'hello' });
    }, 250);
  }

  private onEnvelope(message: DebugEnvelope): void {
    if (!message || typeof message !== 'object') return;
    if (this.role === 'host') {
      if (message.type === 'hello') this.sendState();
      if (message.type === 'clear') {
        this.events.set([]);
        this.liveCommand.set('');
        this.liveThink.set('');
      }
      return;
    }

    if (message.type === 'event') this.append(message.event);
    if (message.type === 'snapshot') this.snapshot.set(message.snapshot);
    if (message.type === 'state') {
      this.receivedState = true;
      this.events.set(message.events ?? []);
      this.snapshot.set(message.snapshot);
    }
    if (message.type === 'clear') {
      this.events.set([]);
      this.liveCommand.set('');
      this.liveThink.set('');
    }
  }

  private sendState(): void {
    this.post({
      type: 'state',
      events: this.events(),
      snapshot: this.snapshot(),
    });
  }

  private post(message: DebugEnvelope): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // ignore
    }
    try {
      this.tauriEmit?.(message);
    } catch {
      // ignore
    }
  }
}
