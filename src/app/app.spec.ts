import {
  composeManualPrompt,
  copyTextToClipboard,
  formatFileSize,
  imageFileName,
  isAbortError,
  joinPath,
} from './app';

describe('image helpers', () => {
  it('builds a workspace path and a safe photo filename', () => {
    expect(joinPath('C:\\src\\photos', 'ava.jpg')).toBe('C:\\src\\photos\\ava.jpg');
    expect(imageFileName({ dataUrl: 'data:image/jpeg;base64,abc', prompt: 'Three women' })).toMatch(
      /^ava-three-women-\w+\.jpg$/,
    );
  });
});

describe('composer helpers', () => {
  it('formats file sizes for attachment previews', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(400)).toBe('400 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(20 * 1024)).toBe('20 KB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('joins attached files and the typed prompt', () => {
    expect(composeManualPrompt('  enhance this  ', [
      { name: 'notes.txt', text: 'hello' },
    ])).toBe('Use this file as context:\nFile: notes.txt\n\nhello\n\nenhance this');
    expect(composeManualPrompt('', [{ name: 'notes.txt', text: 'hello' }])).toBe(
      'Use this file as context:\nFile: notes.txt\n\nhello',
    );
  });

  it('detects abort errors so a stopped request stays silent', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBeTrue();
    expect(isAbortError(new Error('The user aborted a request.'))).toBeTrue();
    expect(isAbortError(new Error('network failed'))).toBeFalse();
  });
});

describe('copyTextToClipboard', () => {
  it('uses the browser clipboard API when available', async () => {
    const writeText = jasmine.createSpy('writeText').and.resolveTo(undefined);
    const originalClipboard = navigator.clipboard;

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const copied = await copyTextToClipboard('hello world');
      expect(copied).toBeTrue();
      expect(writeText).toHaveBeenCalledWith('hello world');
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});
