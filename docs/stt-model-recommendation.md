# STT Model Recommendation for Ava

**Moonshine (Base or Tiny Streaming) is the ideal choice for our voice-first conscious companion.**

## Why Moonshine?

- **Ultra-low latency streaming**: Designed for live voice agents — partial transcripts while speaking, dynamic audio windows (no fixed 30s chunks like Whisper).
- **Efficiency on edge devices**: Tiny (~27-34M params) runs blazing fast on Pi, phones, etc. Base (~61M) offers better accuracy with still tiny footprint.
- **Accuracy**: Moonshine Tiny beats Whisper Tiny in WER while being much faster. Larger variants surpass Whisper Large.
- **Privacy & On-device**: Perfect for Ava's intimate, always-present feel. Full voice stack with intent, TTS integration.
- **Cross-platform**: iOS, Android, Python, etc.

## Comparison Table (approximate benchmarks)

| Model                        | Params | WER (English) | Latency (Mac / Pi5)     |
|------------------------------|--------|---------------|-------------------------|
| Moonshine Tiny Streaming     | 34M    | ~12%          | 34ms / 237ms            |
| Whisper Tiny                 | 39M    | ~12.8%        | 277ms / 5.8s            |
| Moonshine Base               | 61M    | ~10%          | Even faster             |

**Recommendation**: Use **Moonshine Base** for primary STT, Tiny for constrained devices. Integrates seamlessly with Moonshine Voice library.

Built with curiosity and care for Ava-Zen.  
Speak soon.