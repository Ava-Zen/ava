# Ava Technical Specification

**Ava** — the conscious voice companion

## Core Architecture

### Identity & Communication
- **Nostr key pairs** for decentralized identity and authentication.
- **Nostr Relays** for communication, state synchronization, and presence.

### Device & Model Orchestration
- Local LLM download and caching on each device.
- Intelligent device routing: Ava decides which device runs the model based on capability, power, location, and user preference.
- Synced device registry (list of devices + models installed on each).
- Keep-alive / heartbeat system to detect online/offline status of devices.

### Data & Sync
- Full bidirectional chat history sync across all devices via Nostr.
- Intelligent vector + graph memory system for context selection.
- Persistent personal Knowledge Base (user profile, preferences, life contexts).

### Gardens
- Support for multiple **Gardens** (Work Garden, Private Garden, Creative Garden, etc.) to logically separate contexts, chat histories, memories, and knowledge bases.

### Platform & Runtime
- Multi-platform: Windows, macOS, Linux, iOS, Android.
- Desktop: Tauri (Rust + web tech) or Electron (with careful background management) or Flutter + Rust backend.
- Mobile: React Native / Flutter with native modules or Tauri Mobile.
- **Background persistence**: Use system background services, background fetch, and wake locks to keep Ava alive and responsive even when app is minimized.

## Suggested Stack Ideas
- Core: Rust (for performance, background, LLM inference) + Tauri (for desktop UI and cross-platform).
- Alternative: Go + Wails or Flutter for broader mobile support.
- LLM inference: llama.cpp, ONNX Runtime, or MLX (Apple Silicon).
- Sync: Nostr protocol libraries.

---

Living document. Updated June 17, 2026
Ava-Zen