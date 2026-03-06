import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRejectLowConfidenceRecall } from "../src/orchestrator.js";

describe("shouldRejectLowConfidenceRecall", () => {
  it("rejects when all scores are below threshold", () => {
    const results = [
      { path: "a", score: 0.05, snippet: "", docid: "a" },
      { path: "b", score: 0.03, snippet: "", docid: "b" },
    ];
    assert.ok(shouldRejectLowConfidenceRecall(results, 0.12));
  });

  it("does not reject when top score exceeds threshold", () => {
    const results = [
      { path: "a", score: 0.5, snippet: "", docid: "a" },
      { path: "b", score: 0.03, snippet: "", docid: "b" },
    ];
    assert.ok(!shouldRejectLowConfidenceRecall(results, 0.12));
  });

  it("does not reject empty results (handled elsewhere)", () => {
    assert.ok(!shouldRejectLowConfidenceRecall([], 0.12));
  });

  it("uses top score, not average", () => {
    const results = [
      { path: "a", score: 0.15, snippet: "", docid: "a" },
      { path: "b", score: 0.01, snippet: "", docid: "b" },
      { path: "c", score: 0.01, snippet: "", docid: "c" },
    ];
    // Average is 0.057 (below threshold) but top is 0.15 (above)
    assert.ok(!shouldRejectLowConfidenceRecall(results, 0.12));
  });
});
