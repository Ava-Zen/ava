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
  'I can talk with you by voice or text. I keep what we discuss as files, one subject at a time, so you stay in one conversation. Ask me the time or the weather, attach a file for me to summarize, or have me draft a reply. I can also generate or edit images with Grok, and work on files or GitHub in the background.';
