import { okfGeneratedAt, okfHasType, parseOkf, slugify, stringifyOkf } from './okf';

describe('OKF', () => {
  it('round-trips frontmatter and body', () => {
    const raw = stringifyOkf({
      type: 'Topic',
      title: 'Work',
      tags: ['work', 'office'],
      generated: { by: 'ava/0.1', at: '2026-08-19T12:00:00Z' },
    }, 'Notes on work.\n');
    const doc = parseOkf(raw);
    expect(doc.frontmatter['type']).toBe('Topic');
    expect(doc.frontmatter['title']).toBe('Work');
    expect(doc.frontmatter['tags']).toEqual(['work', 'office']);
    expect((doc.frontmatter['generated'] as { by: string }).by).toBe('ava/0.1');
    expect(doc.body.trim()).toBe('Notes on work.');
  });

  it('slugifies titles for folder names', () => {
    expect(slugify('My Project Plan!')).toBe('my-project-plan');
    expect(slugify('   ')).toBe('topic');
  });

  it('reads generated.at and falls back to a v0.1 timestamp', () => {
    const current = parseOkf(stringifyOkf({
      type: 'Topic',
      generated: { by: 'ava/0.1', at: '2026-08-19T12:00:00Z' },
    }, 'body\n'));
    expect(okfHasType(current)).toBeTrue();
    expect(okfGeneratedAt(current)).toBe('2026-08-19T12:00:00Z');
    expect(okfGeneratedAt(parseOkf('---\ntype: Note\ntimestamp: 2026-01-02T00:00:00Z\n---\n\nHi\n'))).toBe(
      '2026-01-02T00:00:00Z',
    );
  });
});
