import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts", "faiss_index.py");
const pythonBin = process.env.PYTHON_BIN || "python3";

function runSidecar(command: "upsert" | "search" | "health", payload: object) {
  const proc = spawnSync(pythonBin, [scriptPath, command], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
  });

  assert.equal(proc.status, 0, `sidecar exited non-zero: ${proc.stderr || "<no stderr>"}`);
  assert.ok(proc.stdout.trim().length > 0, "sidecar returned empty stdout");

  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    assert.fail(`sidecar returned non-JSON stdout: ${proc.stdout}`);
  }

  return parsed as Record<string, unknown>;
}

function hasFaissDeps(): boolean {
  const probe = spawnSync(pythonBin, ["-c", "import faiss, numpy"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return probe.status === 0;
}

test("faiss sidecar health command returns contract", () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-health-"));
  try {
    const response = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });

    assert.equal(response.ok, true);
    assert.ok(["ok", "degraded", "error"].includes(String(response.status)));
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar upsert/search smoke with hash model", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-smoke-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "OpenClaw memory and FAISS integration",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
        {
          id: "chunk-2",
          sessionKey: "session-1",
          text: "Conversation semantic retrieval with a sidecar",
          startTs: "2026-02-27T00:01:00.000Z",
          endTs: "2026-02-27T00:01:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);
    assert.equal(upsertResponse.upserted, 2);

    const searchResponse = runSidecar("search", {
      modelId: "__hash__",
      indexPath,
      query: "FAISS sidecar",
      topK: 2,
    });

    assert.equal(searchResponse.ok, true);
    assert.ok(Array.isArray(searchResponse.results));
    assert.ok((searchResponse.results as unknown[]).length > 0);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});
