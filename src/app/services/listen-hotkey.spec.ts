import { parseListenHotkey } from './listen-hotkey';

describe('listen hotkey', () => {
  it('defaults blank storage to F8', () => {
    expect(parseListenHotkey(null)).toBe('F8');
    expect(parseListenHotkey('')).toBe('off');
  });

  it('accepts the F-keys and off', () => {
    expect(parseListenHotkey('f8')).toBe('F8');
    expect(parseListenHotkey('F10')).toBe('F10');
    expect(parseListenHotkey('off')).toBe('off');
    expect(parseListenHotkey('F11')).toBe('F8');
  });
});
