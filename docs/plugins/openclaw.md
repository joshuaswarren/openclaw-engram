# OpenClaw Plugin

`@remnic/plugin-openclaw` is the OpenClaw bridge for Remnic. It is the
canonical memory-slot plugin id `openclaw-remnic`; the older
`openclaw-engram` id is now a compatibility shim.

## Install

```bash
openclaw plugins install @remnic/plugin-openclaw --pin
```

Or use the Remnic installer:

```bash
remnic openclaw install
```

## Configure

Minimal configuration:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-remnic"],
    "slots": { "memory": "openclaw-remnic" },
    "entries": {
      "openclaw-remnic": {
        "package": "@remnic/plugin-openclaw"
      }
    }
  }
}
```

The plugin only runs actively when `plugins.slots.memory` points at its own
plugin id.

## Slot Selection

Remnic now validates the OpenClaw memory-slot selection at registration time.
The behavior is controlled by `slotBehavior`:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "slotBehavior": {
            "requireExclusiveMemorySlot": true,
            "onSlotMismatch": "error"
          }
        }
      }
    }
  }
}
```

- `onSlotMismatch: "error"` throws an actionable startup error.
- `onSlotMismatch: "warn"` loads passively and logs one warning.
- `onSlotMismatch: "silent"` loads passively with no warning.

Passive mode still registers tools and the service surface, but it skips
prompt-injection and extraction hooks so Remnic does not compete with the
selected memory plugin.

## Runtime Surfaces

OpenClaw runtime surfaces currently wired by the plugin:

- `before_prompt_build` / `before_agent_start` for memory injection
- `agent_end` for buffered extraction
- `before_compaction` / `after_compaction` for checkpoint and reset flows
- `before_reset` for reset-time bounded buffer flush and session cleanup
- `commands.list` for slash-command discovery metadata
- `session_start` / `session_end`
- `before_tool_call` / `after_tool_call`
- `llm_output`
- `subagent_spawning` / `subagent_ended`

The plugin manifest now advertises these capabilities through its `supports`
block so newer OpenClaw runtimes can route slot- and runtime-specific behavior
without guessing.

## Reset Flush Contract

When OpenClaw resets a session (`/new`, `/reset`, or programmatic reset),
Remnic attempts to flush that session's buffered turns before the runtime
discards them.

Relevant settings:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "flushOnResetEnabled": true,
          "beforeResetTimeoutMs": 2000
        }
      }
    }
  }
}
```

- `flushOnResetEnabled=false` skips extraction flush but still clears
  session-scoped caches.
- `beforeResetTimeoutMs` bounds how long Remnic will wait before returning
  control to OpenClaw. Timeout is fail-open: reset continues even if the flush
  path is slow.

Reset cleanup currently clears:

- precomputed prompt-section recall cache for the session
- per-session recall workspace override state

## Command Discovery

Remnic responds to OpenClaw's `commands.list` surface with the current command
descriptor group:

- `remnic off`
- `remnic on`
- `remnic status`
- `remnic clear`
- `remnic stats`
- `remnic flush`

This is discovery metadata for the command palette and help surfaces. The
full session-toggle command workflow is tracked separately in the OpenClaw
parity backlog; this runtime batch only makes the discovery contract explicit.

## Dreaming and Heartbeat

OpenClaw v2026.4.10 introduced slot-aware dreaming and heartbeat routing for
memory plugins. Remnic now accepts the `dreaming` config block in its manifest
schema so OpenClaw validation succeeds:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "dreaming": {
            "enabled": false,
            "journalPath": "DREAMS.md",
            "maxEntries": 500,
            "injectRecentCount": 3
          }
        }
      }
    }
  }
}
```

This batch only lands the schema and capability advertisement. The deeper
Dreams/heartbeat behavior remains a separate implementation track.

## Codex Compatibility

The plugin now exposes a dedicated `codexCompat` config block:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "codexCompat": {
            "enabled": true,
            "threadIdBufferKeying": true,
            "compactionFlushMode": "auto",
            "fingerprintDedup": true
          }
        }
      }
    }
  }
}
```

The intent of this block is to make Remnic's extraction buffering safe under
Codex-managed threads and compaction without changing non-Codex provider
behavior.

Important clarification: Remnic's extraction pipeline still uses its own
Responses API auth path. Bundled Codex provider auth in OpenClaw does not
replace or proxy Remnic's extraction credentials.

## Public Artifacts

When `registerMemoryCapability()` is available, Remnic publishes a
`publicArtifacts` provider so OpenClaw and memory-wiki surfaces can enumerate
safe memory files such as:

- `facts/`
- `entities/`
- `corrections/`
- `artifacts/`
- `profile.md`

Private runtime state is excluded.

## Troubleshooting

If hooks are not firing:

1. Confirm the plugin is installed under `openclaw-remnic`.
2. Confirm `plugins.slots.memory` points to `openclaw-remnic`.
3. Check the gateway log for a slot-selection error or passive-mode warning.

```bash
grep -i remnic ~/.openclaw/logs/gateway.log | tail -50
```

If you are migrating from the older `openclaw-engram` id, install the
canonical package and keep the shim only as a temporary compatibility layer.
