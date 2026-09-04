import { Component, signal, computed, effect, ViewChild, ElementRef, inject, HostBinding, HostListener } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Settings } from './settings/settings';
import { MemoryExplorer } from './memory/memory';
import { GrokCliOverlay } from './grok-cli/grok-cli';
import { DebugConsole } from './debug/debug-console';
import { Onboarding } from './onboarding/onboarding';
import { Startup } from './startup/startup';
import { UpdateDialog } from './updates/update-dialog';
import { ConfirmDialog } from './confirm-dialog/confirm-dialog';
import { UpdateService } from './services/updates';
import { ConfirmDialogService } from './services/confirm-dialog';
import { GrokCliService } from './services/grok-cli';
import { DebugLogService } from './services/debug-log';
import { env, pipeline } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { GardensService, Garden } from './services/gardens';
import { ChatsService } from './services/chats';
import { TtsService } from './services/tts';
import { LlmService, ChatTurn, GeneratedImage } from './services/llm';
import {
  spokenImageSaveReply,
  wantsImage,
  wantsImageEdit,
  wantsPhotoHelp,
  wantsSaveImagesToDisk,
} from './services/llm/grok-chat-backend';
import { AgentsService, AgentTask, AgentToolDef } from './services/agents';
import { McpService, WEATHER_SERVER_ID } from './services/mcp';
import { OnboardingService } from './services/onboarding';
import { ThemeService } from './services/theme';
import { WindowChromeService } from './services/window-chrome';
import { ListenHotkeyService } from './services/listen-hotkey';
import { MemoryService, MemoryTurn } from './services/memory';
import { SchedulesService } from './services/schedules';
import { ResearchService } from './services/research';
import {
  extractGivenFullName,
  isAskingWhatSheRemembers,
  isExplicitRemember,
  personaGapFromLine,
  pickIdleNudge,
  presenceAside,
  presenceTitle,
  peopleAck,
  rememberAck,
} from './services/presence';
import { markdownToHtml, markdownToPlainText, splitIntoSpeechChunks } from './services/text-format';
import { XaiClient } from './services/xai/xai-client';
import { XaiAuthService } from './services/xai/xai-auth';
import {
  CopilotAuthService,
  inferCopilotAgent,
  isFileWorkRequest,
  isGithubWorkRequest,
  needsLocalFileAccess,
  shouldUseCopilot,
} from './services/copilot/copilot-auth';
import {
  AVA_CAPABILITIES_REPLY,
  extractProjectHint,
  isAskingCapabilities,
  isAskingForGrokWork,
  isGrokSessionMemory,
  isAskingForTime,
  isAskingToStopGrokTurn,
  isAskingToStopListening,
  isLeavingGrokWork,
  isAskingToSelfImprove,
  isAskingToResetSelfImprovements,
  extractSelfImproveTask,
  extractResearchTopic,
  isAskingAboutSchedules,
  isAskingToCancelSchedule,
  isAskingToResearchSelf,
  parseInsertRequest,
  parseScheduleRequest,
  buildInsertPrompt,
  type InsertRequest,
  type ParsedSchedule,
} from './intents';
import {
  SelfImproveService,
  buildSelfImproveFollowUp,
  buildSelfImprovePrompt,
  buildSelfImproveSetupSpeech,
} from './services/self-improve';
import { speakableLine } from './services/grok-cli/transcript';
import { ListenMode } from './services/tts';
import {
  isMessageTarget,
  isSameMessage,
  messageSwipeKey,
  nextMessageId,
  rubberbandSwipe,
  swipeCommitAction,
  swipeIntent,
} from './message-swipe';

type CopilotGateKind = 'signin' | 'workspace' | 'tools' | 'photo';

interface CopilotGate {
  kind: CopilotGateKind;
  prompt: string;
  status: 'open' | 'done' | 'dismissed';
}

interface Message {
  role: 'user' | 'ava';
  text: string;
  timestamp: Date;
  topicId?: string;
  id?: string;
  downloadId?: string;
  exportTaskId?: string;
  pending?: boolean;
  gate?: CopilotGate;
  /** Generation diagnostics shown in small text under Ava replies. */
  debug?: {
    model: string;
    durationMs: number;
  };
  /** Original user prompt, set on failed/empty replies so they can be retried. */
  retryFor?: string;
  /** Imagine images returned by Grok. */
  images?: GeneratedImage[];
  /** Memory path for a research report the user can open. */
  reportRel?: string;
  /** Spoken line that arrived through the local MCP voice server or Copilot. */
  via?: 'mcp' | 'copilot';
  /** False for Grok CLI session talk — keep it out of companion memory. */
  persist?: boolean;
}

interface AudioDownload {
  id: string;
  filename: string;
  url: string;
  blob: Blob;
  sizeBytes: number;
}

interface AudioExportTask {
  id: string;
  sourceName: string;
  status: 'running' | 'complete' | 'failed' | 'aborted';
  current: number;
  total: number;
}

interface PendingFile {
  id: string;
  name: string;
  sizeLabel: string;
  text: string;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

export function imageFileName(image: GeneratedImage, index = 0): string {
  const slug = (image.prompt || 'photo')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'photo';
  const stamp = Date.now().toString(36);
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `ava-${slug}${suffix}-${stamp}.jpg`;
}

export function joinPath(folder: string, file: string): string {
  const slash = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${slash}${file}`;
}

export async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(dataUrl)) {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error('Could not download that photo.');
    return new Uint8Array(await res.arrayBuffer());
  }
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  if (/^https?:\/\//i.test(dataUrl)) {
    const res = await fetch(dataUrl);
    if (!res.ok) throw new Error('Could not download that photo.');
    return res.blob();
  }
  const bytes = await dataUrlToBytes(dataUrl);
  const mime = dataUrl.match(/^data:([^;]+);/i)?.[1] || 'image/jpeg';
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy], { type: mime });
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && (error as { name?: string }).name === 'AbortError') return true;
  const message = String((error as { message?: string })?.message ?? error);
  return /aborted|The user aborted a request|cancelled by the user/i.test(message);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 10 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function composeManualPrompt(
  text: string,
  files: Array<{ name: string; text: string }>,
): string {
  const parts = files.map(file => `Use this file as context:\nFile: ${file.name}\n\n${file.text}`);
  const trimmed = text.trim();
  if (trimmed) parts.push(trimmed);
  return parts.join('\n\n');
}

function jitterMs(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to fallback
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return true;
  } catch {
    return false;
  }
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, Settings, MemoryExplorer, GrokCliOverlay, DebugConsole, Onboarding, Startup, UpdateDialog, ConfirmDialog],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  @HostBinding('class.orb-chrome')
  protected get orbChromeHost(): boolean {
    return this.chrome.active();
  }

  protected readonly title = signal('Ava');
  private readonly MAX_FILE_CHARS = 12000;
  private readonly TEXT_FILE_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'html', 'css', 'scss', 'xml', 'yml', 'yaml', 'log'
  ]);

  private readonly gardensService = inject(GardensService);
  private readonly chats = inject(ChatsService);
  private readonly tts = inject(TtsService);
  private readonly llm = inject(LlmService);
  private readonly agents = inject(AgentsService);
  private readonly mcp = inject(McpService);
  private readonly onboarding = inject(OnboardingService);
  private readonly memory = inject(MemoryService);
  private readonly theme = inject(ThemeService);
  private readonly chrome = inject(WindowChromeService);
  private readonly listenHotkey = inject(ListenHotkeyService);
  private readonly updates = inject(UpdateService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly grokCli = inject(GrokCliService);
  private readonly selfImprove = inject(SelfImproveService);
  private readonly debug = inject(DebugLogService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly xai = inject(XaiAuthService);
  private readonly copilotAuth = inject(CopilotAuthService);
  private readonly xaiClient = new XaiClient(this.xai);
  private readonly schedules = inject(SchedulesService);
  private readonly research = inject(ResearchService);
  private readonly announcedAgentTasks = new Set<string>();
  private pendingFullNameFor: 'research' | 'schedule' | null = null;
  private pendingResearchTopic: string | null = null;
  private scheduleBusy = false;

  @ViewChild('transcript') private transcriptEl?: ElementRef<HTMLDivElement>;
  @ViewChild('filePicker') private filePickerEl?: ElementRef<HTMLInputElement>;
  @ViewChild('imagePicker') private imagePickerEl?: ElementRef<HTMLInputElement>;
  @ViewChild('audioFilePicker') private audioFilePickerEl?: ElementRef<HTMLInputElement>;
  @ViewChild('manualInput') private manualInputEl?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('primaryActionShell') private primaryActionShellEl?: ElementRef<HTMLDivElement>;
  @ViewChild('settingsActionShell') private settingsActionShellEl?: ElementRef<HTMLDivElement>;
  @ViewChild('listenMenu') private listenMenuEl?: ElementRef<HTMLDivElement>;
  @ViewChild('workspaceShell') private workspaceShellEl?: ElementRef<HTMLDivElement>;
  @ViewChild('gardenShell') private gardenShellEl?: ElementRef<HTMLDivElement>;
  private photoStageEl?: ElementRef<HTMLElement>;
  private photoViewerWheelUnbind: (() => void) | null = null;
  private readonly viewerPointers = new Map<number, { x: number; y: number }>();
  private viewerDragLast = { x: 0, y: 0 };
  private viewerDidDrag = false;
  private pinchStartDist = 0;
  private pinchStartZoom = 1;
  @ViewChild('photoStage')
  protected set photoStage(el: ElementRef<HTMLElement> | undefined) {
    this.unbindPhotoViewerWheel();
    this.photoStageEl = el;
    if (el) this.bindPhotoViewerWheel(el.nativeElement);
  }

  // Gardens
  protected readonly gardens = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;
  protected readonly desktopHome = this.memory.desktop;
  protected readonly chromeDesktop = this.chrome.desktop;
  protected readonly orbChrome = this.chrome.active;
  protected readonly orbChromePref = this.chrome.compact;
  protected readonly alwaysOnTop = this.chrome.alwaysOnTop;
  protected showSettings = signal(false);
  protected showMemory = signal(false);
  protected showGrokCli = signal(false);
  protected readonly showDebugOverlay = this.debug.overlayOpen;
  protected readonly debugAvailable = this.debug.available;
  protected readonly grokCliDesktop = this.grokCli.desktop;
  protected readonly showStartup = signal(true);
  protected readonly showOnboarding = computed(() => !this.onboarding.completed());
  protected readonly userName = this.onboarding.userName;
  private readonly MOONSHINE_BASE_MODEL = 'onnx-community/moonshine-base-ONNX';
  private readonly MOONSHINE_TINY_MODEL = 'onnx-community/moonshine-tiny-ONNX';

  /** Reactive: the conversation card is shown while there is content or an open voice channel. */
  protected readonly chatStarted = computed(() => {
    if (this.messages().length > 0 || this.showGrokCli()) return true;
    // Push-to-talk must not open this panel on press: the layout jump cancels
    // the pointer and the release never commits audio.
    if (this.pushToTalk()) return false;
    return this.voiceEnabled() || this.isListening() || this.isModelLoading();
  });
  protected readonly showChatPanel = computed(() => this.chatStarted());
  protected readonly activeTopicLabel = computed(() => this.memory.activeTopic()?.title || 'Here');
  protected readonly presenceLine = computed(() => presenceTitle({
    listening: this.isListening(),
    thinking: this.isThinking(),
    speaking: this.status() === 'speaking',
    paused: this.isPaused(),
    name: this.userName(),
  }));
  protected readonly presenceWhisper = computed(() => {
    if (this.isListening() || this.isThinking() || this.status() === 'speaking') return '';
    const last = this.messages().at(-1)?.timestamp ?? null;
    const topic = this.memory.activeTopic();
    const topicTitle = topic && !isGrokSessionMemory(`${topic.title}\n${topic.notes}`)
      ? topic.title
      : null;
    return presenceAside({
      lastAt: last,
      topicTitle,
    });
  });

  /** Name of the currently selected text-to-speech voice. */
  protected readonly voiceName = computed(() => this.tts.selectedVoice().name);
  protected readonly voiceBackendInfo = computed(() => {
    if (this.tts.selectedVoiceId() === 'system') return 'System speechSynthesis';
    if (this.tts.selectedVoiceId() === 'grok') return `Grok Voice · ${this.tts.selectedGrokVoice().name}`;
    return this.kokoroLoadInfo() || 'Kokoro selected; loads on first use';
  });
  protected readonly manualInputEnabled = signal(false);
  protected readonly composerMenuOpen = signal(false);
  protected readonly gardenMenuOpen = signal(false);
  protected readonly gardenMenuError = signal('');
  protected readonly workspaceMenuOpen = signal(false);
  protected readonly workspaceDraftOpen = signal(false);
  protected readonly workspaceDraft = signal('');
  protected readonly pendingImages = signal<GeneratedImage[]>([]);
  protected readonly pendingFiles = signal<PendingFile[]>([]);
  protected readonly hasComposerAttachments = computed(
    () => this.pendingImages().length > 0 || this.pendingFiles().length > 0,
  );
  protected readonly viewerImage = signal<GeneratedImage | null>(null);
  protected readonly viewerZoom = signal(1);
  protected readonly viewerPanX = signal(0);
  protected readonly viewerPanY = signal(0);
  protected readonly viewerPanning = signal(false);
  protected readonly viewerInteracting = signal(false);
  protected readonly viewerZoomLabel = computed(() => `${Math.round(this.viewerZoom() * 100)}%`);
  protected readonly photoViewerTransform = computed(
    () => `translate(${this.viewerPanX()}px, ${this.viewerPanY()}px) scale(${this.viewerZoom()})`,
  );
  protected readonly photoZoomMin = 1;
  protected readonly photoZoomMax = 6;
  protected readonly copilotSignedIn = this.copilotAuth.signedIn;
  protected readonly copilotPending = this.copilotAuth.loginPending;
  protected readonly copilotDevice = this.copilotAuth.deviceLogin;
  protected readonly copilotError = this.copilotAuth.error;
  protected readonly currentChat = this.chats.currentChat;
  protected readonly chatsInGarden = this.chats.chatsInGarden;
  protected readonly currentWorkspace = computed(() => this.currentChat()?.workspace ?? '');
  protected readonly allowLocalTools = computed(() => this.currentChat()?.allowLocalTools === true);
  protected readonly recentWorkspaces = this.gardensService.recentWorkspaces;
  protected readonly workspaceLabel = computed(() =>
    this.chats.workspaceLabel(this.currentWorkspace())
  );
  /** Right-click quick-select menu for the conversation model. */
  protected readonly modelMenuOpen = signal(false);
  /** Right-click / long-press menu on the orb and composer mic. */
  protected readonly listenMenuOpen = signal(false);
  protected readonly listenMenuX = signal(0);
  protected readonly listenMenuY = signal(0);
  protected readonly conversationModels = this.llm.models;
  protected readonly selectedConversationModelId = computed(() => this.llm.selectedModel().id);
  protected readonly cloudExclusive = this.llm.isCloudExclusive;
  protected readonly manualPrompt = signal('');
  protected readonly composerNotice = signal('');
  protected readonly isGeneratingAudioFile = signal(false);
  protected readonly audioDownloads = signal<Record<string, AudioDownload>>({});
  protected readonly audioExportTasks = signal<Record<string, AudioExportTask>>({});
  protected readonly activeAudioPreviewId = signal<string | null>(null);
  protected readonly audioPreviewPaused = signal(false);
  protected readonly copiedMessageId = signal<string | null>(null);
  protected readonly swipeKey = signal<string | null>(null);
  protected readonly swipeDx = signal(0);
  protected readonly swipeSide = signal<'left' | 'right' | null>(null);
  protected readonly swipeArmedFlag = signal(false);
  protected readonly swipeSettling = signal(false);
  private messageSwipe: {
    key: string;
    message: Message;
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    armed: boolean;
    width: number;
    sheet: HTMLElement;
  } | null = null;
  private swipeTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly canSubmitManualPrompt = computed(() =>
    !this.isThinking() && (
      this.manualPrompt().trim().length > 0 ||
      this.pendingFiles().length > 0 ||
      this.pendingImages().length > 0
    )
  );
  protected readonly canAbortRequest = computed(() =>
    this.isThinking() ||
    this.status() === 'speaking' ||
    this.isGeneratingAudioFile()
  );
  protected readonly grokWorking = this.grokCli.working;
  protected readonly grokListenMode = signal<ListenMode>('push');
  protected readonly pushToTalk = computed(() =>
    this.showGrokCli() ? this.grokListenMode() === 'push' : this.tts.listenMode() === 'push',
  );
  protected readonly pushTalkHeld = signal(false);
  private pushTalkKeyCode: string | null = null;
  private listenMenuTimer: ReturnType<typeof setTimeout> | null = null;
  private listenMenuSuppressClick = false;
  private orbDrag: { x: number; y: number; moved: boolean } | null = null;

  protected readonly micTitle = computed(() => {
    const dragHint = this.orbChrome() ? ' · drag to move' : '';
    const listenKey = this.listenHotkey.key();
    const keyHint = listenKey === 'off' ? '' : ` or ${listenKey}`;
    if (this.pushToTalk()) {
      return this.isListening()
        ? 'Release to send'
        : `Hold Space, Right Ctrl${keyHint}, or the mic · right-click to switch mode` + dragHint;
    }
    return this.voiceEnabled()
      ? 'Stop listening · right-click to switch mode' + dragHint
      : 'Start speaking · right-click to switch mode' + dragHint;
  });
  protected readonly micAriaLabel = computed(() => {
    if (this.pushToTalk()) return this.isListening() ? 'Release to send' : 'Hold to talk';
    return this.voiceEnabled() ? 'Stop listening' : 'Start speaking with Ava';
  });
  private requestSeq = 0;
  private readonly startedAt = Date.now();
  private lastIdleNudgeAt = 0;
  private idleNudgesThisSession = 0;
  private idleAwaitingReply = false;
  private usedIdleKeys: string[] = [];
  private nextIdleAt = Date.now() + jitterMs(2 * 60_000, 6 * 60_000);
  private readonly MAX_IDLE_NUDGES = 4;
  protected readonly chatModelLoading = computed(() => this.llm.isLoading());
  protected readonly chatModelLoadStatus = computed(() => this.llm.downloadStatus());

  protected readonly activityBadgeLabel = computed(() => {
    if (this.isModelLoading()) return 'Loading speech';
    if (this.isKokoroLoading()) return 'Loading voice';
    if (this.chatModelLoading()) return this.chatModelLoadStatus() || 'Loading chat model… please wait';
    if (this.agents.isLoading()) return 'Loading agent';
    if (this.isGeneratingAudioFile()) return 'Generating audio';
    if (this.grokCli.working()) return 'Grok working';
    if (this.isThinking()) return 'Thinking';
    if (this.hasActiveAgents()) {
      const usingCopilot = this.agentTasks().some(
        t => t.engine === 'copilot' && (t.status === 'queued' || t.status === 'running'),
      );
      return usingCopilot ? 'Copilot working' : 'Agent working';
    }
    if (this.status() === 'speaking') return 'Speaking';
    if (this.status() === 'listening') return 'Listening';
    return this.llm.isCloudExclusive() ? 'Grok cloud' : 'Local first';
  });
  protected readonly activityBadgeBusy = computed(() => {
    const label = this.activityBadgeLabel();
    return label !== 'Local first' && label !== 'Grok cloud';
  });
  /** True while any local model is downloading or loading into memory. */
  protected readonly activityBadgeSpinning = computed(() =>
    this.isModelLoading() ||
    this.isKokoroLoading() ||
    this.chatModelLoading() ||
    this.agents.isLoading() ||
    this.isGeneratingAudioFile() ||
    this.grokCli.working()
  );
  private activeAudioExportController: AbortController | null = null;
  private audioPreviewPlayer: HTMLAudioElement | null = null;

  // Per-chat message storage
  private messagesByChat = signal<Record<string, Message[]>>({});
  private pendingCopilot: { prompt: string; chatId: string; allowOnce?: boolean } | null = null;
  private pendingPhotoEdit: { prompt: string; chatId: string } | null = null;
  private pendingImageSave: { prompt: string; chatId: string; images: GeneratedImage[] } | null = null;

  protected readonly messages = computed(() => {
    const chatId = this.chats.currentChatId() || 'default';
    return this.messagesByChat()[chatId] ?? [];
  });

  // Background agent tasks (Qwen) surfaced for the UI.
  protected readonly agentTasks = this.agents.tasks;
  protected readonly hasActiveAgents = this.agents.hasActiveTasks;
  protected readonly llmThinkingTrace = this.llm.thinkingTrace;

  constructor() {
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.configureTransformersRuntime();
    this.mcp.connectAll().catch(() => {});
    this.loadMessagesFromStorage();
    this.collapseToSingleConversation();
    void this.hydrateMemory();

    // Auto-scroll chat when new messages arrive
    effect(() => {
      this.messages(); // track changes
      this.scrollToBottom();
    });

    this.registerMcpTtsBridge();
    this.watchAgentCompletions();
    this.watchGrokTurns();
    this.watchDebugSnapshot();
    this.watchIdlePresence();
    this.watchSchedules();
    this.watchWindowChrome();
    this.watchListenHotkey();
    this.debug.log('system', 'Ava started', this.llm.selectedModel().name);
    if (this.onboarding.completed()) {
      this.updates.scheduleAutoCheck();
    }
  }

  private watchIdlePresence() {
    if (typeof window === 'undefined') return;
    window.setInterval(() => void this.maybeIdleNudge(), 20_000);
  }

  private async maybeIdleNudge() {
    if (this.idleAwaitingReply) return;
    if (this.idleNudgesThisSession >= this.MAX_IDLE_NUDGES) return;
    if (
      this.showOnboarding() ||
      this.showStartup() ||
      this.showSettings() ||
      this.showMemory() ||
      this.showGrokCli() ||
      this.showDebugOverlay() ||
      this.viewerImage() ||
      this.updates.dialogOpen() ||
      this.confirm.open()
    ) {
      return;
    }
    if (this.selfImprove.phase() !== 'idle' || this.grokCli.selfImproving()) return;
    if (this.status() !== 'idle' || this.isListening() || this.isThinking() || this.pushTalkHeld()) return;
    if (this.hasActiveAgents() || this.activityBadgeBusy() || this.scheduleBusy) return;
    if (this.manualPrompt().trim() || this.currentTranscript().trim()) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const now = Date.now();
    if (now < this.nextIdleAt) return;
    const lastMsg = this.messages().at(-1)?.timestamp?.getTime() ?? 0;
    const lastActivity = Math.max(this.startedAt, lastMsg, this.lastIdleNudgeAt);
    if (now - lastActivity < 2 * 60_000) return;

    const unfinished = [...this.agentTasks()].reverse().find(task =>
      (task.status === 'error' || task.status === 'queued') && !isGrokSessionMemory(task.prompt),
    );
    const grokTitles = new Set(
      this.grokCli.roster().map(row => row.title.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean),
    );
    const nudge = pickIdleNudge({
      identity: this.memory.identityNotes(),
      name: this.userName(),
      peopleCount: this.memory.people().filter(person => person.id !== 'ava' && person.id !== 'profile').length,
      topics: this.memory.topics()
        .filter(topic => {
          const title = topic.title.replace(/\s+/g, ' ').trim().toLowerCase();
          if (title && grokTitles.has(title)) return false;
          return !isGrokSessionMemory(`${topic.title}\n${topic.notes}\n${topic.description}`);
        })
        .map(topic => ({
          id: topic.id,
          title: topic.title,
          notes: topic.notes,
          updatedAt: topic.updatedAt,
        })),
      unfinishedPrompt: unfinished?.prompt ?? null,
      usedKeys: this.usedIdleKeys,
    });
    if (!nudge) return;

    this.usedIdleKeys = [...this.usedIdleKeys, nudge.key];
    this.lastIdleNudgeAt = now;
    this.idleAwaitingReply = true;
    this.nextIdleAt = now + jitterMs(5 * 60_000, 14 * 60_000);
    this.idleNudgesThisSession += 1;
    this.debug.log('memory', 'Idle nudge', nudge.key);

    const gardenId = this.currentGarden()?.id || this.threadId();
    const seq = this.beginRequest();
    await this.respond(gardenId, nudge.line, undefined, undefined, undefined, seq);
  }

  private heardUserForIdle() {
    this.idleAwaitingReply = false;
    this.nextIdleAt = Date.now() + jitterMs(5 * 60_000, 14 * 60_000);
  }

  private watchDebugSnapshot() {
    let lastStatus = '';
    effect(() => {
      const status = this.status();
      if (status !== lastStatus) {
        lastStatus = status;
        this.debug.log('status', status);
      }
      this.debug.publishSnapshot({
        status: this.status(),
        thinking: this.isThinking(),
        listening: this.isListening(),
        speaking: this.status() === 'speaking',
        transcript: this.currentTranscript(),
        thinkingTrace: this.llmThinkingTrace(),
        model: this.llm.activeModel()?.name ?? this.llm.selectedModel().name,
        intelligence: this.llm.intelligenceMode(),
        voice: this.voiceBackendInfo(),
        garden: this.currentGarden()?.name ?? '',
        workspace: this.currentWorkspace(),
        topic: this.memory.activeTopic()?.title ?? '',
        mcp: this.mcp.tools().map(tool => tool.name),
        agents: this.agentTasks().slice(-8).map(task => ({
          id: task.id,
          status: task.status,
          engine: task.engine,
          prompt: task.prompt,
          progress: task.progress,
        })),
        copilot: this.copilotAuth.signedIn(),
        grok: this.xai.signedIn(),
        at: Date.now(),
      });
    });
  }

  /** Speaks a short wrap-up when a background agent (local or Copilot) finishes. */
  private watchGrokTurns() {
    let lastTurn = this.grokCli.turn();
    let lastHitlId: unknown = null;
    effect(() => {
      if (!this.showGrokCli()) {
        lastTurn = this.grokCli.turn();
        lastHitlId = this.grokCli.hitl()?.requestId ?? null;
        return;
      }
      const turn = this.grokCli.turn();
      if (lastTurn !== 'settled' && turn === 'settled') {
        const recap = this.grokCli.recap();
        if (recap) {
          queueMicrotask(() => {
            if (!this.isThinking()) void this.speak(recap);
          });
        }
      }
      lastTurn = turn;

      const hitl = this.grokCli.hitl();
      const id = hitl?.requestId ?? null;
      if (hitl && id !== lastHitlId) {
        const question = speakableLine(hitl.questions[0]?.question || '') || 'Grok needs a decision.';
        queueMicrotask(() => void this.speak(question));
      }
      lastHitlId = id;
    });
  }

  private watchAgentCompletions() {
    effect(() => {
      const tasks = this.agentTasks();
      for (const task of tasks) {
        if (task.status !== 'done' && task.status !== 'error') continue;
        if (this.announcedAgentTasks.has(task.id)) continue;
        this.announcedAgentTasks.add(task.id);
        queueMicrotask(() => this.announceAgentResult(task));
      }
    });
  }

  private announceAgentResult(task: AgentTask) {
    const gardenId = task.chatId || this.threadId();
    if (!gardenId) return;

    if (task.status === 'error') {
      const spoken = task.error || 'The background agent could not finish.';
      this.addAvaNotice(gardenId, spoken, task.engine === 'copilot' ? 'copilot' : undefined);
      if (!this.isThinking()) void this.speak(spoken);
      return;
    }

    const result = (task.result || '').trim();
    if (!result) return;
    const via = task.engine === 'copilot' ? 'copilot' : undefined;
    this.addAvaNotice(gardenId, result, via);
    if (this.isThinking()) return;
    const spoken = markdownToPlainText(result);
    const preview = spoken.length > 420 ? spoken.slice(0, 400).trim() + '…' : spoken;
    void this.speak(preview);
  }

  private addAvaNotice(gardenId: string, text: string, via?: Message['via'], persist = true) {
    const chatId = this.chats.chats().some(chat => chat.id === gardenId) ? gardenId : this.threadId();
    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    currentMsgs.push({
      role: 'ava',
      id: nextMessageId(),
      text,
      timestamp: new Date(),
      via,
      persist,
    });
    this.setChatMessages(chatId, currentMsgs);
    this.scrollToBottom();
  }

  /**
   * Lets other local agents borrow Ava's voice through the MCP server hosted in
   * the Rust backend. Each `mcp-tts-request` carries text to speak; once
   * playback finishes we acknowledge the backend so the MCP call can return.
   */
  private async registerMcpTtsBridge() {
    if (typeof window === 'undefined') return;
    try {
      await listen<{ id: number; text: string; voice?: string }>('mcp-tts-request', async event => {
        const { id, text, voice } = event.payload;
        let ok = false;
        try {
          this.debug.log('command', 'MCP speak', text, { data: { voice } });
          this.applyMcpVoice(voice);
          this.recordMcpSpeech(text);
          await this.speak(text);
          ok = true;
        } catch (e) {
          console.warn('MCP TTS request failed', e);
        }
        try {
          await invoke('mcp_tts_complete', { id, ok });
        } catch {
          // backend not reachable (e.g. browser-only) — ignore
        }
      });
      await listen('mcp-tts-stop', () => {
        this.stopSpeaking();
      });
    } catch {
      // Tauri not available (plain browser) — MCP bridge stays inert.
    }
  }

  private recordMcpSpeech(text: string) {
    const spoken = text.trim();
    const chatId = this.threadId();
    if (!spoken || !chatId) return;

    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    currentMsgs.push({
      role: 'ava',
      id: nextMessageId(),
      text: spoken,
      timestamp: new Date(),
      via: 'mcp',
    });
    this.setChatMessages(chatId, currentMsgs);
    this.scrollToBottom();
  }

  private applyMcpVoice(voice?: string) {
    if (!voice) return;
    const id = voice.trim();
    if (!id) return;
    const grokIds = this.tts.grokVoiceCatalog().map(v => v.id.toLowerCase());
    if (grokIds.includes(id.toLowerCase()) || (this.xai.signedIn() && !id.includes('_'))) {
      if (this.xai.signedIn()) this.tts.setGrokVoice(id);
      return;
    }
    this.tts.setKokoroVoice(id);
  }

  protected async selectGarden(id: string) {
    if (id === this.gardensService.currentGardenId()) {
      this.gardenMenuOpen.set(false);
      return;
    }
    await this.gardensService.useGarden(id);
    this.gardenMenuOpen.set(false);
    this.gardenMenuError.set('');
    await this.afterGardenChange();
  }

  protected toggleGardenMenu(event?: Event) {
    event?.stopPropagation();
    this.gardenMenuOpen.update(open => !open);
    if (!this.gardenMenuOpen()) this.gardenMenuError.set('');
  }

  protected gardenHomeLabel(garden: Garden): string {
    return this.gardensService.homeLabel(garden);
  }

  protected async createGardenFromUi() {
    const result = await this.gardensService.createGardenFromFolder();
    if (!result.ok) {
      if (result.error) this.gardenMenuError.set(result.error);
      return;
    }
    this.gardenMenuOpen.set(false);
    this.gardenMenuError.set('');
    await this.afterGardenChange();
  }

  protected async onGardenChanged() {
    await this.afterGardenChange();
  }

  private async afterGardenChange() {
    const id = this.gardensService.currentGardenId();
    if (id) this.chats.ensureChatForGarden(id);
    this.currentTranscript.set('');
    await this.hydrateMemory();
  }

  private closeGardenMenuIfOutside(target: EventTarget | null) {
    if (!this.gardenMenuOpen()) return;
    const shell = this.gardenShellEl?.nativeElement;
    const node = target as Node | null;
    if (shell && node && !shell.contains(node)) {
      this.gardenMenuOpen.set(false);
      this.gardenMenuError.set('');
    }
  }

  protected selectChat(id: string) {
    this.chats.selectChat(id);
    this.pendingImages.set([]);
    this.pendingFiles.set([]);
    this.currentTranscript.set('');
    this.scrollToBottom();
  }

  protected startNewChat() {
    const gardenId = this.currentGarden()?.id;
    this.pendingCopilot = null;
    this.pendingPhotoEdit = null;
    this.pendingImageSave = null;
    this.pendingImages.set([]);
    this.pendingFiles.set([]);
    this.closePhotoViewer();
    this.chats.createChat(gardenId);
    this.currentTranscript.set('');
    this.manualPrompt.set('');
    this.composerNotice.set('');
  }

  protected closeChat(event: Event, id: string) {
    event.stopPropagation();
    const remaining = this.chatsInGarden();
    if (remaining.length <= 1) {
      this.resetCurrentConversation();
      return;
    }
    this.messagesByChat.update(all => {
      const copy = { ...all };
      delete copy[id];
      return copy;
    });
    this.chats.deleteChat(id);
    this.saveMessagesToStorage();
  }

  protected openSettings() {
    if (this.showOnboarding()) return;
    this.showMemory.set(false);
    this.showGrokCli.set(false);
    this.showSettings.set(true);
  }

  protected openMemory(rel = '') {
    if (this.showOnboarding()) return;
    this.showSettings.set(false);
    this.showGrokCli.set(false);
    this.memory.focusRel.set(rel);
    this.showMemory.set(true);
  }

  protected openMemoryAt(rel: string) {
    this.openMemory(rel);
  }

  protected closeMemory() {
    this.showMemory.set(false);
  }

  protected openGrokCli() {
    if (this.showOnboarding() || !this.grokCli.desktop()) return;
    this.showSettings.set(false);
    this.showMemory.set(false);
    this.showGrokCli.set(true);
    this.grokListenMode.set('push');
    void this.grokCli.openRoster();
  }

  protected closeGrokCli() {
    this.showGrokCli.set(false);
  }

  protected onGrokListenMode(mode: ListenMode) {
    this.grokListenMode.set(mode);
    if (mode === 'push' && (this.voiceEnabled() || this.isListening())) {
      this.stopListening();
    }
  }

  protected onGrokReadyToWork() {
    const line = 'What would you like us to work on together?';
    this.addAvaNotice(this.threadId(), line, undefined, false);
    void this.speak(line);
  }

  private async openGrokForWork(text: string, requestSeq: number) {
    this.showSettings.set(false);
    this.showMemory.set(false);
    this.showGrokCli.set(true);
    this.grokListenMode.set('push');
    const hint = extractProjectHint(text);
    const result = await this.grokCli.openForWork(hint);
    if (!this.isCurrentRequest(requestSeq)) return;
    const spoken =
      result === 'setup'
        ? 'I can install Grok so we can work in your project.'
        : result === 'signed-out'
          ? 'Sign in with Grok and we can start.'
          : result === 'folder'
            ? hint
              ? `Choose the folder for ${hint}.`
              : 'Choose the folder we should work in.'
            : 'What would you like us to work on together?';
    this.addAvaNotice(this.threadId(), spoken, undefined, false);
    this.isThinking.set(false);
    this.status.set('speaking');
    await this.speak(spoken);
    if (!this.isCurrentRequest(requestSeq)) return;
    if (this.status() === 'speaking') this.status.set('idle');
    this.resumeVoiceCaptureIfEnabled();
  }

  private async startSelfImprove(text: string, requestSeq: number, existingUserMessage?: Message) {
    const gardenId = this.currentGarden()?.id;
    if (gardenId) {
      if (existingUserMessage) this.updateMessageText(gardenId, existingUserMessage, text);
      else this.addUserMessage(gardenId, text);
    }

    this.status.set('thinking');
    this.isThinking.set(true);

    if (!this.grokCli.desktop()) {
      await this.respond(
        this.threadId(),
        'I can only change myself in the desktop app.',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }

    const status = await this.selfImprove.refresh();
    await this.grokCli.boot();
    const grokPhase = this.grokCli.phase();
    const grokReady = grokPhase === 'ready';
    const toolsReady = !status || status.ready;
    if (!grokReady || !toolsReady) {
      const firstTime = this.selfImprove.consumeFirstAsk();
      this.selfImprove.waitingOnSetup.set(true);
      this.showMemory.set(false);
      if (!grokReady) {
        this.showSettings.set(false);
        this.showGrokCli.set(true);
        this.grokListenMode.set('push');
      } else {
        this.showGrokCli.set(false);
        this.showSettings.set(true);
      }
      const spoken = buildSelfImproveSetupSpeech({ grokPhase, status, firstTime });
      await this.respond(this.threadId(), spoken, undefined, undefined, undefined, requestSeq);
      return;
    }

    try {
      const ensured = await this.selfImprove.ensureSource();
      const task = extractSelfImproveTask(text);
      this.selfImprove.waitingOnSetup.set(false);
      this.showSettings.set(false);
      this.showMemory.set(false);
      this.showGrokCli.set(true);
      this.grokListenMode.set('push');

      if (this.grokCli.selfImproving() && this.grokCli.canTakeSpeech()) {
        await this.selfImprove.arm();
        await this.grokCli.send(buildSelfImproveFollowUp(task));
      } else {
        await this.selfImprove.arm();
        const result = await this.grokCli.startSelfImprove(ensured.path, buildSelfImprovePrompt(task));
        if (!this.isCurrentRequest(requestSeq)) return;
        if (result === 'setup' || result === 'signed-out') {
          const firstTime = this.selfImprove.consumeFirstAsk();
          this.selfImprove.waitingOnSetup.set(true);
          const spoken = buildSelfImproveSetupSpeech({
            grokPhase: result,
            status,
            firstTime,
          });
          await this.respond(this.threadId(), spoken, undefined, undefined, undefined, requestSeq);
          return;
        }
      }
    } catch (err) {
      const spoken = err instanceof Error && err.message.trim() ? err.message : 'I could not start changing myself.';
      await this.respond(this.threadId(), spoken, undefined, undefined, undefined, requestSeq);
      return;
    }

    const spoken = 'I will change myself, make sure I still compile, then come back.';
    this.addAvaNotice(this.threadId(), spoken);
    this.isThinking.set(false);
    this.status.set('speaking');
    await this.speak(spoken);
    if (!this.isCurrentRequest(requestSeq)) return;
    if (this.status() === 'speaking') this.status.set('idle');
    this.resumeVoiceCaptureIfEnabled();
  }

  private async resetSelfImprovements(text: string, requestSeq: number, existingUserMessage?: Message) {
    const gardenId = this.currentGarden()?.id;
    if (gardenId) {
      if (existingUserMessage) this.updateMessageText(gardenId, existingUserMessage, text);
      else this.addUserMessage(gardenId, text);
    }

    this.status.set('thinking');
    this.isThinking.set(true);

    if (!this.grokCli.desktop()) {
      await this.respond(
        this.threadId(),
        'I can only undo that in the desktop app.',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }

    const ok = await this.confirm.ask({
      title: 'Undo self-improvements?',
      message: 'This restores the original Ava and forgets those source changes.',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) {
      await this.respond(this.threadId(), 'Alright. I will keep this version.', undefined, undefined, undefined, requestSeq);
      return;
    }

    try {
      await this.selfImprove.reset();
    } catch (err) {
      const spoken = err instanceof Error && err.message.trim() ? err.message : 'I could not restore the original.';
      await this.respond(this.threadId(), spoken, undefined, undefined, undefined, requestSeq);
      return;
    }

    const spoken = 'I am going back to the original. I will be right back.';
    this.addAvaNotice(this.threadId(), spoken);
    this.isThinking.set(false);
    this.status.set('speaking');
    await this.speak(spoken);
    if (!this.isCurrentRequest(requestSeq)) return;
    if (this.status() === 'speaking') this.status.set('idle');
    this.resumeVoiceCaptureIfEnabled();
  }

  protected openDebugConsole() {
    this.showSettings.set(false);
    void this.debug.open();
  }

  protected closeDebugOverlay() {
    this.debug.closeOverlay();
  }

  private cleanLoadLabel(label: string): string {
    return label
      .replace(/^loading\s+/i, 'Loading ')
      .replace(/[.…]+$/g, '')
      .trim();
  }

  /** Global spacebar toggles listening, unless the user is typing or a dialog is open. */
  @HostListener('document:keydown', ['$event'])
  protected onGlobalKeydown(event: KeyboardEvent) {
    if (this.debugAvailable() && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      if (this.showDebugOverlay()) this.debug.closeOverlay();
      else void this.debug.open();
      return;
    }

    if (this.viewerImage()) {
      if (event.key === 'Escape') {
        this.closePhotoViewer();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.nudgePhotoViewerZoom(1);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        this.nudgePhotoViewerZoom(-1);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        this.resetPhotoViewerZoom();
        return;
      }
    }

    if (event.key === 'Escape' && this.showMemory()) {
      this.closeMemory();
      return;
    }

    if (event.key === 'Escape' && this.confirm.open()) {
      this.confirm.cancel();
      return;
    }

    if (event.key === 'Escape' && this.updates.dialogOpen()) {
      this.updates.later();
      return;
    }

    if (event.key === 'Escape' && (this.composerMenuOpen() || this.modelMenuOpen() || this.workspaceMenuOpen() || this.gardenMenuOpen() || this.listenMenuOpen())) {
      this.composerMenuOpen.set(false);
      this.modelMenuOpen.set(false);
      this.workspaceMenuOpen.set(false);
      this.workspaceDraftOpen.set(false);
      this.gardenMenuOpen.set(false);
      this.gardenMenuError.set('');
      this.closeListenMenu();
      return;
    }

    if (event.key === 'Escape' && this.showDebugOverlay()) {
      this.debug.closeOverlay();
      return;
    }

    if (event.key === 'Escape' && this.showGrokCli()) {
      if (this.isListening() || this.voiceEnabled() || this.pushTalkHeld()) {
        this.stopListening();
        return;
      }
      if (this.grokCli.working()) {
        this.stopGrokTurn();
        return;
      }
      return;
    }

    if (event.repeat) return;
    if (this.showStartup() || this.showSettings() || this.showMemory() || this.showDebugOverlay() || this.showOnboarding() || this.viewerImage() || this.updates.dialogOpen() || this.confirm.open()) return;

    if (event.code === 'ControlRight') {
      if (!this.pushToTalk()) return;
      event.preventDefault();
      void this.beginPushTalk('ControlRight');
      return;
    }

    if (event.code !== 'Space') return;
    if (this.isTypingTarget(event.target)) return;

    event.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (this.pushToTalk()) {
      void this.beginPushTalk('Space');
      return;
    }
    this.toggleVoice();
  }

  @HostListener('document:keyup', ['$event'])
  protected onGlobalKeyup(event: KeyboardEvent) {
    if ((event.code !== 'Space' && event.code !== 'ControlRight') || !this.pushToTalk() || !this.pushTalkHeld()) return;
    if (this.pushTalkKeyCode && this.pushTalkKeyCode !== event.code) return;
    event.preventDefault();
    this.endPushTalk();
  }

  @HostListener('document:pointerup', ['$event'])
  @HostListener('document:pointercancel', ['$event'])
  protected onDocumentPointerEnd(event: PointerEvent) {
    this.clearListenMenuLongPress();
    if (!this.pushToTalk() || !this.pushTalkHeld()) return;
    if (event.type === 'pointerup' && event.button !== 0) return;
    this.endPushTalk();
  }

  @HostListener('window:blur')
  protected onWindowBlur() {
    if (this.pushTalkHeld()) this.endPushTalk();
  }

  @HostListener('document:mousedown', ['$event'])
  protected onDocumentMouseDown(event: MouseEvent) {
    this.closeComposerMenuIfOutside(event.target);
    this.closeModelMenuIfOutside(event.target);
    this.closeWorkspaceMenuIfOutside(event.target);
    this.closeGardenMenuIfOutside(event.target);
    this.closeListenMenuIfOutside(event.target);
  }

  @HostListener('document:touchstart', ['$event'])
  protected onDocumentTouchStart(event: TouchEvent) {
    this.closeComposerMenuIfOutside(event.target);
    this.closeModelMenuIfOutside(event.target);
    this.closeWorkspaceMenuIfOutside(event.target);
    this.closeGardenMenuIfOutside(event.target);
    this.closeListenMenuIfOutside(event.target);
  }

  /** Right-clicking the Settings button opens the model quick-select menu. */
  protected onSettingsContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.modelMenuOpen.update(open => !open);
  }

  protected quickSelectModel(id: string) {
    this.modelMenuOpen.set(false);
    if (id === this.selectedConversationModelId()) return;
    this.llm.setModel(id);
  }

  protected closeSettings() {
    this.showSettings.set(false);
  }

  protected onStartupFinished() {
    this.showStartup.set(false);
    if (this.debug.shouldAutoOpen() && this.onboarding.completed()) void this.debug.open();
  }

  protected playAvaFace(event: Event): void {
    const video = event.target as HTMLVideoElement | null;
    if (!video) return;
    video.muted = true;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      video.pause();
      return;
    }
    void video.play().catch(() => {});
  }

  protected onOnboardingCompleted() {
    this.showSettings.set(false);
    void this.hydrateMemory();
    this.updates.scheduleAutoCheck(1200);
    if (this.debug.shouldAutoOpen()) void this.debug.open();
  }

  protected async onResetCache() {
    this.closeSettings();
    this.stopSpeaking();
    this.disableVoiceChannel();
    this.stopAudioPreview();
    this.stopCurrentAudio();
    this.xai.cancelLogin();
    this.xai.logout();
    this.copilotAuth.cancelLogin();
    this.copilotAuth.logout();
    this.llm.setIntelligenceMode('local');
    this.agents.setRuntime('local');

    await this.clearBrowserDatabases();
    await this.clearBrowserCaches();

    try {
      await invoke('reset_app_cache');
    } catch (e) {
      console.warn('Native cache reset failed', e);
    }

    const persistKeys = [
      'ava-xai-auth',
      'ava-intelligence-mode',
      'ava-llm-model',
      'ava-grok-reasoning',
      'ava-llm-uncensored',
      'ava-tts-config',
      'ava-listen-mode',
      'ava-agent-model',
      'ava-agent-runtime',
      'ava-copilot-auth',
      'ava-copilot-workspace',
      'ava-copilot-allow-writes',
      'ava-copilot-model',
      'ava-workspace-recents',
      'ava-chats',
      'ava-current-chat',
      'ava-messages-by-chat',
      'ava-home-root',
      'ava-okf-fs',
      'ava-theme',
      'ava-window-chrome',
      'ava-debug-window',
      'ava-listen-hotkey',
      'ava-onboarding-complete',
      'ava-user-profile',
      'ava-messages-by-garden',
    ];
    try {
      for (const key of persistKeys) localStorage.removeItem(key);
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }

    window.location.reload();
  }

  protected toggleComposerMenu() {
    this.composerMenuOpen.update(open => !open);
  }

  protected openComposerMenu(event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.composerMenuOpen.set(true);
  }

  protected onPrimaryActionClick() {
    if (this.consumeListenMenuClick()) return;
    this.composerMenuOpen.set(false);

    if (this.manualInputEnabled()) {
      void this.submitManualPrompt();
      return;
    }

    if (this.pushToTalk()) return;
    void this.toggleVoice();
  }

  protected onOrbClick(event: Event) {
    if (this.consumeListenMenuClick()) {
      event.preventDefault();
      return;
    }
    if (this.pushToTalk()) {
      event.preventDefault();
      return;
    }
    void this.toggleVoice();
  }

  protected onOrbPointerMove(event: PointerEvent) {
    if (!this.orbChrome() || !this.orbDrag || this.orbDrag.moved || event.buttons === 0) return;
    const dx = event.screenX - this.orbDrag.x;
    const dy = event.screenY - this.orbDrag.y;
    if (dx * dx + dy * dy < 36) return;
    this.orbDrag.moved = true;
    this.clearListenMenuLongPress();
    this.listenMenuSuppressClick = true;
    if (this.pushTalkHeld()) this.endPushTalk();
    void this.chrome.startDragging();
  }

  protected onStopListeningClick(event: Event) {
    if (this.consumeListenMenuClick()) {
      event.preventDefault();
      return;
    }
    this.stopListening();
  }

  protected onMicContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    // Touch long-press also fires contextmenu; don't steal an in-progress hold-to-talk.
    if (this.pushToTalk() && this.pushTalkHeld() && event.button !== 2) return;
    if (this.pushTalkHeld()) this.endPushTalk();
    if (this.listenMenuOpen()) {
      this.closeListenMenu();
      return;
    }
    void this.showListenMenuAt(event.clientX, event.clientY);
  }

  private rememberInsertTarget() {
    if (!this.chrome.desktop) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('remember_insert_target'))
      .catch(() => undefined);
  }

  protected onMicPointerDown(event: PointerEvent) {
    this.rememberInsertTarget();
    if (this.orbChrome() && event.button === 0) {
      this.orbDrag = { x: event.screenX, y: event.screenY, moved: false };
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    }
    this.armListenMenuLongPress(event);
    this.onPushTalkPointerDown(event);
  }

  protected onMicPointerUp(event: PointerEvent) {
    this.clearListenMenuLongPress();
    this.onPushTalkPointerUp(event);
    this.orbDrag = null;
  }

  protected onPushTalkPointerDown(event: PointerEvent) {
    if (!this.pushToTalk() || event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    void this.beginPushTalk();
  }

  protected onPushTalkPointerUp(event: PointerEvent) {
    if (!this.pushToTalk() || !this.pushTalkHeld()) return;
    event.preventDefault();
    this.endPushTalk();
  }

  protected setListenModeFromMenu(mode: ListenMode) {
    this.closeListenMenu();
    if (this.showGrokCli()) {
      this.onGrokListenMode(mode);
      return;
    }
    if (this.tts.listenMode() === mode) return;
    this.tts.setListenMode(mode);
    if (mode === 'push' && (this.voiceEnabled() || this.isListening())) {
      this.stopListening();
    }
  }

  protected toggleAlwaysOnTopFromMenu() {
    void this.chrome.setAlwaysOnTop(!this.alwaysOnTop());
  }

  protected toggleOrbChromeFromMenu() {
    const next = !this.chrome.compact();
    this.closeListenMenu();
    void this.chrome.setCompact(next);
  }

  protected openSettingsFromOrbMenu() {
    this.closeListenMenu();
    this.openSettings();
  }

  protected toggleManualInput() {
    this.setManualInputMode(!this.manualInputEnabled());
  }

  protected setManualInputMode(enabled: boolean) {
    if (enabled && this.voiceEnabled()) {
      this.disableVoiceChannel();
    }

    this.manualInputEnabled.set(enabled);
    this.composerMenuOpen.set(false);
    if (!enabled) {
      this.composerNotice.set('');
      return;
    }

    setTimeout(() => {
      const el = this.manualInputEl?.nativeElement;
      if (!el) return;
      el.focus();
      this.resizeManualInput();
    }, 0);
  }

  protected onAddButtonClick(event: Event) {
    event.stopPropagation();
    this.toggleComposerMenu();
  }

  protected onManualPromptInput(event: Event) {
    const target = event.target as HTMLTextAreaElement | null;
    this.manualPrompt.set(target?.value ?? '');
    this.resizeManualInput();
  }

  protected onManualPromptKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.setManualInputMode(false);
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey) return;

    event.preventDefault();
    this.submitManualPrompt();
  }

  protected async submitManualPrompt() {
    if (this.isThinking()) return;

    const files = this.takePendingFiles();
    const text = composeManualPrompt(this.manualPrompt(), files)
      || (this.pendingImages().length ? 'Look at this photo.' : '');
    if (!text) return;

    this.manualPrompt.set('');
    this.composerNotice.set('');
    this.resizeManualInput();
    await this.handleUserSpeech(text);
  }

  private resizeManualInput() {
    const el = this.manualInputEl?.nativeElement;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 152)}px`;
  }

  protected openFilePicker() {
    this.setManualInputMode(true);
    this.filePickerEl?.nativeElement.click();
  }

  protected openImagePicker() {
    this.setManualInputMode(true);
    this.composerMenuOpen.set(false);
    this.imagePickerEl?.nativeElement.click();
  }

  protected pickPhotoFromChat() {
    this.imagePickerEl?.nativeElement.click();
  }

  protected openPhotoViewer(image: GeneratedImage) {
    this.resetPhotoViewerZoom();
    this.viewerImage.set(image);
  }

  protected closePhotoViewer() {
    this.unbindPhotoViewerWheel();
    this.viewerPointers.clear();
    this.viewerPanning.set(false);
    this.viewerInteracting.set(false);
    this.viewerDidDrag = false;
    this.viewerImage.set(null);
    this.resetPhotoViewerZoom();
  }

  protected resetPhotoViewerZoom() {
    this.viewerZoom.set(1);
    this.viewerPanX.set(0);
    this.viewerPanY.set(0);
  }

  protected nudgePhotoViewerZoom(direction: 1 | -1) {
    const el = this.photoStageEl?.nativeElement;
    const rect = el?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    this.zoomPhotoViewerAt(x, y, this.viewerZoom() * (direction > 0 ? 1.25 : 0.8));
  }

  protected onPhotoViewerBackdrop() {
    if (this.viewerDidDrag) {
      this.viewerDidDrag = false;
      return;
    }
    if (this.viewerZoom() > 1) {
      this.resetPhotoViewerZoom();
      return;
    }
    this.closePhotoViewer();
  }

  protected onPhotoViewerStageClick(event: MouseEvent) {
    event.stopPropagation();
    if (this.viewerDidDrag) {
      this.viewerDidDrag = false;
      return;
    }
    if ((event.target as HTMLElement | null)?.tagName === 'IMG') return;
    if (this.viewerZoom() > 1) {
      this.resetPhotoViewerZoom();
      return;
    }
    this.closePhotoViewer();
  }

  protected onPhotoViewerDoubleClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.viewerZoom() > 1) {
      this.resetPhotoViewerZoom();
      return;
    }
    this.zoomPhotoViewerAt(event.clientX, event.clientY, 2.5);
  }

  protected onPhotoViewerPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    this.viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (this.viewerPointers.size === 2) {
      const [a, b] = [...this.viewerPointers.values()];
      this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchStartZoom = this.viewerZoom();
      this.viewerPanning.set(false);
      return;
    }
    this.viewerDragLast = { x: event.clientX, y: event.clientY };
    this.viewerDidDrag = false;
    this.viewerInteracting.set(true);
    this.viewerPanning.set(this.viewerZoom() > 1);
  }

  protected onPhotoViewerPointerMove(event: PointerEvent) {
    if (!this.viewerPointers.has(event.pointerId)) return;
    this.viewerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.viewerPointers.size === 2 && this.pinchStartDist > 0) {
      const [a, b] = [...this.viewerPointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      this.zoomPhotoViewerAt(
        (a.x + b.x) / 2,
        (a.y + b.y) / 2,
        this.pinchStartZoom * (dist / this.pinchStartDist),
      );
      this.viewerDidDrag = true;
      return;
    }
    if (!this.viewerPanning()) return;
    const dx = event.clientX - this.viewerDragLast.x;
    const dy = event.clientY - this.viewerDragLast.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.viewerDidDrag = true;
    this.viewerPanX.update(x => x + dx);
    this.viewerPanY.update(y => y + dy);
    this.viewerDragLast = { x: event.clientX, y: event.clientY };
  }

  protected onPhotoViewerPointerUp(event: PointerEvent) {
    this.viewerPointers.delete(event.pointerId);
    if (this.viewerPointers.size < 2) this.pinchStartDist = 0;
    if (this.viewerPointers.size === 0) {
      this.viewerPanning.set(false);
      this.viewerInteracting.set(false);
    }
  }

  private zoomPhotoViewerAt(clientX: number, clientY: number, nextScale: number) {
    const prev = this.viewerZoom();
    const scale = Math.min(this.photoZoomMax, Math.max(this.photoZoomMin, nextScale));
    if (scale === prev) {
      if (scale <= this.photoZoomMin) {
        this.viewerPanX.set(0);
        this.viewerPanY.set(0);
      }
      return;
    }
    const el = this.photoStageEl?.nativeElement;
    if (el) {
      const rect = el.getBoundingClientRect();
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      const ratio = scale / prev;
      this.viewerPanX.update(x => cx - (cx - x) * ratio);
      this.viewerPanY.update(y => cy - (cy - y) * ratio);
    }
    this.viewerZoom.set(scale);
    if (scale <= this.photoZoomMin) {
      this.viewerPanX.set(0);
      this.viewerPanY.set(0);
    }
  }

  private bindPhotoViewerWheel(el: HTMLElement) {
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      this.zoomPhotoViewerAt(event.clientX, event.clientY, this.viewerZoom() * Math.exp(-delta * 0.0016));
    };
    el.addEventListener('wheel', handler, { passive: false });
    this.photoViewerWheelUnbind = () => el.removeEventListener('wheel', handler);
  }

  private unbindPhotoViewerWheel() {
    this.photoViewerWheelUnbind?.();
    this.photoViewerWheelUnbind = null;
  }

  protected removePendingImage(dataUrl: string) {
    this.pendingImages.update(list => list.filter(image => image.dataUrl !== dataUrl));
  }

  protected removePendingFile(id: string) {
    this.pendingFiles.update(list => list.filter(file => file.id !== id));
  }

  private takePendingFiles(): PendingFile[] {
    const files = this.pendingFiles();
    if (files.length) this.pendingFiles.set([]);
    return files;
  }

  private takePendingImages(): GeneratedImage[] {
    const images = this.pendingImages();
    if (images.length) this.pendingImages.set([]);
    return images;
  }

  private lastChatImage(): GeneratedImage | undefined {
    const msgs = this.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const image = msgs[i].images?.[0];
      if (image?.dataUrl) return image;
    }
    return undefined;
  }

  protected async onImagesSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (!files.length) return;

    const loaded: GeneratedImage[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        loaded.push({
          dataUrl: await readFileAsDataUrl(file),
          prompt: file.name,
        });
      } catch {
        this.composerNotice.set(`Could not read ${file.name}.`);
      }
    }
    if (!loaded.length) {
      this.composerNotice.set('Choose a JPG, PNG, or similar photo.');
      return;
    }
    const pendingEdit = this.pendingPhotoEdit;
    if (pendingEdit) {
      this.pendingPhotoEdit = null;
      this.closeOpenGates(pendingEdit.chatId, 'done');
      this.attachImagesToLastUser(pendingEdit.chatId, loaded);
      const seq = this.beginRequest();
      this.status.set('thinking');
      this.isThinking.set(true);
      await this.handleImagineEdit(pendingEdit.chatId, pendingEdit.prompt, loaded, seq);
      return;
    }

    this.pendingImages.update(list => [...list, ...loaded].slice(0, 3));
  }

  private attachImagesToLastUser(chatId: string, images: GeneratedImage[]) {
    const msgs = this.messagesByChat()[chatId] || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'user') continue;
      const next = [...msgs];
      next[i] = { ...next[i], images: [...(next[i].images || []), ...images] };
      this.setChatMessages(chatId, next);
      return;
    }
  }

  private async handleImagineEdit(
    gardenId: string,
    text: string,
    attached: GeneratedImage[],
    requestSeq = this.requestSeq,
  ) {
    const source = attached.length ? attached : this.lastChatImage() ? [this.lastChatImage()!] : [];
    if (!source.length) {
      await this.handleLlmReply(gardenId, text, requestSeq);
      return;
    }
    if (!this.xai.signedIn()) {
      await this.respond(gardenId, 'Sign in with Grok in Settings and I can edit that photo with Imagine.', undefined, undefined, undefined, requestSeq);
      return;
    }

    this.status.set('speaking');
    this.speak('I will send that photo to Imagine.');

    try {
      const startedAt = performance.now();
      const result = await this.llm.generate(text, this.buildChatHistory(gardenId), source);
      if (!this.isCurrentRequest(requestSeq)) return;
      const debug: Message['debug'] = {
        model: 'Grok Imagine',
        durationMs: performance.now() - startedAt,
      };
      await this.respond(
        gardenId,
        result.text.trim() || 'I updated that photo for you.',
        debug,
        undefined,
        result.images,
        requestSeq,
      );
    } catch (e) {
      if (!this.isCurrentRequest(requestSeq) || isAbortError(e)) return;
      console.error('Imagine edit failed', e);
      const friendly = this.llm.friendlyError(e);
      await this.respond(gardenId, friendly ?? 'I could not edit that photo just now.', undefined, text, undefined, requestSeq);
    }
  }

  private async handleImagineGenerate(chatId: string, text: string, requestSeq = this.requestSeq) {
    if (!this.xai.signedIn()) {
      await this.respond(chatId, 'Sign in with Grok in Settings and I can make that photo with Imagine.', undefined, undefined, undefined, requestSeq);
      return;
    }

    this.status.set('speaking');
    this.speak(this.pickThinkingFiller());

    try {
      const startedAt = performance.now();
      const result = await this.llm.generate(text, this.buildChatHistory(chatId));
      if (!this.isCurrentRequest(requestSeq)) return;
      const images = result.images ?? [];
      const debug: Message['debug'] = {
        model: 'Grok Imagine',
        durationMs: performance.now() - startedAt,
      };
      const spoken = result.text.trim() || (images.length > 1 ? 'I made those for you.' : 'I made that for you.');

      if (wantsSaveImagesToDisk(text) && images.length) {
        if (!this.currentWorkspace()) {
          this.pendingImageSave = { prompt: text, chatId, images };
          await this.respond(chatId, spoken, debug, undefined, images, requestSeq);
          this.addGateMessage(
            chatId,
            'workspace',
            text,
            'Choose a folder for this chat and I will save the photos there.',
          );
          void this.speak('Choose a folder and I will save the photos there.');
          return;
        }
        const saved = await this.saveImagesToWorkspace(images, this.currentWorkspace());
        if (!this.isCurrentRequest(requestSeq)) return;
        const follow = saved.length
          ? ` ${spokenImageSaveReply(saved.length, this.currentWorkspace())}`
          : ' I could not save them to that folder, but you can still save from the photo.';
        await this.respond(chatId, `${spoken}${follow}`, debug, undefined, images, requestSeq);
        return;
      }

      await this.respond(chatId, spoken, debug, undefined, images, requestSeq);
    } catch (e) {
      if (!this.isCurrentRequest(requestSeq) || isAbortError(e)) return;
      console.error('Imagine generate failed', e);
      const friendly = this.llm.friendlyError(e);
      await this.respond(chatId, friendly ?? 'I could not make that photo just now.', undefined, text, undefined, requestSeq);
    }
  }

  protected openAudioFilePicker() {
    this.composerMenuOpen.set(false);
    this.audioFilePickerEl?.nativeElement.click();
  }

  protected async onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    if (input) input.value = '';
    if (files.length === 0) return;

    const loaded: PendingFile[] = [];
    let failed = 0;

    for (const file of files) {
      if (!this.isTextFile(file)) {
        failed += 1;
        continue;
      }

      try {
        const raw = await file.text();
        const trimmed = raw.trim();
        const clipped = !trimmed
          ? '[empty file]'
          : trimmed.length > this.MAX_FILE_CHARS
            ? `${trimmed.slice(0, this.MAX_FILE_CHARS)}\n\n[truncated to ${this.MAX_FILE_CHARS.toLocaleString()} characters]`
            : trimmed;

        loaded.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          sizeLabel: formatFileSize(file.size),
          text: clipped,
        });
      } catch {
        failed += 1;
      }
    }

    if (loaded.length) {
      this.pendingFiles.update(list => [...list, ...loaded].slice(0, 6));
      this.setManualInputMode(true);
    }

    if (!loaded.length) {
      this.composerNotice.set(
        files.length === 1
          ? `${files[0].name} does not look like a text file.`
          : 'Those files could not be added.',
      );
      return;
    }

    this.composerNotice.set(
      failed
        ? `${loaded.length} file${loaded.length === 1 ? '' : 's'} ready. ${failed} could not be added.`
        : loaded.length === 1
          ? `${loaded[0].name} is ready.`
          : `${loaded.length} files are ready.`,
    );
  }

  protected async onAudioFileSelected(event: Event) {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;

    if (!this.isTextFile(file)) {
      this.composerNotice.set(`${file.name} does not look like a text file.`);
      if (input) input.value = '';
      return;
    }

    try {
      const text = (await file.text()).trim();
      if (!text) {
        this.composerNotice.set(`${file.name} is empty.`);
        return;
      }

      await this.generateDownloadableAudio(text, file.name);
    } catch (e) {
      console.error('Audio file generation failed', e);
      this.composerNotice.set('Could not generate that audio file.');
    } finally {
      if (input) input.value = '';
    }
  }

  // Garden management handlers (called from Settings component)
  protected onUpdateGarden(data: { id: string; name: string; description?: string }) {
    this.gardensService.updateGarden(data.id, { name: data.name, description: data.description });
  }

  protected async onDeleteGarden(id: string) {
    const chatIds = this.chats.chats().filter(chat => chat.gardenId === id).map(chat => chat.id);
    this.gardensService.deleteGarden(id);
    this.chats.deleteForGarden(id);
    this.messagesByChat.update(all => {
      const copy = { ...all };
      for (const chatId of chatIds) delete copy[chatId];
      return copy;
    });
    this.saveMessagesToStorage();
    await this.gardensService.useGarden(this.gardensService.currentGardenId());
    await this.afterGardenChange();
  }

  private threadId(): string {
    const gardenId = this.currentGarden()?.id;
    const current = this.chats.currentChat();
    if (current && (!gardenId || current.gardenId === gardenId)) return current.id;
    if (gardenId) return this.chats.ensureChatForGarden(gardenId).id;
    return this.chats.currentChatId() || 'default';
  }

  private setChatMessages(chatId: string, msgs: Message[]) {
    this.messagesByChat.update(all => ({
      ...all,
      [chatId]: msgs
    }));
    this.saveMessagesToStorage();
  }

  private setGardenMessages(id: string, msgs: Message[]) {
    const chatId = this.chats.chats().some(chat => chat.id === id) ? id : this.threadId();
    this.setChatMessages(chatId, msgs);
  }

  private addUserMessage(
    id: string,
    text: string,
    pending = false,
    images?: GeneratedImage[],
    topicId?: string,
    persist = true,
  ): Message {
    const chatId = this.chats.chats().some(chat => chat.id === id) ? id : this.threadId();
    const message: Message = {
      role: 'user',
      id: nextMessageId(),
      text,
      timestamp: new Date(),
      pending,
      images,
      topicId,
      persist,
    };
    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    currentMsgs.push(message);
    this.setChatMessages(chatId, currentMsgs);
    if (!pending && persist !== false) this.chats.touch(chatId, this.titleFromPrompt(text));
    this.scrollToBottom();
    return message;
  }

  private titleFromPrompt(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    return clean.length > 28 ? `${clean.slice(0, 26).trim()}…` : clean;
  }

  private updateMessageText(id: string, target: Message, text: string, pending = false, persist?: boolean) {
    const chatId = this.chats.chats().some(chat => chat.id === id) ? id : this.threadId();
    const currentMsgs = this.messagesByChat()[chatId] || [];
    const nextMsgs = currentMsgs.map(msg =>
      isMessageTarget(msg, target)
        ? { ...msg, text, pending, persist: persist ?? msg.persist }
        : msg
    );
    this.setChatMessages(chatId, nextMsgs);
    this.scrollToBottom();
  }

  private removeMessage(id: string, target: Message) {
    const chatId = this.chats.chats().some(chat => chat.id === id) ? id : this.threadId();
    const currentMsgs = this.messagesByChat()[chatId] || [];
    this.setChatMessages(
      chatId,
      currentMsgs.filter(msg => !isSameMessage(msg, target)),
    );
  }

  private loadMessagesFromStorage() {
    try {
      const byChat = localStorage.getItem('ava-messages-by-chat');
      const raw = byChat || localStorage.getItem('ava-messages-by-garden');
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, Message[]>;
      const hydrated = Object.fromEntries(
        Object.entries(parsed).map(([key, messages]) => [
          key,
          messages.map(msg => ({
            ...msg,
            id: msg.id || nextMessageId(),
            timestamp: new Date(msg.timestamp as unknown as string)
          }))
        ])
      );
      if (byChat) {
        this.messagesByChat.set(hydrated);
        return;
      }
      const migrated: Record<string, Message[]> = {};
      for (const [gardenId, messages] of Object.entries(hydrated)) {
        const chat = this.chats.ensureChatForGarden(gardenId);
        migrated[chat.id] = messages;
        const firstUser = messages.find(msg => msg.role === 'user')?.text;
        if (firstUser) this.chats.touch(chat.id, this.titleFromPrompt(firstUser));
      }
      this.messagesByChat.set(migrated);
      this.saveMessagesToStorage();
    } catch {}
  }

  private saveMessagesToStorage() {
    try {
      const persisted = Object.fromEntries(
        Object.entries(this.messagesByChat()).map(([chatId, messages]) => [
          chatId,
          messages.filter(message => !message.pending && message.persist !== false)
        ])
      );
      localStorage.setItem('ava-messages-by-chat', JSON.stringify(persisted));
      this.memory.scheduleConversationWrite(
        Object.values(this.messagesByChat()).flat()
          .filter(msg => !msg.pending && msg.persist !== false)
          .map(msg => ({
            role: msg.role,
            text: msg.text,
            timestamp: msg.timestamp,
            topicId: msg.topicId,
          })),
      );
    } catch {}
  }

  private collapseToSingleConversation() {
    const primary = this.chats.collapseToSingle();
    if (!primary) return;
    const merged = Object.values(this.messagesByChat())
      .flat()
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.messagesByChat.set({ [primary.id]: merged });
    this.saveMessagesToStorage();
  }

  private async hydrateMemory() {
    const chatId = this.threadId();
    const fallback = (this.messagesByChat()[chatId] || [])
      .filter(msg => msg.persist !== false)
      .map(msg => ({
        role: msg.role,
        text: msg.text,
        timestamp: msg.timestamp,
        topicId: msg.topicId,
      }));
    const stored = await this.memory.hydrate(fallback);
    if (!stored.length) return;
    this.setChatMessages(chatId, stored.map(turn => ({
      role: turn.role,
      id: nextMessageId(),
      text: turn.text,
      timestamp: turn.timestamp,
      topicId: turn.topicId,
    })));
  }

  // Voice / conversation state
  protected readonly isListening = signal(false);
  protected readonly voiceEnabled = signal(false);
  protected readonly isThinking = signal(false);
  protected readonly isPaused = signal(false);
  protected readonly status = signal<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  protected readonly currentTranscript = signal('');
  protected readonly voiceButtonLabel = computed(() => {
    if (!this.voiceEnabled()) return 'Speak';
    if (this.isListening()) return 'Listening';
    return 'Voice on';
  });

  protected readonly statusLabel = computed(() => {
    if (this.isLoadingModel()) return 'Loading Moonshine…';
    const backend = this.modelLoadInfo();
    switch (this.status()) {
      case 'listening': return backend ? `Listening (${backend})` : 'Listening with Moonshine';
      case 'thinking': return 'Thinking…';
      case 'speaking': return 'Speaking…';
      default: return 'Ready';
    }
  });

  private synth: SpeechSynthesis | null = null;

  // Moonshine Base STT (for continuous transcription)
  private transcriber: any = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private isModelLoading = signal(false);
  private moonshineBuffer: Float32Array = new Float32Array(0);
  private isSpeechActive = false;
  private silenceSamples = 0;
  private lastLiveUpdate = 0;
  private readonly SAMPLE_RATE = 16000;

  // Kokoro 82M TTS
  private kokoro: any = null;
  private exportKokoro: any = null;
  private isKokoroLoading = signal(false);
  private kokoroLoadInfo = signal('');
  private exportKokoroLoadInfo = signal('');
  private readonly CHUNK_SIZE = 4096;
  private readonly SPEECH_THRESHOLD = 0.007; // adaptive energy VAD floor
  private readonly MIN_SPEECH_SAMPLES = 16000 * 0.35; // ~0.35s min
  private readonly PTT_MIN_SAMPLES = 16000 * 0.18; // ~0.18s; release is the commit, not VAD
  private readonly SILENCE_FOR_COMMIT = 16000 * 0.7; // ~0.7s silence to commit
  private readonly SPEECH_ONSET_SAMPLES = 16000 * 0.16; // ~0.16s of sustained energy before wake
  private readonly SPEECH_COOLDOWN_MS = 1200;
  private listenEpoch = 0;
  private noiseFloor = 0.003;
  private speechSamples = 0;
  private speechCandidateSamples = 0;
  private speechCooldownUntil = 0;
  private isCommitInProgress = false;
  private isLiveTranscriptInProgress = false;

  private async preloadModel() {
    if (this.transcriber || typeof window === 'undefined') return;
    try {
      for (const a of await this.moonshineLoadAttempts()) {
        try {
          this.transcriber = await pipeline('automatic-speech-recognition', a.modelId, {
            device: a.device,
            dtype: a.dtype,
          });
          await this.transcriber(new Float32Array(4000));
          this.speechModelName.set(a.modelName);
          this.modelLoadInfo.set(a.label);
          return;
        } catch {
          this.transcriber = null;
        }
      }
    } catch {
      this.transcriber = null;
    }
  }

  private async preloadKokoro(forceWasm = false) {
    if ((this.kokoro && !forceWasm) || typeof window === 'undefined') return;
    try {
      this.isKokoroLoading.set(true);
      this.kokoroLoadInfo.set('loading...');

      // Use quantized for speed/size, fp32 for quality on WebGPU
      const hasWebGPU = !forceWasm && await this.supportsWebGPU();
      const dtype = hasWebGPU ? 'fp32' : 'q8';
      const device = hasWebGPU ? 'webgpu' : 'wasm';

      if (forceWasm) {
        this.kokoro = null;
      }
      this.kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
        dtype,
        device,
      });

      this.kokoroLoadInfo.set(`${device}/${dtype}`);
      console.info(`[Kokoro] Loaded ${this.kokoroLoadInfo()}`);
    } catch (e) {
      console.warn('Failed to load Kokoro TTS, will fallback to browser speechSynthesis', e);
      this.kokoro = null;
      this.kokoroLoadInfo.set('fallback');
    } finally {
      this.isKokoroLoading.set(false);
    }
  }

  private async ensureExportKokoro(): Promise<any> {
    if (this.exportKokoro || typeof window === 'undefined') return this.exportKokoro;

    this.isKokoroLoading.set(true);
    this.exportKokoroLoadInfo.set('loading wasm/q8');
    try {
      this.exportKokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
        dtype: 'q8',
        device: 'wasm',
      });
      this.exportKokoroLoadInfo.set('wasm/q8');
      console.info('[Kokoro export] Loaded wasm/q8');
      return this.exportKokoro;
    } catch (e) {
      this.exportKokoro = null;
      this.exportKokoroLoadInfo.set('failed');
      throw e;
    } finally {
      this.isKokoroLoading.set(false);
    }
  }

  protected readonly isLoadingModel = computed(() => this.isModelLoading());
  protected readonly speechModelName = signal<string>('Moonshine Base');
  protected modelLoadInfo = signal<string>('');  // e.g. "webgpu/q4" or "wasm/q8"
  protected readonly modelDownloadStatus = computed(() => this.llm.downloadStatus());

  protected async toggleVoice() {
    if (this.voiceEnabled()) {
      this.disableVoiceChannel();
      return;
    }

    await this.enableVoiceChannel();
  }

  protected stopListening() {
    this.pushTalkKeyCode = null;
    this.pushTalkHeld.set(false);
    this.disableVoiceChannel();
  }

  protected stopGrokTurn() {
    this.debug.log('command', 'Stop Grok turn');
    void this.grokCli.cancel();
  }

  private async beginPushTalk(fromKey?: string) {
    if (this.pushTalkHeld()) return;
    this.closeListenMenu();
    this.pushTalkKeyCode = fromKey ?? null;
    this.pushTalkHeld.set(true);
    this.voiceEnabled.set(true);
    this.setBackgroundVoiceSession(false);
    if (this.status() === 'speaking') this.stopSpeaking();
    this.debug.log('speech', 'Push-to-talk start');
    if (!this.isListening()) await this.startMoonshineListening();
  }

  private endPushTalk() {
    if (!this.pushTalkHeld()) return;
    this.pushTalkKeyCode = null;
    this.pushTalkHeld.set(false);
    this.voiceEnabled.set(false);
    this.setBackgroundVoiceSession(false);
    this.listenEpoch += 1;
    this.debug.log('speech', 'Push-to-talk release');
    this.stopMoonshineListening({ commitPending: true, submitPartial: true, fromPushTalk: true });
  }

  /** Buttons and other chrome keep Space for hold-to-talk; text fields still type a space. */
  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const host = el.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
    if (!host || !(host instanceof HTMLElement)) return false;
    if (host instanceof HTMLInputElement) {
      const type = host.type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'checkbox' || type === 'radio' || type === 'file' || type === 'image') {
        return false;
      }
    }
    return true;
  }

  private watchListenHotkey() {
    if (!this.listenHotkey.desktop) return;
    void this.listenHotkey.start();
    void import('@tauri-apps/api/event').then(({ listen }) => {
      listen('listen-hotkey-down', () => this.onListenHotkeyDown());
      listen('listen-hotkey-up', () => this.onListenHotkeyUp());
    }).catch(() => undefined);
  }

  private onListenHotkeyDown() {
    void this.rememberInsertTarget();
    if (this.showStartup() || this.showOnboarding() || this.confirm.open()) {
      return;
    }
    if (this.pushToTalk()) {
      void this.beginPushTalk('hotkey');
      return;
    }
    void this.toggleVoice();
  }

  private onListenHotkeyUp() {
    if (!this.pushToTalk() || this.pushTalkKeyCode !== 'hotkey') return;
    this.endPushTalk();
  }

  private watchWindowChrome() {
    effect(() => {
      this.chrome.setBlocked(
        this.showStartup() ||
        this.showOnboarding() ||
        this.showSettings() ||
        this.showMemory() ||
        this.showGrokCli() ||
        this.showDebugOverlay() ||
        !!this.viewerImage() ||
        this.updates.dialogOpen() ||
        this.confirm.open(),
      );
    });
  }

  private closeListenMenu() {
    if (!this.listenMenuOpen() && !this.chrome.menuOpen()) return;
    this.listenMenuOpen.set(false);
    void this.chrome.setMenuOpen(false);
  }

  private async showListenMenuAt(x: number, y: number) {
    this.composerMenuOpen.set(false);
    this.modelMenuOpen.set(false);
    this.workspaceMenuOpen.set(false);
    this.gardenMenuOpen.set(false);
    this.listenMenuOpen.set(true);
    if (this.orbChrome() || this.chrome.compact()) {
      await this.chrome.setMenuOpen(true);
    }
    const compact = this.orbChrome();
    const width = 228;
    const height = this.chromeDesktop ? (compact ? 308 : 256) : 148;
    const pad = 12;
    if (compact) {
      this.listenMenuX.set(Math.max(pad, (window.innerWidth - width) / 2));
      this.listenMenuY.set(Math.max(pad, Math.min(168, window.innerHeight - height - pad)));
      return;
    }
    this.listenMenuX.set(Math.max(pad, Math.min(x, window.innerWidth - width - pad)));
    this.listenMenuY.set(Math.max(pad, Math.min(y, window.innerHeight - height - pad)));
  }

  private armListenMenuLongPress(event: PointerEvent) {
    if (event.button !== 0) return;
    // Hold-to-talk already uses a press-and-hold; only long-press for the menu in open-channel mode.
    if (this.pushToTalk()) return;
    this.clearListenMenuLongPress();
    const x = event.clientX;
    const y = event.clientY;
    this.listenMenuTimer = setTimeout(() => {
      this.listenMenuTimer = null;
      this.listenMenuSuppressClick = true;
      this.showListenMenuAt(x, y);
    }, 520);
  }

  private clearListenMenuLongPress() {
    if (!this.listenMenuTimer) return;
    clearTimeout(this.listenMenuTimer);
    this.listenMenuTimer = null;
  }

  private consumeListenMenuClick(): boolean {
    if (!this.listenMenuSuppressClick) return false;
    this.listenMenuSuppressClick = false;
    return true;
  }

  private closeListenMenuIfOutside(target: EventTarget | null) {
    if (!this.listenMenuOpen()) return;
    const menu = this.listenMenuEl?.nativeElement;
    const node = target as Node | null;
    if (menu && node && menu.contains(node)) return;
    const el = target instanceof HTMLElement ? target : null;
    if (el?.closest('.mic-control')) return;
    this.closeListenMenu();
  }

  private async enableVoiceChannel() {
    this.voiceEnabled.set(true);
    // Gemini-style background session: on Android a microphone foreground
    // service keeps capture alive while the app is backgrounded.
    this.setBackgroundVoiceSession(true);
    if (!this.isListening() && !this.isThinking() && this.status() !== 'speaking') {
      await this.startMoonshineListening();
    }
  }

  private disableVoiceChannel() {
    this.pushTalkKeyCode = null;
    this.pushTalkHeld.set(false);
    this.voiceEnabled.set(false);
    this.setBackgroundVoiceSession(false);
    this.listenEpoch += 1;
    this.stopMoonshineListening();
  }

  /** Starts/stops the native background voice session (no-op outside Tauri). */
  private setBackgroundVoiceSession(active: boolean) {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    this.debug.log('command', active ? 'voice_session_start' : 'voice_session_stop');
    invoke(active ? 'voice_session_start' : 'voice_session_stop').catch(err => {
      // Older hosts without the command, or the OS denied the service.
      console.warn('[voice] background session toggle failed', err);
      this.debug.log('error', 'Voice session command failed', err);
    });
  }

  private pauseVoiceCapture() {
    this.stopMoonshineListening({ commitPending: false, submitPartial: false });
  }

  private resumeVoiceCaptureIfEnabled() {
    if (this.pushToTalk() || this.pushTalkHeld()) return;
    if (!this.voiceEnabled() || this.manualInputEnabled() || this.showStartup() || this.showOnboarding() || this.showSettings()) return;
    if (this.isListening() || this.isThinking() || this.status() === 'speaking') return;
    this.startMoonshineListening().catch(() => {});
  }

  private async supportsWebGPU(): Promise<boolean> {
    try {
      // @ts-ignore
      return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch {
      return false;
    }
  }

  private configureTransformersRuntime() {
    if (typeof window === 'undefined') return;

    const onnx = env.backends.onnx as any;
    onnx.wasm ??= {};
    onnx.wasm.wasmPaths = {
      mjs: new URL('onnxruntime/ort-wasm-simd-threaded.asyncify.mjs', window.location.href).href,
      wasm: new URL('onnxruntime/ort-wasm-simd-threaded.asyncify.wasm', window.location.href).href,
    };

    if (this.isAndroidWebView()) {
      onnx.wasm.numThreads = 1;
      onnx.wasm.proxy = false;
      env.useWasmCache = false;
    }
  }

  private isAndroidWebView(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent);
  }

  private async moonshineLoadAttempts(): Promise<Array<{
    modelId: string;
    modelName: string;
    device: 'webgpu' | 'wasm';
    dtype: any;
    label: string;
  }>> {
    const hasWebGPU = await this.supportsWebGPU();
    const models = this.isAndroidWebView()
      ? [
          { modelId: this.MOONSHINE_TINY_MODEL, modelName: 'Moonshine Tiny' },
        ]
      : [
          { modelId: this.MOONSHINE_BASE_MODEL, modelName: 'Moonshine Base' },
          { modelId: this.MOONSHINE_TINY_MODEL, modelName: 'Moonshine Tiny' },
        ];

    return models.flatMap(model => {
      const shortName = model.modelName.replace('Moonshine ', '').toLowerCase();
      const attempts: Array<{
        modelId: string;
        modelName: string;
        device: 'webgpu' | 'wasm';
        dtype: any;
        label: string;
      }> = [];

      if (hasWebGPU) {
        attempts.push({
          ...model,
          device: 'webgpu',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
          label: `${shortName} webgpu/fp32`,
        });
      }

      if (!hasWebGPU) {
        attempts.push({
          ...model,
          device: 'wasm',
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
          label: `${shortName} wasm/fp32`,
        });
      }

      return attempts;
    });
  }

  /**
   * Loads Moonshine with device/dtype fallbacks. The quantized merged decoder
   * variants can fail in ORT Web with missing DQ scale metadata, so speech
   * recognition uses fp32 and only changes backend/model size.
   */
  private async ensureTranscriberLoaded(): Promise<any> {
    if (this.transcriber) return this.transcriber;

    this.isModelLoading.set(true);
    this.status.set('listening');
    this.currentTranscript.set('');

    const attempts = await this.moonshineLoadAttempts();

    let lastError: any = null;

    try {
      for (const attempt of attempts) {
        try {
          this.modelLoadInfo.set(attempt.label);
          this.speechModelName.set(attempt.modelName);

          this.transcriber = await pipeline(
            'automatic-speech-recognition',
            attempt.modelId,
            { device: attempt.device, dtype: attempt.dtype }
          );

          await this.transcriber(new Float32Array(this.SAMPLE_RATE * 0.25));
          this.currentTranscript.set('');
          console.info(`[Moonshine] Loaded with ${attempt.label}`);
          return this.transcriber;
        } catch (err) {
          lastError = err;
          console.warn(`[Moonshine] ${attempt.label} failed`, err);
          this.transcriber = null;
        }
      }
      console.error('Moonshine failed to load on all backends', lastError);
      this.currentTranscript.set('');
      throw lastError ?? new Error('Moonshine load failed');
    } finally {
      this.isModelLoading.set(false);
    }
  }

  private async reloadTranscriberOnWasm(): Promise<any> {
    this.transcriber = null;
    this.isModelLoading.set(true);
    this.modelLoadInfo.set(`${this.speechModelName().replace('Moonshine ', '').toLowerCase()} wasm/fp32`);
    this.currentTranscript.set('');

    const modelId = this.speechModelName() === 'Moonshine Tiny'
      ? this.MOONSHINE_TINY_MODEL
      : this.MOONSHINE_BASE_MODEL;
    const attempts: Array<{ dtype: any; label: string }> = [
      {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
        label: `${this.speechModelName().replace('Moonshine ', '').toLowerCase()} wasm/fp32`,
      },
    ];

    let lastError: unknown = null;
    try {
      for (const attempt of attempts) {
        try {
          this.modelLoadInfo.set(attempt.label);
          this.transcriber = await pipeline(
            'automatic-speech-recognition',
            modelId,
            { device: 'wasm', dtype: attempt.dtype }
          );
          await this.transcriber(new Float32Array(this.SAMPLE_RATE * 0.25));
          this.currentTranscript.set('');
          console.info(`[Moonshine] Recovered with ${attempt.label}`);
          return this.transcriber;
        } catch (e) {
          lastError = e;
          this.transcriber = null;
        }
      }
      throw lastError ?? new Error('Moonshine WASM reload failed');
    } finally {
      this.isModelLoading.set(false);
    }
  }

  private usesGrokSpeech(): boolean {
    return this.llm.isCloudExclusive() && this.xai.signedIn();
  }

  private async transcribeWithRecovery(audio: Float32Array, transcriber = this.transcriber): Promise<any> {
    if (this.usesGrokSpeech()) {
      const text = await this.xaiClient.transcribe(audio, this.SAMPLE_RATE);
      return { text };
    }
    try {
      return await transcriber(audio);
    } catch (e) {
      if (this.isRecoverableMoonshineGpuError(e) && this.modelLoadInfo().startsWith('webgpu')) {
        this.modelLoadInfo.set('speech webgpu failed');
      }
      throw e;
    }
  }

  private isRecoverableMoonshineGpuError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /WebGPU|GroupQueryAttention|workgroup storage|compute pipeline|OrtRun|GPU/i.test(message);
  }

  private async startMoonshineListening() {
    if (this.isListening() || this.manualInputEnabled()) return;
    const epoch = this.listenEpoch;

    try {
      this.currentTranscript.set('');
      this.moonshineBuffer = new Float32Array(0);
      this.isSpeechActive = false;
      this.silenceSamples = 0;
      this.speechSamples = 0;
      this.speechCandidateSamples = 0;
      this.speechCooldownUntil = 0;
      this.isLiveTranscriptInProgress = false;
      this.noiseFloor = 0.003;

      const stream = await this.requestMicrophoneStream();
      if (epoch !== this.listenEpoch) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      this.mediaStream = stream;

      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.SAMPLE_RATE,
        latencyHint: 'interactive',
      });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume().catch(() => {});
      }
      if (epoch !== this.listenEpoch) {
        this.teardownAudioGraph();
        return;
      }

      // Some browsers ignore sampleRate in getUserMedia; we resample in processor if needed.
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);

      // ScriptProcessor for broad compatibility (simple continuous chunking)
      this.processor = this.audioContext.createScriptProcessor(this.CHUNK_SIZE, 1, 1);

      this.sourceNode.connect(this.processor);

      // Connect processor to a silent gain node (ScriptProcessor requires connection to keep firing)
      const gain = this.audioContext.createGain();
      gain.gain.value = 0;
      this.processor.connect(gain);
      gain.connect(this.audioContext.destination);

      this.isListening.set(true);
      this.status.set('listening');
      this.processor.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer.getChannelData(0);
        if (this.pushTalkHeld()) {
          const held = new Float32Array(inputBuffer);
          this.appendToBuffer(held);
          this.speechSamples += held.length;
          return;
        }
        if (this.isCommitInProgress) return;

        // Convert to mono float32 (already should be)
        const samples = new Float32Array(inputBuffer);

        // Simple energy-based VAD with hysteresis and onset gating
        const energy = this.calculateEnergy(samples);
        const speechThreshold = this.currentSpeechThreshold();
        const now = Date.now();
        const isAboveThreshold = energy > speechThreshold;

        if (this.speechCooldownUntil > now) {
          this.updateNoiseFloor(energy);
          this.appendToRollingContext(samples);
          return;
        }

        if (!this.isSpeechActive) {
          if (isAboveThreshold) {
            this.speechCandidateSamples += samples.length;
            this.appendToRollingContext(samples);
            if (this.speechCandidateSamples >= this.SPEECH_ONSET_SAMPLES) {
              this.isSpeechActive = true;
              this.silenceSamples = 0;
              this.speechSamples = 0;
              this.speechCandidateSamples = 0;
              this.appendToBuffer(samples);
            }
          } else {
            this.speechCandidateSamples = 0;
            this.updateNoiseFloor(energy);
            this.appendToRollingContext(samples);
          }
        } else if (isAboveThreshold) {
          this.appendToBuffer(samples);
          this.speechSamples += samples.length;
          this.silenceSamples = 0;
        } else {
          this.silenceSamples += samples.length;
          this.appendToBuffer(samples);

          if (this.silenceSamples >= this.SILENCE_FOR_COMMIT && this.speechSamples >= this.MIN_SPEECH_SAMPLES) {
            this.commitCurrentUtterance();
          }
        }

        // Live / continuous transcription updates (throttled)
        if (this.isSpeechActive &&
            this.moonshineBuffer.length > 0 &&
            (now - this.lastLiveUpdate > 1800) && // occasional live text, final transcription has priority
            this.speechSamples >= this.MIN_SPEECH_SAMPLES) {
          this.lastLiveUpdate = now;
          this.updateLiveTranscript();
        }
      };

      if (!this.usesGrokSpeech()) {
        await this.ensureTranscriberLoaded();
        if (epoch !== this.listenEpoch) return;
      } else {
        this.speechModelName.set('Grok Voice');
        this.modelLoadInfo.set('cloud');
      }
    } catch (err: any) {
      if (epoch !== this.listenEpoch) return;
      console.error('Moonshine STT start error', err);
      this.voiceEnabled.set(false);
      this.stopMoonshineListening({ commitPending: false, submitPartial: false });

      this.currentTranscript.set(this.voiceStartFailureMessage(err));
      setTimeout(() => this.currentTranscript.set(''), 2400);
    }
  }

  private async requestMicrophoneStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable in this WebView');
    }

    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: this.SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  private voiceStartFailureMessage(error: unknown): string {
    const name = String((error as any)?.name ?? '');
    const message = String((error as any)?.message ?? error);

    if (/NotAllowedError|PermissionDeniedError|SecurityError/i.test(name) || /permission|denied/i.test(message)) {
      return 'Microphone permission needed';
    }

    if (/NotFoundError|DevicesNotFoundError/i.test(name) || /no.*microphone|requested device not found/i.test(message)) {
      return 'No microphone found';
    }

    if (!this.transcriber) {
      return 'Speech model unavailable';
    }

    return 'Voice unavailable';
  }

  private calculateEnergy(buffer: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  private currentSpeechThreshold(): number {
    return Math.max(this.SPEECH_THRESHOLD, this.noiseFloor * 4.2);
  }

  private updateNoiseFloor(energy: number) {
    // Slow EMA so air-conditioning/keyboard noise is learned, but speech does
    // not immediately raise the threshold and make Ava deaf mid-sentence.
    this.noiseFloor = this.noiseFloor * 0.96 + Math.min(energy, 0.03) * 0.04;
  }

  private appendToBuffer(newSamples: Float32Array) {
    const combined = new Float32Array(this.moonshineBuffer.length + newSamples.length);
    combined.set(this.moonshineBuffer);
    combined.set(newSamples, this.moonshineBuffer.length);
    this.moonshineBuffer = combined;

    // Safety cap (Moonshine handles up to ~30s well)
    const maxSamples = this.SAMPLE_RATE * 28;
    if (this.moonshineBuffer.length > maxSamples) {
      this.moonshineBuffer = this.moonshineBuffer.slice(this.moonshineBuffer.length - maxSamples);
    }
  }

  private appendToRollingContext(newSamples: Float32Array) {
    const contextSize = this.SAMPLE_RATE * 1.2; // keep ~1.2s context
    const combined = new Float32Array(Math.min(contextSize, this.moonshineBuffer.length + newSamples.length));
    const start = Math.max(0, this.moonshineBuffer.length + newSamples.length - contextSize);
    if (this.moonshineBuffer.length > 0) {
      const prevStart = Math.max(0, this.moonshineBuffer.length - (contextSize - newSamples.length));
      combined.set(this.moonshineBuffer.slice(prevStart));
    }
    combined.set(newSamples, combined.length - newSamples.length);
    this.moonshineBuffer = combined;
  }

  private async updateLiveTranscript() {
    try {
      if (this.usesGrokSpeech()) return;
      if (this.isLiveTranscriptInProgress || this.isCommitInProgress) return;
      if (this.moonshineBuffer.length < this.MIN_SPEECH_SAMPLES) return;

      this.isLiveTranscriptInProgress = true;
      const buffer = this.moonshineBuffer.slice();
      const result: any = await this.transcribeWithRecovery(buffer);
      const text = (result?.text || '').trim();
      if (text) {
        this.currentTranscript.set(text);
      }
    } catch (e) {
      // non-fatal for live updates
    } finally {
      this.isLiveTranscriptInProgress = false;
    }
  }

  private async commitCurrentUtterance() {
    const live = this.currentTranscript();
    const buffer = this.moonshineBuffer;
    const spokenSamples = this.speechSamples;
    this.moonshineBuffer = new Float32Array(0);
    this.isSpeechActive = false;
    this.silenceSamples = 0;
    this.speechSamples = 0;
    await this.commitCapturedAudio(buffer, spokenSamples, live, this.MIN_SPEECH_SAMPLES);
  }

  private async commitCapturedAudio(
    buffer: Float32Array,
    spokenSamples: number,
    live: string,
    minSamples: number,
  ) {
    if (this.isCommitInProgress) return;
    this.isCommitInProgress = true;
    this.speechCooldownUntil = Date.now() + this.SPEECH_COOLDOWN_MS;
    await this.waitForLiveTranscriptToSettle();

    const spoken = live.trim();
    if (!spoken && spokenSamples < minSamples && buffer.length < minSamples) {
      this.isCommitInProgress = false;
      return;
    }

    const gardenId = this.currentGarden()?.id;
    let pendingUserMessage: Message | undefined;

    try {
      if (spoken) {
        this.currentTranscript.set('');
        this.lastLiveUpdate = 0;
        this.handleUserSpeech(spoken);
        return;
      }

      if (!this.usesGrokSpeech() && !this.transcriber) {
        await this.ensureTranscriberLoaded();
      }

      if (gardenId) {
        pendingUserMessage = this.addUserMessage(gardenId, 'Transcribing...', true);
      }
      this.currentTranscript.set('Transcribing...');
      this.status.set('thinking');

      const result: any = await this.transcribeWithRecovery(buffer);
      const finalText = (result?.text || '').trim();

      if (finalText) {
        this.currentTranscript.set('');
        this.lastLiveUpdate = 0;
        this.handleUserSpeech(finalText, pendingUserMessage);
      } else if (gardenId && pendingUserMessage) {
        this.removeMessage(gardenId, pendingUserMessage);
        this.currentTranscript.set('I heard you, but could not make out the words.');
        setTimeout(() => {
          if (this.currentTranscript() === 'I heard you, but could not make out the words.') {
            this.currentTranscript.set('');
          }
        }, 1600);
      }
    } catch (e) {
      console.error('Moonshine transcription error on commit', e);
      if (gardenId && pendingUserMessage) {
        this.removeMessage(gardenId, pendingUserMessage);
      }
      this.currentTranscript.set('I heard you, but could not transcribe that.');
      setTimeout(() => {
        if (this.currentTranscript() === 'I heard you, but could not transcribe that.') {
          this.currentTranscript.set('');
        }
      }, 1600);
    } finally {
      this.isCommitInProgress = false;
      if (!this.isThinking() && this.status() !== 'speaking') {
        this.resumeVoiceCaptureIfEnabled();
      }
    }
  }

  private async waitForLiveTranscriptToSettle() {
    for (let i = 0; i < 12 && this.isLiveTranscriptInProgress; i++) {
      await this.delay(25);
    }
  }

  private teardownAudioGraph() {
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
      }
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
      }
    } catch {
      // ignore cleanup errors
    }

    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.sourceNode = null;
    this.moonshineBuffer = new Float32Array(0);
    this.isSpeechActive = false;
    this.silenceSamples = 0;
    this.speechSamples = 0;
    this.isLiveTranscriptInProgress = false;
    this.isListening.set(false);
  }

  private stopMoonshineListening(
    options: { commitPending?: boolean; submitPartial?: boolean; fromPushTalk?: boolean } = {}
  ) {
    const commitPending = options.commitPending ?? true;
    const wasListening = this.isListening();
    const buffer = this.moonshineBuffer;
    const spokenSamples = this.speechSamples;
    const live = options.fromPushTalk ? '' : (this.currentTranscript() || '').trim();
    const minSamples = options.fromPushTalk ? this.PTT_MIN_SAMPLES : this.MIN_SPEECH_SAMPLES;
    const hasAudio = spokenSamples >= minSamples || buffer.length >= minSamples;

    this.teardownAudioGraph();

    if (this.status() === 'listening') {
      this.status.set('idle');
    }

    if (commitPending && wasListening && (hasAudio || live)) {
      void this.commitCapturedAudio(buffer, spokenSamples, live, minSamples);
    }
  }

  private async handleUserSpeech(text: string, existingUserMessage?: Message) {
    this.currentTranscript.set('');

    this.debug.log('speech', 'Heard you', text);
    if (!text.trim()) return;
    this.heardUserForIdle();

    if (isAskingToSelfImprove(text) || isAskingToResetSelfImprovements(text)) {
      const gardenId = this.currentGarden()?.id;
      if (!gardenId) return;
      const seq = this.beginRequest();
      if (isAskingToResetSelfImprovements(text)) {
        this.debug.log('route', 'Reset self-improvements', text);
        await this.resetSelfImprovements(text, seq, existingUserMessage);
        return;
      }
      this.debug.log('route', 'Self-improve', text);
      await this.startSelfImprove(text, seq, existingUserMessage);
      return;
    }

    if (this.showGrokCli() && this.grokCli.working() && isAskingToStopGrokTurn(text)) {
      this.debug.log('route', 'Stop Grok turn');
      this.stopGrokTurn();
      return;
    }

    if ((this.isListening() || this.voiceEnabled() || this.pushTalkHeld()) && isAskingToStopListening(text)) {
      this.debug.log('route', 'Stop listening');
      this.stopListening();
      return;
    }

    if (this.showGrokCli() && this.grokCli.working() && /^(stop|end)$/.test(text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim())) {
      this.debug.log('route', 'Stop Grok turn');
      this.stopGrokTurn();
      return;
    }

    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const seq = this.beginRequest();

    const insertAsk = parseInsertRequest(text, { intoField: this.chrome.compact() });
    if (insertAsk) {
      this.debug.log('route', 'Insert into field', insertAsk.kind);
      this.status.set('thinking');
      this.isThinking.set(true);
      await this.handleInsertIntoField(gardenId, text, insertAsk, seq, existingUserMessage);
      return;
    }

    if (this.isNewConversationCommand(text)) {
      this.debug.log('route', 'New conversation');
      this.resetCurrentConversation();
      this.status.set('thinking');
      this.isThinking.set(true);
      await this.respond(this.threadId(), 'Alright. The talk is clear. I still remember what matters.', undefined, undefined, undefined, seq);
      return;
    }

    if (this.showGrokCli()) {
      if (isLeavingGrokWork(text)) {
        this.debug.log('route', 'Leave Grok session');
        this.closeGrokCli();
        this.status.set('thinking');
        this.isThinking.set(true);
        await this.respond(this.threadId(), 'Alright. I am here.', undefined, undefined, undefined, seq);
        return;
      }
      if (isAskingForGrokWork(text) && (extractProjectHint(text) || !this.grokCli.canTakeSpeech())) {
        this.debug.log('route', 'Grok CLI work', text);
        this.status.set('thinking');
        this.isThinking.set(true);
        await this.openGrokForWork(text, seq);
        return;
      }
      if (this.grokCli.needsFolder()) {
        this.debug.log('route', 'Grok CLI folder', text);
        this.status.set('thinking');
        this.isThinking.set(true);
        const picked = await this.grokCli.handleFolderSpeech(text);
        this.isThinking.set(false);
        if (picked) {
          await this.speak('What would you like us to work on together?');
        } else {
          await this.speak('Choose a folder for this session and we can start.');
        }
        if (this.status() === 'speaking') this.status.set('idle');
        this.resumeVoiceCaptureIfEnabled();
        return;
      }
      if (this.grokCli.canTakeSpeech()) {
        this.debug.log('route', 'Grok CLI session', text);
        this.status.set('thinking');
        this.isThinking.set(true);
        await this.grokCli.send(text);
        this.isThinking.set(false);
        this.status.set('idle');
        this.resumeVoiceCaptureIfEnabled();
        return;
      }
    }

    if (isAskingForGrokWork(text)) {
      this.debug.log('route', 'Grok CLI work', text);
      this.status.set('thinking');
      this.isThinking.set(true);
      const persist = !this.grokCli.desktop();
      if (existingUserMessage) this.updateMessageText(gardenId, existingUserMessage, text, false, persist);
      else this.addUserMessage(gardenId, text, false, undefined, undefined, persist);
      if (!persist) {
        await this.openGrokForWork(text, seq);
        return;
      }
      await this.respond(
        gardenId,
        'Grok sessions live in the desktop app. Open Ava there and we can work on a project together.',
        undefined,
        undefined,
        undefined,
        seq,
      );
      return;
    }

    this.status.set('thinking');
    this.isThinking.set(true);

    const routed = this.memory.route(text);
    this.debug.log(
      'memory',
      routed.created ? 'New topic' : routed.switched ? 'Switched topic' : 'Held topic',
      routed.topic?.title ?? 'Here',
    );
    const attached = this.takePendingImages();
    if (existingUserMessage) {
      this.updateMessageText(gardenId, existingUserMessage, text);
    } else {
      this.addUserMessage(gardenId, text, false, attached, routed.topic?.id);
    }
    const lastAva = [...this.messages()].reverse().find(msg => msg.role === 'ava' && !msg.pending);
    const remembered = this.memory.rememberUser(text, routed.topic, lastAva ? personaGapFromLine(lastAva.text) : null);

    if (this.pendingFullNameFor) {
      await this.handlePendingFullName(gardenId, text, seq);
      return;
    }

    if (isAskingAboutSchedules(text)) {
      this.debug.log('route', 'List schedules');
      await this.respond(gardenId, this.describeSchedules(), undefined, undefined, undefined, seq);
      return;
    }

    if (isAskingToCancelSchedule(text)) {
      this.debug.log('route', 'Cancel schedules');
      const count = this.schedules.enabled().length;
      this.schedules.clear();
      await this.respond(
        gardenId,
        count ? 'I cleared the schedules.' : 'Nothing was scheduled.',
        undefined,
        undefined,
        undefined,
        seq,
      );
      return;
    }

    const scheduled = parseScheduleRequest(text);
    if (scheduled) {
      this.debug.log('route', 'Create schedule', scheduled.title);
      await this.handleScheduleAsk(gardenId, scheduled, seq);
      return;
    }

    if (isAskingToResearchSelf(text)) {
      this.debug.log('route', 'Research me');
      await this.handleResearch(gardenId, { aboutUser: true }, seq);
      return;
    }

    const researchTopic = extractResearchTopic(text);
    if (researchTopic && !this.detectAgentRequest(text)) {
      this.debug.log('route', 'Research topic', researchTopic);
      await this.handleResearch(gardenId, { topic: researchTopic }, seq);
      return;
    }

    const chatId = this.threadId();
    const referringToExisting = /\b(this|that)\b/i.test(text);

    if (attached.length) {
      this.debug.log('route', 'Imagine edit', { photos: attached.length });
      await this.handleImagineEdit(chatId, text, attached, seq);
      return;
    }

    if (wantsPhotoHelp(text) && (!this.lastChatImage() || !referringToExisting)) {
      this.debug.log('route', 'Photo gate');
      this.pendingPhotoEdit = { prompt: text, chatId };
      this.addGateMessage(
        chatId,
        'photo',
        text,
        'Choose a photo and I will work on it here.',
      );
      void this.speak('Choose a photo and I will take it from there.');
      this.isThinking.set(false);
      this.status.set('idle');
      return;
    }

    if (wantsImageEdit(text) && this.lastChatImage()) {
      this.debug.log('route', 'Imagine edit last photo');
      await this.handleImagineEdit(chatId, text, attached, seq);
      return;
    }

    if (wantsImage(text)) {
      this.debug.log('route', 'Imagine generate');
      await this.handleImagineGenerate(chatId, text, seq);
      return;
    }

    // 1) Copilot / GitHub / background-task request.
    if (
      this.detectAgentRequest(text) ||
      shouldUseCopilot(text, this.copilotAuth.signedIn()) ||
      isGithubWorkRequest(text) ||
      isFileWorkRequest(text)
    ) {
      this.debug.log('route', 'Agent / Copilot');
      await this.handleAgentRequest(gardenId, text, seq);
      return;
    }

    // 2) Weather questions → answer right now with the built-in weather tools.
    if (this.detectWeatherRequest(text)) {
      this.debug.log('route', 'Weather tools');
      await this.handleWeatherRequest(gardenId, text, seq);
      return;
    }

    const keepQuiet = remembered.kind === 'people'
      ? !text.includes('?') && text.trim().length < 360
      : remembered.kind !== 'none' && remembered.explicit && text.trim().length < 220;
    if (keepQuiet) {
      this.debug.log('route', 'Quiet remember', remembered.kind);
      await this.delay(250);
      if (!this.isCurrentRequest(seq)) return;
      const spoken = remembered.kind === 'people'
        ? peopleAck(remembered.line?.split(',').length || 1)
        : rememberAck();
      this.respond(gardenId, spoken, undefined, undefined, undefined, seq);
      return;
    }

    // 3) Fast hard-coded reply for common phrases.
    const fixed = this.generateAvaResponse(text);
    if (fixed) {
      this.debug.log('route', 'Fixed reply', fixed);
      await this.delay(350 + Math.random() * 350);
      if (!this.isCurrentRequest(seq)) return;
      this.respond(gardenId, fixed, undefined, undefined, undefined, seq);
      return;
    }

    this.debug.log('route', 'Conversation model');
    await this.handleLlmReply(gardenId, text, seq, routed.topic?.id);
  }

  /** Detects when the user is explicitly asking for a background agent/task. */
  private detectAgentRequest(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(agent|background task|in the background|run a task|keep working on|work on (this|that|it)|go (and )?(research|find|look into|investigate)|research .+ for me|monitor|keep an eye on|while i('m| am)? (away|gone|busy))\b/.test(
      lower
    );
  }

  private watchSchedules() {
    if (typeof window === 'undefined') return;
    window.setInterval(() => void this.maybeRunDueSchedules(), 20_000);
  }

  private async maybeRunDueSchedules() {
    if (this.scheduleBusy) return;
    if (this.showOnboarding() || this.showStartup()) return;
    if (this.selfImprove.phase() !== 'idle' || this.grokCli.selfImproving()) return;
    if (this.status() !== 'idle' || this.isListening() || this.isThinking() || this.pushTalkHeld()) return;
    if (this.hasActiveAgents()) return;
    const due = this.schedules.takeDue();
    if (!due.length) return;
    this.scheduleBusy = true;
    try {
      for (const job of due) {
        const gardenId = this.currentGarden()?.id || this.threadId();
        const seq = this.beginRequest();
        this.debug.log('route', 'Schedule run', job.title);
        this.status.set('thinking');
        this.isThinking.set(true);
        this.addUserMessage(gardenId, job.task, false, undefined, this.memory.activeTopic()?.id);
        if ((job.researchMe || isAskingToResearchSelf(job.task)) && !this.research.fullName()) {
          await this.respond(
            gardenId,
            'I skipped that research. I still need your full name.',
            undefined,
            undefined,
            undefined,
            seq,
          );
          this.schedules.markRan(job.id);
          continue;
        }
        if (job.researchMe || isAskingToResearchSelf(job.task)) {
          await this.handleResearch(gardenId, { aboutUser: true }, seq);
        } else {
          const topic = extractResearchTopic(job.task);
          if (topic) await this.handleResearch(gardenId, { topic }, seq);
          else await this.handleLlmReply(gardenId, job.task, seq);
        }
        this.schedules.markRan(job.id);
      }
    } finally {
      this.scheduleBusy = false;
    }
  }

  private describeSchedules(): string {
    const items = this.schedules.enabled();
    if (!items.length) return 'Nothing is scheduled. I only run those while I am still open.';
    if (items.length === 1) {
      const item = items[0];
      return `${item.title}, ${this.schedules.describe(item)}. I need to stay open for it.`;
    }
    return items
      .map(item => `${item.title}, ${this.schedules.describe(item)}`)
      .join('. ') + '. I need to stay open for them.';
  }

  private async handleScheduleAsk(gardenId: string, parsed: ParsedSchedule, requestSeq: number) {
    const job = this.schedules.addFromSpeech(parsed);
    const when = this.schedules.describe(job);
    if (parsed.researchMe && !this.research.fullName()) {
      this.pendingFullNameFor = 'schedule';
      await this.respond(
        gardenId,
        `I will. ${when.charAt(0).toUpperCase()}${when.slice(1)}, if I am still here. What is your full name, so I can look you up?`,
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }
    await this.respond(
      gardenId,
      `I will. ${when.charAt(0).toUpperCase()}${when.slice(1)}, if I am still here.`,
      undefined,
      undefined,
      undefined,
      requestSeq,
    );
  }

  private async handlePendingFullName(gardenId: string, text: string, requestSeq: number) {
    const name = extractGivenFullName(text);
    if (!name) {
      await this.respond(
        gardenId,
        'Say your first and last name, and I will look from there.',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }
    await this.memory.rememberFullName(name);
    const kind = this.pendingFullNameFor;
    this.pendingFullNameFor = null;
    const topic = this.pendingResearchTopic;
    this.pendingResearchTopic = null;
    if (kind === 'schedule') {
      await this.respond(
        gardenId,
        `I will keep ${name}. I will look you up when that schedule runs.`,
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }
    await this.handleResearch(gardenId, topic ? { topic } : { aboutUser: true }, requestSeq);
  }

  private async handleResearch(
    gardenId: string,
    input: { aboutUser?: boolean; topic?: string },
    requestSeq: number,
  ) {
    if (input.aboutUser && !this.research.fullName()) {
      this.pendingFullNameFor = 'research';
      this.pendingResearchTopic = null;
      await this.respond(
        gardenId,
        'What is your full name, so I can look you up?',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }

    this.status.set('speaking');
    this.speak(input.aboutUser ? 'I will look you up.' : 'I will look into that.');

    try {
      const result = await this.research.run(input);
      if (!this.isCurrentRequest(requestSeq)) return;
      await this.respond(
        gardenId,
        result.spoken,
        undefined,
        undefined,
        undefined,
        requestSeq,
        result.reportRel,
      );
    } catch (error) {
      if (!this.isCurrentRequest(requestSeq) || isAbortError(error)) return;
      console.error('Research failed', error);
      const friendly = this.llm.friendlyError(error);
      await this.respond(
        gardenId,
        friendly ?? 'I could not finish that research just now.',
        undefined,
        input.topic || 'research me',
        undefined,
        requestSeq,
      );
    }
  }

  /** Detects when the user is asking about the weather. */
  private detectWeatherRequest(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(weather|forecast|temperature|how (hot|cold|warm)|will it (rain|snow)|is it (raining|snowing|sunny)|do i need (an? )?(umbrella|jacket|coat))\b/.test(
      lower
    );
  }

  /** Answers a weather question now using the built-in weather tools + Qwen. */
  private async handleWeatherRequest(gardenId: string, text: string, requestSeq = this.requestSeq) {
    const weatherTools = this.mcp.tools().filter((t) => t.serverId === WEATHER_SERVER_ID);
    if (!weatherTools.length) {
      await this.handleLlmReply(gardenId, text, requestSeq);
      return;
    }

    // Speak a filler immediately; looking up + reasoning takes a moment.
    this.status.set('speaking');
    this.speak(this.pickThinkingFiller());

    const toolDefs: AgentToolDef[] = weatherTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const instructions =
      'You are Ava, a warm and concise voice companion answering a weather question. ' +
      'When the user names a place, first call search_location to get its latitude and longitude, ' +
      'then call get_forecast (works worldwide) for that location. Use get_current_conditions or ' +
      'get_alerts only for US locations. Once you have the data, reply in one or two short, natural ' +
      'spoken sentences the way a friend would — mention the location plus the key details (temperature ' +
      'and conditions). Do not read out tables, coordinates, or long lists of numbers.';

    try {
      const reply = (
        await this.agents.generateWithTools(
          text,
          toolDefs,
          (name, args) => this.runMcpTool(name, args),
          4,
          instructions,
        )
      ).trim();
      if (!this.isCurrentRequest(requestSeq)) return;
      this.respond(gardenId, reply || 'I could not get the weather just now.', undefined, undefined, undefined, requestSeq);
    } catch (e) {
      if (!this.isCurrentRequest(requestSeq) || isAbortError(e)) return;
      console.error('Weather request failed', e);
      this.respond(gardenId, 'Sorry, I could not get the weather right now.', undefined, undefined, undefined, requestSeq);
    }
  }

  private isNewConversationCommand(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:(?:hey\s+)?ava\s+|please\s+|can you\s+|could you\s+|would you\s+|can we\s+|could we\s+)+/, '')
      .replace(/\s+(please|for me)$/g, '');

    return /^(new|start a new|begin a new|fresh|reset|clear|wipe|erase)\s+(the\s+|my\s+|current\s+)?(conversation|chat|thread)$/.test(normalized)
      || /^(new conversation|new chat|fresh conversation|fresh chat|start fresh|start over|start from scratch|begin again)$/.test(normalized)
      || /^(let'?s|lets|let us)\s+(start over|start fresh|start a new conversation|begin again)$/.test(normalized);
  }

  /** Speaks a final reply, stores it, and returns to idle when speech finishes. */
  private async respond(
    gardenId: string,
    response: string,
    debug?: Message['debug'],
    retryFor?: string,
    images?: GeneratedImage[],
    requestSeq = this.requestSeq,
    reportRel?: string,
    spoken?: string,
  ) {
    if (!this.isCurrentRequest(requestSeq)) return;

    const chatId = this.chats.chats().some(chat => chat.id === gardenId) ? gardenId : this.threadId();
    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    const avaMsg: Message = {
      role: 'ava',
      id: nextMessageId(),
      text: response,
      timestamp: new Date(),
      debug,
      retryFor,
      images,
      reportRel,
      topicId: this.memory.activeTopic()?.id,
    };
    currentMsgs.push(avaMsg);
    this.setChatMessages(chatId, currentMsgs);

    this.isThinking.set(false);
    this.status.set('speaking');
    this.scrollToBottom();

    await this.speak(spoken ?? response);

    if (!this.isCurrentRequest(requestSeq)) return;
    if (this.status() === 'speaking') this.status.set('idle');
    this.resumeVoiceCaptureIfEnabled();
  }

  private async handleInsertIntoField(
    gardenId: string,
    spoken: string,
    request: InsertRequest,
    requestSeq: number,
    existingUserMessage?: Message,
  ) {
    if (existingUserMessage) this.updateMessageText(gardenId, existingUserMessage, spoken);
    else this.addUserMessage(gardenId, spoken);

    if (!this.chrome.desktop) {
      await this.respond(
        gardenId,
        'I can only type into other apps in the desktop app.',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }

    let body = '';
    let debug: Message['debug'] | undefined;
    if (request.kind === 'last') {
      body = [...this.messages()].reverse().find(msg => msg.role === 'ava' && !msg.pending)?.text?.trim() ?? '';
      if (!body) {
        await this.respond(gardenId, 'I do not have anything to insert yet.', undefined, undefined, undefined, requestSeq);
        return;
      }
    } else if (request.kind === 'literal') {
      body = request.text.trim();
    } else {
      this.status.set('speaking');
      this.speak(this.pickThinkingFiller());
      try {
        const startedAt = performance.now();
        const topic = this.memory.activeTopic();
        const result = await this.llm.generate(
          buildInsertPrompt(request.prompt),
          this.buildChatHistory(gardenId, topic?.id),
          [],
          this.memory.contextBlock(topic),
        );
        if (!this.isCurrentRequest(requestSeq)) return;
        body = result.text.trim();
        debug = {
          model: this.llm.activeModel()?.name ?? (this.llm.isCloudExclusive() ? 'Grok' : 'local model'),
          durationMs: performance.now() - startedAt,
        };
      } catch (error) {
        if (!this.isCurrentRequest(requestSeq) || isAbortError(error)) return;
        const friendly = this.llm.friendlyError(error);
        await this.respond(
          gardenId,
          friendly ?? 'Sorry, I could not write that just now.',
          undefined,
          spoken,
          undefined,
          requestSeq,
        );
        return;
      }
    }

    if (!body) {
      await this.respond(gardenId, 'I could not write that just now.', debug, spoken, undefined, requestSeq);
      return;
    }

    let inserted = false;
    let insertError = '';
    try {
      (document.activeElement as HTMLElement | null)?.blur?.();
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('remember_insert_target');
      await invoke('insert_into_focused_field', { text: body });
      inserted = true;
    } catch (error) {
      insertError = error instanceof Error ? error.message : String(error);
      console.warn('Insert into field failed', error);
    }
    if (!this.isCurrentRequest(requestSeq)) return;

    const ack = inserted
      ? 'It is in.'
      : /click the field/i.test(insertError)
        ? 'Click the field you want, then ask me again.'
        : 'I have the text. Click the field you want, then say insert that.';

    if (request.kind === 'last') {
      await this.respond(gardenId, ack, undefined, undefined, undefined, requestSeq);
      return;
    }

    await this.respond(gardenId, body, debug, undefined, undefined, requestSeq, undefined, ack);
  }

  /** Routes an open-ended question to the local LLM, speaking a filler line first. */
  private async handleLlmReply(gardenId: string, text: string, requestSeq = this.requestSeq, topicId?: string) {
    // Speak the filler immediately so the user knows Ava is working.
    this.status.set('speaking');
    this.speak(this.pickThinkingFiller());

    try {
      const history = this.buildChatHistory(gardenId, topicId);
      const startedAt = performance.now();
      const topic = this.memory.topics().find(item => item.id === topicId) ?? this.memory.activeTopic();
      const result = await this.llm.generate(
        text,
        history,
        this.takePendingImages(),
        this.memory.contextBlock(topic),
      );
      if (!this.isCurrentRequest(requestSeq)) return;
      const reply = result.text.trim();
      const debug: Message['debug'] = {
        model: this.llm.activeModel()?.name ?? (this.llm.isCloudExclusive() ? 'Grok' : 'local model'),
        durationMs: performance.now() - startedAt,
      };
      if (reply || result.images?.length) {
        this.respond(
          gardenId,
          reply || 'I made that for you.',
          debug,
          undefined,
          result.images,
          requestSeq,
        );
      } else {
        this.respond(gardenId, 'I am not sure how to answer that just yet.', debug, text, undefined, requestSeq);
      }
    } catch (e) {
      if (!this.isCurrentRequest(requestSeq) || isAbortError(e)) return;
      console.error('LLM reply failed', e);
      const friendly = this.llm.friendlyError(e);
      this.respond(gardenId, friendly ?? 'Sorry, I could not think that through just now.', undefined, text, undefined, requestSeq);
    }
  }

  /** Re-runs a failed or empty reply with the original user prompt. */
  protected async retryMessage(msg: Message) {
    const retryFor = msg.retryFor;
    if (!retryFor || this.isThinking()) return;
    const gardenId = this.currentGarden()?.id;
    if (!gardenId) return;

    const seq = this.beginRequest();
    this.status.set('thinking');
    this.isThinking.set(true);
    await this.handleLlmReply(gardenId, retryFor, seq, this.memory.activeTopic()?.id);
  }

  /** Hands the request to a local or Copilot background agent and confirms by voice. */
  private async handleAgentRequest(gardenId: string, text: string, requestSeq = this.requestSeq) {
    const signedIn = this.copilotAuth.signedIn();
    const explicitCopilot = shouldUseCopilot(text, signedIn);
    const wantsCopilot =
      explicitCopilot ||
      (this.agents.runtime() === 'copilot' && signedIn && this.detectAgentRequest(text));
    const chatId = this.threadId();

    if ((explicitCopilot || isGithubWorkRequest(text) || isFileWorkRequest(text)) && !signedIn) {
      this.pendingCopilot = { prompt: text, chatId };
      this.addGateMessage(chatId, 'signin', text, 'I can do that with GitHub Copilot. Sign in and I will continue.');
      await this.respond(chatId, 'Sign in with GitHub Copilot and I will take it from there.', undefined, undefined, undefined, requestSeq);
      return;
    }

    if (wantsCopilot) {
      if (this.gateCopilotIfNeeded(chatId, text)) return;
      this.startCopilotTask(text);
      await this.respond(
        chatId,
        'Okay, I will ask Copilot to work on that and let you know when it is ready.',
        undefined,
        undefined,
        undefined,
        requestSeq,
      );
      return;
    }

    const tools = this.mcp.tools();
    if (tools.length) {
      const toolDefs: AgentToolDef[] = tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.agents.runTask(text, toolDefs, (name, args) => this.runMcpTool(name, args));
    } else {
      this.agents.runTask(text);
    }

    // Kick off model loading in the background if it is not ready yet.
    this.agents.ensureLoaded().catch(() => {});

    const ack =
      'Okay, I will work on that in the background and let you know when it is ready.';
    this.respond(gardenId, ack, undefined, undefined, undefined, requestSeq);
  }

  private gateCopilotIfNeeded(chatId: string, text: string): boolean {
    const needsFiles = needsLocalFileAccess(text);
    if (needsFiles && !this.currentWorkspace()) {
      this.pendingCopilot = { prompt: text, chatId };
      this.addGateMessage(
        chatId,
        'workspace',
        text,
        'Choose a folder first. Copilot will work there.',
      );
      void this.speak('Choose a folder for this chat and I will continue.');
      this.isThinking.set(false);
      this.status.set('idle');
      return true;
    }
    if (needsFiles && !this.allowLocalTools() && !this.pendingCopilot?.allowOnce) {
      this.pendingCopilot = { prompt: text, chatId };
      this.addGateMessage(
        chatId,
        'tools',
        text,
        'Allow Copilot to create and edit files in this folder?',
      );
      void this.speak('Do you want to allow Copilot to change files in this folder?');
      this.isThinking.set(false);
      this.status.set('idle');
      return true;
    }
    return false;
  }

  private addGateMessage(chatId: string, kind: CopilotGateKind, prompt: string, text: string) {
    const message: Message = {
      role: 'ava',
      text,
      timestamp: new Date(),
      id: `gate-${Date.now()}-${kind}`,
      gate: { kind, prompt, status: 'open' },
    };
    this.setChatMessages(chatId, [...(this.messagesByChat()[chatId] || []), message]);
    this.scrollToBottom();
  }

  private closeOpenGates(chatId: string, status: 'done' | 'dismissed') {
    const msgs = this.messagesByChat()[chatId] || [];
    this.setChatMessages(
      chatId,
      msgs.map(msg =>
        msg.gate?.status === 'open' ? { ...msg, gate: { ...msg.gate, status } } : msg
      ),
    );
  }

  private startCopilotTask(text: string, allowOnce = false) {
    this.agents.runTask(text, {
      engine: 'copilot',
      agent: inferCopilotAgent(text),
      allowWrites: allowOnce || this.allowLocalTools(),
      chatId: this.threadId(),
    });
    this.agents.ensureLoaded().catch(() => {});
    this.pendingCopilot = null;
  }

  private async continuePendingCopilot() {
    const pending = this.pendingCopilot;
    if (!pending) return;
    if (this.chats.currentChatId() !== pending.chatId) this.chats.selectChat(pending.chatId);
    if (this.gateCopilotIfNeeded(pending.chatId, pending.prompt)) return;
    this.startCopilotTask(pending.prompt, pending.allowOnce === true);
    await this.respond(pending.chatId, 'Okay, Copilot is on it.');
  }

  /** Resolves an MCP tool by name and invokes it, returning text for the agent. */
  private async runMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.mcp.findTool(name);
    if (!tool) return `Tool "${name}" is not available.`;
    const result = await this.mcp.callTool(tool.serverId, name, args);
    return result.text || (result.isError ? 'The tool reported an error.' : 'Done.');
  }

  /** A few natural "give me a second" lines spoken before Gemma answers. */
  private pickThinkingFiller(): string {
    const fillers = [
      'Let me think about that, one second…',
      'Give me a moment to think about that…',
      'Hmm, let me think for a second…',
      'One moment while I think that through…',
    ];
    return fillers[Math.floor(Math.random() * fillers.length)];
  }

  /** Builds recent conversation history (excluding the latest user turn) for the LLM. */
  private buildChatHistory(gardenId: string, topicId?: string, maxTurns = 6): ChatTurn[] {
    const chatId = this.chats.chats().some(chat => chat.id === gardenId) ? gardenId : this.threadId();
    const msgs = this.messagesByChat()[chatId] || this.messagesByChat()[gardenId] || [];
    const turns: MemoryTurn[] = msgs.map(msg => ({
      role: msg.role,
      text: msg.text,
      timestamp: msg.timestamp,
      topicId: msg.topicId,
    }));
    return this.memory.historyForTopic(turns, topicId, maxTurns).map<ChatTurn>(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    }));
  }

  private currentAudio: HTMLAudioElement | null = null;
  /** Resolver for the in-flight chunk, invoked when playback is interrupted. */
  private currentChunkSettle: ((result: boolean) => void) | null = null;
  /** Increments on every new speak() call so stale chunk playback can self-cancel. */
  private speechGen = 0;

  private async speak(text: string): Promise<void> {
    const id = ++this.speechGen;
    this.debug.log('tts', `Speak (${this.tts.selectedVoiceId()})`, text);

    // Interrupt anything already speaking.
    this.isPaused.set(false);
    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();

    if (this.tts.selectedVoiceId() === 'grok') {
      const handled = await this.speakWithGrok(text, id);
      if (handled || this.speechGen !== id) return;
    }

    if (this.tts.selectedVoiceId() === 'kokoro') {
      const handled = await this.speakWithKokoro(text, id);
      if (handled || this.speechGen !== id) return;
    }

    if (this.speechGen !== id) return;
    await this.speakWithSystem(text, id);
  }

  private async speakWithGrok(text: string, id: number): Promise<boolean> {
    const spoken = markdownToPlainText(text);
    const chunks = splitIntoSpeechChunks(spoken);
    if (chunks.length === 0) return true;

    try {
      let pending = this.tts.synthesizeGrok(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        if (this.speechGen !== id) return true;
        let blob: Blob;
        try {
          blob = await pending;
        } catch (e) {
          if (i === 0) return false;
          console.warn('Grok TTS chunk failed', e);
          break;
        }
        pending = i + 1 < chunks.length ? this.tts.synthesizeGrok(chunks[i + 1]) : Promise.resolve(new Blob());
        if (this.speechGen !== id) return true;
        const ok = await this.playChunk(blob, id);
        if (!ok) {
          if (this.speechGen !== id) return true;
          if (i === 0) return false;
          break;
        }
      }
      return true;
    } catch (e) {
      console.warn('Grok TTS failed, falling back', e);
      return false;
    }
  }

  /**
   * Speaks long replies as a sequence of small chunks. The next chunk is
   * synthesised while the current one plays, so there is no audible gap between
   * sentences. Returns true when it handled playback (including when it was
   * interrupted by a newer utterance), false only on a genuine failure that
   * should fall back to the system voice.
   */
  private async speakWithKokoro(text: string, id: number): Promise<boolean> {
    if (!this.kokoro) {
      await this.preloadKokoro().catch(() => {});
    }
    if (!this.kokoro) return false;

    const spoken = markdownToPlainText(text);
    const chunks = splitIntoSpeechChunks(spoken);
    if (chunks.length === 0) return true;

    try {
      const voice = this.tts.selectedKokoroVoiceId();
      const synth = (chunk: string) => this.kokoro.generate(chunk, { voice, speed: 0.98 });

      // Pre-generate the first chunk, then keep one chunk ahead of playback.
      let pending: Promise<any> | null = synth(chunks[0]);

      for (let i = 0; i < chunks.length; i++) {
        if (this.speechGen !== id) return true; // superseded

        let audio: any;
        try {
          audio = await pending;
        } catch (e) {
          if (i === 0) return false; // first chunk failed → fall back
          console.warn('Kokoro chunk synthesis failed, stopping playback', e);
          break;
        }

        // Kick off synthesis of the next chunk before playing this one.
        pending = i + 1 < chunks.length ? synth(chunks[i + 1]) : null;

        if (this.speechGen !== id) return true; // superseded while synthesising

        const ok = await this.playChunk(audio.toBlob(), id);
        if (!ok) {
          if (this.speechGen !== id) return true; // interrupted
          if (i === 0) return false;              // playback error on first chunk
          break;
        }
      }
      return true;
    } catch (e) {
      console.warn('Kokoro TTS failed, falling back', e);
      return false;
    }
  }

  private async generateDownloadableAudio(text: string, sourceName: string) {
    if (this.isGeneratingAudioFile()) return;

    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    this.activeAudioExportController = controller;
    this.isGeneratingAudioFile.set(true);
    this.composerNotice.set('');
    this.audioExportTasks.update(tasks => ({
      ...tasks,
      [taskId]: { id: taskId, sourceName, status: 'running', current: 0, total: 0 }
    }));
    this.addAvaExportMessage(`Making audio from ${sourceName}...`, taskId);

    try {
      this.updateAvaExportMessage(taskId, `Preparing ${sourceName} for audio export...`);

      const useGrok = this.tts.selectedVoiceId() === 'grok' && this.xai.signedIn();
      if (!useGrok && !this.kokoro) {
        await this.preloadKokoro().catch(() => {});
      }
      if (!useGrok && !this.kokoro) {
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `I could not load Ava's voice model for ${sourceName}.`);
        return;
      }
      this.throwIfAudioExportAborted(controller.signal);

      const spoken = markdownToPlainText(text);
      const chunks = splitIntoSpeechChunks(spoken);
      if (chunks.length === 0) {
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `${sourceName} did not contain speakable text.`);
        return;
      }

      this.audioExportTasks.update(tasks => ({
        ...tasks,
        [taskId]: { ...tasks[taskId], total: chunks.length }
      }));

      if (useGrok) {
        const parts: Blob[] = [];
        for (let i = 0; i < chunks.length; i++) {
          this.throwIfAudioExportAborted(controller.signal);
          this.audioExportTasks.update(tasks => ({
            ...tasks,
            [taskId]: { ...tasks[taskId], current: i + 1 }
          }));
          this.updateAvaExportMessage(
            taskId,
            `Generating audio from ${sourceName} (${i + 1}/${chunks.length})...`
          );
          parts.push(await this.tts.synthesizeGrok(chunks[i]));
        }
        const filename = `${this.stripFileExtension(sourceName)}-ava.mp3`;
        const download = this.createAudioDownload(new Blob(parts, { type: 'audio/mpeg' }), filename);
        this.markAudioExportTask(taskId, 'complete');
        this.updateAvaExportMessage(
          taskId,
          `I transcribed ${sourceName} into Ava audio. Use the button below to download ${filename}.`,
          download.id
        );
        return;
      }

      const voice = this.tts.selectedKokoroVoiceId();
      const audioChunks: Float32Array[] = [];
      let sampleRate = 24000;

      for (let i = 0; i < chunks.length; i++) {
        this.throwIfAudioExportAborted(controller.signal);
        this.audioExportTasks.update(tasks => ({
          ...tasks,
          [taskId]: { ...tasks[taskId], current: i + 1 }
        }));
        this.updateAvaExportMessage(
          taskId,
          `Generating audio from ${sourceName} (${i + 1}/${chunks.length})...`
        );

        const audio = await this.generateKokoroAudioChunk(chunks[i], voice, this.kokoro, taskId);
        this.throwIfAudioExportAborted(controller.signal);
        audioChunks.push(this.extractKokoroSamples(audio));
        sampleRate = audio.sampling_rate ?? audio.sample_rate ?? sampleRate;
      }

      const filename = `${this.stripFileExtension(sourceName)}-ava.wav`;
      const wav = this.createWavBlob(this.concatAudioChunks(audioChunks), sampleRate);
      const download = this.createAudioDownload(wav, filename);

      this.markAudioExportTask(taskId, 'complete');
      this.updateAvaExportMessage(
        taskId,
        `I transcribed ${sourceName} into Ava audio. Use the button below to download ${filename}.`,
        download.id
      );
    } catch (e) {
      if (this.isAbortError(e)) {
        this.markAudioExportTask(taskId, 'aborted');
        this.updateAvaExportMessage(taskId, `Stopped audio export for ${sourceName}.`);
      } else {
        console.error('Audio file generation failed', e);
        this.markAudioExportTask(taskId, 'failed');
        this.updateAvaExportMessage(taskId, `I could not finish the audio export for ${sourceName}.`);
      }
    } finally {
      if (this.activeAudioExportController === controller) {
        this.activeAudioExportController = null;
      }
      this.isGeneratingAudioFile.set(false);
    }
  }

  private async generateKokoroAudioChunk(
    text: string,
    voice: string,
    engine = this.kokoro,
    taskId?: string
  ): Promise<any> {
    try {
      return await engine.generate(text, { voice, speed: 0.98 });
    } catch (e) {
      if (engine !== this.kokoro || !this.isRecoverableGpuError(e) || !this.kokoroLoadInfo().startsWith('webgpu')) {
        throw e;
      }

      console.warn('Kokoro WebGPU synthesis failed; retrying audio export on WASM', e);
      if (taskId) {
        this.updateAvaExportMessage(taskId, 'GPU voice synthesis stumbled. Retrying safely...');
      }
      const exporter = await this.ensureExportKokoro();
      if (!exporter) throw e;
      return await exporter.generate(text, { voice, speed: 0.98 });
    }
  }

  protected stopAudioExport(taskId: string) {
    const task = this.audioExportTasks()[taskId];
    if (!task || task.status !== 'running') return;

    this.markAudioExportTask(taskId, 'aborted');
    this.updateAvaExportMessage(taskId, `Stopping audio export for ${task.sourceName}...`);
    this.activeAudioExportController?.abort();
  }

  private throwIfAudioExportAborted(signal: AbortSignal) {
    if (!signal.aborted) return;
    const error = new Error('Audio export stopped.');
    error.name = 'AbortError';
    throw error;
  }

  private isAbortError(error: unknown): boolean {
    return (error as any)?.name === 'AbortError';
  }

  private isRecoverableGpuError(error: unknown): boolean {
    const message = String((error as any)?.message ?? error);
    return /GPUBuffer|mapAsync|external Instance|device lost|AbortError/i.test(message);
  }

  private concatAudioChunks(chunks: Float32Array[]): Float32Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  private extractKokoroSamples(audio: any): Float32Array {
    const samples = audio?.data ?? audio?.audio;
    if (samples instanceof Float32Array) return samples;
    if (Array.isArray(samples)) return this.concatAudioChunks(samples);
    throw new Error('Kokoro returned audio without PCM samples.');
  }

  private createWavBlob(samples: Float32Array, sampleRate: number): Blob {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    this.writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this.writeAscii(view, 8, 'WAVE');
    this.writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    this.writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += bytesPerSample;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  private writeAscii(view: DataView, offset: number, text: string) {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  protected audioDownloadFor(message: Message): AudioDownload | null {
    return message.downloadId ? this.audioDownloads()[message.downloadId] ?? null : null;
  }

  protected audioExportTaskFor(message: Message): AudioExportTask | null {
    return message.exportTaskId ? this.audioExportTasks()[message.exportTaskId] ?? null : null;
  }

  protected async copyMessage(message: Message): Promise<void> {
    const ok = await copyTextToClipboard(message.text);
    if (!ok) return;

    this.copiedMessageId.set(`${message.role}-${message.timestamp.getTime()}`);
    window.setTimeout(() => this.copiedMessageId.set(null), 1400);
  }

  protected isMessageCopied(message: Message): boolean {
    return this.copiedMessageId() === `${message.role}-${message.timestamp.getTime()}`;
  }

  protected messageTrack(message: Message): string {
    return message.id || messageSwipeKey(message);
  }

  protected forgetMessage(message: Message) {
    if (message.pending) return;
    this.removeMessage(this.threadId(), message);
    if (this.isMessageCopied(message)) this.copiedMessageId.set(null);
  }

  protected editMessageInComposer(message: Message) {
    const text = message.text.trim();
    if (!text) return;
    this.manualPrompt.set(text);
    this.setManualInputMode(true);
    setTimeout(() => this.resizeManualInput(), 0);
  }

  protected swipeTransform(message: Message): string {
    if (this.swipeKey() !== messageSwipeKey(message)) return '';
    return `translate3d(${this.swipeDx()}px, 0, 0)`;
  }

  protected swipeSheetSettling(message: Message): boolean {
    return this.swipeSettling() && this.swipeKey() === messageSwipeKey(message);
  }

  protected swipeShows(message: Message, side: 'left' | 'right'): boolean {
    return this.swipeKey() === messageSwipeKey(message) && this.swipeSide() === side;
  }

  protected swipeArmed(message: Message): boolean {
    return this.swipeKey() === messageSwipeKey(message) && this.swipeArmedFlag();
  }

  protected swipeHint(message: Message): 'delete' | 'edit' | null {
    if (!this.swipeArmed(message)) return null;
    return this.swipeSide() === 'left' ? 'delete' : this.swipeSide() === 'right' ? 'edit' : null;
  }

  protected onMessagePointerDown(event: PointerEvent, message: Message) {
    if (event.button !== 0 || message.pending) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, label, .photo-open')) return;
    this.clearSwipe();
    const sheet = event.currentTarget as HTMLElement;
    const width = sheet.closest('.message-swipe')?.clientWidth || sheet.clientWidth || 240;
    this.messageSwipe = {
      key: messageSwipeKey(message),
      message,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      armed: false,
      width,
      sheet,
    };
    this.swipeKey.set(this.messageSwipe.key);
    this.swipeDx.set(0);
    this.swipeSide.set(null);
    this.swipeArmedFlag.set(false);
    this.swipeSettling.set(false);
  }

  protected onMessagePointerMove(event: PointerEvent, message: Message) {
    const swipe = this.messageSwipe;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (messageSwipeKey(message) !== swipe.key) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.armed) {
      const intent = swipeIntent(dx, dy, event.pointerType === 'mouse' ? 22 : 10);
      if (intent === 'vertical') {
        this.clearSwipe();
        return;
      }
      if (intent !== 'horizontal') return;
      swipe.armed = true;
      try {
        swipe.sheet.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; mouse still tracks while over the sheet.
      }
    }
    event.preventDefault();
    swipe.dx = dx;
    this.swipeDx.set(rubberbandSwipe(dx, Math.min(160, swipe.width * 0.72)));
    this.swipeSide.set(dx < -4 ? 'left' : dx > 4 ? 'right' : null);
    this.swipeArmedFlag.set(!!swipeCommitAction(dx));
  }

  protected onMessagePointerUp(event: PointerEvent, message: Message) {
    const swipe = this.messageSwipe;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (messageSwipeKey(message) !== swipe.key) return;
    if (!swipe.armed) {
      this.clearSwipe();
      return;
    }
    this.finishSwipe(true);
  }

  protected onMessagePointerCancel(event: PointerEvent, message: Message) {
    const swipe = this.messageSwipe;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    if (messageSwipeKey(message) !== swipe.key) return;
    this.finishSwipe(false);
  }

  private finishSwipe(commit: boolean) {
    const swipe = this.messageSwipe;
    if (!swipe) return;
    const action = commit && swipe.armed ? swipeCommitAction(swipe.dx) : null;
    this.swipeSettling.set(true);
    if (action === 'delete') {
      this.swipeDx.set(swipe.dx < 0 ? -(swipe.width + 56) : swipe.width + 56);
      this.swipeTimer = setTimeout(() => {
        this.forgetMessage(swipe.message);
        this.clearSwipe();
      }, 180);
      return;
    }
    if (action === 'edit') {
      this.swipeDx.set(0);
      this.editMessageInComposer(swipe.message);
      this.swipeTimer = setTimeout(() => this.clearSwipe(), 180);
      return;
    }
    this.swipeArmedFlag.set(false);
    this.swipeDx.set(0);
    this.swipeTimer = setTimeout(() => this.clearSwipe(), 180);
  }

  private clearSwipe() {
    if (this.swipeTimer) {
      clearTimeout(this.swipeTimer);
      this.swipeTimer = null;
    }
    const sheet = this.messageSwipe?.sheet;
    const pointerId = this.messageSwipe?.pointerId;
    if (sheet && pointerId != null) {
      try {
        if (sheet.hasPointerCapture(pointerId)) sheet.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
    }
    this.messageSwipe = null;
    this.swipeKey.set(null);
    this.swipeDx.set(0);
    this.swipeSide.set(null);
    this.swipeArmedFlag.set(false);
    this.swipeSettling.set(false);
  }

  protected isAudioPreviewActive(downloadId: string): boolean {
    return this.activeAudioPreviewId() === downloadId && !this.audioPreviewPaused();
  }

  protected async toggleAudioPreview(download: AudioDownload) {
    if (this.activeAudioPreviewId() === download.id && this.audioPreviewPlayer) {
      if (this.audioPreviewPaused()) {
        await this.audioPreviewPlayer.play().catch(() => {});
        this.audioPreviewPaused.set(false);
      } else {
        this.audioPreviewPlayer.pause();
        this.audioPreviewPaused.set(true);
      }
      return;
    }

    this.stopAudioPreview();
    const player = new Audio(download.url);
    this.audioPreviewPlayer = player;
    this.activeAudioPreviewId.set(download.id);
    this.audioPreviewPaused.set(false);

    const settle = () => {
      if (this.audioPreviewPlayer === player) {
        this.audioPreviewPlayer = null;
        this.activeAudioPreviewId.set(null);
        this.audioPreviewPaused.set(false);
      }
    };
    player.onended = settle;
    player.onerror = settle;
    await player.play().catch(settle);
  }

  private async afterWorkspaceChosen() {
    this.closeOpenGates(this.threadId(), 'done');
    if (this.pendingImageSave) {
      await this.flushPendingImageSave();
      return;
    }
    void this.continuePendingCopilot();
  }

  private async flushPendingImageSave() {
    const pending = this.pendingImageSave;
    if (!pending) return;
    this.pendingImageSave = null;
    const folder = this.currentWorkspace();
    if (!folder) {
      await this.respond(pending.chatId, 'Choose a folder and I will save the photos there.');
      return;
    }
    const saved = await this.saveImagesToWorkspace(pending.images, folder);
    const spoken = saved.length
      ? spokenImageSaveReply(saved.length, folder)
      : 'I could not save those photos to that folder. You can still save them from the photo.';
    await this.respond(pending.chatId, spoken);
  }

  protected async saveChatImage(image: GeneratedImage, event?: Event) {
    event?.stopPropagation();
    const filename = imageFileName(image);
    try {
      const blob = await dataUrlToBlob(image.dataUrl);
      const savePicker = (window as any).showSaveFilePicker;
      if (typeof savePicker === 'function') {
        try {
          const handle = await savePicker({
            suggestedName: filename,
            types: [
              {
                description: 'Photo',
                accept: { 'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'] },
              },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (e) {
          if ((e as any)?.name === 'AbortError') return;
          console.warn('Save picker failed; falling back to download', e);
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      console.warn('Could not save photo', e);
      this.composerNotice.set('Could not save that photo.');
    }
  }

  private async saveImagesToWorkspace(images: GeneratedImage[], folder: string): Promise<string[]> {
    const saved: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const filename = imageFileName(image, i);
      const path = joinPath(folder, filename);
      try {
        const bytes = await dataUrlToBytes(image.dataUrl);
        this.debug.log('command', 'write_file_bytes', path);
        await invoke('write_file_bytes', { path, contents: Array.from(bytes) });
        saved.push(path);
      } catch (e) {
        console.warn('Could not write photo to workspace', e);
      }
    }
    return saved;
  }

  protected async saveAudioDownload(download: AudioDownload) {
    const savePicker = (window as any).showSaveFilePicker;
    if (typeof savePicker === 'function') {
      try {
        const handle = await savePicker({
          suggestedName: download.filename,
          types: [
            {
              description: 'WAV audio',
              accept: { 'audio/wav': ['.wav'] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(download.blob);
        await writable.close();
        return;
      } catch (e) {
        if ((e as any)?.name === 'AbortError') return;
        console.warn('Save picker failed; falling back to browser download', e);
      }
    }

    const link = document.createElement('a');
    link.href = download.url;
    link.download = download.filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private createAudioDownload(blob: Blob, filename: string): AudioDownload {
    const url = URL.createObjectURL(blob);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const download = { id, filename, url, blob, sizeBytes: blob.size };
    this.audioDownloads.update(downloads => ({ ...downloads, [id]: download }));
    return download;
  }

  private addAvaExportMessage(text: string, exportTaskId: string) {
    const chatId = this.threadId();
    if (!chatId) return;

    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    currentMsgs.push({ role: 'ava', id: nextMessageId(), text, timestamp: new Date(), exportTaskId });
    this.setChatMessages(chatId, currentMsgs);
    this.scrollToBottom();
  }

  private updateAvaExportMessage(exportTaskId: string, text: string, downloadId?: string) {
    const chatId = this.threadId();
    if (!chatId) return;

    const currentMsgs = this.messagesByChat()[chatId] || [];
    const nextMsgs = currentMsgs.map(msg =>
      msg.exportTaskId === exportTaskId
        ? { ...msg, text, downloadId: downloadId ?? msg.downloadId }
        : msg
    );
    this.setChatMessages(chatId, nextMsgs);
    this.scrollToBottom();
  }

  private markAudioExportTask(taskId: string, status: AudioExportTask['status']) {
    this.audioExportTasks.update(tasks => {
      const task = tasks[taskId];
      if (!task) return tasks;
      return { ...tasks, [taskId]: { ...task, status } };
    });
  }

  private addAvaMessage(text: string) {
    const chatId = this.threadId();
    if (!chatId) return;

    const currentMsgs = [...(this.messagesByChat()[chatId] || [])];
    currentMsgs.push({ role: 'ava', id: nextMessageId(), text, timestamp: new Date() });
    this.setChatMessages(chatId, currentMsgs);
    this.scrollToBottom();
  }

  private speakWithSystem(text: string, id: number): Promise<void> {
    return new Promise<void>(resolve => {
      if (!this.synth) {
        resolve();
        return;
      }
      try {
        this.synth.cancel();
        const utterance = new SpeechSynthesisUtterance(markdownToPlainText(text));
        utterance.rate = 0.96;
        utterance.pitch = 1.02;
        utterance.volume = 0.92;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        if (this.speechGen !== id) {
          resolve();
          return;
        }
        this.synth.speak(utterance);
      } catch {
        resolve();
      }
    });
  }

  /** Plays a single pre-generated audio chunk, resolving when it finishes. */
  private playChunk(blob: Blob, id: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const url = URL.createObjectURL(blob);
      const player = new Audio(url);
      this.currentAudio = player;

      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        this.currentChunkSettle = null;
        URL.revokeObjectURL(url);
        if (this.currentAudio === player) this.currentAudio = null;
        resolve(result);
      };

      // Interruptions are signalled explicitly via stopCurrentAudio(), not via
      // the 'pause' event — Chromium fires 'pause' at natural end-of-media too,
      // which would otherwise be mistaken for an interruption.
      this.currentChunkSettle = () => finish(false);

      player.onended = () => finish(true);
      player.onerror = () => finish(false);

      player.play().catch(() => finish(false));
    });
  }

  /** Plays a pre-generated sample for a Kokoro speaker when it is selected. */
  protected async previewVoice(voiceId: string) {
    if (this.tts.selectedVoiceId() === 'grok' || this.tts.grokVoiceCatalog().some(v => v.id === voiceId)) {
      const name = this.tts.grokVoiceCatalog().find(v => v.id === voiceId)?.name ?? 'Ava';
      await this.speak(`Hi, I am ${name}.`);
      return;
    }
    const previewUrl = this.tts.getKokoroPreviewAudioUrl(voiceId);
    const resolvedUrl = new URL(previewUrl, window.location.href).toString();

    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();

    try {
      this.status.set('speaking');
      const player = new Audio(resolvedUrl);
      this.currentAudio = player;
      player.onended = () => {
        if (this.currentAudio === player) this.currentAudio = null;
        if (this.status() === 'speaking') this.status.set('idle');
      };
      player.onerror = () => {
        if (this.currentAudio === player) this.currentAudio = null;
        if (this.status() === 'speaking') this.status.set('idle');
      };
      await player.play();
    } catch (e) {
      console.warn('Voice preview failed', e);
      const name = this.tts.kokoroVoices.find(v => v.id === voiceId)?.name ?? 'Ava';
      const text = `Hi, I am ${name}, how are you feeling today?`;
      this.speakWithSystem(text, ++this.speechGen);
    }
  }

  private stopCurrentAudio() {
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
      } catch {
        // ignore
      }
      this.currentAudio = null;
    }
    // Resolve any awaiting chunk as interrupted so its loop can exit cleanly.
    if (this.currentChunkSettle) {
      const settle = this.currentChunkSettle;
      this.currentChunkSettle = null;
      settle(false);
    }
  }

  /** Toggles pause/resume of Ava's current speech. */
  protected togglePause() {
    if (this.isPaused()) {
      this.resumeSpeaking();
    } else {
      this.pauseSpeaking();
    }
  }

  /** Pauses the current spoken reply without discarding the rest of it. */
  protected pauseSpeaking() {
    if (this.status() !== 'speaking' || this.isPaused()) return;
    this.isPaused.set(true);
    // Pause directly (not via stopCurrentAudio) so the chunk promise stays
    // pending and resumes from where it left off.
    try {
      this.currentAudio?.pause();
    } catch {
      // ignore
    }
    try {
      this.synth?.pause();
    } catch {
      // ignore
    }
  }

  /** Resumes a paused reply. */
  protected resumeSpeaking() {
    if (!this.isPaused()) return;
    this.isPaused.set(false);
    try {
      void this.currentAudio?.play()?.catch(() => {});
    } catch {
      // ignore
    }
    try {
      this.synth?.resume();
    } catch {
      // ignore
    }
  }

  /** Stops Ava speaking entirely and discards any remaining chunks. */
  protected stopSpeaking() {
    // Supersede the active chunk loop so no further chunks are played.
    this.speechGen++;
    this.isPaused.set(false);
    this.stopCurrentAudio();
    if (this.synth) this.synth.cancel();
    if (this.status() === 'speaking') this.status.set('idle');
    this.resumeVoiceCaptureIfEnabled();
  }

  private beginRequest(): number {
    this.requestSeq += 1;
    return this.requestSeq;
  }

  private isCurrentRequest(seq: number): boolean {
    return seq === this.requestSeq;
  }

  /** Aborts the in-flight reply, image job, or spoken response. */
  protected stopCurrentRequest() {
    this.debug.log('command', 'Abort current request');
    this.requestSeq += 1;
    this.llm.cancel();
    this.agents.abortActive();
    this.stopSpeaking();
    if (this.activeAudioExportController) {
      this.activeAudioExportController.abort();
    }
    this.isThinking.set(false);
    if (this.status() !== 'listening') this.status.set('idle');
  }

  private async playAudioBlob(blob: Blob): Promise<boolean> {
    this.stopCurrentAudio();
    const url = URL.createObjectURL(blob);
    const player = new Audio(url);
    this.currentAudio = player;
    const settle = () => {
      URL.revokeObjectURL(url);
      if (this.currentAudio === player) this.currentAudio = null;
      if (this.status() === 'speaking') this.status.set('idle');
    };
    player.onended = settle;
    player.onerror = settle;
    try {
      await player.play();
      return true;
    } catch {
      settle();
      return false;
    }
  }

  private stopAudioPreview() {
    if (this.audioPreviewPlayer) {
      try {
        this.audioPreviewPlayer.pause();
      } catch {
        // ignore
      }
      this.audioPreviewPlayer = null;
    }
    this.activeAudioPreviewId.set(null);
    this.audioPreviewPaused.set(false);
  }

  private generateAvaResponse(input: string): string | null {
    const lower = input.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();

    if (isAskingForTime(input)) {
      return `It is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    }
    if (isAskingCapabilities(input)) {
      return AVA_CAPABILITIES_REPLY;
    }
    if (isAskingWhatSheRemembers(input)) {
      const topic = this.memory.activeTopic()?.title;
      return topic
        ? `I am holding ${topic}, and whatever else we have put in this home. You can walk through it whenever you want.`
        : 'I keep what matters in this home, as files. You can walk through it whenever you want.';
    }
    if (/^(hi|hello|hey)(?:\s+ava)?$/.test(lower)) {
      const name = this.userName();
      return name ? `Hello, ${name}. It is good to be with you.` : 'Hello. It is good to be with you.';
    }
    if (/^how are you(?: doing| today)?$/.test(lower)) {
      return 'I am here, and I am listening. How are you feeling?';
    }
    if (/^what(?:'s| is) your name$/.test(lower) || /^who are you$/.test(lower)) {
      return 'I am Ava.';
    }
    if (/^(thanks|thank you|thank you ava)$/.test(lower)) {
      return 'You are welcome. I am here.';
    }
    if (isExplicitRemember(input)) return null;

    return null;
  }

  private simulateVoiceInput() {
    // Graceful fallback (used if mic denied or model fails to load)
    const demoPhrases = [
      'Hello Ava',
      'How are you today',
      'What time is it',
      'What can you do',
      'I feel a bit tired',
      'Tell me something calm'
    ];
    const phrase = demoPhrases[Math.floor(Math.random() * demoPhrases.length)];

    this.currentTranscript.set(phrase);
    this.isListening.set(true);
    this.status.set('listening');

    setTimeout(() => {
      this.isListening.set(false);
      this.status.set('idle');
      this.handleUserSpeech(phrase);
    }, 850);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected clearConversation() {
    this.composerMenuOpen.set(false);
    this.resetCurrentConversation();
  }

  private resetCurrentConversation(_gardenId?: string) {
    this.memory.markConversationCleared();
    this.memory.clearConversationFocus();
    this.chats.touch(this.threadId(), 'New chat');
    this.setChatMessages(this.threadId(), []);
    this.currentTranscript.set('');
    this.manualPrompt.set('');
    this.pendingFiles.set([]);
    this.pendingImages.set([]);
    this.composerNotice.set('');
    this.status.set('idle');
    this.speechGen++;
    this.isPaused.set(false);
    this.stopCurrentAudio();
    this.stopAudioPreview();
    if (this.synth) this.synth.cancel();
    this.scrollToBottom();
  }

  private async clearBrowserDatabases(): Promise<void> {
    const indexedDb = window.indexedDB;
    if (!indexedDb) return;

    try {
      const databases = typeof indexedDb.databases === 'function'
        ? await indexedDb.databases()
        : [];

      await Promise.all(
        databases
          .map(database => database.name)
          .filter((name): name is string => !!name)
          .map(name => this.deleteIndexedDatabase(indexedDb, name))
      );
    } catch (e) {
      console.warn('Failed to enumerate IndexedDB databases', e);
    }
  }

  private deleteIndexedDatabase(indexedDb: IDBFactory, name: string): Promise<void> {
    return new Promise(resolve => {
      try {
        const request = indexedDb.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private async clearBrowserCaches(): Promise<void> {
    try {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    } catch (e) {
      console.warn('Failed to clear browser caches', e);
    }
  }

  private scrollToBottom() {
    const doScroll = () => {
      const el = this.transcriptEl?.nativeElement;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    };
    // Double rAF handles the common case once layout has settled…
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
    // …and a short delayed pass corrects for long replies whose height keeps
    // growing after the first paint (e.g. multi-paragraph Ava answers).
    setTimeout(doScroll, 160);
  }

  /** Renders an Ava reply's markdown into sanitized HTML for display. */
  protected formatMessage(text: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markdownToHtml(text));
  }

  protected formatTime(date: Date | string): string {
    const value = date instanceof Date ? date : new Date(date);
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  protected formatGenDuration(ms: number): string {
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  }

  private closeComposerMenuIfOutside(target: EventTarget | null) {
    if (!this.composerMenuOpen()) return;

    const shell = this.primaryActionShellEl?.nativeElement;
    const node = target as Node | null;
    if (shell && node && !shell.contains(node)) {
      this.composerMenuOpen.set(false);
    }
  }

  private closeModelMenuIfOutside(target: EventTarget | null) {
    if (!this.modelMenuOpen()) return;

    const shell = this.settingsActionShellEl?.nativeElement;
    const node = target as Node | null;
    if (shell && node && !shell.contains(node)) {
      this.modelMenuOpen.set(false);
    }
  }

  private closeWorkspaceMenuIfOutside(target: EventTarget | null) {
    if (!this.workspaceMenuOpen() && !this.workspaceDraftOpen()) return;
    const shell = this.workspaceShellEl?.nativeElement;
    const node = target as Node | null;
    if (shell && node && !shell.contains(node)) {
      this.workspaceMenuOpen.set(false);
      this.workspaceDraftOpen.set(false);
    }
  }

  protected folderLabel(path: string): string {
    return this.gardensService.workspaceLabel(path);
  }

  protected toggleWorkspaceMenu(event: Event) {
    event.stopPropagation();
    this.workspaceMenuOpen.update(open => !open);
    this.workspaceDraftOpen.set(false);
  }

  protected toggleLocalTools() {
    this.chats.setAllowLocalTools(!this.allowLocalTools());
  }

  protected chooseRecentWorkspace(path: string) {
    this.chats.setWorkspace(path);
    this.workspaceMenuOpen.set(false);
    this.workspaceDraftOpen.set(false);
    void this.afterWorkspaceChosen();
  }

  protected startWorkspaceDraft() {
    this.workspaceDraft.set(this.currentWorkspace());
    this.workspaceDraftOpen.set(true);
    this.workspaceMenuOpen.set(true);
  }

  protected commitWorkspaceDraft() {
    this.chats.setWorkspace(this.workspaceDraft());
    this.workspaceDraftOpen.set(false);
    this.workspaceMenuOpen.set(false);
    void this.afterWorkspaceChosen();
  }

  async pickWorkspaceFolder() {
    this.workspaceMenuOpen.set(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('copilot_pick_folder');
      if (path?.trim()) {
        this.chats.setWorkspace(path.trim());
        void this.afterWorkspaceChosen();
        return;
      }
    } catch {
      // Browser or older host — fall through to a typed path.
    }
    this.startWorkspaceDraft();
  }

  async connectCopilotFromChat() {
    if (this.copilotAuth.loginPending() || this.copilotAuth.signedIn()) return;
    try {
      await this.copilotAuth.loginWithGitHub();
      if (this.copilotAuth.signedIn()) {
        this.agents.setRuntime('copilot');
        this.closeOpenGates(this.threadId(), 'done');
        void this.continuePendingCopilot();
      }
    } catch {
      // surfaced on the inline card
    }
  }

  protected allowToolsOnce() {
    if (this.pendingCopilot) this.pendingCopilot.allowOnce = true;
    this.closeOpenGates(this.threadId(), 'done');
    void this.continuePendingCopilot();
  }

  protected allowToolsAlways() {
    this.chats.setAllowLocalTools(true);
    this.closeOpenGates(this.threadId(), 'done');
    void this.continuePendingCopilot();
  }

  protected denyTools() {
    this.closeOpenGates(this.threadId(), 'dismissed');
    this.pendingCopilot = null;
    const chatId = this.threadId();
    void this.respond(chatId, 'Okay, I will not change files.');
  }

  openCopilotVerification() {
    void this.copilotAuth.openVerificationPage();
  }

  cancelCopilotLogin() {
    this.copilotAuth.cancelLogin();
  }

  private isTextFile(file: File): boolean {
    const type = file.type.toLowerCase();
    if (type.startsWith('text/')) return true;
    if (/(json|javascript|typescript|xml|yaml)/.test(type)) return true;

    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension ? this.TEXT_FILE_EXTENSIONS.has(extension) : false;
  }

  private stripFileExtension(filename: string): string {
    const withoutExtension = filename.replace(/\.[^/.]+$/, '');
    return withoutExtension.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'ava-audio';
  }
}
