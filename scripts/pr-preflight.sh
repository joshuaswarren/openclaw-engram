#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run() {
  echo "[preflight] $*"
  "$@"
}

# Core mandatory gate from docs/ops/pr-review-hardening-playbook.md
run npm run check-types
run npm run check-config-contract

if [[ "$MODE" == "quick" ]]; then
  run npm test -- tests/intent.test.ts
  run npm test -- tests/artifact-recall-limit.test.ts
  run npm test -- tests/recall-no-recall-short-circuit.test.ts
  run npm test -- tests/orchestrator-path-filter.test.ts
  run npm test -- tests/artifact-cache.test.ts
else
  run npm test
  run npm run build
fi

echo "[preflight] OK ($MODE)"
