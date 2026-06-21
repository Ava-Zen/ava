import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { OnboardingService } from '../services/onboarding';

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

  @Output() completed = new EventEmitter<void>();

  protected readonly step = signal(0);
  protected readonly suggestedName = this.onboarding.suggestedName;
  protected readonly name = signal('');
  protected readonly pronunciation = signal('');
  protected readonly primaryUse = signal('Everyday companion');
  protected readonly preferredInput = signal<'voice' | 'text' | 'both'>('both');
  protected readonly downloadConsent = signal(false);
  protected readonly nameAnswered = signal(false);

  protected readonly totalSteps = 4;
  protected readonly progress = computed(() => `${((this.step() + 1) / this.totalSteps) * 100}%`);
  protected readonly canContinue = computed(() => {
    if (this.step() === 1) return this.name().trim().length > 0;
    if (this.step() === 2) return this.downloadConsent();
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

  protected acceptSuggestedName(): void {
    const suggested = this.suggestedName();
    if (!suggested) return;
    this.name.set(suggested);
    this.nameAnswered.set(true);
  }

  protected editSuggestedName(): void {
    this.name.set(this.suggestedName() ?? '');
    this.nameAnswered.set(true);
  }

  protected onNameInput(event: Event): void {
    const input = event.target as HTMLInputElement | null;
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

  protected next(): void {
    if (!this.canContinue()) return;
    if (this.step() < this.totalSteps - 1) {
      this.step.update(value => value + 1);
      return;
    }

    this.onboarding.complete({
      name: this.name(),
      pronunciation: this.pronunciation(),
      primaryUse: this.primaryUse(),
      preferredInput: this.preferredInput(),
      modelDownloadConsent: this.downloadConsent(),
    });
    this.completed.emit();
  }

  protected back(): void {
    this.step.update(value => Math.max(0, value - 1));
  }
}
