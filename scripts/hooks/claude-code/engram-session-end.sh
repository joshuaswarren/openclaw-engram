#!/usr/bin/env bash
# Claude Code SessionEnd hook: final flush of remaining transcript messages into Engram.
#
# Fires when the session actually exits. Sends any messages not yet observed
# (since the last Stop cursor), then cleans up the cursor file.
#
# Required env vars:
#   OPENCLAW_ENGRAM_ACCESS_TOKEN  — bearer token for the Engram REST API
#
# Optional env vars:
#   ENGRAM_HOST  — defaults to 127.0.0.1
#   ENGRAM_PORT  — defaults to 4318

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/observe"

LOG="${HOME}/.claude/logs/engram-session-store.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

INPUT="$(cat)"
SESSION_ID="$(echo "$INPUT"       | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(echo "$INPUT"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || echo "")"
CWD="$(echo "$INPUT"              | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

# Return immediately
echo '{}'

[ -z "$ENGRAM_TOKEN" ] && exit 0
[ -z "$SESSION_ID" ] && exit 0
[ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ] && exit 0

CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
LOCK_FILE="/tmp/engram-lock-${SESSION_ID}"

(
  # Acquire exclusive lock to prevent races with any in-flight Stop observe job.
  exec 9>"$LOCK_FILE"
  flock -x 9

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

  rm -f "$CURSOR_FILE"

  if [ -z "$PAYLOAD" ]; then
    log "session-end[$SESSION_ID]: parse failed"
    exit 0
  fi

  if echo "$PAYLOAD" | grep -q "^CURSOR:"; then
    log "session-end[$SESSION_ID]: no new messages at exit"
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

  log "session-end[$SESSION_ID]: flushing $NEW_MSG_COUNT remaining messages (cursor $LAST_COUNT→$NEW_COUNT)"

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
    log "session-end[$SESSION_ID]: flush OK — $RESULT"
  else
    log "session-end[$SESSION_ID]: flush failed (curl=$CURL_EXIT http=$HTTP_STATUS)"
  fi
) >> "$LOG" 2>&1 &

disown $!
exit 0
