#!/usr/bin/env bash
# Engram PostToolUse hook for Codex.
# Observes Bash tool executions by sending transcript delta to the
# observe endpoint. Runs in background, never blocks.

set -euo pipefail

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/observe"
TOKEN_FILE="${HOME}/.engram/tokens.json"

LOG="${HOME}/.engram/logs/engram-post-tool-observe.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [codex-post-tool] $*" >> "$LOG"; }

# Read token
ENGRAM_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  ENGRAM_TOKEN="$(node -e "
    const t = JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));
    process.stdout.write(t['codex'] || t['openclaw'] || '');
  " 2>/dev/null || echo "")"
fi
[ -z "$ENGRAM_TOKEN" ] && ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"

INPUT="$(cat)"

# Return immediately — never block the tool
echo '{"continue":true}'

[ -z "$ENGRAM_TOKEN" ] && exit 0

SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.transcript_path||'')" "$INPUT" 2>/dev/null || echo "")"
CWD="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.cwd||'')" "$INPUT" 2>/dev/null || echo "")"
TOOL_NAME="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.tool_name||'')" "$INPUT" 2>/dev/null || echo "")"
PROJECT_NAME="$(basename "$CWD" 2>/dev/null || echo "unknown")"

[ -z "$SESSION_ID" ] && exit 0
{ [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; } && exit 0

CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
LOCK_DIR="/tmp/engram-lock-${SESSION_ID}.d"

(
  # Acquire exclusive lock
  ACQUIRED=0
  for _i in $(seq 1 50); do
    if mkdir "$LOCK_DIR" 2>/dev/null; then ACQUIRED=1; break; fi
    sleep 0.1
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT INT TERM
  [ "$ACQUIRED" -eq 0 ] && exit 0

  LAST_COUNT=0
  [ -f "$CURSOR_FILE" ] && LAST_COUNT="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"

  PAYLOAD="$(node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const sessionId = process.argv[2];
    const lastCount = parseInt(process.argv[3], 10) || 0;

    const lines = fs.readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof msg.content === 'string') text = msg.content.trim();
        else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text.trim())
            .join('\n').trim();
        }
        if (text) messages.push({ role, content: text });
      } catch {}
    }

    const newMessages = messages.slice(lastCount);
    if (!newMessages.length) {
      process.stdout.write('CURSOR:' + messages.length);
    } else {
      process.stdout.write(JSON.stringify({
        sessionKey: sessionId,
        messages: newMessages,
        __total__: messages.length
      }));
    }
  " "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" 2>/dev/null)"

  [ -z "$PAYLOAD" ] && { log "parse failed for $SESSION_ID"; exit 0; }

  if echo "$PAYLOAD" | grep -q "^CURSOR:"; then
    echo "${PAYLOAD#CURSOR:}" > "$CURSOR_FILE"
    exit 0
  fi

  TOTAL="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.__total__||0))" "$PAYLOAD" 2>/dev/null || echo 0)"
  MSG_COUNT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String((d.messages||[]).length))" "$PAYLOAD" 2>/dev/null || echo "?")"
  CLEAN="$(node -e "const d=JSON.parse(process.argv[1]); delete d.__total__; process.stdout.write(JSON.stringify(d))" "$PAYLOAD" 2>/dev/null)"

  [ -z "$CLEAN" ] && exit 0

  log "observing $MSG_COUNT new messages (cursor $LAST_COUNT->$TOTAL) project=$PROJECT_NAME tool=$TOOL_NAME"

  RAW="$(curl -s -w "\n%{http_code}" --max-time 120 \
    -X POST "$ENGRAM_URL" \
    -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Engram-Client-Id: codex" \
    -d "$CLEAN" 2>/dev/null)"
  CURL_EXIT=$?
  HTTP_STATUS="$(echo "$RAW" | tail -1)"

  if [ $CURL_EXIT -eq 0 ] && [[ "$HTTP_STATUS" =~ ^2 ]]; then
    log "observe OK for $SESSION_ID"
    echo "$TOTAL" > "$CURSOR_FILE"
  else
    log "observe failed (curl=$CURL_EXIT http=$HTTP_STATUS) — cursor not advanced"
  fi
) >> "$LOG" 2>&1 &

disown $!
exit 0
