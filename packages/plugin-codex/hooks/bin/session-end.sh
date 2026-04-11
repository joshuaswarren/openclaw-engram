#!/usr/bin/env bash
# Remnic Stop hook for Codex.
# Performs final observe flush then cleans up cursor/lock files.

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
REMNIC_URL="http://${REMNIC_HOST}:${REMNIC_PORT}/engram/v1/observe"

LOG="${HOME}/.remnic/logs/remnic-codex-session-end.log"
mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%F %T') [codex-stop] $*" >> "$LOG"; }

REMNIC_TOKEN=""
for TOKEN_FILE in "${HOME}/.remnic/tokens.json" "${HOME}/.engram/tokens.json"; do
  [ ! -f "$TOKEN_FILE" ] && continue
  REMNIC_TOKEN="$(node -e "
    const fs = require('fs');
    const tokenFile = process.argv[1];
    const store = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    const tokens = store.tokens || [];
    const cx = tokens.find(t => t.connector === 'codex');
    const oc = tokens.find(t => t.connector === 'openclaw');
    let tok = (cx && cx.token) || (oc && oc.token) || '';
    if (!tok) { tok = store['codex'] || store['openclaw'] || ''; }
    process.stdout.write(tok);
  " "$TOKEN_FILE" 2>/dev/null || echo "")"
  [ -n "$REMNIC_TOKEN" ] && break
done
[ -z "$REMNIC_TOKEN" ] && REMNIC_TOKEN="${OPENCLAW_REMNIC_ACCESS_TOKEN:-${OPENCLAW_ENGRAM_ACCESS_TOKEN:-}}"

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"
TRANSCRIPT_PATH="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.transcript_path||'')" "$INPUT" 2>/dev/null || echo "")"

echo '{"continue":true}'

# Final observe flush if we have transcript
if [ -n "$REMNIC_TOKEN" ] && [ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LEGACY_CURSOR_FILE="/tmp/engram-cursor-${SESSION_ID}"
  CURSOR_FILE="/tmp/remnic-cursor-${SESSION_ID}"
  if [ ! -f "$CURSOR_FILE" ] && [ -f "$LEGACY_CURSOR_FILE" ]; then
    CURSOR_FILE="$LEGACY_CURSOR_FILE"
  fi
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
      -X POST "$REMNIC_URL" \
      -H "Authorization: Bearer ${REMNIC_TOKEN}" \
      -H "Content-Type: application/json" \
      -H "X-Engram-Client-Id: codex" \
      -d "$PAYLOAD" >/dev/null 2>&1 || log "final flush failed"
  fi
fi

# Cleanup
rm -f "/tmp/remnic-cursor-${SESSION_ID}" 2>/dev/null
rmdir "/tmp/remnic-lock-${SESSION_ID}.d" 2>/dev/null
rm -f "/tmp/engram-cursor-${SESSION_ID}" 2>/dev/null
rmdir "/tmp/engram-lock-${SESSION_ID}.d" 2>/dev/null

# Codex-native memory materialization (#378). The script honors the
# `codexMaterializeMemories` config flag and the `.remnic-managed` sentinel,
# so it's safe to run unconditionally here.
if [ "${REMNIC_CODEX_MATERIALIZE:-1}" != "0" ]; then
  REMNIC_REPO_ROOT="${REMNIC_REPO_ROOT:-}"
  if [ -z "$REMNIC_REPO_ROOT" ] && command -v remnic >/dev/null 2>&1; then
    REMNIC_REPO_ROOT="$(remnic --print-root 2>/dev/null || true)"
  fi
  if [ -n "$REMNIC_REPO_ROOT" ] && [ -f "${REMNIC_REPO_ROOT}/scripts/codex-materialize.ts" ]; then
    (
      cd "$REMNIC_REPO_ROOT"
      npx --yes tsx scripts/codex-materialize.ts --reason session_end >> "$LOG" 2>&1 || \
        log "codex-materialize session_end failed"
    )
  fi
fi

exit 0
