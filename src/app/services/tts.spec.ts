import { TtsService } from './tts';

describe('TtsService', () => {
  it('maps Kokoro voices to bundled preview audio assets', () => {
    const service = new TtsService();

    expect(service.getKokoroPreviewAudioUrl('af_bella')).toBe('/audio/kokoro/af_bella.wav');
    expect(service.getKokoroPreviewAudioUrl('bm_george')).toBe('/audio/kokoro/bm_george.wav');
    expect(service.getKokoroPreviewAudioUrl('missing_voice')).toBe('/audio/kokoro/af_bella.wav');
  });
});
