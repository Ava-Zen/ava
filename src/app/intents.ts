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
  'I can talk with you by voice or text. I keep what we discuss as files, one subject at a time, so you stay in one conversation. Ask me the time or the weather, attach a file for me to summarize, or have me draft a reply. I can also generate or edit images with Grok, work on a project with Grok in this window, and work on files or GitHub in the background.';

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
