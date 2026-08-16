import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { formatBytes, UpdateService } from '../services/updates';

@Component({
  selector: 'app-update-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './update-dialog.html',
  styleUrl: './update-dialog.css',
})
export class UpdateDialog {
  private readonly updates = inject(UpdateService);

  protected readonly open = this.updates.dialogOpen;
  protected readonly phase = this.updates.phase;
  protected readonly available = this.updates.available;
  protected readonly error = this.updates.error;
  protected readonly progress = this.updates.progress;
  protected readonly busy = computed(() => {
    const phase = this.phase();
    return phase === 'downloading' || phase === 'installing';
  });
  protected readonly percent = computed(() => Math.round(this.progress() * 100));
  protected readonly progressLabel = computed(() => {
    const done = formatBytes(this.updates.bytesDownloaded());
    const total = formatBytes(this.updates.bytesTotal());
    if (done && total) return `${done} of ${total}`;
    if (this.phase() === 'installing') return 'Preparing to restart';
    return 'Starting download';
  });

  later() {
    if (this.busy()) return;
    this.updates.later();
  }

  install() {
    if (this.busy()) return;
    void this.updates.install();
  }
}
