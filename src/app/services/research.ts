import { Injectable, inject } from '@angular/core';
import { LlmService } from './llm';
import { MemoryService } from './memory';
import { OnboardingService } from './onboarding';
import { fullNameFromPersona, identitySocials } from './presence';

export interface ResearchResult {
  spoken: string;
  reportRel: string;
  title: string;
}

const RESEARCH_SYSTEM =
  'You are Ava writing a private research report for the person you companion. ' +
  'Search the public internet, X (Twitter), and YouTube. Prefer the last seven days, then a short background. ' +
  'Do not invent biographies, quotes, or links. If you cannot find them, say so. ' +
  'Write markdown in the report. Keep the spoken summary to two or three short sentences. ' +
  'Format exactly as:\nSPEAK: <spoken summary>\nREPORT:\n<markdown report with Highlights this week, Public mentions, X and YouTube, and Sources>';

@Injectable({ providedIn: 'root' })
export class ResearchService {
  private readonly llm = inject(LlmService);
  private readonly memory = inject(MemoryService);
  private readonly onboarding = inject(OnboardingService);

  fullName(): string {
    return fullNameFromPersona(this.onboarding.userName(), this.memory.identityNotes());
  }

  async run(input: { aboutUser?: boolean; topic?: string }): Promise<ResearchResult> {
    const aboutUser = !!input.aboutUser;
    const fullName = this.fullName();
    const topic = aboutUser
      ? (fullName || this.onboarding.userName() || 'this person')
      : (input.topic || '').trim();
    if (!topic) throw new Error('Nothing to research.');

    const title = aboutUser ? `Highlights for ${fullName || topic}` : topic;
    const clues = await gatherPublicClues(topic, aboutUser ? identitySocials(this.memory.identityNotes()) : []);
    const prompt = researchPrompt({
      aboutUser,
      topic,
      fullName,
      identity: this.memory.identityNotes(),
      socials: identitySocials(this.memory.identityNotes()),
      clues,
    });

    const raw = await this.llm.generateMessages(
      [
        { role: 'system', content: RESEARCH_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxNewTokens: 2200, temperature: 0.4, topP: 0.9, research: true },
    );
    const parsed = parseResearchOutput(this.llm.sanitizeModelOutput(raw.text));
    const report = parsed.report.trim() || parsed.spoken;
    const rel = await this.memory.writeReport(title, report, aboutUser
      ? 'Public highlights from the last week.'
      : `Research on ${topic}.`);
    return {
      spoken: parsed.spoken || 'I wrote that up for you.',
      reportRel: rel,
      title,
    };
  }
}

export function parseResearchOutput(text: string): { spoken: string; report: string } {
  const cleaned = text.replace(/\s+$/, '').trim();
  const speakMatch = cleaned.match(/SPEAK:\s*([\s\S]*?)(?:\n\s*REPORT:|$)/i);
  const reportMatch = cleaned.match(/REPORT:\s*([\s\S]*)$/i);
  if (speakMatch) {
    const spoken = clipSpokenSummary(speakMatch[1]);
    const report = (reportMatch?.[1] || '').trim();
    return { spoken, report: report || cleaned };
  }
  const first = cleaned.split(/\n{2,}/)[0] || cleaned;
  return { spoken: clipSpokenSummary(first), report: cleaned };
}

export function clipSpokenSummary(text: string): string {
  const plain = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length) {
    const few = sentences.slice(0, 3).join(' ').trim();
    if (few.length <= 420) return few;
  }
  if (plain.length <= 420) return plain;
  return `${plain.slice(0, 400).trim()}…`;
}

function researchPrompt(input: {
  aboutUser: boolean;
  topic: string;
  fullName: string;
  identity: string;
  socials: string[];
  clues: string;
}): string {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const lines = [
    `Today is ${today}. Look at the last seven days first.`,
    input.aboutUser
      ? `Research the person named ${input.fullName || input.topic}.`
      : `Research this topic: ${input.topic}.`,
  ];
  if (input.fullName) lines.push(`Full name: ${input.fullName}.`);
  if (input.identity.trim()) {
    lines.push('What Ava already knows:');
    lines.push(input.identity.trim().slice(0, 800));
  }
  if (input.socials.length) {
    lines.push(`Known accounts: ${input.socials.join(', ')}.`);
    lines.push('Search those X, YouTube, and GitHub accounts as well as the open web.');
  } else if (input.aboutUser) {
    lines.push('Search X, YouTube, news, and the open web by their full name.');
  }
  if (input.clues.trim()) {
    lines.push('Public pages already found:');
    lines.push(input.clues.trim().slice(0, 2400));
  }
  return lines.join('\n');
}

export async function gatherPublicClues(query: string, socials: string[] = []): Promise<string> {
  const searches = [query, `${query} site:x.com`, `${query} site:youtube.com`, ...socials];
  const chunks = await Promise.all(searches.slice(0, 4).map(term => wikiSearch(term)));
  return chunks.filter(Boolean).join('\n\n');
}

async function wikiSearch(query: string): Promise<string> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    '&utf8=&format=json&origin=*&srlimit=3';
  const data = await fetchJson(url);
  const hits = (data as { query?: { search?: Array<{ title?: string; snippet?: string }> } })
    ?.query?.search ?? [];
  if (!hits.length) return '';
  return hits
    .filter(hit => hit.title)
    .map(hit => `- ${hit.title}: ${stripTags(hit.snippet || '')}`)
    .join('\n');
}

async function fetchJson(url: string, ms = 3500): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
