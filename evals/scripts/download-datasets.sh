#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATASETS_DIR="$(cd "$SCRIPT_DIR/../datasets" && pwd)"

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
  if [[ -d "$dir" && -f "$dir/ama-bench.json" ]]; then
    echo "[ama-bench] Already downloaded at $dir"
    return
  fi
  echo "[ama-bench] Downloading from GitHub..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/tongxin97/AMA-Bench.git "$tmpdir/repo" 2>/dev/null || {
    echo "[ama-bench] WARNING: Could not clone repo. Creating placeholder dataset."
    echo '[{"id":"placeholder","memorize_texts":["The capital of France is Paris."],"queries":[{"query":"What is the capital of France?","expected_answer":"Paris","category":"factual"}]}]' > "$dir/ama-bench.json"
    rm -rf "$tmpdir"
    return
  }
  # Look for data files in common locations
  if [[ -d "$tmpdir/repo/data" ]]; then
    cp -r "$tmpdir/repo/data/"* "$dir/" 2>/dev/null || true
  fi
  if [[ -d "$tmpdir/repo/benchmark" ]]; then
    cp -r "$tmpdir/repo/benchmark/"* "$dir/" 2>/dev/null || true
  fi
  # If no structured data found, create a consolidated file from whatever exists
  if [[ ! -f "$dir/ama-bench.json" && ! -d "$dir/tasks" ]]; then
    find "$tmpdir/repo" -name "*.json" -not -path "*/node_modules/*" -not -name "package*.json" \
      -exec cp {} "$dir/" \; 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
  echo "[ama-bench] Downloaded to $dir"
}

download_longmemeval() {
  local dir="$DATASETS_DIR/longmemeval"
  if [[ -d "$dir" && -f "$dir/longmemeval.json" ]]; then
    echo "[longmemeval] Already downloaded at $dir"
    return
  fi
  echo "[longmemeval] Downloading from HuggingFace..."
  mkdir -p "$dir"
  # Try HuggingFace datasets API
  curl -sL "https://huggingface.co/api/datasets/dt-research-group/LongMemEval/parquet/default/test/0.parquet" \
    -o "$dir/test.parquet" 2>/dev/null || true
  if [[ ! -s "$dir/test.parquet" ]]; then
    # Fallback: try the git repo
    local tmpdir
    tmpdir=$(mktemp -d)
    git clone --depth 1 https://huggingface.co/datasets/dt-research-group/LongMemEval "$tmpdir/repo" 2>/dev/null || {
      echo "[longmemeval] WARNING: Could not download. Creating placeholder dataset."
      echo '[{"id":"placeholder","conversations":[{"role":"user","content":"My favorite color is blue.","session_id":"s1"},{"role":"assistant","content":"Got it, blue!","session_id":"s1"}],"queries":[{"query":"What is my favorite color?","expected_answer":"blue","category":"single_session"}]}]' > "$dir/longmemeval.json"
      rm -rf "$tmpdir"
      return
    }
    find "$tmpdir/repo" -name "*.json" -o -name "*.jsonl" | head -20 | while read -r f; do
      cp "$f" "$dir/" 2>/dev/null || true
    done
    rm -rf "$tmpdir"
  fi
  echo "[longmemeval] Downloaded to $dir"
}

download_amemgym() {
  local dir="$DATASETS_DIR/amemgym"
  if [[ -d "$dir" && -f "$dir/amemgym-tasks.json" ]]; then
    echo "[amemgym] Already downloaded at $dir"
    return
  fi
  echo "[amemgym] Downloading from GitHub..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/agiresearch/AMemGym.git "$tmpdir/repo" 2>/dev/null || {
    echo "[amemgym] WARNING: Could not clone repo. Creating placeholder dataset."
    echo '[{"id":"placeholder","user_profile":{"user_id":"u1","preferences":{"cuisine":"Italian","color":"green"},"history":[{"role":"user","content":"I love Italian food"},{"role":"assistant","content":"Italian cuisine is wonderful!"}]},"queries":[{"query":"What cuisine do I prefer?","expected_answer":"Italian","relevant_preferences":["Italian"],"difficulty":"easy"}]}]' > "$dir/amemgym-tasks.json"
    rm -rf "$tmpdir"
    return
  }
  if [[ -d "$tmpdir/repo/data" ]]; then
    cp -r "$tmpdir/repo/data/"* "$dir/" 2>/dev/null || true
  fi
  if [[ -d "$tmpdir/repo/benchmark" ]]; then
    cp -r "$tmpdir/repo/benchmark/"* "$dir/" 2>/dev/null || true
  fi
  if [[ ! -f "$dir/amemgym-tasks.json" && ! -d "$dir/tasks" ]]; then
    find "$tmpdir/repo" -name "*.json" -not -path "*/node_modules/*" -not -name "package*.json" \
      -exec cp {} "$dir/" \; 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
  echo "[amemgym] Downloaded to $dir"
}

download_locomo() {
  local dir="$DATASETS_DIR/locomo"
  if [[ -d "$dir" && -f "$dir/locomo.json" ]]; then
    echo "[locomo] Already downloaded at $dir"
    return
  fi
  echo "[locomo] Downloading from HuggingFace..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://huggingface.co/datasets/LoCoMo/LoCoMo "$tmpdir/repo" 2>/dev/null || {
    echo "[locomo] WARNING: Could not download. Creating placeholder dataset."
    echo '[{"id":"placeholder","conversation":[{"role":"user","content":"I went to Paris last summer."},{"role":"assistant","content":"How was Paris?"},{"role":"user","content":"Amazing! I visited the Eiffel Tower."},{"role":"assistant","content":"The Eiffel Tower is iconic!"}],"questions":[{"question":"Where did I travel last summer?","answer":"Paris","question_type":"factual"}]}]' > "$dir/locomo.json"
    rm -rf "$tmpdir"
    return
  }
  find "$tmpdir/repo" -name "*.json" -o -name "*.jsonl" | head -20 | while read -r f; do
    cp "$f" "$dir/" 2>/dev/null || true
  done
  rm -rf "$tmpdir"
  echo "[locomo] Downloaded to $dir"
}

download_memory_arena() {
  local dir="$DATASETS_DIR/memory-arena"
  if [[ -d "$dir" && -f "$dir/arena-tasks.json" ]]; then
    echo "[memory-arena] Already downloaded at $dir"
    return
  fi
  echo "[memory-arena] Downloading from GitHub..."
  mkdir -p "$dir"
  local tmpdir
  tmpdir=$(mktemp -d)
  git clone --depth 1 https://github.com/shenzhi-wang/MemoryArena.git "$tmpdir/repo" 2>/dev/null || {
    echo "[memory-arena] WARNING: Could not clone repo. Creating placeholder dataset."
    echo '[{"id":"placeholder","description":"Store and recall a fact","steps":[{"action":"store","content":"The project deadline is March 15."},{"action":"query","query":"When is the project deadline?","expected_answer":"March 15"}],"category":"single_step"}]' > "$dir/arena-tasks.json"
    rm -rf "$tmpdir"
    return
  }
  if [[ -d "$tmpdir/repo/data" ]]; then
    cp -r "$tmpdir/repo/data/"* "$dir/" 2>/dev/null || true
  fi
  if [[ -d "$tmpdir/repo/tasks" ]]; then
    cp -r "$tmpdir/repo/tasks/"* "$dir/" 2>/dev/null || true
  fi
  if [[ ! -f "$dir/arena-tasks.json" && ! -d "$dir/tasks" ]]; then
    find "$tmpdir/repo" -name "*.json" -not -path "*/node_modules/*" -not -name "package*.json" \
      -exec cp {} "$dir/" \; 2>/dev/null || true
  fi
  rm -rf "$tmpdir"
  echo "[memory-arena] Downloaded to $dir"
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
