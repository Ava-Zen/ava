import { BROWSER_HOME, canRevealHomePath, isBrowserHome } from './home';

describe('home folder reveal', () => {
  it('opens only a real folder on a native host', () => {
    expect(canRevealHomePath('C:\\Users\\Ava\\Documents\\Ava', true)).toBeTrue();
    expect(canRevealHomePath('/home/ava/Documents/Ava', true)).toBeTrue();
    expect(canRevealHomePath('C:\\Users\\Ava\\Documents\\Ava', false)).toBeFalse();
    expect(canRevealHomePath(BROWSER_HOME, true)).toBeFalse();
    expect(canRevealHomePath(null, true)).toBeFalse();
  });

  it('treats the in-browser store as not a folder', () => {
    expect(isBrowserHome(BROWSER_HOME)).toBeTrue();
    expect(isBrowserHome(`${BROWSER_HOME}:garden-2`)).toBeTrue();
    expect(isBrowserHome('C:\\Users\\Ava\\Documents\\Ava')).toBeFalse();
  });
});
