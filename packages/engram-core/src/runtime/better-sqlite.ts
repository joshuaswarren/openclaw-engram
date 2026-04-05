import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

export type BetterSqlite3Database = BetterSqlite3.Database;
type BetterSqlite3Ctor = typeof BetterSqlite3;

let cachedCtor: BetterSqlite3Ctor | null = null;

function loadBetterSqlite3(): BetterSqlite3Ctor {
  if (cachedCtor) return cachedCtor;

  const require = createRequire(import.meta.url);

  try {
    const loaded = require("better-sqlite3") as
      | BetterSqlite3Ctor
      | { default?: BetterSqlite3Ctor };
    const ctor = typeof loaded === "function" ? loaded : loaded.default;

    if (typeof ctor !== "function") {
      throw new Error("module did not export a constructor");
    }

    cachedCtor = ctor;
    return ctor;
  } catch (error) {
    const detail =
      error instanceof Error && error.message.length > 0
        ? ` (${error.message})`
        : "";
    throw new Error(
      "better-sqlite3 is unavailable. Rebuild it in the plugin install with `npm rebuild better-sqlite3 --build-from-source` before using SQLite-backed Engram features" +
        detail,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export function openBetterSqlite3(
  file: string,
  options?: ConstructorParameters<BetterSqlite3Ctor>[1],
): BetterSqlite3Database {
  const Database = loadBetterSqlite3();
  return new Database(file, options);
}
