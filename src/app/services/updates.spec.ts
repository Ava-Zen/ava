import {
  buildSnooze,
  downloadProgress,
  fallbackReleaseNotes,
  formatBytes,
  isTauriDesktop,
  isVersionSnoozed,
  parseSnooze,
  UPDATE_SNOOZE_MS,
} from './updates';

describe('update helpers', () => {
  it('treats a matching snooze as active until it expires', () => {
    const now = 1_700_000_000_000;
    const record = buildSnooze('0.2.0', now);
    expect(record.until).toBe(now + UPDATE_SNOOZE_MS);
    expect(isVersionSnoozed('0.2.0', now + 1000, JSON.stringify(record))).toBeTrue();
    expect(isVersionSnoozed('0.2.0', record.until + 1, JSON.stringify(record))).toBeFalse();
    expect(isVersionSnoozed('0.3.0', now + 1000, JSON.stringify(record))).toBeFalse();
  });

  it('ignores broken snooze records', () => {
    expect(parseSnooze('{"nope":true}')).toBeNull();
    expect(parseSnooze('not-json')).toBeNull();
    expect(isVersionSnoozed('0.2.0', Date.now(), null)).toBeFalse();
  });

  it('clamps download progress and formats sizes', () => {
    expect(downloadProgress(0, 100)).toBe(0);
    expect(downloadProgress(50, 100)).toBe(0.5);
    expect(downloadProgress(200, 100)).toBe(1);
    expect(downloadProgress(10, 0)).toBe(0);
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(900)).toBe('1 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('uses a calm fallback when release notes are empty', () => {
    expect(fallbackReleaseNotes('  New voice fixes.  ')).toBe('New voice fixes.');
    expect(fallbackReleaseNotes('')).toContain('improvements and fixes');
  });

  it('only treats desktop Tauri shells as supported', () => {
    expect(isTauriDesktop()).toBeFalse();
  });
});
