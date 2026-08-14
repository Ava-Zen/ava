import { Component, ElementRef, EventEmitter, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { OnboardingService } from '../services/onboarding';
import { HardwareDiagnosticsService } from '../services/hardware-diagnostics';
import { XaiAuthService } from '../services/xai/xai-auth';
import { LlmService } from '../services/llm';
import { TtsService } from '../services/tts';

interface OnboardingOption {
  id: string;
  label: string;
  description: string;
}

@Component({
  selector: 'app-onboarding',
  standalone: true,
  templateUrl: './onboarding.html',
  styleUrl: './onboarding.css'
})
export class Onboarding {
  private readonly onboarding = inject(OnboardingService);
  private readonly hardwareDiagnostics = inject(HardwareDiagnosticsService);
  private readonly xai = inject(XaiAuthService);
  private readonly llm = inject(LlmService);
  private readonly tts = inject(TtsService);
  private nameInputElement?: ElementRef<HTMLInputElement>;

  @Output() completed = new EventEmitter<void>();

  protected readonly step = signal(0);
  protected readonly suggestedName = this.onboarding.suggestedName;
  protected readonly name = signal('');
  protected readonly nameEdited = signal(false);
  protected readonly pronunciation = signal('');
  protected readonly primaryUse = signal('Everyday companion');
  protected readonly preferredInput = signal<'voice' | 'text' | 'both'>('both');
  protected readonly downloadConsent = signal(false);
  protected readonly intelligence = signal<'local' | 'grok'>('local');
  protected readonly apiKeyDraft = signal('');
  protected readonly xaiBusy = signal(false);
  protected readonly hardware = this.hardwareDiagnostics.diagnostics;
  protected readonly hardwareReadinessLabel = this.hardwareDiagnostics.readinessLabel;
  protected readonly hardwareReadinessDetails = this.hardwareDiagnostics.readinessDetails;
  protected readonly xaiSignedIn = this.xai.signedIn;
  protected readonly xaiError = this.xai.error;
  protected readonly xaiPending = this.xai.loginPending;
  protected readonly xaiDevice = this.xai.deviceLogin;
  protected readonly grokCliAvailable = this.xai.grokCliAvailable;

  protected readonly totalSteps = 6;
  protected readonly progress = computed(() => `${((this.step() + 1) / this.totalSteps) * 100}%`);
  protected readonly canContinue = computed(() => {
    if (this.step() === 1) return this.name().trim().length > 0;
    if (this.step() === 4 && this.intelligence() === 'local') return this.downloadConsent();
    if (this.step() === 4 && this.intelligence() === 'grok') return this.xai.signedIn();
    return true;
  });

  protected readonly useOptions: OnboardingOption[] = [
    {
      id: 'Everyday companion',
      label: 'Everyday',
      description: 'Questions, planning, reflection, and small tasks.'
    },
    {
      id: 'Creative work',
      label: 'Creative',
      description: 'Drafting, brainstorming, rewriting, and making ideas clearer.'
    },
    {
      id: 'Focused work',
      label: 'Work',
      description: 'Summaries, action lists, file context, and background agents.'
    }
  ];

  @ViewChild('nameInput')
  protected set nameInput(input: ElementRef<HTMLInputElement> | undefined) {
    this.nameInputElement = input;
    this.syncNameInputValue();
  }

  constructor() {
    this.prefillName(this.suggestedName());
    void this.onboarding.loadSuggestedName().then(suggested => this.prefillName(suggested));
  }

  protected onNameInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.nameEdited.set(true);
    this.name.set(input?.value ?? '');
  }

  protected onPronunciationInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.pronunciation.set(input?.value ?? '');
  }

  protected setPrimaryUse(value: string): void {
    this.primaryUse.set(value);
  }

  protected setPreferredInput(value: 'voice' | 'text' | 'both'): void {
    this.preferredInput.set(value);
  }

  protected setDownloadConsent(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.downloadConsent.set(!!input?.checked);
  }

  protected setIntelligence(value: 'local' | 'grok'): void {
    this.intelligence.set(value);
  }

  protected onApiKeyInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.apiKeyDraft.set(input?.value ?? '');
  }

  protected async signInWithGrok(): Promise<void> {
    if (this.xai.loginPending()) return;
    this.xaiBusy.set(true);
    try {
      const login = this.xai.loginWithGrok();
      this.xaiBusy.set(false);
      await login;
    } catch {
      // error signal is set by the auth service
    } finally {
      this.xaiBusy.set(false);
    }
  }

  protected async signInWithApiKey(): Promise<void> {
    this.xaiBusy.set(true);
    try {
      await this.xai.loginWithApiKey(this.apiKeyDraft());
      this.apiKeyDraft.set('');
    } catch (err) {
      this.xai.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.xaiBusy.set(false);
    }
  }

  protected async importGrokCli(): Promise<void> {
    this.xaiBusy.set(true);
    try {
      const ok = await this.xai.importGrokCliAuth();
      if (!ok) this.xai.error.set('No Grok CLI login was found on this computer.');
    } finally {
      this.xaiBusy.set(false);
    }
  }

  protected cancelGrokLogin(): void {
    this.xaiBusy.set(false);
    this.xai.cancelLogin();
  }

  protected openGrokVerification(): void {
    void this.xai.openVerificationPage();
  }

  protected formatMemory(memoryGb: number | undefined): string {
    return memoryGb ? `${memoryGb} GB reported` : 'Not reported';
  }

  protected next(): void {
    if (!this.canContinue()) return;
    if (this.step() < this.totalSteps - 1) {
      this.step.update(value => value + 1);
      return;
    }

    if (this.intelligence() === 'grok' && this.xai.signedIn()) {
      this.llm.setIntelligenceMode('grok');
      this.tts.preferGrokVoice();
    } else {
      this.llm.setIntelligenceMode('local');
    }

    this.onboarding.complete({
      name: this.name(),
      pronunciation: this.pronunciation(),
      primaryUse: this.primaryUse(),
      preferredInput: this.preferredInput(),
      modelDownloadConsent: this.intelligence() === 'local' ? this.downloadConsent() : true,
      intelligenceMode: this.intelligence(),
    });
    this.completed.emit();
  }

  protected back(): void {
    this.step.update(value => Math.max(0, value - 1));
  }

  private prefillName(suggested: string | null): void {
    if (!suggested || this.nameEdited() || this.name().trim().length > 0) return;
    this.name.set(suggested);
    this.syncNameInputValue();
  }

  private syncNameInputValue(): void {
    const input = this.nameInputElement?.nativeElement;
    if (!input || input.value === this.name()) return;
    input.value = this.name();
  }
}
