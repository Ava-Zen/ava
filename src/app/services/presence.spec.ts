import {
  durableFact,
  identityFact,
  isAskingWhatSheRemembers,
  isExplicitRemember,
  peopleFromText,
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
