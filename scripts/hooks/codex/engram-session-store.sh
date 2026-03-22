#!/usr/bin/env bash
# Codex Stop hook: incrementally feed new transcript messages into Engram.
#
# Fires after every agent turn (Stop) and also on final exit (stop_hook_active=false).
# Tracks a cursor per session in /tmp/engram-cursor-<session_id> so only NEW
# messages are sent each call. When stop_hook_active is false (final stop),
# the cursor file is also cleaned up.
# Runs observe in the background — never blocks the stop.
#
# Required env vars:
#   OPENCLAW_ENGRAM_ACCESS_TOKEN  — bearer token for the Engram REST API
#
# Optional env vars:
#   ENGRAM_HOST  — defaults to 127.0.0.1 (set to your Engram server if Codex
#                  runs on a different machine than the gateway)
#   ENGRAM_PORT  — defaults to 4318

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/observe"

LOG="${HOME}/.codex/logs/engram-session-store.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT"       | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(echo "$INPUT"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || echo "")"
CWD="$(echo "$INPUT"              | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
STOP_HOOK_ACTIVE="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stop_hook_active', True))" 2>/dev/null || echo "True")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"
IS_FINAL_STOP=$( [ "$STOP_HOOK_ACTIVE" = "False" ] && echo "true" || echo "false" )

# Return immediately
echo '{}'

[ -z "$ENGRAM_TOKEN" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0
[ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ] && exit 0

CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
LOCK_FILE="/tmp/engram-lock-${SESSION_ID}"

(
  # Acquire exclusive lock to prevent overlapping observe jobs from replaying
  # the same transcript tail when Stop fires in rapid succession.
  # Uses mkdir atomicity (POSIX-portable; flock(1) is Linux-only).
  LOCK_DIR="${LOCK_FILE}.d"
  ACQUIRED=0
  for _i in $(seq 1 100); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then ACQUIRED=1; break; fi
    sleep 0.1
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM
  [ "$ACQUIRED" -eq 0 ] && exit 0

  LAST_COUNT=0
  [ -f "$CURSOR_FILE" ] && LAST_COUNT="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"

  PAYLOAD="$(python3 - "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" <<'PYEOF'
import sys, json

transcript_path = sys.argv[1]
session_id      = sys.argv[2]
last_count      = int(sys.argv[3])

def extract_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text", "").strip()
                if t:
                    parts.append(t)
        return "\n".join(parts).strip()
    return ""

all_messages = []
try:
    with open(transcript_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("type") not in ("user", "assistant"):
                continue
            msg = entry.get("message", {})
            if not isinstance(msg, dict):
                continue
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue
            text = extract_text(msg.get("content", ""))
            if text:
                all_messages.append({"role": role, "content": text})
except Exception as e:
    print(f"ERROR:{e}", file=sys.stderr)
    sys.exit(1)

total = len(all_messages)
new_messages = all_messages[last_count:]

if not new_messages:
    print(f"CURSOR:{total}")
    sys.exit(0)

print(json.dumps({"sessionKey": session_id, "messages": new_messages, "__new_count__": total}))
PYEOF
)"

  if [ -z "$PAYLOAD" ]; then
    log "stop[$SESSION_ID]: parse failed"
    [ "$IS_FINAL_STOP" = "true" ] && rm -f "$CURSOR_FILE"
    exit 0
  fi

  if echo "$PAYLOAD" | grep -q "^CURSOR:"; then
    NEW_CURSOR="$(echo "$PAYLOAD" | sed 's/CURSOR://')"
    echo "$NEW_CURSOR" > "$CURSOR_FILE"
    [ "$IS_FINAL_STOP" = "true" ] && rm -f "$CURSOR_FILE" && log "stop[$SESSION_ID]: final stop, no new messages, cursor cleaned up"
    exit 0
  fi

  NEW_COUNT="$(echo "$PAYLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('__new_count__',0))" 2>/dev/null || echo 0)"
  NEW_MSG_COUNT="$(echo "$PAYLOAD" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('messages',[])))" 2>/dev/null || echo "?")"

  CLEAN_PAYLOAD="$(echo "$PAYLOAD" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.pop('__new_count__', None)
print(json.dumps(d))
" 2>/dev/null)"

  [ -z "$CLEAN_PAYLOAD" ] && exit 0

  LABEL="stop"
  [ "$IS_FINAL_STOP" = "true" ] && LABEL="final-stop"
  log "$LABEL[$SESSION_ID]: observing $NEW_MSG_COUNT new messages (cursor $LAST_COUNT→$NEW_COUNT) project=$PROJECT_NAME"

  RAW="$(curl -s -w "\n%{http_code}" --max-time 120 \
    -X POST "$ENGRAM_URL" \
    -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$CLEAN_PAYLOAD" 2>/dev/null)"
  CURL_EXIT=$?
  HTTP_STATUS="$(echo "$RAW" | tail -1)"
  RESPONSE="$(echo "$RAW" | sed '$d')"

  if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]] && [ -n "$RESPONSE" ]; then
    RESULT="$(echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"accepted={d.get('accepted','?')} lcm={d.get('lcmArchived','?')} extraction={d.get('extractionQueued','?')}\")" 2>/dev/null || echo "$RESPONSE" | head -c 80)"
    log "$LABEL[$SESSION_ID]: observe OK — $RESULT"
    echo "$NEW_COUNT" > "$CURSOR_FILE"
    [ "$IS_FINAL_STOP" = "true" ] && rm -f "$CURSOR_FILE"
  else
    log "$LABEL[$SESSION_ID]: observe failed (curl=$CURL_EXIT http=$HTTP_STATUS) — cursor not advanced"
    [ "$IS_FINAL_STOP" = "true" ] && rm -f "$CURSOR_FILE"
  fi
) >> "$LOG" 2>&1 &

disown $!
exit 0
