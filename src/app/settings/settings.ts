import { Component, Output, EventEmitter, inject, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { Garden, GardensService } from '../services/gardens';
import { TtsService, TtsEngine } from '../services/tts';
import { CustomVoiceService } from '../services/custom-voice';
import { LlmService } from '../services/llm';
import { AgentsService } from '../services/agents';
import { HardwareDiagnosticsService } from '../services/hardware-diagnostics';

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
  private readonly customVoiceService = inject(CustomVoiceService);
  private readonly llmService = inject(LlmService);
  private readonly agentsService = inject(AgentsService);
  private readonly hardwareDiagnostics = inject(HardwareDiagnosticsService);
  protected readonly gardenList = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;
  protected readonly hardware = this.hardwareDiagnostics.diagnostics;
  protected readonly hardwareReadinessLabel = this.hardwareDiagnostics.readinessLabel;
  protected readonly hardwareReadinessDetails = this.hardwareDiagnostics.readinessDetails;

  // Text-to-speech configuration
  protected readonly voices = this.ttsService.voices;
  protected readonly selectedVoiceId = this.ttsService.selectedVoiceId;
  protected readonly kokoroVoices = this.ttsService.kokoroVoices;
  protected readonly selectedKokoroVoiceId = this.ttsService.selectedKokoroVoiceId;
  // Custom voice cloning
  protected readonly customVoices = this.customVoiceService.voices;
  protected readonly selectedCustomVoiceId = this.customVoiceService.selectedId;
  protected readonly customVoiceBuilding = this.customVoiceService.isBuilding;
  protected readonly customVoiceStatus = this.customVoiceService.buildStatus;
  protected readonly minSampleSeconds = this.customVoiceService.minSampleSeconds;
  protected readonly isRecording = signal(false);
  protected readonly recordSeconds = signal(0);
  protected readonly newVoiceName = signal('');
  protected readonly customVoiceError = signal('');
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordTimer: ReturnType<typeof setInterval> | null = null;
  protected readonly conversationModels = this.llmService.models;
  protected readonly selectedConversationModel = this.llmService.selectedModel;
  protected readonly activeConversationModel = this.llmService.activeModel;
  protected readonly conversationLoadInfo = this.llmService.loadInfo;
  protected readonly conversationReady = this.llmService.isReady;
  protected readonly conversationLoading = this.llmService.isLoading;
  protected readonly agentModels = this.agentsService.models;
  protected readonly selectedAgentModel = this.agentsService.selectedModel;
  protected readonly activeAgentModel = this.agentsService.activeModel;
  protected readonly agentLoadInfo = this.agentsService.loadInfo;
  protected readonly agentReady = this.agentsService.isReady;
  protected readonly agentLoading = this.agentsService.isLoading;
  protected readonly selectedVoice = this.ttsService.selectedVoice;
  protected readonly selectedKokoroVoice = this.ttsService.selectedKokoroVoice;

  // MCP voice server: lets other local agents call Ava to speak.
  protected readonly mcpServerUrl = signal<string | null>(null);

  constructor() {
    void this.loadMcpServerInfo();
  }

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
    const active = this.activeAgentModel();
    if (active) return `${active.name} · ${this.agentLoadInfo() || 'loaded'}`;
    if (this.agentLoading()) return this.agentLoadInfo() || 'Loading';
    if (this.agentReady()) return this.agentLoadInfo() || 'Ready';
    return 'Not loaded yet';
  });

  protected formatMemory(memoryGb: number | undefined): string {
    return memoryGb ? `${memoryGb} GB reported` : 'Not reported';
  }

  selectVoice(id: TtsEngine) {
    this.ttsService.setVoice(id);
  }

  selectKokoroVoice(id: string) {
    this.ttsService.setKokoroVoice(id);
    this.previewVoice.emit(id);
  }

  selectCustomVoice(id: string) {
    this.customVoiceService.select(id);
    this.previewCustomVoice.emit(id);
  }

  removeCustomVoice(id: string) {
    this.customVoiceService.removeVoice(id);
  }

  async startRecording() {
    this.customVoiceError.set('');
    if (this.isRecording()) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recordedChunks = [];
      const recorder = new MediaRecorder(stream);
      this.mediaRecorder = recorder;
      recorder.ondataavailable = e => {
        if (e.data.size > 0) this.recordedChunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        void this.buildVoiceFromChunks();
      };
      recorder.start();
      this.isRecording.set(true);
      this.recordSeconds.set(0);
      this.recordTimer = setInterval(() => this.recordSeconds.update(s => s + 1), 1000);
    } catch {
      this.customVoiceError.set('Microphone access was denied.');
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

  async onSampleUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.customVoiceError.set('');
    try {
      await this.buildVoiceFromBlob(file);
    } catch {
      this.customVoiceError.set('Could not read that audio file.');
    }
  }

  private async buildVoiceFromChunks() {
    if (this.recordedChunks.length === 0) return;
    const blob = new Blob(this.recordedChunks, { type: this.recordedChunks[0].type || 'audio/webm' });
    this.recordedChunks = [];
    await this.buildVoiceFromBlob(blob);
  }

  private async buildVoiceFromBlob(blob: Blob) {
    try {
      const buffer = await blob.arrayBuffer();
      const ctx = new AudioContext();
      const decoded = await ctx.decodeAudioData(buffer);
      const samples = decoded.getChannelData(0);
      const name = this.newVoiceName().trim() || `My voice ${this.customVoices().length + 1}`;
      await this.customVoiceService.addVoice(name, new Float32Array(samples), decoded.sampleRate);
      await ctx.close();
      this.newVoiceName.set('');
    } catch (e) {
      this.customVoiceError.set((e as Error)?.message || 'Could not build a voice from that sample.');
    }
  }

  selectConversationModel(id: string) {
    this.llmService.setModel(id);
  }

  selectAgentModel(id: string) {
    this.agentsService.setModel(id);
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
  @Output() selectGarden = new EventEmitter<string>();
  @Output() createGarden = new EventEmitter<{name: string; description?: string}>();
  @Output() updateGarden = new EventEmitter<{id: string; name: string; description?: string}>();
  @Output() deleteGarden = new EventEmitter<string>();
  @Output() previewVoice = new EventEmitter<string>();
  @Output() previewCustomVoice = new EventEmitter<string>();
  @Output() resetCache = new EventEmitter<void>();

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

  resetEverything() {
    if (confirm('Reset Ava from scratch? This deletes downloaded models, settings, gardens, and local databases.')) {
      this.resetCache.emit();
    }
  }
}
