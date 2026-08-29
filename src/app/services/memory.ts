import { Injectable, computed, inject, signal } from '@angular/core';
import { HomeService } from './home';
import { GardensService } from './gardens';
import { OnboardingService } from './onboarding';
import { isAskingForGrokWork, isGrokSessionMemory } from '../intents';
import {
  compactNote,
  durableFact,
  fullNameFromPersona,
  identityFact,
  isExplicitRemember,
  peopleFromText,
  personaReplyFact,
  type PersonaGap,
  type PersonMention,
} from './presence';
import {
  OKF_ACTOR,
  OKF_VERSION,
  generatedNow,
  joinRel,
  okfDescription,
  okfStringList,
  okfTags,
  okfTitle,
  okfType,
  parseOkf,
  slugify,
  stringifyOkf,
  todayIsoDate,
} from './okf';

export interface MemoryTopic {
  id: string;
  title: string;
  description: string;
  tags: string[];
  aliases: string[];
  notes: string;
  updatedAt: string;
}

export interface MemoryTurn {
  role: 'user' | 'ava';
  text: string;
  timestamp: Date;
  topicId?: string;
}

export interface MemoryNode {
  id: string;
  rel: string;
  title: string;
  description: string;
  type: string;
  kind: 'dir' | 'doc';
  tags: string[];
  body?: string;
}

export interface TopicRoute {
  topic: MemoryTopic | null;
  switched: boolean;
  created: boolean;
}

export interface RememberResult {
  kind: 'topic' | 'identity' | 'people' | 'none';
  line?: string;
  explicit: boolean;
}

export interface MemoryPerson {
  id: string;
  name: string;
  role: string;
  relation: string;
  notes: string;
}

export type MemoryNodeFamily = 'companion' | 'person' | 'topic' | 'note' | 'place';

export interface MemoryGraphNode {
  id: string;
  title: string;
  rel: string;
  kind: string;
  weight: number;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export interface MemoryEvent {
  id: string;
  at: string;
  title: string;
  detail: string;
  rel?: string;
}

const STOP_TOPIC =
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|what time is it|what can you do|how are you)[\s.!?]*$/i;

const GREETING =
  /^(?:(?:hey\s+)?ava[,.]?\s+)?(?:hi|hello|hey|good (?:morning|afternoon|evening))[\s.!?]*$/i;

@Injectable({ providedIn: 'root' })
export class MemoryService {
  private readonly home = inject(HomeService);
  private readonly gardens = inject(GardensService);
  private readonly onboarding = inject(OnboardingService);

  readonly topics = signal<MemoryTopic[]>([]);
  readonly activeTopicId = signal<string | null>(null);
  readonly activeTopic = computed(() => {
    const id = this.activeTopicId();
    return this.topics().find(topic => topic.id === id) ?? null;
  });
  readonly homeLabel = this.home.label;
  readonly homePath = this.home.root;
  readonly desktop = this.home.desktop;
  readonly canRevealHome = this.home.canReveal;
  readonly lastNotice = signal('');
  readonly homeError = signal('');
  readonly identityNotes = signal('');
  readonly people = signal<MemoryPerson[]>([]);
  readonly focusRel = signal('');

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTurns: MemoryTurn[] = [];
  private clearedAfter: string | null = null;

  async hydrate(fallback: MemoryTurn[] = []): Promise<MemoryTurn[]> {
    await this.home.whenReady();
    this.activeTopicId.set(null);
    await this.ensureBundle();
    await this.reloadTopics();
    await this.loadClearedAfter();
    await this.loadIdentity();
    await this.reloadPeople();
    await this.loadLastNotice();
    const stored = await this.loadConversation();
    if (stored.length) {
      this.lastTurns = stored;
      const lastTopic = [...stored].reverse().find(turn => {
        if (!turn.topicId) return false;
        const topic = this.topics().find(item => item.id === turn.topicId);
        if (!topic) return true;
        return !isGrokSessionMemory(`${topic.title}\n${topic.notes}\n${topic.description}`);
      })?.topicId;
      if (lastTopic) this.activeTopicId.set(lastTopic);
      await this.recoverPeople(stored);
      return stored;
    }
    if (fallback.length) {
      this.lastTurns = fallback;
      await this.writeConversation(fallback);
      await this.recoverPeople(fallback);
      return fallback;
    }
    return [];
  }

  async ensureBundle(name?: string): Promise<void> {
    await this.home.whenReady();
    const personName = name || this.onboarding.userName() || 'You';
    if (!(await this.home.exists('index.md'))) {
      await this.home.writeText('index.md', rootIndex());
    } else {
      const index = await this.home.readText('index.md');
      if (index && !/reports\//i.test(index) && index.includes('[Noticing]')) {
        await this.home.writeText(
          'index.md',
          index.replace(
            '* [Noticing]',
            '* [Reports](reports/) - research Ava wrote for you\n* [Noticing]',
          ),
        );
      }
    }
    if (!(await this.home.exists('log.md'))) {
      await this.home.writeText('log.md', rootLog());
    }
    if (!(await this.home.exists('person/index.md'))) {
      await this.home.writeText('person/index.md', directoryIndex('You', [
        { href: 'profile.md', title: personName, description: 'Who Ava is speaking with' },
      ]));
    }
    if (!(await this.home.exists('person/profile.md'))) {
      await this.home.writeText('person/profile.md', personDoc(personName));
    }
    if (!(await this.home.exists('person/ava.md'))) {
      await this.home.writeText('person/ava.md', avaDoc());
    }
    await this.reloadPeople();
    await this.writePeopleIndex();
    if (!(await this.home.exists('noticing.md'))) {
      await this.home.writeText('noticing.md', noticingDoc());
    }
    if (!(await this.home.exists('topics/index.md'))) {
      await this.home.writeText('topics/index.md', directoryIndex('Topics', []));
    }
    if (!(await this.home.exists('conversation/index.md'))) {
      await this.home.writeText('conversation/index.md', directoryIndex('Conversation', []));
    }
    if (!(await this.home.exists('reports/index.md'))) {
      await this.home.writeText('reports/index.md', directoryIndex('Reports', []));
    }
  }

  async rememberFullName(name: string): Promise<void> {
    await this.writeIdentity(`Full name is ${name}`);
  }

  async writeReport(title: string, body: string, description?: string): Promise<string> {
    await this.home.whenReady();
    if (!(await this.home.exists('reports/index.md'))) {
      await this.home.writeText('reports/index.md', directoryIndex('Reports', []));
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const rel = `reports/${stamp}-${slugify(title)}.md`;
    await this.home.writeText(rel, stringifyOkf({
      type: 'Report',
      title,
      description: description || 'A research report Ava wrote for you.',
      tags: ['research', 'report'],
      generated: generatedNow(),
    }, `${body.trim()}\n`));
    await this.writeReportsIndex();
    this.noteQuietly(title);
    void this.appendLog(`**Report**: Wrote [${title}](/${rel}).`);
    return rel;
  }

  private async writeReportsIndex(): Promise<void> {
    const entries = await this.home.list('reports');
    const items: Array<{ href: string; title: string; description: string }> = [];
    for (const entry of entries.filter(item => item.name.endsWith('.md') && item.name !== 'index.md')) {
      const doc = await this.readDoc(entry.rel);
      items.push({
        href: entry.name,
        title: doc ? okfTitle(doc, titleFromRel(entry.rel)) : titleFromRel(entry.rel),
        description: doc ? okfDescription(doc) : 'A research report',
      });
    }
    items.reverse();
    await this.home.writeText('reports/index.md', directoryIndex('Reports', items));
  }

  route(text: string): TopicRoute {
    if (isAskingForGrokWork(text)) {
      return { topic: null, switched: false, created: false };
    }
    const topics = this.topics();
    const previous = this.activeTopicId();
    const ranked = rankTopics(text, topics, previous);
    const winner = ranked[0];
    const nextBest = ranked[1];
    const sticky = topics.find(topic => topic.id === previous) ?? null;

    if (winner && winner.score >= 3 && (!nextBest || winner.score >= nextBest.score + 2 || winner.topic.id === previous)) {
      const switched = winner.topic.id !== previous;
      this.activeTopicId.set(winner.topic.id);
      return { topic: winner.topic, switched, created: false };
    }

    if (sticky && !looksLikeTopicShift(text) && !winner) {
      this.activeTopicId.set(sticky.id);
      return { topic: sticky, switched: false, created: false };
    }

    if (sticky && (!winner || winner.score < 3) && !looksLikeTopicShift(text)) {
      this.activeTopicId.set(sticky.id);
      return { topic: sticky, switched: false, created: false };
    }

    const suggestion = suggestTopicFromText(text);
    if (suggestion) {
      const created = this.upsertTopic(suggestion.title, suggestion.seed);
      this.activeTopicId.set(created.id);
      return { topic: created, switched: created.id !== previous, created: created.description === suggestion.seed };
    }

    if (sticky) {
      this.activeTopicId.set(sticky.id);
      return { topic: sticky, switched: false, created: false };
    }

    this.activeTopicId.set(null);
    return { topic: null, switched: false, created: false };
  }

  contextBlock(topic: MemoryTopic | null): string {
    if (topic && isGrokSessionMemory(`${topic.title}\n${topic.notes}\n${topic.description}`)) {
      topic = null;
    }
    const parts: string[] = [];
    const name = this.onboarding.userName();
    if (name) parts.push(`You are speaking with ${name}.`);
    const fullName = fullNameFromPersona(name, this.identityNotes());
    if (fullName && fullName.toLowerCase() !== name.trim().toLowerCase()) {
      parts.push(`Their full name is ${fullName}.`);
    }
    const identity = this.identityNotes().trim();
    if (identity) {
      parts.push('What you know about them:');
      parts.push(identity.slice(0, 600));
    }
    const people = this.people().filter(person => person.id !== 'ava' && person.id !== 'profile');
    if (people.length) {
      parts.push('People in their life:');
      parts.push(people.map(person => `${person.name} (${person.role})`).join(', '));
    }
    if (!topic) {
      parts.push(
        'This is one ongoing conversation. Keep replies in the current subject.',
        'If they change subject, follow them. Do not mix in unrelated memory.',
      );
      return parts.join('\n');
    }
    parts.push(`Current subject: ${topic.title}. Stay on this subject unless they clearly change it.`);
    if (topic.description) parts.push(topic.description);
    const notes = topic.notes.trim();
    if (notes) {
      parts.push('What you remember about this subject:');
      parts.push(notes.slice(0, 1800));
    }
    parts.push('Do not bring in other subjects unless they ask.');
    return parts.join('\n');
  }

  historyForTopic(turns: MemoryTurn[], topicId: string | null | undefined, maxTurns = 6): MemoryTurn[] {
    return scopeHistoryToTopic(turns, topicId, maxTurns);
  }

  rememberUser(text: string, topic: MemoryTopic | null, personaGap?: PersonaGap | null): RememberResult {
    const trimmed = text.trim();
    const explicit = isExplicitRemember(trimmed);
    if (!trimmed) return { kind: 'none', explicit };

    const people = peopleFromText(trimmed);
    if (people.length) {
      void this.writePeople(people);
      const line = people.map(person => person.notes
        ? `${person.role}: ${person.name} (${person.notes})`
        : `${person.role}: ${person.name}`).join(', ');
      this.noteQuietly(line);
      return { kind: 'people', line, explicit: true };
    }

    const identity = identityFact(trimmed) || (personaGap ? personaReplyFact(personaGap, trimmed) : null);
    if (identity) {
      void this.writeIdentity(identity);
      this.noteQuietly(identity);
      return { kind: 'identity', line: identity, explicit: true };
    }

    const fact = durableFact(trimmed);
    if (!fact || !topic) return { kind: 'none', explicit };

    const next: MemoryTopic = {
      ...topic,
      notes: appendNote(topic.notes, fact),
      aliases: mergeAliases(topic.aliases, aliasesFromText(trimmed, topic.title)),
      updatedAt: new Date().toISOString(),
    };
    this.topics.update(list => list.map(item => (item.id === topic.id ? next : item)));
    void this.writeTopic(next);
    void this.writeTopicsIndex();
    this.noteQuietly(fact);
    void this.appendLog(`**Update**: Kept a note in [${topic.title}](/topics/${topic.id}/).`);
    return { kind: 'topic', line: fact, explicit };
  }

  markConversationCleared(): void {
    this.clearedAfter = new Date().toISOString();
    this.lastTurns = [];
    void this.home.writeText('conversation/state.md', stringifyOkf({
      type: 'Conversation',
      title: 'The talk',
      description: 'The visible talk starts again from here. Older days stay in files.',
      since: this.clearedAfter,
      generated: generatedNow(),
    }, 'A fresh start. Yesterday is still in this home if you want to walk back.\n'));
  }

  scheduleConversationWrite(turns: MemoryTurn[]): void {
    this.lastTurns = turns;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.writeConversation(this.lastTurns);
    }, 400);
  }

  async nodeAt(rel = ''): Promise<MemoryNode> {
    await this.home.whenReady();
    const path = normalizeRel(rel);
    if (!path) {
      return {
        id: 'home',
        rel: '',
        title: this.home.label() || 'Ava',
        description: 'What Ava keeps for you.',
        type: 'Bundle',
        kind: 'dir',
        tags: [],
      };
    }
    const doc = await this.readDoc(path.endsWith('.md') ? path : joinRel(path, 'index.md'));
    if (doc) {
      return {
        id: path,
        rel: path,
        title: okfTitle(doc, titleFromRel(path)),
        description: okfDescription(doc),
        type: okfType(doc),
        kind: path.endsWith('.md') && !path.endsWith('index.md') ? 'doc' : 'dir',
        tags: okfTags(doc),
        body: doc.body,
      };
    }
    return {
      id: path,
      rel: path,
      title: titleFromRel(path),
      description: '',
      type: 'Directory',
      kind: 'dir',
      tags: [],
    };
  }

  async childrenOf(rel = ''): Promise<MemoryNode[]> {
    await this.home.whenReady();
    const entries = await this.home.list(rel);
    const nodes: MemoryNode[] = [];
    for (const entry of entries) {
      if (entry.name === 'index.md') continue;
      if (entry.dir) {
        const index = await this.readDoc(joinRel(entry.rel, 'index.md'));
        nodes.push({
          id: entry.rel,
          rel: entry.rel,
          title: index ? okfTitle(index, titleFromRel(entry.rel)) : titleFromRel(entry.rel),
          description: index ? okfDescription(index) : '',
          type: 'Directory',
          kind: 'dir',
          tags: index ? okfTags(index) : [],
        });
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const doc = await this.readDoc(entry.rel);
      nodes.push({
        id: entry.rel,
        rel: entry.rel,
        title: doc ? okfTitle(doc, titleFromRel(entry.rel)) : titleFromRel(entry.rel),
        description: doc ? okfDescription(doc) : '',
        type: doc ? okfType(doc) : 'Concept',
        kind: 'doc',
        tags: doc ? okfTags(doc) : [],
        body: doc?.body,
      });
    }
    return nodes;
  }

  async readBody(rel: string): Promise<string> {
    const doc = await this.readDoc(rel);
    return doc?.body ?? '';
  }

  constellation(rel = ''): MemoryGraph {
    const path = normalizeRel(rel);
    const inTopics = !path || path === 'topics' || path.startsWith('topics/');
    const topics = this.topics();
    if (!inTopics && path) {
      return { nodes: [], edges: [] };
    }
    const nodes: MemoryGraphNode[] = [
      { id: 'ava', title: 'Ava', rel: 'person/ava.md', kind: 'Companion', weight: 3 },
      { id: 'you', title: this.onboarding.userName() || 'You', rel: 'person/profile.md', kind: 'Person', weight: 3 },
    ];
    const edges: MemoryGraphEdge[] = [{ from: 'ava', to: 'you' }];
    for (const person of this.people()) {
      if (person.id === 'ava' || person.id === 'profile') continue;
      nodes.push({
        id: person.id,
        title: person.name,
        rel: `person/${person.id}.md`,
        kind: 'Person',
        weight: 2,
      });
      edges.push({ from: 'you', to: person.id });
    }
    const focus = path.startsWith('topics/') ? path.split('/')[1] : '';
    for (const topic of topics) {
      nodes.push({
        id: topic.id,
        title: topic.title,
        rel: `topics/${topic.id}`,
        kind: 'Topic',
        weight: 1 + Math.min(4, Math.round(topic.notes.length / 90)),
      });
      edges.push({ from: 'ava', to: topic.id });
      if (focus && topic.id === focus) edges.push({ from: 'you', to: topic.id });
    }
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        if (topicsShare(topics[i], topics[j])) {
          edges.push({ from: topics[i].id, to: topics[j].id });
        }
      }
    }
    return { nodes, edges };
  }

  async timeline(): Promise<MemoryEvent[]> {
    const events: MemoryEvent[] = [];
    const noticing = await this.readDoc('noticing.md');
    if (noticing) {
      for (const line of noticing.body.split('\n')) {
        const match = line.replace(/^- /, '').match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — (.+)$/);
        if (!match) continue;
        events.push({
          id: `notice-${match[1]}-${match[2].slice(0, 24)}`,
          at: match[1].replace(' ', 'T') + ':00',
          title: 'Kept',
          detail: match[2],
          rel: 'noticing.md',
        });
      }
    }
    const days = await this.home.list('conversation');
    for (const day of days.filter(item => /^\d{4}-\d{2}-\d{2}\.md$/.test(item.name))) {
      const stamp = day.name.replace(/\.md$/, '');
      events.push({
        id: `day-${stamp}`,
        at: `${stamp}T20:00:00`,
        title: stamp,
        detail: 'A day of the talk',
        rel: day.rel,
      });
    }
    for (const topic of this.topics()) {
      events.push({
        id: `topic-${topic.id}`,
        at: topic.updatedAt,
        title: topic.title,
        detail: topic.description || 'A subject Ava is holding',
        rel: `topics/${topic.id}`,
      });
    }
    const reports = await this.home.list('reports');
    for (const entry of reports.filter(item => item.name.endsWith('.md') && item.name !== 'index.md')) {
      const doc = await this.readDoc(entry.rel);
      const generated = doc?.frontmatter['generated'] as { at?: string } | undefined;
      events.push({
        id: `report-${entry.name}`,
        at: generated?.at || new Date().toISOString(),
        title: doc ? okfTitle(doc, titleFromRel(entry.rel)) : titleFromRel(entry.rel),
        detail: doc ? okfDescription(doc) || 'A research report' : 'A research report',
        rel: entry.rel,
      });
    }
    return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  }

  async pickHomeFolder(): Promise<string | null> {
    const result = await this.gardens.pickHomeFor();
    if (!result.ok) {
      this.homeError.set(result.error || '');
      return null;
    }
    this.homeError.set('');
    await this.ensureBundle();
    return result.path;
  }

  async revealHome(): Promise<boolean> {
    this.homeError.set('');
    const ok = await this.home.openInExplorer();
    if (!ok && this.home.canReveal()) {
      this.homeError.set('Could not open the home folder.');
    }
    return ok;
  }

  async useSuggestedHome(): Promise<string | null> {
    const path = await this.home.useSuggested();
    if (path) await this.ensureBundle();
    return path;
  }

  private upsertTopic(title: string, seed: string): MemoryTopic {
    const existing = this.topics().find(topic => topic.title.toLowerCase() === title.toLowerCase());
    if (existing) return existing;
    const id = uniqueTopicId(slugify(title), this.topics().map(topic => topic.id));
    const topic: MemoryTopic = {
      id,
      title,
      description: seed,
      tags: [id],
      aliases: aliasesFromText(title, title),
      notes: seed ? `- ${seed}` : '',
      updatedAt: new Date().toISOString(),
    };
    this.topics.update(list => [...list, topic]);
    void this.writeTopic(topic);
    void this.writeTopicsIndex();
    void this.appendLog(`**Creation**: Opened [${title}](/topics/${id}/).`);
    return topic;
  }

  private async reloadTopics(): Promise<void> {
    const entries = await this.home.list('topics');
    const topics: MemoryTopic[] = [];
    for (const entry of entries) {
      if (!entry.dir) continue;
      const index = await this.readDoc(joinRel('topics', entry.name, 'index.md'));
      const notes = await this.readDoc(joinRel('topics', entry.name, 'notes.md'));
      const title = index ? okfTitle(index, titleFromRel(entry.name)) : titleFromRel(entry.name);
      topics.push({
        id: entry.name,
        title,
        description: index ? okfDescription(index) : '',
        tags: index ? okfTags(index) : [entry.name],
        aliases: index ? okfStringList(index.frontmatter['aliases']) : [],
        notes: notes?.body.trim() ?? '',
        updatedAt: new Date().toISOString(),
      });
    }
    this.topics.set(topics);
  }

  private async writeTopic(topic: MemoryTopic): Promise<void> {
    const dir = joinRel('topics', topic.id);
    await this.home.writeText(joinRel(dir, 'index.md'), stringifyOkf({
      type: 'Topic',
      title: topic.title,
      description: topic.description || `What Ava remembers about ${topic.title}.`,
      tags: topic.tags,
      aliases: topic.aliases,
      status: 'stable',
      generated: generatedNow(),
    }, `${topic.description || `Notes on ${topic.title}.`}\n\nSee [notes](./notes.md).\n`));
    await this.home.writeText(joinRel(dir, 'notes.md'), stringifyOkf({
      type: 'Note',
      title: `${topic.title} notes`,
      description: `Living notes for ${topic.title}.`,
      tags: topic.tags,
      generated: generatedNow(),
    }, `${topic.notes.trim()}\n`));
  }

  private async writeTopicsIndex(): Promise<void> {
    const items = this.topics().map(topic => ({
      href: `${topic.id}/`,
      title: topic.title,
      description: topic.description || `Notes on ${topic.title}`,
    }));
    await this.home.writeText('topics/index.md', directoryIndex('Topics', items));
  }

  private async writeConversation(turns: MemoryTurn[]): Promise<void> {
    const byDay = new Map<string, MemoryTurn[]>();
    for (const turn of turns) {
      const day = todayIsoDate(turn.timestamp);
      const list = byDay.get(day) ?? [];
      list.push(turn);
      byDay.set(day, list);
    }
    const days = [...byDay.keys()].sort().reverse();
    await this.home.writeText('conversation/index.md', directoryIndex(
      'Conversation',
      days.map(day => ({
        href: `${day}.md`,
        title: day,
        description: 'The talk from this day',
      })),
    ));
    for (const [day, dayTurns] of byDay) {
      await this.home.writeText(joinRel('conversation', `${day}.md`), stringifyOkf({
        type: 'Conversation',
        title: day,
        description: 'The ongoing talk for this day.',
        tags: ['conversation'],
        generated: generatedNow(),
      }, formatConversation(dayTurns)));
    }
  }

  private async loadConversation(): Promise<MemoryTurn[]> {
    const entries = await this.home.list('conversation');
    const files = entries
      .filter(entry => !entry.dir && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const turns: MemoryTurn[] = [];
    for (const file of files) {
      const raw = await this.home.readText(file.rel);
      if (!raw) continue;
      turns.push(...parseConversation(parseOkf(raw).body, file.name.replace(/\.md$/, '')));
    }
    if (!this.clearedAfter) return turns;
    const since = new Date(this.clearedAfter).getTime();
    if (!Number.isFinite(since)) return turns;
    return turns.filter(turn => turn.timestamp.getTime() >= since);
  }

  private async loadClearedAfter(): Promise<void> {
    const raw = await this.home.readText('conversation/state.md');
    if (!raw) return;
    const since = parseOkf(raw).frontmatter['since'];
    if (typeof since === 'string' && since) this.clearedAfter = since;
  }

  private async loadLastNotice(): Promise<void> {
    const raw = await this.home.readText('noticing.md');
    if (!raw) return;
    const lines = parseOkf(raw).body.split('\n').map(line => line.replace(/^- /, '').trim()).filter(Boolean);
    const last = lines.at(-1);
    if (last && !/^nothing kept yet/i.test(last)) this.lastNotice.set(last.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — /, ''));
  }

  private async recoverPeople(turns: MemoryTurn[]): Promise<void> {
    const mentions = turns
      .filter(turn => turn.role === 'user')
      .slice(-40)
      .flatMap(turn => peopleFromText(turn.text));
    if (mentions.length) await this.writePeople(mentions);
  }

  private async writePeople(mentions: PersonMention[]): Promise<void> {
    const next = [...this.people()];
    for (const mention of mentions) {
      const existing = next.find(person => person.name.toLowerCase() === mention.name.toLowerCase());
      const base = existing?.notes?.trim() || `${mention.name} is ${mention.role.toLowerCase()}.`;
      const extra = mention.notes?.trim() || '';
      const notes = extra && !base.toLowerCase().includes(extra.toLowerCase())
        ? `${base} ${extra}`.trim()
        : base;
      const person: MemoryPerson = existing
        ? { ...existing, role: mention.role, relation: mention.relation, notes }
        : {
          id: uniqueTopicId(slugify(mention.name), next.map(item => item.id).concat(['index', 'profile', 'ava'])),
          name: mention.name,
          role: mention.role,
          relation: mention.relation,
          notes,
        };
      if (existing) {
        const index = next.findIndex(item => item.id === existing.id);
        next[index] = person;
      } else {
        next.push(person);
        void this.appendLog(`**Creation**: Opened [${person.name}](/person/${person.id}.md).`);
      }
      await this.home.writeText(joinRel('person', `${person.id}.md`), stringifyOkf({
        type: 'Person',
        title: person.name,
        description: person.role,
        role: person.role,
        relation: person.relation,
        tags: ['person', person.relation],
        generated: generatedNow(),
      }, `${person.notes.trim()}\n`));
    }
    this.people.set(next);
    await this.writePeopleIndex();
  }

  private async reloadPeople(): Promise<void> {
    const entries = await this.home.list('person');
    const people: MemoryPerson[] = [];
    for (const entry of entries) {
      if (entry.dir || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const doc = await this.readDoc(entry.rel);
      const id = entry.name.replace(/\.md$/, '');
      people.push({
        id,
        name: doc ? okfTitle(doc, titleFromRel(id)) : titleFromRel(id),
        role: String(doc?.frontmatter['role'] || (id === 'ava' ? 'Companion' : id === 'profile' ? 'You' : 'Person')),
        relation: String(doc?.frontmatter['relation'] || ''),
        notes: doc?.body.trim() ?? '',
      });
    }
    this.people.set(people);
  }

  private async writePeopleIndex(): Promise<void> {
    const user = this.onboarding.userName() || 'You';
    const extras = this.people()
      .filter(person => person.id !== 'ava' && person.id !== 'profile')
      .map(person => ({
        href: `${person.id}.md`,
        title: person.name,
        description: person.role,
      }));
    await this.home.writeText('person/index.md', directoryIndex('People', [
      { href: 'profile.md', title: user, description: 'Who Ava is speaking with' },
      { href: 'ava.md', title: 'Ava', description: 'The one voice in this home' },
      ...extras,
    ]));
  }

  private async loadIdentity(): Promise<void> {
    const raw = await this.home.readText('person/profile.md');
    if (!raw) return;
    const body = parseOkf(raw).body.trim();
    this.identityNotes.set(body);
  }

  private async writeIdentity(line: string): Promise<void> {
    const name = this.onboarding.userName() || 'You';
    const existing = (await this.home.readText('person/profile.md')) ?? personDoc(name);
    const parsed = parseOkf(existing);
    const body = appendNote(parsed.body, line);
    this.identityNotes.set(body);
    await this.home.writeText('person/profile.md', stringifyOkf({
      ...parsed.frontmatter,
      type: 'Person',
      title: name,
      generated: generatedNow(`human:${slugify(name)}`),
    }, `${body.trim()}\n`));
  }

  private noteQuietly(line: string): void {
    this.lastNotice.set(line);
    void this.appendNoticing(line);
  }

  private async appendNoticing(line: string): Promise<void> {
    const existing = (await this.home.readText('noticing.md')) ?? noticingDoc();
    const parsed = parseOkf(existing);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const next = appendNote(parsed.body, `${stamp} — ${line}`);
    await this.home.writeText('noticing.md', stringifyOkf({
      type: 'Note',
      title: 'Noticing',
      description: 'What Ava quietly kept, in her own time.',
      tags: ['interior'],
      generated: generatedNow(),
    }, `${next.trim()}\n`));
  }

  private async readDoc(rel: string) {
    const raw = await this.home.readText(rel);
    return raw ? parseOkf(raw) : null;
  }

  private async appendLog(entry: string): Promise<void> {
    const day = todayIsoDate();
    const existing = (await this.home.readText('log.md')) ?? rootLog();
    if (existing.includes(`## ${day}`) && existing.includes(entry)) return;
    const next = prependLog(existing, day, entry);
    await this.home.writeText('log.md', next);
  }
}

export function memoryNodeFamily(kind: string, id?: string): MemoryNodeFamily {
  const key = (kind || '').trim().toLowerCase();
  if (id === 'ava' || key === 'companion') return 'companion';
  if (key === 'topic') return 'topic';
  if (key === 'note' || key === 'conversation' || key === 'report' || key === 'concept' || key === 'doc') {
    return 'note';
  }
  if (key === 'directory' || key === 'bundle' || key === 'place' || key === 'dir') return 'place';
  return 'person';
}

export function rankTopics(
  text: string,
  topics: MemoryTopic[],
  previousId: string | null,
): Array<{ topic: MemoryTopic; score: number }> {
  const hay = normalize(text);
  if (!hay) return [];
  return topics
    .map(topic => ({ topic, score: scoreTopic(hay, topic, previousId) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function scoreTopic(hay: string, topic: MemoryTopic, previousId: string | null): number {
  let score = 0;
  const title = normalize(topic.title);
  if (title && hay.includes(title)) score += 6;
  for (const token of tokenize(topic.title)) {
    if (token.length < 3) continue;
    if (hay.includes(token)) score += 3;
  }
  for (const tag of topic.tags) {
    const value = normalize(tag);
    if (value && hay.includes(value)) score += 2;
  }
  for (const alias of topic.aliases) {
    const value = normalize(alias);
    if (value && hay.includes(value)) score += 4;
  }
  for (const token of tokenize(topic.notes).slice(0, 40)) {
    if (token.length < 5) continue;
    if (hay.includes(token)) score += 1;
  }
  if (topic.id === previousId) score += 1;
  return score;
}

export function suggestTopicFromText(text: string): { title: string; seed: string } | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 18) return null;
  if (STOP_TOPIC.test(trimmed) || GREETING.test(trimmed)) return null;
  if (isAskingForGrokWork(trimmed)) return null;
  if (peopleFromText(trimmed).length) return null;
  if (/^(what time|what can you|who are you|how are you)/i.test(trimmed)) return null;

  const about = trimmed.match(/\b(?:about|regarding|re:)\s+([^?.!]{3,42})/i);
  if (about) return { title: cleanTitle(about[1]), seed: compactNote(trimmed) || cleanTitle(about[1]) };

  const remember = trimmed.match(/\bremember(?: that)?\s+(.+)/i);
  if (remember) {
    const seed = compactNote(remember[1]) || remember[1].trim();
    return { title: cleanTitle(seed.split(/[.,]/)[0] || seed), seed };
  }

  const my = trimmed.match(/\bmy\s+([a-z][a-z0-9\s-]{2,32})/i);
  if (my) {
    const title = cleanTitle(`My ${my[1]}`);
    return { title, seed: compactNote(trimmed) || title };
  }

  const quoted = trimmed.match(/["“]([^"”]{3,40})["”]/);
  if (quoted) return { title: cleanTitle(quoted[1]), seed: compactNote(trimmed) || cleanTitle(quoted[1]) };

  const talking = trimmed.match(/\b(?:talk(?:ing)? about|switch(?:ing)? to)\s+([^?.!]{3,42})/i);
  if (talking) return { title: cleanTitle(talking[1]), seed: compactNote(trimmed) || cleanTitle(talking[1]) };

  return null;
}

export function scopeHistoryToTopic(
  turns: MemoryTurn[],
  topicId: string | null | undefined,
  maxTurns = 6,
): MemoryTurn[] {
  const prior = turns.slice(0, -1);
  if (!topicId) return prior.slice(-maxTurns);
  const same = prior.filter(turn => turn.topicId === topicId);
  const streak: MemoryTurn[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const turn = prior[i];
    if (turn.topicId && turn.topicId !== topicId) break;
    if (!turn.topicId) streak.unshift(turn);
    else break;
  }
  const seen = new Set<string>();
  const merged: MemoryTurn[] = [];
  for (const turn of [...same, ...streak]) {
    const key = `${turn.timestamp.toISOString()}:${turn.role}:${turn.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(turn);
  }
  return merged
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(-maxTurns);
}

export function looksLikeTopicShift(text: string): boolean {
  return /\b(anyway|switching|unrelated|different topic|speaking of|on another note|change of subject|talk(?:ing)? about)\b/i.test(text);
}

export function parseConversation(body: string, day: string): MemoryTurn[] {
  const chunks = body.split(/^###\s+/m).map(chunk => chunk.trim()).filter(Boolean);
  const turns: MemoryTurn[] = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^(\S+)\s+·\s+(You|Ava)(?:\s+·\s+([a-z0-9-]+))?\n([\s\S]*)$/i);
    if (!match) continue;
    const stamp = match[1];
    const iso = stamp.includes('T') ? stamp : `${day}T${normalizeClock(stamp)}`;
    const timestamp = new Date(iso);
    turns.push({
      role: match[2].toLowerCase() === 'you' ? 'user' : 'ava',
      text: match[4].trim(),
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date(`${day}T00:00:00`) : timestamp,
      topicId: match[3] || undefined,
    });
  }
  return turns;
}

export function formatConversation(turns: MemoryTurn[]): string {
  if (!turns.length) return '';
  return `${turns.map(turn => {
    const stamp = turn.timestamp.toISOString();
    const who = turn.role === 'user' ? 'You' : 'Ava';
    const topic = turn.topicId ? ` · ${turn.topicId}` : '';
    return `### ${stamp} · ${who}${topic}\n${turn.text.trim()}`;
  }).join('\n\n')}\n`;
}

function appendNote(existing: string, line: string): string {
  const bullet = line.startsWith('- ') ? line : `- ${line}`;
  const current = existing.trim();
  if (current.includes(line)) return current;
  return current ? `${current}\n${bullet}` : bullet;
}

function mergeAliases(current: string[], extra: string[]): string[] {
  const seen = new Set(current.map(item => item.toLowerCase()));
  const next = [...current];
  for (const alias of extra) {
    const key = alias.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(alias);
  }
  return next.slice(0, 12);
}

function aliasesFromText(text: string, title: string): string[] {
  const aliases = new Set<string>([title]);
  for (const token of tokenize(text)) {
    if (token.length > 3) aliases.add(token);
  }
  return [...aliases].slice(0, 8);
}

function topicsShare(a: MemoryTopic, b: MemoryTopic): boolean {
  const hayA = `${a.title} ${a.tags.join(' ')} ${a.aliases.join(' ')} ${a.notes}`.toLowerCase();
  const keys = [...b.tags, ...b.aliases, ...tokenize(b.title)].filter(item => item.length > 3);
  return keys.some(key => hayA.includes(key.toLowerCase()));
}

function uniqueTopicId(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  let i = 2;
  while (used.includes(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

function cleanTitle(value: string): string {
  const cleaned = value.replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  if (!cleaned) return 'Topic';
  return cleaned.replace(/\b\w/g, ch => ch.toUpperCase()).slice(0, 42);
}

function titleFromRel(rel: string): string {
  const name = rel.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || rel;
  return name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function normalizeClock(value: string): string {
  if (/^\d{2}:\d{2}$/.test(value)) return `${value}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  return '00:00:00';
}

function rootIndex(): string {
  return `---
okf_version: "${OKF_VERSION}"
---

# Ava

What Ava keeps for you, as files on this device.

# Rooms

* [You](person/) - who Ava is speaking with
* [Topics](topics/) - one place per subject, kept apart
* [Conversation](conversation/) - the single ongoing talk
* [Reports](reports/) - research Ava wrote for you
* [Noticing](noticing.md) - what Ava quietly kept
`;
}

function avaDoc(): string {
  return stringifyOkf({
    type: 'Companion',
    title: 'Ava',
    description: 'The one voice in this home.',
    tags: ['identity', 'ava'],
    generated: generatedNow(),
  }, [
    'Ava is one companion, not a set of bots.',
    'When you talk about something, she stays with that something.',
    'When you change the subject, she follows without making you pick a room.',
    'What she keeps lives in files you can open.',
    '',
  ].join('\n'));
}

function noticingDoc(): string {
  return stringifyOkf({
    type: 'Note',
    title: 'Noticing',
    description: 'What Ava quietly kept, in her own time.',
    tags: ['interior'],
    generated: generatedNow(),
  }, 'Nothing kept yet.\n');
}

function rootLog(): string {
  return `# Home log

## ${todayIsoDate()}
* **Initialization**: Ava opened this home folder.
`;
}

function directoryIndex(title: string, items: Array<{ href: string; title: string; description: string }>): string {
  const list = items.length
    ? items.map(item => `* [${item.title}](${item.href}) - ${item.description}`).join('\n')
    : '* _Nothing here yet._';
  return `# ${title}\n\n${list}\n`;
}

function personDoc(name: string): string {
  return stringifyOkf({
    type: 'Person',
    title: name,
    description: 'Who Ava is speaking with.',
    tags: ['identity'],
    generated: generatedNow(name ? `human:${slugify(name)}` : OKF_ACTOR),
  }, `${name} talks with Ava here.\n`);
}

function prependLog(existing: string, day: string, entry: string): string {
  const heading = `## ${day}`;
  if (existing.includes(heading)) {
    return existing.replace(heading, `${heading}\n* ${entry}`);
  }
  const intro = existing.split('\n## ')[0].trimEnd();
  const rest = existing.slice(intro.length).trim();
  return `${intro}\n\n${heading}\n* ${entry}\n${rest ? `\n${rest}\n` : ''}`;
}
