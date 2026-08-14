import { isLikelyApiKey, isTokenExpiring, normalizeTokenPayload, parseGrokCliAuth } from './xai-auth';

describe('xAI auth helpers', () => {
  it('accepts console API keys and long tokens', () => {
    expect(isLikelyApiKey('xai-abcdefghijklmnopqrstuvwxyz')).toBeTrue();
    expect(isLikelyApiKey('not-a-key')).toBeFalse();
    expect(isLikelyApiKey('super-long-token-without-prefix-123456')).toBeTrue();
  });

  it('treats tokens as expiring within a minute', () => {
    expect(isTokenExpiring(Date.now() + 10_000, Date.now())).toBeTrue();
    expect(isTokenExpiring(Date.now() + 120_000, Date.now())).toBeFalse();
    expect(isTokenExpiring(undefined)).toBeFalse();
  });

  it('normalizes OAuth token payloads', () => {
    const tokens = normalizeTokenPayload({
      access_token: 'tok',
      refresh_token: 'ref',
      expires_in: 3600,
    });
    expect(tokens.accessToken).toBe('tok');
    expect(tokens.refreshToken).toBe('ref');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('reads Grok CLI auth.json from nested or flat shapes', () => {
    expect(parseGrokCliAuth('{"access_token":"abc","refresh_token":"def"}')?.accessToken).toBe('abc');
    expect(parseGrokCliAuth('{"xai":{"accessToken":"nested"}}')?.accessToken).toBe('nested');
    expect(parseGrokCliAuth('{"nope":true}')).toBeNull();
  });
});
