import { TestBed } from '@angular/core/testing';
import {
  clipDebugText,
  DebugLogService,
  extractThinkBlock,
  formatDebugDetail,
} from './debug-log';

describe('debug log helpers', () => {
  it('pulls closed and open thinking blocks out of model text', () => {
    expect(extractThinkBlock('Hello <think>I should greet them</think> Hi.')).toBe(
      'I should greet them',
    );
    expect(extractThinkBlock('Sure!<think>reasoning that never ends')).toBe(
      'reasoning that never ends',
    );
    expect(extractThinkBlock('No thinking here')).toBeNull();
  });

  it('strips data URLs and caps long details', () => {
    expect(clipDebugText('photo data:image/jpeg;base64,abc123== done')).toBe(
      'photo data:… done',
    );
    const long = 'x'.repeat(5000);
    const clipped = clipDebugText(long, 40);
    expect(clipped.startsWith('x'.repeat(40))).toBeTrue();
    expect(clipped).toContain('4960 more characters');
  });

  it('formats objects as json', () => {
    expect(formatDebugDetail({ tool: 'search_location', q: 'oslo' })).toContain(
      '"tool": "search_location"',
    );
    expect(formatDebugDetail('')).toBeUndefined();
  });
});

describe('DebugLogService', () => {
  const createService = () => {
    TestBed.configureTestingModule({});
    return TestBed.inject(DebugLogService);
  };

  it('keeps a ring buffer of events with thinking and tool live labels', () => {
    const service = createService();
    service.available.set(true);
    service.log('route', 'LLM');
    service.log('think', 'Gathering what I remember');
    service.log('tool', 'Calling search_location', { q: 'oslo' });

    const events = service.events();
    expect(events.length).toBe(3);
    expect(events[0].title).toBe('LLM');
    expect(events[2].detail).toContain('search_location');
    expect(service.liveThink()).toBe('Gathering what I remember');
    expect(service.liveCommand()).toBe('Calling search_location');
  });

  it('clears events and live labels', () => {
    const service = createService();
    service.available.set(true);
    service.log('error', 'Weather failed', 'timeout');
    service.clear();
    expect(service.events()).toEqual([]);
    expect(service.liveCommand()).toBe('');
  });
});
