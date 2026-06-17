/**
 * Small, dependency-free helpers for turning the language model's markdown
 * output into:
 *   - safe HTML for display (`markdownToHtml`)
 *   - clean spoken text for TTS, with no stray markup (`markdownToPlainText`)
 *   - bite-sized chunks the TTS model can synthesise without choking
 *     (`splitIntoSpeechChunks`).
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Applies inline markdown (code, bold, italic) to an already line-split segment. */
function inlineMarkdown(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
  return t;
}

/**
 * Converts a subset of markdown (headings, bold/italic, inline code, ordered
 * and unordered lists, paragraphs) into safe HTML. All raw HTML in the input is
 * escaped first, so the result is safe to bind via [innerHTML].
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // '#' -> <h3>
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(line);
    if (unordered) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  return out.join('');
}

/**
 * Strips markdown markup so the text can be spoken naturally — the TTS engine
 * never reads "asterisk", "hash" or "underscore" aloud.
 */
export function markdownToPlainText(md: string): string {
  let t = md.replace(/\r\n/g, '\n');
  t = t.replace(/```[\s\S]*?```/g, ' ');         // fenced code blocks
  t = t.replace(/`([^`]+)`/g, '$1');             // inline code
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links / images -> label
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');      // heading markers
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');       // bold **
  t = t.replace(/__([^_]+)__/g, '$1');           // bold __
  t = t.replace(/\*([^*]+)\*/g, '$1');           // italic *
  t = t.replace(/_([^_]+)_/g, '$1');             // italic _
  t = t.replace(/^\s*[-*+]\s+/gm, '');           // bullet markers
  t = t.replace(/^\s*\d+\.\s+/gm, '');           // numbered markers
  t = t.replace(/^\s*>\s?/gm, '');               // blockquotes
  t = t.replace(/[*_#`>]/g, ' ');                // any stray markup chars
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/ *\n */g, '\n');
  t = t.replace(/\n{2,}/g, '\n');
  return t.trim();
}

/**
 * Splits text into sentence-aware chunks small enough for the TTS model to
 * synthesise smoothly. Chunks are generated ahead of playback so there is no
 * audible gap between them.
 */
export function splitIntoSpeechChunks(text: string, maxLen = 260): string[] {
  const clean = text.trim();
  if (!clean) return [];

  const segments = clean.match(/[^.!?\n]+[.!?]*|\n+/g) ?? [clean];
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = '';
  };

  for (const seg of segments) {
    const piece = seg.replace(/\s+/g, ' ').trim();
    if (!piece) continue;

    if (current && (current.length + 1 + piece.length) > maxLen) {
      flush();
    }
    current = current ? `${current} ${piece}` : piece;

    // Hard-split any single sentence that is longer than the limit.
    while (current.length > maxLen) {
      const cut = current.lastIndexOf(' ', maxLen);
      const at = cut > maxLen * 0.6 ? cut : maxLen;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  flush();

  return chunks;
}
