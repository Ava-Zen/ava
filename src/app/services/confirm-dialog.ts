import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  readonly open = signal(false);
  readonly request = signal<ConfirmRequest | null>(null);
  private pending: ((value: boolean) => void) | null = null;

  ask(options: ConfirmOptions): Promise<boolean> {
    this.settle(false);
    this.request.set({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'Confirm',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      danger: options.danger ?? false,
    });
    this.open.set(true);
    return new Promise(resolve => {
      this.pending = resolve;
    });
  }

  confirm(): void {
    this.settle(true);
  }

  cancel(): void {
    this.settle(false);
  }

  private settle(value: boolean): void {
    const pending = this.pending;
    this.pending = null;
    this.open.set(false);
    this.request.set(null);
    pending?.(value);
  }
}
