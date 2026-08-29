import { buildSelfImproveFollowUp, buildSelfImprovePrompt } from './self-improve';

describe('buildSelfImprovePrompt', () => {
  it('asks Grok to compile, speak, and hand off restart', () => {
    const prompt = buildSelfImprovePrompt('changing the color of the Pause button');
    expect(prompt).toContain('changing the color of the Pause button');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('cargo check');
    expect(prompt).toContain('speak');
    expect(prompt).toContain('self_improve_ready');
    expect(prompt).toContain('Stay in this workspace');
  });

  it('keeps follow-ups on the same protocol', () => {
    const prompt = buildSelfImproveFollowUp('how you visualize memory');
    expect(prompt).toContain('how you visualize memory');
    expect(prompt).toContain('self_improve_ready');
    expect(prompt).toContain('compile must pass');
  });
});
