import { SessionUpdate, TranscriptItem } from './types';

export function chunkText(update: SessionUpdate | Record<string, unknown>): string {
  const content = (update as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content)) {
    return content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

export function updateKind(update: SessionUpdate): string {
  return update.sessionUpdate?.trim() || '';
}

export function friendlyTool(name: string, title: string): string {
  const key = `${name} ${title}`.toLowerCase();
  if (key.includes('read_file') || key.includes('list_dir')) return 'Read';
  if (key.includes('grep') || key.includes('search')) return 'Searched';
  if (key.includes('search_replace') || /\bwrite\b/.test(key)) return 'Edited';
  if (key.includes('run_terminal') || key.includes('bash') || key.includes('execute')) {
    return 'Ran command';
  }
  if (key.includes('web_search') || key.includes('web_fetch') || key.includes('open_page')) {
    return 'Looked up';
  }
  if (key.includes('image')) return 'Made an image';
  return title.trim() || name.trim() || 'Worked';
}

function toolName(update: SessionUpdate): string {
  const meta = update._meta?.['x.ai/tool'];
  if (meta && typeof meta === 'object') {
    const name = (meta as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return (update.title || '').trim();
}

function matchingUserIndex(items: TranscriptItem[], incoming: string): number {
  const text = incoming.trim();
  if (!text) return -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind !== 'user') continue;
    const have = items[i].text.trim();
    if (have === text) return i;
    if (have.includes(text) || text.includes(have)) return i;
  }
  return -1;
}

function ackPendingUser(items: TranscriptItem[], incoming: string, eid?: string | null): TranscriptItem[] {
  const i = matchingUserIndex(items, incoming);
  if (i < 0) return items;
  const item = items[i];
  if (item.kind !== 'user' || !item.pending) return items;
  const next = items.slice();
  next[i] = { ...item, pending: undefined, eid: item.eid ?? eid };
  return next;
}

function appendChunk(
  items: TranscriptItem[],
  kind: 'user' | 'agent' | 'thought',
  text: string,
  eid?: string | null,
): TranscriptItem[] {
  if (!text) return items;
  const last = items[items.length - 1];
  if (last && last.kind === kind && !last.pending) {
    const next = items.slice();
    next[next.length - 1] = { ...last, text: last.text + text, eid: last.eid ?? eid };
    return next;
  }
  return [...items, { kind, text, eid }];
}

function upsertWork(items: TranscriptItem[], update: SessionUpdate, eid?: string | null): TranscriptItem[] {
  const id = update.toolCallId || eid || '';
  const name = toolName(update);
  const title = friendlyTool(name, update.title || '');
  const text = chunkText(update) || (update.title || '').trim();
  const status = update.status || update.stopReason || 'running';
  if (id) {
    const index = items.findIndex(item => item.kind === 'work' && item.toolCallId === id);
    if (index >= 0) {
      const next = items.slice();
      const prev = next[index];
      next[index] = {
        ...prev,
        title: title || prev.title,
        text: text || prev.text,
        status,
        eid: prev.eid ?? eid,
      };
      return next;
    }
  }
  return [
    ...items,
    {
      kind: 'work',
      title,
      text,
      status,
      eid,
      toolCallId: id || null,
    },
  ];
}

export function applySessionUpdate(
  items: TranscriptItem[],
  update: SessionUpdate,
  eid?: string | null,
): TranscriptItem[] {
  const kind = updateKind(update);
  if (kind === 'user_message_chunk') {
    const text = chunkText(update);
    if (!text.trim()) return items;
    if (matchingUserIndex(items, text) >= 0) return ackPendingUser(items, text, eid);
    return appendChunk(items, 'user', text, eid);
  }
  if (kind === 'agent_message_chunk') {
    return appendChunk(items, 'agent', chunkText(update), eid);
  }
  if (kind === 'agent_thought_chunk') {
    return appendChunk(items, 'thought', chunkText(update), eid);
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return upsertWork(items, update, eid);
  }
  return items;
}

export function addPendingUser(items: TranscriptItem[], text: string): TranscriptItem[] {
  const trimmed = text.trim();
  if (!trimmed) return items;
  return [...items, { kind: 'user', text: trimmed, pending: true }];
}

export function spokenRecap(items: TranscriptItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'agent' && items[i].text.trim()) {
      const plain = items[i].text.replace(/[`*_#>-]/g, ' ').replace(/\s+/g, ' ').trim();
      const sentence = plain.split(/(?<=[.!?])\s+/)[0] || plain;
      return sentence.slice(0, 220);
    }
  }
  return '';
}

export function isTurnComplete(update: SessionUpdate): boolean {
  return updateKind(update) === 'turn_completed';
}

export function isReplayChannel(channel?: string | null): boolean {
  return channel === 'replay';
}
