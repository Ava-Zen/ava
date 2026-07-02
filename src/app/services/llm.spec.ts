import { LlmService } from './llm';

describe('LlmService', () => {
  it('strips chat-template role markers from model output', () => {
    const service = new LlmService();
    const output = '<|im_start|>system\nYou are Ava<|im_end|>\n<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\nHi there<|im_end|>';

    expect(service.sanitizeModelOutput(output)).toBe('Hi there');
  });

  it('strips Qwen3 thinking blocks from model output', () => {
    const service = new LlmService();
    const output = '<think>\nThe user wants a joke. Let me think…\n</think>\n\nWhy did the chicken cross the road?';

    expect(service.sanitizeModelOutput(output)).toBe('Why did the chicken cross the road?');
  });

  it('drops everything after an unterminated thinking block', () => {
    const service = new LlmService();
    const output = 'Sure!<think>reasoning that never ends';

    expect(service.sanitizeModelOutput(output)).toBe('Sure!');
  });
});
