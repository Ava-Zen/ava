import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ConfirmDialogService } from '../services/confirm-dialog';
import { GardensService } from '../services/gardens';
import { GrokCliService, RosterItem, TranscriptItem } from '../services/grok-cli';
import { markdownToHtml } from '../services/text-format';

@Component({
  selector: 'app-grok-cli',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './grok-cli.html',
  styleUrl: './grok-cli.css',
})
export class GrokCliOverlay {
  private readonly grok = inject(GrokCliService);
  private readonly gardens = inject(GardensService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly sanitizer = inject(DomSanitizer);

  @Output() readonly close = new EventEmitter<void>();

  protected readonly desktop = this.grok.desktop;
  protected readonly phase = this.grok.phase;
  protected readonly grokInfo = this.grok.grokInfo;
  protected readonly auth = this.grok.auth;
  protected readonly installLog = this.grok.installLog;
  protected readonly error = this.grok.error;
  protected readonly busy = this.grok.busy;
  protected readonly roster = this.grok.roster;
  protected readonly runningIds = this.grok.runningIds;
  protected readonly activeId = this.grok.activeId;
  protected readonly cwd = this.grok.cwd;
  protected readonly items = this.grok.items;
  protected readonly turn = this.grok.turn;
  protected readonly hitl = this.grok.hitl;
  protected readonly hydrating = this.grok.hydrating;
  protected readonly prompt = this.grok.prompt;
  protected readonly mode = this.grok.mode;
  protected readonly working = this.grok.working;
  protected readonly activeRow = this.grok.activeRow;
  protected readonly projects = this.grok.projects;
  protected readonly folderLabel = computed(() => folderName(this.cwd()) || 'Choose a folder');

  protected readonly showRoster = signal(true);

  constructor() {
    void this.grok.boot();
    if (!this.activeId()) this.showRoster.set(true);
  }

  protected html(item: TranscriptItem): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markdownToHtml(item.text || ''));
  }

  protected isRunning(id: string): boolean {
    return this.runningIds().includes(id);
  }

  protected async install(): Promise<void> {
    await this.grok.install();
  }

  protected async login(): Promise<void> {
    await this.grok.login();
  }

  protected async cancelLogin(): Promise<void> {
    await this.grok.cancelLogin();
  }

  protected async logout(): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Sign out of Grok CLI?',
      message: 'Ava will close Grok sessions in this window. Your CLI login on disk is cleared through Grok.',
      confirmLabel: 'Sign out',
      danger: true,
    });
    if (!ok) return;
    await this.grok.logout();
  }

  protected async openRow(row: RosterItem): Promise<void> {
    this.showRoster.set(false);
    await this.grok.openSession(row.sessionId, row.cwd);
  }

  protected async newSession(): Promise<void> {
    this.showRoster.set(false);
    await this.grok.startDraft();
  }

  protected backToRoster(): void {
    this.showRoster.set(true);
  }

  protected async pickFolder(): Promise<void> {
    await this.grok.pickFolder();
  }

  protected useGardenFolder(): void {
    const workspace = this.gardens.currentGarden()?.workspace;
    if (workspace) this.grok.cwd.set(workspace);
  }

  protected async send(): Promise<void> {
    await this.grok.send();
  }

  protected onPromptKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  protected async cancelTurn(): Promise<void> {
    await this.grok.cancel();
  }

  protected async answer(optionId: string): Promise<void> {
    await this.grok.respondHitl(optionId);
  }

  protected async dismissHitl(): Promise<void> {
    await this.grok.respondHitl(null);
  }

  protected async setMode(mode: string): Promise<void> {
    await this.grok.setMode(mode);
  }

  protected async deleteRow(row: RosterItem, event: Event): Promise<void> {
    event.stopPropagation();
    const ok = await this.confirm.ask({
      title: 'Delete this Grok session?',
      message: 'Grok will remove it from this machine. The CLI will no longer list it.',
      confirmLabel: 'Delete session',
      danger: true,
    });
    if (!ok) return;
    await this.grok.deleteSession(row.sessionId);
  }

  protected dismiss(): void {
    this.close.emit();
  }
}

function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return trimmed.split(/[\\/]/).pop() || trimmed;
}
