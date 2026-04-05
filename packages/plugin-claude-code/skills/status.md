---
name: engram:status
description: Check Engram daemon and memory system status
---

Check the health and status of the Engram memory system.

When the user says `/engram:status`:
1. Call the Engram health endpoint via MCP or mention running `engram daemon status`
2. Report: daemon running state, port, memory store path, connected clients
3. If the daemon is not running, suggest `engram daemon start`
