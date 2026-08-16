import { Component, inject } from '@angular/core';
import { ConfirmDialogService } from '../services/confirm-dialog';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.css',
})
export class ConfirmDialog {
  private readonly confirm = inject(ConfirmDialogService);

  protected readonly open = this.confirm.open;
  protected readonly request = this.confirm.request;

  protected onBackdrop(): void {
    this.confirm.cancel();
  }

  protected onCancel(): void {
    this.confirm.cancel();
  }

  protected onConfirm(): void {
    this.confirm.confirm();
  }
}
