#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run() {
  echo "[preflight] $*"
  "$@"
}

changed_files() {
  local base_ref="${PREFLIGHT_BASE_REF:-origin/main}"

  if git rev-parse --verify "$base_ref" >/dev/null 2>&1; then
    git diff --name-only "$(git merge-base HEAD "$base_ref")"...HEAD
    return
  fi

  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff --name-only HEAD~1...HEAD
  fi
}

needs_entity_hardening() {
  local files
  files="$(changed_files)"
  if [[ -z "$files" ]]; then
    return 1
  fi

  if printf '%s\n' "$files" | rg -q '^(src|packages/remnic-core/src)/(orchestrator|storage|intent|memory-cache|entity-retrieval|config)\.ts$'; then
    return 0
  fi

  return 1
}

# Core mandatory gate from docs/ops/pr-review-hardening-playbook.md
run npm run check-types
run npm run check-config-contract
run bash scripts/check-review-patterns.sh

if needs_entity_hardening; then
  run npm run test:entity-hardening
fi

if [[ "$MODE" == "quick" ]]; then
  # Registration contract tests catch silent lifecycle breakage (issues #282, #285).
  # Run first — registration regressions are caught before slower tests.
  run npm test -- tests/register-multi-registry.test.ts
  run npm test -- tests/intent.test.ts
  run npm test -- tests/runtime-input-guards.test.ts
  run npm test -- tests/artifact-recall-limit.test.ts
  run npm test -- tests/artifact-status-snapshot.test.ts
  run npm test -- tests/recall-no-recall-short-circuit.test.ts
  run npm test -- tests/orchestrator-path-filter.test.ts
  run npm test -- tests/artifact-cache.test.ts
else
  run npm test
  run npm run build
fi

echo "[preflight] OK ($MODE)"
