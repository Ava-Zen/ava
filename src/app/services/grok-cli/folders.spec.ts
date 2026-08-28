import { folderName, matchFolderByHint, normalizeFolderKey, uniqueFolders } from './folders';

describe('grok-cli folders', () => {
  it('reads the last path segment', () => {
    expect(folderName('F:\\github\\nostria')).toBe('nostria');
    expect(folderName('/Users/me/src/Nostria/')).toBe('Nostria');
    expect(folderName('')).toBe('');
  });

  it('matches a spoken project name to a unique folder', () => {
    const folders = [
      { path: 'F:\\github\\ava' },
      { path: 'F:\\github\\nostria', name: 'Nostria' },
      { path: 'C:\\src\\notes' },
    ];
    expect(matchFolderByHint('Nostria', folders)).toBe('F:\\github\\nostria');
    expect(matchFolderByHint('nostria project', folders)).toBe('F:\\github\\nostria');
    expect(matchFolderByHint('ava', folders)).toBe('F:\\github\\ava');
  });

  it('returns null when the name is missing or tied', () => {
    expect(matchFolderByHint('Nostria', [{ path: 'F:\\github\\ava' }])).toBeNull();
    expect(
      matchFolderByHint('web', [
        { path: 'C:\\src\\web-app' },
        { path: 'C:\\src\\web-api' },
      ]),
    ).toBeNull();
    expect(matchFolderByHint('x', [{ path: 'C:\\src\\xyz' }])).toBeNull();
  });

  it('keeps the first unique path', () => {
    expect(
      uniqueFolders([
        { path: 'F:\\github\\nostria', name: 'Nostria' },
        { path: 'F:\\github\\nostria' },
        { path: 'F:\\github\\ava' },
      ]).map(folder => folder.path),
    ).toEqual(['F:\\github\\nostria', 'F:\\github\\ava']);
  });

  it('normalizes project-ish suffixes', () => {
    expect(normalizeFolderKey('Nostria-project')).toBe('nostria');
  });
});
