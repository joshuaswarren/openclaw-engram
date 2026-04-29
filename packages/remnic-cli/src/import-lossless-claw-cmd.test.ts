import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseImportLosslessClawArgs } from "./import-lossless-claw-args.js";

describe("parseImportLosslessClawArgs", () => {
  it("accepts --src and a relative path", () => {
    const args = parseImportLosslessClawArgs(["--src", "./lcm.db"]);
    assert.equal(args.src, "./lcm.db");
    assert.equal(args.dryRun, false);
    assert.deepEqual(args.sessionFilter, []);
  });

  it("expands tildes in --src and --memory-dir", () => {
    const home = process.env.HOME ?? "/tmp";
    const args = parseImportLosslessClawArgs([
      "--src",
      "~/lcm.db",
      "--memory-dir",
      "~/.remnic/memory",
    ]);
    assert.equal(args.src, `${home}/lcm.db`);
    assert.equal(args.memoryDir, `${home}/.remnic/memory`);
  });

  it("collects multiple --session-filter values", () => {
    const args = parseImportLosslessClawArgs([
      "--src",
      "/tmp/lcm.db",
      "--session-filter",
      "sess-A",
      "--session-filter",
      "sess-B",
    ]);
    assert.deepEqual(args.sessionFilter, ["sess-A", "sess-B"]);
  });

  it("sets dryRun on --dry-run", () => {
    const args = parseImportLosslessClawArgs(["--src", "/tmp/lcm.db", "--dry-run"]);
    assert.equal(args.dryRun, true);
  });

  it("rejects --src without a following value (CLAUDE.md gotcha #14)", () => {
    assert.throws(
      () => parseImportLosslessClawArgs(["--src"]),
      /requires a path/,
    );
  });

  it("rejects --src followed by another flag (no silent default)", () => {
    assert.throws(
      () => parseImportLosslessClawArgs(["--src", "--dry-run"]),
      /requires a path/,
    );
  });

  it("rejects --memory-dir without value", () => {
    assert.throws(
      () =>
        parseImportLosslessClawArgs([
          "--src",
          "/tmp/lcm.db",
          "--memory-dir",
        ]),
      /requires a path/,
    );
  });

  it("rejects --session-filter without value", () => {
    assert.throws(
      () =>
        parseImportLosslessClawArgs([
          "--src",
          "/tmp/lcm.db",
          "--session-filter",
        ]),
      /requires a session id/,
    );
  });

  it("requires --src", () => {
    assert.throws(
      () => parseImportLosslessClawArgs(["--dry-run"]),
      /--src is required/,
    );
  });

  it("rejects unknown flags rather than ignoring them (gotcha #51)", () => {
    assert.throws(
      () =>
        parseImportLosslessClawArgs([
          "--src",
          "/tmp/lcm.db",
          "--unknown-flag",
        ]),
      /Unknown argument/,
    );
  });
});
