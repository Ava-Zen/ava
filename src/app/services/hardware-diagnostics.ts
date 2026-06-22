import { Injectable, computed, signal } from '@angular/core';
import { DeviceCapability, detectDeviceCapability, isAndroidWebView } from './device-capability';

export interface HardwareDiagnostics {
  userAgent: string;
  platform: string;
  browser: string;
  os: string;
  cores: number;
  memoryGb?: number;
  hasWebGPU: boolean;
  hasWebNN: boolean;
  supportsLlmWebGPU: boolean;
  maxComputeWorkgroupStorageSize?: number;
  tier: DeviceCapability['tier'];
  androidWebView: boolean;
}

@Injectable({ providedIn: 'root' })
export class HardwareDiagnosticsService {
  readonly diagnostics = signal<HardwareDiagnostics | null>(null);

  readonly readinessLabel = computed(() => {
    const info = this.diagnostics();
    if (!info) return 'Checking device';
    if ((info.hasWebNN || info.supportsLlmWebGPU) && info.tier === 'high') return 'Strong local AI device';
    if (info.hasWebNN || info.supportsLlmWebGPU || info.tier === 'medium') return 'Good for local AI';
    return 'Limited local AI performance';
  });

  readonly readinessDetails = computed(() => {
    const info = this.diagnostics();
    if (!info) return 'Ava is checking browser and hardware capabilities.';
    if (info.hasWebNN) {
      return 'This device exposes WebNN, so Ava will try NPU/GPU acceleration before any CPU fallback.';
    }
    if (info.supportsLlmWebGPU) {
      return 'This browser exposes WebGPU, so Ava will try GPU-backed local chat models before any CPU fallback.';
    }
    return 'Ava will use WASM on CPU for local models. Smaller models are recommended on this device.';
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (typeof navigator === 'undefined') return;

    const capability = await detectDeviceCapability(true);
    const userAgent = navigator.userAgent;
    this.diagnostics.set({
      userAgent,
      platform: navigator.platform || 'Unknown',
      browser: this.detectBrowser(userAgent),
      os: this.detectOs(userAgent),
      cores: capability.cores,
      memoryGb: capability.memoryGb,
      hasWebGPU: capability.hasWebGPU,
      hasWebNN: capability.hasWebNN,
      supportsLlmWebGPU: capability.supportsLlmWebGPU,
      maxComputeWorkgroupStorageSize: capability.maxComputeWorkgroupStorageSize,
      tier: capability.tier,
      androidWebView: isAndroidWebView(),
    });
  }

  private detectBrowser(userAgent: string): string {
    if (/wv\)/i.test(userAgent) || /; wv/i.test(userAgent)) return 'Android WebView';
    if (/Edg\//i.test(userAgent)) return 'Edge';
    if (/Chrome\//i.test(userAgent)) return 'Chrome';
    if (/Firefox\//i.test(userAgent)) return 'Firefox';
    if (/Safari\//i.test(userAgent)) return 'Safari';
    return 'Unknown browser';
  }

  private detectOs(userAgent: string): string {
    if (/Android/i.test(userAgent)) return 'Android';
    if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iOS';
    if (/Windows/i.test(userAgent)) return 'Windows';
    if (/Mac OS X/i.test(userAgent)) return 'macOS';
    if (/Linux/i.test(userAgent)) return 'Linux';
    return 'Unknown OS';
  }
}
