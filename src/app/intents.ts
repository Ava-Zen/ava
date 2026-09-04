/** Lowercase, strip punctuation, and peel off greetings plus polite wrappers. */
function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /^(?:(?:hey|hi|hello|yo|ok|okay|so|well|um|uh)(?:\s+there)?(?:\s+ava)?|ava)(?:\s+please)?\s+/,
      '',
    )
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+)+/, '')
    .replace(/\s+(please|for me|right now|now)$/g, '')
    .trim();
}

/** True only when the user is asking for the current time, not merely mentioning time. */
export function isAskingForTime(text: string): boolean {
  const q = normalizeUtterance(text);
  if (!q) return false;
  if (/^(the )?time$/.test(q) || /^current time$/.test(q)) return true;
  return (
    /^what time is it(?:\s+in\s+\w[\w\s]*)?$/.test(q) ||
    /^what(?:'s|s| is) the(?: current)? time$/.test(q) ||
    /^tell me(?: the| what)?(?: current)? time$/.test(q) ||
    /^tell me what time it is(?:\s+in\s+\w[\w\s]*)?$/.test(q) ||
    /^do you know (?:the |what )?time(?: it is)?(?:\s+in\s+\w[\w\s]*)?$/.test(q) ||
    /^got the time$/.test(q)
  );
}

/** True when the user is asking what Ava can do. */
export function isAskingCapabilities(text: string): boolean {
  const q = normalizeUtterance(text);
  if (!q) return false;
  return (
    /^what can (?:you|ava) do$/.test(q) ||
    /^what do you do$/.test(q) ||
    /^what are you (?:capable of|able to do|good at)$/.test(q) ||
    /^what are your (?:capabilities|skills|features)$/.test(q) ||
    /^how can you help(?: me)?$/.test(q) ||
    /^what can you help(?: me)? with$/.test(q) ||
    /^(?:tell|show) me what you can do$/.test(q) ||
    /^what (?:should|can) i (?:ask|say)(?: you)?$/.test(q) ||
    /^help me get started$/.test(q)
  );
}

export const AVA_CAPABILITIES_REPLY =
  'I can talk with you by voice or text. I keep what we discuss as files, one subject at a time, so you stay in one conversation. Ask me the time or the weather, attach a file for me to summarize, or have me draft a reply. On the desktop app, click a field in another app, then say write about Vikings or generate a text, and I will put it there. I can also generate or edit images with Grok, work on a project with Grok in this window, and work on files or GitHub in the background. Ask me to research you or a topic and I will write a report you can open. You can schedule a task once or every morning, as long as I am still running. On the desktop app, say Ava, improve yourself, and I will change my own source, compile, and come back.';

const PROJECT_STOP =
  /^(this|that|it|them|myself|me|us|something|stuff|things|nothing|everything|grok|grok cli|a grok session|grok session|session)$/i;

function peelWant(text: string): string {
  return normalizeUtterance(text)
    .replace(
      /^(i want to |i would like to |i need to |i'?d like to |let'?s |let us |can we |could we )/,
      '',
    )
    .replace(/^(do some |do a bit of |get some )/, '')
    .trim();
}

/** Project name from “work on my Nostria project”, or null. */
export function extractProjectHint(text: string): string | null {
  const q = peelWant(text);
  const match =
    q.match(
      /^(?:work on|working on|open|start(?: working on)?)\s+(?:my |the |our )?(?:project |repo |repository )?(?<name>.+)$/i,
    ) || q.match(/\b(?:project|repo|repository)\s+(?:called |named )?(?<name>.+)$/i);
  const captured = match?.groups?.['name'];
  if (!captured) return null;
  const name = captured
    .replace(/\s+(project|repo|repository|codebase|folder|code)$/i, '')
    .trim();
  if (!name || PROJECT_STOP.test(name) || name.split(/\s+/).length > 6) return null;
  const original = text.replace(/[^\w\s']/g, ' ');
  const at = original.toLowerCase().lastIndexOf(name.toLowerCase());
  if (at >= 0) return original.slice(at, at + name.length).trim();
  return name;
}

/** True when the user wants Ava to open a Grok CLI coding session. */
export function isAskingForGrokWork(text: string): boolean {
  if (extractProjectHint(text)) return true;
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(?:open|start|use) (?:a |the )?grok(?: cli)?(?: session)?$/.test(q) ||
    /^(?:code|development work|coding|write some code)$/.test(q) ||
    /^help me (?:code|develop|program|with (?:this |my )?project)$/.test(q) ||
    /^(?:start|open) (?:a )?(?:coding|development) session$/.test(q)
  );
}

/** True when a memory note or topic is leftover Grok CLI work, not companion talk. */
export function isGrokSessionMemory(text: string): boolean {
  const hay = text.replace(/\s+/g, ' ').trim();
  if (!hay) return false;
  if (/\bgrok(?:\s+cli)?(?:\s+session)?\b/i.test(hay)) return true;
  if (isAskingForGrokWork(hay)) return true;
  return text.split(/[\n.;]+/).some(part => isAskingForGrokWork(part));
}

export type InsertRequest =
  | { kind: 'last' }
  | { kind: 'literal'; text: string }
  | { kind: 'generate'; prompt: string };

const INSERT_VERBS = 'type|insert|paste|dictate';
const WRITE_VERBS = 'generate|author|draft|compose|write|type|insert|paste|dictate|make|create|fill';
const TEXT_KINDS = 'text|paragraph|passage|blurb|note|message|email|reply|caption|sentence|poem|story|summary|bio';

export interface InsertParseOptions {
  /** Orb-only mode: treat write/generate asks as paste-into-field. */
  intoField?: boolean;
}

/** True when the user wants text placed in the focused field of another app. */
export function parseInsertRequest(text: string, options: InsertParseOptions = {}): InsertRequest | null {
  const q = peelWant(text);
  if (!q) return null;

  if (
    /^(?:type|insert|paste|put|write) (?:that|this|it)(?:\s+in(?:to)?(?:\s+(?:the\s+)?(?:field|box|app|window))?)?$/.test(q) ||
    /^(?:paste|insert|put) that(?:\s+in)?$/.test(q)
  ) {
    return { kind: 'last' };
  }

  if (/^(tell me|talk(?: to me)? about|what|who|when|where|why|how|do you|remember|research)\b/.test(q)) {
    return null;
  }

  const intoField =
    options.intoField === true ||
    /\b(?:in(?:to)? the (?:field|box|app|window)|type (?:it|that) in|fill (?:it|that|this) in)\b/.test(q);

  let match = q.match(
    new RegExp(`^(?:${WRITE_VERBS})\\b[\\s\\S]*\\b(?:about|regarding|on)\\s+(.+)$`),
  );
  if (match?.[1]) return { kind: 'generate', prompt: recoverPhrase(text, match[1]) };

  match = q.match(
    new RegExp(
      `^(?:${WRITE_VERBS})\\s+(?:me\\s+)?(?:(?:a|an|some|the)\\s+)?(?:short\\s+)?(?:${TEXT_KINDS}|something|anything)?\\s*(?:about|on|for|regarding)\\s+(.+)$`,
    ),
  );
  if (match?.[1]) return { kind: 'generate', prompt: recoverPhrase(text, match[1]) };

  match = q.match(
    new RegExp(
      `^(?:generate|author|draft|compose)\\s+(?:me\\s+)?(?:(?:a|an|some|the)\\s+)?(?:short\\s+)?(?:${TEXT_KINDS})\\s+(?:that\\s+|to\\s+)?(.+)$`,
    ),
  );
  if (match?.[1]) return { kind: 'generate', prompt: recoverPhrase(text, match[1]) };

  match = q.match(
    /^(?:type|insert|paste|dictate|put|write)\s+(?:this|the following)(?:\s+in(?:to)?(?:\s+the\s+(?:field|box))?)?\s+(.+)$/,
  );
  if (match?.[1]) return classifyInsertBody(text, match[1]);

  match = q.match(/^fill (?:this|it|the (?:field|box|input))(?: in)?(?: with)?\s+(.+)$/);
  if (match?.[1]) return classifyInsertBody(text, match[1]);

  match = q.match(new RegExp(`^(?:${INSERT_VERBS})\\s+(.+)$`));
  if (match?.[1]) return classifyInsertBody(text, match[1]);

  if (intoField) {
    match = q.match(new RegExp(`^(?:${WRITE_VERBS})\\s+(?:me\\s+)?(.+)$`));
    if (match?.[1]) return { kind: 'generate', prompt: recoverPhrase(text, match[1]) };
  }

  return null;
}

/** Prompt that asks the model for paste-ready copy only. */
export function buildInsertPrompt(topic: string): string {
  return `Write text to paste into another app. Output only that text, with no title, quotes, or preamble.\n\n${topic.trim()}`;
}

function classifyInsertBody(source: string, body: string): InsertRequest {
  const generateShape = new RegExp(
    `^(?:about\\b|(?:a|an|some)\\s+(?:short\\s+)?(?:${TEXT_KINDS})\\b)`,
  );
  if (generateShape.test(body) || body.split(/\s+/).length > 12) {
    return { kind: 'generate', prompt: recoverPhrase(source, body) };
  }
  return { kind: 'literal', text: recoverPhrase(source, body) };
}

function recoverPhrase(source: string, needle: string): string {
  const hay = source.replace(/\s+/g, ' ').trim();
  const at = hay.toLowerCase().lastIndexOf(needle.toLowerCase());
  if (at >= 0) return hay.slice(at, at + needle.length).trim();
  return needle.trim();
}

/** True when the user wants to leave the Grok session and return to Ava. */
export function isLeavingGrokWork(text: string): boolean {
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(?:close|leave|exit|hide) (?:the )?(?:grok|session|project)$/.test(q) ||
    /^(?:back to (?:chat|ava|the conversation|conversation)|go back)$/.test(q)
  );
}

/** True when the user wants the mic off, not the Grok session. */
export function isAskingToStopListening(text: string): boolean {
  const q = normalizeUtterance(text);
  if (!q) return false;
  return (
    /^(stop|end)(?:\s+(listening|recording))?$/.test(q) ||
    /^(that's enough|thats enough|enough|quiet)$/.test(q) ||
    /\b(stop|end|turn off|shut off|disable|mute)\b(?:\s+(the|my|your))?\s+(listening|mic|microphone|voice|recording|voice channel)\b/.test(q) ||
    /\b(mic|microphone)\s+(off|stop)\b/.test(q)
  );
}

/** True when the user wants to cancel the in-flight Grok turn, not close the panel. */
export function isAskingToStopGrokTurn(text: string): boolean {
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(stop|cancel)(?:\s+(the|this))?\s+(grok|agent|turn|run|session work)$/.test(q) ||
    /^(stop|cancel) (?:that|it)$/.test(q) ||
    /^stop working(?: on (?:this|the project|it))?$/.test(q)
  );
}

/** True when the user is asking to pick a working folder for Grok. */
export function isAskingToPickFolder(text: string): boolean {
  const q = peelWant(text);
  return /^(choose|pick|select|browse)(?: a| the)?(?: git| working)? folder$/.test(q);
}

/**
 * True when the utterance is addressed to Ava by name. Optional greetings
 * may precede it (“Hey Ava”), but a bare request without her name is not enough.
 */
export function isAddressedToAva(text: string): boolean {
  const t = text
    .trim()
    .replace(/^[^\w]+/, '')
    .replace(/\s+/g, ' ');
  return /^(?:(?:hey|hi|hello|yo|ok|okay|so|well|um|uh)(?:\s+there)?\s+)?ava\b/i.test(t);
}

/**
 * True only for an explicit self-improvement ask: addressed to Ava, and
 * using “improve yourself” or “self-improve”. A generic “improve the button”
 * in another Grok session must not match.
 */
export function isAskingToSelfImprove(text: string): boolean {
  if (!isAddressedToAva(text)) return false;
  const q = normalizeUtterance(text);
  if (!q) return false;
  return (
    /\bimprove yourself\b/.test(q) ||
    /\bself[- ]improve(?:ments?)?\b/.test(q)
  );
}

/** The change the user wants, with the self-improve trigger stripped. */
export function extractSelfImproveTask(text: string): string {
  const q = normalizeUtterance(text);
  const match = q.match(
    /^(?:please\s+)?(?:improve yourself|self[- ]improve(?:ments?)?)\s*(?:by|and|to|with|:)?\s*(.*)$/i,
  );
  const stripped = (match?.[1] || '').trim();
  if (!stripped) return q;
  const original = text.replace(/\s+/g, ' ').trim();
  const at = original.toLowerCase().lastIndexOf(stripped);
  if (at >= 0) return original.slice(at, at + stripped.length).trim();
  return stripped;
}

/** True when the user wants Ava restored to the original shipped build. */
export function isAskingToResetSelfImprovements(text: string): boolean {
  if (!isAddressedToAva(text)) return false;
  const q = normalizeUtterance(text);
  if (!q) return false;
  return (
    /^(?:reset|revert|undo)\s+yourself$/.test(q) ||
    /^(?:reset|revert|undo|restore)\s+(?:your\s+)?self[- ]improvements?\b/.test(q) ||
    /^(?:reset|revert|undo|restore)\s+(?:yourself|ava)\s+to\s+(?:the\s+)?original\b/.test(q) ||
    /^(?:go back to|restore)\s+(?:the\s+)?(?:original|factory)\s+(?:ava|version|yourself|build)\b/.test(q)
  );
}

const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const PERIOD_HOUR: Record<string, number> = {
  morning: 8,
  noon: 12,
  afternoon: 15,
  evening: 19,
  night: 21,
};

export interface ParsedSchedule {
  kind: 'once' | 'interval';
  hour: number;
  minute: number;
  intervalDays: number;
  delayMs?: number;
  task: string;
  researchMe: boolean;
  title: string;
}

/** True when the user wants a public-web research pass about themselves. */
export function isAskingToResearchSelf(text: string): boolean {
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(?:do\s+)?(?:some\s+|a\s+bit\s+of\s+)?research\s+(?:on\s+|about\s+)?(?:me|myself)$/.test(q) ||
    /^(?:look|search)\s+me\s+up$/.test(q) ||
    /^(?:look|search)\s+(?:up|into|on)\s+(?:me|myself)$/.test(q) ||
    /^who\s+am\s+i\s+online$/.test(q) ||
    /^search\s+(?:the\s+(?:web|internet)\s+for\s+)?(?:me|myself)$/.test(q)
  );
}

/** Topic for “research X”, or null when it is about the user or not research. */
export function extractResearchTopic(text: string): string | null {
  const q = peelWant(text);
  if (!q) return null;
  const match = q.match(
    /^(?:do\s+)?(?:some\s+|a\s+bit\s+of\s+)?(?:research|look\s+into|look\s+up|search(?:\s+the\s+(?:web|internet))?(?:\s+for)?)\s+(?:on\s+|about\s+)?(.+)$/i,
  );
  const topic = match?.[1]?.replace(/\s+(for me|please)$/i, '').trim();
  if (!topic) return null;
  if (/^(me|myself)$/i.test(topic)) return null;
  if (/\b(in the background|background task|while i)\b/i.test(topic)) return null;
  if (topic.split(/\s+/).length > 12) return null;
  return topic;
}

export function isAskingAboutSchedules(text: string): boolean {
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(?:what|which|show|list|tell me(?: about)?)\s+(?:are\s+)?(?:my\s+)?schedules?\b/.test(q) ||
    /^(?:what did you schedule|what is scheduled|what'?s scheduled)\b/.test(q)
  );
}

export function isAskingToCancelSchedule(text: string): boolean {
  const q = peelWant(text);
  if (!q) return false;
  return (
    /^(?:cancel|stop|remove|delete|clear)\s+(?:all\s+)?(?:my\s+)?(?:the\s+)?schedules?\b/.test(q) ||
    /^(?:don'?t|do not)\s+(?:run|do)\s+that(?:\s+anymore)?$/.test(q)
  );
}

/** Single or repeating task from speech, or null when this is not a schedule ask. */
export function parseScheduleRequest(text: string): ParsedSchedule | null {
  const q = peelWant(text);
  if (!q) return null;

  const relative = q.match(/\bin\s+(\d+)\s+(minutes?|mins?|hours?|hrs?)\b/i);
  const every = q.match(
    new RegExp(`\\b(?:every|each)\\s+(morning|afternoon|evening|night|day|week|${WEEKDAYS})\\b`, 'i'),
  );
  const onceWord = /\b(once|today)\b/i.test(q);
  const tomorrow = /\btomorrow\b/i.test(q);
  const scheduleWord = /\bschedule\b/i.test(q);
  if (!relative && !every && !onceWord && !tomorrow && !scheduleWord) return null;

  let hour = 8;
  let minute = 0;
  const clock =
    q.match(/\b(?:at|@)\s*(\d{1,2})(?:[:\s.](\d{2}))?\s*(am|pm)?\b/i)
    || q.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i);
  if (clock) {
    hour = Number(clock[1]);
    minute = Number(clock[2] || '0');
    const ap = (clock[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
  } else if (every) {
    const period = PERIOD_HOUR[every[1].toLowerCase()];
    if (period !== undefined) hour = period;
  }
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;

  let kind: ParsedSchedule['kind'] = 'once';
  let intervalDays = 1;
  let delayMs: number | undefined;
  if (relative) {
    const n = Number(relative[1]);
    delayMs = /hour|hr/i.test(relative[2]) ? n * 3_600_000 : n * 60_000;
  } else if (every) {
    kind = 'interval';
    const word = every[1].toLowerCase();
    intervalDays = word === 'week' || new RegExp(`^(?:${WEEKDAYS})$`).test(word) ? 7 : 1;
  } else if (scheduleWord && !tomorrow && !onceWord) {
    kind = 'interval';
  }

  let task = q
    .replace(/\b(?:please\s+)?(?:schedule|remind me to|set up)\b/gi, ' ')
    .replace(new RegExp(`\\b(?:every|each)\\s+(?:morning|afternoon|evening|night|day|week|${WEEKDAYS})\\b`, 'gi'), ' ')
    .replace(/\b(?:once|tomorrow|today)\b/gi, ' ')
    .replace(/\bin\s+\d+\s+(?:minutes?|mins?|hours?|hrs?)\b/gi, ' ')
    .replace(/\b(?:at|@)\s*\d{1,2}(?:[:\s.]\d{2})?\s*(?:am|pm)?\b/gi, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:i want you to |i want to |please |do |to |and |then )+/i, '')
    .replace(/\s+(please)$/i, '')
    .trim();
  if (!task || task.length < 3) return null;

  const researchMe = isAskingToResearchSelf(task);
  const title = researchMe ? 'Research on you' : clipScheduleTitle(task);
  return { kind, hour, minute, intervalDays, delayMs, task, researchMe, title };
}

function clipScheduleTitle(task: string): string {
  const cleaned = task.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 42) return cleaned.replace(/^\w/, ch => ch.toUpperCase());
  return `${cleaned.slice(0, 40).trim()}…`;
}
