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
  const t = text.trim();
  if (/^(?:(?:hey|hi|hello)\s+)?(?:ava[, ]+)?(?:please\s+)?remember(?:\s+(?:that|this|it))?[,:]?\s+\S/i.test(t)) {
    return true;
  }
  if (/\b(?:please\s+)?remember(?:\s+(?:that|this))\s+\S/i.test(t)) return true;
  if (/\b(?:please\s+)?(?:keep|store|save|note)\s+(?:that|this)\b/i.test(t)) return true;
  if (/\bdon'?t forget\b/i.test(t)) return true;
  if (/\bplease keep\b/i.test(t)) return true;
  return false;
}

export function stripRememberPrefix(text: string): string {
  return text
    .replace(
      /^(?:(?:hey|hi|hello)\s+)?(?:ava[, ]+)?(?:please\s+)?(?:remember(?:\s+(?:that|this|it))?|keep this|store this|save this|note this|don't forget|do not forget)[.,:]?\s*/i,
      '',
    )
    .trim();
}

export function looksLikeSelfFact(text: string): boolean {
  const t = text.trim();
  if (/^my\s+(partner|wife|husband|spouse|girlfriend|boyfriend|son|daughter|kid|child|kids|children)\b/i.test(t)) {
    return false;
  }
  if (/^i have (?:a |an )?(son|daughter|kid|child|partner|wife|husband|girlfriend|boyfriend)\b/i.test(t)) {
    return false;
  }
  return /^(?:i(?:'m| am| have|'ve)|my |i live|i work)\b/i.test(t);
}

export function selfFactLine(text: string): string | null {
  const cleaned = compactNote(text);
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : null;
}

export function isAskingWhatSheRemembers(text: string): boolean {
  const q = text.toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(what do you remember|what do you know about me|show me (your |the )?memory|what are you holding)\b/.test(q);
}

export interface PersonMention {
  name: string;
  relation: 'partner' | 'child' | 'person';
  role: string;
  notes?: string;
  livesIn?: string;
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
    const notes = ageNote(raw);
    found.push({ name, relation, role, notes: notes || undefined });
  };

  const partner = text.match(
    /\b(?:my|our)\s+(partner|wife|husband|spouse|girlfriend|boyfriend)(?:'s\s+name\s+is|\s+is\s+called|\s+is\s+named|\s+named|\s+is)\s+([A-Za-z][A-Za-z'-]{1,30}(?:\s+[A-Za-z][A-Za-z'-]{1,30})?)/i,
  );
  if (partner) add(partner[2], 'partner', titleCaseName(partner[1]) || 'Partner');

  const havePartner = text.match(
    /\bi(?:'ve| have)\s+a\s+(girlfriend|boyfriend|partner|wife|husband)(?:[,.]?\s+(?:and\s+)?(?:her|his|their)\s+name\s+is|\s+(?:named|called))\s+([A-Za-z][A-Za-z'-]{1,30})/i,
  );
  if (havePartner) add(havePartner[2], 'partner', titleCaseName(havePartner[1]) || 'Partner');

  const namedPartner = text.match(
    /\b(girlfriend|boyfriend|partner|wife|husband)[,.]?\s+(?:her|his|their)\s+name\s+is\s+([A-Za-z][A-Za-z'-]{1,30})/i,
  );
  if (namedPartner) add(namedPartner[2], 'partner', titleCaseName(namedPartner[1]) || 'Partner');

  const kids = text.match(
    /\b(?:my|our)\s+(?:kids?|children)(?:'s\s+names?\s+are|'s\s+name\s+is|\s+are\s+called|\s+are\s+named|\s+named|\s+are)\s+([^.?!]+)/i,
  );
  if (kids) {
    for (const part of splitNames(kids[1])) add(part, 'child', 'Child');
  }

  const haveKids = text.match(
    /\b(?:we|i)\s+have\s+(?:(?:a|two|three|four|\d+)\s+)?(?:kids?|children)(?:\s+(?:named|called)|\s*[:\-–])\s+([^.?!]+)/i,
  );
  if (haveKids) {
    for (const part of splitNames(haveKids[1])) add(part, 'child', 'Child');
  }

  for (const match of text.matchAll(
    /\b(?:my|our)\s+(son|daughter|kid|child)\s+(?:is\s+(?:called|named)\s+|named\s+|is\s+)([A-Za-z][A-Za-z'-]{1,30})/gi,
  )) {
    add(match[2], 'child', titleCaseName(match[1]) || 'Child');
  }

  for (const match of text.matchAll(
    /\b(?:my|our)\s+(son|daughter|kid|child)'s name is\s+([A-Za-z][A-Za-z'-]{1,30})/gi,
  )) {
    add(match[2], 'child', titleCaseName(match[1]) || 'Child');
  }

  const haveSon = text.match(
    /\bi have (?:a |an )?(son|daughter|kid|child)(?:[,.]?\s+(?:and\s+)?(?:his|her|their)\s+name\s+is|\s+(?:named|called))\s+([A-Za-z][A-Za-z'-]{1,30})/i,
  );
  if (haveSon) add(haveSon[2], 'child', titleCaseName(haveSon[1]) || 'Child');

  const partnerLives = text.match(
    /\b(?:my|our)\s+(partner|wife|husband|spouse|girlfriend|boyfriend)\s+lives in\s+([^.,!?]+)/i,
  );
  if (partnerLives) {
    const role = titleCaseName(partnerLives[1]) || 'Partner';
    const livesIn = cleanFactTail(partnerLives[2]);
    const named = found.find(person => person.relation === 'partner');
    if (named) {
      named.livesIn = named.livesIn || livesIn;
      named.notes = [named.notes, livesIn ? `Lives in ${livesIn}` : ''].filter(Boolean).join('. ');
    } else {
      found.push({
        name: '',
        relation: 'partner',
        role,
        livesIn,
        notes: livesIn ? `Lives in ${livesIn}` : undefined,
      });
    }
  }

  return found;
}

export function peopleAck(count: number): string {
  return count > 1 ? 'I will keep them.' : 'I will keep that.';
}

export function identityFact(text: string): string | null {
  const full = text.match(/\bmy full name is\s+([^.,!?]{3,80})/i);
  if (full) return `Full name is ${cleanFactTail(full[1])}`;
  const name = text.match(/\bmy name is\s+([^.,!?]{2,40})/i);
  if (name) {
    const cleaned = cleanFactTail(name[1]);
    return looksLikeFullName(cleaned) ? `Full name is ${cleaned}` : `Name is ${cleaned}`;
  }
  const twitter = text.match(/\bmy (?:x|twitter)(?: handle)? is\s+(@?[\w./-]+)/i);
  if (twitter) return `X is ${twitter[1]}`;
  const youtube = text.match(/\bmy youtube(?: channel)? is\s+(\S+)/i);
  if (youtube) return `YouTube is ${youtube[1]}`;
  const github = text.match(/\bmy github is\s+(\S+)/i);
  if (github) return `GitHub is ${github[1]}`;
  const live = text.match(/\bi live in\s+([^.,!?]{2,40})/i);
  if (live) return `Lives in ${cleanFactTail(live[1])}`;
  const work = text.match(/\bi work(?:\s+as|\s+at|\s+for)?\s+([^.,!?]{2,40})/i);
  if (work) return `Works ${cleanFactTail(work[1])}`;
  const age = parseSpokenAge(text);
  if (age != null) return `Age is ${age}`;
  return null;
}

const AGE_ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const AGE_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const AGE_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function parseSpokenAge(text: string): number | null {
  const hay = text.replace(/-/g, ' ');
  const labeled = hay.match(/\bmy age is\s+(\d{1,2}|[a-z]+(?:\s+[a-z]+)?)\b/i);
  if (labeled) return parseAgeToken(labeled[1]);
  const years = hay.match(/\b(?:i(?:'m| am)\s+)?(\d{1,2}|[a-z]+(?:\s+[a-z]+)?)\s+years old\b/i);
  if (years) return parseAgeToken(years[1]);
  const whole = hay.replace(/[.,!?]/g, '').trim();
  const bare = whole.match(/^(?:i(?:'m| am)\s+)?(\d{1,2}|[a-z]+(?:\s+[a-z]+)?)$/i);
  if (bare) return parseAgeToken(bare[1]);
  return null;
}

function parseAgeToken(raw: string): number | null {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 99) return n;
  return ageFromWords(raw);
}

function ageFromWords(raw: string): number | null {
  const n = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (AGE_TEENS[n] != null) return AGE_TEENS[n];
  if (AGE_ONES[n] != null) return AGE_ONES[n];
  if (AGE_TENS[n] != null) return AGE_TENS[n];
  const parts = n.split(' ');
  if (parts.length === 2 && AGE_TENS[parts[0]] != null && AGE_ONES[parts[1]] != null) {
    return AGE_TENS[parts[0]] + AGE_ONES[parts[1]];
  }
  return null;
}

export function looksLikeFullName(value: string): boolean {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.length <= 4 && parts.every(part => /^[A-Za-z][A-Za-z'.-]{0,30}$/.test(part));
}

export function titleCaseFullName(value: string): string {
  return value
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .split(' ')
    .filter(part => part && !/^(and|or|the)$/i.test(part))
    .slice(0, 4)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function fullNameFromPersona(name?: string, identity?: string): string {
  const hay = identity ?? '';
  const labeled = hay.match(/\bfull name is\s+([^.\n]{3,80})/i)?.[1]
    || hay.match(/\bname is\s+([A-Za-z][A-Za-z'.-]+(?:\s+[A-Za-z][A-Za-z'.-]+){1,3})\b/i)?.[1];
  const candidate = (labeled || name || '').replace(/\s+/g, ' ').trim();
  return looksLikeFullName(candidate) ? titleCaseFullName(candidate) : '';
}

export function extractGivenFullName(text: string): string | null {
  const labeled = text.match(/\b(?:my )?(?:full )?name is\s+([^.,!?\n]{3,80})/i);
  const raw = (labeled?.[1] || text).replace(/\s+/g, ' ').trim();
  return looksLikeFullName(raw) ? titleCaseFullName(raw) : null;
}

export function identitySocials(identity?: string): string[] {
  if (!identity) return [];
  const found: string[] = [];
  const add = (line: string) => {
    const key = line.toLowerCase();
    if (found.some(item => item.toLowerCase() === key)) return;
    found.push(line);
  };
  for (const match of identity.matchAll(/\bX is\s+(\S+)/gi)) add(`X: ${match[1]}`);
  for (const match of identity.matchAll(/\bYouTube is\s+(\S+)/gi)) add(`YouTube: ${match[1]}`);
  for (const match of identity.matchAll(/\bGitHub is\s+(\S+)/gi)) add(`GitHub: ${match[1]}`);
  for (const match of identity.matchAll(/https?:\/\/(?:www\.)?(?:x|twitter|youtube|github)\.com\/[^\s)]+/gi)) {
    add(match[0]);
  }
  return found;
}

export type PersonaGap = 'name' | 'age' | 'work' | 'family' | 'home';

export interface IdleNudge {
  key: string;
  line: string;
}

export interface IdleNudgeInput {
  identity?: string;
  name?: string;
  peopleCount?: number;
  topics?: Array<{ id: string; title: string; notes: string; updatedAt: string }>;
  unfinishedPrompt?: string | null;
  usedKeys?: string[];
}

const PERSONA_LINES: Record<PersonaGap, string> = {
  name: 'I realized I never asked your name. What should I call you?',
  age: 'How old are you? I would like to know you a little better.',
  work: 'What do you do for work, if you want to tell me?',
  family: 'Do you have family around you that I should know?',
  home: 'Where do you live these days?',
};

export function missingPersona(input: {
  identity?: string;
  name?: string;
  peopleCount?: number;
}): PersonaGap[] {
  const hay = (input.identity ?? '').toLowerCase();
  const missing: PersonaGap[] = [];
  if (!input.name?.trim()) missing.push('name');
  if (!/\b(age is|years old|yrs old)\b/.test(hay)) missing.push('age');
  if (!/\b(works?\b|job\b|career\b)/.test(hay)) missing.push('work');
  const familyKnown = (input.peopleCount ?? 0) > 0
    || /\b(family|partner|wife|husband|kids?|children|son|daughter)\b/.test(hay);
  if (!familyKnown) missing.push('family');
  if (!/\blives in\b/.test(hay) && !/\blive in\b/.test(hay)) missing.push('home');
  return missing;
}

/** One quiet spoken line for when nothing has happened for a while. */
export function pickIdleNudge(
  input: IdleNudgeInput,
  random: () => number = Math.random,
): IdleNudge | null {
  const used = new Set(input.usedKeys ?? []);
  const candidates: IdleNudge[] = [];

  const unfinished = input.unfinishedPrompt?.replace(/\s+/g, ' ').trim();
  if (unfinished) {
    candidates.push({
      key: `task:${unfinished.slice(0, 48).toLowerCase()}`,
      line: `I still have that unfinished work: ${clipSpoken(unfinished)}. Want me to pick it up?`,
    });
  }

  const topics = input.topics ?? [];
  for (const topic of topics) {
    const hay = `${topic.title} ${topic.notes}`;
    if (/\b(research|look into|investigat|find out)\b/i.test(hay)) {
      candidates.push({
        key: `research:${topic.id}`,
        line: `I could go back to ${topic.title} if you want to keep looking into it.`,
      });
    } else if (topic.notes.trim()) {
      candidates.push({
        key: `topic:${topic.id}`,
        line: `We never finished ${topic.title}. Want to pick that up?`,
      });
    }
  }

  for (const gap of missingPersona(input)) {
    candidates.push({ key: `persona:${gap}`, line: PERSONA_LINES[gap] });
  }

  candidates.push({
    key: 'next',
    line: 'I am here. What would you like to do next?',
  });

  const unused = candidates.filter(item => !used.has(item.key));
  if (!unused.length) return null;
  const roll = random();
  const index = Math.min(unused.length - 1, Math.max(0, Math.floor(roll * unused.length)));
  return unused[index] ?? null;
}

export function personaGapFromLine(text: string): PersonaGap | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  for (const gap of Object.keys(PERSONA_LINES) as PersonaGap[]) {
    const line = PERSONA_LINES[gap];
    if (trimmed === line || trimmed.startsWith(line)) return gap;
  }
  return null;
}

const THROWAWAY_REPLY = /^(yes|no|yeah|yep|yup|nope|ok|okay|sure|nah|thanks|thank you)[.!?]*$/i;

export function personaReplyFact(gap: PersonaGap, text: string): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed || THROWAWAY_REPLY.test(trimmed)) return null;
  if (gap === 'family' || gap === 'name') return null;
  if (gap === 'age') {
    const n = parseSpokenAge(trimmed);
    return n != null ? `Age is ${n}` : null;
  }
  if (gap === 'work') {
    const known = identityFact(trimmed);
    if (known?.startsWith('Works')) return known;
    const cleaned = compactNote(trimmed.replace(/^(i(?:'m| am)?(?:\s+a(?:n)?)?|i work(?:\s+as|\s+at|\s+for)?)\s+/i, ''));
    return cleaned ? `Works ${cleaned}` : null;
  }
  if (gap === 'home') {
    const known = identityFact(trimmed);
    if (known?.startsWith('Lives')) return known;
    const cleaned = compactNote(trimmed.replace(/^(i live in|we live in|in|from)\s+/i, ''));
    return cleaned ? `Lives in ${cleaned}` : null;
  }
  return null;
}

function clipSpoken(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  if (cleaned.length <= 42) return cleaned;
  return `${cleaned.slice(0, 40).trim()}…`;
}

export function durableFact(text: string): string | null {
  const stripped = stripRememberPrefix(text);
  const identity = identityFact(text) || identityFact(stripped);
  if (identity) return identity;
  const remember = text.match(/\bremember(?:\s+(?:that|this|it))?[,:]?\s+(.+)/i);
  if (remember) {
    const rest = compactNote(remember[1].replace(/^(?:this|that|it)[,:]?\s+/i, ''));
    return identityFact(rest) || rest || null;
  }
  if (/\bplease keep\b/i.test(text)) return compactNote(stripped || text);
  if (isExplicitRemember(text) && stripped) return compactNote(stripped);
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
    .filter(part => part && !/^\d+(\s+years?)?$/i.test(part.replace(/[()]/g, '').trim()));
}

function ageNote(value: string): string {
  const match = value.match(/\((\d{1,2})\s*(?:years?|yrs?|yo)?\)/i)
    || value.match(/\b(\d{1,2})\s*(?:years?|yrs?|yo)\s*old\b/i);
  if (!match) return '';
  return match[1] === '1' ? '1 year old' : `${match[1]} years old`;
}

function titleCaseName(value: string): string {
  const parts = value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '')
    .split(' ')
    .filter(part => part && !/^(and|or|our|my|the|&)$/i.test(part) && !NAME_STOP.test(part) && !/^\d+$/.test(part));
  const cleaned = parts[0] || '';
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, ch => ch.toUpperCase());
}
