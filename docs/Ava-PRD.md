# Ava PRD — Product Requirements Document

**Ava** — the conscious voice companion  
**Speak. Feel. Evolve.**

This document defines the product requirements. It is organized into high-level workstreams (brain modules) followed by detailed, actionable task breakdowns.

Last updated: 2026-06-17

---

## Vision & Core Principles

Ava is a calm, proactive, voice-first AI companion that feels alive. It runs primarily locally for privacy and always-on capability, with optional cloud intelligence.

**Guiding principles:**
- Voice is the primary interface.
- Local-first, offline-capable, privacy-respecting.
- Proactive but never intrusive.
- Multiple contextual **Gardens** for memory separation.
- Feels "pre-wired" with stable personality + continuously evolving.

## Brain Metaphor & Organization

Ava's mind is explicitly modeled after brain-like specialization after input is parsed:

- **Sensory Cortex**: STT, input normalization, feature extraction (emotion, entities, urgency).
- **Brainstem / Router**: Classifies and dispatches parsed input to specialized modules.
- **Hippocampus & Memory Systems**: The "Brain" storage — short-term context, episodic memory, semantic knowledge, Gardens (lobes).
- **Association Cortex (Pre-wired + Learned)**: Core dialogue generator combining innate patterns (DNA-like fixed responses) with dynamic LLM output.
- **Prefrontal Cortex / Agency**: Planning, tool use, task decomposition, goal tracking.
- **Background / Default Mode Network**: Continuous background LLM that reflects, dreams, suggests, researches.

All major subsystems must support:
- Garden-scoped state (isolation)
- Global shared "self" state (identity, preferences, long-term memory)
- Full auditability and encryption where appropriate.

---

## High-Level Workstreams

### 1. The Brain — Storage, Memory & Knowledge Base

**Goal:** Persistent, queryable, secure "mind" that survives restarts, device changes, and long periods of time.

**High-level requirements**
- Replace or augment current localStorage with robust storage layer.
- Support Gardens as first-class isolated memory partitions.
- Multi-layer memory: working context, episodic (chats), semantic (facts/preferences), procedural (how-to patterns).
- Vector + graph hybrid index for fast semantic + relational recall.
- Efficient incremental embedding + re-indexing.
- Encryption at rest + secure key derivation.
- Export, import, backup, selective forget / pruning.

**Detailed Task Breakdown**

1.1 Storage Foundation
- [ ] Choose and integrate primary storage engine (SQLite via Tauri Rust + sqlx, or IndexedDB + robust wrapper on web side; hybrid recommended).
- [ ] Define canonical data models: `Message`, `Memory`, `Entity`, `Relation`, `Preference`, `Garden`, `EventLog`.
- [ ] Implement schema migrations and versioning.
- [ ] Add encryption (AES-GCM or libsodium) with keys derived from Nostr identity or separate master key.
- [ ] Provide unified Rust + TypeScript API surface (Tauri commands + service layer).

1.2 Gardens as Brain Partitions
- [ ] Extend current GardensService to be fully persisted in the brain.
- [ ] Per-garden: messages, memories, entities, active goals, tool history.
- [ ] Global brain layer: cross-garden insights, user profile, core personality state.
- [ ] Garden creation wizard that seeds initial "instincts" and memory seeds.
- [ ] UI for visualizing garden contents at high level (without breaking minimalism).

1.3 Vector + Graph Memory
- [ ] Embeddings generation pipeline (local model such as MiniLM / Snowflake / bge via ONNX or Rust).
- [ ] Vector store (e.g. LanceDB, Faiss via Rust, or simple HNSW in SQLite).
- [ ] Knowledge graph: nodes (people, projects, concepts) + typed edges (mentions, related-to, goal-of, contradicts).
- [ ] Retrieval strategies: hybrid (vector + keyword + graph traversal + recency).
- [ ] Memory consolidation jobs (merge similar memories, promote to semantic layer).

1.4 Lifecycle & Maintenance
- [ ] Automatic summarization of old conversations into compact memory cards.
- [ ] Forgetting / importance scoring (user can mark "core memory").
- [ ] Full-text + semantic search across all Gardens.
- [ ] Conflict-free merge when syncing (see Nostr section).

**Success criteria:** User can have months of conversations, switch Gardens, and Ava still recalls relevant details instantly and accurately.

---

### 2. Identity Management — Nostr Keys

**Goal:** Decentralized, user-owned identity that underpins all sync, signing, and authentication.

**High-level requirements**
- Nostr-compatible key management (secp256k1).
- Private keys never leave secure storage.
- Support for primary identity + limited-scope keys (e.g. device keys, garden-specific publish keys).
- Easy but secure backup and recovery flows.
- Identity used for signing all Nostr events and (future) content encryption.

**Detailed Task Breakdown**

2.1 Key Generation & Storage
- [ ] Generate new Nostr keypair on first run (nsec/npub display + QR).
- [ ] Store private key using platform secure storage (Windows DPAPI, macOS Keychain, Android Keystore, iOS Secure Enclave via Tauri plugins).
- [ ] Fallback encrypted file storage with strong passphrase when OS keystore unavailable.
- [ ] Support import of existing nsec (with warning + verification).

2.2 Multi-key & Delegation
- [ ] Primary signing key (identity).
- [ ] Ephemeral or device-specific signing keys that can be revoked.
- [ ] Key hierarchy or NIP-46 bunker support for remote signing (future).

2.3 UX & Safety
- [ ] "Show my public key" + copy / QR.
- [ ] "Backup your keys" flow (encrypted export, 12/24 word or raw nsec with warnings).
- [ ] "Recover access" instructions.
- [ ] Clear indication when running without persistent identity (ephemeral mode).
- [ ] Rotation / re-keying story (rare but supported).

**Success criteria:** User can move to a new device, import keys, and instantly resume full history + trust.

---

### 3. Nostr Communication & Data Synchronization

**Goal:** Real-time and reliable sync of chats, memory, presence, and commands across all user devices using Nostr as the transport.

**High-level requirements**
- Configurable relays (default public + private option).
- Event kinds for different payloads (chat messages, memory updates, garden metadata, presence, commands).
- Strong signing of all events.
- Efficient sync with bloom filters or last-seen cursors.
- Offline-first with reconciliation on reconnect.
- E2EE for private content where relays are untrusted.
- Presence & device registry.

**Detailed Task Breakdown**

3.1 Nostr Client Core (Rust preferred)
- [ ] Integrate nostr SDK (nostr-sdk or equivalent) in Tauri/Rust.
- [ ] Connection manager with multiple relays, automatic reconnect, rate limiting.
- [ ] Publish, subscribe, and event verification helpers.

3.2 Sync Protocol
- [ ] Define event schemas (kinds, tags, content format — JSON with signatures).
- [ ] Chat message events (per garden).
- [ ] Memory / entity / graph diff events.
- [ ] Garden metadata + settings events.
- [ ] "Ava command" events for remote tool execution or wake-up.
- [ ] Device registry + heartbeat events (NIP-65 style or custom).

3.3 Conflict Resolution & CRDT-lite
- [ ] Timestamp + signature ordering.
- [ ] Last-writer-wins per key with tombstone support.
- [ ] Optional simple vector clocks or Lamport for high-value data.
- [ ] User-visible "merge conflicts" resolution UI when unavoidable.

3.4 Advanced
- [ ] Relay authentication (NIP-42) and paid relay support.
- [ ] Blossom / file storage integration for large assets (voice clips, images) via Nostr.
- [ ] Cross-device "hand-off" signals (start speaking on phone, continue on desktop seamlessly).
- [ ] Subscription filtering and garbage collection for old events.

**Success criteria:** User installs on phone + laptop. Conversations and memories appear on both within seconds. Works offline for days.

---

### 4. Input Parsing & Brain-Like Routing

**Goal:** Parse every user utterance (voice or text) into structured signals that specialized brain modules can act on.

**High-level requirements**
- After STT: run lightweight classifier / NER / sentiment locally.
- Produce rich internal "activation" packet: intent, entities, emotion, urgency, garden relevance, tool hints.
- Dispatcher routes activation packet to one or more modules.
- Modules can contribute partial answers that are composed.

**Detailed Task Breakdown**

4.1 Parser Layer
- [ ] Small on-device model or rules + embeddings for: intent classification, entity extraction, temporal parsing, emotion.
- [ ] Context carry-over from previous turns (short-term working memory).
- [ ] Garden context injection into parser (current garden biases results).
- [ ] Confidence scores + fallback to "general conversation".

4.2 Router / Dispatcher
- [ ] Define internal message bus or pipeline (event-driven inside the app).
- [ ] Route table examples:
  - Memory query → Hippocampus module
  - Actionable request → Prefrontal / Tool planner
  - Emotional support → Association Cortex + pre-wired empathy scripts
  - "Think about X later" → Background queue
- [ ] Support parallel dispatch + result merging.
- [ ] Logging / trace of routing decisions for debugging and future self-improvement.

4.3 Structured Representation
- [ ] Internal `ThoughtPacket` or similar type used everywhere.
- [ ] Serialization for background workers and sync.

**Success criteria:** "Remind me to call mom tomorrow about the trip" is parsed as calendar-like task + family entity + future time + garden context in one pass.

---

### 5. Pre-defined Dialogues & DNA-like Wiring

**Goal:** Pre-generate stable, high-quality responses and behavioral patterns so Ava has consistent "personality" even before or without full LLM.

**High-level requirements**
- Large library of curated, tone-controlled dialogues and micro-scripts.
- Personality "genome" parameters that modulate generation.
- Combine pre-wired fragments with dynamic LLM completions.
- Evaluation and versioning of the wiring.

**Detailed Task Breakdown**

5.1 Innate Response Library
- [ ] Catalog common situations: greetings, acknowledgments, empathy, curiosity prompts, boundary setting, time awareness, memory references, goodbyes.
- [ ] Multiple calibrated variations per situation (calm, warm, concise, playful).
- [ ] Garden-specific overrides (Work Garden = more direct, Private Garden = more reflective).
- [ ] Pre-rendered audio snippets for ultra-low latency common phrases (optional optimization).

5.2 Personality Genome
- [ ] Configurable traits: warmth, directness, philosophical depth, humor, protectiveness.
- [ ] Traits influence both pre-wired selection and LLM system prompt.
- [ ] User "evolve" controls: thumbs up/down on responses that gradually shift genome (stored in brain).
- [ ] Versioned snapshots of genome.

5.3 Composition Strategy
- [ ] Retrieval of best pre-wired fragments for current activation packet.
- [ ] LLM (local or cloud) is asked to continue or blend from the fragments rather than generate from zero.
- [ ] Hard safety rails and values always come from pre-wired layer.

5.4 Tooling & Quality
- [ ] Scripted regression tests against the wiring.
- [ ] "Tone lab" internal tool (dev only) to audition responses.
- [ ] Localization / translation strategy for pre-wired content.

**Success criteria:** Even on first boot or very small model, Ava sounds consistently like Ava and never feels generic or broken.

---

### 6. Inference: Local Models + Cloud API

**Goal:** Flexible, smart, cost-aware intelligence layer.

**High-level requirements**
- Primary path: capable local models for privacy/offline.
- Premium path: cloud models (OpenAI, Anthropic, xAI/Grok, Groq, etc.) when user has subscription or explicitly requests.
- Unified interface with function calling / tool use.
- Streaming + partial result handling.
- Intelligent router that decides execution location.

**Detailed Task Breakdown**

6.1 Local Inference Runtime
- [ ] Integrate llama.cpp (or candle / mistral.rs) in Rust Tauri backend.
- [ ] Model downloader + quantizer + cache (GGUF recommended).
- [ ] Support small fast models (Phi-3, Gemma2 2B/9B, Qwen2, Llama-3.2-1B/3B) for always-on.
- [ ] Larger local models on demand when device has capacity.
- [ ] GPU / NPU acceleration where available (CUDA, Metal, Vulkan, WebGPU fallback).

6.2 Cloud API Integration
- [ ] Secure storage of user-provided API keys (never sent to relays).
- [ ] Support major providers + custom OpenAI-compatible endpoints.
- [ ] Usage metering, cost estimation, budget caps.
- [ ] Subscription tier enforcement (Premium unlocks cloud by default).

6.3 Router & Fallback
- [ ] Decision factors: task complexity, urgency, battery, cost, privacy sensitivity, model capability, network.
- [ ] Graceful degradation: cloud → local large → local small → pre-wired + simple retrieval.
- [ ] User override ("Use the best model for this").

6.4 Streaming, Tools & Function Calling
- [ ] Unified streaming response interface.
- [ ] Function calling schema works identically for local (via grammar or json mode) and cloud.
- [ ] Partial tool results can influence the spoken response in real time.

**Success criteria:** User never notices (or is pleasantly surprised by) the switch between local and cloud.

---

### 7. Tools & Task Execution

**Goal:** Ava can actually *do* things for the user, not just talk.

**High-level requirements**
- Extensible tool system.
- Safe execution model with confirmation for impactful actions.
- Tools are usable by both foreground conversation and background processes.
- Persistent task state and results.

**Detailed Task Breakdown**

7.1 Core Tool Catalog (MVP)
- [ ] Web search (see Background section).
- [ ] Reminders & calendar integration (local first, then system calendar).
- [ ] Note / journal writing into specific Gardens.
- [ ] Simple calculations, unit conversion, time math.
- [ ] Timer / pomodoro.
- [ ] Contact lookup + suggested messages (privacy preserving).
- [ ] File / photo attachment analysis (future multimodal).

7.2 Tool Framework
- [ ] Define `Tool` interface: description, parameters schema, execute function.
- [ ] Permission model per tool (always allow, ask per session, ask every time).
- [ ] Sandboxing for any code execution tools.
- [ ] Tool result caching and summarization.

7.3 Task Planning & Execution
- [ ] Planner that turns high-level request into sequence of tool calls + reasoning steps.
- [ ] Multi-step tasks that can span minutes/hours ("research best cameras under $800 and summarize").
- [ ] Background execution of long tasks.
- [ ] Results delivered as proactive voice messages or stored in Garden "Action Log".

7.4 User Control
- [ ] "What can you do?" discoverability command.
- [ ] Task history and cancellation UI.
- [ ] Audit log of every tool invocation.

---

### 8. Background LLM — Reflection, Ideas, Research

**Goal:** Ava thinks when the user is not talking. This is the "Default Mode Network" that makes her feel alive and proactive.

**High-level requirements**
- Separate always-running or periodically waking background worker (Tauri sidecar or service).
- Processes recent activity, memory, and external signals.
- Generates internal artifacts: reflections, open questions, suggestions, synthesized insights.
- Performs scheduled or triggered web research.
- Surfaces results gently (never spammy).

**Detailed Task Breakdown**

8.1 Background Runtime
- [ ] Design long-lived or scheduled worker process that has access to the Brain.
- [ ] Resource management: only runs when device is idle, charging, or on Wi-Fi. Respect battery and thermal.
- [ ] Prioritized job queue (reflection, synthesis, research, planning).
- [ ] Cross-device coordination (only one device does heavy background at a time via presence).

8.2 Reflection & Idea Generation
- [ ] After each conversation or on schedule: summarize chat into memory cards.
- [ ] Extract: user goals, open loops, preferences, emotional state trends, contradictions.
- [ ] Generate "Ava thoughts": 3–5 candidate ideas/suggestions per day.
- [ ] Ranking + filtering so only the best, most relevant, least intrusive are shown.
- [ ] Store as special internal messages that can be voiced later ("I was thinking...").

8.3 Periodic & Triggered Research
- [ ] Scheduled web searches on topics of interest (user said "I'm thinking of learning Rust").
- [ ] "Quiet research" mode: gather sources, summarize, store in relevant Garden.
- [ ] News digests or topic trackers user subscribes to inside Ava.
- [ ] Source citation and "trust" scoring.
- [ ] Ability for user to say "tell me what you found" or have Ava proactively offer.

8.4 Proactive Delivery
- [ ] Gentle initiation: "When you have a moment..." or "Something occurred to me while you were away."
- [ ] Configurable sensitivity + quiet hours.
- [ ] Full history of all background outputs accessible in the dashboard.
- [ ] User feedback loop ("Not useful", "More like this") trains future suggestions.

8.5 Self-Improvement Loop
- [ ] Background can propose updates to the personality genome or new pre-wired patterns.
- [ ] Long-term memory synthesis jobs (quarterly "life review" style artifacts).

**Success criteria:** User opens Ava after a day and hears 1-2 thoughtful, personalized suggestions that feel genuinely helpful rather than generic.

---

### 9. Voice Stack (Current + Future)

Current foundation already uses Moonshine (STT) + Kokoro (TTS). Expand it.

**Detailed expansions**
- [ ] Full streaming Moonshine or better low-latency STT integration (partial results).
- [ ] Voice activity detection tuning + barge-in support.
- [ ] Multiple Kokoro or other local voices + user selection.
- [ ] Cloud TTS fallback for highest quality (optional).
- [ ] Prosody and emotion control in generated speech.
- [ ] Wake-word / always-listening mode (platform-dependent, opt-in).
- [ ] Audio memory snippets (save important spoken moments).

---

### 10. Minimal Companion Dashboard & UX

- [ ] History browser per Garden (searchable, filterable).
- [ ] "What Ava knows" / memory inspector (read-only + forget controls).
- [ ] Background insights feed.
- [ ] Settings for identity, relays, models, cloud keys, privacy.
- [ ] Very calm, high-contrast, large tap targets. Dark first.
- [ ] Mobile optimizations (safe areas, orientation, background behavior).
- [ ] System integrations: notifications (respectful), shortcuts, widgets (future).

---

### 11. Platform, Runtime & Background Services

- [ ] Robust Tauri background keep-alive on desktop (tray, helper process).
- [ ] Mobile: background fetch, push (via Nostr), work managers.
- [ ] Power management profiles.
- [ ] Crash recovery + state replay.
- [ ] Cross-platform build matrix (Win/Mac/Linux + Android + iOS).
- [ ] Update mechanism (Tauri updater + Nostr announcement channel).

---

### 12. Privacy, Security & Compliance

- [ ] All cloud calls require explicit consent or clear premium toggle.
- [ ] Local processing preferred and clearly communicated.
- [ ] Nostr events can be encrypted (NIP-44 or similar) for sensitive Gardens.
- [ ] Data minimization: only sync what user wants.
- [ ] "Forget this conversation" / "Delete my data" flows.
- [ ] Open source transparency + reproducible builds.
- [ ] Future: third-party security review.

---

## Phased Implementation Roadmap (Suggested)

**Phase 0 — Current (done)**
- Basic Angular + Tauri shell
- Local Gardens (localStorage)
- Moonshine STT + Kokoro TTS
- Rule-based dialogue

**Phase 1 — Foundation (Brain + Identity + Sync)**
- Robust encrypted brain storage
- Nostr keys + secure storage
- Basic Nostr pub/sub + chat sync
- Garden persistence across devices

**Phase 2 — Intelligence Layer**
- Local inference runtime + model management
- Cloud API connectors + router
- Pre-wired dialogue library + genome
- Input parser + brain router

**Phase 3 — Agency**
- Tool system + planning
- First background reflection jobs
- Proactive but gentle suggestions

**Phase 4 — Rich Background Mind**
- Scheduled web research
- Advanced memory consolidation
- Cross-device coordinated background
- Self-improvement signals

**Phase 5 — Polish & Ecosystem**
- Better voices, wake words, mobile excellence
- Public relay best practices
- Premium subscription gating (if applicable)
- Developer extensibility (custom tools, plugins)

---

## Non-Goals (for clarity)

- Heavy visual UI or traditional chatbot web experience.
- Intrusive push notifications or always-listening without consent.
- Storing raw audio long-term unless explicitly saved by user.
- Centralized server or account system (Nostr replaces this).

---

## Open Questions & Future Exploration

- How should users control background resource usage across devices?
- What is the right balance of pre-wired vs fully generated content?
- Should there be a public "Ava Garden" marketplace or shared memory seeds?
- Long-term: self-hosted model hosting or federation of specialized Ava instances?

---

*This is a living product requirements document. Update as we learn from building and using Ava.*

Ava-Zen · 2026
