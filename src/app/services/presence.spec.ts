import {
  durableFact,
  extractGivenFullName,
  fullNameFromPersona,
  identityFact,
  identitySocials,
  isAskingWhatSheRemembers,
  isExplicitRemember,
  missingPersona,
  peopleFromText,
  personaGapFromLine,
  personaReplyFact,
  pickIdleNudge,
  presenceAside,
  presenceTitle,
} from './presence';

describe('presence', () => {
  it('stays short in the idle title', () => {
    expect(presenceTitle({ name: 'Sondre', hour: 21 })).toBe('I am here, Sondre.');
    expect(presenceTitle({ listening: true, name: 'Sondre' })).toBe('I am listening.');
    expect(presenceTitle({ hour: 3, name: 'Sondre' })).toBe('Still here, Sondre.');
  });

  it('only whispers after a long gap', () => {
    const now = new Date('2026-08-20T10:00:00Z');
    expect(presenceAside({ lastAt: new Date('2026-08-20T09:00:00Z'), topicTitle: 'Work', now })).toBe('');
    expect(presenceAside({ lastAt: new Date('2026-08-19T20:00:00Z'), topicTitle: 'Work', now })).toBe('I still have Work.');
  });
});

describe('what to keep', () => {
  it('keeps explicit remembers and identity, not small talk', () => {
    expect(isExplicitRemember('Remember that my garden needs watering on Thursdays')).toBeTrue();
    expect(durableFact('Remember that my garden needs watering on Thursdays')).toMatch(/garden/i);
    expect(identityFact('My name is Sondre')).toBe('Name is Sondre');
    expect(identityFact('My full name is Sondre Larsen')).toBe('Full name is Sondre Larsen');
    expect(identityFact('My name is Sondre Larsen')).toBe('Full name is Sondre Larsen');
    expect(identityFact('My twitter is @sondr')).toBe('X is @sondr');
    expect(identityFact('I am 42 years old')).toBe('Age is 42');
    expect(fullNameFromPersona('Sondre', 'Full name is Sondre Larsen')).toBe('Sondre Larsen');
    expect(extractGivenFullName('Sondre Larsen')).toBe('Sondre Larsen');
    expect(identitySocials('X is @sondr\nYouTube is @ava')).toEqual(['X: @sondr', 'YouTube: @ava']);
    expect(durableFact('How are you today')).toBeNull();
    expect(isAskingWhatSheRemembers('What do you remember')).toBeTrue();
    expect(isAskingWhatSheRemembers('Remember that the keys are in the bowl')).toBeFalse();
  });

  it('files a partner and kids as people', () => {
    const people = peopleFromText('My partner is Sigrid and our kids are Lea and Noah');
    expect(people.map(person => person.name)).toEqual(['Sigrid', 'Lea', 'Noah']);
    expect(people[0].relation).toBe('partner');
    expect(people.filter(person => person.relation === 'child').length).toBe(2);
  });

  it('files a girlfriend and kids from ordinary speech', () => {
    const people = peopleFromText(
      'I have a girlfriend, her name is Tania. We have two kids: Mira (6 years) and Erik (1 year).',
    );
    expect(people.map(person => person.name)).toEqual(['Tania', 'Mira', 'Erik']);
    expect(people[0].relation).toBe('partner');
    expect(people[0].role).toBe('Girlfriend');
    expect(people.find(person => person.name === 'Mira')?.notes).toBe('6 years old');
    expect(people.find(person => person.name === 'Erik')?.notes).toBe('1 year old');
  });
});

describe('idle presence', () => {
  it('asks for missing persona before small talk', () => {
    expect(missingPersona({ identity: 'Sondre talks with Ava here.', name: 'Sondre' })).toEqual([
      'age',
      'work',
      'family',
      'home',
    ]);
    const nudge = pickIdleNudge({ name: 'Sondre', identity: 'Sondre talks with Ava here.' }, () => 0);
    expect(nudge?.key).toBe('persona:age');
  });

  it('picks among idle thoughts at random and does not repeat', () => {
    const topics = [
      { id: 'cameras', title: 'Cameras', notes: '- research best cameras under 800', updatedAt: '2026-08-01T00:00:00Z' },
    ];
    const input = {
      name: 'Sondre',
      identity: 'Name is Sondre\nAge is 42\nWorks as a designer\nLives in Oslo',
      peopleCount: 2,
      unfinishedPrompt: 'Look into the camera options we started',
      topics,
    };
    const first = pickIdleNudge(input, () => 0);
    expect(first?.line).toMatch(/unfinished work/i);
    const last = pickIdleNudge(input, () => 0.99);
    expect(last?.key).toBe('next');
    const second = pickIdleNudge({ ...input, usedKeys: [first!.key] }, () => 0);
    expect(second?.key).toBe('research:cameras');
    expect(second?.key).not.toBe(first?.key);
  });

  it('reads a persona question so a short reply can be kept', () => {
    expect(personaGapFromLine('Where do you live these days?')).toBe('home');
    expect(personaGapFromLine('How old are you? I would like to know you a little better.')).toBe('age');
    expect(personaReplyFact('age', '42')).toBe('Age is 42');
    expect(personaReplyFact('home', 'Oslo')).toBe('Lives in Oslo');
    expect(personaReplyFact('work', 'I am a designer')).toBe('Works designer');
    expect(personaReplyFact('work', 'yes')).toBeNull();
  });
});
