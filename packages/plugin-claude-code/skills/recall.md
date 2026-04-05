---
name: engram:recall
description: Search Engram memories by query
---

Search Engram for memories matching the user's query. Use the `engram_recall` MCP tool.

When the user says `/engram:recall <query>`:
1. Call the `engram_recall` tool with the query text
2. Present the recalled memories clearly
3. If no memories match, suggest the user store relevant information with `/engram:remember`
