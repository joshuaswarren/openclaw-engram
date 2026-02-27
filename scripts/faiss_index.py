#!/usr/bin/env python3
"""FAISS conversation index sidecar.

JSON-in/JSON-out CLI used by src/conversation-index/faiss-adapter.ts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MODEL_CACHE: dict[str, Any] = {}
HASH_EMBED_DIM = 128
LOCK_TIMEOUT_SECONDS = 10.0
LOCK_STALE_SECONDS = 120.0
MODEL_ID_ALIASES = {
    "text-embedding-3-small": "sentence-transformers/all-MiniLM-L6-v2",
    "text-embedding-3-large": "sentence-transformers/all-mpnet-base-v2",
    "text-embedding-ada-002": "sentence-transformers/all-MiniLM-L6-v2",
}


class SidecarError(Exception):
    pass


class DependencyError(SidecarError):
    pass


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    sys.stdout.flush()


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise SidecarError("empty stdin payload")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SidecarError(f"invalid JSON payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise SidecarError("payload must be a JSON object")
    return payload


def ensure_index_dir(index_path: str) -> Path:
    if not isinstance(index_path, str) or not index_path.strip():
        raise SidecarError("indexPath is required")
    path = Path(index_path)
    path.mkdir(parents=True, exist_ok=True)
    return path


def metadata_file(index_dir: Path) -> Path:
    return index_dir / "metadata.jsonl"


def index_file(index_dir: Path) -> Path:
    return index_dir / "index.faiss"


def read_metadata(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        row_id = row.get("id")
        text = row.get("text")
        if not isinstance(row_id, str) or not row_id:
            continue
        if not isinstance(text, str):
            continue
        rows.append(
            {
                "id": row_id,
                "sessionKey": row.get("sessionKey") if isinstance(row.get("sessionKey"), str) else "",
                "text": text,
                "startTs": row.get("startTs") if isinstance(row.get("startTs"), str) else "",
                "endTs": row.get("endTs") if isinstance(row.get("endTs"), str) else "",
            }
        )
    return rows


def write_metadata(path: Path, rows: list[dict[str, Any]]) -> None:
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":"), ensure_ascii=False))
            handle.write("\n")
    os.replace(tmp, path)


def load_vector_dependencies() -> tuple[Any, Any]:
    try:
        import numpy as np  # type: ignore
        import faiss  # type: ignore
    except Exception as exc:
        raise DependencyError(f"missing faiss dependencies: {exc}") from exc
    return np, faiss


def sentence_transformers_enabled() -> bool:
    value = os.environ.get("ENGRAM_FAISS_ENABLE_ST", "").strip().lower()
    return value in ("1", "true", "yes", "on")


def normalize_model_id(model_id: str) -> str:
    cleaned = (model_id or "").strip()
    if not cleaned:
        cleaned = "sentence-transformers/all-MiniLM-L6-v2"
    resolved = MODEL_ID_ALIASES.get(cleaned, cleaned)
    if resolved in ("__hash__", "hash"):
        return "__hash__"
    if not sentence_transformers_enabled():
        return "__hash__"
    return resolved


def get_embedder(model_id: str) -> Any:
    resolved_model_id = normalize_model_id(model_id)
    if resolved_model_id in ("__hash__", "hash"):
        return None
    if resolved_model_id in MODEL_CACHE:
        return MODEL_CACHE[resolved_model_id]
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except Exception as exc:
        raise DependencyError(f"missing sentence-transformers dependency: {exc}") from exc
    MODEL_CACHE[resolved_model_id] = SentenceTransformer(resolved_model_id)
    return MODEL_CACHE[resolved_model_id]


def embed_with_hash(texts: list[str], np: Any) -> Any:
    vectors = np.zeros((len(texts), HASH_EMBED_DIM), dtype="float32")
    for row_index, text in enumerate(texts):
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        for byte_index in range(HASH_EMBED_DIM):
            vectors[row_index, byte_index] = (digest[byte_index % len(digest)] / 255.0) - 0.5
    return vectors


def embed_texts(texts: list[str], model_id: str) -> tuple[Any, Any, Any]:
    np, faiss = load_vector_dependencies()
    embedder = get_embedder(model_id)
    if embedder is None:
        arr = embed_with_hash(texts, np)
    else:
        vectors = embedder.encode(
            texts,
            normalize_embeddings=False,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        arr = np.asarray(vectors, dtype="float32")
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.shape[0] > 0:
        faiss.normalize_L2(arr)
    return arr, np, faiss


def write_index(path: Path, vectors: Any, faiss: Any) -> None:
    dim = int(vectors.shape[1])
    index = faiss.IndexFlatIP(dim)
    if int(vectors.shape[0]) > 0:
        index.add(vectors)
    tmp = path.with_suffix(".faiss.tmp")
    faiss.write_index(index, str(tmp))
    os.replace(tmp, path)


def parse_chunks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_chunks = payload.get("chunks")
    if not isinstance(raw_chunks, list):
        raise SidecarError("chunks must be an array")
    chunks: list[dict[str, Any]] = []
    for item in raw_chunks:
        if not isinstance(item, dict):
            continue
        chunk_id = item.get("id")
        text = item.get("text")
        if not isinstance(chunk_id, str) or not chunk_id:
            continue
        if not isinstance(text, str):
            continue
        chunks.append(
            {
                "id": chunk_id,
                "sessionKey": item.get("sessionKey") if isinstance(item.get("sessionKey"), str) else "",
                "text": text,
                "startTs": item.get("startTs") if isinstance(item.get("startTs"), str) else "",
                "endTs": item.get("endTs") if isinstance(item.get("endTs"), str) else "",
            }
        )
    return chunks


def merge_rows(existing: list[dict[str, Any]], updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {row["id"]: row for row in existing}
    order = [row["id"] for row in existing]
    for update in updates:
        update_id = update["id"]
        if update_id not in by_id:
            order.append(update_id)
        by_id[update_id] = update
    return [by_id[row_id] for row_id in order]


def read_lock_owner_pid(lock_path: Path) -> int | None:
    try:
        raw = lock_path.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    if not raw:
        return None
    try:
        pid = int(raw)
    except ValueError:
        return None
    return pid if pid > 0 else None


def is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False

    if os.name == "nt":
        try:
            probe = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                timeout=2,
            )
        except Exception:
            return False
        output = probe.stdout.strip()
        if not output:
            return False
        if output.startswith("INFO:"):
            return False
        return f'"{pid}"' in output

    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def acquire_index_lock(index_dir: Path) -> Path:
    lock_path = index_dir / ".index.lock"
    deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS

    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(str(os.getpid()))
            return lock_path
        except FileExistsError:
            try:
                age = time.time() - lock_path.stat().st_mtime
            except FileNotFoundError:
                continue

            owner_pid = read_lock_owner_pid(lock_path)
            owner_alive = is_process_alive(owner_pid) if owner_pid is not None else False

            if age > LOCK_STALE_SECONDS and not owner_alive:
                lock_path.unlink(missing_ok=True)
                continue

            if time.monotonic() >= deadline:
                raise SidecarError("timed out waiting for FAISS index lock")
            time.sleep(0.05)


def release_index_lock(lock_path: Path) -> None:
    lock_path.unlink(missing_ok=True)


def run_upsert(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = payload.get("modelId")
    if not isinstance(model_id, str) or not model_id:
        raise SidecarError("modelId is required")

    index_dir = ensure_index_dir(str(payload.get("indexPath", "")))
    chunks = parse_chunks(payload)

    if not chunks:
        return {"ok": True, "upserted": 0}

    lock_path = acquire_index_lock(index_dir)
    try:
        meta_path = metadata_file(index_dir)
        idx_path = index_file(index_dir)
        existing = read_metadata(meta_path)
        merged = merge_rows(existing, chunks)

        texts = [row["text"] for row in merged]
        vectors, _np, faiss = embed_texts(texts, model_id)

        # Commit FAISS index first; metadata follows so we never point at missing vectors.
        write_index(idx_path, vectors, faiss)
        write_metadata(meta_path, merged)
    finally:
        release_index_lock(lock_path)

    return {"ok": True, "upserted": len(chunks)}


def run_search(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = payload.get("modelId")
    query = payload.get("query")
    top_k = payload.get("topK")
    if not isinstance(model_id, str) or not model_id:
        raise SidecarError("modelId is required")
    if not isinstance(query, str) or not query.strip():
        raise SidecarError("query is required")
    if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k <= 0:
        raise SidecarError("topK must be a positive integer")

    index_dir = ensure_index_dir(str(payload.get("indexPath", "")))
    meta_path = metadata_file(index_dir)
    idx_path = index_file(index_dir)

    rows = read_metadata(meta_path)
    if not rows or not idx_path.exists():
        return {"ok": True, "results": []}

    _np, faiss = load_vector_dependencies()
    index = faiss.read_index(str(idx_path))

    query_vector, _np2, faiss2 = embed_texts([query], model_id)
    if int(index.d) != int(query_vector.shape[1]):
        raise SidecarError(
            f"index dimension mismatch (index={index.d}, query={int(query_vector.shape[1])})"
        )

    distances, indices = index.search(query_vector, top_k)
    results: list[dict[str, Any]] = []
    for score, idx in zip(distances[0], indices[0]):
        idx_i = int(idx)
        if idx_i < 0 or idx_i >= len(rows):
            continue
        row = rows[idx_i]
        results.append(
            {
                "path": row["id"],
                "snippet": row["text"][:280],
                "score": float(score),
            }
        )

    return {"ok": True, "results": results}


def run_health(payload: dict[str, Any]) -> dict[str, Any]:
    index_dir = ensure_index_dir(str(payload.get("indexPath", "")))
    meta_path = metadata_file(index_dir)
    idx_path = index_file(index_dir)

    status = "ok"
    error = ""
    model_id = normalize_model_id(str(payload.get("modelId", "")))

    try:
        load_vector_dependencies()
        if model_id not in ("__hash__", "hash"):
            try:
                import sentence_transformers  # type: ignore # noqa: F401
            except Exception as exc:
                raise DependencyError(f"missing sentence-transformers dependency: {exc}") from exc
    except Exception as exc:
        status = "degraded"
        error = str(exc)

    if not idx_path.exists() or not meta_path.exists():
        if status == "ok":
            status = "degraded"

    response: dict[str, Any] = {"ok": True, "status": status}
    if error:
        response["error"] = error
    return response


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["upsert", "search", "health"])
    args = parser.parse_args()

    try:
        payload = read_payload()
        if args.command == "upsert":
            emit(run_upsert(payload))
        elif args.command == "search":
            emit(run_search(payload))
        else:
            emit(run_health(payload))
        return 0
    except (SidecarError, DependencyError) as exc:
        emit({"ok": False, "error": str(exc)})
        return 0
    except Exception as exc:
        print(f"faiss sidecar internal error: {exc}", file=sys.stderr)
        emit({"ok": False, "error": "internal sidecar error"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
