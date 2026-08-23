/** Quiet presence lines. Short on purpose — they are spoken-adjacent, not UI copy. */

export function hourOf(date = new Date()): number {
  return date.getHours();
}

export function presenceTitle(input: {
  listening?: boolean;
  thinking?: boolean;
  speaking?: boolean;
  paused?: boolean;
  name?: string;
  hour?: number;
}): string {
  if (input.listening) return 'I am listening.';
  if (input.thinking) return 'Let me think.';
  if (input.speaking) return input.paused ? 'Paused.' : 'Speaking with you.';
  const name = input.name?.trim();
  const hour = input.hour ?? hourOf();
  if (name && hour < 5) return `Still here, ${name}.`;
  if (name) return `I am here, ${name}.`;
  return 'I am here.';
}

export function presenceAside(input: {
  lastAt?: Date | null;
  topicTitle?: string | null;
  now?: Date;
}): string {
  if (!input.lastAt) return '';
  const now = input.now ?? new Date();
  const hours = (now.getTime() - input.lastAt.getTime()) / 3_600_000;
  if (hours < 8) return '';
  if (input.topicTitle) return `I still have ${input.topicTitle}.`;
  if (hours >= 36) return 'I have been here.';
  return 'Still here.';
}

export function rememberAck(): string {
  return 'I will keep that.';
}

export function isExplicitRemember(text: string): boolean {
  return /\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(text.trim())
    || /\bplease keep\b/i.test(text.trim());
}

export function isAskingWhatSheRemembers(text: string): boolean {
  const q = text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(what do you remember|what do you know about me|show me (your |the )?memory|what are you holding)\b/.test(q);
}

export interface PersonMention {
  name: string;
  relation: 'partner' | 'child' | 'person';
  role: string;
}

const NAME_STOP =
  /^(a|an|the|my|our|his|her|their|very|so|really|here|there|wonderful|amazing|great|good|nice|kind|sweet|one|called|named|is|are)$/i;

export function peopleFromText(text: string): PersonMention[] {
  const found: PersonMention[] = [];
  const seen = new Set<string>();
  const add = (raw: string, relation: PersonMention['relation'], role: string) => {
    const name = titleCaseName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, relation, role });
  };

  const partner = text.match(
    /\b(?:my|our)\s+(partner|wife|husband|spouse|girlfriend|boyfriend)(?:'s\s+name\s+is|\s+is\s+called|\s+is\s+named|\s+named|\s+is)\s+([A-Za-z][A-Za-z'-]{1,30}(?:\s+[A-Za-z][A-Za-z'-]{1,30})?)/i,
  );
  if (partner) add(partner[2], 'partner', titleCaseName(partner[1]) || 'Partner');

  const kids = text.match(
    /\b(?:my|our)\s+(?:kids?|children)(?:'s\s+names?\s+are|'s\s+name\s+is|\s+are\s+called|\s+are\s+named|\s+named|\s+are)\s+([^.?!]+)/i,
  );
  if (kids) {
    for (const part of splitNames(kids[1])) add(part, 'child', 'Child');
  }

  for (const match of text.matchAll(
    /\b(?:my|our)\s+(son|daughter|kid|child)\s+(?:is\s+(?:called|named)\s+|named\s+|is\s+)([A-Za-z][A-Za-z'-]{1,30})/gi,
  )) {
    add(match[2], 'child', titleCaseName(match[1]) || 'Child');
  }

  return found;
}

export function peopleAck(count: number): string {
  return count > 1 ? 'I will keep them.' : 'I will keep that.';
}

export function identityFact(text: string): string | null {
  const name = text.match(/\bmy name is\s+([^.,!?]{2,40})/i);
  if (name) return `Name is ${cleanFactTail(name[1])}`;
  const live = text.match(/\bi live in\s+([^.,!?]{2,40})/i);
  if (live) return `Lives in ${cleanFactTail(live[1])}`;
  const work = text.match(/\bi work(?:\s+as|\s+at|\s+for)?\s+([^.,!?]{2,40})/i);
  if (work) return `Works ${cleanFactTail(work[1])}`;
  return null;
}

export function durableFact(text: string): string | null {
  const identity = identityFact(text);
  if (identity) return identity;
  const remember = text.match(/\bremember(?:\s+that)?\s+(.+)/i);
  if (remember) return compactNote(remember[1]);
  if (/\bplease keep\b/i.test(text)) return compactNote(text);
  return null;
}

export function compactNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '').slice(0, 220);
}

function cleanFactTail(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
}

function splitNames(value: string): string[] {
  return value
    .replace(/\s+and\s+/gi, ',')
    .replace(/\s*&\s*/g, ',')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function titleCaseName(value: string): string {
  const parts = value
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .split(' ')
    .filter(part => part && !/^(and|or|our|my|the|&)$/i.test(part) && !NAME_STOP.test(part));
  const cleaned = parts[0] || '';
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, ch => ch.toUpperCase());
}
