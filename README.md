# Ava — the conscious voice companion

**Speak. Feel. Evolve.**

Ava is a voice-first, privacy-respecting AI companion that runs locally with optional cloud intelligence. It is built to feel alive, proactive, and calm.

This repository contains the cross-platform client built with:

- **Tauri 2** (Rust backend) — desktop (Windows, macOS, Linux) + mobile (Android, iOS)
- **Angular 22** for the minimal, calm visual interface

## Key Principles (from specs)

- Voice-first experience (primary interface is spoken conversation)
- Local-first + optional cloud
- Privacy-first, using Nostr for sync and identity (planned)
- Multiple Gardens for contextual memory
- Background persistence and agency
- Minimal visual UI — companion dashboard for history only

See:
- [docs/Ava-Functional-Specification.md](docs/Ava-Functional-Specification.md)
- [docs/Ava-Technical-Specification.md](docs/Ava-Technical-Specification.md)

## Getting Started

### Prerequisites

- Node 20+
- Rust **stable** (use `rustup default stable` — nightly may cause dependency issues with current Tauri)
- For Android: Android SDK + NDK (the project was scaffolded with Android support)
- For iOS: macOS + Xcode (run `npm run tauri:ios:init` on a Mac)

### Install & Run (Desktop)

```bash
# install dependencies
npm install

# desktop dev
npm run tauri:dev
```

The Angular dev server runs on http://localhost:4200. Tauri wraps it.

### Mobile

```bash
# Android (after first init)
npm run tauri:android:dev

# Build production Android
npm run tauri:android:build
```

On macOS:

```bash
npm run tauri:ios:init
npm run tauri:ios:dev
```

### Build

```bash
npm run build            # Angular production build
npm run tauri:build      # Full Tauri bundles for current platform
```

## Project Structure

```
src/                 # Angular 22 app (voice UI)
src-tauri/           # Rust + Tauri configuration
  src/               # Rust entry + commands (future plugins, LLM, Nostr)
  gen/android/       # Generated Android project
  capabilities/      # Permission scopes
angular.json
tauri.conf.json      # (in src-tauri)
```

## Voice Interaction (Current)

The initial UI uses the Web Speech API (SpeechRecognition + SpeechSynthesis) for immediate cross-platform voice:

- Tap / click the central orb to speak
- Ava responds calmly with synthesized voice + on-screen history
- Works on desktop Chrome/Edge, Android Chrome, and iOS Safari (with limits)

Future: full local LLM inference (llama.cpp / MLX / ONNX), Nostr sync, device routing, persistent memory, proactive agency.

## Next Steps (aligned with Technical Spec)

- [ ] Add Nostr identity (keypair) + relay connectivity
- [ ] Local model download + inference scaffolding (Rust side)
- [ ] Background services / keep-alive
- [ ] Multiple Gardens + vector/graph memory
- [ ] Cross-device sync & presence via Nostr
- [ ] Subscription / premium cloud model routing
- [ ] Polish mobile layouts + system integrations (mic, notifications)

## License

See LICENSE. This is an early-stage project under active development.

---

Ava-Zen · 2026
