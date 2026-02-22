# Requirements & Product Specs

This directory contains requirements, product specs, and design constraints for openclaw-engram.

## Core Requirements

### Functional Requirements

1. **Persistent memory across sessions** — Agents must have access to facts, preferences, entities, and decisions from prior conversations.
2. **Automatic extraction** — Memory extraction must happen without user intervention, triggered by conversation activity.
3. **Relevant recall** — Only memories relevant to the current prompt should be injected into the agent's context.
4. **Local-first storage** — All user data must remain on the user's machine; no cloud sync or external database required.
5. **Human-readable storage** — Memory files must be readable and editable by humans without special tools.
6. **Graceful degradation** — The plugin must operate (with reduced search quality) when QMD or the OpenAI API is unavailable.

### Non-Functional Requirements

1. **Signal scan latency < 10 ms** — The per-turn signal classifier must not add measurable latency to agent responses.
2. **Extraction is asynchronous** — LLM extraction must not block agent turn completion.
3. **Token budget enforced** — Recalled memories must never exceed `maxMemoryTokens` in the injected context.
4. **No personal data in code** — Source code, tests, and commits must never contain real user data.
5. **Plugin isolation** — Engram must not interfere with other OpenClaw plugins.

### Privacy Requirements

1. Memory data (`facts/`, `entities/`, `profile.md`, etc.) must never be committed to this repository.
2. Extraction prompts must never log user message content.
3. Config examples must use placeholder values (`${OPENAI_API_KEY}`), not real credentials.

## Feature Plans

Detailed feature plans live in `docs/plans/`. Current active plans:

- [v8.2 PR17 — TMT](../plans/2026-02-22-v8.2-pr17-tmt.md)
- [v8.2 PR18 — Graph](../plans/2026-02-22-v8.2-pr18-graph.md)
- [Memory OS Roadmap](../plans/2026-02-21-engram-memory-os-roadmap.md)
