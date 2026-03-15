#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATASETS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/datasets"

usage() {
  echo "Usage: $0 [--benchmark <name>]"
  echo ""
  echo "Downloads benchmark datasets for the Engram eval suite."
  echo ""
  echo "Benchmarks: ama-bench, longmemeval, amemgym, locomo, memory-arena, all"
  echo ""
  echo "Options:"
  echo "  --benchmark <name>   Download only the specified benchmark (default: all)"
  echo "  --help               Show this help"
  exit 0
}

BENCHMARK="all"
while [[ $# -gt 0 ]]; do
  case $1 in
    --benchmark) BENCHMARK="$2"; shift 2 ;;
    --help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

check_deps() {
  for cmd in git curl; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "ERROR: $cmd is required but not found"
      exit 1
    fi
  done
}

download_ama_bench() {
  local dir="$DATASETS_DIR/ama-bench"
  if [[ -f "$dir/open_end_qa_set.jsonl" ]]; then
    echo "[ama-bench] Already downloaded at $dir"
    return
  fi
  echo "[ama-bench] Downloading from HuggingFace (AMA-bench/AMA-bench)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/AMA-bench/AMA-bench "$tmpdir/repo" 2>/dev/null || {
    echo "[ama-bench] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/AMA-bench/AMA-bench /tmp/amabench"
    echo "  cp /tmp/amabench/test/open_end_qa_set.jsonl $dir/"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/test/open_end_qa_set.jsonl" "$dir/" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[ama-bench] Downloaded to $dir ($(wc -l < "$dir/open_end_qa_set.jsonl") episodes)"
}

download_longmemeval() {
  local dir="$DATASETS_DIR/longmemeval"
  if [[ -f "$dir/longmemeval_oracle.json" ]]; then
    echo "[longmemeval] Already downloaded at $dir"
    return
  fi
  echo "[longmemeval] Downloading from HuggingFace (xiaowu0162/longmemeval-cleaned)..."
  mkdir -p "$dir"
  curl -sL "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json" \
    -o "$dir/longmemeval_oracle.json"
  if [[ ! -s "$dir/longmemeval_oracle.json" ]]; then
    echo "[longmemeval] ERROR: Download failed. Try manually:"
    echo "  curl -sL https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json -o $dir/longmemeval_oracle.json"
    rm -f "$dir/longmemeval_oracle.json"
    return 1
  fi
  echo "[longmemeval] Downloaded to $dir ($(du -h "$dir/longmemeval_oracle.json" | cut -f1))"
}

download_amemgym() {
  local dir="$DATASETS_DIR/amemgym"
  if [[ -f "$dir/amemgym-v1-base.json" ]]; then
    echo "[amemgym] Already downloaded at $dir"
    return
  fi
  echo "[amemgym] Downloading from HuggingFace (AGI-Eval/AMemGym)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/AGI-Eval/AMemGym "$tmpdir/repo" 2>/dev/null || {
    echo "[amemgym] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/AGI-Eval/AMemGym /tmp/amemgym"
    echo "  cp /tmp/amemgym/v1.base/data.json $dir/amemgym-v1-base.json"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/v1.base/data.json" "$dir/amemgym-v1-base.json" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[amemgym] Downloaded to $dir"
}

download_locomo() {
  local dir="$DATASETS_DIR/locomo"
  if [[ -f "$dir/locomo10.json" ]]; then
    echo "[locomo] Already downloaded at $dir"
    return
  fi
  echo "[locomo] Downloading from GitHub (snap-research/locomo)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/snap-research/locomo.git "$tmpdir/repo" 2>/dev/null || {
    echo "[locomo] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://github.com/snap-research/locomo.git /tmp/locomo"
    echo "  cp /tmp/locomo/data/locomo10.json $dir/"
    rm -rf "$tmpdir"
    return 1
  }
  cp "$tmpdir/repo/data/locomo10.json" "$dir/" 2>/dev/null || true
  rm -rf "$tmpdir"
  echo "[locomo] Downloaded to $dir ($(du -h "$dir/locomo10.json" | cut -f1))"
}

download_memory_arena() {
  local dir="$DATASETS_DIR/memory-arena"
  if [[ -d "$dir" ]] && ls "$dir"/*.jsonl &>/dev/null; then
    echo "[memory-arena] Already downloaded at $dir"
    return
  fi
  echo "[memory-arena] Downloading from HuggingFace (ZexueHe/memoryarena)..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/ZexueHe/memoryarena "$tmpdir/repo" 2>/dev/null || {
    echo "[memory-arena] ERROR: Could not clone. Try manually:"
    echo "  git clone --depth 1 https://huggingface.co/datasets/ZexueHe/memoryarena /tmp/memoryarena"
    echo "  for d in /tmp/memoryarena/*/; do cp \"\$d/data.jsonl\" \"$dir/\$(basename \$d).jsonl\"; done"
    rm -rf "$tmpdir"
    return 1
  }
  for d in "$tmpdir/repo"/*/; do
    local name
    name=$(basename "$d")
    if [[ -f "$d/data.jsonl" ]]; then
      cp "$d/data.jsonl" "$dir/${name}.jsonl"
    fi
  done
  rm -rf "$tmpdir"
  local count
  count=$(ls "$dir"/*.jsonl 2>/dev/null | wc -l | tr -d ' ')
  echo "[memory-arena] Downloaded to $dir ($count domains)"
}

# ── Main ──

check_deps
mkdir -p "$DATASETS_DIR"

case "$BENCHMARK" in
  ama-bench)      download_ama_bench ;;
  longmemeval)    download_longmemeval ;;
  amemgym)        download_amemgym ;;
  locomo)         download_locomo ;;
  memory-arena)   download_memory_arena ;;
  all)
    download_ama_bench
    download_longmemeval
    download_amemgym
    download_locomo
    download_memory_arena
    ;;
  *)
    echo "Unknown benchmark: $BENCHMARK"
    echo "Available: ama-bench, longmemeval, amemgym, locomo, memory-arena, all"
    exit 1
    ;;
esac

echo ""
echo "Done. Datasets at: $DATASETS_DIR"
