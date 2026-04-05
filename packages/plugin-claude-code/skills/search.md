---
name: engram:search
description: Full-text search across all Engram memories
---

Perform a full-text search across all stored memories. Use the `engram_lcm_search` MCP tool for deep search.

When the user says `/engram:search <query>`:
1. Call `engram_lcm_search` with the query
2. Present results grouped by relevance
3. Show memory dates and categories when available
