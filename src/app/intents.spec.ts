import { AVA_CAPABILITIES_REPLY, isAskingCapabilities, isAskingForTime } from './intents';

describe('isAskingForTime', () => {
  it('matches genuine current-time questions', () => {
    expect(isAskingForTime('What time is it')).toBeTrue();
    expect(isAskingForTime("what's the time?")).toBeTrue();
    expect(isAskingForTime('what is the time')).toBeTrue();
    expect(isAskingForTime('tell me the time')).toBeTrue();
    expect(isAskingForTime('Hey Ava, what time is it?')).toBeTrue();
    expect(isAskingForTime('Hi, what time is it')).toBeTrue();
    expect(isAskingForTime("Hey, what's the time")).toBeTrue();
    expect(isAskingForTime('Can you tell me the time please')).toBeTrue();
    expect(isAskingForTime('what time is it in Tokyo')).toBeTrue();
    expect(isAskingForTime('what time is it now')).toBeTrue();
    expect(isAskingForTime('current time')).toBeTrue();
    expect(isAskingForTime('time')).toBeTrue();
  });

  it('ignores sentences that only mention time', () => {
    expect(isAskingForTime("I don't have time for this")).toBeFalse();
    expect(isAskingForTime('once upon a time')).toBeFalse();
    expect(isAskingForTime("it's time to go")).toBeFalse();
    expect(isAskingForTime('what time is the meeting')).toBeFalse();
    expect(isAskingForTime('what time should we leave')).toBeFalse();
    expect(isAskingForTime('sometimes I feel tired')).toBeFalse();
    expect(isAskingForTime('next time we talk')).toBeFalse();
    expect(isAskingForTime('do you have time to talk')).toBeFalse();
    expect(isAskingForTime('I spent a lot of time on this')).toBeFalse();
    expect(isAskingForTime('how much time do we have')).toBeFalse();
  });
});

describe('isAskingCapabilities', () => {
  it('matches questions about what Ava can do', () => {
    expect(isAskingCapabilities('What can you do')).toBeTrue();
    expect(isAskingCapabilities('what can Ava do?')).toBeTrue();
    expect(isAskingCapabilities('How can you help me')).toBeTrue();
    expect(isAskingCapabilities('what are you capable of')).toBeTrue();
    expect(isAskingCapabilities('tell me what you can do')).toBeTrue();
    expect(isAskingCapabilities('Hey Ava, what can you do?')).toBeTrue();
    expect(isAskingCapabilities('Hi, what can you do')).toBeTrue();
    expect(isAskingCapabilities('Hello, what can you do?')).toBeTrue();
    expect(isAskingCapabilities('Hi Ava, tell me what you can do')).toBeTrue();
    expect(isAskingCapabilities('what can I ask you')).toBeTrue();
    expect(AVA_CAPABILITIES_REPLY.toLowerCase()).toContain('weather');
  });

  it('ignores unrelated questions that mention doing something', () => {
    expect(isAskingCapabilities('what can you do about this error')).toBeFalse();
    expect(isAskingCapabilities('I can do this')).toBeFalse();
    expect(isAskingCapabilities('what do you do with the files')).toBeFalse();
  });
});
