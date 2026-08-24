import {
  addPendingUser,
  applySessionUpdate,
  chunkText,
  friendlyTool,
  isTurnComplete,
  spokenRecap,
} from './transcript';
import { TranscriptItem } from './types';

describe('grok-cli transcript', () => {
  it('reads text from chunk content shapes', () => {
    expect(chunkText({ content: 'hello' })).toBe('hello');
    expect(chunkText({ content: { text: 'hi' } })).toBe('hi');
    expect(chunkText({ content: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
  });

  it('appends agent chunks onto the open reply', () => {
    let items: TranscriptItem[] = [];
    items = applySessionUpdate(items, { sessionUpdate: 'agent_message_chunk', content: 'Hello' });
    items = applySessionUpdate(items, { sessionUpdate: 'agent_message_chunk', content: ' there' });
    expect(items).toEqual([{ kind: 'agent', text: 'Hello there', eid: undefined }]);
  });

  it('acks a pending user echo instead of duplicating it', () => {
    let items = addPendingUser([], 'List the files');
    items = applySessionUpdate(items, {
      sessionUpdate: 'user_message_chunk',
      content: 'List the files',
    }, 'e1');
    expect(items.length).toBe(1);
    expect(items[0].pending).toBeUndefined();
    expect(items[0].eid).toBe('e1');
  });

  it('upserts tool work by id', () => {
    let items: TranscriptItem[] = [];
    items = applySessionUpdate(items, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read_file src/app.ts',
    });
    items = applySessionUpdate(items, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      title: 'read_file src/app.ts',
      stopReason: 'completed',
    });
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe('work');
    expect(items[0].title).toBe('Read');
    expect(items[0].status).toBe('completed');
  });

  it('names common tools in plain language', () => {
    expect(friendlyTool('run_terminal_command', '')).toBe('Ran command');
    expect(friendlyTool('search_replace', 'edit')).toBe('Edited');
  });

  it('speaks a short recap of the last agent line', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'agent', text: 'I listed the files. Want me to open one?' },
      { kind: 'work', text: 'ls' },
    ];
    expect(spokenRecap(items)).toBe('I listed the files.');
  });

  it('detects turn completion', () => {
    expect(isTurnComplete({ sessionUpdate: 'turn_completed', stopReason: 'end_turn' })).toBeTrue();
    expect(isTurnComplete({ sessionUpdate: 'agent_message_chunk' })).toBeFalse();
  });
});
