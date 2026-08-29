import { Component, Output, EventEmitter, inject, Input, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { MemoryService } from '../services/memory';
import { TtsService, TtsEngine, ListenMode } from '../services/tts';
import { MCP_PRESETS, McpService, GITHUB_OAUTH_DEFAULTS } from '../services/mcp';
import { McpAuthMethod, McpServerConfig, McpServerStatus } from '../services/mcp/mcp-types';
import { LlmService } from '../services/llm';
import { AgentsService } from '../services/agents';
import { HardwareDiagnosticsService } from '../services/hardware-diagnostics';
import { XaiAuthService } from '../services/xai/xai-auth';
import { CopilotAuthService } from '../services/copilot/copilot-auth';
import { UpdateService } from '../services/updates';
import { ConfirmDialogService } from '../services/confirm-dialog';
import { ThemePreference, ThemeService } from '../services/theme';
import { GardensService } from '../services/gardens';
import { GrokCliService } from '../services/grok-cli';
import { DebugLogService } from '../services/debug-log';
import { SelfImproveService } from '../services/self-improve';

interface ModelFileInfo {
  name: string;
  sizeBytes: number;
  partial: boolean;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css'
})
export class Settings {
  private readonly memory = inject(MemoryService);
  private readonly ttsService = inject(TtsService);
  private readonly mcp = inject(McpService);
  private readonly llmService = inject(LlmService);
  private readonly agentsService = inject(AgentsService);
  private readonly hardwareDiagnostics = inject(HardwareDiagnosticsService);
  private readonly xai = inject(XaiAuthService);
  private readonly copilotAuth = inject(CopilotAuthService);
  private readonly updates = inject(UpdateService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly theme = inject(ThemeService);
  private readonly gardensService = inject(GardensService);
  private readonly grokBuild = inject(GrokCliService);
  private readonly debugLog = inject(DebugLogService);
  private readonly selfImprove = inject(SelfImproveService);
  protected readonly debugAvailable = this.debugLog.available;
  protected readonly selfImproveDesktop = this.selfImprove.desktop;
  protected readonly selfImproveStatus = this.selfImprove.status;
  protected selfImproveError = '';
  protected readonly gardens = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;
  protected gardenError = '';
  protected newGardenName = '';
  protected readonly themePreference = this.theme.preference;
  protected readonly resolvedTheme = this.theme.resolved;
  protected readonly homePath = this.memory.homePath;
  protected readonly homeLabel = this.memory.homeLabel;
  protected readonly desktopHome = this.memory.desktop;
  protected readonly hardware = this.hardwareDiagnostics.diagnostics;
  protected readonly hardwareReadinessLabel = this.hardwareDiagnostics.readinessLabel;
  protected readonly hardwareReadinessDetails = this.hardwareDiagnostics.readinessDetails;

  // MCP (Model Context Protocol) servers
  protected readonly mcpServers = this.mcp.servers;
  protected readonly mcpStatuses = this.mcp.statuses;
  protected readonly mcpPresets = MCP_PRESETS;
  protected readonly builtInMcpServers = this.mcp.builtInServers;

  newMcpName = '';
  newMcpUrl = '';
  newMcpAuth: McpAuthMethod = 'none';
  newMcpPat = '';
  patDrafts: Record<string, string> = {};
  oauthClientDrafts: Record<string, string> = {};
  oauthScopeDrafts: Record<string, string> = {};
  mcpBusy: Record<string, boolean> = {};
  mcpError = '';
  apiKeyDraft = '';
  xaiBusy = false;
  patDraft = '';
  copilotBusy = false;

  constructor() {
    // Seed per-server OAuth drafts from persisted config so saved values show.
    for (const s of this.mcpServers()) {
      if (s.oauth?.clientId) this.oauthClientDrafts[s.id] = s.oauth.clientId;
      if (s.oauth?.scope) this.oauthScopeDrafts[s.id] = s.oauth.scope;
    }
    void this.loadMcpServerInfo();
    void this.refreshModelFiles();
    if (this.xai.signedIn()) void this.ttsService.refreshGrokVoices();
    if (this.grokBuild.desktop()) void this.grokBuild.boot();
    if (this.selfImprove.desktop()) void this.selfImprove.refresh();
    effect(() => {
      this.workspaceDraft = this.agentsService.workspace();
    });
  }

  statusFor(id: string): McpServerStatus | undefined {
    return this.mcpStatuses()[id];
  }

  toolCount(id: string): number {
    return this.statusFor(id)?.tools.length ?? 0;
  }

  presetAdded(preset: { url: string }): boolean {
    return this.mcpServers().some((s) => s.url === preset.url);
  }

  addPreset(preset: Omit<McpServerConfig, 'id' | 'enabled'>) {
    this.mcpError = '';
    const server = this.mcp.addPreset(preset);
    this.patDrafts[server.id] = '';
  }

  addMcpServer() {
    this.mcpError = '';
    const name = this.newMcpName.trim();
    const url = this.newMcpUrl.trim();
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) {
      this.mcpError = 'Server URL must start with http:// or https://';
      return;
    }
    const server = this.mcp.addServer({
      name,
      url,
      auth: this.newMcpAuth,
      pat: this.newMcpAuth === 'pat' ? this.newMcpPat.trim() || undefined : undefined,
    });
    this.newMcpName = '';
    this.newMcpUrl = '';
    this.newMcpAuth = 'none';
    this.newMcpPat = '';
    if (server.auth !== 'oauth') {
      void this.connectMcp(server.id);
    }
  }

  async connectMcp(id: string) {
    this.mcpError = '';
    this.mcpBusy[id] = true;
    try {
      await this.mcp.connect(id);
    } finally {
      this.mcpBusy[id] = false;
    }
  }

  async authenticateMcp(id: string) {
    this.mcpError = '';
    this.mcpBusy[id] = true;
    try {
      await this.mcp.authenticate(id);
    } catch (err) {
      this.mcpError = err instanceof Error ? err.message : String(err);
    } finally {
      this.mcpBusy[id] = false;
    }
  }

  async savePat(id: string) {
    const token = (this.patDrafts[id] ?? '').trim();
    if (!token) return;
    this.mcp.updateServer(id, { auth: 'pat', pat: token });
    this.patDrafts[id] = '';
    await this.connectMcp(id);
  }

  /** Switches a server's auth method, pre-filling GitHub's OAuth endpoints. */
  setServerAuth(server: McpServerConfig, method: McpAuthMethod) {
    this.mcpError = '';
    const patch: Partial<McpServerConfig> = { auth: method };
    if (method === 'oauth') {
      const existing = server.oauth ?? {};
      patch.oauth =
        server.preset === 'github'
          ? { ...GITHUB_OAUTH_DEFAULTS, ...existing }
          : existing;
      this.oauthClientDrafts[server.id] = patch.oauth.clientId ?? '';
      this.oauthScopeDrafts[server.id] = patch.oauth.scope ?? '';
    }
    this.mcp.updateServer(server.id, patch);
  }

  /** Saves the OAuth client ID (+ optional scope) entered for a server. */
  saveOAuth(server: McpServerConfig) {
    this.mcpError = '';
    const clientId = (this.oauthClientDrafts[server.id] ?? '').trim();
    const scope = (this.oauthScopeDrafts[server.id] ?? '').trim();
    if (!clientId) {
      this.mcpError = 'A client ID is required for OAuth.';
      return;
    }
    const oauth = {
      ...(server.preset === 'github' ? GITHUB_OAUTH_DEFAULTS : {}),
      ...(server.oauth ?? {}),
      clientId,
      scope: scope || server.oauth?.scope,
    };
    this.mcp.updateServer(server.id, { auth: 'oauth', oauth });
  }

  disconnectMcp(id: string) {
    this.mcp.disconnect(id);
  }

  async removeMcp(id: string) {
    const ok = await this.confirm.ask({
      title: 'Remove this MCP server?',
      message: 'Ava will disconnect and forget this server.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) this.mcp.removeServer(id);
  }

  // Text-to-speech configuration
  protected readonly voices = this.ttsService.voices;
  protected readonly selectedVoiceId = this.ttsService.selectedVoiceId;
  protected readonly kokoroVoices = this.ttsService.kokoroVoices;
  protected readonly selectedKokoroVoiceId = this.ttsService.selectedKokoroVoiceId;
  protected readonly isRecording = signal(false);
  protected readonly recordSeconds = signal(0);
  private mediaRecorder: MediaRecorder | null = null;
  private recordTimer: ReturnType<typeof setInterval> | null = null;
  protected readonly conversationModels = this.llmService.models;
  protected readonly selectedConversationModel = this.llmService.selectedModel;
  protected readonly activeConversationModel = this.llmService.activeModel;
  protected readonly conversationLoadInfo = this.llmService.loadInfo;
  protected readonly conversationReady = this.llmService.isReady;
  protected readonly conversationLoading = this.llmService.isLoading;

  // Local model storage (Tauri: GGUF files in the app data dir).
  protected readonly modelFiles = signal<ModelFileInfo[]>([]);
  protected readonly modelStorageAvailable = signal(false);
  protected readonly modelStorageTotal = computed(() =>
    this.modelFiles().reduce((sum, file) => sum + file.sizeBytes, 0)
  );
  protected readonly agentModels = this.agentsService.models;
  protected readonly selectedAgentModel = this.agentsService.selectedModel;
  protected readonly activeAgentModel = this.agentsService.activeModel;
  protected readonly agentLoadInfo = this.agentsService.loadInfo;
  protected readonly agentReady = this.agentsService.isReady;
  protected readonly agentLoading = this.agentsService.isLoading;
  protected readonly selectedVoice = this.ttsService.selectedVoice;
  protected readonly selectedKokoroVoice = this.ttsService.selectedKokoroVoice;
  protected readonly grokVoices = this.ttsService.grokVoiceCatalog;
  protected readonly selectedGrokVoiceId = this.ttsService.selectedGrokVoiceId;
  protected readonly xaiSignedIn = this.xai.signedIn;
  protected readonly xaiNeedsReauth = this.xai.needsReauth;
  protected readonly xaiMethod = this.xai.method;
  protected readonly xaiAccount = this.xai.accountLabel;
  protected readonly xaiError = this.xai.error;
  protected readonly xaiPending = this.xai.loginPending;
  protected readonly xaiDevice = this.xai.deviceLogin;
  protected readonly grokCliAvailable = this.xai.grokCliAvailable;
  protected readonly grokBuildDesktop = this.grokBuild.desktop;
  protected readonly grokBuildInfo = this.grokBuild.grokInfo;
  protected readonly grokBuildPhase = this.grokBuild.phase;
  protected readonly intelligenceMode = this.llmService.intelligenceMode;
  protected readonly cloudExclusive = this.llmService.isCloudExclusive;
  protected readonly copilotSignedIn = this.copilotAuth.signedIn;
  protected readonly copilotMethod = this.copilotAuth.method;
  protected readonly copilotAccount = this.copilotAuth.accountLabel;
  protected readonly copilotError = this.copilotAuth.error;
  protected readonly copilotPending = this.copilotAuth.loginPending;
  protected readonly copilotDevice = this.copilotAuth.deviceLogin;
  protected readonly copilotHost = this.copilotAuth.host;
  protected readonly ghCliAvailable = this.copilotAuth.ghCliAvailable;
  protected readonly agentRuntime = this.agentsService.runtime;
  protected readonly updatesSupported = this.updates.supported;
  protected readonly updatePhase = this.updates.phase;
  protected readonly updateAvailable = this.updates.available;
  protected readonly updateError = this.updates.error;
  protected readonly appVersion = this.updates.currentVersion;
  protected readonly updateStatus = computed(() => {
    const available = this.updateAvailable();
    switch (this.updatePhase()) {
      case 'checking':
        return 'Checking GitHub for a newer desktop build…';
      case 'available':
        return available ? `Version ${available.version} is ready to install.` : 'An update is available.';
      case 'up-to-date':
        return 'You are on the latest published desktop build.';
      case 'downloading':
        return 'Downloading the update…';
      case 'installing':
        return 'Installing the update. Ava will restart.';
      case 'error':
        return this.updateError() || 'Could not check for updates.';
      case 'unsupported':
        return 'Desktop updates are available in the installed Ava app.';
      default:
        return this.updatesSupported()
          ? 'Ava checks GitHub Releases for new desktop builds.'
          : 'Install the desktop app to receive updates from GitHub Releases.';
    }
  });
  protected readonly copilotWorkspace = this.agentsService.workspace;
  protected readonly copilotAllowWrites = this.agentsService.allowWrites;
  protected readonly copilotModel = this.agentsService.copilotModel;
  workspaceDraft = '';

  // MCP voice server: lets other local agents call Ava to speak.
  protected readonly mcpServerUrl = signal<string | null>(null);

  private async loadMcpServerInfo() {
    try {
      const info = await invoke<{ url: string }>('mcp_server_info');
      this.mcpServerUrl.set(info.url);
    } catch {
      this.mcpServerUrl.set(null);
    }
  }

  @Input() speechModelName = 'Moonshine';
  @Input() speechLoadInfo = '';
  @Input() voiceBackendInfo = '';

  protected readonly conversationRuntimeLabel = computed(() => {
    const active = this.activeConversationModel();
    if (active) return `${active.name} · ${this.conversationLoadInfo() || 'loaded'}`;
    if (this.conversationLoading()) return this.conversationLoadInfo() || 'Loading';
    if (this.conversationReady()) return this.conversationLoadInfo() || 'Ready';
    return 'Not loaded yet';
  });

  protected readonly agentRuntimeLabel = computed(() => {
    if (this.agentRuntime() === 'copilot' && this.copilotSignedIn()) {
      return `GitHub Copilot · ${this.copilotAccount() || 'signed in'}`;
    }
    const active = this.activeAgentModel();
    if (active) return `${active.name} · ${this.agentLoadInfo() || 'loaded'}`;
    if (this.agentLoading()) return this.agentLoadInfo() || 'Loading';
    if (this.agentReady()) return this.agentLoadInfo() || 'Ready';
    return 'Not loaded yet';
  });

  protected formatMemory(memoryGb: number | undefined): string {
    return memoryGb ? `${memoryGb} GB reported` : 'Not reported';
  }

  protected async refreshModelFiles(): Promise<void> {
    if (!isTauri()) return;
    try {
      const files = await invoke<ModelFileInfo[]>('llm_list_models');
      this.modelFiles.set(files);
      this.modelStorageAvailable.set(true);
    } catch {
      this.modelStorageAvailable.set(false);
    }
  }

  protected async openModelsFolder(): Promise<void> {
    try {
      await invoke('llm_open_models_dir');
    } catch {
      // older host without the command
    }
  }

  protected async deleteModelFile(name: string): Promise<void> {
    const ok = await this.confirm.ask({
      title: `Delete ${name}?`,
      message: 'It will be re-downloaded if the model is selected again.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('llm_delete_model', { name });
    } catch {
      // ignore; refresh shows the real state
    }
    await this.refreshModelFiles();
  }

  protected formatBytes(bytes: number): string {
    const gb = 1024 ** 3;
    const mb = 1024 ** 2;
    if (bytes >= gb) return `${(bytes / gb).toFixed(2)} GB`;
    if (bytes >= mb) return `${Math.round(bytes / mb)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  protected readonly listenMode = this.ttsService.listenMode;

  setListenMode(mode: ListenMode) {
    this.ttsService.setListenMode(mode);
  }

  selectVoice(id: TtsEngine) {
    this.ttsService.setVoice(id);
  }

  selectKokoroVoice(id: string) {
    this.ttsService.setKokoroVoice(id);
    this.previewVoice.emit(id);
  }

  selectGrokVoice(id: string) {
    this.ttsService.setGrokVoice(id);
    this.previewVoice.emit(id);
  }

  openGrokSessions() {
    this.openGrokCli.emit();
  }

  openDebugConsole() {
    this.openDebug.emit();
  }

  setIntelligenceMode(mode: 'local' | 'grok') {
    this.llmService.setIntelligenceMode(mode);
    if (mode === 'grok') {
      this.ttsService.preferGrokVoice();
    } else if (this.ttsService.selectedVoiceId() === 'grok') {
      this.ttsService.setVoice('kokoro');
    }
  }

  setTheme(preference: ThemePreference) {
    this.theme.setPreference(preference);
  }

  async signInWithGrok() {
    if (this.xai.loginPending()) return;
    this.xaiBusy = true;
    try {
      const login = this.xai.loginWithGrok();
      this.xaiBusy = false;
      await login;
      if (this.xai.signedIn()) {
        this.setIntelligenceMode('grok');
        await this.ttsService.refreshGrokVoices();
      }
    } catch {
      // surfaced via xaiError
    } finally {
      this.xaiBusy = false;
    }
  }

  async signInWithApiKey() {
    this.xaiBusy = true;
    try {
      await this.xai.loginWithApiKey(this.apiKeyDraft);
      this.apiKeyDraft = '';
      this.setIntelligenceMode('grok');
      await this.ttsService.refreshGrokVoices();
    } catch (err) {
      this.xai.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.xaiBusy = false;
    }
  }

  async importGrokCli() {
    this.xaiBusy = true;
    try {
      const ok = await this.xai.importGrokCliAuth();
      if (ok) {
        this.setIntelligenceMode('grok');
        await this.ttsService.refreshGrokVoices();
      } else {
        this.xai.error.set('No Grok CLI login was found on this computer.');
      }
    } finally {
      this.xaiBusy = false;
    }
  }

  signOutGrok() {
    this.xai.logout();
    this.setIntelligenceMode('local');
  }

  cancelGrokLogin() {
    this.xaiBusy = false;
    this.xai.cancelLogin();
  }

  openGrokVerification() {
    void this.xai.openVerificationPage();
  }

  async startRecording() {
    if (this.isRecording()) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      this.mediaRecorder = recorder;
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
      };
      recorder.start();
      this.isRecording.set(true);
      this.recordSeconds.set(0);
      this.recordTimer = setInterval(() => this.recordSeconds.update(s => s + 1), 1000);
    } catch {
      console.warn('Microphone access was denied.');
    }
  }

  stopRecording() {
    if (!this.isRecording()) return;
    this.isRecording.set(false);
    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
    }
    this.mediaRecorder?.stop();
  }

  selectConversationModel(id: string) {
    this.llmService.setModel(id);
  }

  selectAgentModel(id: string) {
    this.agentsService.setModel(id);
  }

  setAgentRuntime(runtime: 'local' | 'copilot') {
    this.agentsService.setRuntime(runtime);
  }

  saveCopilotWorkspace() {
    this.agentsService.setWorkspace(this.workspaceDraft);
  }

  setCopilotAllowWrites(allow: boolean) {
    this.agentsService.setAllowWrites(allow);
  }

  setCopilotModel(id: string) {
    this.agentsService.setCopilotModel(id);
  }

  async signInWithGithub() {
    if (this.copilotAuth.loginPending()) return;
    this.copilotBusy = true;
    try {
      const login = this.copilotAuth.loginWithGitHub();
      this.copilotBusy = false;
      await login;
      if (this.copilotAuth.signedIn()) this.setAgentRuntime('copilot');
    } catch {
      // surfaced via copilotError
    } finally {
      this.copilotBusy = false;
    }
  }

  async signInWithGithubPat() {
    this.copilotBusy = true;
    try {
      await this.copilotAuth.loginWithPat(this.patDraft);
      this.patDraft = '';
      this.setAgentRuntime('copilot');
    } catch (err) {
      this.copilotAuth.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.copilotBusy = false;
    }
  }

  async importGithubCli() {
    this.copilotBusy = true;
    try {
      const ok = await this.copilotAuth.importGhCliAuth();
      if (ok) {
        this.setAgentRuntime('copilot');
      } else {
        this.copilotAuth.error.set('No GitHub CLI login was found on this computer.');
      }
    } finally {
      this.copilotBusy = false;
    }
  }

  useCopilotCliLogin() {
    this.copilotAuth.useStoredCliLogin();
    this.setAgentRuntime('copilot');
  }

  signOutCopilot() {
    this.copilotAuth.logout();
    this.setAgentRuntime('local');
  }

  cancelCopilotLogin() {
    this.copilotBusy = false;
    this.copilotAuth.cancelLogin();
  }

  openCopilotVerification() {
    void this.copilotAuth.openVerificationPage();
  }

  fallbackConversationToCpu() {
    void this.llmService.reloadOnCpu().catch(error => {
      console.error('Conversation CPU fallback failed', error);
    });
  }

  fallbackAgentToCpu() {
    void this.agentsService.reloadOnCpu().catch(error => {
      console.error('Agent CPU fallback failed', error);
    });
  }

  @Output() close = new EventEmitter<void>();
  @Output() previewVoice = new EventEmitter<string>();
  @Output() resetCache = new EventEmitter<void>();
  @Output() openMemory = new EventEmitter<void>();
  @Output() openGrokCli = new EventEmitter<void>();
  @Output() openDebug = new EventEmitter<void>();
  @Output() gardenChanged = new EventEmitter<void>();
  @Output() deleteGarden = new EventEmitter<string>();

  gardenHomeLabel(id: string): string {
    const garden = this.gardens().find(item => item.id === id);
    return this.gardensService.homeLabel(garden);
  }

  async selectGarden(id: string) {
    if (id === this.currentGarden()?.id) return;
    this.gardenError = '';
    await this.gardensService.useGarden(id);
    this.gardenChanged.emit();
  }

  async createGarden() {
    const name = this.newGardenName.trim();
    if (!name) return;
    const result = await this.gardensService.createNamedGarden(name);
    if (!result.ok) {
      this.gardenError = result.error || '';
      return;
    }
    this.newGardenName = '';
    this.gardenError = '';
    this.gardenChanged.emit();
  }

  async pickGardenFolder(id: string) {
    const result = await this.gardensService.pickHomeFor(id);
    if (!result.ok) {
      this.gardenError = result.error || '';
      return;
    }
    this.gardenError = '';
    if (id === this.currentGarden()?.id) this.gardenChanged.emit();
  }

  async removeGarden(id: string) {
    const garden = this.gardens().find(item => item.id === id);
    if (!garden || this.gardens().length <= 1) return;
    const ok = await this.confirm.ask({
      title: `Remove ${garden.name}?`,
      message: 'Her files stay in that folder. This only forgets the garden in the app.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.deleteGarden.emit(id);
  }

  async pickHomeFolder() {
    await this.pickGardenFolder(this.currentGarden()?.id || '');
  }

  async resetEverything() {
    const ok = await this.confirm.ask({
      title: 'Reset Ava from scratch?',
      message: 'This deletes downloaded models, settings, and local databases. Your home folder of files stays.',
      confirmLabel: 'Reset cache',
      danger: true,
    });
    if (ok) this.resetCache.emit();
  }

  async undoSelfImprovements() {
    const ok = await this.confirm.ask({
      title: 'Undo self-improvements?',
      message: 'This restores the original Ava and forgets those source changes.',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) return;
    this.selfImproveError = '';
    try {
      await this.selfImprove.reset();
    } catch (error) {
      this.selfImproveError = error instanceof Error ? error.message : 'Could not restore the original Ava.';
    }
  }

  async checkForUpdates() {
    if (this.updates.available()) {
      this.updates.dialogOpen.set(true);
      return;
    }
    await this.updates.check({ silent: false });
  }
}
