import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("cli service candidate helper falls through to legacy service labels after a failure", async () => {
  const { firstSuccessfulCandidate } = await import(
    path.join(ROOT, "packages/remnic-cli/src/service-candidates.ts")
  );
  const calls: string[] = [];
  const result = firstSuccessfulCandidate(["remnic.service", "engram.service"], (candidate) => {
    calls.push(candidate);
    if (candidate === "remnic.service") {
      throw new Error("canonical service missing");
    }
  });
  assert.equal(result, "engram.service");
  assert.deepEqual(calls, ["remnic.service", "engram.service"]);
});
