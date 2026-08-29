import {
  isSameMessage,
  messageSwipeKey,
  rubberbandSwipe,
  swipeCommitAction,
  swipeIntent,
} from './message-swipe';

describe('message swipe', () => {
  it('treats a left swipe as delete and a right swipe as edit', () => {
    expect(swipeCommitAction(-72)).toBe('delete');
    expect(swipeCommitAction(72)).toBe('edit');
    expect(swipeCommitAction(-20)).toBeNull();
    expect(swipeCommitAction(20)).toBeNull();
  });

  it('does not steal a vertical scroll', () => {
    expect(swipeIntent(2, 2)).toBeNull();
    expect(swipeIntent(24, 6)).toBe('horizontal');
    expect(swipeIntent(6, 24)).toBe('vertical');
  });

  it('softens a drag past the rail', () => {
    expect(rubberbandSwipe(40, 80)).toBe(40);
    expect(rubberbandSwipe(120, 80)).toBeLessThan(120);
    expect(rubberbandSwipe(120, 80)).toBeGreaterThan(80);
  });

  it('keys a message by role and time', () => {
    const at = new Date('2026-08-20T10:00:00Z');
    expect(messageSwipeKey({ role: 'user', timestamp: at })).toBe(`user-${at.getTime()}`);
  });
});

describe('isSameMessage', () => {
  it('does not treat two different messages as the same when both lack ids', () => {
    const user = { role: 'user', text: 'Hi', timestamp: new Date('2026-08-20T10:00:00Z') };
    const ava = { role: 'ava', text: 'Hello', timestamp: new Date('2026-08-20T10:00:01Z') };
    expect(isSameMessage(user, user)).toBeTrue();
    expect(isSameMessage(user, ava)).toBeFalse();
    expect(isSameMessage(user, { ...user })).toBeTrue();
  });
});

describe('isMessageTarget', () => {
  it('does not rewrite every bubble just because ids are missing', () => {
    const pending = { role: 'user', text: 'Transcribing...', timestamp: new Date() };
    const ava = { role: 'ava', text: 'How old are you?', timestamp: new Date() };
    expect(isMessageTarget(pending, pending)).toBeTrue();
    expect(isMessageTarget(ava, pending)).toBeFalse();
    expect(isMessageTarget({ ...pending }, pending)).toBeFalse();
    expect(isMessageTarget({ id: 'm-1' }, { id: 'm-1' })).toBeTrue();
    expect(isMessageTarget({ id: 'm-1' }, { id: 'm-2' })).toBeFalse();
  });
});
