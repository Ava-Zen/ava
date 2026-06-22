import { Component, Output, EventEmitter, inject, Input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Garden, GardensService } from '../services/gardens';
import { TtsService, TtsEngine } from '../services/tts';
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
