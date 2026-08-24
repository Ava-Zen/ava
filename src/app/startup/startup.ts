import {
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  HostListener,
  Output,
  ViewChild,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-startup',
  standalone: true,
  templateUrl: './startup.html',
  styleUrl: './startup.css',
})
export class Startup {
  @Output() finished = new EventEmitter<void>();

  @ViewChild('reel') private reel?: ElementRef<HTMLVideoElement>;

  protected readonly fading = signal(false);

  private readonly destroyRef = inject(DestroyRef);
  private closed = false;
  private safetyTimer = 0;
  private fadeTimer = 0;

  constructor() {
    afterNextRender(() => this.arm());
    this.destroyRef.onDestroy(() => {
      window.clearTimeout(this.safetyTimer);
      window.clearTimeout(this.fadeTimer);
      this.reel?.nativeElement.pause();
    });
  }

  @HostListener('document:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismiss();
  }

  protected onEnded(): void {
    this.dismiss();
  }

  protected onSkip(): void {
    this.dismiss();
  }

  protected onError(): void {
    this.dismiss();
  }

  private arm(): void {
    if (this.closed) return;

    if (prefersReducedMotion()) {
      this.dismiss();
      return;
    }

    const video = this.reel?.nativeElement;
    if (!video) {
      this.dismiss();
      return;
    }

    const overlay = video.closest('.startup-overlay') as HTMLElement | null;
    overlay?.focus();

    // Desktop WebView usually allows sound; browsers often block it until a gesture.
    video.muted = false;
    const play = video.play();
    if (play) {
      play.catch(() => {
        video.muted = true;
        void video.play().catch(() => this.dismiss());
      });
    }

    this.safetyTimer = window.setTimeout(() => this.dismiss(), 12000);
  }

  private dismiss(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.safetyTimer);

    const video = this.reel?.nativeElement;
    if (video) {
      video.pause();
      video.muted = true;
    }

    this.fading.set(true);
    this.fadeTimer = window.setTimeout(() => this.finished.emit(), 720);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

