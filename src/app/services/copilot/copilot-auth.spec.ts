import {
  inferCopilotAgent,
  isExplicitCopilotRequest,
  isGithubWorkRequest,
  isSupportedGithubToken,
  shouldUseCopilot,
} from './copilot-auth';

describe('Copilot auth helpers', () => {
  it('accepts Copilot-supported GitHub tokens and rejects classic PATs', () => {
    expect(isSupportedGithubToken('github_pat_abcdefghijklmnopqrstuvwxyz')).toBeTrue();
    expect(isSupportedGithubToken('gho_abcdefghijklmnopqrst')).toBeTrue();
    expect(isSupportedGithubToken('ghu_abcdefghijklmnopqrst')).toBeTrue();
    expect(isSupportedGithubToken('ghp_abcdefghijklmnopqrstuvwxyz')).toBeFalse();
    expect(isSupportedGithubToken('not-a-token')).toBeFalse();
  });

  it('detects an explicit Copilot request', () => {
    expect(isExplicitCopilotRequest('Ask Copilot to review this')).toBeTrue();
    expect(isExplicitCopilotRequest('use github copilot on the auth module')).toBeTrue();
    expect(isExplicitCopilotRequest('research this in the background')).toBeFalse();
  });

  it('infers a Copilot sub-agent from the prompt', () => {
    expect(inferCopilotAgent('research how login works')).toBe('researcher');
    expect(inferCopilotAgent('implement a fix for the crash')).toBe('implementer');
    expect(inferCopilotAgent('plan the migration steps')).toBe('planner');
    expect(inferCopilotAgent('get my GitHub issues')).toBe('github');
    expect(inferCopilotAgent('just think about this')).toBeUndefined();
  });

  it('routes GitHub work to Copilot when signed in', () => {
    expect(isGithubWorkRequest('get my GitHub issues')).toBeTrue();
    expect(isGithubWorkRequest('list my open PRs')).toBeTrue();
    expect(isGithubWorkRequest('what is the weather')).toBeFalse();
    expect(shouldUseCopilot('get my GitHub issues', true, false)).toBeTrue();
    expect(shouldUseCopilot('get my GitHub issues', false, false)).toBeFalse();
  });
});
