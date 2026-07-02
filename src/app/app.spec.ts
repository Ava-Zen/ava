import { copyTextToClipboard } from './app';

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
