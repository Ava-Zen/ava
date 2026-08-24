export interface GrokInfo {
  path: string;
  version: string;
  grokHome: string;
}

export interface GrokUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  channel: string;
  error?: string | null;
}

export interface GrokAuthStatus {
  signedIn: boolean;
  message: string;
  email?: string | null;
  name?: string | null;
}

export interface RosterItem {
  sessionId: string;
  cwd: string;
  title: string;
  preview: string;
  color: string;
  shape: string;
  pinned: boolean;
  updatedAt: string;
  modelId?: string | null;
  unread: boolean;
  effort?: string | null;
}

export interface RosterSnapshot {
  rows: RosterItem[];
  liveIds: string[];
  runningIds: string[];
}

export interface TranscriptItem {
  kind: 'user' | 'agent' | 'thought' | 'work';
  text: string;
  title?: string | null;
  status?: string | null;
  eid?: string | null;
  pending?: boolean;
  toolCallId?: string | null;
}

export interface ReplayPage {
  items: TranscriptItem[];
  hasMore: boolean;
  cursor: number;
  turnComplete: boolean;
}

export interface SessionUpdate {
  sessionUpdate?: string | null;
  content?: unknown;
  title?: string | null;
  rawInput?: unknown;
  stopReason?: string | null;
  toolCallId?: string | null;
  status?: string | null;
  currentModeId?: string | null;
  availableCommands?: unknown;
  _meta?: Record<string, unknown> | null;
}

export interface AcpStreamEvent {
  sessionId: string;
  update: SessionUpdate;
  channel?: string | null;
  eid?: string | null;
}

export interface AgentRequestOption {
  optionId: string;
  name: string;
  description?: string | null;
}

export interface AgentQuestion {
  question: string;
  header?: string | null;
  multiSelect: boolean;
  options: AgentRequestOption[];
}

export interface AgentRequestEvent {
  requestId: unknown;
  sessionId: string;
  method: string;
  params: unknown;
  options: AgentRequestOption[];
  questions: AgentQuestion[];
}

export interface ProjectPrefs {
  lastProject: string;
  recentProjects: string[];
}

export type GrokPhase = 'boot' | 'setup' | 'signed-out' | 'ready';
export type TurnLife = 'idle' | 'sending' | 'live' | 'settled' | 'cancelled';
