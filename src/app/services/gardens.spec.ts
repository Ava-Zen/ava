import { homePathKey, sameHomePath } from './gardens';

describe('garden home folders', () => {
  it('treats trailing slashes and slash style as the same folder', () => {
    expect(sameHomePath('C:\\Users\\Ava\\Home', 'C:/Users/Ava/Home/')).toBeTrue();
    expect(homePathKey('C:\\Users\\Ava\\Home\\')).toBe('c:/users/ava/home');
  });

  it('does not treat different folders as the same', () => {
    expect(sameHomePath('C:\\Users\\Ava\\Home', 'C:\\Users\\Ava\\Work')).toBeFalse();
    expect(sameHomePath('C:\\Users\\Ava\\Home', '')).toBeFalse();
    expect(sameHomePath(undefined, 'C:\\Users\\Ava\\Home')).toBeFalse();
  });
});
