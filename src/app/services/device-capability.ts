/**
 * Lightweight device capability detection used to pick an appropriate
 * on-device model size for a given machine.
 *
 * Tiers:
 *  - 'low'    : no WebGPU and/or limited RAM — favour the smallest models.
 *  - 'medium' : WebGPU or a reasonable amount of RAM — mid-size models.
 *  - 'high'   : WebGPU plus plenty of RAM — the largest local models.
 */
export type DeviceTier = 'low' | 'medium' | 'high';

export interface DeviceCapability {
  tier: DeviceTier;
  hasWebGPU: boolean;
  /** Approximate device memory in GB (Chrome-only; undefined elsewhere). */
  memoryGb?: number;
  /** Number of logical CPU cores. */
  cores: number;
}

let cached: DeviceCapability | null = null;

export async function supportsWebGPU(): Promise<boolean> {
  try {
    // @ts-ignore — navigator.gpu is not in all lib targets yet
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/**
 * Detects the device capability once and caches the result.
 * The detection is intentionally conservative: when the browser does not
 * expose memory information we fall back to WebGPU + core count heuristics.
 */
export async function detectDeviceCapability(force = false): Promise<DeviceCapability> {
  if (cached && !force) return cached;

  const hasWebGPU = await supportsWebGPU();
  const memoryGb = typeof navigator !== 'undefined'
    ? (navigator as any).deviceMemory as number | undefined
    : undefined;
  const cores = typeof navigator !== 'undefined'
    ? navigator.hardwareConcurrency || 4
    : 4;

  let tier: DeviceTier;
  if (hasWebGPU && (memoryGb === undefined ? cores >= 8 : memoryGb >= 8)) {
    tier = 'high';
  } else if (hasWebGPU || (memoryGb !== undefined ? memoryGb >= 4 : cores >= 4)) {
    tier = 'medium';
  } else {
    tier = 'low';
  }

  cached = { tier, hasWebGPU, memoryGb, cores };
  return cached;
}
