import {
  AVA_CAPABILITIES_REPLY,
  extractProjectHint,
  extractSelfImproveTask,
  isAddressedToAva,
  isAskingCapabilities,
  isAskingForGrokWork,
  isAskingForTime,
  isAskingToPickFolder,
  isAskingToResetSelfImprovements,
  isAskingToSelfImprove,
  isAskingToStopGrokTurn,
  isAskingToStopListening,
  isLeavingGrokWork,
} from './intents';

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

describe('isAskingForGrokWork', () => {
  it('matches spoken project work', () => {
    expect(isAskingForGrokWork('I want to do some work on my Nostria project')).toBeTrue();
    expect(extractProjectHint('I want to do some work on my Nostria project')).toBe('Nostria');
    expect(extractProjectHint("Let's work on the Nostria repo")).toBe('Nostria');
    expect(extractProjectHint('Hey Ava, work on my Nostria project')).toBe('Nostria');
    expect(isAskingForGrokWork('open grok')).toBeTrue();
    expect(isAskingForGrokWork('start a grok session')).toBeTrue();
    expect(isAskingForGrokWork('I want to start a grok session')).toBeTrue();
    expect(isAskingForGrokWork('help me code')).toBeTrue();
  });

  it('ignores casual mentions of work', () => {
    expect(isAskingForGrokWork('I work on Tuesdays')).toBeFalse();
    expect(isAskingForGrokWork('work on this')).toBeFalse();
    expect(isAskingForGrokWork('work on that')).toBeFalse();
    expect(isAskingForGrokWork('what time is it')).toBeFalse();
    expect(extractProjectHint('open grok')).toBeNull();
  });
});

describe('isLeavingGrokWork', () => {
  it('matches leaving the Grok session', () => {
    expect(isLeavingGrokWork('close grok')).toBeTrue();
    expect(isLeavingGrokWork('back to chat')).toBeTrue();
    expect(isLeavingGrokWork('stop')).toBeFalse();
    expect(isLeavingGrokWork('stop listening')).toBeFalse();
    expect(isLeavingGrokWork('stop working')).toBeFalse();
    expect(isLeavingGrokWork('fix the login')).toBeFalse();
  });
});

describe('isAskingToStopListening', () => {
  it('matches mic-off phrases, including a bare stop', () => {
    expect(isAskingToStopListening('stop')).toBeTrue();
    expect(isAskingToStopListening('stop listening')).toBeTrue();
    expect(isAskingToStopListening('mic off')).toBeTrue();
    expect(isAskingToStopListening('stop grok')).toBeFalse();
  });
});

describe('isAskingToStopGrokTurn', () => {
  it('cancels the running turn without closing the session', () => {
    expect(isAskingToStopGrokTurn('stop grok')).toBeTrue();
    expect(isAskingToStopGrokTurn('cancel that')).toBeTrue();
    expect(isAskingToStopGrokTurn('stop working')).toBeTrue();
    expect(isAskingToStopGrokTurn('stop listening')).toBeFalse();
    expect(isAskingToStopGrokTurn('close grok')).toBeFalse();
  });
});

describe('isAskingToPickFolder', () => {
  it('matches folder-picker asks', () => {
    expect(isAskingToPickFolder('choose a folder')).toBeTrue();
    expect(isAskingToPickFolder('pick the git folder')).toBeTrue();
    expect(isAskingToPickFolder('work on nostria')).toBeFalse();
  });
});

describe('isAskingToSelfImprove', () => {
  it('matches Ava-addressed self-improvement asks', () => {
    expect(isAskingToSelfImprove('Ava, improve yourself by changing the color of the Pause button')).toBeTrue();
    expect(isAskingToSelfImprove('Ava, self-improve how you visualize memory')).toBeTrue();
    expect(isAskingToSelfImprove('Hey Ava, improve yourself')).toBeTrue();
    expect(isAskingToSelfImprove('Ava self improve the memory view')).toBeTrue();
    expect(extractSelfImproveTask('Ava, improve yourself by changing the color of the Pause button')).toBe(
      'changing the color of the Pause button',
    );
    expect(extractSelfImproveTask('Ava, self-improve how you visualize memory')).toBe(
      'how you visualize memory',
    );
  });

  it('ignores asks that are not addressed to Ava or lack the trigger', () => {
    expect(isAskingToSelfImprove('Improve the button in my app')).toBeFalse();
    expect(isAskingToSelfImprove('improve yourself by changing the Pause button')).toBeFalse();
    expect(isAskingToSelfImprove('Hey Ava, improve the pause button')).toBeFalse();
    expect(isAskingToSelfImprove('work on my Ava project')).toBeFalse();
    expect(isAskingToSelfImprove('Ava, what time is it')).toBeFalse();
    expect(isAddressedToAva('Improve the button in my app')).toBeFalse();
    expect(isAddressedToAva('Ava, improve yourself')).toBeTrue();
  });
});

describe('isAskingToResetSelfImprovements', () => {
  it('matches Ava-addressed reset asks', () => {
    expect(isAskingToResetSelfImprovements('Ava, reset yourself')).toBeTrue();
    expect(isAskingToResetSelfImprovements('Ava, undo your self-improvements')).toBeTrue();
    expect(isAskingToResetSelfImprovements('Hey Ava, restore the original Ava')).toBeTrue();
  });

  it('ignores reset talk that is not this safety phrase', () => {
    expect(isAskingToResetSelfImprovements('reset yourself')).toBeFalse();
    expect(isAskingToResetSelfImprovements('Ava, reset the conversation')).toBeFalse();
    expect(isAskingToResetSelfImprovements('undo that')).toBeFalse();
  });
});
