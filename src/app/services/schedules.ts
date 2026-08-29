import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { GardensService } from './gardens';
import type { ParsedSchedule } from '../intents';

export interface AvaSchedule {
  id: string;
  title: string;
  task: string;
  kind: 'once' | 'interval';
  hour: number;
  minute: number;
  intervalDays: number;
  researchMe: boolean;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
}

const GRACE_MS = 2 * 60 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class SchedulesService {
  private readonly gardens = inject(GardensService);
  readonly items = signal<AvaSchedule[]>([]);
  readonly enabled = computed(() => this.items().filter(item => item.enabled));

  constructor() {
    effect(() => {
      this.gardens.currentGardenId();
      this.reload();
    });
  }

  addFromSpeech(parsed: ParsedSchedule, now = new Date()): AvaSchedule {
    const next: AvaSchedule = {
      id: `sch-${Date.now().toString(36)}`,
      title: parsed.title,
      task: parsed.task,
      kind: parsed.kind,
      hour: parsed.hour,
      minute: parsed.minute,
      intervalDays: parsed.intervalDays,
      researchMe: parsed.researchMe,
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: nextRunAt(parsed, now).toISOString(),
    };
    this.items.update(list => [...list, next]);
    this.persist();
    return next;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.items.update(list => list.map(item => item.id === id ? { ...item, enabled } : item));
    this.persist();
  }

  remove(id: string): void {
    this.items.update(list => list.filter(item => item.id !== id));
    this.persist();
  }

  clear(): void {
    this.items.set([]);
    this.persist();
  }

  /** Due jobs. Missed by more than two hours are skipped, not piled up. */
  takeDue(now = new Date()): AvaSchedule[] {
    const stamp = now.getTime();
    const due: AvaSchedule[] = [];
    const nextList = this.items().map(item => {
      if (!item.enabled) return item;
      const when = Date.parse(item.nextRunAt);
      if (!Number.isFinite(when) || when > stamp) return item;
      if (stamp - when > GRACE_MS) return advance(item, now);
      due.push(item);
      return item;
    });
    if (nextList.some((item, index) => item !== this.items()[index])) {
      this.items.set(nextList);
      this.persist();
    }
    return due;
  }

  markRan(id: string, now = new Date()): void {
    this.items.update(list => list.map(item => {
      if (item.id !== id) return item;
      if (item.kind === 'once') {
        return { ...item, enabled: false, lastRunAt: now.toISOString() };
      }
      return advance({ ...item, lastRunAt: now.toISOString() }, now);
    }));
    this.persist();
  }

  describe(item: AvaSchedule): string {
    const clock = formatClock(item.hour, item.minute);
    if (item.kind === 'once') return `once at ${clock}`;
    if (item.intervalDays === 7) return `every week at ${clock}`;
    return `every day at ${clock}`;
  }

  private reload(): void {
    this.items.set(this.load());
  }

  private persist(): void {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(this.items()));
    } catch {
      // Ava can still keep the in-memory list for this session.
    }
  }

  private load(): AvaSchedule[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw) as AvaSchedule[];
      return Array.isArray(parsed) ? parsed.filter(item => item?.id && item.task) : [];
    } catch {
      return [];
    }
  }

  private storageKey(): string {
    return `ava-schedules:${this.gardens.currentGardenId() || 'default'}`;
  }
}

export function nextRunAt(parsed: Pick<ParsedSchedule, 'hour' | 'minute' | 'delayMs'>, now = new Date()): Date {
  if (parsed.delayMs && parsed.delayMs > 0) {
    return new Date(now.getTime() + parsed.delayMs);
  }
  return nextClock(parsed.hour, parsed.minute, now);
}

export function nextClock(hour: number, minute: number, from = new Date()): Date {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function formatClock(hour: number, minute: number): string {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function advance(item: AvaSchedule, now: Date): AvaSchedule {
  if (item.kind === 'once') {
    return { ...item, enabled: false };
  }
  let next = nextClock(item.hour, item.minute, now);
  if (item.intervalDays > 1) {
    next = new Date(next);
    next.setDate(next.getDate() + (item.intervalDays - 1));
  }
  return { ...item, nextRunAt: next.toISOString() };
}
