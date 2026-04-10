#!/usr/bin/env bash
# Remnic session cleanup for Claude Code.
# Removes cursor and lock files for the session.
#
# NOTE: Claude Code does not support a Stop/SessionEnd hook event.
# This script is provided for manual cleanup or future hook support.
# Temp files in /tmp/ are cleaned by the OS on reboot.

INPUT="$(cat)"
SESSION_ID="$(node -e "const d=JSON.parse(process.argv[1]); process.stdout.write(d.session_id||'')" "$INPUT" 2>/dev/null || echo "")"

echo '{"continue":true}'

[ -z "$SESSION_ID" ] && exit 0

rm -f "/tmp/remnic-cursor-${SESSION_ID}" 2>/dev/null
rmdir "/tmp/remnic-lock-${SESSION_ID}.d" 2>/dev/null
rm -f "/tmp/engram-cursor-${SESSION_ID}" 2>/dev/null
rmdir "/tmp/engram-lock-${SESSION_ID}.d" 2>/dev/null

exit 0
