#!/usr/bin/env bash
# Remnic UserPromptSubmit hook for Claude Code.
# Recalls per-prompt context using the user's message as query.
# Skips short prompts (<4 words). Minimal mode, 20s timeout.

set -euo pipefail

ensure_migrated() {
  if [ -f "${HOME}/.remnic/.migrated-from-engram" ]; then
    return 0
  fi
  if [ ! -d "${HOME}/.engram" ] && [ ! -f "${HOME}/.config/engram/config.json" ]; then
    return 0
  fi
  if command -v remnic >/dev/null 2>&1; then
    remnic migrate >/dev/null 2>&1 || true
  elif command -v engram >/dev/null 2>&1; then
    engram migrate >/dev/null 2>&1 || true
  fi
}

ensure_migrated

REMNIC_HOST="${REMNIC_HOST:-${ENGRAM_HOST:-127.0.0.1}}"
REMNIC_PORT="${REMNIC_PORT:-${ENGRAM_PORT:-4318}}"
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/recall"

LOG="${HOME}/.remnic/logs/remnic-user-prompt-recall.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [user-prompt] $*" >> "$LOG"; }

# Read token
REMNIC_TOKEN=""
for TOKEN_FILE in "${HOME}/.remnic/tokens.json" "${HOME}/.engram/tokens.json"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const fs = require('fs');
    const tokenFile = process.argv[1];
    const store = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const tokens = store.tokens || [];
    const cc = tokens.find(t => t.connector === 'claude-code');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cc && cc.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['claude-code'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " "$TOKEN_FILE" 2>/dev/null || echo "")"
  [ -n "$REMNIC_TOKEN" ] && break
done
[ -z "$REMNIC_TOKEN" ] && REMNIC_TOKEN="${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}"

INPUT="$(cat)"

if [ -z "$REMNIC_TOKEN" ]; then
  echo '{"continue":true}'
  exit 0
fi

SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
PROMPT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.prompt||'')" "$INPUT" 2>/dev/null || echo "")"

# Skip very short prompts
WORD_COUNT="$(echo "$PROMPT" | wc -w | tr -d ' ')"
if [ "$WORD_COUNT" -lt 4 ]; then
  echo '{"continue":true}'
  exit 0
fi

log "session=$SESSION_ID words=$WORD_COUNT"

REQUEST_BODY="$(node -e "process.stdout.write(JSON.stringify({
  query: process.argv[1],
  sessionKey: process.argv[2],
  topK: 8,
  mode: 'minimal'
}))" "$PROMPT" "$SESSION_ID" 2>/dev/null)"

[ -z "$REQUEST_BODY" ] && echo '{"continue":true}' && exit 0

RAW="$(curl -s -w "\n%{http_code}" --max-time 20 \
  -X POST "$REMNIC_URL" \
  -H "Authorization: Bearer ${REMNIC_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Engram-Client-Id: claude-code" \
  -d "$REQUEST_BODY" 2>/dev/null)"
CURL_EXIT=$?
HTTP_STATUS="$(echo "$RAW" | tail -1)"
RESPONSE="$(echo "$RAW" | sed '$d')"

if [ $CURL_EXIT -ne 0 ] || ! [[ "$HTTP_STATUS" =~ ^2 ]] || [ -z "$RESPONSE" ]; then
  log "recall failed (curl=$CURL_EXIT http=$HTTP_STATUS)"
  echo '{"continue":true}'
  exit 0
fi

node -e "
  const d = JSON.parse(process.argv[1]);
  const ctx = d.context || '';
  const count = d.count || 0;
  if (!ctx || count === 0) {
    process.stdout.write(JSON.stringify({continue: true}));
  } else {
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<remnic-memory count=\"' + count + '\">\n' + ctx + '\n</remnic-memory>'
      }
    }));
  }
" "$RESPONSE" 2>/dev/null || echo '{"continue":true}'

COUNT="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.count||0))" "$RESPONSE" 2>/dev/null || echo "?")"
log "done: ${COUNT} memories injected"
