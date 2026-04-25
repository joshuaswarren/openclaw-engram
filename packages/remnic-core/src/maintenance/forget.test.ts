/**
 * Unit tests for `forgetMemory` (issue #686 PR 4/6).
 *
 * Pure helper-level coverage — uses a minimal in-memory storage stub
 * so the test focuses on the forget pipeline (find by id → write
 * frontmatter → return result) without booting an orchestrator.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  forgetMemory,
  ForgetMemoryAlreadyForgottenError,
  ForgetMemoryNotFoundError,
} from "./forget.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";

interface StubWriteCall {
  memoryId: string;
  patch: Partial<MemoryFrontmatter>;
}

function makeMemory(overrides: Partial<MemoryFrontmatter> = {}): MemoryFile {
  return {
    path: `/tmp/mem/${overrides.id ?? "mem-1"}.md`,
    content: "synthetic body",
    frontmatter: {
      id: "mem-1",
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      ...overrides,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(memories: MemoryFile[]) {
  const writes: StubWriteCall[] = [];
  const stub = {
    readAllMemories: async () => memories,
    writeMemoryFrontmatter: async (memory: MemoryFile, patch: Partial<MemoryFrontmatter>) => {
      writes.push({ memoryId: memory.frontmatter.id, patch });
      return true;
    },
  };
  return { stub, writes };
}

test("forgetMemory: marks active memory as forgotten with timestamp + reason", async () => {
  const mem = makeMemory({ id: "alpha", status: "active" });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub as never, {
    id: "alpha",
    reason: "stale preference",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.id, "alpha");
  assert.equal(result.path, "/tmp/mem/alpha.md");
  assert.equal(result.priorStatus, "active");
  assert.equal(result.forgottenAt, "2026-04-25T12:00:00.000Z");
  assert.equal(result.reason, "stale preference");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.memoryId, "alpha");
  assert.equal(writes[0]?.patch.status, "forgotten");
  assert.equal(writes[0]?.patch.forgottenAt, "2026-04-25T12:00:00.000Z");
  assert.equal(writes[0]?.patch.forgottenReason, "stale preference");
  assert.equal(writes[0]?.patch.updated, "2026-04-25T12:00:00.000Z");
});

test("forgetMemory: omits forgottenReason when reason is empty", async () => {
  const mem = makeMemory({ id: "beta", status: "active" });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub as never, {
    id: "beta",
    reason: "   ",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.reason, "");
  assert.equal(writes[0]?.patch.forgottenReason, undefined);
});

test("forgetMemory: throws ForgetMemoryNotFoundError on unknown id", async () => {
  const { stub } = makeStorageStub([makeMemory({ id: "gamma" })]);
  await assert.rejects(
    forgetMemory(stub as never, { id: "no-such-id" }),
    (err: unknown) => err instanceof ForgetMemoryNotFoundError,
  );
});

test("forgetMemory: throws ForgetMemoryAlreadyForgottenError on already-forgotten", async () => {
  const mem = makeMemory({
    id: "delta",
    status: "forgotten",
    forgottenAt: "2026-04-20T00:00:00.000Z",
  });
  const { stub } = makeStorageStub([mem]);
  await assert.rejects(
    forgetMemory(stub as never, { id: "delta" }),
    (err: unknown) =>
      err instanceof ForgetMemoryAlreadyForgottenError &&
      err.message.includes("2026-04-20T00:00:00.000Z"),
  );
});

test("forgetMemory: rejects empty/whitespace id", async () => {
  const { stub } = makeStorageStub([makeMemory({ id: "epsilon" })]);
  await assert.rejects(forgetMemory(stub as never, { id: "" }), /required/);
  await assert.rejects(forgetMemory(stub as never, { id: "   " }), /required/);
});

test("forgetMemory: trims whitespace from id and reason", async () => {
  const mem = makeMemory({ id: "zeta", status: "active" });
  const { stub, writes } = makeStorageStub([mem]);
  const result = await forgetMemory(stub as never, {
    id: "  zeta  ",
    reason: "  bad data  ",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.id, "zeta");
  assert.equal(result.reason, "bad data");
  assert.equal(writes[0]?.patch.forgottenReason, "bad data");
});

test("forgetMemory: preserves prior non-active status in result", async () => {
  const mem = makeMemory({ id: "eta", status: "archived" });
  const { stub } = makeStorageStub([mem]);
  const result = await forgetMemory(stub as never, {
    id: "eta",
    now: () => new Date("2026-04-25T12:00:00Z"),
  });
  assert.equal(result.priorStatus, "archived");
});
