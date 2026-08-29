import {
  allowOptionId,
  hasAllowAllOption,
  isCommandPermission,
  permissionOptionLabel,
} from './permissions';

describe('grok-cli permissions', () => {
  it('treats session permission prompts as command gates', () => {
    expect(
      isCommandPermission({
        method: 'session/request_permission',
        options: [{ optionId: 'allow-once', name: 'Allow once' }],
        questions: [],
      }),
    ).toBeTrue();
    expect(
      isCommandPermission({
        method: 'x.ai/ask_user_question',
        options: [],
        questions: [{ question: 'Ship it?', multiSelect: false, options: [] }],
      }),
    ).toBeFalse();
  });

  it('prefers allow-always and labels it Allow all', () => {
    const request = {
      options: [
        { optionId: 'allow-once', name: 'Allow once' },
        { optionId: 'allow-always', name: 'Allow always' },
        { optionId: 'reject-once', name: 'Reject' },
      ],
      questions: [],
    };
    expect(allowOptionId(request)).toBe('allow-always');
    expect(hasAllowAllOption(request)).toBeTrue();
    expect(permissionOptionLabel(request.options[1])).toBe('Allow all');
    expect(permissionOptionLabel(request.options[0])).toBe('Allow');
  });

  it('falls back to allow-once when that is all Grok offers', () => {
    expect(
      allowOptionId({
        options: [{ optionId: 'allow-once', name: 'Allow once' }],
        questions: [],
      }),
    ).toBe('allow-once');
    expect(
      hasAllowAllOption({
        options: [{ optionId: 'allow-once', name: 'Allow once' }],
        questions: [],
      }),
    ).toBeFalse();
  });
});
