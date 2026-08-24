import { Injectable, computed, inject, signal } from '@angular/core';
import { GardensService } from './gardens';
import { openExternal } from './mcp/mcp-http';
import { isTauriDesktop } from './updates';
import {
  addPendingUser,
  applySessionUpdate,
  isReplayChannel,
  isTurnComplete,
  spokenRecap,
} from './grok-cli/transcript';
import {
  AcpStreamEvent,
  AgentRequestEvent,
  GrokAuthStatus,
  GrokInfo,
  GrokPhase,
  GrokUpdateCheck,
  ProjectPrefs,
  RosterItem,
  RosterSnapshot,
  TranscriptItem,
  TurnLife,
} from './grok-cli/types';

export type {
  AgentRequestEvent,
  GrokAuthStatus,
  GrokInfo,
  GrokPhase,
  ProjectPrefs,
  RosterItem,
  TranscriptItem,
  TurnLife,
} from './grok-cli/types';

const DRAFT_ID = 'draft';

@Injectable({ providedIn: 'root' })
export class GrokCliService {
  private readonly gardens = inject(GardensService);
  private listening = false;
  private selection = 0;
  private eventIds = new Set<string>();

  readonly desktop = signal(isTauriDesktop());
  readonly phase = signal<GrokPhase>('boot');
  readonly grokInfo = signal<GrokInfo | null>(null);
  readonly auth = signal<GrokAuthStatus | null>(null);
  readonly update = signal<GrokUpdateCheck | null>(null);
  readonly installLog = signal('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly roster = signal<RosterItem[]>([]);
  readonly runningIds = signal<string[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly cwd = signal('');
  readonly items = signal<TranscriptItem[]>([]);
  readonly turn = signal<TurnLife>('idle');
  readonly hitl = signal<AgentRequestEvent | null>(null);
  readonly hydrating = signal(false);
  readonly prompt = signal('');
  readonly mode = signal('ask');
  readonly projects = signal<ProjectPrefs>({ lastProject: '', recentProjects: [] });

  readonly signedIn = computed(() => !!this.auth()?.signedIn);
  readonly working = computed(() => this.turn() === 'sending' || this.turn() === 'live');
  readonly activeRow = computed(() => {
    const id = this.activeId();
    return this.roster().find(row => row.sessionId === id) ?? null;
  });

  async boot(): Promise<void> {
    if (!this.desktop()) {
      this.phase.set('boot');
      return;
    }
    this.error.set('');
    await this.listen();
    try {
      const info = await invoke<GrokInfo>('which_grok');
      this.grokInfo.set(info);
    } catch {
      this.grokInfo.set(null);
      this.phase.set('setup');
      return;
    }
    try {
      const status = await invoke<GrokAuthStatus>('grok_auth_status');
      this.auth.set(status);
      if (!status.signedIn) {
        this.phase.set('signed-out');
        return;
      }
      this.phase.set('ready');
      await this.refreshRoster();
      this.projects.set(await invoke<ProjectPrefs>('grok_project_prefs'));
      this.mode.set((await invoke<string>('grok_default_mode')) || 'ask');
    } catch (err) {
      this.error.set(readError(err));
      this.phase.set('signed-out');
    }
  }

  async install(): Promise<void> {
    if (!this.desktop()) return;
    this.busy.set(true);
    this.installLog.set('Installing Grok Build…');
    this.error.set('');
    try {
      const info = await invoke<GrokInfo>('install_grok');
      this.grokInfo.set(info);
      await this.boot();
    } catch (err) {
      this.error.set(readError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async login(): Promise<void> {
    if (!this.desktop()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const status = await invoke<GrokAuthStatus>('grok_login');
      this.auth.set(status);
      if (status.signedIn) {
        this.phase.set('ready');
        await this.refreshRoster();
      }
    } catch (err) {
      this.error.set(readError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async cancelLogin(): Promise<void> {
    if (!this.desktop()) return;
    try {
      await invoke('grok_cancel_login');
    } catch {
      // ignore
    }
    this.busy.set(false);
  }

  async logout(): Promise<void> {
    if (!this.desktop()) return;
    this.busy.set(true);
    try {
      const status = await invoke<GrokAuthStatus>('grok_logout');
      this.auth.set(status);
      this.activeId.set(null);
      this.items.set([]);
      this.phase.set(status.signedIn ? 'ready' : 'signed-out');
    } catch (err) {
      this.error.set(readError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async refreshRoster(): Promise<void> {
    if (!this.desktop() || this.phase() !== 'ready') return;
    try {
      const snap = await invoke<RosterSnapshot>('list_roster');
      this.roster.set(snap.rows);
      this.runningIds.set(snap.runningIds);
    } catch (err) {
      this.error.set(readError(err));
    }
  }

  async pickFolder(): Promise<string | null> {
    if (!this.desktop()) return null;
    const start = this.cwd() || this.projects().lastProject || this.gardens.currentGarden()?.workspace || null;
    const path = await invoke<string | null>('grok_pick_folder', { cwd: start });
    if (path) {
      this.cwd.set(path);
      this.projects.set(await invoke<ProjectPrefs>('grok_remember_project', { path }));
    }
    return path;
  }

  async openSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.desktop()) return;
    const token = this.beginSelection(sessionId, cwd);
    this.hydrating.set(true);
    this.hitl.set(null);
    this.turn.set('idle');
    this.eventIds = new Set();
    try {
      const page = await invoke<import('./grok-cli/types').ReplayPage>('open_replay', {
        sessionId,
        cursor: null,
        markRead: true,
      });
      if (!this.isCurrent(token)) return;
      this.items.set(sanitizeReplay(page.items));
      await invoke('take_over_session', { sessionId, cwd });
      if (!this.isCurrent(token)) return;
      await invoke('grok_remember_session', { sessionId });
      this.mode.set((await invoke<string>('grok_session_mode', { sessionId })) || this.mode());
    } catch (err) {
      if (this.isCurrent(token)) this.error.set(readError(err));
    } finally {
      if (this.isCurrent(token)) this.hydrating.set(false);
    }
  }

  async startDraft(cwd?: string): Promise<void> {
    const folder = cwd?.trim() || this.cwd() || this.projects().lastProject || this.gardens.currentGarden()?.workspace || '';
    if (!folder) {
      const picked = await this.pickFolder();
      if (!picked) return;
      this.beginSelection(DRAFT_ID, picked);
      this.items.set([]);
      return;
    }
    this.beginSelection(DRAFT_ID, folder);
    this.items.set([]);
  }

  async send(text?: string): Promise<void> {
    if (!this.desktop()) return;
    const body = (text ?? this.prompt()).trim();
    if (!body) return;
    this.prompt.set('');
    this.error.set('');
    let sessionId = this.activeId();
    const cwd = this.cwd();
    try {
      if (!sessionId || sessionId === DRAFT_ID) {
        if (!cwd) {
          const picked = await this.pickFolder();
          if (!picked) return;
        }
        this.turn.set('sending');
        sessionId = await invoke<string>('new_session', { cwd: this.cwd(), mode: this.mode() });
        this.activeId.set(sessionId);
        await invoke('grok_remember_session', { sessionId });
      }
      this.items.update(items => addPendingUser(items, body));
      this.turn.set('sending');
      await invoke('send_prompt', { sessionId, text: body, sendNow: null, promptId: null });
      this.turn.set('live');
    } catch (err) {
      this.turn.set('idle');
      this.error.set(readError(err));
    }
  }

  async cancel(): Promise<void> {
    const sessionId = this.activeId();
    if (!sessionId || sessionId === DRAFT_ID) return;
    this.turn.set('cancelled');
    try {
      await invoke('cancel_turn', { sessionId, cancelTrigger: 'mouse' });
    } catch (err) {
      this.error.set(readError(err));
    }
  }

  async respondHitl(optionId: string | null): Promise<void> {
    const request = this.hitl();
    if (!request) return;
    this.hitl.set(null);
    try {
      await invoke('respond_agent_request', {
        requestId: request.requestId,
        optionId,
        answers: null,
        payload: null,
      });
    } catch (err) {
      this.error.set(readError(err));
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await invoke('delete_session', { sessionId });
      if (this.activeId() === sessionId) {
        this.activeId.set(null);
        this.items.set([]);
      }
      await this.refreshRoster();
    } catch (err) {
      this.error.set(readError(err));
    }
  }

  async setMode(mode: string): Promise<void> {
    this.mode.set(mode);
    const sessionId = this.activeId();
    try {
      await invoke('grok_set_default_mode', { mode });
      if (sessionId && sessionId !== DRAFT_ID) {
        await invoke('set_session_mode', { sessionId, mode });
      }
    } catch (err) {
      this.error.set(readError(err));
    }
  }

  recap(): string {
    return spokenRecap(this.items());
  }

  canTakeSpeech(): boolean {
    return this.desktop() && this.phase() === 'ready' && !!this.activeId();
  }

  private beginSelection(sessionId: string, cwd: string): number {
    this.selection += 1;
    this.activeId.set(sessionId);
    this.cwd.set(cwd);
    this.hitl.set(null);
    this.turn.set('idle');
    return this.selection;
  }

  private isCurrent(token: number): boolean {
    return token === this.selection;
  }

  private async listen(): Promise<void> {
    if (this.listening || !this.desktop()) return;
    this.listening = true;
    const { listen } = await import('@tauri-apps/api/event');
    await listen<string>('grok://install', event => {
      this.installLog.set(String(event.payload || ''));
    });
    await listen<{ url?: string }>('auth://login', event => {
      const url = event.payload?.url;
      if (url) void openExternal(url);
    });
    await listen<AcpStreamEvent>('acp://stream', event => {
      this.onStream(event.payload);
    });
    await listen<AgentRequestEvent>('acp://agent-request', event => {
      const payload = event.payload;
      if (payload?.sessionId && payload.sessionId === this.activeId()) {
        this.hitl.set(payload);
      }
    });
    await listen('acp://roster-changed', () => {
      void this.refreshRoster();
    });
    await listen<{ sessionId?: string; message?: string }>('acp://prompt-error', event => {
      if (event.payload?.sessionId && event.payload.sessionId !== this.activeId()) return;
      this.error.set(event.payload?.message || 'Grok could not finish that turn.');
      if (this.turn() !== 'cancelled') this.turn.set('settled');
    });
    await listen<{ sessionId?: string; toolCallId?: string }>('acp://interaction-resolved', event => {
      const current = this.hitl();
      if (!current) return;
      const params = current.params as { toolCallId?: string } | null;
      if (event.payload?.toolCallId && params?.toolCallId === event.payload.toolCallId) {
        this.hitl.set(null);
      }
    });
  }

  private onStream(event: AcpStreamEvent | undefined): void {
    if (!event?.sessionId || event.sessionId !== this.activeId()) return;
    if (event.eid && this.eventIds.has(event.eid)) return;
    if (event.eid) this.eventIds.add(event.eid);
    const replay = isReplayChannel(event.channel);
    if (isTurnComplete(event.update)) {
      if (!replay && this.turn() !== 'cancelled') this.turn.set('settled');
      return;
    }
    this.items.update(items => applySessionUpdate(items, event.update, event.eid));
    if (!replay && this.turn() === 'sending') this.turn.set('live');
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
  return 'Grok could not do that.';
}

function sanitizeReplay(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .map(item => {
      const kind = item.kind === 'user' || item.kind === 'agent' || item.kind === 'thought' || item.kind === 'work'
        ? item.kind
        : 'work';
      return {
        kind,
        text: item.text || '',
        title: item.title,
        status: item.status,
        eid: item.eid,
        toolCallId: item.toolCallId || null,
      };
    });
}
