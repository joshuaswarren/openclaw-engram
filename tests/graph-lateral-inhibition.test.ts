import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLateralInhibition } from "../src/graph.js";

describe("applyLateralInhibition", () => {
  it("suppresses lower-activation nodes relative to top-M competitors", () => {
    const scores = new Map<string, number>([
      ["hub", 1.0],
      ["relevant-a", 0.7],
      ["relevant-b", 0.65],
      ["noise-c", 0.2],
      ["noise-d", 0.1],
    ]);
    const result = applyLateralInhibition(scores, { beta: 0.15, topM: 7 });
    assert.ok(result.get("noise-d")! < 0.05, "low-activation node should be heavily suppressed");
    assert.ok(result.get("relevant-a")! > result.get("noise-c")!, "relevant node still outranks noise");
    assert.ok(result.get("hub")! > result.get("relevant-a")!, "hub stays on top");
  });

  it("returns zero for nodes fully suppressed by inhibition", () => {
    const scores = new Map<string, number>([
      ["dominant", 1.0],
      ["weak", 0.01],
    ]);
    const result = applyLateralInhibition(scores, { beta: 0.15, topM: 7 });
    assert.ok(result.get("weak")! < 0.05, "very weak node suppressed to near-zero after sigmoid");
  });

  it("applies sigmoid transform to final scores", () => {
    const scores = new Map<string, number>([
      ["a", 0.8],
      ["b", 0.5],
    ]);
    const result = applyLateralInhibition(scores, { beta: 0.15, topM: 7 });
    for (const [, v] of result) {
      assert.ok(v >= 0 && v <= 1, "sigmoid output in [0,1]");
    }
  });

  it("is a no-op when beta is zero", () => {
    const scores = new Map([["a", 0.5], ["b", 0.3]]);
    const result = applyLateralInhibition(scores, { beta: 0, topM: 7 });
    assert.equal(result.get("a"), scores.get("a"));
    assert.equal(result.get("b"), scores.get("b"));
  });

  it("preserves relative ordering of well-separated nodes", () => {
    const scores = new Map<string, number>([
      ["top", 0.9],
      ["mid", 0.6],
      ["low", 0.35],
    ]);
    const result = applyLateralInhibition(scores, { beta: 0.15, topM: 7 });
    assert.ok(result.get("top")! > result.get("mid")!);
    assert.ok(result.get("mid")! > result.get("low")!);
  });
});
