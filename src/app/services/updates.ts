import { Injectable, signal } from '@angular/core';

export const UPDATE_SNOOZE_KEY = 'ava.update.snooze';
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export type UpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'installing'
  | 'error';

export interface AvailableUpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}

export interface UpdateSnooze {
  version: string;
  until: number;
}

type PendingUpdate = NonNullable<
  Awaited<ReturnType<(typeof import('@tauri-apps/plugin-updater'))['check']>>
>;

export function isTauriDesktop(): boolean {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return !/Android|iPhone|iPad|iPod/i.test(ua);
}

export function parseSnooze(raw: string | null): UpdateSnooze | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UpdateSnooze;
    if (!parsed?.version || typeof parsed.until !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isVersionSnoozed(
  version: string,
  now = Date.now(),
  raw: string | null = null,
): boolean {
  const record = parseSnooze(raw);
  if (!record || record.version !== version) return false;
  return record.until > now;
}

export function buildSnooze(version: string, now = Date.now()): UpdateSnooze {
  return { version, until: now + UPDATE_SNOOZE_MS };
}

export function downloadProgress(downloaded: number, total?: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(1, downloaded / total);
}

export function fallbackReleaseNotes(notes?: string | null): string {
  const trimmed = (notes || '').trim();
  return trimmed || 'A small set of improvements and fixes is ready to install.';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = 1024 * 1024;
  if (bytes >= mb) return `${(bytes / mb).toFixed(bytes >= 10 * mb ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

@Injectable({ providedIn: 'root' })
export class UpdateService {
  readonly supported = signal(false);
  readonly phase = signal<UpdatePhase>('idle');
  readonly available = signal<AvailableUpdateInfo | null>(null);
  readonly error = signal<string | null>(null);
  readonly progress = signal(0);
  readonly bytesDownloaded = signal(0);
  readonly bytesTotal = signal(0);
  readonly dialogOpen = signal(false);
  readonly currentVersion = signal('');

  private pending: PendingUpdate | null = null;
  private checkInFlight: Promise<boolean> | null = null;
  private autoCheckStarted = false;

  constructor() {
    if (!isTauriDesktop()) {
      this.phase.set('unsupported');
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        void this.loadCurrentVersion();
      }
      return;
    }
    this.supported.set(true);
    void this.loadCurrentVersion();
  }

  scheduleAutoCheck(delayMs = 2800): void {
    if (!this.supported() || this.autoCheckStarted) return;
    this.autoCheckStarted = true;
    setTimeout(() => {
      void this.check({ silent: true });
    }, delayMs);
  }

  async check(options: { silent?: boolean } = {}): Promise<boolean> {
    const silent = options.silent === true;
    if (!this.supported()) {
      if (!silent) this.phase.set('unsupported');
      return false;
    }
    if (this.phase() === 'downloading' || this.phase() === 'installing') {
      if (!silent) this.dialogOpen.set(true);
      return !!this.available();
    }
    if (this.checkInFlight) return this.checkInFlight;

    this.checkInFlight = this.runCheck(silent).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  later(): void {
    if (this.phase() === 'downloading' || this.phase() === 'installing') return;
    const version = this.available()?.version;
    if (version) this.persistSnooze(version);
    this.dialogOpen.set(false);
    this.phase.set(this.available() ? 'available' : 'idle');
  }

  async install(): Promise<void> {
    if (!this.pending) {
      const found = await this.check({ silent: false });
      if (!found || !this.pending) return;
    }

    this.error.set(null);
    this.progress.set(0);
    this.bytesDownloaded.set(0);
    this.bytesTotal.set(0);
    this.phase.set('downloading');
    this.dialogOpen.set(true);

    let downloaded = 0;
    try {
      await this.pending.downloadAndInstall(event => {
        if (event.event === 'Started') {
          this.bytesTotal.set(event.data.contentLength ?? 0);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength ?? 0;
          this.bytesDownloaded.set(downloaded);
          this.progress.set(downloadProgress(downloaded, this.bytesTotal() || undefined));
        } else if (event.event === 'Finished') {
          this.progress.set(1);
          this.phase.set('installing');
        }
      });
      this.phase.set('installing');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (err) {
      this.phase.set('error');
      this.error.set(this.describeError(err, 'The update could not be installed.'));
    }
  }

  private async runCheck(silent: boolean): Promise<boolean> {
    this.error.set(null);
    this.phase.set('checking');
    if (!silent) this.dialogOpen.set(false);

    try {
      await this.loadCurrentVersion();
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ timeout: 20_000 });
      if (this.pending) {
        await this.pending.close().catch(() => undefined);
        this.pending = null;
      }

      if (!update) {
        this.available.set(null);
        this.phase.set('up-to-date');
        return false;
      }

      this.pending = update;
      const info: AvailableUpdateInfo = {
        version: update.version,
        currentVersion: update.currentVersion || this.currentVersion(),
        notes: fallbackReleaseNotes(update.body),
        date: update.date,
      };
      this.available.set(info);
      this.phase.set('available');
      if (!silent || !this.isSnoozed(info.version)) {
        this.dialogOpen.set(true);
      }
      return true;
    } catch (err) {
      if (silent) {
        this.phase.set('idle');
        this.error.set(null);
        return false;
      }
      this.phase.set('error');
      this.error.set(this.describeError(err, 'Could not check for updates.'));
      return false;
    }
  }

  private async loadCurrentVersion(): Promise<void> {
    if (this.currentVersion()) return;
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      this.currentVersion.set(await getVersion());
    } catch {
      this.currentVersion.set('');
    }
  }

  private isSnoozed(version: string): boolean {
    try {
      return isVersionSnoozed(version, Date.now(), localStorage.getItem(UPDATE_SNOOZE_KEY));
    } catch {
      return false;
    }
  }

  private persistSnooze(version: string): void {
    try {
      localStorage.setItem(UPDATE_SNOOZE_KEY, JSON.stringify(buildSnooze(version)));
    } catch {
      // session-only later is still fine
    }
  }

  private describeError(err: unknown, fallback: string): string {
    const message = err instanceof Error ? err.message : String(err ?? '');
    const compact = message.replace(/\s+/g, ' ').trim();
    if (!compact) return fallback;
    if (/Could not fetch a valid release JSON/i.test(compact) || /404/.test(compact)) {
      return 'No published desktop release was found yet.';
    }
    if (/network|fetch|timeout|timed out|dns|offline/i.test(compact)) {
      return 'Could not reach GitHub to look for updates.';
    }
    return compact.length > 180 ? fallback : compact;
  }
}
