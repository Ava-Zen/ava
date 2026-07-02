import { LlmService } from './llm';

describe('LlmService', () => {
  it('strips chat-template role markers from model output', () => {
    const service = new LlmService();
    const output = '<|im_start|>system\nYou are Ava<|im_end|>\n<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\nHi there<|im_end|>';

    expect(service.sanitizeModelOutput(output)).toBe('Hi there');
  });
});
