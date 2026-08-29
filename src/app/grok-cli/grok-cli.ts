import { Component, ElementRef, EventEmitter, Input, Output, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ConfirmDialogService } from '../services/confirm-dialog';
import { GardensService } from '../services/gardens';
import { GrokCliService, RosterItem, TranscriptItem, folderName } from '../services/grok-cli';
import { SelfImproveService, grokCliInstallCommand, grokCliInstallUrl } from '../services/self-improve';
import { openExternal } from '../services/mcp/mcp-http';
import {
  hasAllowAllOption,
  isCommandPermission,
  permissionOptionLabel,
  permissionOptions,
} from '../services/grok-cli/permissions';
import { speakableLine, shortFileLabel } from '../services/grok-cli/transcript';
import { markdownToHtml } from '../services/text-format';
import { ListenMode } from '../services/tts';

@Component({
  selector: 'app-grok-cli',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './grok-cli.html',
  styleUrl: './grok-cli.css',
  host: { '[class.embedded]': 'embedded' },
})
export class GrokCliOverlay {
  private readonly grok = inject(GrokCliService);
  private readonly gardens = inject(GardensService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly selfImprove = inject(SelfImproveService);

  @Input() embedded = false;
  @Input() listenMode: ListenMode = 'push';
  @Output() readonly close = new EventEmitter<void>();
  @Output() readonly readyToWork = new EventEmitter<void>();
  @Output() readonly listenModeChange = new EventEmitter<ListenMode>();
  @ViewChild('thread') private threadEl?: ElementRef<HTMLElement>;

  protected readonly phase = this.grok.phase;
  protected readonly auth = this.grok.auth;
  protected readonly installLog = this.grok.installLog;
  protected readonly error = this.grok.error;
  protected readonly busy = this.grok.busy;
  protected readonly roster = this.grok.roster;
  protected readonly runningIds = this.grok.runningIds;
  protected readonly cwd = this.grok.cwd;
  protected readonly items = this.grok.items;
  protected readonly hitl = this.grok.hitl;
  protected readonly hydrating = this.grok.hydrating;
  protected readonly prompt = this.grok.prompt;
  protected readonly mode = this.grok.mode;
  protected readonly working = this.grok.working;
  protected readonly activeRow = this.grok.activeRow;
  protected readonly view = this.grok.view;
  protected readonly projectHint = this.grok.projectHint;
  protected readonly needsFolder = this.grok.needsFolder;
  protected readonly selfImproving = this.grok.selfImproving;
  protected readonly selfImproveSetup = this.selfImprove.waitingOnSetup;
  protected readonly grokInstallCommand = computed(() =>
    this.selfImprove.status()?.grokInstallCommand || grokCliInstallCommand(this.selfImprove.status()?.os),
  );
  protected readonly grokInstallUrl = grokCliInstallUrl();
  protected readonly folderChoices = this.grok.folderChoices;
  protected readonly folderLabel = computed(() => folderName(this.cwd()) || 'Choose a folder');
  protected readonly heading = computed(() => {
    if (this.selfImproving() || this.selfImproveSetup()) return 'Improving Ava';
    if (this.phase() !== 'ready') return 'Grok';
    if (this.view() === 'roster') return 'Sessions';
    if (!this.cwd().trim()) return 'New session';
    return this.activeRow()?.title || this.folderLabel();
  });
  protected readonly gardenWorkspace = computed(() => this.gardens.currentGarden()?.workspace || '');
  protected readonly gardenLabel = computed(() => this.gardens.currentGarden()?.name || 'Garden folder');
  protected readonly draftPath = signal('');
  protected readonly hitlQuestion = computed(() => {
    const request = this.hitl();
    const raw = request?.questions[0]?.question || request?.method || '';
    const spoken = speakableLine(raw);
    return { raw, spoken: spoken || 'Grok needs a decision.' };
  });
  protected readonly hitlOptions = computed(() => {
    const request = this.hitl();
    if (!request) return [];
    return permissionOptions(request).map(option => ({
      optionId: option.optionId,
      name: permissionOptionLabel(option),
    }));
  });
  protected readonly showAllowAll = computed(() => {
    const request = this.hitl();
    return !!request && isCommandPermission(request) && !hasAllowAllOption(request);
  });

  constructor() {
    void this.grok.boot();
    effect(() => {
      this.items();
      this.hitl();
      this.hydrating();
      this.working();
      queueMicrotask(() => this.scrollThread());
    });
  }

  protected displayText(item: TranscriptItem): string {
    if (item.kind !== 'work' || !item.text) return item.text;
    return this.displayPath(item.text);
  }

  protected displayPath(value: string): string {
    return shortFileLabel(value) || speakableLine(value) || value;
  }

  protected setListenMode(mode: ListenMode): void {
    this.listenModeChange.emit(mode);
  }

  private scrollThread(): void {
    const el = this.threadEl?.nativeElement;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: this.working() ? 'auto' : 'smooth' });
    });
  }

  protected html(item: TranscriptItem): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(markdownToHtml(item.text || ''));
  }

  protected isRunning(id: string): boolean {
    return this.runningIds().includes(id);
  }

  protected nameOf(path: string): string {
    return folderName(path);
  }

  protected async openGrokInstallPage(): Promise<void> {
    await openExternal(this.grokInstallUrl);
  }

  protected async install(): Promise<void> {
    await this.grok.install();
    if (this.grok.phase() === 'ready') this.selfImprove.waitingOnSetup.set(false);
  }

  protected async login(): Promise<void> {
    await this.grok.login();
    if (this.grok.phase() === 'ready') this.selfImprove.waitingOnSetup.set(false);
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
    await this.grok.openSession(row.sessionId, row.cwd);
  }

  protected async newSession(): Promise<void> {
    await this.grok.startDraft();
  }

  protected backToRoster(): void {
    this.grok.view.set('roster');
  }

  protected async pickFolder(): Promise<void> {
    const needed = this.needsFolder();
    const path = await this.grok.pickFolder();
    if (path && needed) this.readyToWork.emit();
  }

  protected async useFolder(path: string): Promise<void> {
    const needed = this.needsFolder();
    if (await this.grok.useFolder(path) && needed) this.readyToWork.emit();
  }

  protected useGardenFolder(): void {
    const workspace = this.gardenWorkspace();
    if (workspace) void this.useFolder(workspace);
  }

  protected async commitDraftPath(): Promise<void> {
    const path = this.draftPath().trim();
    if (!path) return;
    this.draftPath.set('');
    await this.useFolder(path);
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

  protected async allowAll(): Promise<void> {
    await this.grok.allowAll();
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
