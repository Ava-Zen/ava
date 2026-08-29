import {
  formatConversation,
  looksLikeTopicShift,
  memoryNodeFamily,
  parseConversation,
  rankTopics,
  scopeHistoryToTopic,
  scoreTopic,
  suggestTopicFromText,
  type MemoryTopic,
  type MemoryTurn,
} from './memory';

function topic(partial: Partial<MemoryTopic> & Pick<MemoryTopic, 'id' | 'title'>): MemoryTopic {
  return {
    description: '',
    tags: [partial.id],
    aliases: [],
    notes: '',
    updatedAt: '2026-08-19T00:00:00Z',
    ...partial,
  };
}

describe('topic routing', () => {
  const work = topic({ id: 'work', title: 'Work', aliases: ['office', 'job'], notes: '- meeting with sarah' });
  const family = topic({ id: 'family', title: 'Family', aliases: ['kids', 'home'] });

  it('picks the matching subject without mixing the other', () => {
    const ranked = rankTopics('Can you remind me about the meeting with Sarah at work', [work, family], 'family');
    expect(ranked[0].topic.id).toBe('work');
    expect(scoreTopic('meeting with sarah at work', family, 'family')).toBeLessThan(ranked[0].score);
  });

  it('opens a new subject from natural speech', () => {
    const suggested = suggestTopicFromText('Remember that my garden needs watering on Thursdays');
    expect(suggested?.title.toLowerCase()).toContain('garden');
  });

  it('does not invent a subject for greetings', () => {
    expect(suggestTopicFromText('Hello Ava')).toBeNull();
    expect(suggestTopicFromText('How are you')).toBeNull();
  });

  it('does not file Grok CLI work as a subject', () => {
    expect(suggestTopicFromText('I want to do some work on my Ava app to do some improvements')).toBeNull();
    expect(suggestTopicFromText('open grok')).toBeNull();
    expect(suggestTopicFromText('work on my Nostria project')).toBeNull();
  });

  it('notices an explicit subject change', () => {
    expect(looksLikeTopicShift('Anyway, talking about the kids now')).toBeTrue();
  });
});

describe('topic-scoped history', () => {
  it('does not carry the other subject into the model', () => {
    const work: MemoryTurn = {
      role: 'user',
      text: 'The report is due Friday.',
      timestamp: new Date('2026-08-19T14:00:00Z'),
      topicId: 'work',
    };
    const avaWork: MemoryTurn = {
      role: 'ava',
      text: 'I will keep Friday in mind.',
      timestamp: new Date('2026-08-19T14:00:08Z'),
      topicId: 'work',
    };
    const family: MemoryTurn = {
      role: 'user',
      text: 'The kids are with my sister tonight.',
      timestamp: new Date('2026-08-19T18:00:00Z'),
      topicId: 'family',
    };
    const current: MemoryTurn = {
      role: 'user',
      text: 'What should I pack for them?',
      timestamp: new Date('2026-08-19T18:00:10Z'),
      topicId: 'family',
    };
    const history = scopeHistoryToTopic([work, avaWork, family, current], 'family', 6);
    expect(history.some(turn => turn.topicId === 'work')).toBeFalse();
    expect(history.some(turn => /kids/i.test(turn.text))).toBeTrue();
  });
});

describe('memory map node families', () => {
  it('keeps people apart from Ava, topics, and notes', () => {
    expect(memoryNodeFamily('Companion', 'ava')).toBe('companion');
    expect(memoryNodeFamily('Person', 'you')).toBe('person');
    expect(memoryNodeFamily('Person', 'sarah')).toBe('person');
    expect(memoryNodeFamily('Sister', 'maya')).toBe('person');
    expect(memoryNodeFamily('Topic', 'work')).toBe('topic');
    expect(memoryNodeFamily('Note')).toBe('note');
    expect(memoryNodeFamily('Directory')).toBe('place');
    expect(memoryNodeFamily('dir')).toBe('place');
    expect(memoryNodeFamily('Directory', 'person')).toBe('place');
  });
});

describe('constellation links', () => {
  it('connects subjects that share language', () => {
    const work = topic({ id: 'work', title: 'Work', aliases: ['office'], notes: '- kids pickup after office' });
    const family = topic({ id: 'family', title: 'Family', aliases: ['kids'] });
    const hay = `${work.title} ${work.aliases.join(' ')} ${work.notes}`.toLowerCase();
    expect(hay.includes('kids')).toBeTrue();
    expect(`${family.title} ${family.aliases.join(' ')}`.toLowerCase()).toContain('kids');
  });
});

describe('conversation files', () => {
  it('round-trips a single talk', () => {
    const raw = formatConversation([
      { role: 'user', text: 'The report is due Friday.', timestamp: new Date('2026-08-19T14:32:00Z'), topicId: 'work' },
      { role: 'ava', text: 'I will keep Friday in mind.', timestamp: new Date('2026-08-19T14:32:08Z'), topicId: 'work' },
    ]);
    const turns = parseConversation(raw, '2026-08-19');
    expect(turns.length).toBe(2);
    expect(turns[0].role).toBe('user');
    expect(turns[0].topicId).toBe('work');
    expect(turns[1].text).toContain('Friday');
  });
});
