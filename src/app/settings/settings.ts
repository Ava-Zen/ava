import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Garden, GardensService } from '../services/gardens';
import { TtsService, TtsEngine } from '../services/tts';
import { LlmService } from '../services/llm';
import { AgentsService } from '../services/agents';

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
  protected readonly gardenList = this.gardensService.gardens;
  protected readonly currentGarden = this.gardensService.currentGarden;

  // Text-to-speech configuration
  protected readonly voices = this.ttsService.voices;
  protected readonly selectedVoiceId = this.ttsService.selectedVoiceId;
  protected readonly kokoroVoices = this.ttsService.kokoroVoices;
  protected readonly selectedKokoroVoiceId = this.ttsService.selectedKokoroVoiceId;
  protected readonly uncensoredModel = this.llmService.uncensoredModel;
  protected readonly isUncensoredMode = this.llmService.isUncensoredMode;

  selectVoice(id: TtsEngine) {
    this.ttsService.setVoice(id);
  }

  selectKokoroVoice(id: string) {
    this.ttsService.setKokoroVoice(id);
    this.previewVoice.emit(id);
  }

  setUncensoredMode(enabled: boolean) {
    this.llmService.setUncensoredMode(enabled);
    this.agentsService.resetLoadedModel();
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
