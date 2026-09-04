import { TestBed } from '@angular/core/testing';
import { LlmService, parseGrokReasoningEffort } from './llm';

describe('LlmService', () => {
  const createService = () => {
    TestBed.configureTestingModule({});
    return TestBed.inject(LlmService);
  };

  it('strips chat-template role markers from model output', () => {
    const service = createService();
    const output = '<|im_start|>system\nYou are Ava<|im_end|>\n<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\nHi there<|im_end|>';

    expect(service.sanitizeModelOutput(output)).toBe('Hi there');
  });

  it('strips Qwen3 thinking blocks from model output', () => {
    const service = createService();
    const output = '<think>\nThe user wants a joke. Let me think…\n</think>\n\nWhy did the chicken cross the road?';

    expect(service.sanitizeModelOutput(output)).toBe('Why did the chicken cross the road?');
  });

  it('drops everything after an unterminated thinking block', () => {
    const service = createService();
    const output = 'Sure!<think>reasoning that never ends';

    expect(service.sanitizeModelOutput(output)).toBe('Sure!');
  });
});

describe('parseGrokReasoningEffort', () => {
  it('defaults to low', () => {
    expect(parseGrokReasoningEffort(null)).toBe('low');
    expect(parseGrokReasoningEffort('')).toBe('low');
    expect(parseGrokReasoningEffort('fast')).toBe('low');
  });

  it('keeps supported levels', () => {
    expect(parseGrokReasoningEffort('medium')).toBe('medium');
    expect(parseGrokReasoningEffort('high')).toBe('high');
    expect(parseGrokReasoningEffort('xhigh')).toBe('xhigh');
  });
});
