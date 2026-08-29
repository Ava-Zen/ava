/** Open Knowledge Format (OKF) v0.2 — markdown + YAML frontmatter. */

export const OKF_VERSION = '0.2';
export const OKF_ACTOR = 'ava/0.1';

export interface OkfGenerated {
  by: string;
  at: string;
}

export interface OkfDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIsoDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function parseOkf(text: string): OkfDoc {
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!raw.startsWith('---')) {
    return { frontmatter: {}, body: raw.replace(/^\n+/, '') };
  }
  const rest = raw.slice(3).replace(/^\n/, '');
  const close = rest.indexOf('\n---');
  if (close < 0) {
    return { frontmatter: {}, body: raw };
  }
  const yaml = rest.slice(0, close);
  const body = rest.slice(close + 4).replace(/^\n/, '');
  return { frontmatter: parseSimpleYaml(yaml), body };
}

export function stringifyOkf(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  const lines = ['---', ...keys.map(key => formatYamlLine(key, frontmatter[key])), '---', ''];
  const cleaned = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `${lines.join('\n')}${cleaned ? `${cleaned}\n` : ''}`;
}

export function okfType(doc: OkfDoc): string {
  return stringField(doc.frontmatter, 'type') || 'Concept';
}

export function okfTitle(doc: OkfDoc, fallback = ''): string {
  return stringField(doc.frontmatter, 'title') || fallback;
}

export function okfDescription(doc: OkfDoc): string {
  return stringField(doc.frontmatter, 'description');
}

export function okfTags(doc: OkfDoc): string[] {
  return stringList(doc.frontmatter['tags']);
}

export function okfStringList(value: unknown): string[] {
  return stringList(value);
}

export function generatedNow(by = OKF_ACTOR): OkfGenerated {
  return { by, at: nowIso() };
}

/** Last content change: `generated.at`, with v0.1 `timestamp` as fallback. */
export function okfGeneratedAt(doc: OkfDoc): string {
  const generated = doc.frontmatter['generated'];
  if (generated && typeof generated === 'object') {
    const at = (generated as { at?: unknown }).at;
    if (typeof at === 'string' && at.trim()) return at.trim();
  }
  const timestamp = doc.frontmatter['timestamp'];
  return typeof timestamp === 'string' ? timestamp.trim() : '';
}

export function okfHasType(doc: OkfDoc | null | undefined): doc is OkfDoc {
  return !!doc && typeof doc.frontmatter['type'] === 'string' && !!String(doc.frontmatter['type']).trim();
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'topic';
}

export function joinRel(...parts: string[]): string {
  return parts
    .flatMap(part => part.replace(/\\/g, '/').split('/'))
    .filter(part => part && part !== '.')
    .join('/');
}

function stringField(map: Record<string, unknown>, key: string): string {
  const value = map[key];
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function parseSimpleYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('-')) continue;
    const split = line.indexOf(':');
    if (split <= 0) continue;
    const key = line.slice(0, split).trim();
    const raw = line.slice(split + 1).trim();
    if (!key) continue;
    result[key] = parseYamlScalar(raw);
  }
  return result;
}

function parseYamlScalar(raw: string): unknown {
  if (!raw || raw === 'null' || raw === '~') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map(part => unquote(part.trim()))
      .filter(Boolean);
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const obj: Record<string, string> = {};
    for (const part of raw.slice(1, -1).split(',')) {
      const inner = part.indexOf(':');
      if (inner <= 0) continue;
      obj[part.slice(0, inner).trim()] = unquote(part.slice(inner + 1).trim());
    }
    return obj;
  }
  return unquote(raw);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function formatYamlLine(key: string, value: unknown): string {
  return `${key}: ${formatYamlValue(value)}`;
}

function formatYamlValue(value: unknown): string {
  if (value == null) return '""';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map(item => (typeof item === 'string' ? quoteIfNeeded(item) : formatYamlValue(item)))
      .join(', ');
    return `[${items}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? quoteIfNeeded(v) : formatYamlValue(v)}`)
      .join(', ');
    return `{ ${entries} }`;
  }
  return quoteIfNeeded(String(value));
}

function quoteIfNeeded(value: string): string {
  if (!value) return '""';
  if (/[:#\[\]{},]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}
