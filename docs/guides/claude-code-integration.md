# Claude Code Integration

Engram integrates with Claude Code via four session hooks that automatically recall memories at session start, inject relevant context before each turn, store session content incrementally after each turn, and flush remaining content at session end. This gives every Claude Code session (and Codex) access to the same cross-project memory that OpenClaw gateway sessions use.

## How It Works

```
SessionStart hook           UserPromptSubmit hook        Stop hook (per turn)       SessionEnd hook
      │                             │                           │                          │
      ▼                             ▼                           ▼                          ▼
engram-session-recall.sh   engram-user-prompt-recall.sh  engram-session-store.sh  engram-session-end.sh
      │                             │                           │                          │
      ▼                             ▼                           ▼                          ▼
POST /recall                 POST /recall                 POST /observe             POST /observe
(auto mode, 45s)             (minimal mode, 20s)          (incremental, bg)         (final flush, bg)
      │                             │                           │                          │
      ▼                             ▼                           ▼                          ▼
additionalContext            additionalContext             cursor advanced           cursor cleaned up
(before turn 1)             (before each turn)            (new msgs only)           (remaining msgs)
```

**SessionStart** (`engram-session-recall.sh`): Fires when a session opens. Queries Engram with the project name in `auto` mode, injecting matched memories as `additionalContext`. Claude sees relevant cross-project context before the first message.

**UserPromptSubmit** (`engram-user-prompt-recall.sh`): Fires synchronously before every user message. Uses the actual prompt text as the recall query (`minimal` mode, up to 20s). Injects results as `additionalContext` so Claude has relevant memories at the moment they're needed — not just at session start. Short prompts (<4 words) are skipped.

**Stop** (`engram-session-store.sh`): Fires after every assistant turn (not just on exit). Reads new messages from the transcript since the last observed cursor position and POSTs only the delta to `/engram/v1/observe` in the background. Advances the cursor on success. Never blocks Claude.

**SessionEnd** (`engram-session-end.sh`): Fires when the session actually exits. Sends any messages not yet observed (since the last Stop cursor), then cleans up the cursor file.

## Setup

### 1. Ensure the Engram REST API is running

The Engram HTTP server runs inside the OpenClaw gateway process on port `4318` by default. If you're running Engram standalone, see [standalone-server.md](./standalone-server.md).

Verify it's up:

```bash
curl -s http://127.0.0.1:4318/engram/v1/health \
  -H "Authorization: Bearer $OPENCLAW_ENGRAM_ACCESS_TOKEN"
```

### 2. Set the access token

The hooks read `OPENCLAW_ENGRAM_ACCESS_TOKEN` from the environment. This must be set in whichever environment Claude Code launches from.

**For terminal sessions** — add to your shell profile (`~/.zshrc`, `~/.bashrc`):

```bash
export OPENCLAW_ENGRAM_ACCESS_TOKEN="<your-token>"
```

This works when you launch Claude Code or Codex from a terminal that sources your profile.

**If Claude Code is launched from the Dock, Spotlight, or a desktop shortcut** — those apps don't inherit shell profile variables. Set the variable in the user's launchd session environment instead:

```bash
# Set immediately (lost on next logout):
launchctl setenv OPENCLAW_ENGRAM_ACCESS_TOKEN "your-token"

# Persist across logins: add to ~/.zprofile (loaded by macOS login shells):
echo 'export OPENCLAW_ENGRAM_ACCESS_TOKEN="your-token"' >> ~/.zprofile
```

> **Note:** Adding the token to the OpenClaw *gateway* plist only sets it for the gateway process — hook scripts run inside Claude Code / Codex, not inside the gateway, so the gateway plist alone is not sufficient.

To find your token, check the gateway plist or run:

```bash
grep -i "engram.*token\|token.*engram" ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### 3. Install the hook scripts

The four scripts are included in this repository under `scripts/hooks/claude-code/`. Copy them to `~/.claude/scripts/`:

```bash
mkdir -p ~/.claude/scripts
cp scripts/hooks/claude-code/engram-session-recall.sh \
   scripts/hooks/claude-code/engram-user-prompt-recall.sh \
   scripts/hooks/claude-code/engram-session-store.sh \
   scripts/hooks/claude-code/engram-session-end.sh \
   ~/.claude/scripts/
```

Make them executable:

```bash
chmod +x ~/.claude/scripts/engram-session-recall.sh \
         ~/.claude/scripts/engram-user-prompt-recall.sh \
         ~/.claude/scripts/engram-session-store.sh \
         ~/.claude/scripts/engram-session-end.sh
```

### 4. Wire the hooks in `~/.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/scripts/engram-session-recall.sh"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/scripts/engram-user-prompt-recall.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/scripts/engram-session-store.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/scripts/engram-session-end.sh"
          }
        ]
      }
    ]
  }
}
```

## What Gets Stored

The store hook extracts **text content only** from the session transcript:

- User messages (full text)
- Assistant messages (text blocks only — thinking blocks, tool calls, and tool results are excluded)

This gives Engram clean, high-signal content for extraction. The extraction pipeline then identifies:

- Bug fixes and solutions
- Project-specific patterns and conventions
- Decisions and their rationale
- Repeated errors and how they were resolved
- Configuration gotchas

These become cross-project memories available in future sessions, including sessions on unrelated projects when the pattern is relevant.

## What Gets Recalled

At session start, the recall hook queries Engram with a prompt based on the project directory name:

> "Starting a new coding session in project: `<project>`. Recall relevant memories, preferences, decisions, patterns, and context about this project and the user's coding style."

Engram uses hybrid BM25 + vector search (via QMD) and returns the most relevant memories as injected context. The context appears before the first user turn.

Recall uses `auto` mode (full recall, 45s timeout) with fallback to `minimal` mode (8 results, 20s timeout) if the server is slow.

## Logs

All scripts log to `~/.claude/logs/`:

```bash
tail -f ~/.claude/logs/engram-session-recall.log      # SessionStart recall
tail -f ~/.claude/logs/engram-user-prompt-recall.log   # per-turn recall
tail -f ~/.claude/logs/engram-session-store.log        # Stop + SessionEnd store
```

Example session-recall log:
```
2026-03-22 14:01:10 session-recall fired: session=abc123 project=openclaw-engram
2026-03-22 14:01:10 attempting full recall (auto mode)...
2026-03-22 14:01:32 recall complete: [Engram Memory Recall — 9 memories, auto mode]
```

Example user-prompt-recall log:
```
2026-03-22 14:05:22 user-prompt-recall: session=abc123 project=openclaw-engram words=12
2026-03-22 14:05:30 recall done: 5 memories injected
```

Example session-store log (incremental per turn + final flush):
```
2026-03-22 16:30:55 stop[abc123]: observing 8 new messages (cursor 0→8) project=openclaw-engram
2026-03-22 16:30:58 stop[abc123]: observe OK — accepted=8 lcm=True extraction=True
2026-03-22 16:45:12 stop[abc123]: observing 6 new messages (cursor 8→14) project=openclaw-engram
2026-03-22 16:45:15 stop[abc123]: observe OK — accepted=6 lcm=True extraction=True
2026-03-22 17:02:01 session-end[abc123]: flushing 2 remaining messages (cursor 14→16)
2026-03-22 17:02:03 session-end[abc123]: flush OK — accepted=2 lcm=True extraction=True
```

## Cross-Project Memory Flow

The key benefit is that memories from one project automatically surface in other projects:

1. You fix a tricky Zod `optional().nullable()` bug in Project A
2. Engram extracts this as a memory: "Zod optional fields must use `.optional().nullable()`, not just `.optional()`"
3. In a future session on Project B, if you're working with Zod schemas, Engram recalls this pattern
4. Claude sees it in `additionalContext` before you even ask about it

This works because Engram's recall is query-based across all stored memories regardless of which project produced them.

## Codex CLI Integration

Codex uses the same three-phase pattern but with three hooks instead of four — Codex has no `SessionEnd` event. The `Stop` hook detects final session exit via `stop_hook_active: false` and handles cursor cleanup then.

### Hook Architecture

```
SessionStart hook           UserPromptSubmit hook        Stop hook
      │                             │                        │
      ▼                             ▼                        ▼
engram-session-recall.sh   engram-user-prompt-recall.sh  engram-session-store.sh
      │                             │                        │
      ▼                             ▼                        ▼
POST /recall                 POST /recall              POST /observe
(auto mode, 45s)             (minimal mode, 20s)       (incremental, bg)
      │                             │                        │
      ▼                             ▼                        ▼
additionalContext            additionalContext          cursor advanced
(before turn 1)              (before each turn)        (final: cursor cleaned up)
```

**Key differences from Claude Code:**

- Three hooks only — no `SessionEnd`. The `Stop` hook detects `"stop_hook_active": false` to identify the final turn and clean up the cursor file then.
- Default `ENGRAM_HOST` should point to your Engram server (e.g. a Tailscale IP if Codex runs on a different machine than the one hosting the gateway), rather than `127.0.0.1`.
- Hook output uses `hookEventName` field in `hookSpecificOutput`: `{ "hookEventName": "SessionStart", "additionalContext": "..." }`.

### Setup

The three scripts are included in this repository under `scripts/hooks/codex/`. Copy them to `~/.codex/scripts/`:

```bash
mkdir -p ~/.codex/scripts
cp scripts/hooks/codex/engram-session-recall.sh \
   scripts/hooks/codex/engram-user-prompt-recall.sh \
   scripts/hooks/codex/engram-session-store.sh \
   ~/.codex/scripts/
```

Make them executable:

```bash
chmod +x ~/.codex/scripts/engram-session-recall.sh \
         ~/.codex/scripts/engram-user-prompt-recall.sh \
         ~/.codex/scripts/engram-session-store.sh
```

Wire them in `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/yourname/.codex/scripts/engram-session-recall.sh",
            "timeout": 55
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/yourname/.codex/scripts/engram-user-prompt-recall.sh",
            "timeout": 25
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/yourname/.codex/scripts/engram-session-store.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### Logs

```bash
tail -f ~/.codex/logs/engram-session-recall.log      # SessionStart recall
tail -f ~/.codex/logs/engram-user-prompt-recall.log   # per-turn recall
tail -f ~/.codex/logs/engram-session-store.log        # Stop store + final flush
```

## Environment Variables

| Variable | Default (Claude Code) | Default (Codex) | Description |
|---|---|---|---|
| `OPENCLAW_ENGRAM_ACCESS_TOKEN` | (required) | (required) | Bearer token for Engram REST API |
| `ENGRAM_HOST` | `127.0.0.1` | your-engram-server | Engram server hostname or IP |
| `ENGRAM_PORT` | `4318` | `4318` | Engram server port |

## Troubleshooting

**Recall returns no memories**: The project name in the query may not match stored memory content. Check the recall log to see the query used, then try manually recalling with a broader query via the MCP tools (`mcp__engram__engram_recall`).

**Store hook produces no output**: Check `~/.claude/logs/engram-session-store.log`. Common causes: empty transcript (session was very short), `transcript_path` not set (older Claude Code version), or server unreachable.

**Per-turn recall adding too much latency**: `UserPromptSubmit` recall uses `minimal` mode with a 20s timeout. If even that is too slow, increase the `PROMPT_WORD_COUNT` threshold in `engram-user-prompt-recall.sh` to skip more short prompts, or reduce `topK` from 8 to 4.

**Recall times out every session**: The full `auto` recall involves QMD search + LLM planning and can take 20–40 seconds. If this is consistently too slow, consider switching to `minimal` mode by default (edit `engram-session-recall.sh` and change `'mode': 'auto'` to `'mode': 'minimal'`).

**Token not found**: Run `echo $OPENCLAW_ENGRAM_ACCESS_TOKEN` in a new terminal. If empty, the variable isn't being exported from your shell profile. Add `export OPENCLAW_ENGRAM_ACCESS_TOKEN="..."` to `~/.zshrc` (not just `.zprofile` if Claude Code uses a login shell).

**Namespace-aware deployments**: The hook scripts forward the Claude/Codex `session_id` as the `sessionKey` but do not supply a namespace or principal override. On installs that use `principalFromSessionKeyRules` or other namespace routing, observe/recall will use the server's default principal and namespace. To isolate hook sessions into a specific namespace, start the Engram server with a fixed `--principal` flag that matches your desired namespace, or configure `principalFromSessionKeyRules` to match the session key pattern used by Claude Code / Codex.
