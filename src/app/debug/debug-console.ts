import { Component, ElementRef, EventEmitter, HostListener, Input, Output, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { ThemeService } from '../services/theme';
import {
  DebugEvent,
  DebugKind,
  DebugLogService,
  isDebugWindow,
} from '../services/debug-log';

const FILTERS: Array<{ id: DebugKind | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'route', label: 'Route' },
  { id: 'think', label: 'Think' },
  { id: 'llm', label: 'LLM' },
  { id: 'tool', label: 'Tools' },
  { id: 'command', label: 'Commands' },
  { id: 'speech', label: 'Speech' },
  { id: 'agent', label: 'Agent' },
  { id: 'error', label: 'Errors' },
];

@Component({
  selector: 'app-debug-console',
  standalone: true,
  templateUrl: './debug-console.html',
  styleUrl: './debug-console.css',
  host: { '[class.overlay-host]': 'embedded' },
})
export class DebugConsole {
  private readonly debug = inject(DebugLogService);
  private readonly theme = inject(ThemeService);

  @Input() embedded = false;
  @Output() readonly close = new EventEmitter<void>();

  protected readonly standalone = isDebugWindow();
  protected readonly events = this.debug.events;
  protected readonly snapshot = this.debug.snapshot;
  protected readonly liveCommand = this.debug.liveCommand;
  protected readonly liveThink = this.debug.liveThink;
  protected readonly paused = signal(false);
  protected readonly query = signal('');
  protected readonly filter = signal<DebugKind | 'all'>('all');
  protected readonly filters = FILTERS;
  protected readonly openId = signal<string | null>(null);
  private frozen: DebugEvent[] = [];
  @ViewChild('log') private logEl?: ElementRef<HTMLElement>;

  protected readonly visible = computed(() => {
    const list = this.paused() ? this.frozen : this.events();
    const filter = this.filter();
    const query = this.query().trim().toLowerCase();
    return list.filter(event => {
      if (filter !== 'all' && event.kind !== filter && !(filter === 'error' && event.level === 'error')) {
        return false;
      }
      if (!query) return true;
      return (
        event.title.toLowerCase().includes(query) ||
        event.kind.includes(query) ||
        (event.detail ?? '').toLowerCase().includes(query)
      );
    });
  });

  protected readonly statusLabel = computed(() => {
    const snap = this.snapshot();
    if (!snap) return this.events().length ? 'Connected' : 'Waiting for Ava';
    if (snap.thinking) return 'Thinking';
    if (snap.listening) return 'Listening';
    if (snap.speaking) return 'Speaking';
    return snap.status || 'Idle';
  });

  constructor() {
    this.theme.resolved();
    if (this.standalone && typeof document !== 'undefined') {
      document.title = 'Ava Debug';
    }
    effect(() => {
      this.visible();
      if (this.paused()) return;
      queueMicrotask(() => {
        const el = this.logEl?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  protected togglePause(): void {
    if (!this.paused()) this.frozen = this.events();
    this.paused.update(value => !value);
  }

  protected clear(): void {
    this.frozen = [];
    this.debug.clear();
  }

  protected popOut(): void {
    this.debug.popOut();
  }

  protected dismiss(): void {
    this.close.emit();
    this.debug.closeOverlay();
  }

  protected setFilter(id: DebugKind | 'all'): void {
    this.filter.set(id);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected toggleEvent(id: string): void {
    this.openId.update(current => (current === id ? null : id));
  }

  protected isOpen(id: string): boolean {
    return this.openId() === id;
  }

  protected formatTime(at: number): string {
    const date = new Date(at);
    const pad = (value: number, size = 2) => String(value).padStart(size, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  protected kindLabel(kind: DebugKind): string {
    return kind;
  }

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.embedded) {
      event.preventDefault();
      this.dismiss();
    }
  }
}
