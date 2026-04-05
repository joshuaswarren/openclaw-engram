#!/usr/bin/env bash
# Engram Stop hook for Codex.
# Performs final observe flush then cleans up cursor/lock files.

set -euo pipefail

ENGRAM_HOST="${ENGRAM_HOST:-127.0.0.1}"
ENGRAM_PORT="${ENGRAM_PORT:-4318}"
ENGRAM_URL="http://${ENGRAM_HOST}:${ENGRAM_PORT}/engram/v1/observe"
TOKEN_FILE="${HOME}/.engram/tokens.json"

LOG="${HOME}/.engram/logs/engram-codex-session-end.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [codex-stop] $*" >> "$LOG"; }

ENGRAM_TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  ENGRAM_TOKEN="$(node -e "
    const t = JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8'));
    process.stdout.write(t['codex'] || t['openclaw'] || '');
  " 2>/dev/null || echo "")"
fi
[ -z "$ENGRAM_TOKEN" ] && ENGRAM_TOKEN="${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}"

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.transcript_path||'')" "$INPUT" 2>/dev/null || echo "")"

echo '{"continue":true}'

# Final observe flush if we have transcript
if [ -n "$ENGRAM_TOKEN" ] && [ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
  LAST_COUNT=0
  [ -f "$CURSOR_FILE" ] && LAST_COUNT="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"

  PAYLOAD="$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync(process.argv[1], 'utf8').split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = typeof msg.content === 'string' ? msg.content.trim() :
          Array.isArray(msg.content) ? msg.content.filter(b => b.type === 'text' && b.text).map(b => b.text.trim()).join('\n').trim() : '';
        if (text) messages.push({ role, content: text });
      } catch {}
    }
    const newMessages = messages.slice(parseInt(process.argv[3], 10) || 0);
    if (newMessages.length) {
      process.stdout.write(JSON.stringify({ sessionKey: process.argv[2], messages: newMessages }));
    }
  " "$TRANSCRIPT_PATH" "$SESSION_ID" "$LAST_COUNT" 2>/dev/null)"

  if [ -n "$PAYLOAD" ]; then
    log "final flush for $SESSION_ID"
    curl -s --max-time 30 \
      -X POST "$ENGRAM_URL" \
      -H "Authorization: Bearer ${ENGRAM_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "X-Engram-Client-Id: codex" \
      -d "$PAYLOAD" >/dev/null 2>&1 || log "final flush failed"
  fi
fi

# Cleanup
rm -f "/tmp/engram-cursor-${SESSION_ID}" 2>/dev/null
rmdir "/tmp/engram-lock-${SESSION_ID}.d" 2>/dev/null

exit 0
