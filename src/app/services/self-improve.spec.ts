import {
  buildSelfImproveFollowUp,
  buildSelfImprovePrompt,
  buildSelfImproveSetupSpeech,
  grokCliInstallCommand,
  type SelfImproveStatus,
} from './self-improve';

function status(overrides: Partial<SelfImproveStatus> = {}): SelfImproveStatus {
  return {
    desktop: true,
    fromCheckout: false,
    customized: false,
    armed: false,
    sourcePath: '',
    pristinePath: '',
    liveExe: '',
    originalExe: '',
    os: 'windows',
    node: true,
    npm: true,
    cargo: true,
    ready: true,
    missing: [],
    tools: [],
    grokInstallUrl: 'https://x.ai/cli',
    grokInstallCommand: 'irm https://x.ai/cli/install.ps1 | iex',
    message: '',
    ...overrides,
  };
}

describe('buildSelfImprovePrompt', () => {
  it('asks Grok to compile, speak, and hand off restart', () => {
    const prompt = buildSelfImprovePrompt('changing the color of the Pause button');
    expect(prompt).toContain('changing the color of the Pause button');
    expect(prompt).toContain('npm run build');
    expect(prompt).toContain('cargo check');
    expect(prompt).toContain('speak');
    expect(prompt).toContain('self_improve_ready');
    expect(prompt).toContain('Stay in this workspace');
  });

  it('keeps follow-ups on the same protocol', () => {
    const prompt = buildSelfImproveFollowUp('how you visualize memory');
    expect(prompt).toContain('how you visualize memory');
    expect(prompt).toContain('self_improve_ready');
    expect(prompt).toContain('compile must pass');
  });
});

describe('buildSelfImproveSetupSpeech', () => {
  it('on first ask explains Grok install when the CLI is missing', () => {
    const spoken = buildSelfImproveSetupSpeech({
      grokPhase: 'setup',
      status: status(),
      firstTime: true,
    });
    expect(spoken).toContain('Grok CLI');
    expect(spoken).toContain('irm https://x.ai/cli/install.ps1 | iex');
    expect(spoken).toContain('sign in');
    expect(spoken).toContain('opened the setup');
  });

  it('asks for Grok sign-in when the CLI is present', () => {
    const spoken = buildSelfImproveSetupSpeech({
      grokPhase: 'signed-out',
      status: status(),
      firstTime: true,
    });
    expect(spoken).toContain('Sign in with Grok');
    expect(spoken.toLowerCase()).not.toContain('not installed');
  });

  it('lists missing compile tools with install commands', () => {
    const spoken = buildSelfImproveSetupSpeech({
      grokPhase: 'ready',
      status: status({
        ready: false,
        missing: ['Node.js', 'Rust'],
        tools: [
          {
            id: 'node',
            label: 'Node.js',
            present: false,
            installUrl: 'https://nodejs.org/en/download',
            installCommand: '',
            detail: 'Download the LTS installer.',
          },
          {
            id: 'cargo',
            label: 'Rust',
            present: false,
            installUrl: 'https://rustup.rs/',
            installCommand: 'irm https://win.rustup.rs | iex',
            detail: 'Install rustup.',
          },
        ],
      }),
      firstTime: true,
    });
    expect(spoken).toContain('https://nodejs.org/en/download');
    expect(spoken).toContain('irm https://win.rustup.rs | iex');
  });

  it('keeps later asks shorter', () => {
    const spoken = buildSelfImproveSetupSpeech({
      grokPhase: 'setup',
      status: status(),
      firstTime: false,
    });
    expect(spoken).toContain('Grok CLI');
    expect(spoken).not.toContain('To change myself I need');
    expect(spoken).not.toContain('opened the setup');
  });
});

describe('grokCliInstallCommand', () => {
  it('uses the official Windows installer', () => {
    expect(grokCliInstallCommand('windows')).toContain('install.ps1');
  });

  it('uses the official Unix installer', () => {
    expect(grokCliInstallCommand('macos')).toContain('install.sh');
  });
});
