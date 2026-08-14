import { GROK_OAUTH_API_BASE, XAI_API_BASE, resolveXaiBaseUrl } from '../xai/xai-http';
import { parseResponsesPayload, wantsImage } from './grok-chat-backend';

describe('wantsImage', () => {
  it('detects casual photo requests', () => {
    expect(wantsImage('make a photo for me')).toBeTrue();
    expect(wantsImage('Can you draw a picture of a garden?')).toBeTrue();
    expect(wantsImage('what time is it')).toBeFalse();
  });
});

describe('resolveXaiBaseUrl', () => {
  it('sends SuperGrok OAuth to the subscription chat proxy', () => {
    expect(resolveXaiBaseUrl('oauth')).toBe(GROK_OAUTH_API_BASE);
  });

  it('sends API keys to the developer API', () => {
    expect(resolveXaiBaseUrl('api-key')).toBe(XAI_API_BASE);
  });
});

describe('parseResponsesPayload', () => {
  it('prefers output_text and collects Imagine images', () => {
    const result = parseResponsesPayload({
      output_text: 'Here is a sketch.',
      output: [
        {
          type: 'image_generation_call',
          prompt: 'a calm garden',
          result: 'abc123',
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'ignored when output_text exists' }],
        },
      ],
    });

    expect(result.text).toBe('Here is a sketch.');
    expect(result.images?.length).toBe(1);
    expect(result.images?.[0].dataUrl).toBe('data:image/jpeg;base64,abc123');
    expect(result.images?.[0].prompt).toBe('a calm garden');
  });

  it('falls back to message content when output_text is missing', () => {
    const result = parseResponsesPayload({
      output: [
        {
          type: 'message',
          content: [{ text: 'Spoken reply' }],
        },
      ],
    });
    expect(result.text).toBe('Spoken reply');
  });
});
