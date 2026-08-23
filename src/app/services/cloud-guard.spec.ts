import { CLOUD_BLOCKED_MESSAGE, isCloudUrl } from './cloud-guard';

describe('cloud guard', () => {
  it('recognizes Grok and GitHub hosts', () => {
    expect(isCloudUrl('https://api.x.ai/v1/responses')).toBeTrue();
    expect(isCloudUrl('https://cli-chat-proxy.grok.com/v1/responses')).toBeTrue();
    expect(isCloudUrl('https://github.com/login/device/code')).toBeTrue();
    expect(isCloudUrl('https://api.github.com/user')).toBeTrue();
    expect(isCloudUrl('http://127.0.0.1:3210/tts')).toBeFalse();
  });

  it('exposes a stable blocked message', () => {
    expect(CLOUD_BLOCKED_MESSAGE).toContain('blocked');
  });
});
