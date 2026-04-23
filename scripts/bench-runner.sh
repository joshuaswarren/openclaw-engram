#!/usr/bin/env bash
# Session-independent benchmark runner.
# Runs benchmarks via nohup so they survive terminal/session restarts.
#
# Usage:
#   scripts/bench-runner.sh start [bench flags...]   - launch detached run
#   scripts/bench-runner.sh status                   - show progress (machine-readable)
#   scripts/bench-runner.sh stop                     - kill running benchmark
#   scripts/bench-runner.sh log                      - tail the log file
#   scripts/bench-runner.sh show                     - print latest status JSON
#
# State files:
#   ~/.remnic/bench/runner.pid   - PID of the bench process
#   ~/.remnic/bench/runner.log   - combined stdout+stderr
#   ~/.remnic/bench/runner.env   - saved CLI flags for reproducibility
#   ~/.remnic/bench/results/bench-status-*.json - progress (written by bench-status.ts)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_DIR="$HOME/.remnic/bench"
RESULTS_DIR="$BENCH_DIR/results"
PID_FILE="$BENCH_DIR/runner.pid"
LOG_FILE="$BENCH_DIR/runner.log"
ENV_FILE="$BENCH_DIR/runner.env"
RUNNER_SCRIPT="$REPO_ROOT/scripts/run-bench-cli.mjs"

mkdir -p "$BENCH_DIR" "$RESULTS_DIR"

usage() {
  sed -n '2,/^$/s/^# //p' "$0"
  exit 1
}

is_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  fi
}

latest_status_file() {
  ls -t "$RESULTS_DIR"/bench-status-*.json 2>/dev/null | head -1 || true
}

cmd_start() {
  if [[ $# -eq 0 ]]; then
    echo "ERROR: start requires bench run flags." >&2
    echo "Usage: scripts/bench-runner.sh start <benchmark> [flags...]" >&2
    exit 1
  fi

  local pid
  pid="$(read_pid)"
  if [[ -n "$pid" ]] && is_alive "$pid"; then
    echo "ERROR: benchmark already running (PID $pid). Stop it first." >&2
    echo "  scripts/bench-runner.sh stop" >&2
    exit 1
  fi

  # Save flags for reproducibility (redact API keys).
  # Join args onto one line so sed can match flag+value pairs that
  # arrive as separate shell words.
  printf '%s' "$*" | sed -E 's/(-system-api-key |-judge-api-key |-api-key )[^ ]*/\1***REDACTED***/g' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Rotate log if large (>10MB)
  if [[ -f "$LOG_FILE" ]] && [[ "$(wc -c < "$LOG_FILE")" -gt 10485760 ]]; then
    mv "$LOG_FILE" "$LOG_FILE.$(date +%Y%m%d%H%M%S)"
  fi

  # Log flags with API keys redacted
  local redacted_args
  redacted_args="$(printf '%s' "$*" | sed -E 's/(-system-api-key |-judge-api-key |-api-key )[^ ]*/\1***REDACTED***/g')"
  echo "[$(date -Iseconds)] Starting benchmark: run-bench-cli.mjs run $redacted_args" >> "$LOG_FILE"

  nohup node "$RUNNER_SCRIPT" run "$@" >> "$LOG_FILE" 2>&1 &
  local bg_pid=$!
  echo "$bg_pid" > "$PID_FILE"

  echo "Benchmark started."
  echo "  PID:  $bg_pid"
  echo "  Log:  $LOG_FILE"
  echo "  Status: scripts/bench-runner.sh status"
}

cmd_stop() {
  local pid
  pid="$(read_pid)"
  if [[ -z "$pid" ]]; then
    echo "No PID file found. Nothing to stop."
    exit 0
  fi

  if ! is_alive "$pid"; then
    echo "Process $pid is not running. Cleaning up PID file."
    rm -f "$PID_FILE"
    exit 0
  fi

  echo "Stopping benchmark (PID $pid)..."
  # Kill the process group so child processes are also terminated
  kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true

  # Wait up to 10s for graceful shutdown
  local waited=0
  while [[ $waited -lt 10 ]] && is_alive "$pid"; do
    sleep 1
    waited=$((waited + 1))
  done

  if is_alive "$pid"; then
    echo "Process did not exit, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  # Kill any orphaned bench processes from previous runs
  local orphaned
  orphaned="$(pgrep -f "tsx.*packages/remnic-cli/src/index.ts bench run" 2>/dev/null || true)"
  if [[ -n "$orphaned" ]]; then
    echo "Killing orphaned bench processes: $orphaned"
    echo "$orphaned" | xargs kill 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Stopped."
}

cmd_status() {
  local pid
  pid="$(read_pid)"

  # Process status
  if [[ -n "$pid" ]] && is_alive "$pid"; then
    echo "process: running (PID $pid)"
  elif [[ -n "$pid" ]]; then
    echo "process: stopped (PID $pid exited)"
  else
    echo "process: no run"
  fi

  # Parse latest status JSON
  local status_file
  status_file="$(latest_status_file)"

  if [[ -z "$status_file" ]]; then
    echo "status_file: none"
    if [[ -z "$pid" ]] || ! is_alive "${pid:-}"; then
      exit 1
    fi
    exit 0
  fi

  # Extract key fields with portable parsing (no jq dependency).
  # Patterns tolerate pretty-printed JSON (optional whitespace around colons).
  local current_bench completed total benchmarks failed
  current_bench="$(grep -oE '"currentBenchmark"\s*:\s*"[^"]*"' "$status_file" | head -1 | grep -oE '"[^"]*"$' | tr -d '"')"
  completed="$(grep -oE '"completed"\s*:\s*[0-9]+' "$status_file" | head -1 | grep -oE '[0-9]+$')"
  total="$(grep -oE '"total"\s*:\s*[0-9]+' "$status_file" | head -1 | grep -oE '[0-9]+$')"
  benchmarks="$(grep -oE '"id"\s*:\s*"[^"]*"\s*,\s*"status"\s*:\s*"[^"]*"' "$status_file" | sed -E 's/"id"\s*:\s*"/  /;s/"\s*,\s*"status"\s*:\s*"/ → /;s/"$//' | tail -20)"
  failed="$(grep -cE '"status"\s*:\s*"failed"' "$status_file" 2>/dev/null || echo 0)"

  echo "status_file: $(basename "$status_file")"
  if [[ -n "$current_bench" ]]; then
    echo "current: $current_bench (${completed:-0}${total:+/$total} tasks)"
  fi

  local bench_complete bench_total
  bench_complete="$(grep -cE '"status"\s*:\s*"complete"' "$status_file" 2>/dev/null || echo 0)"
  bench_total="$(grep -cE '"status"\s*:\s*"(pending|running|complete|failed)"' "$status_file" 2>/dev/null || echo 0)"

  echo "benchmarks: ${bench_complete}/${bench_total} complete, ${failed} failed"
  if [[ -n "$benchmarks" ]]; then
    echo "$benchmarks"
  fi

  # Exit codes: 0=running, 2=completed, 1=stopped/no run
  if [[ -n "$pid" ]] && is_alive "$pid"; then
    exit 0
  elif [[ "$bench_complete" -eq "$bench_total" ]] && [[ "$bench_total" -gt 0 ]]; then
    exit 2
  else
    exit 1
  fi
}

cmd_log() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "No log file yet."
    exit 1
  fi
  tail -f "$LOG_FILE"
}

cmd_show() {
  local status_file
  status_file="$(latest_status_file)"
  if [[ -z "$status_file" ]]; then
    echo "No status file found."
    exit 1
  fi
  cat "$status_file"
}

# --- Main dispatch ---

if [[ $# -eq 0 ]]; then
  usage
fi

cmd="$1"
shift

case "$cmd" in
  start)  cmd_start "$@" ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  log)    cmd_log ;;
  show)   cmd_show ;;
  -h|--help) usage ;;
  *)
    echo "ERROR: unknown command '$cmd'" >&2
    usage
    ;;
esac
