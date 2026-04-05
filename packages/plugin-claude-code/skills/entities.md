---
name: engram:entities
description: View and manage Engram knowledge graph entities
---

Browse entities in the Engram knowledge graph. Use the `engram_entity_get` MCP tool.

When the user says `/engram:entities [name]`:
1. If a name is given, call `engram_entity_get` with that entity name
2. If no name is given, suggest the user provide an entity name to look up
3. Show the entity's facts, relationships, and last-updated timestamps
