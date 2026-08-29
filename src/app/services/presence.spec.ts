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
});

describe('idle presence', () => {
  it('asks for missing persona before small talk', () => {
    expect(missingPersona({ identity: 'Sondre talks with Ava here.', name: 'Sondre' })).toEqual([
      'age',
      'work',
      'family',
      'home',
    ]);
    const nudge = pickIdleNudge({ name: 'Sondre', identity: 'Sondre talks with Ava here.' });
    expect(nudge?.key).toBe('persona:age');
  });

  it('picks unfinished work, then old research, and does not repeat', () => {
    const topics = [
      { id: 'cameras', title: 'Cameras', notes: '- research best cameras under 800', updatedAt: '2026-08-01T00:00:00Z' },
    ];
    const first = pickIdleNudge({
      name: 'Sondre',
      identity: 'Name is Sondre\nAge is 42\nWorks as a designer\nLives in Oslo',
      peopleCount: 2,
      unfinishedPrompt: 'Look into the camera options we started',
      topics,
    });
    expect(first?.line).toMatch(/unfinished work/i);
    const second = pickIdleNudge({
      name: 'Sondre',
      identity: 'Name is Sondre\nAge is 42\nWorks as a designer\nLives in Oslo',
      peopleCount: 2,
      unfinishedPrompt: 'Look into the camera options we started',
      topics,
      usedKeys: [first!.key],
    });
    expect(second?.key).toBe('research:cameras');
  });
});
