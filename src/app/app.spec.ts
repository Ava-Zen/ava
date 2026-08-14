import { copyTextToClipboard, imageFileName, joinPath } from './app';

describe('image helpers', () => {
  it('builds a workspace path and a safe photo filename', () => {
    expect(joinPath('C:\\src\\photos', 'ava.jpg')).toBe('C:\\src\\photos\\ava.jpg');
    expect(imageFileName({ dataUrl: 'data:image/jpeg;base64,abc', prompt: 'Three women' })).toMatch(
      /^ava-three-women-\w+\.jpg$/,
    );
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
