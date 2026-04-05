---
name: engram:remember
description: Store a memory in Engram for cross-agent recall
---

Store the user's statement as a memory in Engram. Use the `engram_memory_store` MCP tool.

When the user says `/engram:remember <text>`:
1. Call the `engram_memory_store` tool with the text as the `content` parameter
2. Confirm what was stored
3. Mention that this memory is now available to all connected agents (Claude Code, Codex, Hermes, etc.)
