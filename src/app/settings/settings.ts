import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Garden, GardensService } from '../services/gardens';
import { TtsService, TtsEngine } from '../services/tts';
import { MCP_PRESETS, McpService, GITHUB_OAUTH_DEFAULTS } from '../services/mcp';
import { McpAuthMethod, McpServerConfig, McpServerStatus } from '../services/mcp/mcp-types';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html',
  styleUrl: './settings.css'
})
export class Settings {
  private readonly gardensService = inject(GardensService);
  private readonly ttsService = inject(TtsService);
  private readonly mcp = inject(McpService);
  protected readonly gardenList = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;

  // MCP (Model Context Protocol) servers
  protected readonly mcpServers = this.mcp.servers;
  protected readonly mcpStatuses = this.mcp.statuses;
  protected readonly mcpPresets = MCP_PRESETS;

  newMcpName = '';
  newMcpUrl = '';
  newMcpAuth: McpAuthMethod = 'none';
  newMcpPat = '';
  patDrafts: Record<string, string> = {};
  oauthClientDrafts: Record<string, string> = {};
  oauthScopeDrafts: Record<string, string> = {};
  mcpBusy: Record<string, boolean> = {};
  mcpError = '';

  constructor() {
    // Seed per-server OAuth drafts from persisted config so saved values show.
    for (const s of this.mcpServers()) {
      if (s.oauth?.clientId) this.oauthClientDrafts[s.id] = s.oauth.clientId;
      if (s.oauth?.scope) this.oauthScopeDrafts[s.id] = s.oauth.scope;
    }
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

  removeMcp(id: string) {
    if (confirm('Remove this MCP server?')) {
      this.mcp.removeServer(id);
    }
  }

  // Text-to-speech configuration
  protected readonly voices = this.ttsService.voices;
  protected readonly selectedVoiceId = this.ttsService.selectedVoiceId;
  protected readonly kokoroVoices = this.ttsService.kokoroVoices;
  protected readonly selectedKokoroVoiceId = this.ttsService.selectedKokoroVoiceId;

  selectVoice(id: TtsEngine) {
    this.ttsService.setVoice(id);
  }

  selectKokoroVoice(id: string) {
    this.ttsService.setKokoroVoice(id);
    this.previewVoice.emit(id);
  }

  @Output() close = new EventEmitter<void>();
  @Output() selectGarden = new EventEmitter<string>();
  @Output() createGarden = new EventEmitter<{name: string; description?: string}>();
  @Output() updateGarden = new EventEmitter<{id: string; name: string; description?: string}>();
  @Output() deleteGarden = new EventEmitter<string>();
  @Output() previewVoice = new EventEmitter<string>();

  // Local form state
  newGardenName = '';
  newGardenDescription = '';
  editingId: string | null = null;
  editName = '';
  editDescription = '';

  select(id: string) {
    this.selectGarden.emit(id);
    this.close.emit();
  }

  startCreate() {
    this.newGardenName = '';
    this.newGardenDescription = '';
  }

  create() {
    const name = this.newGardenName.trim();
    if (!name) return;

    this.createGarden.emit({
      name,
      description: this.newGardenDescription.trim() || undefined
    });
    this.newGardenName = '';
    this.newGardenDescription = '';
  }

  startEdit(garden: Garden) {
    this.editingId = garden.id;
    this.editName = garden.name;
    this.editDescription = garden.description || '';
  }

  saveEdit() {
    if (!this.editingId) return;
    const name = this.editName.trim();
    if (!name) {
      this.cancelEdit();
      return;
    }

    this.updateGarden.emit({
      id: this.editingId,
      name,
      description: this.editDescription.trim() || undefined
    });
    this.cancelEdit();
  }

  cancelEdit() {
    this.editingId = null;
    this.editName = '';
    this.editDescription = '';
  }

  remove(id: string) {
    if (confirm('Delete this garden? Its conversation history will be lost.')) {
      this.deleteGarden.emit(id);
    }
  }
}
