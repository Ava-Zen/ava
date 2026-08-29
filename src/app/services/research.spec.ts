import { clipSpokenSummary, parseResearchOutput } from './research';

describe('research output', () => {
  it('splits SPEAK and REPORT labels', () => {
    const parsed = parseResearchOutput(
      'SPEAK: You showed up in two talks this week.\nREPORT:\n## Highlights this week\n- A talk in Oslo.',
    );
    expect(parsed.spoken).toContain('two talks');
    expect(parsed.report).toContain('Highlights this week');
  });

  it('falls back to the first paragraph when labels are missing', () => {
    const parsed = parseResearchOutput('Quiet week online.\n\n## Report\nNothing loud.');
    expect(parsed.spoken).toBe('Quiet week online.');
    expect(parsed.report).toContain('Nothing loud');
  });

  it('keeps spoken summaries short', () => {
    const long = 'One. Two. Three. Four. Five.';
    expect(clipSpokenSummary(long).startsWith('One. Two. Three.')).toBeTrue();
  });
});
