import assert from "node:assert/strict";
import test from "node:test";
import {
  isLikelyBetterSqlite3NativeBindingError,
  openBetterSqlite3,
} from "./better-sqlite.js";

test("isLikelyBetterSqlite3NativeBindingError recognizes missing and mismatched native bindings", () => {
  assert.equal(
    isLikelyBetterSqlite3NativeBindingError(
      new Error("Could not locate the bindings file. Tried: better_sqlite3.node"),
    ),
    true,
  );
  assert.equal(
    isLikelyBetterSqlite3NativeBindingError(
      new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127"),
    ),
    true,
  );
  assert.equal(isLikelyBetterSqlite3NativeBindingError(new Error("SQLITE_BUSY: database is locked")), false);
});

test("openBetterSqlite3 can open an in-memory database after install verification", () => {
  const db = openBetterSqlite3(":memory:");
  try {
    const row = db.prepare("SELECT 42 AS answer").get() as { answer: number };
    assert.equal(row.answer, 42);
  } finally {
    db.close();
  }
});
