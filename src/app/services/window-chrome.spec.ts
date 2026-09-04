import { compactWindowSize, ORB_MENU_SIZE, ORB_WINDOW_SIZE, parseChromeState } from './window-chrome';

describe('window chrome', () => {
  it('parses missing or invalid storage as off', () => {
    expect(parseChromeState(null)).toEqual({ compact: false, alwaysOnTop: false, restore: null });
    expect(parseChromeState('{')).toEqual({ compact: false, alwaysOnTop: false, restore: null });
    expect(parseChromeState('{"compact":"yes"}')).toEqual({
      compact: false,
      alwaysOnTop: false,
      restore: null,
    });
  });

  it('keeps compact and always-on-top flags', () => {
    expect(parseChromeState('{"compact":true,"alwaysOnTop":true}')).toEqual({
      compact: true,
      alwaysOnTop: true,
      restore: null,
    });
  });

  it('restores a full-size window rect and ignores orb-sized leftovers', () => {
    expect(
      parseChromeState('{"compact":true,"alwaysOnTop":false,"restore":{"width":480,"height":760,"x":40,"y":80}}'),
    ).toEqual({
      compact: true,
      alwaysOnTop: false,
      restore: { width: 480, height: 760, x: 40, y: 80 },
    });
    expect(
      parseChromeState('{"restore":{"width":196,"height":196,"x":10,"y":10}}').restore,
    ).toBeNull();
  });

  it('grows the orb window when the menu needs to fit', () => {
    expect(compactWindowSize(false)).toEqual(ORB_WINDOW_SIZE);
    expect(compactWindowSize(true)).toEqual(ORB_MENU_SIZE);
  });
});
